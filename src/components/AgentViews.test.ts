import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { catalogById } from "../features/agent-core/catalog";
import { createInitialAgentState, transition } from "../features/agent-core/machine";
import type { ModelConnectionState } from "../features/agent-core/modelConnection";
import type { AgentState } from "../features/agent-core/types";
import { ExtensibleAgentRouter } from "../features/agent-core/router";
import {
  confirmTaskPlanForTest,
  proposeTaskPlanForTest
} from "../features/agent-core/taskPlanTestSupport";
import {
  AgentHomeView,
  ClarificationView,
  ExecutionView,
  SettingsView,
  WorkspaceView
} from "./AgentViews";

const localModelConnection: ModelConnectionState = {
  status: "unconfigured",
  activeProvider: "local-rule",
  configured: false,
  endpointHost: null,
  model: null,
  providerId: null,
  endpointMode: null,
  lastCheckedAt: null
};

describe("clarification view", () => {
  it("renders the validated Task Plan confirmation gate separately from download approval", () => {
    let state = transition(createInitialAgentState(), {
      type: "SUBMIT_TASK",
      task: "帮我找一个 GitHub 上名叫 tau 的项目",
      taskId: "task-plan-view"
    });
    state = transition(state, new ExtensibleAgentRouter().route(state)!);
    state = proposeTaskPlanForTest(state);

    const html = renderToStaticMarkup(createElement(ClarificationView, {
      dispatch: async (event) => transition(state, event),
      onNavigate: () => undefined,
      onRetryLocally: async () => state,
      state
    }));

    expect(html).toContain("先确认 Agent 对任务的理解");
    expect(html).toContain("名叫 tau");
    expect(html).toContain("确认的是处理流程，不是执行权限");
    expect(html).toContain("结构、依赖与权限策略校验通过");
    expect(html).toContain("确认流程并继续");
    expect(html).not.toContain("确认下载计划");
  });

  it("renders Main-registered P2 capabilities and the P3 reset control", () => {
    const state = createInitialAgentState();
    const capabilities = {
      domainSkills: [
        {
          id: "ai-development-environment",
          displayName: "AI 开发环境"
        },
        {
          id: "research-data-environment",
          displayName: "科研数据环境"
        }
      ],
      sourceProviders: [{ id: "trusted-catalog" }],
      workspaceTemplates: [
        { id: "ai-development-workspace" },
        { id: "research-data-workspace" }
      ]
    };
    const homeHtml = renderToStaticMarkup(
      createElement(AgentHomeView, {
        capabilities,
        dispatch: async (event) => transition(state, event),
        onNavigate: () => undefined,
        state
      })
    );
    const settingsHtml = renderToStaticMarkup(
      createElement(SettingsView, {
        capabilities,
        modelConnection: localModelConnection,
        onResetDemoData: async () => ({
          ok: true as const,
          reset: {
            resetAt: "2026-07-29T00:00:00.000Z",
            removedRecords: 0,
            cleanupWarning: null
          }
        }),
        onTestConnection: async () => localModelConnection,
        persistence: {
          status: "ready",
          restoredAt: null,
          lastSavedAt: null,
          lastResetAt: null,
          lastResetRemovedRecords: 0,
          error: null
        },
        state
      })
    );

    expect(homeHtml).toContain("科研数据环境");
    expect(homeHtml).toContain("1 个 Provider · 2 个模板");
    expect(homeHtml).toContain("本地仓库导入 Agent");
    expect(homeHtml).toContain("选择本地 Git 仓库");
    expect(settingsHtml).toContain("平台扩展能力");
    expect(settingsHtml).toContain("重置 Demo 数据");
  });

  it("shows local repository provenance and a separate publish approval", () => {
    const imported = transition(createInitialAgentState(), {
      type: "LOCAL_REPOSITORY_IMPORTED",
      taskId: "local-task",
      repository: {
        repositoryHandleId: "local-repo-test",
        displayName: "example",
        fingerprint: "a".repeat(64),
        commitSha: "b".repeat(40),
        branch: "main",
        detached: false,
        clean: true,
        status: {
          modified: 0,
          deleted: 0,
          untracked: 0,
          conflicted: 0,
          ahead: 0,
          behind: 0
        },
        fileCount: 2,
        trackedFileCount: 2,
        hasSubmodules: false,
        hasSymlinks: false,
        inspectedAt: "2026-07-30T12:00:00.000Z",
        analysis: {
          ecosystems: ["node"],
          manifests: ["package.json"],
          lockfiles: ["package-lock.json"],
          runtimeHints: ["Node.js"],
          nodeOfflinePreparation: "package-lock-supported",
          nodeOfflinePackageCount: 0,
          nodeOfflineBlockers: [],
          treeTruncated: false
        }
      }
    });
    const planned = transition(imported, {
      type: "GITHUB_PUBLISH_PLAN_PREPARED",
      plan: {
        publishId: "github-publish-test",
        repositoryHandleId: "local-repo-test",
        sourceFingerprint: "a".repeat(64),
        sourceCommitSha: "b".repeat(40),
        sourceBranch: "main",
        targetOwner: "owner",
        targetRepository: "example",
        targetVisibility: "private",
        targetBranch: "main",
        commitMessage: "Publish example",
        fileCount: 2,
        totalBytes: 100,
        createRepository: true,
        force: false,
        createdAt: "2026-07-30T12:01:00.000Z",
        expiresAt: "2026-07-30T12:11:00.000Z",
        planSha256: "c".repeat(64)
      }
    });
    const html = renderToStaticMarkup(
      createElement(WorkspaceView, {
        dispatch: async (event) => transition(planned, event),
        onApproveGitHubPublish: async () => ({
          ok: true as const,
          snapshot: { state: planned }
        }),
        onNavigate: () => undefined,
        onOpenWorkspace: async () => ({ ok: true as const }),
        onPrepareGitHubPublish: async () => ({
          ok: true as const,
          snapshot: { state: planned }
        }),
        onReadFile: async () => ({
          ok: true as const,
          content: "{}"
        }),
        onSelectWorkspaceRoot: async () => undefined,
        state: planned
      })
    );

    expect(html).toContain("本地仓库只读摘要");
    expect(html).toContain("审批后发布到 GitHub");
    expect(html).toContain("owner/example");
    expect(html).toContain("不强推");
    expect(html).toContain("批准并创建 GitHub 仓库");
  });

  it("shows recovery actions instead of an infinite loader after the model step limit", () => {
    const submitted = transition(createInitialAgentState(), {
      type: "SUBMIT_TASK",
      task: "准备全栈 AI 应用环境"
    });
    const cancelled = transition(
      {
        ...submitted,
        phase: "planning",
        agentRun: {
          ...submitted.agentRun,
          step: submitted.agentRun.maxSteps
        }
      },
      { type: "MODEL_STEP_LIMIT_REACHED" }
    );

    const html = renderToStaticMarkup(createElement(ClarificationView, {
      dispatch: async (event) => transition(cancelled, event),
      onNavigate: () => undefined,
      onRetryLocally: async () => cancelled,
      state: cancelled
    }));

    expect(html).toContain("资源计划未能在安全步数内生成");
    expect(html).toContain("模型已达到 6 步安全上限");
    expect(html).toContain("使用本地模型重新开始");
    expect(html).toContain("返回首页");
    expect(html).not.toContain("正在生成资源计划");
  });

  it("reports an unrenderable GitHub decision as a plan recovery instead of an API failure", () => {
    let state = transition(createInitialAgentState(), {
      type: "SUBMIT_TASK",
      task: "帮我在 GitHub 上找一个名叫 tau 的项目",
      taskId: "github-stalled-plan"
    });
    state = transition(state, new ExtensibleAgentRouter().route(state)!);
    state = proposeTaskPlanForTest(state);
    const plan = structuredClone(state.taskPlan!);
    plan.status = "waiting_user_input";
    plan.confirmation = {
      ...plan.confirmation,
      status: "confirmed",
      confirmedAt: "2026-08-03T06:30:14.000Z",
      confirmedRevision: plan.revision
    };
    plan.steps = [{
      ...plan.steps[0],
      id: "clarify-search-params",
      title: "确认搜索参数",
      description: "询问时间窗口和排序指标。",
      kind: "user_decision",
      tool: null,
      staticInput: {},
      status: "waiting_user_input",
      startedAt: "2026-08-03T06:30:14.000Z"
    }];
    const stalled = {
      ...state,
      phase: "result",
      taskPlan: plan,
      agentRun: { ...state.agentRun, toolResults: [] }
    } as AgentState;

    const html = renderToStaticMarkup(createElement(ClarificationView, {
      dispatch: async (event) => transition(stalled, event),
      onNavigate: () => undefined,
      onRetryLocally: async () => stalled,
      state: stalled
    }));

    expect(html).toContain("查询尚未开始");
    expect(html).toContain("GitHub API 尚未被调用");
    expect(html).toContain("重新规划并继续");
    expect(html).not.toContain("没有收到可展示的 GitHub API 结果");
  });

  it("renders a named GitHub result with the local preparation action", () => {
    const initial = createInitialAgentState();
    const state = {
      ...initial,
      phase: "result" as const,
      task: "查找 GitHub 上名叫 tau 的项目",
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
      agentRun: {
        ...initial.agentRun,
        status: "complete" as const,
        toolResults: [{
          callId: "github-search",
          tool: "search_github_repositories" as const,
          status: "success" as const,
          output: {
            criteria: {
              mode: "name",
              query: "tau",
              match: "repository-name",
              order: "best-match",
              licenseRequired: true
            },
            repositories: [{
              id: 1,
              fullName: "owner/tau",
              url: "https://github.com/owner/tau",
              description: "Tau repository",
              stars: 1234,
              forks: 120,
              openIssues: 8,
              language: "TypeScript",
              topics: ["agent"],
              license: { spdxId: "MIT", name: "MIT License" },
              createdAt: "2026-07-01T00:00:00.000Z",
              updatedAt: "2026-07-29T00:00:00.000Z",
              pushedAt: "2026-07-29T00:00:00.000Z"
            }],
            totalCount: 1,
            incompleteResults: false,
            fetchedAt: "2026-07-30T00:00:00.000Z",
            authenticated: false,
            rateLimit: { remaining: 9, resetAt: null }
          },
          startedAt: "start",
          finishedAt: "finish"
        }]
      }
    };
    const html = renderToStaticMarkup(createElement(ClarificationView, {
      dispatch: async (event) => transition(state, event),
      onNavigate: () => undefined,
      onRetryLocally: async () => state,
      state
    }));

    expect(html).toContain("GitHub API 查询结果");
    expect(html).toContain("名称匹配“tau”的开源项目");
    expect(html).toContain("按仓库名称");
    expect(html).toContain("owner/tau");
    expect(html).toContain("MIT");
    expect(html).toContain("1,234");
    expect(html).toContain("准备到本地");
    expect(html).not.toContain("查看资源计划");
  });

  it("only shows speed and ETA while a download is active or paused", () => {
    const initial = createInitialAgentState();
    const resource = catalogById.get("python-312")!;
    const completedHtml = renderToStaticMarkup(createElement(ExecutionView, {
      dispatch: async () => initial,
      modelConnection: localModelConnection,
      onNavigate: () => undefined,
      state: {
        ...initial,
        phase: "awaiting_failure_action",
        resources: [
          {
            ...resource,
            selected: true,
            status: "downloaded",
            progress: 100,
            attempts: 1,
            speedBytesPerSecond: 1024,
            etaSeconds: 0
          }
        ]
      }
    }));
    const activeHtml = renderToStaticMarkup(createElement(ExecutionView, {
      dispatch: async () => initial,
      modelConnection: localModelConnection,
      onNavigate: () => undefined,
      state: {
        ...initial,
        phase: "downloading",
        activeResourceId: resource.id,
        resources: [
          {
            ...resource,
            selected: true,
            status: "downloading",
            progress: 50,
            attempts: 1,
            speedBytesPerSecond: 1024 * 1024,
            etaSeconds: 8
          }
        ]
      }
    }));

    expect(completedHtml).not.toContain("剩余约 0s");
    expect(activeHtml).toContain("1.0 MB/s");
    expect(activeHtml).toContain("剩余约 8s");
  });

  it("renders handoff as completed with an explicit workspace action", () => {
    const initial = createInitialAgentState();
    const state: AgentState = {
      ...initial,
      phase: "handoff",
      agentRun: { ...initial.agentRun, status: "complete" },
      workspace: {
        ...initial.workspace,
        ready: true,
        exportStatus: "ready",
        rootPath: "/tmp/task/revision-1"
      }
    };
    const html = renderToStaticMarkup(createElement(ExecutionView, {
      dispatch: async (event) => transition(state, event),
      modelConnection: localModelConnection,
      onNavigate: () => undefined,
      state
    }));

    expect(html).toContain("Agent 已完成工作区交接");
    expect(html).toContain("工作区交接包已就绪");
    expect(html).toContain("查看工作区");
    expect(html).not.toContain("Agent 正在工作区交接");
  });

  it("shows the TaskPlan step cursor and per-step audit status during execution", () => {
    let state = transition(createInitialAgentState(), {
      type: "SUBMIT_TASK",
      task: "准备 Windows AI 环境",
      taskId: "task-plan-execution-view"
    });
    state = transition(state, new ExtensibleAgentRouter().route(state)!);
    state = confirmTaskPlanForTest(state);
    const html = renderToStaticMarkup(createElement(ExecutionView, {
      dispatch: async (event) => transition(state, event),
      modelConnection: localModelConnection,
      onNavigate: () => undefined,
      state: { ...state, phase: "downloading" }
    }));

    expect(html).toContain("task-plan-execution");
    expect(html).toContain("Task Plan r1");
    expect(html).toContain("当前步骤");
    expect(html).toContain("等待输入");
  });
});
