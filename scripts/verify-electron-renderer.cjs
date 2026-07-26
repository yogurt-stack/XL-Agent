const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const { createMockAgentRuntime } = require(
  path.join(root, "dist-electron", "src", "features", "agent-core", "runtime.js")
);
const { LocalRuleModelRuntime } = require(
  path.join(root, "dist-electron", "src", "features", "agent-core", "localRuleModel.js")
);
const testApiKey = "renderer-smoke-secret";
const expectedElectronMajor = Number(
  require(path.join(root, "package.json")).devDependencies.electron.match(/\d+/)?.[0]
);
const runtime = createMockAgentRuntime(new LocalRuleModelRuntime());
let latestTaskState = runtime.getState();
let modelConnection = {
  status: "configured",
  activeProvider: "local-rule",
  configured: true,
  endpointHost: "models.example.test",
  model: "renderer-smoke-model",
  lastCheckedAt: null
};

const runtimeSnapshot = () => ({
  state: runtime.getState(),
  modelConnection,
  persistence: {
    status: "ready",
    restoredAt: null,
    lastSavedAt: latestTaskState.taskId === "unassigned"
      ? null
      : "2026-07-24T00:00:00.000Z",
    error: null
  }
});

const broadcastRuntimeSnapshot = () => {
  const snapshot = runtimeSnapshot();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("agent:runtimeSnapshot", snapshot);
  }
};

runtime.subscribe((state) => {
  latestTaskState = state;
  broadcastRuntimeSnapshot();
});
runtime.start();

ipcMain.handle("agent:getRuntimeSnapshot", () => ({
  ok: true,
  snapshot: runtimeSnapshot()
}));

ipcMain.handle("agent:dispatchUserEvent", (_event, input) => {
  runtime.dispatch(input);
  return { ok: true, snapshot: runtimeSnapshot() };
});

ipcMain.handle("agent:retryTaskLocally", () => ({
  ok: true,
  snapshot: runtimeSnapshot()
}));

ipcMain.handle("agent:testModelConnection", () => {
  modelConnection = {
    ...modelConnection,
    status: "remote_available",
    activeProvider: "remote-llm",
    lastCheckedAt: "2026-07-24T00:00:00.000Z"
  };
  broadcastRuntimeSnapshot();
  return { ok: true, snapshot: runtimeSnapshot() };
});

ipcMain.handle("agent:listTaskHistory", () => ({
  ok: true,
  history: latestTaskState
    ? [
        {
          taskId: latestTaskState.taskId,
          task: latestTaskState.task,
          phase: latestTaskState.phase,
          revision: latestTaskState.revision,
          approvedRevision: latestTaskState.approvedRevision,
          updatedAt: "2026-07-24T00:00:00.000Z",
          resourceCount: latestTaskState.resources.length,
          verifiedResourceCount: latestTaskState.resources.filter(
            (resource) => resource.status === "verified"
          ).length,
          workspaceReady: latestTaskState.workspace.ready,
          hasErrors: latestTaskState.logs.some((entry) => entry.level === "error")
        }
      ]
    : []
}));

ipcMain.handle("agent:getTaskHistoryDetail", (_event, input) => ({
  ok: true,
  detail:
    latestTaskState?.taskId === input.taskId
      ? {
          summary: {
            taskId: latestTaskState.taskId,
            task: latestTaskState.task,
            phase: latestTaskState.phase,
            revision: latestTaskState.revision,
            approvedRevision: latestTaskState.approvedRevision,
            updatedAt: "2026-07-24T00:00:00.000Z",
            resourceCount: latestTaskState.resources.length,
            verifiedResourceCount: latestTaskState.resources.filter(
              (resource) => resource.status === "verified"
            ).length,
            workspaceReady: latestTaskState.workspace.ready,
            hasErrors: latestTaskState.logs.some((entry) => entry.level === "error")
          },
          state: latestTaskState,
          approvals: [],
          workspaceExports: [],
          downloadArtifacts: [],
          operationEvents: []
        }
      : null
}));

ipcMain.handle("agent:flushTaskPersistence", () => ({ ok: true }));

ipcMain.handle("agent:readWorkspaceFile", () => ({
  ok: true,
  content: JSON.stringify({ schemaVersion: "xunlei-agent-workspace-2.0" }, null, 2)
}));

