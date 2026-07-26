import type {
  AgentRuntimeSnapshot,
  AgentRuntimeSnapshotResult
} from "../features/agent-core/runtimeBridge";
import type { AgentUserEvent } from "../features/agent-core/types";

export type XunleiAppInfo = {
  name: string;
  version: string;
  platform: string;
  electron: string;
  chrome: string;
};

export type TaskHistorySummary = {
  taskId: string;
  task: string;
  phase: string;
  revision: number;
  approvedRevision: number | null;
  updatedAt: string;
  resourceCount: number;
  verifiedResourceCount: number;
  workspaceReady: boolean;
  hasErrors: boolean;
};

export type TaskHistoryApproval = {
  taskId: string;
  revision: number;
  actor: "local-user";
  approvedAt: string;
  expiresAt: string;
  status: "active" | "expired" | "revoked";
};

export type TaskHistoryWorkspaceExport = {
  taskId: string;
  revision: number;
  rootPath: string;
  generatedAt: string;
  reusedExisting: boolean;
  files: Array<{
    relativePath: string;
    absolutePath: string;
    bytesWritten: number;
    sha256: string;
  }>;
};

export type TaskHistoryDetail = {
  summary: TaskHistorySummary;
  state: unknown;
  approvals: TaskHistoryApproval[];
  workspaceExports: TaskHistoryWorkspaceExport[];
};

export type TaskHistoryIpcError = {
  code: "TASK_HISTORY_INVALID_REQUEST" | "TASK_HISTORY_READ_FAILED";
  message: string;
  retriable: boolean;
};

declare global {
  interface Window {
    xunleiAgent?: {
      getAppInfo: () => Promise<XunleiAppInfo>;
      getAgentRuntimeSnapshot: () => Promise<AgentRuntimeSnapshotResult>;
      dispatchAgentEvent: (event: AgentUserEvent) => Promise<AgentRuntimeSnapshotResult>;
      retryTaskLocally: () => Promise<AgentRuntimeSnapshotResult>;
      testModelConnection: () => Promise<AgentRuntimeSnapshotResult>;
      onAgentRuntimeSnapshot: (
        listener: (snapshot: AgentRuntimeSnapshot) => void
      ) => () => void;
      listTaskHistory: (limit?: number) => Promise<
        | { ok: true; history: TaskHistorySummary[] }
        | { ok: false; error: TaskHistoryIpcError }
      >;
      getTaskHistoryDetail: (taskId: string) => Promise<
        | { ok: true; detail: TaskHistoryDetail | null }
        | { ok: false; error: TaskHistoryIpcError }
      >;
      flushTaskPersistence: () => Promise<{ ok: true }>;
      readWorkspaceFile: (request: {
        taskId: string;
        revision: number;
        relativePath: string;
      }) => Promise<
        | { ok: true; content: string }
        | {
            ok: false;
            error: { code: string; message: string; retriable: boolean };
          }
      >;
      openWorkspace: (request: {
        taskId: string;
        revision: number;
      }) => Promise<{ ok: true } | { ok: false; error: string }>;
    };
  }
}
