import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import axe, { type AxeResults } from "axe-core";
import { _electron as electron, type ElectronApplication } from "playwright";

const projectRoot = path.resolve(__dirname, "..");
const visualRegressionEnabled = process.platform === "linux";

let electronApp: ElectronApplication;
let page: Page;
let testDataRoot: string;
let testEnvironment: Record<string, string>;

function deterministicEnvironment(approvalTtlMs: number) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  return {
    ...inherited,
    VITE_DEV_SERVER_URL: "",
    NODE_ENV: "test",
    XL_AGENT_E2E_DOWNLOAD_FIXTURE: "1",
    XL_AGENT_LLM_PROVIDER: "openai-compatible",
    XL_AGENT_LLM_ENDPOINT: "",
    XL_AGENT_LLM_BASE_URL: "",
    XL_AGENT_LLM_MODEL: "",
    XL_AGENT_LLM_API_KEY: "",
    XL_AGENT_APPROVAL_TTL_MS: String(approvalTtlMs),
    XL_AGENT_TASK_STORE_PATH: path.join(testDataRoot, "agent-tasks.sqlite"),
    XL_AGENT_WORKSPACE_ROOT: path.join(testDataRoot, "workspaces")
  };
}

async function launchApplication() {
  electronApp = await electron.launch({
    args: [
      "--disable-gpu",
      `--user-data-dir=${path.join(testDataRoot, "electron-user-data")}`,
      projectRoot
    ],
    cwd: projectRoot,
    env: testEnvironment,
    locale: "zh-CN",
    timeout: 30_000
  });
  page = await electronApp.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await electronApp.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  await page.waitForLoadState("domcontentloaded");
  await expect(page).toHaveTitle("迅雷 AI Task Agent");
  await expect(page.getByRole("heading", { name: "准备一个可交接的开发工作区" })).toBeVisible();
}

test.beforeEach(async ({}, testInfo) => {
  testDataRoot = mkdtempSync(path.join(tmpdir(), "xunlei-agent-e2e-"));
  const approvalTtlMs = testInfo.title.includes("rejects expired approval") ? 10 : 30 * 60 * 1000;
  testEnvironment = deterministicEnvironment(approvalTtlMs);
  await launchApplication();
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
    rmSync(testDataRoot, { force: true, recursive: true });
  }
});

async function approveInitialTask() {
  await page.getByRole("textbox", { name: "任务描述" }).fill("准备 Python 机器学习环境");
  await page.getByRole("button", { name: "开始任务" }).click();

  await expect(
    page.getByRole("heading", { name: "先确认 Agent 对任务的理解" })
  ).toBeVisible();
  await expect(page.getByText("确认的是处理流程，不是执行权限。"))
    .toBeVisible();
  await page.getByRole("button", { name: "确认流程并继续" }).click();

  await expect(
    page.getByRole("heading", { name: "Python AI 环境是否需要同时准备前端工具链" })
  ).toBeVisible();
  await page.getByRole("button", { name: "仅 Python AI" }).click();

  await page.getByRole("button", { name: "查看资源计划" }).click();
  await expect(page.getByText("计划 r1 已通过严格验证")).toBeVisible();
  await page.getByRole("button", { name: "确认下载计划 r1" }).click();
}

async function startTaskAndWaitForFailure() {
  await approveInitialTask();
  await expect(page.getByRole("heading", { name: "AI Dev Starter 需要人工决策" })).toBeVisible();
  const failurePanel = page.getByRole("alert");
  await expect(failurePanel).toContainText("CHECKSUM_MISMATCH");
  await expect(failurePanel.getByRole("button", { name: "重试原来源" })).toBeEnabled();
  await expect(failurePanel.getByRole("button", { name: "使用可信替代来源" })).toBeEnabled();
  await expect(failurePanel.getByRole("button", { name: "交给 Agent B" })).toBeEnabled();
  await expectMainPanelAtTop("failure resolution");
}

async function expectMainPanelAtTop(view: string) {
  await expect.poll(
    () => page.locator("main.main-panel").evaluate((element) => element.scrollTop),
    { message: `${view} should start at the top after navigation` }
  ).toBe(0);
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
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(page.locator("main.main-panel")).toHaveScreenshot(`${name}.png`, {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.01,
    scale: "css"
  });
}

async function approveReplacementPlan() {
  await confirmReplacementTaskPlan();
  await expect(page.getByText("替代计划 r2 已生成")).toBeVisible();
  await page.getByRole("button", { name: "查看并确认" }).click();
  await expect(page.getByText("计划 r2 已通过严格验证")).toBeVisible();
  await expectMainPanelAtTop("replacement plan");
  await page.getByRole("button", { name: "确认下载计划 r2" }).click();
}

