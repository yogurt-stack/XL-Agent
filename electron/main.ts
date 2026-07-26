import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { config as loadEnv } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZodError } from "zod";
import type { AgentRuntimeSnapshot } from "../src/features/agent-core/runtimeBridge";
import { AgentRuntimeHost } from "./agentRuntimeHost";
import {
  downloadTrustedResource,
  toControlledDownloadError,
  type ControlledDownloadOptions,
  type ControlledDownloadOutput
} from "./downloadClient";
import { RemoteModelClient } from "./modelClient";
import { TaskStore } from "./taskStore";
import type { TrustedDownloadMetadata } from "./trustedDownloadCatalog";
import {
  LocalArtifactScanError,
  scanLocalArtifacts
} from "./localArtifacts";

loadEnv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

app.setName("迅雷 AI Task Agent");

const remoteModelClient = new RemoteModelClient();
const downloadFixtureAttempts = new Map<string, number>();
let taskStorePromise: Promise<TaskStore> | null = null;
let runtimeHostPromise: Promise<AgentRuntimeHost> | null = null;

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
  const taskId = getTaskId(input.taskId);
  const revision =
    typeof input.revision === "number" &&
    Number.isSafeInteger(input.revision) &&
    input.revision > 0
      ? input.revision
      : null;
  return taskId && revision ? { taskId, revision } : null;
}

function getTaskId(value: unknown) {
  return typeof value === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)
    ? value
    : null;
}

function getTaskHistoryLimit(value: unknown) {
  if (value === undefined) return 50;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const limit = (value as Record<string, unknown>).limit;
  return typeof limit === "number" &&
    Number.isSafeInteger(limit) &&
    limit >= 1 &&
    limit <= 100
    ? limit
    : null;
}

async function fixtureDownload(
  resourceId: string,
  metadata: TrustedDownloadMetadata
): Promise<{ ok: true; output: ControlledDownloadOutput } | {
  ok: false;
  error: { code: string; message: string; retriable: boolean };
}> {
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
  const fileName = `${resourceId}.download`;
  const artifactRoot = path.join(os.tmpdir(), "xunlei-agent-e2e");
  const tempFilePath = path.join(artifactRoot, fileName);
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(tempFilePath, `fixture:${resourceId}`, { flag: "w" });
  return {
    ok: true,
    output: {
      resourceId,
      fileName,
      urlHost: new URL(metadata.url).host,
      bytesWritten: Buffer.byteLength(`fixture:${resourceId}`),
      sha256: metadata.expectedSha256,
      tempFilePath,
      elapsedMs: 1
    }
  };
}

async function performTrustedDownload(
  resourceId: string,
  metadata: TrustedDownloadMetadata,
  options: ControlledDownloadOptions = {}
) {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.XL_AGENT_E2E_DOWNLOAD_FIXTURE === "1"
  ) {
    const result = await fixtureDownload(resourceId, metadata);
    if (result.ok) {
      await options.onProgress?.({
        resourceId,
        bytesWritten: result.output.bytesWritten,
        totalBytes: result.output.bytesWritten,
        progress: 99,
        speedBytesPerSecond: result.output.bytesWritten,
        etaSeconds: 0
      });
    }
    return result;
  }

  try {
    return {
      ok: true as const,
      output: await downloadTrustedResource(
        { resourceId, ...metadata },
        options
      )
    };
  } catch (error) {
    return {
      ok: false as const,
      error: toControlledDownloadError(error)
    };
  }
}

function broadcastRuntimeSnapshot(snapshot: AgentRuntimeSnapshot) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("agent:runtimeSnapshot", snapshot);
    }
  }
}

function getAgentRuntimeHost() {
  if (!runtimeHostPromise) {
    runtimeHostPromise = getTaskStore().then((store) =>
      AgentRuntimeHost.create({
        store,
        modelClient: remoteModelClient,
        workspaceRoot: getWorkspaceRoot(),
        performDownload: performTrustedDownload,
        onSnapshot: broadcastRuntimeSnapshot
      })
    );
  }
  return runtimeHostPromise;
}

function getDevServerUrl() {
  const rawUrl = process.env.VITE_DEV_SERVER_URL;
  if (!rawUrl) return null;

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
    void mainWindow.loadFile(path.resolve(__dirname, "../../dist/index.html"));
  }
}

function runtimeIpcFailure(error: unknown) {
  return {
    ok: false as const,
    error: {
      code: error instanceof ZodError
        ? "AGENT_EVENT_INVALID" as const
        : "AGENT_EVENT_REJECTED" as const,
      message:
        error instanceof ZodError
          ? "Renderer 派发了不符合协议的 Agent 用户事件。"
          : error instanceof Error
            ? error.message
            : "Electron Main 拒绝了 Agent 用户事件。",
      retriable: false
    }
  };
}

ipcMain.handle("app:getInfo", () => ({
  name: app.getName(),
  version: app.getVersion(),
  platform: process.platform,
  electron: process.versions.electron,
  chrome: process.versions.chrome
}));

ipcMain.handle("agent:getRuntimeSnapshot", async () => {
  try {
    return { ok: true as const, snapshot: (await getAgentRuntimeHost()).getSnapshot() };
  } catch (error) {
    return {
      ok: false as const,
      error: {
        code: "AGENT_RUNTIME_UNAVAILABLE" as const,
        message: error instanceof Error ? error.message : "Agent Runtime 初始化失败。",
        retriable: true
      }
    };
  }
});

