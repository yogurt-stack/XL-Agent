import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import axe, { type AxeResults } from "axe-core";
import { _electron as electron, type ElectronApplication } from "playwright";

const projectRoot = path.resolve(__dirname, "..");
const visualRegressionEnabled = process.platform === "linux";

let electronApp: ElectronApplication;
let page: Page;

function deterministicEnvironment() {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  return {
    ...inherited,
    VITE_DEV_SERVER_URL: "",
    XL_AGENT_LLM_ENDPOINT: "",
    XL_AGENT_LLM_MODEL: "",
    XL_AGENT_LLM_API_KEY: ""
  };
}

test.beforeEach(async () => {
  electronApp = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: deterministicEnvironment(),
    locale: "zh-CN",
    timeout: 30_000
  });
  page = await electronApp.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await electronApp.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  await page.waitForLoadState("domcontentloaded");
  await expect(page).toHaveTitle("迅雷 AI Task Agent");
  await expect(page.getByRole("heading", { name: "准备一个可交接的开发工作区" })).toBeVisible();
});

test.afterEach(async ({}, testInfo: TestInfo) => {
  const failed = testInfo.status !== testInfo.expectedStatus;
  try {
    if (failed && page && !page.isClosed()) {
      await testInfo.attach("electron-failure", {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png"
      });
    }
    if (electronApp) {
      if (failed) {
        const tracePath = testInfo.outputPath("trace.zip");
        await electronApp.context().tracing.stop({ path: tracePath });
        await testInfo.attach("trace", { path: tracePath, contentType: "application/zip" });
      } else {
        await electronApp.context().tracing.stop();
      }
    }
  } finally {
    await electronApp?.close();
  }
});

async function startTaskAndWaitForFailure() {
  await page.getByRole("textbox", { name: "任务描述" }).fill("准备 Python 机器学习环境");
  await page.getByRole("button", { name: "开始任务" }).click();

  await expect(
    page.getByRole("heading", { name: "Python AI 环境是否需要同时准备前端工具链" })
  ).toBeVisible();
  await page.getByRole("button", { name: "仅 Python AI" }).click();

  await page.getByRole("button", { name: "查看资源计划" }).click();
  await expect(page.getByText("计划 r1 已通过严格验证")).toBeVisible();
  await page.getByRole("button", { name: "确认下载计划 r1" }).click();

  await expect(page.getByRole("heading", { name: "AI Dev Starter 需要人工决策" })).toBeVisible();
  const failurePanel = page.getByRole("alert");
  await expect(failurePanel).toContainText("CHECKSUM_MISMATCH");
  await expect(failurePanel.getByRole("button", { name: "重试原来源" })).toBeEnabled();
  await expect(failurePanel.getByRole("button", { name: "使用可信替代来源" })).toBeEnabled();
  await expect(failurePanel.getByRole("button", { name: "交给 Agent B" })).toBeEnabled();
}

async function expectNoSeriousAccessibilityViolations(view: string) {
  const axeLoaded = await page.evaluate(() => "axe" in globalThis);
  if (!axeLoaded) await page.addScriptTag({ content: axe.source });
  const scan = await page.evaluate(async () => {
    const axeApi = (globalThis as typeof globalThis & {
      axe: { run(): Promise<unknown> };
    }).axe;
    return axeApi.run();
  }) as AxeResults;
  const violations = scan.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target)
    }));
  expect(violations, `${view} has serious accessibility violations`).toEqual([]);
}

async function expectVisualBaseline(name: string) {
  if (!visualRegressionEnabled) return;
  await expect(page).toHaveScreenshot(`${name}.png`, {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.01,
    scale: "css"
  });
}

async function approveReplacementPlan() {
  await expect(page.getByText("替代计划 r2 已生成")).toBeVisible();
  await page.getByRole("button", { name: "查看并确认" }).click();
  await expect(page.getByText("计划 r2 已通过严格验证")).toBeVisible();
  await page.getByRole("button", { name: "确认下载计划 r2" }).click();
}

