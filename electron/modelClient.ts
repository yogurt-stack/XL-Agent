const modelSystemPrompt = `你是一个受控 Windows 开发资源准备 Agent 的规划模型。

你必须只返回一个合法的 JSON 对象，且这个对象必须符合 ModelDecision 结构。
禁止返回 Markdown。
禁止返回代码块。
禁止返回解释文字。
禁止返回 JSON 之外的任何前缀、后缀、注释或自然语言。
不要把 JSON 包在字符串里。
如果无法确定下一步，也必须返回合法的 ModelDecision JSON。

ModelDecision 顶层结构必须包含：
{
  "decisionId": "string",
  "provider": "remote-llm",
  "model": "string",
  "explanation": "string",
  "action": {}
}

允许的 action.type 只有：
- "ask_clarification"
- "create_plan"
- "create_replan"
- "call_tool"
- "finish"

允许的工具名只有：
- "read_system_profile"
- "search_trusted_catalog"
- "simulate_download"
- "controlled_download"

字段名、action.type、工具名、strategy 值必须使用上述英文原值，不要翻译。

当 action.type 是 "ask_clarification" 时，action 必须包含：
{
  "actionId": "string",
  "type": "ask_clarification",
  "questionId": "string",
  "question": "string",
  "reason": "string",
  "required": true,
  "options": ["string"]
}

当 action.type 是 "create_plan" 时，action 必须包含：
{
  "actionId": "string",
  "type": "create_plan",
  "resourceIds": ["string"],
  "explanation": "string"
}

当 action.type 是 "create_replan" 时，action 必须包含：
{
  "actionId": "string",
  "type": "create_replan",
  "strategy": "trusted-mirror",
  "explanation": "string"
}
其中 strategy 只能是 "trusted-mirror" 或 "primary-retry"。

当 action.type 是 "call_tool" 时，action 必须包含：
{
  "actionId": "string",
  "type": "call_tool",
  "purpose": "string",
  "call": {
    "callId": "string",
    "name": "read_system_profile",
    "input": {}
  }
}
如果 call.name 是 "read_system_profile"，input 必须是 {}。
如果 call.name 是 "search_trusted_catalog"，input 必须包含：
{
  "query": "string",
  "resourceIds": ["string"]
}
resourceIds 可以省略，但 query 必须存在。
如果 call.name 是 "simulate_download"，input 必须包含：
{
  "resourceId": "string"
}
如果 call.name 是 "controlled_download"，input 必须包含：
{
  "resourceId": "string"
}

当 action.type 是 "finish" 时，action 必须包含：
{
  "actionId": "string",
  "type": "finish",
  "summary": "string"
}

决策规则：
1. 只能调用 context.availableTools 中列出的工具；只能提出当前 context 或 toolResults 中已经存在的 resourceIds，不能编造资源 ID。
2. 在 state.phase 为 "planning" 时，如果还没有成功的 read_system_profile 结果，优先 call_tool: read_system_profile。
3. 在 state.phase 为 "planning" 时，如果还没有成功的 search_trusted_catalog 结果，优先 call_tool: search_trusted_catalog。
4. 在 state.phase 为 "replanning" 时，必须返回 create_replan。
5. 在 state.phase 为 "replanning" 且失败资源存在 fallbackId 时，可以使用 strategy: "trusted-mirror"。
6. 在 state.phase 为 "replanning" 且失败资源没有 fallbackId 时，必须使用 strategy: "primary-retry"。
7. 当 state.requestedReplanStrategy 存在时，create_replan.strategy 必须与它完全一致。
8. 每个 create_replan 都会产生新的 plan revision，宿主会要求用户再次审批。
9. 宿主的 Policy 和状态机会校验每个 action；不要尝试绕过审批、Policy 或状态机。
10. 不要调用未列出的工具，不要提出未列出的 action.type。

再次强调：你的最终输出必须是一个裸 JSON 对象，不能包含 Markdown、代码块、解释或任何 JSON 之外的文本。`;

const modelConnectionTestPrompt = `你正在执行远程模型连接测试。

你必须只返回一个合法的 JSON 对象。
禁止返回 Markdown。
禁止返回代码块。
禁止返回解释文字。
禁止返回 JSON 之外的任何前缀、后缀、注释或自然语言。
不要把 JSON 包在字符串里。

必须严格返回以下 ModelDecision 结构：
{
  "decisionId": "connection-test",
  "provider": "remote-llm",
  "model": "connection-test",
  "explanation": "Connection test succeeded.",
  "action": {
    "actionId": "connection-test",
    "type": "finish",
    "summary": "Connection test succeeded."
  }
}

最终输出只能是这个裸 JSON 对象。`;

export type ModelConnectionErrorCode =
  | "MODEL_UNCONFIGURED"
  | "MODEL_ENDPOINT_INVALID"
  | "MODEL_AUTH_FAILED"
  | "MODEL_TIMEOUT"
  | "MODEL_NETWORK_ERROR"
  | "MODEL_HTTP_ERROR"
  | "MODEL_INVALID_RESPONSE"
  | "MODEL_INVALID_JSON"
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

export type ModelFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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

  async requestDecision(context: unknown) {
    return this.requestRemoteJson(modelSystemPrompt, context);
  }

  async testConnection() {
    return this.requestRemoteJson(modelConnectionTestPrompt, { purpose: "model-connection-test" });
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
      throw remoteModelError("MODEL_ENDPOINT_INVALID", "XL_AGENT_LLM_ENDPOINT 不是合法 URL。", false);
    }
    if (url.protocol !== "https:") {
      throw remoteModelError("MODEL_ENDPOINT_INVALID", "XL_AGENT_LLM_ENDPOINT 必须使用 HTTPS。", false);
    }
    return { endpoint: url.toString(), apiKey, model };
  }

  private async requestRemoteJson(systemPrompt: string, context: unknown) {
    const config = this.getConfig();
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
          response_format: { type: "json_object" },
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
      choices?: Array<{ message?: { content?: string } }>;
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw remoteModelError("MODEL_INVALID_RESPONSE", "远程 LLM 返回了无法解析的响应。", true);
    }
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw remoteModelError(
        "MODEL_INVALID_RESPONSE",
        "远程 LLM 响应缺少 choices[0].message.content。",
        true
      );
    }
    try {
      const decision = JSON.parse(content) as Record<string, unknown>;
      return { ...decision, model: config.model };
    } catch {
      throw remoteModelError("MODEL_INVALID_JSON", "远程 LLM 没有返回合法 JSON。", true);
    }
  }
}
