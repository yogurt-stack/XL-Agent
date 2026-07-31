import {
  createOpenAiAgentTools,
  ModelToolProtocolError,
  parseOpenAiToolDecision,
  type AgentActionToolName,
  type OpenAiFunctionTool
} from "../src/features/agent-core/modelToolProtocol";
import type {
  AgentToolName,
  ModelContext
} from "../src/features/agent-core/types";

const modelSystemPrompt = `你是受控 Windows 资源准备 Agent 的规划模型。

宿主使用 OpenAI-compatible 原生 function tools 与你交互。你必须调用且只调用一个函数来表达下一步动作；不要在 message.content 中返回 JSON、Markdown 或自然语言答案。

规则：
1. 只能调用本次请求 tools 中实际提供的函数。
2. task_planning 阶段必须调用 propose_task_plan：先根据用户首轮目标和路由结果给出完整目标、交付物、假设、约束、DAG 步骤、风险与审批边界。该动作不执行工具；用户确认前不得调用任何读取、下载或导出工具。
3. Task Plan 的首轮 confirmation.required 必须为 true。只读步骤不得伪装成写入；本地写入、外部写入和代码执行必须声明独立审批及原因。Task Plan 确认不等于后续资源下载审批。
4. 只能使用 context、可信目录查询结果或既有 toolResults 中出现的 resourceId，禁止编造资源 ID。
5. planning 阶段尚无成功的 read_system_profile 结果时，调用 read_system_profile。
6. planning 阶段尚无成功的 search_trusted_catalog 结果时，调用一次 search_trusted_catalog。
7. read_system_profile 或 search_trusted_catalog 成功后不得重复调用。
8. search_trusted_catalog 成功且结果非空时，使用 create_plan；结果为空时使用 ask_clarification。
9. replanning 阶段必须调用 create_replan。若 state.requestedReplanStrategy 存在，strategy 必须完全一致；否则仅在失败资源存在 fallbackId 时使用 trusted-mirror，没有 fallbackId 时使用 primary-retry。
10. 每个 create_plan/create_replan 都会产生需要用户重新审批的 plan revision。
11. controlled_download 与 export_workspace 仍会被宿主 Policy、审批记录和状态机二次校验，不得尝试绕过。
12. 当 routeDecision.skillId 为 github-project-discovery 时，只调用 search_github_repositories；成功或失败返回后调用 finish。搜索参数必须忠实表达任务：近期热门榜使用 discovery；按名称查找（如“名叫 tau”）使用 name；明确的 GitHub URL 或 owner/repo 使用 exact。name/exact 不得改写为时间窗口或热门排行。候选仓库的固定 commit、审批和下载由结果页中的宿主受控流程继续完成。
13. 所有工具参数必须严格符合函数 JSON Schema，不得添加额外字段。`;

const modelConnectionTestPrompt = `这是远程模型连接测试。你必须调用且只调用 finish 函数，summary 使用 "Connection test succeeded."，不要返回正文。`;

export type ModelConnectionErrorCode =
  | "MODEL_UNCONFIGURED"
  | "MODEL_CONFIGURATION_CONFLICT"
  | "MODEL_PROVIDER_UNSUPPORTED"
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
  XL_AGENT_LLM_PROVIDER?: string;
  XL_AGENT_LLM_ENDPOINT?: string;
  XL_AGENT_LLM_BASE_URL?: string;
  XL_AGENT_LLM_API_KEY?: string;
  XL_AGENT_LLM_MODEL?: string;
};

export type RemoteModelProviderId = "openai-compatible";
export type ModelEndpointMode = "endpoint" | "base-url";

