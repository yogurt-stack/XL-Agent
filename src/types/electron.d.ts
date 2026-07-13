export type XunleiAppInfo = {
  name: string;
  version: string;
  platform: string;
  electron: string;
  chrome: string;
};

export type ModelDecisionIpcResult =
  | { ok: true; decision: unknown }
  | { ok: false; error: string };

declare global {
  interface Window {
    xunleiAgent?: {
      getAppInfo: () => Promise<XunleiAppInfo>;
      requestModelDecision: (context: unknown) => Promise<ModelDecisionIpcResult>;
    };
  }
}
