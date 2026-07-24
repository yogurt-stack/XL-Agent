import { app, BrowserWindow, ipcMain, shell } from "electron";
import { config as loadEnv } from "dotenv";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  downloadTrustedResource,
  toControlledDownloadError,
  type ControlledDownloadOutput
} from "./downloadClient";
import { RemoteModelClient, toModelConnectionError } from "./modelClient";
import { TaskStore } from "./taskStore";
import { getTrustedDownloadMetadata, type TrustedDownloadMetadata } from "./trustedDownloadCatalog";
import {
  exportWorkspace,
  toWorkspaceExportError
} from "./workspaceExporter";

loadEnv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

app.setName("迅雷 AI Task Agent");

const remoteModelClient = new RemoteModelClient();
const downloadFixtureAttempts = new Map<string, number>();
let taskStorePromise: Promise<TaskStore> | null = null;

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

function safePositiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getTaskStore() {
  if (!taskStorePromise) {
    const configuredPath = process.env.XL_AGENT_TASK_STORE_PATH;
    const databasePath =
      configuredPath && path.isAbsolute(configuredPath)
        ? configuredPath
        : path.join(app.getPath("userData"), "agent-tasks.sqlite");
    taskStorePromise = TaskStore.open({
      databasePath,
      approvalTtlMs: safePositiveInteger(
        process.env.XL_AGENT_APPROVAL_TTL_MS,
        30 * 60 * 1000
      )
    });
  }
  return taskStorePromise;
}

function getWorkspaceRoot() {
  const configuredRoot = process.env.XL_AGENT_WORKSPACE_ROOT;
  return configuredRoot && path.isAbsolute(configuredRoot)
    ? configuredRoot
    : path.join(app.getPath("userData"), "workspaces");
}

function getTaskRevisionInput(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const taskId =
    typeof input.taskId === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(input.taskId)
      ? input.taskId
      : null;
  const revision =
    typeof input.revision === "number" &&
    Number.isSafeInteger(input.revision) &&
    input.revision > 0
      ? input.revision
      : null;
  return taskId && revision ? { taskId, revision } : null;
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
  const taskRevision = getTaskRevisionInput(input);
  const metadata = resourceId ? getTrustedDownloadMetadata(resourceId) : null;
  if (!resourceId || !metadata || !taskRevision) {
    return {
      ok: false as const,
      error: {
        code: "RESOURCE_NOT_TRUSTED",
        message: "请求的资源不在 Electron 主进程可信下载目录中。",
        retriable: false
      }
    };
  }

  const approval = await (
    await getTaskStore()
  ).hasValidApproval(taskRevision.taskId, taskRevision.revision);
  if (!approval.valid) {
    return {
      ok: false as const,
      error: {
        code:
          approval.status === "expired"
            ? "APPROVAL_EXPIRED"
            : "APPROVAL_NOT_FOUND",
        message:
          approval.status === "expired"
            ? "当前下载审批已过期，请重新确认资源计划。"
            : "Electron 主进程未找到当前 revision 的有效用户审批。",
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

ipcMain.handle("agent:saveTaskState", async (_event, state: unknown) => {
  try {
    return {
      ok: true as const,
      ...(await (await getTaskStore()).saveSnapshot(state))
    };
  } catch (error) {
    return {
      ok: false as const,
      error: {
        code: "TASK_PERSISTENCE_WRITE_FAILED",
        message: error instanceof Error ? error.message : "SQLite 任务状态写入失败。",
        retriable: true
      }
    };
  }
});

ipcMain.handle("agent:loadTaskState", async () => {
  try {
    return {
      ok: true as const,
      restored: await (await getTaskStore()).loadLatestUnfinished()
    };
  } catch (error) {
    return {
      ok: false as const,
      error: {
        code: "TASK_PERSISTENCE_READ_FAILED",
        message: error instanceof Error ? error.message : "SQLite 任务状态读取失败。",
        retriable: true
      }
    };
  }
});

ipcMain.handle("agent:flushTaskPersistence", async () => {
  await (await getTaskStore()).flush();
  return { ok: true as const };
});

ipcMain.handle("agent:exportWorkspace", async (_event, input: unknown) => {
  const taskRevision = getTaskRevisionInput(input);
  if (!taskRevision) {
    return {
      ok: false as const,
      error: {
        code: "WORKSPACE_EXPORT_INVALID_STATE",
        message: "工作区导出请求缺少合法的 taskId 或 revision。",
        retriable: false
      }
    };
  }

  try {
    const store = await getTaskStore();
    const approval = await store.hasValidApproval(
      taskRevision.taskId,
      taskRevision.revision
    );
    if (!approval.valid) {
      return {
        ok: false as const,
        error: {
          code:
            approval.status === "expired"
              ? "APPROVAL_EXPIRED"
              : "APPROVAL_NOT_FOUND",
          message:
            approval.status === "expired"
              ? "当前工作区导出审批已过期，请重新确认资源计划。"
              : "Electron 主进程未找到当前 revision 的有效工作区导出审批。",
          retriable: false
        }
      };
    }
    const state = await store.getTaskState(taskRevision.taskId);
    if (!state || state.revision !== taskRevision.revision) {
      return {
        ok: false as const,
        error: {
          code: "WORKSPACE_EXPORT_INVALID_STATE",
          message: "SQLite 中没有与导出请求匹配的任务快照。",
          retriable: false
        }
      };
    }
    const output = await exportWorkspace(state, {
      workspaceRoot: getWorkspaceRoot()
    });
    await store.recordWorkspaceExport(output);
    return { ok: true as const, output };
  } catch (error) {
    return { ok: false as const, error: toWorkspaceExportError(error) };
  }
});

ipcMain.handle("agent:readWorkspaceFile", async (_event, input: unknown) => {
  const taskRevision = getTaskRevisionInput(input);
  const relativePath =
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    typeof (input as Record<string, unknown>).relativePath === "string"
      ? (input as Record<string, string>).relativePath
      : null;
  if (!taskRevision || !relativePath) {
    return {
      ok: false as const,
      error: {
        code: "WORKSPACE_FILE_INVALID",
        message: "工作区文件读取请求无效。",
        retriable: false
      }
    };
  }
  const output = await (
    await getTaskStore()
  ).getWorkspaceExport(taskRevision.taskId, taskRevision.revision);
  const file = output?.files.find(
    (candidate) => candidate.relativePath === relativePath
  );
  if (!file) {
    return {
      ok: false as const,
      error: {
        code: "WORKSPACE_FILE_NOT_FOUND",
        message: "请求的文件不属于已记录的工作区导出。",
        retriable: false
      }
    };
  }
  try {
    const content = await readFile(file.absolutePath, "utf8");
    return { ok: true as const, content };
  } catch (error) {
    return {
      ok: false as const,
      error: {
        code: "WORKSPACE_FILE_READ_FAILED",
        message: error instanceof Error ? error.message : "工作区文件读取失败。",
        retriable: true
      }
    };
  }
});

ipcMain.handle("agent:openWorkspace", async (_event, input: unknown) => {
  const taskRevision = getTaskRevisionInput(input);
  if (!taskRevision) {
    return { ok: false as const, error: "工作区打开请求无效。" };
  }
  const output = await (
    await getTaskStore()
  ).getWorkspaceExport(taskRevision.taskId, taskRevision.revision);
  if (!output) {
    return { ok: false as const, error: "未找到已导出的工作区。" };
  }
  const error = await shell.openPath(output.rootPath);
  return error
    ? { ok: false as const, error }
    : { ok: true as const };
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

app.whenReady().then(async () => {
  await getTaskStore();
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
