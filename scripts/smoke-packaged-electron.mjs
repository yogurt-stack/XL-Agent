import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
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
const workspaceRoot = path.join(testRoot, "workspaces");
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
      XL_AGENT_E2E_DOWNLOAD_FIXTURE: "1",
      XL_AGENT_LLM_PROVIDER: "openai-compatible",
      XL_AGENT_LLM_ENDPOINT: "",
      XL_AGENT_LLM_BASE_URL: "",
      XL_AGENT_LLM_API_KEY: "",
      XL_AGENT_LLM_MODEL: "",
      XL_AGENT_TASK_STORE_PATH: path.join(
        testRoot,
        "agent-tasks.sqlite"
      ),
      XL_AGENT_WORKSPACE_ROOT: workspaceRoot
    },
    locale: "zh-CN",
    timeout: 45_000
  });
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
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

  await page
    .getByRole("textbox", { name: "任务描述" })
    .fill("准备 Python 机器学习环境");
  await page.getByRole("button", { name: "开始任务" }).click();
  await page
    .getByRole("heading", { name: "先确认 Agent 对任务的理解" })
    .waitFor({ timeout: 45_000 });
  await page.getByText("Task Plan r1", { exact: true }).waitFor();
  await page.getByRole("button", { name: "确认流程并继续" }).click();
  await page
    .getByRole("heading", {
      name: "Python AI 环境是否需要同时准备前端工具链"
    })
    .waitFor({ timeout: 45_000 });
  await page.getByRole("button", { name: "仅 Python AI" }).click();
  await page.getByRole("button", { name: "查看资源计划" }).click();
  await page
    .getByText("计划 r1 已通过严格验证")
    .waitFor({ timeout: 45_000 });
  await page.getByRole("button", { name: "确认下载计划 r1" }).click();

  await page
    .getByRole("heading", {
      name: "AI Dev Starter 需要人工决策"
    })
    .waitFor({ timeout: 45_000 });
  const failurePanel = page.getByRole("alert");
  if (!(await failurePanel.innerText()).includes("CHECKSUM_MISMATCH")) {
    throw new Error("Packaged flow did not expose the controlled failure.");
  }
  await failurePanel
    .getByRole("button", { name: "重试原来源" })
    .click();
  await page
    .getByRole("heading", { name: "先确认 Agent 对任务的理解" })
    .waitFor({ timeout: 45_000 });
  await page.getByText("Task Plan r2", { exact: true }).waitFor();
  await page.getByRole("button", { name: "确认流程并继续" }).click();
  await page
    .getByText("替代计划 r2 已生成")
    .waitFor({ timeout: 45_000 });
  await page.getByRole("button", { name: "查看并确认" }).click();
  await page
    .getByText("计划 r2 已通过严格验证")
    .waitFor({ timeout: 45_000 });
  await page.getByRole("button", { name: "确认下载计划 r2" }).click();

  await page
    .getByText("工作区交接", { exact: true })
    .waitFor({ timeout: 60_000 });
  await page
    .getByRole("button", { name: "工作区", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "交接包已就绪" })
    .waitFor({ timeout: 45_000 });
  const rootPath = await page
    .locator(".workspace-view .agent-page-heading > div:last-child > p")
    .innerText();
  const manifestPath = path.join(rootPath, "resource-manifest.json");
  if (
    !rootPath.startsWith(workspaceRoot) ||
    !existsSync(manifestPath)
  ) {
    throw new Error("Packaged flow did not write the managed workspace.");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== "xunlei-agent-workspace-2.0" ||
    manifest.revision !== 2 ||
    manifest.approvedRevision !== 2 ||
    manifest.handoff?.ready !== true
  ) {
    throw new Error(
      `Packaged workspace manifest is invalid: ${JSON.stringify(manifest)}`
    );
  }

  await page.getByTestId("run-agent-b").click();
  const agentBAnswer = page.getByTestId("agent-b-answer");
  await agentBAnswer.waitFor({ timeout: 45_000 });
  const agentBText = await agentBAnswer.innerText();
  if (
    !agentBText.includes("校验通过") ||
    !agentBText.includes("禁止动作")
  ) {
    throw new Error("Packaged Agent B did not verify the final Manifest.");
  }
  console.log(
    `Packaged Electron flow passed: ${appInfo.name} ${appInfo.version} on ${appInfo.platform}, revision ${manifest.revision}, Agent B verified`
  );
} finally {
  await application?.close();
  rmSync(testRoot, { force: true, recursive: true });
}
