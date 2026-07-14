import type { ModelDecision } from "./types";

export type ModelConnectionStatus =
  | "unconfigured"
  | "configured"
  | "checking"
  | "remote_available"
  | "fallback_local"
  | "connection_failed";

export type ModelConnectionErrorCode =
  | "MODEL_BRIDGE_UNAVAILABLE"
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

export type ModelConnectionInfo = {
  configured: boolean;
  endpointHost: string | null;
  model: string | null;
  error?: ModelConnectionError;
};

export type ModelConnectionState = ModelConnectionInfo & {
  status: ModelConnectionStatus;
  activeProvider: "local-rule" | "remote-llm";
  lastCheckedAt: string | null;
};

export type ModelConnectionProbeResult =
  | { ok: true }
  | { ok: false; error: ModelConnectionError };

export interface ModelConnectionBridge {
  getConnectionInfo(): Promise<ModelConnectionInfo>;
  testConnection(): Promise<ModelConnectionProbeResult>;
}

export type ModelConnectionListener = (state: ModelConnectionState) => void;

export class ModelConnectionRequestError extends Error {
  constructor(readonly detail: ModelConnectionError) {
    super(detail.message);
    this.name = "ModelConnectionRequestError";
  }
}

export function toModelConnectionError(error: unknown): ModelConnectionError {
  if (error instanceof ModelConnectionRequestError) return error.detail;
  return {
    code: "MODEL_UNKNOWN_ERROR",
    message: error instanceof Error ? error.message : "未知远程模型错误。",
    retriable: true
  };
}

const bridgeUnavailableError: ModelConnectionError = {
  code: "MODEL_BRIDGE_UNAVAILABLE",
  message: "当前页面没有 Electron 模型桥接，已使用本地规则模型。",
  retriable: false
};

export class ModelConnectionController {
  private state: ModelConnectionState;
  private readonly listeners = new Set<ModelConnectionListener>();
  private operationVersion = 0;

  constructor(
    private readonly bridge?: ModelConnectionBridge,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    this.state = bridge
      ? {
          status: "checking",
          activeProvider: "local-rule",
          configured: false,
          endpointHost: null,
          model: null,
          lastCheckedAt: null
        }
      : {
          status: "unconfigured",
          activeProvider: "local-rule",
          configured: false,
          endpointHost: null,
          model: null,
          error: bridgeUnavailableError,
          lastCheckedAt: null
        };
  }

  getState() {
    return this.state;
  }

  subscribe(listener: ModelConnectionListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize() {
    if (!this.bridge) return this.state;
    const version = ++this.operationVersion;
    this.update({ ...this.state, status: "checking", error: undefined });

    try {
      const info = await this.bridge.getConnectionInfo();
      if (version !== this.operationVersion) return this.state;
      if (this.state.status !== "checking") {
        this.update({
          ...this.state,
          configured: info.configured,
          endpointHost: info.endpointHost,
          model: info.model ?? this.state.model
        });
        return this.state;
      }
      this.update({
        ...info,
        status: info.configured ? "configured" : "unconfigured",
        activeProvider: "local-rule",
        lastCheckedAt: null
      });
    } catch (error) {
      if (version !== this.operationVersion) return this.state;
      if (this.state.status !== "checking") return this.state;
      this.update({
        ...this.state,
        status: "connection_failed",
        activeProvider: "local-rule",
        error: toModelConnectionError(error),
        lastCheckedAt: this.now()
      });
    }
    return this.state;
  }

  async testConnection() {
    if (!this.bridge) return this.state;
    const version = ++this.operationVersion;
    this.update({ ...this.state, status: "checking", activeProvider: "local-rule", error: undefined });

    try {
      const result = await this.bridge.testConnection();
      if (version !== this.operationVersion) return this.state;
      if (result.ok === false) {
        this.update({
          ...this.state,
          status: result.error.code === "MODEL_UNCONFIGURED" ? "unconfigured" : "connection_failed",
          activeProvider: "local-rule",
          configured: result.error.code === "MODEL_UNCONFIGURED" ? false : this.state.configured,
          error: result.error,
          lastCheckedAt: this.now()
        });
        return this.state;
      }

      this.update({
        ...this.state,
        status: "remote_available",
        activeProvider: "remote-llm",
        configured: true,
        error: undefined,
        lastCheckedAt: this.now()
      });
    } catch (error) {
      if (version !== this.operationVersion) return this.state;
      this.update({
        ...this.state,
        status: "connection_failed",
        activeProvider: "local-rule",
        error: toModelConnectionError(error),
        lastCheckedAt: this.now()
      });
    }
    return this.state;
  }

  shouldAttemptRemote() {
    return Boolean(
      this.bridge &&
        (this.state.status === "configured" ||
          this.state.status === "checking" ||
          this.state.status === "remote_available")
    );
  }

  recordRemoteSuccess(decision: ModelDecision) {
    this.update({
      ...this.state,
      status: "remote_available",
      activeProvider: "remote-llm",
      configured: true,
      model: this.state.model ?? decision.model,
      error: undefined,
      lastCheckedAt: this.now()
    });
  }

  recordFallback(error: unknown) {
    const connectionError = toModelConnectionError(error);
    const unconfigured =
      connectionError.code === "MODEL_UNCONFIGURED" ||
      connectionError.code === "MODEL_BRIDGE_UNAVAILABLE";
    this.update({
      ...this.state,
      status: unconfigured ? "unconfigured" : "fallback_local",
      activeProvider: "local-rule",
      configured: unconfigured ? false : this.state.configured,
      error: connectionError,
      lastCheckedAt: this.now()
    });
  }

  private update(state: ModelConnectionState) {
    this.state = state;
    this.listeners.forEach((listener) => listener(state));
  }
}
