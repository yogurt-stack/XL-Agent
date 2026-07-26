import type {
  AgentRuntimeSnapshot,
  AgentRuntimeSnapshotResult
} from "../features/agent-core/runtimeBridge";
import type { AgentUserEvent } from "../features/agent-core/types";
import type {
  TaskHistoryDetailPayload as TaskHistoryDetail,
  TaskHistoryIpcError,
  TaskHistorySummary
} from "../features/task-history/types";

export type XunleiAppInfo = {
  name: string;
  version: string;
  platform: string;
  electron: string;
  chrome: string;
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
      selectLocalResources: () => Promise<
        | {
            ok: true;
            snapshot: AgentRuntimeSnapshot;
            imported: number;
          }
        | {
            ok: false;
            error: { code: string; message: string; retriable: boolean };
          }
      >;
      selectWorkspaceRoot: () => Promise<
        | {
            ok: true;
            snapshot: AgentRuntimeSnapshot;
            selected: boolean;
          }
        | {
            ok: false;
            error: { code: string; message: string; retriable: boolean };
          }
      >;
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
