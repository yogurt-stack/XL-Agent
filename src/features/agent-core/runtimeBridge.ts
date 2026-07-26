import type { ModelConnectionState } from "./modelConnection";
import type { AgentState } from "./types";

export type RuntimePersistenceState = {
  status: "loading" | "ready" | "error";
  restoredAt: string | null;
  lastSavedAt: string | null;
  error: string | null;
};

export type AgentRuntimeSnapshot = {
  state: AgentState;
  modelConnection: ModelConnectionState;
  persistence: RuntimePersistenceState;
};

export type AgentRuntimeIpcError = {
  code:
    | "AGENT_RUNTIME_UNAVAILABLE"
    | "AGENT_EVENT_INVALID"
    | "AGENT_EVENT_REJECTED";
  message: string;
  retriable: boolean;
};

export type AgentRuntimeSnapshotResult =
  | { ok: true; snapshot: AgentRuntimeSnapshot }
  | { ok: false; error: AgentRuntimeIpcError };
