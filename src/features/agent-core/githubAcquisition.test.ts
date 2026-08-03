import { describe, expect, it } from "vitest";
import { DefaultAgentPolicy, InMemoryAgentToolExecutor } from "./agentServices";
import type { AgentScheduler } from "./interfaces";
import { LocalRuleModelRuntime } from "./localRuleModel";
import { createInitialAgentState, transition } from "./machine";
import { FixedWindowsPlanner, MockVerifier } from "./mockServices";
import { ExtensibleAgentRouter } from "./router";
import { AgentRuntime } from "./runtime";
import {
  completeTaskPlanStep,
  confirmTaskPlan,
  createTaskPlan,
  defaultTaskPlanToolPolicies,
  prepareTaskPlanForConfirmation,
  startTaskPlanStep,
  validateTaskPlan
} from "./taskPlan";
import type { PlannedResource } from "./types";

const commitSha = "a".repeat(40);
const digestBase64 = `${"A".repeat(86)}==`;

function sourceResource(): PlannedResource {
  return {
    id: "github-openai-example-aaaaaaaaaaaa",
    name: "openai/example",
    version: "aaaaaaaaaaaa",
    publisher: "openai",
    source: "GitHub Repository API",
    homepage: "https://github.com/openai/example",
    releasePage: "https://github.com/openai/example/releases",
    sizeMb: 1,
    license: "MIT",
    purpose: "固定 commit 的开源项目源码快照。",
    recommendation: "不执行代码。",
    required: true,
    dependsOn: [],
    provides: ["project-source"],
    requiresCapabilities: [],
    supportedOperatingSystems: ["Windows 11"],
    supportedArchitectures: ["x64"],
    sourceTrust: "github-api",
    catalogStatus: "active",
    verification: {
      checksumAlgorithm: "sha256",
      checksumSource: "computed-on-download",
      checksumSourceUrl: `https://github.com/openai/example/commit/${commitSha}`,
      signatureType: "none",
      signatureEnforcement: "not-applicable"
    },
    download: {
      url: `https://codeload.github.com/openai/example/zip/${commitSha}`,
      expectedSha256: null,
      digestPolicy: "record-after-download",
      maxSizeMb: 10,
      allowedHosts: ["codeload.github.com"]
    },
    github: {
      fullName: "openai/example",
      owner: "openai",
      repository: "example",
      defaultBranch: "main",
      commitSha,
      treeSha: "b".repeat(40),
      archiveFormat: "zip",
      inspectedAt: "2026-07-30T00:00:00.000Z",
      analysis: {
        ecosystems: ["node"],
        manifests: ["package.json"],
        lockfiles: ["package-lock.json"],
        runtimeHints: ["Node.js"],
        nodeOfflinePreparation: "package-lock-supported",
        nodeOfflinePackageCount: 1,
        nodeOfflineBlockers: [],
        treeTruncated: false
      }
    },
    selected: true,
    status: "pending",
    progress: 0,
    attempts: 0
  };
}

function npmResource(): PlannedResource {
  const resolvedUrl =
    "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz";
  return {
    id: "npm-left-pad-1234567890abcdef",
    name: "left-pad（npm 离线包）",
    version: "1.3.0",
    publisher: "npm registry / package-lock",
    source: "package-lock.json @ aaaaaaaaaaaa",
    homepage: "https://www.npmjs.com/package/left-pad",
    releasePage: "https://www.npmjs.com/package/left-pad/v/1.3.0",
    sizeMb: 1,
    license: "WTFPL",
    purpose: "Node 开发依赖的离线 tarball。",
    recommendation: "不执行 npm install。",
    required: false,
    dependsOn: [],
    provides: ["offline-node-package"],
    requiresCapabilities: ["project-source"],
    supportedOperatingSystems: ["Windows 11"],
    supportedArchitectures: ["x64"],
    sourceTrust: "npm-lockfile",
    catalogStatus: "active",
    verification: {
      checksumAlgorithm: "sha512",
      checksumSource: "npm-lockfile-integrity",
      checksumSourceUrl:
        `https://github.com/openai/example/blob/${commitSha}/package-lock.json`,
      signatureType: "none",
      signatureEnforcement: "checksum-only"
    },
    download: {
      url: resolvedUrl,
      expectedSha256: null,
      digestPolicy: "lockfile-integrity",
      expectedIntegrity: {
        algorithm: "sha512",
        digestBase64
      },
      maxSizeMb: 100,
      allowedHosts: ["registry.npmjs.org"]
    },
    npm: {
      packageName: "left-pad",
      version: "1.3.0",
      resolvedUrl,
      integrity: `sha512-${digestBase64}`,
      license: "WTFPL",
      dependencyKind: "development",
      lockfilePath: "package-lock.json",
      repositoryFullName: "openai/example",
      repositoryCommitSha: commitSha
    },
    selected: false,
    status: "pending",
    progress: 0,
    attempts: 0
  };
}