async function openCompletedWorkspace() {
  await expect(page.getByText("工作区交接", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "工作区" }).click();
  await expect(page.getByRole("heading", { name: "交接包已就绪" })).toBeVisible();
  await expect(page.getByText("已验证，可交接")).toBeVisible();
  return JSON.parse(await page.locator("pre.workspace-code-preview").innerText()) as {
    revision: number;
    approvedRevision: number;
    resources: Array<{ id: string; replacedFrom: string | null; status: string }>;
    handoff: { ready: boolean; missingItems: string[]; nextAction: string };
  };
}

test("retries the original source and reaches a ready workspace", async () => {
  await expectNoSeriousAccessibilityViolations("home");
  await expectVisualBaseline("home");
  await startTaskAndWaitForFailure();
  await expectNoSeriousAccessibilityViolations("failure resolution");

  const catalogResults = page.locator("details.agent-tool-result-group").filter({ hasText: "search_trusted_catalog" });
  const downloadResults = page.locator("details.agent-tool-result-group").filter({ hasText: "simulate_download" });
  await expect(catalogResults).toHaveCount(1);
  await expect(downloadResults).toHaveCount(1);
  expect(await catalogResults.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  expect(await downloadResults.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
  await catalogResults.locator("summary").click();
  await expect.poll(() => catalogResults.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
  await expect(catalogResults.locator(".agent-trace-row")).toHaveCount(1);
  await expect(downloadResults).toContainText("需关注");
  await expectVisualBaseline("failure-with-tool-details");

  await page.getByRole("button", { name: "重试原来源" }).click();
  await approveReplacementPlan();

  const manifest = await openCompletedWorkspace();
  await expectNoSeriousAccessibilityViolations("ready workspace");
  await expectVisualBaseline("ready-workspace");
  expect(manifest).toMatchObject({
    revision: 2,
    approvedRevision: 2,
    handoff: { ready: true, missingItems: [] }
  });
  expect(manifest.resources).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "sample-project", status: "verified" })])
  );
  expect(manifest.resources.some((resource) => resource.id === "sample-project-mirror")).toBe(false);
});

test("switches to the trusted fallback and records its provenance", async () => {
  await startTaskAndWaitForFailure();
  await page.getByRole("button", { name: "使用可信替代来源" }).click();

  await expect(page.getByText("替代计划 r2 已生成")).toBeVisible();
  await page.getByRole("button", { name: "查看并确认" }).click();
  await expectNoSeriousAccessibilityViolations("replacement plan");
  await expect(page.getByRole("heading", { name: "AI Dev Starter Mirror", exact: true })).toBeVisible();
  await expect(page.getByText("替代 sample-project")).toBeVisible();
  await expectVisualBaseline("trusted-replacement-plan");
  await page.getByRole("button", { name: "确认下载计划 r2" }).click();

  const manifest = await openCompletedWorkspace();
  expect(manifest.handoff).toMatchObject({ ready: true, missingItems: [] });
  expect(manifest.resources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "sample-project-mirror",
        replacedFrom: "sample-project",
        status: "verified"
      })
    ])
  );
});

test("delegates the failed resource to Agent B as an incomplete handoff", async () => {
  await startTaskAndWaitForFailure();
  await page.getByRole("button", { name: "交给 Agent B" }).click();

  await expect(page.getByRole("heading", { name: "等待资源准备完成" })).toBeVisible();
  await expect(page.getByText("已交给 Agent B 处理未完成资源")).toBeVisible();
  await expect(page.getByText("仍有资源未验证")).toBeVisible();
  await expectNoSeriousAccessibilityViolations("Agent B handoff");
  await expectVisualBaseline("agent-b-incomplete-handoff");

  const manifest = JSON.parse(await page.locator("pre.workspace-code-preview").innerText()) as {
    resources: Array<{ id: string; status: string; failureReason: string | null }>;
    handoff: { ready: boolean; missingItems: string[]; nextAction: string };
  };
  expect(manifest.handoff.ready).toBe(false);
  expect(manifest.handoff.missingItems.length).toBeGreaterThan(0);
  expect(manifest.handoff.nextAction).toContain("Agent B");
  expect(manifest.resources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "sample-project",
        status: "failed",
        failureReason: expect.stringContaining("SHA256")
      })
    ])
  );
});
