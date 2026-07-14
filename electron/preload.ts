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

contextBridge.exposeInMainWorld("xunleiAgent", {
  getAppInfo: () => ipcRenderer.invoke("app:getInfo") as Promise<AppInfo>,
  getModelConnectionInfo: () =>
    ipcRenderer.invoke("agent:modelConnectionInfo") as Promise<ModelConnectionInfoIpcResult>,
  testModelConnection: () =>
    ipcRenderer.invoke("agent:testModelConnection") as Promise<ModelDecisionIpcResult>,
  requestModelDecision: (context: unknown) =>
    ipcRenderer.invoke("agent:modelDecision", context) as Promise<ModelDecisionIpcResult>
});
