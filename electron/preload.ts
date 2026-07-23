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
  controlledDownload: (resourceId: string) =>
    ipcRenderer.invoke("agent:controlledDownload", { resourceId }) as Promise<ControlledDownloadResult>
});
