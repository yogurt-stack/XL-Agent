import {
  createOpenAiAgentTools,
  ModelToolProtocolError,
  parseOpenAiToolDecision,
  type OpenAiFunctionTool
} from "../src/features/agent-core/modelToolProtocol";
import type {
  AgentToolName,
  ModelContext
} from "../src/features/agent-core/types";

const modelSystemPrompt = `你是受控 Windows 开发资源 Agent 的规划模型。

宿主使用 OpenAI-compatible 原生 function tools 与你交互。你必须调用且只调用一个函数来表达下一步动作；不要在 message.content 中返回 JSON、Markdown 或自然语言答案。

规则：
1. 只能调用本次请求 tools 中实际提供的函数。
2. 只能使用 context、可信目录查询结果或既有 toolResults 中出现的 resourceId，禁止编造资源 ID。
3. planning 阶段尚无成功的 read_system_profile 结果时，调用 read_system_profile。
4. planning 阶段尚无成功的 search_trusted_catalog 结果时，调用一次 search_trusted_catalog。
5. read_system_profile 或 search_trusted_catalog 成功后不得重复调用。
6. search_trusted_catalog 成功且结果非空时，使用 create_plan；结果为空时使用 ask_clarification。
7. replanning 阶段必须调用 create_replan。若 state.requestedReplanStrategy 存在，strategy 必须完全一致；否则仅在失败资源存在 fallbackId 时使用 trusted-mirror，没有 fallbackId 时使用 primary-retry。
8. 每个 create_plan/create_replan 都会产生需要用户重新审批的 plan revision。
9. controlled_download 与 export_workspace 仍会被宿主 Policy、审批记录和状态机二次校验，不得尝试绕过。
10. 所有工具参数必须严格符合函数 JSON Schema，不得添加额外字段。`;

const modelConnectionTestPrompt = `这是远程模型连接测试。你必须调用且只调用 finish 函数，summary 使用 "Connection test succeeded."，不要返回正文。`;

export type ModelConnectionErrorCode =
  | "MODEL_UNCONFIGURED"
  | "MODEL_ENDPOINT_INVALID"
  | "MODEL_AUTH_FAILED"
  | "MODEL_TIMEOUT"
  | "MODEL_NETWORK_ERROR"
  | "MODEL_HTTP_ERROR"
  | "MODEL_INVALID_RESPONSE"
  | "MODEL_INVALID_JSON"
  | "MODEL_INVALID_DECISION"
  | "MODEL_UNKNOWN_ERROR";

export type ModelConnectionError = {
  code: ModelConnectionErrorCode;
  message: string;
  retriable: boolean;
};

export type ModelClientEnvironment = {
  XL_AGENT_LLM_ENDPOINT?: string;
  XL_AGENT_LLM_API_KEY?: string;
  XL_AGENT_LLM_MODEL?: string;
};

export type ModelFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export class RemoteModelRequestError extends Error {
  constructor(readonly detail: ModelConnectionError) {
    super(detail.message);
    this.name = "RemoteModelRequestError";
  }
}

function remoteModelError(
  code: ModelConnectionErrorCode,
  message: string,
  retriable: boolean
) {
  return new RemoteModelRequestError({ code, message, retriable });
}

export function toModelConnectionError(error: unknown): ModelConnectionError {
  if (error instanceof RemoteModelRequestError) return error.detail;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return {
      code: "MODEL_TIMEOUT",
      message: "远程 LLM 请求超时，请检查网络或稍后重试。",
      retriable: true
    };
  }
  if (error instanceof TypeError) {
    return {
      code: "MODEL_NETWORK_ERROR",
      message: "无法连接远程 LLM，请检查网络和端点地址。",
      retriable: true
    };
  }
  return {
    code: "MODEL_UNKNOWN_ERROR",
    message: error instanceof Error ? error.message : "未知远程模型错误。",
    retriable: true
  };
}

function protocolError(error: ModelToolProtocolError) {
  if (error.kind === "invalid-json") {
    return remoteModelError("MODEL_INVALID_JSON", error.message, true);
  }
  if (error.kind === "invalid-decision") {
    return remoteModelError("MODEL_INVALID_DECISION", error.message, true);
  }
  return remoteModelError("MODEL_INVALID_RESPONSE", error.message, true);
}

