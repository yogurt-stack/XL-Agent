import { app, BrowserWindow, ipcMain } from "electron";
import { config as loadEnv } from "dotenv";
import path from "node:path";

loadEnv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

app.setName("迅雷 AI Task Agent");

const modelSystemPrompt = `You are the planning model for a controlled Windows development-resource agent.
Return exactly one JSON ModelDecision object. Never return markdown.
Allowed action types: ask_clarification, create_plan, create_replan, call_tool, request_approval, finish.
Allowed tools: read_system_profile, search_trusted_catalog, simulate_download.
Only propose resource IDs already present in the supplied context or tool results.
When state.phase is replanning, return create_replan with strategy trusted-mirror only when the failed resource has a fallbackId; otherwise use primary-retry.
When state.requestedReplanStrategy is present, the create_replan strategy must match it exactly.
Every create_replan action produces a new plan revision that the host will require the user to approve again.
The host policy and state machine will validate every action.`;

function getLlmConfig() {
  const endpoint = process.env.XL_AGENT_LLM_ENDPOINT;
  const apiKey = process.env.XL_AGENT_LLM_API_KEY;
  const model = process.env.XL_AGENT_LLM_MODEL;
  if (!endpoint || !apiKey || !model) {
    throw new Error("远程 LLM 未配置，将由 renderer 回退到本地规则模型。");
  }

  const url = new URL(endpoint);
  if (url.protocol !== "https:") {
    throw new Error("XL_AGENT_LLM_ENDPOINT 必须使用 HTTPS。");
  }
  return { endpoint: url.toString(), apiKey, model };
}

async function requestRemoteModelDecision(context: unknown) {
  const config = getLlmConfig();
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: modelSystemPrompt },
        { role: "user", content: JSON.stringify(context) }
      ]
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`远程 LLM 请求失败：HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("远程 LLM 响应缺少 choices[0].message.content。");
  }
  const decision = JSON.parse(content) as Record<string, unknown>;
  return { ...decision, model: config.model };
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

ipcMain.handle("agent:modelDecision", async (_event, context: unknown) => {
  try {
    return { ok: true as const, decision: await requestRemoteModelDecision(context) };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "未知远程模型错误"
    };
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
