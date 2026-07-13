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
  | { ok: false; error: string };

contextBridge.exposeInMainWorld("xunleiAgent", {
  getAppInfo: () => ipcRenderer.invoke("app:getInfo") as Promise<AppInfo>,
  requestModelDecision: (context: unknown) =>
    ipcRenderer.invoke("agent:modelDecision", context) as Promise<ModelDecisionIpcResult>
});