async function confirmReplacementTaskPlan() {
  await expect(
    page.getByRole("heading", { name: "先确认 Agent 对任务的理解" })
  ).toBeVisible();
  await expect(page.getByText("Task Plan r2", { exact: true })).toBeVisible();
  await expect(page.getByText("确认的是处理流程，不是执行权限。"))
    .toBeVisible();
  await expectMainPanelAtTop("replacement TaskPlan confirmation");
  await page.getByRole("button", { name: "确认流程并继续" }).click();
}

async function openCompletedWorkspace() {
  await expect(page.getByRole("heading", { name: "交接包已就绪" })).toBeVisible();
  await expect(page.getByRole("button", { name: "工作区" }))
    .toHaveAttribute("aria-current", "page");
  await expect(page.getByText("已验证并真实落盘")).toBeVisible();
  await expectMainPanelAtTop("ready workspace");
  await expect(page.locator("pre.workspace-code-preview")).toContainText(
    "xunlei-agent-workspace-2.0"
  );
  const rootPath = await page
    .locator(".workspace-view .agent-page-heading > div:last-child > p")
    .innerText();
  const expectedFiles = [
    "README.md",
    "RESOURCE_MANIFEST.md",
    "AGENTS.md",
    "resource-manifest.json",
    "scripts/bootstrap.ps1",
    "scripts/verify-environment.ps1"
  ];
  expect(rootPath.startsWith(testDataRoot)).toBe(true);
  for (const relativePath of expectedFiles) {
    expect(existsSync(path.join(rootPath, relativePath)), `${relativePath} should exist`).toBe(true);
  }
  const manifest = JSON.parse(
    readFileSync(path.join(rootPath, "resource-manifest.json"), "utf8")
  ) as {
    schemaVersion: string;
    revision: number;
    approvedRevision: number;
    resources: Array<{
      id: string;
      replacedFrom: string | null;
      status: string;
      selected: boolean;
      artifact: null | {
        relativePath: string;
        sha256: string;
        verificationStatus: string;
      };
    }>;
    handoff: {
      ready: boolean;
      files: string[];
      missingItems: string[];
      nextAction: string;
    };
  };
  expect(manifest.schemaVersion).toBe("xunlei-agent-workspace-2.0");
  for (const resource of manifest.resources.filter((item) => item.selected)) {
    expect(resource.artifact, `${resource.id} should have a copied artifact`).not.toBeNull();
    const artifactPath = path.join(rootPath, resource.artifact!.relativePath);
    expect(existsSync(artifactPath), resource.artifact!.relativePath).toBe(true);
    expect(
      createHash("sha256").update(readFileSync(artifactPath)).digest("hex")
    ).toBe(resource.artifact!.sha256);
    expect(manifest.handoff.files).toContain(resource.artifact!.relativePath);
  }
  expect(JSON.stringify(manifest)).not.toContain("tempFilePath");
  expect(JSON.parse(await page.locator("pre.workspace-code-preview").innerText())).toEqual(manifest);
  return manifest;
}

function createLocalGitRepository() {
  const rootPath = path.join(testDataRoot, "local-repository");
  mkdirSync(rootPath, { recursive: true });
  execFileSync("git", ["init"], { cwd: rootPath });
  execFileSync("git", ["config", "user.name", "Agent E2E"], {
    cwd: rootPath
  });
  execFileSync("git", ["config", "user.email", "agent@example.test"], {
    cwd: rootPath
  });
  writeFileSync(
    path.join(rootPath, "package.json"),
    `${JSON.stringify({ name: "local-repository", version: "1.0.0" })}\n`,
    "utf8"
  );
  writeFileSync(
    path.join(rootPath, "package-lock.json"),
    `${JSON.stringify({
      name: "local-repository",
      lockfileVersion: 3,
      packages: {
        "": { name: "local-repository", version: "1.0.0" }
      }
    })}\n`,
    "utf8"
  );
  execFileSync("git", ["add", "package.json", "package-lock.json"], {
    cwd: rootPath
  });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: rootPath });
  return rootPath;
}

