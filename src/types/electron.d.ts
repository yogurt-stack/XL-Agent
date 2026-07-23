import type {
  ControlledDownloadResult,
  HostSystemProfile
} from "../features/agent-core/types";

export type XunleiAppInfo = {
  name: string;
  version: string;
  platform: string;
  electron: string;
  chrome: string;
};

export type ModelDecisionIpcResult =
  | { ok: true; decision: unknown }
  | { ok: false; error: ModelConnectionIpcError };

export type ModelConnectionIpcError = {
  code:
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
  message: string;
  retriable: boolean;
};

export type ModelConnectionInfoIpcResult =
  | {
      ok: true;
      info: {
        configured: boolean;
        endpointHost: string | null;
        model: string | null;
        error?: ModelConnectionIpcError;
      };
    }
  | { ok: false; error: ModelConnectionIpcError };

export type SystemProfileIpcResult =
  | { ok: true; profile: HostSystemProfile }
  | {
      ok: false;
      error: {
        code: "SYSTEM_PROFILE_UNAVAILABLE";
        message: string;
        retriable: boolean;
      };
    };

declare global {
  interface Window {
    xunleiAgent?: {
      getAppInfo: () => Promise<XunleiAppInfo>;
      readSystemProfile: () => Promise<SystemProfileIpcResult>;
      getModelConnectionInfo: () => Promise<ModelConnectionInfoIpcResult>;
      testModelConnection: () => Promise<ModelDecisionIpcResult>;
      requestModelDecision: (context: unknown) => Promise<ModelDecisionIpcResult>;
      controlledDownload: (resourceId: string) => Promise<ControlledDownloadResult>;
    };
  }
}