function finishTool(): OpenAiFunctionTool {
  const tool = createOpenAiAgentTools([]).find(
    (candidate) => candidate.function.name === "finish"
  );
  if (!tool) throw new Error("finish 工具定义缺失。");
  return tool;
}

export class RemoteModelClient {
  constructor(
    private readonly environment: ModelClientEnvironment = process.env,
    private readonly fetchRequest: ModelFetch = fetch
  ) {}

  getSafeConnectionInfo() {
    const model = this.environment.XL_AGENT_LLM_MODEL || null;
    let endpointHost: string | null = null;
    if (this.environment.XL_AGENT_LLM_ENDPOINT) {
      try {
        endpointHost = new URL(this.environment.XL_AGENT_LLM_ENDPOINT).host;
      } catch {
        endpointHost = null;
      }
    }
    try {
      const config = this.getConfig();
      return {
        configured: true,
        endpointHost: new URL(config.endpoint).host,
        model: config.model
      };
    } catch (error) {
      return {
        configured: false,
        endpointHost,
        model,
        error: toModelConnectionError(error)
      };
    }
  }

  async requestDecision(context: ModelContext) {
    return this.requestRemoteToolDecision(
      modelSystemPrompt,
      context,
      context.availableTools
    );
  }

  async testConnection() {
    return this.requestRemoteToolDecision(
      modelConnectionTestPrompt,
      { purpose: "model-connection-test" },
      [],
      true
    );
  }

  private getConfig() {
    const endpoint = this.environment.XL_AGENT_LLM_ENDPOINT;
    const apiKey = this.environment.XL_AGENT_LLM_API_KEY;
    const model = this.environment.XL_AGENT_LLM_MODEL;
    if (!endpoint || !apiKey || !model) {
      throw remoteModelError(
        "MODEL_UNCONFIGURED",
        "远程 LLM 配置不完整，请检查端点、模型 ID 和 API Key。",
        false
      );
    }

    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw remoteModelError(
        "MODEL_ENDPOINT_INVALID",
        "XL_AGENT_LLM_ENDPOINT 不是合法 URL。",
        false
      );
    }
    if (url.protocol !== "https:") {
      throw remoteModelError(
        "MODEL_ENDPOINT_INVALID",
        "XL_AGENT_LLM_ENDPOINT 必须使用 HTTPS。",
        false
      );
    }
    return { endpoint: url.toString(), apiKey, model };
  }

  private async requestRemoteToolDecision(
    systemPrompt: string,
    context: unknown,
    availableTools: AgentToolName[],
    forceFinish = false
  ) {
    const config = this.getConfig();
    const tools = forceFinish
      ? [finishTool()]
      : createOpenAiAgentTools(availableTools);
    let response: Response;
    try {
      response = await this.fetchRequest(config.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0.1,
          tools,
          tool_choice: forceFinish
            ? { type: "function", function: { name: "finish" } }
            : "required",
          parallel_tool_calls: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(context) }
          ]
        }),
        signal: AbortSignal.timeout(15000)
      });
    } catch (error) {
      throw new RemoteModelRequestError(toModelConnectionError(error));
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw remoteModelError(
          "MODEL_AUTH_FAILED",
          `远程 LLM 鉴权失败：HTTP ${response.status}。`,
          false
        );
      }
      throw remoteModelError(
        "MODEL_HTTP_ERROR",
        `远程 LLM 请求失败：HTTP ${response.status}。`,
        response.status === 408 || response.status === 429 || response.status >= 500
      );
    }

    let payload: {
      choices?: Array<{ message?: unknown }>;
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw remoteModelError(
        "MODEL_INVALID_RESPONSE",
        "远程 LLM 返回了无法解析的响应。",
        true
      );
    }

    const message = payload.choices?.[0]?.message;
    if (!message) {
      throw remoteModelError(
        "MODEL_INVALID_RESPONSE",
        "远程 LLM 响应缺少 choices[0].message。",
        true
      );
    }

    try {
      return parseOpenAiToolDecision(message, config.model, availableTools);
    } catch (error) {
      if (error instanceof ModelToolProtocolError) throw protocolError(error);
      throw remoteModelError(
        "MODEL_INVALID_DECISION",
        "远程 LLM 的 tool_call 无法转换为合法 ModelDecision。",
        true
      );
    }
  }
}