test("imports a local Git repository into Manifest and Agent B without write permission", async () => {
  const repositoryRoot = createLocalGitRepository();
  await electronApp.evaluate(
    ({ dialog }, selectedPath) => {
      (
        dialog as unknown as {
          showOpenDialog: () => Promise<{
            canceled: boolean;
            filePaths: string[];
          }>;
        }
      ).showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selectedPath]
      });
    },
    repositoryRoot
  );

  await page.getByTestId("import-local-repository").click();

  const repositorySummary = page.getByTestId("local-repository-summary");
  await expect(
    repositorySummary.getByRole("heading", { name: "本地仓库只读摘要" })
  ).toBeVisible();
  await expect(repositorySummary).toContainText("local-repository");
  await expect(repositorySummary).toContainText("clean");
  await expect(
    page.getByRole("heading", { name: "审批后发布到 GitHub" })
  ).toBeVisible();
  const runAgentB = page.getByTestId("run-agent-b");
  await expect(runAgentB).toBeEnabled();
  await runAgentB.click();
  await expect(page.getByTestId("agent-b-answer")).toContainText(
    "本地 Git 仓库（只读）"
  );

  const workspaceRoot = await page
    .locator(".workspace-view .agent-page-heading > div:last-child > p")
    .innerText();
  const manifest = JSON.parse(
    readFileSync(path.join(workspaceRoot, "resource-manifest.json"), "utf8")
  ) as {
    localRepository: {
      displayName: string;
      commitSha: string;
      analysis: { ecosystems: string[] };
    };
    forbiddenActions: string[];
  };
  expect(workspaceRoot.startsWith(testDataRoot)).toBe(true);
  expect(manifest.localRepository).toMatchObject({
    displayName: "local-repository",
    commitSha: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
    analysis: { ecosystems: ["node"] }
  });
  expect(manifest.forbiddenActions).toContain("未经独立审批发布到 GitHub");
  expect(JSON.stringify(manifest)).not.toContain(repositoryRoot);
  await expectNoSeriousAccessibilityViolations("local repository workspace");
});

