import type { ModelConnectionState } from "./modelConnection";
import type { AgentState } from "./types";

export const AGENT_RUNTIME_SNAPSHOT_PROTOCOL_VERSION = 1 as const;

export type AgentRuntimeSnapshotEnvelope = {
  protocolVersion: number;
  runtimeInstanceId: string;
  sequence: number;
};

export type AgentRuntimeSnapshotCursor = {
  runtimeInstanceId: string;
  sequence: number;
  retiredRuntimeInstanceIds: readonly string[];
};

export type AgentRuntimeSnapshotAcceptance =
  | {
      accepted: true;
      reason: "first" | "newer" | "new-instance";
      cursor: AgentRuntimeSnapshotCursor;
    }
  | {
      accepted: false;
      reason:
        | "incompatible-protocol"
        | "invalid-envelope"
        | "stale-sequence"
        | "retired-instance";
      cursor: AgentRuntimeSnapshotCursor | null;
    };

function readSnapshotEnvelope(
  value: unknown
): AgentRuntimeSnapshotEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.protocolVersion !== "number" ||
    typeof candidate.runtimeInstanceId !== "string" ||
    !candidate.runtimeInstanceId.trim() ||
    typeof candidate.sequence !== "number" ||
    !Number.isSafeInteger(candidate.sequence) ||
    candidate.sequence < 0
  ) {
    return null;
  }
  return {
    protocolVersion: candidate.protocolVersion,
    runtimeInstanceId: candidate.runtimeInstanceId,
    sequence: candidate.sequence
  };
}

/**
 * 判定来自 Main 的快照是否可以覆盖 Renderer 当前已接收的快照。
 *
 * sequence 只在同一个 Main Runtime 实例内比较。首次看到的新实例会被接收，
 * 原实例随后进入 retired 集合，避免它的延迟 IPC 响应再次覆盖新实例状态。
 */
export function classifyAgentRuntimeSnapshot(
  current: AgentRuntimeSnapshotCursor | null,
  candidate: unknown
): AgentRuntimeSnapshotAcceptance {
  const envelope = readSnapshotEnvelope(candidate);
  if (!envelope) {
    return { accepted: false, reason: "invalid-envelope", cursor: current };
  }
  if (
    envelope.protocolVersion !== AGENT_RUNTIME_SNAPSHOT_PROTOCOL_VERSION
  ) {
    return {
      accepted: false,
      reason: "incompatible-protocol",
      cursor: current
    };
  }
  if (!current) {
    return {
      accepted: true,
      reason: "first",
      cursor: {
        runtimeInstanceId: envelope.runtimeInstanceId,
        sequence: envelope.sequence,
        retiredRuntimeInstanceIds: []
      }
    };
  }
  if (current.runtimeInstanceId === envelope.runtimeInstanceId) {
    if (envelope.sequence <= current.sequence) {
      return {
        accepted: false,
        reason: "stale-sequence",
        cursor: current
      };
    }
    return {
      accepted: true,
      reason: "newer",
      cursor: { ...current, sequence: envelope.sequence }
    };
  }
  if (current.retiredRuntimeInstanceIds.includes(envelope.runtimeInstanceId)) {
    return {
      accepted: false,
      reason: "retired-instance",
      cursor: current
    };
  }
  return {
    accepted: true,
    reason: "new-instance",
    cursor: {
      runtimeInstanceId: envelope.runtimeInstanceId,
      sequence: envelope.sequence,
      retiredRuntimeInstanceIds: [
        ...current.retiredRuntimeInstanceIds,
        current.runtimeInstanceId
      ]
    }
  };
}

export type RuntimePersistenceState = {
  status: "loading" | "ready" | "error";
  restoredAt: string | null;
  lastSavedAt: string | null;
  lastResetAt: string | null;
  lastResetRemovedRecords: number;
  error: string | null;
};

export type PlatformCapabilitySummary = {
  domainSkills: Array<{
    id: string;
    displayName: string;
  }>;
  sourceProviders: Array<{
    id: string;
  }>;
  workspaceTemplates: Array<{
    id: string;
  }>;
  githubPublish?: {
    configured: boolean;
    credentialBoundary: "separate-write-token";
    existingRepositoryPolicy: "create-only";
  };
};

export type AgentRuntimeSnapshot = {
  protocolVersion: typeof AGENT_RUNTIME_SNAPSHOT_PROTOCOL_VERSION;
  runtimeInstanceId: string;
  sequence: number;
  state: AgentState;
  modelConnection: ModelConnectionState;
  persistence: RuntimePersistenceState;
  capabilities: PlatformCapabilitySummary;
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
