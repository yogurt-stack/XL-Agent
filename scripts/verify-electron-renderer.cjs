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

  try {
    await window.loadFile(path.join(root, "dist", "index.html"));
    const result = await window.webContents.executeJavaScript(`
      (async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (predicate, message) => {
          for (let attempt = 0; attempt < 50; attempt += 1) {
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

        return {
          title: document.title,
          settingsVisible: document.body.innerText.includes("models.example.test"),
          modelVisible: document.body.innerText.includes("renderer-smoke-model"),
          remoteAvailable: document.body.innerText.includes("远程可用"),
          bodyText: document.body.innerText
        };
      })()
    `);

    if (result.title !== "迅雷 AI Task Agent") throw new Error("Production renderer title is incorrect.");
    if (!result.settingsVisible || !result.modelVisible || !result.remoteAvailable) {
      throw new Error("Model connection settings smoke assertions failed.");
    }
    if (result.bodyText.includes(testApiKey)) throw new Error("Renderer exposed the API key.");
    console.log("Electron renderer passed: settings, safe metadata and connection test UI verified");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