ipcMain.handle("agent:openWorkspace", () => ({ ok: true }));

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(root, "dist-electron", "electron", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  let exitCode = 0;
  try {
    await window.loadFile(path.join(root, "dist", "index.html"));
    const result = await window.webContents.executeJavaScript(`
      (async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (predicate, message) => {
          for (let attempt = 0; attempt < 250; attempt += 1) {
            if (predicate()) return;
            await wait(20);
          }
          throw new Error(message);
        };

        await waitFor(
          () => document.body.innerText.includes("远程已配置"),
          "Configured connection status did not render."
        );
        const settingsButton = [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "设置");
        if (!settingsButton) throw new Error("Settings navigation button is missing.");
        settingsButton.click();
        await waitFor(
          () => document.body.innerText.includes("远程模型连接"),
          "Settings view did not render."
        );

        const testButton = [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("测试连接"));
        if (!testButton || testButton.disabled) throw new Error("Connection test button is unavailable.");
        testButton.click();
        await waitFor(
          () => document.body.innerText.includes("远程可用"),
          "Successful connection state did not render."
        );
        const settingsVisibleBeforeTask = document.body.innerText.includes("models.example.test");
        const modelVisibleBeforeTask = document.body.innerText.includes("renderer-smoke-model");
        const remoteAvailableBeforeTask = document.body.innerText.includes("远程可用");

        const homeButton = [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "首页");
        if (!homeButton) throw new Error("Home navigation button is missing.");
        homeButton.click();
        await waitFor(
          () => document.body.innerText.includes("准备一个可交接的开发工作区"),
          "Home view did not render."
        );

        const taskInput = document.querySelector('textarea[name="task"]');
        const startButton = [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("开始任务"));
        if (!taskInput || !startButton) throw new Error("Task submission controls are missing.");
        taskInput.value = "准备 Python 机器学习环境";
        startButton.click();

        await waitFor(
          () => document.body.innerText.includes("Python AI 环境是否需要同时准备前端工具链"),
          "Python task clarification did not render."
        );
        const pythonOnlyButton = [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "仅 Python AI");
        if (!pythonOnlyButton) throw new Error("Python-only clarification action is missing.");
        pythonOnlyButton.click();

        await waitFor(
          () => [...document.querySelectorAll("button")]
            .some((button) => button.textContent?.includes("查看资源计划")),
          "Validated resource plan was not generated."
        );
        const viewPlanButton = [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("查看资源计划"));
        viewPlanButton.click();

        await waitFor(
          () => document.body.innerText.includes("已通过严格验证"),
          "Strict plan validation result did not render."
        );
        const approveButton = [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("确认下载计划"));
        if (!approveButton || approveButton.disabled) {
          throw new Error("A valid current revision must expose an enabled approval button.");
        }
        approveButton.click();
        await waitFor(
          () => document.body.innerText.includes("执行监控"),
          "Approval did not navigate to the execution state."
        );
        const strictPlanApproved = document.body.innerText.includes("执行监控");

        const historyButton = [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "历史");
        if (!historyButton) throw new Error("History navigation button is missing.");
        historyButton.click();
        await waitFor(
          () => document.body.innerText.includes("SQLite 只读记录") &&
            document.body.innerText.includes("准备 Python 机器学习环境") &&
            document.body.innerText.includes("模型与工具审计"),
          "Persisted task history did not render."
        );

        return {
          title: document.title,
          settingsVisible: settingsVisibleBeforeTask,
          modelVisible: modelVisibleBeforeTask,
          remoteAvailable: remoteAvailableBeforeTask,
          strictPlanApproved,
          historyVisible: document.body.innerText.includes("SQLite 只读记录"),
          bodyText: document.body.innerText
        };
      })()
    `);

    if (result.title !== "迅雷 AI Task Agent") throw new Error("Production renderer title is incorrect.");
    if (Number(process.versions.electron.split(".")[0]) !== expectedElectronMajor) {
      throw new Error(
        `Electron major mismatch: expected ${expectedElectronMajor}, received ${process.versions.electron}.`
      );
    }
    if (!result.settingsVisible || !result.modelVisible || !result.remoteAvailable || !result.strictPlanApproved || !result.historyVisible) {
      throw new Error("Renderer smoke assertions failed.");
    }
    if (result.bodyText.includes(testApiKey)) throw new Error("Renderer exposed the API key.");
    console.log(
      `Electron ${process.versions.electron} renderer passed: settings, strict plan approval, history and safe metadata verified`
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window.destroy();
    app.exit(exitCode);
  }
});
