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
      resetDemoData: () => Promise<
        | {
            ok: true;
            snapshot: AgentRuntimeSnapshot;
            reset: {
              resetAt: string;
              removedRecords: number;
              cleanupWarning: string | null;
            };
          }
        | {
            ok: false;
            error: { code: string; message: string; retriable: boolean };
          }
      >;
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
      selectLocalRepository: () => Promise<
        | {
            ok: true;
            snapshot: AgentRuntimeSnapshot;
            imported: boolean;
          }
        | {
            ok: false;
            error: { code: string; message: string; retriable: boolean };
          }
      >;
      prepareGitHubPublish: (input: {
        repositoryName: string;
        visibility: "private" | "public";
        branch?: string;
        commitMessage?: string;
      }) => Promise<
        | { ok: true; snapshot: AgentRuntimeSnapshot }
        | {
            ok: false;
            error: { code: string; message: string; retriable: boolean };
          }
      >;
      approveGitHubPublish: (input: {
        publishId: string;
        planSha256: string;
      }) => Promise<
        | { ok: true; snapshot: AgentRuntimeSnapshot }
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