test("retries the original source and reaches a ready workspace", async () => {
  await expectNoSeriousAccessibilityViolations("home");
  await expectVisualBaseline("home");
  await startTaskAndWaitForFailure();
  await expectNoSeriousAccessibilityViolations("failure resolution");

  const catalogResults = page.locator("details.agent-tool-result-group").filter({ hasText: "search_trusted_catalog" });
  const downloadResults = page.locator("details.agent-tool-result-group").filter({ hasText: "controlled_download" });
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
  await page.getByTestId("run-agent-b").click();
  await expect(page.getByTestId("agent-b-answer")).toBeVisible();
  await expect(page.getByTestId("agent-b-answer")).toContainText("校验通过");
  await expect(page.getByTestId("agent-b-answer")).toContainText("禁止动作");
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

  await confirmReplacementTaskPlan();
  await expect(page.getByText("替代计划 r2 已生成")).toBeVisible();
  await page.getByRole("button", { name: "查看并确认" }).click();
  await expectNoSeriousAccessibilityViolations("replacement plan");
  await expectMainPanelAtTop("trusted replacement plan");
  await expect(page.getByRole("heading", { name: "AI Dev Starter Alternate Route", exact: true })).toBeVisible();
  await expect(page.getByText("替代 sample-project")).toBeVisible();
  const replacementDetails = page.locator(".agent-resource-row").filter({ hasText: "AI Dev Starter Alternate Route" }).locator(".resource-plan-details");
  await expect(replacementDetails).toBeVisible();
  const replacementDetailsBounds = await replacementDetails.boundingBox();
  expect(replacementDetailsBounds?.width).toBeGreaterThan(800);
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
  await expect(page.getByText("仍有资源或导出未完成")).toBeVisible();
  await expect(page.getByTestId("agent-b-answer")).toBeVisible();
  await expect(page.getByTestId("agent-b-answer")).toContainText("校验通过");
  await expect(page.getByTestId("agent-b-answer")).toContainText("AI Dev Starter");
  await expect(page.getByTestId("agent-b-answer")).toContainText("自动运行安装包");
  await expectMainPanelAtTop("Agent B handoff");
  await expectNoSeriousAccessibilityViolations("Agent B handoff");

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

test("restores an unfinished failure decision after an application restart", async () => {
  await startTaskAndWaitForFailure();
  await page.evaluate(async () => {
    const bridge = (
      window as unknown as {
        xunleiAgent?: { flushTaskPersistence(): Promise<{ ok: true }> };
      }
    ).xunleiAgent;
    await bridge?.flushTaskPersistence();
  });
  await electronApp.context().tracing.stop();
  await electronApp.close();

  await launchApplication();
  await page.getByRole("button", { name: "执行" }).click();
  await expect(page.getByRole("heading", { name: "AI Dev Starter 需要人工决策" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("CHECKSUM_MISMATCH");
  await expect(page.getByText("已从 SQLite 恢复未完成任务。")).toBeVisible();

  await page.getByRole("button", { name: "设置" }).click();
  const restoredRow = page.locator(".settings-row").filter({ hasText: "最近恢复" });
  await expect(restoredRow).not.toContainText("本次未恢复");
});

test("rejects expired approval before a controlled download", async () => {
  await approveInitialTask();
  await expect(page.getByText("当前审批已失效")).toBeVisible();
  await expect(page.getByText("必须重新确认计划 r1 后才能继续受控执行。")).toBeVisible();
  const downloadResult = page
    .locator("details.agent-tool-result-group")
    .filter({ hasText: "controlled_download" });
  await expect(downloadResult).toContainText("当前下载审批已过期");
  await page.getByRole("button", { name: "重新确认" }).click();
  await expect(page.getByText("计划 r1 已通过严格验证")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认下载计划 r1" })).toBeEnabled();
});

test("shows persisted task history without changing the active task", async () => {
  await startTaskAndWaitForFailure();
  await page.evaluate(async () => {
    const bridge = (
      window as unknown as {
        xunleiAgent?: { flushTaskPersistence(): Promise<{ ok: true }> };
      }
    ).xunleiAgent;
    await bridge?.flushTaskPersistence();
  });

  await page.getByRole("button", { name: "历史" }).click();
  await expect(page.getByRole("heading", { name: "历史任务" })).toBeVisible();
  await expect(page.getByRole("button", { name: /准备 Python 机器学习环境/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "准备 Python 机器学习环境" })).toBeVisible();
  await expect(page.getByText("等待失败处置", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "资源快照" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "审批记录" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "模型与工具审计" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "供应链与恢复审计" })).toBeVisible();
  await expect(page.getByText("目录版本已固定", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".history-resource-row").filter({ hasText: "AI Dev Starter" })).toBeVisible();
  await expectNoSeriousAccessibilityViolations("task history");

  await page.getByRole("button", { name: "执行" }).click();
  await expect(page.getByRole("heading", { name: "AI Dev Starter 需要人工决策" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("CHECKSUM_MISMATCH");
});

test("routes the second Domain Skill through its own plan", async () => {
  await page
    .getByRole("textbox", { name: "任务描述" })
    .fill("准备一个科研数据分析工作区");
  await page.getByRole("button", { name: "开始任务" }).click();
  await expect(
    page.getByRole("heading", { name: "先确认 Agent 对任务的理解" })
  ).toBeVisible();
  await page.getByRole("button", { name: "确认流程并继续" }).click();
  await expect(
    page.getByRole("heading", {
      name: "科研数据环境是否需要包含可验证的示例工作区"
    })
  ).toBeVisible();
  await page
    .getByRole("button", { name: "只准备科研基础工具" })
    .click();
  await page.getByRole("button", { name: "查看资源计划" }).click();

  await expect(page.getByText("计划 r1 已通过严格验证")).toBeVisible();
  await expect(
    page.locator(".agent-resource-row").filter({ hasText: "Python 3.12" })
  ).toBeVisible();
  await expect(
    page.locator(".agent-resource-row").filter({ hasText: "Visual Studio Code" })
  ).toBeVisible();
  await expect(
    page.locator(".agent-resource-row").filter({ hasText: "Git for Windows" })
  ).toBeVisible();
  await expect(
    page.locator(".agent-resource-row").filter({ hasText: "AI Dev Starter" })
  ).toHaveCount(0);
  await expectNoSeriousAccessibilityViolations("research skill plan");
});

test("resets Demo records only after explicit confirmation", async () => {
  await startTaskAndWaitForFailure();
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("button", { name: "重置 Demo 数据" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "永久清除 SQLite 中的任务"
  );
  await page.getByRole("button", { name: "确认永久清除" }).click();
  await expect(page.getByText(/Demo 数据已重置，共清除/)).toBeVisible();
  await expect(
    page.locator(".settings-row").filter({ hasText: "最近 Demo 重置" })
  ).not.toContainText("尚未重置");

  await page.getByRole("button", { name: "历史" }).click();
  await expect(page.getByRole("heading", { name: "历史任务" })).toBeVisible();
  await expect(page.getByText("还没有历史任务")).toBeVisible();
  await expectNoSeriousAccessibilityViolations("reset history");
});