describe("GitHub source and npm dependency revisions", () => {
  it("opens a new TaskPlan revision when local preparation is added after search completion", () => {
    const validationContext = {
      tools: defaultTaskPlanToolPolicies,
      requireInitialConfirmation: true
    };
    const createdAt = "2026-08-01T00:00:00.000Z";
    const draft = createTaskPlan({
      planId: "github-search-plan",
      taskId: "github-search-task",
      createdBy: "local-rule",
      createdAt,
      proposal: {
        objective: "查找 openai/example",
        deliverables: ["仓库结果"],
        assumptions: [],
        constraints: ["只读查询"],
        steps: [{
          id: "present-results",
          title: "展示结果",
          description: "展示 GitHub 查询结果。",
          kind: "handoff",
          tool: null,
          dependsOn: [],
          staticInput: {},
          inputBindings: {},
          expectedOutput: "仓库结果",
          risk: "read_only",
          approval: { required: false, reason: null }
        }],
        confirmation: { required: true, reason: "确认查询流程。" }
      }
    });
    let taskPlan = confirmTaskPlan(
      prepareTaskPlanForConfirmation(draft, validationContext, createdAt),
      { revision: 1, confirmedAt: createdAt }
    );
    taskPlan = completeTaskPlanStep(
      startTaskPlanStep(taskPlan, "present-results", createdAt),
      {
        stepId: "present-results",
        completedAt: createdAt,
        result: { reference: "github:results", summary: "查询结果已展示。" }
      }
    );
    const initial = createInitialAgentState();
    const resultState = {
      ...initial,
      taskId: "github-search-task",
      task: "查找 openai/example",
      phase: "result" as const,
      route: "github-project-discovery",
      routeDecision: {
        status: "supported" as const,
        reason: "matched",
        skillId: "github-project-discovery",
        sourceProviderId: "github-api",
        userLinks: [],
        resourceIds: [],
        clarifications: [],
        requirements: null
      },
      taskPlan,
      taskPlanValidation: validateTaskPlan(taskPlan, validationContext)
    };
    const extended = transition(resultState, {
      type: "GITHUB_ACQUISITION_PREPARED",
      resources: [sourceResource()],
      explanation: "固定提交并创建资源计划。"
    });

    expect(extended).toMatchObject({
      phase: "waiting_task_plan_confirmation",
      revision: 1,
      taskPlan: {
        revision: 2,
        previousRevision: 1,
        status: "waiting_confirmation"
      }
    });
  });

  it("writes repository selection and pinned commit back into the running TaskPlan", async () => {
    const jobs: Array<() => void | Promise<void>> = [];
    const scheduler: AgentScheduler = {
      schedule(task) {
        jobs.push(task);
        return () => undefined;
      }
    };
    const tools = new InMemoryAgentToolExecutor(
      undefined,
      undefined,
      undefined,
      undefined,
      async () => ({
        ok: true,
        output: {
          criteria: {
            mode: "exact" as const,
            fullName: "openai/example",
            match: "exact" as const,
            licenseRequired: true
          },
          repositories: [{
            id: 1,
            fullName: "openai/example",
            url: "https://github.com/openai/example",
            description: "Example",
            stars: 100,
            forks: 10,
            openIssues: 1,
            language: "TypeScript",
            topics: ["agent"],
            license: { spdxId: "MIT", name: "MIT License" },
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-29T00:00:00.000Z",
            pushedAt: "2026-07-29T00:00:00.000Z"
          }],
          totalCount: 1,
          incompleteResults: false,
          fetchedAt: "2026-08-01T00:00:00.000Z",
          authenticated: false,
          rateLimit: { remaining: 9, resetAt: null }
        }
      })
    );
    const runtime = new AgentRuntime({
      router: new ExtensibleAgentRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler,
      model: new LocalRuleModelRuntime(),
      tools,
      policy: new DefaultAgentPolicy(),
      downloadTool: "controlled_download",
      stepDelayMs: 0,
      createTaskId: () => "github-acquisition-task"
    });
    runtime.start();
    runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "找到 GitHub openai/example 并下载到本地"
    });
    for (let index = 0; index < 20; index += 1) {
      if (runtime.getState().phase === "waiting_task_plan_confirmation") {
        runtime.dispatch({ type: "CONFIRM_TASK_PLAN", revision: 1 });
      }
      if (runtime.getState().phase === "result") break;
      const job = jobs.shift();
      if (!job) throw new Error(`Runtime stalled at ${runtime.getState().phase}.`);
      await job();
    }
    expect(runtime.getState()).toMatchObject({
      phase: "result",
      taskPlan: {
        status: "waiting_user_input",
        steps: expect.arrayContaining([
          expect.objectContaining({ id: "select-repository", status: "waiting_user_input" })
        ])
      }
    });

    runtime.reportExternalEvent({
      type: "GITHUB_ACQUISITION_PREPARED",
      resources: [sourceResource()],
      explanation: "固定提交并创建资源计划。"
    });
    await jobs.shift()?.();

    expect(runtime.getState()).toMatchObject({
      phase: "waiting_approval",
      taskPlan: {
        status: "waiting_approval",
        steps: expect.arrayContaining([
          expect.objectContaining({ id: "select-repository", status: "completed" }),
          expect.objectContaining({ id: "pin-repository", status: "completed" }),
          expect.objectContaining({ id: "download-repository", status: "waiting_approval" })
        ])
      }
    });
  });

  it("keeps npm packages out of the first approval and enables them only after Agent B", () => {
    const initial = createInitialAgentState();
    const resultState = {
      ...initial,
      taskId: "task-github",
      task: "准备 GitHub 项目",
      phase: "result" as const,
      route: "github-project-discovery",
      routeDecision: {
        status: "supported" as const,
        reason: "matched",
        skillId: "github-project-discovery",
        sourceProviderId: "github-api",
        userLinks: [],
        resourceIds: [],
        clarifications: [],
        requirements: null
      }
    };
    const firstPlan = transition(resultState, {
      type: "GITHUB_ACQUISITION_PREPARED",
      resources: [sourceResource(), npmResource()],
      explanation: "固定提交并识别锁文件。"
    });

    expect(firstPlan).toMatchObject({
      phase: "waiting_approval",
      revision: 1,
      approvedRevision: null
    });
    expect(firstPlan.resources.find((resource) => resource.npm)?.selected).toBe(
      false
    );
    const prematureToggle = transition(firstPlan, {
      type: "TOGGLE_NODE_DEPENDENCIES",
      selected: true
    });
    expect(
      prematureToggle.resources.find((resource) => resource.npm)?.selected
    ).toBe(false);

    const handoff = {
      ...firstPlan,
      phase: "handoff" as const,
      resources: firstPlan.resources.map((resource) =>
        resource.github
          ? { ...resource, status: "verified" as const, progress: 100 }
          : resource
      ),
      workspace: {
        ...firstPlan.workspace,
        ready: true,
        exportStatus: "ready" as const,
        manifestRevision: 1
      },
      agentB: {
        status: "completed" as const,
        runId: "agent-b-1",
        grantId: "grant-1",
        manifestRevision: 1,
        error: null,
        answer: {
          manifestRevision: 1,
          planRevision: 1,
          workspaceStatus: "ready" as const,
          preparedRequiredResources: ["openai/example"],
          missingOrFailedResources: [],
          allowedActions: ["核对"],
          forbiddenActions: ["执行脚本"],
          integrity: "valid" as const,
          projectReadiness: {
            fullName: "openai/example",
            commitSha,
            ecosystems: ["node" as const],
            manifests: ["package.json"],
            lockfiles: ["package-lock.json"],
            runtimeHints: ["Node.js"],
            dependencyPreparation: "package-lock-supported" as const,
            offlinePackageCount: 1,
            offlineBlockers: [],
            selectedOfflinePackages: 0,
            treeTruncated: false
          },
          summary: "源码准备完成。"
        }
      }
    };

    const dependencyPlan = transition(handoff, {
      type: "PREPARE_NODE_DEPENDENCIES"
    });
    expect(dependencyPlan).toMatchObject({
      phase: "waiting_approval",
      revision: 2,
      approvedRevision: null,
      workspace: { ready: false }
    });
    expect(
      dependencyPlan.resources.find((resource) => resource.npm)?.selected
    ).toBe(true);
    expect(
      dependencyPlan.resources.find((resource) => resource.github)?.status
    ).toBe("verified");

    const approved = transition(dependencyPlan, {
      type: "APPROVE_PLAN",
      revision: 2
    });
    expect(approved.phase).toBe("downloading");
    expect(approved.activeResourceId).toBe("npm-left-pad-1234567890abcdef");
    expect(
      approved.resources.find((resource) => resource.github)?.status
    ).toBe("verified");
  });
});