export type ResolvedRemoteModelConfig = {
  providerId: RemoteModelProviderId;
  endpointMode: ModelEndpointMode;
  endpoint: string;
  apiKey: string;
  model: string;
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

function configuredValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function sanitizeProviderErrorMessage(
  value: unknown,
  secrets: string[]
) {
  if (typeof value !== "string") return null;
  let message = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message ? message.slice(0, 500) : null;
}

async function readProviderErrorMessage(
  response: Response,
  secrets: string[]
) {
  try {
    const body = await response.text();
    if (!body) return null;
    const payload = JSON.parse(body) as {
      error?: { message?: unknown };
    };
    return sanitizeProviderErrorMessage(
      payload.error?.message,
      secrets
    );
  } catch {
    return null;
  }
}

function parseHttpsUrl(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw remoteModelError(
      "MODEL_ENDPOINT_INVALID",
      `${label} 不是合法 URL。`,
      false
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw remoteModelError(
      "MODEL_ENDPOINT_INVALID",
      `${label} 必须使用 HTTPS，且不能包含凭据或片段。`,
      false
    );
  }
  return url;
}

function endpointFromBaseUrl(baseUrl: string) {
  const url = parseHttpsUrl(baseUrl, "XL_AGENT_LLM_BASE_URL");
  if (url.search) {
    throw remoteModelError(
      "MODEL_ENDPOINT_INVALID",
      "XL_AGENT_LLM_BASE_URL 不能包含查询参数。",
      false
    );
  }
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath}/chat/completions`.replace(/\/{2,}/gu, "/");
  return url.toString();
}

function providerRequestExtensions(
  config: ResolvedRemoteModelConfig
) {
  const hostname = new URL(config.endpoint).hostname.toLowerCase();
  if (hostname === "api.deepseek.com") {
    return {
      thinking: { type: "disabled" as const }
    };
  }
  return {};
}

export function resolveRemoteModelConfig(
  environment: ModelClientEnvironment
): ResolvedRemoteModelConfig {
  const provider =
    configuredValue(environment.XL_AGENT_LLM_PROVIDER) ??
    "openai-compatible";
  if (provider !== "openai-compatible") {
    throw remoteModelError(
      "MODEL_PROVIDER_UNSUPPORTED",
      `不支持的远程模型 Provider：${provider}。`,
      false
    );
  }

  const endpoint = configuredValue(environment.XL_AGENT_LLM_ENDPOINT);
  const baseUrl = configuredValue(environment.XL_AGENT_LLM_BASE_URL);
  const apiKey = configuredValue(environment.XL_AGENT_LLM_API_KEY);
  const model = configuredValue(environment.XL_AGENT_LLM_MODEL);
  if (endpoint && baseUrl) {
    throw remoteModelError(
      "MODEL_CONFIGURATION_CONFLICT",
      "XL_AGENT_LLM_ENDPOINT 与 XL_AGENT_LLM_BASE_URL 只能配置一个。",
      false
    );
  }
  if ((!endpoint && !baseUrl) || !apiKey || !model) {
    throw remoteModelError(
      "MODEL_UNCONFIGURED",
      "远程 LLM 配置不完整，请检查 Provider、Endpoint/Base URL、模型 ID 和 API Key。",
      false
    );
  }

  return {
    providerId: provider,
    endpointMode: endpoint ? "endpoint" : "base-url",
    endpoint: endpoint
      ? parseHttpsUrl(endpoint, "XL_AGENT_LLM_ENDPOINT").toString()
      : endpointFromBaseUrl(baseUrl!),
    apiKey,
    model
  };
}

export class RemoteModelClient {
  constructor(
    private readonly environment: ModelClientEnvironment = process.env,
    private readonly fetchRequest: ModelFetch = fetch
  ) {}

  getSafeConnectionInfo() {
    const model = configuredValue(this.environment.XL_AGENT_LLM_MODEL);
    const providerId =
      configuredValue(this.environment.XL_AGENT_LLM_PROVIDER) ??
      "openai-compatible";
    const endpointMode = configuredValue(
      this.environment.XL_AGENT_LLM_ENDPOINT
    )
      ? "endpoint" as const
      : configuredValue(this.environment.XL_AGENT_LLM_BASE_URL)
        ? "base-url" as const
        : null;
    let endpointHost: string | null = null;
    const configuredEndpoint =
      configuredValue(this.environment.XL_AGENT_LLM_ENDPOINT) ??
      configuredValue(this.environment.XL_AGENT_LLM_BASE_URL);
    if (configuredEndpoint) {
      try {
        endpointHost = new URL(configuredEndpoint).host;
      } catch {
        endpointHost = null;
      }
    }
    try {
      const config = this.getConfig();
      return {
        configured: true,
        endpointHost: new URL(config.endpoint).host,
        model: config.model,
        providerId: config.providerId,
        endpointMode: config.endpointMode
      };
    } catch (error) {
      return {
        configured: false,
        endpointHost,
        model,
        providerId,
        endpointMode,
        error: toModelConnectionError(error)
      };
    }
  }

  async requestDecision(context: ModelContext) {
    const availableActions: AgentActionToolName[] =
      context.state.phase === "task_planning"
        ? ["propose_task_plan"]
        : context.state.routeDecision?.skillId === "github-project-discovery"
          ? ["finish"]
          : ["ask_clarification", "create_plan", "create_replan", "finish"];
    return this.requestRemoteToolDecision(
      modelSystemPrompt,
      context,
      context.availableTools,
      availableActions,
      false,
      context.state.phase === "task_planning"
    );
  }

  async testConnection() {
    return this.requestRemoteToolDecision(
      modelConnectionTestPrompt,
      { purpose: "model-connection-test" },
      [],
      ["finish"],
      true
    );
  }

  private getConfig() {
    return resolveRemoteModelConfig(this.environment);
  }

  private async requestRemoteToolDecision(
    systemPrompt: string,
    context: unknown,
    availableTools: AgentToolName[],
    availableActions: AgentActionToolName[],
    forceFinish = false,
    taskPlanningMode = false
  ) {
    const config = this.getConfig();
    const githubSearchMode = !taskPlanningMode && availableTools.includes(
      "search_github_repositories"
    );
    const tools = forceFinish
      ? [finishTool()]
      : createOpenAiAgentTools(
          taskPlanningMode ? [] : availableTools,
          availableActions
        ).filter((tool) =>
          !githubSearchMode ||
          tool.function.name === "finish" ||
          tool.function.name === "search_github_repositories"
        );
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
          ...providerRequestExtensions(config),
          tools,
          tool_choice: "required",
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
      const providerMessage = await readProviderErrorMessage(
        response,
        [config.apiKey]
      );
      if (response.status === 401 || response.status === 403) {
        throw remoteModelError(
          "MODEL_AUTH_FAILED",
          `远程 LLM 鉴权失败：HTTP ${response.status}。`,
          false
        );
      }
      throw remoteModelError(
        "MODEL_HTTP_ERROR",
        providerMessage
          ? `远程 LLM 请求失败：HTTP ${response.status}。服务返回：${providerMessage}`
          : `远程 LLM 请求失败：HTTP ${response.status}。`,
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
      return parseOpenAiToolDecision(
        message,
        config.model,
        availableTools,
        availableActions
      );
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
