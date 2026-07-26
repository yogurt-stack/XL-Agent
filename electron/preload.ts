import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentRuntimeSnapshot,
  AgentRuntimeSnapshotResult
} from "../src/features/agent-core/runtimeBridge";
import type { AgentUserEvent } from "../src/features/agent-core/types";

type AppInfo = {
  name: string;
  version: string;
  platform: string;
  electron: string;
  chrome: string;
};

type TaskHistorySummary = {
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

type TaskHistoryDetail = {
  summary: TaskHistorySummary;
  state: unknown;
  approvals: Array<{
    taskId: string;
    revision: number;
    actor: "local-user";
    approvedAt: string;
    expiresAt: string;
    status: "active" | "expired" | "revoked";
  }>;
  workspaceExports: Array<{
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
  }>;
};

type TaskHistoryError = {
  code: "TASK_HISTORY_INVALID_REQUEST" | "TASK_HISTORY_READ_FAILED";
  message: string;
  retriable: boolean;
};

type TaskHistoryListResult =
  | { ok: true; history: TaskHistorySummary[] }
  | { ok: false; error: TaskHistoryError };

type TaskHistoryDetailResult =
  | { ok: true; detail: TaskHistoryDetail | null }
  | { ok: false; error: TaskHistoryError };

contextBridge.exposeInMainWorld("xunleiAgent", {
  getAppInfo: () => ipcRenderer.invoke("app:getInfo") as Promise<AppInfo>,
  getAgentRuntimeSnapshot: () =>
    ipcRenderer.invoke("agent:getRuntimeSnapshot") as Promise<AgentRuntimeSnapshotResult>,
  dispatchAgentEvent: (event: AgentUserEvent) =>
    ipcRenderer.invoke("agent:dispatchUserEvent", event) as Promise<AgentRuntimeSnapshotResult>,
  retryTaskLocally: () =>
    ipcRenderer.invoke("agent:retryTaskLocally") as Promise<AgentRuntimeSnapshotResult>,
  testModelConnection: () =>
    ipcRenderer.invoke("agent:testModelConnection") as Promise<AgentRuntimeSnapshotResult>,
  onAgentRuntimeSnapshot: (listener: (snapshot: AgentRuntimeSnapshot) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: AgentRuntimeSnapshot) => {
      listener(snapshot);
    };
    ipcRenderer.on("agent:runtimeSnapshot", wrapped);
    return () => ipcRenderer.removeListener("agent:runtimeSnapshot", wrapped);
  },
  listTaskHistory: (limit = 50) =>
    ipcRenderer.invoke("agent:listTaskHistory", { limit }) as Promise<TaskHistoryListResult>,
  getTaskHistoryDetail: (taskId: string) =>
    ipcRenderer.invoke("agent:getTaskHistoryDetail", { taskId }) as Promise<TaskHistoryDetailResult>,
  flushTaskPersistence: () =>
    ipcRenderer.invoke("agent:flushTaskPersistence") as Promise<{ ok: true }>,
  selectLocalResources: () =>
    ipcRenderer.invoke("agent:selectLocalResources") as Promise<
      | {
          ok: true;
          snapshot: AgentRuntimeSnapshot;
          imported: number;
        }
      | {
          ok: false;
          error: { code: string; message: string; retriable: boolean };
        }
    >,
  selectWorkspaceRoot: () =>
    ipcRenderer.invoke("agent:selectWorkspaceRoot") as Promise<
      | {
          ok: true;
          snapshot: AgentRuntimeSnapshot;
          selected: boolean;
        }
      | {
          ok: false;
          error: { code: string; message: string; retriable: boolean };
        }
    >,
  readWorkspaceFile: (request: {
    taskId: string;
    revision: number;
    relativePath: string;
  }) =>
    ipcRenderer.invoke("agent:readWorkspaceFile", request) as Promise<
      | { ok: true; content: string }
      | {
          ok: false;
          error: { code: string; message: string; retriable: boolean };
        }
    >,
  openWorkspace: (request: { taskId: string; revision: number }) =>
    ipcRenderer.invoke("agent:openWorkspace", request) as Promise<
      { ok: true } | { ok: false; error: string }
    >
});
