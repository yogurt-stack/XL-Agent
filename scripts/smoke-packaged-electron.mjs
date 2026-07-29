import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";

const artifactRoot = path.resolve(process.argv[2] ?? "");
const executablePath = path.join(
  artifactRoot,
  "迅雷 AI Task Agent.exe"
);
const testRoot = mkdtempSync(
  path.join(tmpdir(), "xunlei-packaged-smoke-")
);
const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry) => entry[1] !== undefined)
);
let application;

try {
  application = await electron.launch({
    executablePath,
    args: ["--disable-gpu"],
    cwd: artifactRoot,
    env: {
      ...environment,
      NODE_ENV: "test",
      VITE_DEV_SERVER_URL: "",
      XL_AGENT_LLM_PROVIDER: "openai-compatible",
      XL_AGENT_LLM_ENDPOINT: "",
      XL_AGENT_LLM_BASE_URL: "",
      XL_AGENT_LLM_API_KEY: "",
      XL_AGENT_LLM_MODEL: "",
      XL_AGENT_TASK_STORE_PATH: path.join(
        testRoot,
        "agent-tasks.sqlite"
      ),
      XL_AGENT_WORKSPACE_ROOT: path.join(testRoot, "workspaces")
    },
    timeout: 45_000
  });
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  if ((await page.title()) !== "迅雷 AI Task Agent") {
    throw new Error("Packaged renderer title did not load.");
  }
  const appInfo = await page.evaluate(async () =>
    window.xunleiAgent?.getAppInfo()
  );
  if (
    appInfo?.name !== "迅雷 AI Task Agent" ||
    appInfo.version !== "0.3.0" ||
    appInfo.platform !== "win32"
  ) {
    throw new Error(
      `Packaged preload/Main bridge returned invalid app info: ${JSON.stringify(appInfo)}`
    );
  }
  console.log(
    `Packaged Electron smoke passed: ${appInfo.name} ${appInfo.version} on ${appInfo.platform}`
  );
} finally {
  await application?.close();
  rmSync(testRoot, { force: true, recursive: true });
}
