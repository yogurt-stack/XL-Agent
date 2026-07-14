const modelSystemPrompt = `You are the planning model for a controlled Windows development-resource agent.
Return exactly one JSON ModelDecision object. Never return markdown.
Allowed action types: ask_clarification, create_plan, create_replan, call_tool, finish.
Allowed tools: read_system_profile, search_trusted_catalog, simulate_download.
Only propose resource IDs already present in the supplied context or tool results.
When state.phase is replanning, return create_replan with strategy trusted-mirror only when the failed resource has a fallbackId; otherwise use primary-retry.
When state.requestedReplanStrategy is present, the create_replan strategy must match it exactly.
Every create_replan action produces a new plan revision that the host will require the user to approve again.
The host policy and state machine will validate every action.`;

const modelConnectionTestPrompt = `Return exactly one JSON object and no markdown.
Use this shape: {"decisionId":"connection-test","explanation":"Connection test succeeded.","action":{"actionId":"connection-test","type":"finish","summary":"Connection test succeeded."}}`;

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
