const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const testApiKey = "renderer-smoke-secret";

ipcMain.handle("agent:modelConnectionInfo", () => ({
  ok: true,
  info: {
    configured: true,
    endpointHost: "models.example.test",
    model: "renderer-smoke-model"
  }
}));

ipcMain.handle("agent:readSystemProfile", () => ({
  ok: true,
  profile: {
    platform: "linux",
    platformLabel: "Linux",
    architecture: "x64",
    release: "renderer-smoke",
    cpuCount: 4,
    totalMemoryGb: 8,
    defaultShell: "sh",
    collectedBy: "electron-main",
    collectedAt: "renderer-smoke-static",
    privacy: {
      hostname: false,
      username: false,
      homeDirectory: false,
      environment: false,
      shellPath: false
    }
  }
}));

ipcMain.handle("agent:testModelConnection", () => ({
  ok: true,
  decision: {
    decisionId: "renderer-connection-test",
    model: "renderer-smoke-model",
    explanation: "Connection test succeeded.",
    action: {
      actionId: "renderer-connection-test",
      type: "finish",
      summary: "Connection test succeeded."
    }
  }
}));

ipcMain.handle("agent:modelDecision", () => ({
  ok: false,
  error: {
    code: "MODEL_NETWORK_ERROR",
    message: "Renderer smoke intentionally exercises the local fallback.",
    retriable: true
  }
}));

ipcMain.handle("agent:controlledDownload", (_event, input) => ({
  ok: true,
  output: {
    resourceId: input.resourceId,
    urlHost: "downloads.xunlei.example",
    bytesWritten: 7,
    sha256: {
      "python-312": "7b16d7f7610a4c9ebdb31d2b2ed7b0e0c3c9f681d7b9f2d4545cbf88d07a8c3a",
      vscode: "59e5dd4db0c2dfaa6c03f4a9f98e1c8f0e16e0c2d2c0993c88f0ab622c91f4f2",
      git: "c2d4519d06c2d6d0fb8a44d9d93e6b95c51ef4e9871d5ceaf3c11ac4e0db0c4b",
      "sample-project": "b4a0f36f2cc8f5c7d09ea6d0f9f0de58b79b631aa6a5a8b09f9f0a8e2a4c7d1b"
    }[input.resourceId],
    tempFilePath: `/tmp/${input.resourceId}.download`,
    elapsedMs: 1
  }
}));

ipcMain.handle("agent:saveTaskState", () => ({
  ok: true,
  savedAt: "2026-07-24T00:00:00.000Z"
}));

ipcMain.handle("agent:loadTaskState", () => ({
  ok: true,
  restored: null
}));

ipcMain.handle("agent:flushTaskPersistence", () => ({ ok: true }));

ipcMain.handle("agent:exportWorkspace", (_event, input) => ({
  ok: true,
  output: {
    taskId: input.taskId,
    revision: input.revision,
    rootPath: `/tmp/${input.taskId}/revision-${input.revision}`,
    generatedAt: "2026-07-24T00:00:00.000Z",
    reusedExisting: false,
    files: [
      {
        relativePath: "resource-manifest.json",
        absolutePath: `/tmp/${input.taskId}/revision-${input.revision}/resource-manifest.json`,
        bytesWritten: 80,
        sha256: "a".repeat(64)
      }
    ]
  }
}));

ipcMain.handle("agent:readWorkspaceFile", () => ({
  ok: true,
  content: JSON.stringify({ schemaVersion: "xunlei-agent-workspace-1.0" }, null, 2)
}));

ipcMain.handle("agent:openWorkspace", () => ({ ok: true }));

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(root, "dist-electron", "preload.js"),
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

        return {
          title: document.title,
          settingsVisible: settingsVisibleBeforeTask,
          modelVisible: modelVisibleBeforeTask,
          remoteAvailable: remoteAvailableBeforeTask,
          strictPlanApproved: document.body.innerText.includes("执行监控"),
          bodyText: document.body.innerText
        };
      })()
    `);

    if (result.title !== "迅雷 AI Task Agent") throw new Error("Production renderer title is incorrect.");
    if (!result.settingsVisible || !result.modelVisible || !result.remoteAvailable || !result.strictPlanApproved) {
      throw new Error("Renderer smoke assertions failed.");
    }
    if (result.bodyText.includes(testApiKey)) throw new Error("Renderer exposed the API key.");
    console.log("Electron renderer passed: settings, strict plan approval and safe metadata verified");
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window.destroy();
    app.exit(exitCode);
  }
});
