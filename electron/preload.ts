import { contextBridge, ipcRenderer } from "electron";

type AppInfo = {
  name: string;
  version: string;
  platform: string;
  electron: string;
  chrome: string;
};

type ModelDecisionIpcResult =
  | { ok: true; decision: unknown }
  | { ok: false; error: ModelConnectionError };

type ModelConnectionError = {
  code: string;
  message: string;
  retriable: boolean;
};

type ModelConnectionInfoIpcResult =
  | {
      ok: true;
      info: {
        configured: boolean;
        endpointHost: string | null;
        model: string | null;
        error?: ModelConnectionError;
      };
    }
  | { ok: false; error: ModelConnectionError };

type HostSystemProfile = {
  platform: "darwin" | "linux" | "win32" | "unknown";
  platformLabel: string;
  architecture: "x64" | "arm64" | "other";
  release: string;
  cpuCount: number;
  totalMemoryGb: number;
  defaultShell: string;
  collectedBy: "electron-main";
  collectedAt: string;
  privacy: {
    hostname: false;
    username: false;
    homeDirectory: false;
    environment: false;
    shellPath: false;
  };
};

type SystemProfileIpcResult =
  | { ok: true; profile: HostSystemProfile }
  | {
      ok: false;
      error: {
        code: "SYSTEM_PROFILE_UNAVAILABLE";
        message: string;
        retriable: boolean;
      };
    };

type ControlledDownloadResult =
  | {
      ok: true;
      output: {
        resourceId: string;
        urlHost: string;
        bytesWritten: number;
        sha256: string;
        tempFilePath: string;
        elapsedMs: number;
      };
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        retriable: boolean;
      };
    };

type TaskPersistenceResult =
  | { ok: true; savedAt: string }
  | {
      ok: false;
      error: { code: string; message: string; retriable: boolean };
    };

type TaskRestoreResult =
  | {
      ok: true;
      restored: null | {
        state: unknown;
        approval: { valid: boolean; expiresAt: string | null };
        savedAt: string;
      };
    }
  | {
      ok: false;
      error: { code: string; message: string; retriable: boolean };
    };

type WorkspaceExportResult =
  | {
      ok: true;
      output: {
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
    }
  | {
      ok: false;
      error: { code: string; message: string; retriable: boolean };
    };

contextBridge.exposeInMainWorld("xunleiAgent", {
  getAppInfo: () => ipcRenderer.invoke("app:getInfo") as Promise<AppInfo>,
  readSystemProfile: () =>
    ipcRenderer.invoke("agent:readSystemProfile") as Promise<SystemProfileIpcResult>,
  getModelConnectionInfo: () =>
    ipcRenderer.invoke("agent:modelConnectionInfo") as Promise<ModelConnectionInfoIpcResult>,
  testModelConnection: () =>
    ipcRenderer.invoke("agent:testModelConnection") as Promise<ModelDecisionIpcResult>,
  requestModelDecision: (context: unknown) =>
    ipcRenderer.invoke("agent:modelDecision", context) as Promise<ModelDecisionIpcResult>,
  controlledDownload: (request: {
    resourceId: string;
    taskId: string;
    revision: number;
  }) =>
    ipcRenderer.invoke("agent:controlledDownload", request) as Promise<ControlledDownloadResult>,
  saveTaskState: (state: unknown) =>
    ipcRenderer.invoke("agent:saveTaskState", state) as Promise<TaskPersistenceResult>,
  loadTaskState: () =>
    ipcRenderer.invoke("agent:loadTaskState") as Promise<TaskRestoreResult>,
  flushTaskPersistence: () =>
    ipcRenderer.invoke("agent:flushTaskPersistence") as Promise<{ ok: true }>,
  exportWorkspace: (request: { taskId: string; revision: number }) =>
    ipcRenderer.invoke("agent:exportWorkspace", request) as Promise<WorkspaceExportResult>,
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