ipcMain.handle("agent:dispatchUserEvent", async (_event, value: unknown) => {
  try {
    return {
      ok: true as const,
      snapshot: await (await getAgentRuntimeHost()).dispatch(value)
    };
  } catch (error) {
    return runtimeIpcFailure(error);
  }
});

ipcMain.handle("agent:retryTaskLocally", async () => {
  try {
    return {
      ok: true as const,
      snapshot: (await getAgentRuntimeHost()).retryTaskLocally()
    };
  } catch (error) {
    return runtimeIpcFailure(error);
  }
});

ipcMain.handle("agent:testModelConnection", async () => {
  try {
    return {
      ok: true as const,
      snapshot: await (await getAgentRuntimeHost()).testModelConnection()
    };
  } catch (error) {
    return {
      ok: false as const,
      error: {
        code: "AGENT_RUNTIME_UNAVAILABLE" as const,
        message: error instanceof Error ? error.message : "模型连接测试失败。",
        retriable: true
      }
    };
  }
});

ipcMain.handle("agent:listTaskHistory", async (_event, input: unknown) => {
  const limit = getTaskHistoryLimit(input);
  if (limit === null) {
    return {
      ok: false as const,
      error: {
        code: "TASK_HISTORY_INVALID_REQUEST",
        message: "历史任务列表请求的 limit 必须是 1 到 100 之间的整数。",
        retriable: false
      }
    };
  }
  try {
    return {
      ok: true as const,
      history: await (await getTaskStore()).listTaskHistory(limit)
    };
  } catch {
    return {
      ok: false as const,
      error: {
        code: "TASK_HISTORY_READ_FAILED",
        message: "SQLite 历史任务列表读取失败。",
        retriable: true
      }
    };
  }
});

ipcMain.handle("agent:getTaskHistoryDetail", async (_event, input: unknown) => {
  const taskId =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? getTaskId((input as Record<string, unknown>).taskId)
      : null;
  if (!taskId) {
    return {
      ok: false as const,
      error: {
        code: "TASK_HISTORY_INVALID_REQUEST",
        message: "历史任务详情请求缺少合法的 taskId。",
        retriable: false
      }
    };
  }
  try {
    return {
      ok: true as const,
      detail: await (await getTaskStore()).getTaskHistoryDetail(taskId)
    };
  } catch {
    return {
      ok: false as const,
      error: {
        code: "TASK_HISTORY_READ_FAILED",
        message: "SQLite 历史任务详情读取失败。",
        retriable: true
      }
    };
  }
});

ipcMain.handle("agent:flushTaskPersistence", async () => {
  await (await getAgentRuntimeHost()).flushPersistence();
  return { ok: true as const };
});

ipcMain.handle("agent:selectLocalResources", async () => {
  const host = await getAgentRuntimeHost();
  const state = host.getSnapshot().state;
  if (
    state.taskId === "unassigned" ||
    state.phase === "downloading" ||
    state.phase === "verifying" ||
    state.phase === "exporting"
  ) {
    return {
      ok: false as const,
      error: {
        code: "LOCAL_RESOURCE_NOT_ALLOWED",
        message: "请先创建任务，并在执行下载前接入本地资源。",
        retriable: false
      }
    };
  }
  const result = await dialog.showOpenDialog({
    title: "选择要交给 Agent 的本地资源",
    properties: ["openFile", "openDirectory", "multiSelections"]
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: true as const, snapshot: host.getSnapshot(), imported: 0 };
  }
  try {
    const currentPlanRevision = Math.max(1, state.revision);
    const scannedRecords = await scanLocalArtifacts(result.filePaths, {
      taskId: state.taskId,
      planRevision: currentPlanRevision
    });
    const planRevision =
      state.phase === "waiting_approval" &&
      scannedRecords.some((record) => record.matchedResourceId)
        ? currentPlanRevision + 1
        : currentPlanRevision;
    const records = scannedRecords.map((record) => ({
      ...record,
      planRevision
    }));
    return {
      ok: true as const,
      snapshot: await host.addLocalArtifacts(records),
      imported: records.length
    };
  } catch (error) {
    return {
      ok: false as const,
      error: {
        code:
          error instanceof LocalArtifactScanError
            ? error.code
            : "LOCAL_RESOURCE_READ_FAILED",
        message:
          error instanceof Error ? error.message : "本地资源接入失败。",
        retriable: false
      }
    };
  }
});

ipcMain.handle("agent:selectWorkspaceRoot", async () => {
  const host = await getAgentRuntimeHost();
  const result = await dialog.showOpenDialog({
    title: "选择 Agent 工作区保存目录",
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || result.filePaths.length !== 1) {
    return { ok: true as const, snapshot: host.getSnapshot(), selected: false };
  }
  return {
    ok: true as const,
    snapshot: host.selectWorkspaceRoot(result.filePaths[0]),
    selected: true
  };
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
  if (relativePath.startsWith("downloads/")) {
    return {
      ok: false as const,
      error: {
        code: "WORKSPACE_FILE_BINARY_PREVIEW_UNSUPPORTED",
        message: "下载物是二进制资源，请通过打开工作目录查看，Renderer 不读取其内容。",
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

app.whenReady().then(async () => {
  await getAgentRuntimeHost();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("before-quit", () => {
  void runtimeHostPromise?.then(async (host) => {
    await host.flushPersistence();
    host.stop();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
