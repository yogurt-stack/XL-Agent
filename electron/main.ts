import { app, BrowserWindow, ipcMain } from "electron";
import { config as loadEnv } from "dotenv";
import os from "node:os";
import path from "node:path";
import {
  downloadTrustedResource,
  toControlledDownloadError,
  type ControlledDownloadOutput
} from "./downloadClient";
import { RemoteModelClient, toModelConnectionError } from "./modelClient";
import { getTrustedDownloadMetadata, type TrustedDownloadMetadata } from "./trustedDownloadCatalog";

loadEnv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

app.setName("迅雷 AI Task Agent");

const remoteModelClient = new RemoteModelClient();
const downloadFixtureAttempts = new Map<string, number>();

type HostPlatform = "darwin" | "linux" | "win32" | "unknown";

type HostArchitecture = "x64" | "arm64" | "other";

type HostSystemProfile = {
  platform: HostPlatform;
  platformLabel: string;
  architecture: HostArchitecture;
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

function normalizePlatform(value: NodeJS.Platform): HostPlatform {
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  return "unknown";
}

function normalizeArchitecture(value: string): HostArchitecture {
  if (value === "x64" || value === "arm64") return value;
  return "other";
}

function platformLabel(platform: HostPlatform) {
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  if (platform === "win32") return "Windows";
  return "未知系统";
}

function shellBasename(rawShell: string | undefined) {
  if (!rawShell) return "unknown";
  return path.basename(rawShell).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "unknown";
}

function readHostSystemProfile(): HostSystemProfile {
  const platform = normalizePlatform(process.platform);
  return {
    platform,
    platformLabel: platformLabel(platform),
    architecture: normalizeArchitecture(process.arch),
    release: os.release().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "unknown",
    cpuCount: os.cpus().length,
    totalMemoryGb: Math.round(os.totalmem() / 1024 / 1024 / 1024),
    defaultShell: shellBasename(process.env.SHELL ?? process.env.ComSpec),
    collectedBy: "electron-main",
    collectedAt: new Date().toISOString(),
    privacy: {
      hostname: false,
      username: false,
      homeDirectory: false,
      environment: false,
      shellPath: false
    }
  };
}

function getControlledDownloadResourceId(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const resourceId = (value as Record<string, unknown>).resourceId;
  return typeof resourceId === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(resourceId)
    ? resourceId
    : null;
}

function fixtureDownload(
  resourceId: string,
  metadata: TrustedDownloadMetadata
): { ok: true; output: ControlledDownloadOutput } | {
  ok: false;
  error: { code: string; message: string; retriable: boolean };
} {
  const attempts = (downloadFixtureAttempts.get(resourceId) ?? 0) + 1;
  downloadFixtureAttempts.set(resourceId, attempts);
  if (resourceId === "sample-project" && attempts === 1) {
    return {
      ok: false,
      error: {
        code: "CHECKSUM_MISMATCH",
        message: "示例项目代码包校验失败：SHA256 与可信目录不一致",
        retriable: true
      }
    };
  }
  return {
    ok: true,
    output: {
      resourceId,
      urlHost: new URL(metadata.url).host,
      bytesWritten: 7,
      sha256: metadata.expectedSha256,
      tempFilePath: path.join(os.tmpdir(), "xunlei-agent-e2e", `${resourceId}.download`),
      elapsedMs: 1
    }
  };
}

function getDevServerUrl() {
  const rawUrl = process.env.VITE_DEV_SERVER_URL;
  if (!rawUrl) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    const isHttp = url.protocol === "http:";
    const isLoopback =
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]";

    return isHttp && isLoopback ? url.toString() : null;
  } catch {
    return null;
  }
}

function createMainWindow() {
  const devServerUrl = getDevServerUrl();
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: "迅雷 AI Task Agent",
    backgroundColor: "#121923",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

ipcMain.handle("app:getInfo", () => ({
  name: app.getName(),
  version: app.getVersion(),
  platform: process.platform,
  electron: process.versions.electron,
  chrome: process.versions.chrome
}));

ipcMain.handle("agent:readSystemProfile", () => {
  try {
    return { ok: true as const, profile: readHostSystemProfile() };
  } catch (error) {
    return {
      ok: false as const,
      error: {
        code: "SYSTEM_PROFILE_UNAVAILABLE" as const,
        message: error instanceof Error ? error.message : "系统画像读取失败。",
        retriable: true
      }
    };
  }
});

ipcMain.handle("agent:modelDecision", async (_event, context: unknown) => {
  try {
    return { ok: true as const, decision: await remoteModelClient.requestDecision(context) };
  } catch (error) {
    return {
      ok: false as const,
      error: toModelConnectionError(error)
    };
  }
});

ipcMain.handle("agent:controlledDownload", async (_event, input: unknown) => {
  const resourceId = getControlledDownloadResourceId(input);
  const metadata = resourceId ? getTrustedDownloadMetadata(resourceId) : null;
  if (!resourceId || !metadata) {
    return {
      ok: false as const,
      error: {
        code: "RESOURCE_NOT_TRUSTED",
        message: "请求的资源不在 Electron 主进程可信下载目录中。",
        retriable: false
      }
    };
  }

  if (
    process.env.NODE_ENV === "test" &&
    process.env.XL_AGENT_E2E_DOWNLOAD_FIXTURE === "1"
  ) {
    return fixtureDownload(resourceId, metadata);
  }

  try {
    return {
      ok: true as const,
      output: await downloadTrustedResource({ resourceId, ...metadata })
    };
  } catch (error) {
    return {
      ok: false as const,
      error: toControlledDownloadError(error)
    };
  }
});

ipcMain.handle("agent:modelConnectionInfo", () => ({
  ok: true as const,
  info: remoteModelClient.getSafeConnectionInfo()
}));

ipcMain.handle("agent:testModelConnection", async () => {
  try {
    return { ok: true as const, decision: await remoteModelClient.testConnection() };
  } catch (error) {
    return { ok: false as const, error: toModelConnectionError(error) };
  }
});

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
