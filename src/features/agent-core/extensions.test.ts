import { describe, expect, it } from "vitest";
import {
  DefaultAgentPolicy,
  InMemoryAgentToolExecutor
} from "./agentServices";
import {
  DomainSkillRegistry,
  createDefaultDomainSkillRegistry,
  type DomainSkill
} from "./domainSkills";
import { trustedCatalog } from "./catalog";
import { createInitialAgentState, transition } from "./machine";
import { LocalRuleModelRuntime } from "./localRuleModel";
import {
  githubSearchInputFromState,
  latestGitHubRepositorySearchResult
} from "./githubSearch";
import { FixedWindowsPlanner, MockVerifier } from "./mockServices";
import { ExtensibleAgentRouter } from "./router";
import { AgentRuntime } from "./runtime";
import {
  confirmTaskPlanForTest,
  proposeTaskPlanForTest
} from "./taskPlanTestSupport";
import {
  TrustedCatalogSourceProvider,
  createDefaultSourceProviderRegistry
} from "./sourceProviders";
import {
  createDefaultWorkspaceTemplateRegistry
} from "./workspaceTemplates";
import type { AgentScheduler } from "./interfaces";
import type { AgentState } from "./types";

function submitted(task: string) {
  return transition(createInitialAgentState(), {
    type: "SUBMIT_TASK",
    task,
    taskId: "routing-test"
  });
}

describe("extensible routing and registries", () => {
  it("routes version inventory to the local read-only inspection skill before resource preparation", () => {
    const router = new ExtensibleAgentRouter();
    const routed = router.route(
      submitted("帮我查询本地的代码环境，包括 npm、nodejs、py、cuda，把版本号全部列出来")
    );

    expect(routed?.decision).toMatchObject({
      status: "supported",
      skillId: "local-development-environment-inspection",
      sourceProviderId: "electron-main",
      clarifications: []
    });
  });

  it("keeps explicit environment preparation on the resource acquisition skill", () => {
    const router = new ExtensibleAgentRouter();
    const routed = router.route(
      submitted("帮我下载安装 Node.js 并配置开发环境")
    );

    expect(routed?.decision).toMatchObject({
      status: "supported",
      skillId: "ai-development-environment"
    });
  });

  it("routes an installed AI development skill as supported", () => {
    const router = new ExtensibleAgentRouter();
    const event = router.route(submitted("准备 Python 机器学习开发环境"));

    expect(event?.decision).toMatchObject({
      status: "supported",
      skillId: "ai-development-environment",
      sourceProviderId: "trusted-catalog"
    });
    expect(event?.decision.clarifications[0]?.id).toBe("python-scope");
  });

  it("routes the installed research skill and derives its own capability set", () => {
    const router = new ExtensibleAgentRouter();
    const routed = router.route(submitted("准备一个科研数据分析工作区"));
    expect(routed?.decision).toMatchObject({
      status: "supported",
      skillId: "research-data-environment",
      sourceProviderId: "trusted-catalog"
    });
    expect(routed?.decision.clarifications[0]?.id).toBe(
      "research-template"
    );

    const planning = transition(
      confirmTaskPlanForTest(transition(
        submitted("准备一个科研数据分析工作区"),
        routed!
      )),
      {
        type: "ANSWER_CLARIFICATION",
        questionId: "research-template",
        answer: "只准备科研基础工具"
      }
    );
    expect(router.resolveRequirements(planning)).toEqual({
      intent: "skill:research-data-environment",
      label: "科研数据环境",
      requiredCapabilities: [
        "python-runtime",
        "code-editor",
        "source-control"
      ]
    });
  });

  it("routes GitHub project discovery before the generic git development skill", () => {
    const router = new ExtensibleAgentRouter();
    const routed = router.route(
      submitted("帮我查找 GitHub 最新最热门的 10 个开源项目")
    );

    expect(routed?.decision).toMatchObject({
      status: "supported",
      skillId: "github-project-discovery",
      sourceProviderId: "github-api"
    });
    expect(routed?.decision.clarifications.map((question) => question.id))
      .toEqual(["github-created-window", "github-sort"]);
  });

  it("keeps an imported fixed repository attached and routes project compatibility analysis", () => {
    const imported = transition(createInitialAgentState(), {
      type: "LOCAL_REPOSITORY_IMPORTED",
      taskId: "local-repository-task",
      repository: {
        repositoryHandleId: "local-repo-fixture",
        displayName: "fixture",
        fingerprint: "f".repeat(64),
        commitSha: "a".repeat(40),
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
        inspectedAt: "2026-08-07T00:00:00.000Z",
        analysis: {
          ecosystems: ["node"],
          manifests: ["package.json"],
          lockfiles: [],
          runtimeHints: ["Node.js"],
          nodeOfflinePreparation: "lockfile-unsupported",
          nodeOfflinePackageCount: 0,
          nodeOfflineBlockers: [],
          treeTruncated: false
        }
      }
    });
    const submittedWithRepository = transition(imported, {
      type: "SUBMIT_TASK",
      task: "分析当前项目的运行要求，并告诉我本机还缺什么",
      taskId: "project-compatibility-task"
    });
    expect(submittedWithRepository.localRepository?.repositoryHandleId)
      .toBe("local-repo-fixture");
    const routed = new ExtensibleAgentRouter().route(submittedWithRepository);
    expect(routed?.decision).toMatchObject({
      status: "supported",
      skillId: "local-project-environment-compatibility",
      sourceProviderId: "local-git"
    });
    const planning = transition(submittedWithRepository, routed!);
    const proposed = proposeTaskPlanForTest(planning);
    expect(proposed.taskPlan?.steps[0]).toMatchObject({
      kind: "analysis",
      execution: {
        mode: "agent_loop",
        allowedTools: [
          "list_local_repository_tree",
          "inspect_project_requirements",
          "read_local_repository_file",
          "inspect_local_development_environment"
        ]
      }
    });
  });

  it("starts a separate read-only analysis plan from a fixed GitHub search result", () => {
    const initial = createInitialAgentState();
    const searchResultState: AgentState = {
      ...initial,
      taskId: "github-search-task",
      phase: "result",
      route: "github-project-discovery",
      routeDecision: {
        status: "supported",
        reason: "matched",
        skillId: "github-project-discovery",
        sourceProviderId: "github-api",
        userLinks: [],
        resourceIds: [],
        clarifications: [],
        requirements: null
      }
    };
    const attached = transition(searchResultState, {
      type: "GITHUB_REPOSITORY_ANALYSIS_ATTACHED",
      taskId: "github-analysis-task",
      repository: {
        repositoryHandleId: "github-repo-fixture",
        fullName: "owner/example",
        displayName: "owner/example",
        defaultBranch: "main",
        commitSha: "a".repeat(40),
        treeSha: "b".repeat(40),
        trackedFileCount: 2,
        treeTruncated: false,
        inspectedAt: "2026-08-07T00:00:00.000Z",
        analysis: {
          ecosystems: ["node"],
          manifests: ["package.json"],
          lockfiles: [],
          runtimeHints: ["Node.js"],
          nodeOfflinePreparation: "lockfile-unsupported",
          nodeOfflinePackageCount: 0,
          nodeOfflineBlockers: [],
          treeTruncated: false
        }
      }
    });
    expect(attached).toMatchObject({
      phase: "routing",
      localRepository: null,
      githubRepository: {
        fullName: "owner/example",
        commitSha: "a".repeat(40)
      }
    });
    const routedEvent = new ExtensibleAgentRouter().route(attached);
    expect(routedEvent?.decision).toMatchObject({
      status: "supported",
      skillId: "github-project-environment-compatibility",
      sourceProviderId: "github-api"
    });
    const routed = transition(attached, routedEvent!);
    const proposed = proposeTaskPlanForTest(routed);
    expect(proposed.taskPlan?.steps[0]).toMatchObject({
      id: "analyze-github-project-environment",
      kind: "analysis",
      execution: {
        mode: "agent_loop",
        allowedTools: [
          "list_github_repository_tree",
          "inspect_github_project_requirements",
          "read_github_repository_file",
          "inspect_local_development_environment"
        ]
      }
    });
    expect(proposed.resources).toEqual([]);
  });

  it("executes local environment inspection exactly once and reaches a read-only result", async () => {
    const jobs: Array<() => void | Promise<void>> = [];
    let inspectionCalls = 0;
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
      undefined,
      () => {
        inspectionCalls += 1;
        return {
          host: { platform: "darwin" as const, architecture: "arm64" as const },
          tools: [{
            id: "node" as const,
            name: "Node.js",
            command: "node",
            status: "available" as const,
            version: "v22.20.0",
            detail: null
          }],
          collectedAt: "2026-08-07T00:00:00.000Z",
          source: "electron-main-fixed-command-allowlist" as const,
          boundary: "read-only-fixed-command-allowlist" as const
        };
      }
    );
    const runtime = new AgentRuntime({
      router: new ExtensibleAgentRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler,
      model: new LocalRuleModelRuntime(),
      tools,
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0,
      createTaskId: () => "local-environment-inspection-test"
    });

    runtime.start();
    runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "查询本地代码环境，列出 npm、nodejs、py 和 cuda 版本"
    });
    await jobs.shift()?.();
    await jobs.shift()?.();

    expect(runtime.getState()).toMatchObject({
      phase: "waiting_task_plan_confirmation",
      routeDecision: {
        skillId: "local-development-environment-inspection"
      },
      taskPlan: {
        steps: [
          expect.objectContaining({
            id: "inspect-local-development-environment",
            tool: "inspect_local_development_environment",
            risk: "read_only"
          }),
          expect.objectContaining({
            id: "present-local-development-environment",
            kind: "handoff"
          })
        ]
      }
    });
    expect(runtime.getState().taskPlan?.steps).toHaveLength(2);
    expect(runtime.getState().taskPlan?.steps.some((step) =>
      step.tool === "controlled_download" ||
      step.tool === "search_trusted_catalog" ||
      step.tool === "export_workspace"
    )).toBe(false);

    runtime.dispatch({ type: "CONFIRM_TASK_PLAN", revision: 1 });
    for (
      let step = 0;
      step < 8 && runtime.getState().phase !== "result";
      step += 1
    ) {
      const job = jobs.shift();
      if (!job) throw new Error(`Runtime stalled at ${runtime.getState().phase}.`);
      await job();
    }

    expect(runtime.getState()).toMatchObject({
      phase: "result",
      resources: [],
      taskPlan: { status: "completed" },
      agentRun: { status: "complete" }
    });
    expect(inspectionCalls).toBe(1);
    expect(runtime.getState().agentRun.toolResults).toEqual([
      expect.objectContaining({
        tool: "inspect_local_development_environment",
        status: "success"
      })
    ]);
  });

  it("routes a named GitHub repository search without trending clarifications", async () => {
    const router = new ExtensibleAgentRouter();
    const initial = submitted("帮我找一个 GitHub 上名叫 tau 的项目");
    const routed = router.route(initial);

    expect(routed?.decision).toMatchObject({
      status: "supported",
      skillId: "github-project-discovery",
      clarifications: []
    });
    const taskPlanning = transition(initial, routed!);
    expect(taskPlanning.phase).toBe("task_planning");
    const proposalDecision = await new LocalRuleModelRuntime().decide({
      state: taskPlanning,
      step: 0,
      maxSteps: 6,
      availableTools: ["search_github_repositories"],
      toolResults: []
    });
    expect(proposalDecision.action).toMatchObject({
      type: "propose_task_plan",
      proposal: { objective: expect.stringContaining("tau") }
    });
    const planning = confirmTaskPlanForTest(taskPlanning);
    expect(githubSearchInputFromState(planning)).toEqual({
      mode: "name",
      query: "tau",
      limit: 10
    });

    const decision = await new LocalRuleModelRuntime().decide({
      state: planning,
      step: 1,
      maxSteps: 6,
      availableTools: ["search_github_repositories"],
      toolResults: []
    });
    expect(decision.action).toMatchObject({
      type: "call_tool",
      purpose: expect.stringContaining("tau"),
      call: {
        name: "search_github_repositories",
        input: { mode: "name", query: "tau", limit: 10 }
      }
    });

    const conversational = submitted(
      "帮我在 GitHub 上找一个 tau 的开源项目"
    );
    const conversationalRoute = router.route(conversational);
    expect(conversationalRoute?.decision.clarifications).toEqual([]);
    expect(
      githubSearchInputFromState(
        transition(conversational, conversationalRoute!)
      )
    ).toEqual({ mode: "name", query: "tau", limit: 10 });
  });

  it("routes a GitHub repository URL as an exact lookup without clarifications", () => {
    const router = new ExtensibleAgentRouter();
    const initial = submitted("请处理 https://github.com/openai/tau");
    const routed = router.route(initial);

    expect(routed?.decision).toMatchObject({
      status: "supported",
      skillId: "github-project-discovery",
      userLinks: ["https://github.com/openai/tau"],
      clarifications: []
    });
    expect(githubSearchInputFromState(transition(initial, routed!))).toEqual({
      mode: "exact",
      fullName: "openai/tau",
      limit: 1
    });
  });

  it("falls back when a remote GitHub plan invents an unrenderable decision", async () => {
    const jobs: Array<() => void | Promise<void>> = [];
    const scheduler: AgentScheduler = {
      schedule(job) {
        jobs.push(job);
        return () => undefined;
      }
    };
    const runtime = new AgentRuntime({
      router: new ExtensibleAgentRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler,
      model: {
        async decide(context) {
          return {
            decisionId: "remote-invalid-github-plan",
            provider: "remote-llm" as const,
            model: "remote-test",
            explanation: "错误地增加热门榜参数。",
            action: {
              actionId: "remote-invalid-github-plan-action",
              type: "propose_task_plan" as const,
              explanation: "先询问不相关参数。",
              proposal: {
                objective: context.state.task,
                deliverables: ["tau 仓库列表"],
                assumptions: [],
                constraints: ["只读查询"],
                steps: [{
                  id: "clarify-search-params",
                  title: "确认搜索参数",
                  description: "询问时间窗口和排序指标。",
                  kind: "user_decision" as const,
                  tool: null,
                  dependsOn: [],
                  staticInput: {},
                  inputBindings: {},
                  expectedOutput: "时间窗口与排序指标",
                  risk: "read_only" as const,
                  approval: { required: false, reason: null }
                }, {
                  id: "search-tau-repos",
                  title: "搜索 tau",
                  description: "使用 GitHub API 搜索。",
                  kind: "read_tool" as const,
                  tool: "search_github_repositories",
                  dependsOn: ["clarify-search-params"],
                  staticInput: { query: "tau", searchMode: "name" },
                  inputBindings: {},
                  expectedOutput: "候选仓库",
                  risk: "read_only" as const,
                  approval: { required: false, reason: null }
                }, {
                  id: "present-results",
                  title: "展示结果",
                  description: "向用户展示候选仓库。",
                  kind: "handoff" as const,
                  tool: null,
                  dependsOn: ["search-tau-repos"],
                  staticInput: {},
                  inputBindings: {},
                  expectedOutput: "仓库列表",
                  risk: "read_only" as const,
                  approval: { required: false, reason: null }
                }],
                confirmation: { required: true, reason: "确认查询流程。" }
              }
            }
          };
        }
      },
      tools: new InMemoryAgentToolExecutor(),
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0,
      createTaskId: () => "github-invalid-plan-fallback"
    });

    runtime.start();
    runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "帮我在 GitHub 上找一个名叫 tau 的项目"
    });
    await jobs.shift()?.();
    await jobs.shift()?.();

    expect(runtime.getState()).toMatchObject({
      phase: "waiting_task_plan_confirmation",
      taskPlan: {
        createdBy: "local-rule",
        steps: [{
          id: "search-github",
          tool: "search_github_repositories",
          staticInput: { mode: "name", query: "tau", limit: 10 }
        }, {
          id: "present-github-results",
          kind: "handoff"
        }]
      }
    });
  });

  it("recovers a GitHub result from the durable TaskPlan step output", () => {
    const router = new ExtensibleAgentRouter();
    const initial = submitted("帮我找一个 GitHub 上名叫 tau 的项目");
    const taskPlanning = transition(initial, router.route(initial)!);
    const proposed = confirmTaskPlanForTest(taskPlanning);
    const taskPlan = structuredClone(proposed.taskPlan!);
    const searchStep = taskPlan.steps.find(
      (step) => step.tool === "search_github_repositories"
    )!;
    searchStep.status = "completed";
    searchStep.startedAt = "2026-08-03T06:30:13.000Z";
    searchStep.completedAt = "2026-08-03T06:30:14.000Z";
    searchStep.result = {
      reference: "task-plan-step:search-github",
      summary: "GitHub 查询完成。",
      output: {
        criteria: {
          mode: "name",
          query: "tau",
          match: "repository-name",
          order: "best-match",
          licenseRequired: true
        },
        repositories: [],
        totalCount: 0,
        incompleteResults: false,
        fetchedAt: "2026-08-03T06:30:14.000Z",
        authenticated: false,
        rateLimit: { remaining: 9, resetAt: null }
      }
    };
    const restored = {
      ...proposed,
      taskPlan,
      agentRun: { ...proposed.agentRun, toolResults: [] }
    };

    expect(latestGitHubRepositorySearchResult(restored)).toMatchObject({
      tool: "search_github_repositories",
      status: "success",
      output: { criteria: { mode: "name", query: "tau" } }
    });
  });

  it("routes exact trusted catalog links through needs_links without recommending extras", () => {
    const resource = trustedCatalog.find((item) => item.id === "python-312");
    expect(resource).toBeDefined();
    const router = new ExtensibleAgentRouter();
    const event = router.route(
      submitted(`请保存这个资源，不需要推荐其他内容：${resource!.download.url}`)
    );

    expect(event?.decision).toMatchObject({
      status: "needs_links",
      skillId: null,
      sourceProviderId: "trusted-catalog",
      resourceIds: ["python-312"],
      clarifications: []
    });

    const next = event
      ? transition(submitted("placeholder"), event)
      : createInitialAgentState();
    expect(next.phase).toBe("task_planning");
  });

  it("fails closed for unsupported goals and unrecognized links", () => {
    const router = new ExtensibleAgentRouter();
    expect(router.route(submitted("帮我分析今天的心情"))?.decision.status)
      .toBe("unsupported");
    expect(
      router.route(
        submitted("下载这个文件 https://untrusted.example.invalid/tool.exe")
      )?.decision
    ).toMatchObject({
      status: "unsupported",
      resourceIds: []
    });
  });

  it("supports adding a Domain Skill without modifying Router or Core", () => {
    const shellSkill: DomainSkill = {
      id: "exam-study-materials",
      displayName: "考试学习资料",
      matches: (goal) => goal.text.includes("国考"),
      clarify: () => [],
      buildRequirements: () => [
        { capability: "source-control", required: true }
      ],
      generateGuide: () => ({
        title: "国考资料",
        summary: "扩展验证",
        nextActions: []
      })
    };
    const registry = createDefaultDomainSkillRegistry().register(shellSkill);
    const router = new ExtensibleAgentRouter(
      registry,
      createDefaultSourceProviderRegistry()
    );

    const routedEvent = router.route(submitted("准备国考申论学习资料"));
    expect(routedEvent?.decision).toMatchObject({
        status: "supported",
        skillId: "exam-study-materials"
      });
    const planning = confirmTaskPlanForTest(transition(
      submitted("准备国考申论学习资料"),
      routedEvent!
    ));
    expect(router.resolveRequirements(planning)).toEqual({
      intent: "skill:exam-study-materials",
      label: "考试学习资料",
      requiredCapabilities: ["source-control"]
    });
    expect(() => registry.register(shellSkill)).toThrow(/已注册/);
  });

  it("drives an added Domain Skill through requirements and local planning", async () => {
    const skill: DomainSkill = {
      id: "source-control-materials",
      displayName: "源码资料",
      matches: (goal) => goal.text.includes("源码资料"),
      clarify: () => [],
      buildRequirements: () => [
        { capability: "source-control", required: true }
      ],
      generateGuide: () => ({
        title: "源码资料工作区",
        summary: "源码资料已经准备。",
        nextActions: ["核对 Git 资源。"]
      })
    };
    const jobs: Array<() => void | Promise<void>> = [];
    const scheduler: AgentScheduler = {
      schedule(task) {
        jobs.push(task);
        return () => undefined;
      }
    };
    const runtime = new AgentRuntime({
      router: new ExtensibleAgentRouter(
        new DomainSkillRegistry([skill]),
        createDefaultSourceProviderRegistry()
      ),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler,
      model: new LocalRuleModelRuntime(),
      tools: new InMemoryAgentToolExecutor(),
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0,
      createTaskId: () => "extension-runtime-test"
    });
    runtime.start();
    runtime.dispatch({ type: "SUBMIT_TASK", task: "准备源码资料" });

    for (
      let step = 0;
      step < 20 && runtime.getState().phase !== "waiting_approval";
      step += 1
    ) {
      if (runtime.getState().phase === "waiting_task_plan_confirmation") {
        runtime.dispatch({ type: "CONFIRM_TASK_PLAN", revision: 1 });
        continue;
      }
      const job = jobs.shift();
      if (!job) throw new Error(`Runtime stalled at ${runtime.getState().phase}.`);
      await job();
    }

    expect(runtime.getState()).toMatchObject({
      phase: "waiting_approval",
      taskRequirements: {
        intent: "skill:source-control-materials",
        label: "源码资料",
        requiredCapabilities: ["source-control"]
      }
    });
    expect(runtime.getState().resources.map((resource) => resource.id))
      .toContain("git");
  });

  it("drives GitHub discovery to a terminal result without creating a download plan", async () => {
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
      async (input) => {
        if (input.mode !== "discovery") {
          throw new Error("Expected discovery search input.");
        }
        return {
          ok: true,
          output: {
            criteria: {
              mode: "discovery",
              keywords: input.keywords,
              createdWithinDays: input.createdWithinDays,
              createdAfter: "2026-06-30",
              sort: input.sort,
              order: "desc",
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
            fetchedAt: "2026-07-30T00:00:00.000Z",
            authenticated: false,
            rateLimit: { remaining: 9, resetAt: null }
          }
        };
      }
    );
    const runtime = new AgentRuntime({
      router: new ExtensibleAgentRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler,
      model: new LocalRuleModelRuntime(),
      tools,
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0,
      createTaskId: () => "github-runtime-test"
    });
    runtime.start();
    runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "帮我查找 GitHub 最新最热门的 10 个开源项目"
    });
    await jobs.shift()?.();
    await jobs.shift()?.();
    expect(runtime.getState().phase).toBe("waiting_task_plan_confirmation");
    runtime.dispatch({ type: "CONFIRM_TASK_PLAN", revision: 1 });
    expect(runtime.getState()).toMatchObject({
      phase: "clarifying",
      taskPlan: {
        steps: [
          expect.objectContaining({
            id: "clarify-github-1",
            status: "waiting_user_input",
            staticInput: expect.objectContaining({
              questionId: "github-created-window"
            })
          }),
          expect.objectContaining({ id: "clarify-github-2", status: "pending" }),
          expect.objectContaining({
            id: "search-github",
            status: "pending",
            dependsOn: ["clarify-github-2"]
          }),
          expect.objectContaining({ id: "present-github-results", status: "pending" })
        ]
      }
    });
    expect(jobs).toHaveLength(0);
    runtime.dispatch({
      type: "ANSWER_CLARIFICATION",
      questionId: "github-created-window",
      answer: "最近 30 天新建"
    });
    runtime.dispatch({
      type: "ANSWER_CLARIFICATION",
      questionId: "github-sort",
      answer: "按 Star 数"
    });

    for (
      let step = 0;
      step < 10 && runtime.getState().phase !== "result";
      step += 1
    ) {
      const job = jobs.shift();
      if (!job) throw new Error(`Runtime stalled at ${runtime.getState().phase}.`);
      await job();
    }

    expect(runtime.getState()).toMatchObject({
      phase: "result",
      resources: [],
      agentRun: { status: "complete" }
    });
    expect(runtime.getState().agentRun.toolResults).toEqual([
      expect.objectContaining({
        tool: "search_github_repositories",
        status: "success"
      })
    ]);
  });

  it("executes the conversational tau lookup exactly once through the TaskPlan executor", async () => {
    const jobs: Array<() => void | Promise<void>> = [];
    const calls: unknown[] = [];
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
      async (input) => {
        calls.push(input);
        if (input.mode !== "name") {
          throw new Error("Expected repository-name search input.");
        }
        return {
          ok: true,
          output: {
            criteria: {
              mode: "name" as const,
              query: input.query,
              match: "repository-name" as const,
              order: "best-match" as const,
              licenseRequired: true as const
            },
            repositories: [],
            totalCount: 0,
            incompleteResults: false,
            fetchedAt: "2026-08-03T06:50:00.000Z",
            authenticated: false,
            rateLimit: { remaining: 9, resetAt: null }
          }
        };
      }
    );
    const runtime = new AgentRuntime({
      router: new ExtensibleAgentRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler,
      model: new LocalRuleModelRuntime(),
      tools,
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0,
      createTaskId: () => "github-conversational-tau"
    });

    runtime.start();
    runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "帮我在 GitHub 上找一个 tau 的开源项目"
    });
    await jobs.shift()?.();
    await jobs.shift()?.();
    expect(runtime.getState().phase).toBe("waiting_task_plan_confirmation");
    runtime.dispatch({ type: "CONFIRM_TASK_PLAN", revision: 1 });

    for (
      let step = 0;
      step < 10 && runtime.getState().phase !== "result";
      step += 1
    ) {
      const job = jobs.shift();
      if (!job) throw new Error(`Runtime stalled at ${runtime.getState().phase}.`);
      await job();
    }

    expect(runtime.getState()).toMatchObject({
      phase: "result",
      taskPlan: { status: "completed" },
      agentRun: { status: "complete" }
    });
    expect(calls).toEqual([{ mode: "name", query: "tau", limit: 10 }]);
    expect(runtime.getState().agentRun.toolResults).toHaveLength(1);
  });

  it("resolves trusted source metadata and a matching workspace template", () => {
    const provider = new TrustedCatalogSourceProvider();
    const [resource] = provider.search({ resourceIds: ["git"] });
    expect(provider.inspect(resource)).toMatchObject({
      id: "git",
      verification: { checksumAlgorithm: "sha256" }
    });

    const template = createDefaultWorkspaceTemplateRegistry()
      .resolve("ai-development-environment");
    expect(template?.id).toBe("ai-development-workspace");
    expect(
      template?.renderReadme({
        skillId: "ai-development-environment",
        manifestJson: "{}",
        title: "AI 工作区",
        summary: "摘要",
        nextActions: ["核对 Manifest"]
      })
    ).toContain("核对 Manifest");
    expect(
      createDefaultWorkspaceTemplateRegistry()
        .resolve("research-data-environment")?.id
    ).toBe("research-data-workspace");
  });

  it("keeps deprecated and revoked catalog entries out of searches", () => {
    const active = trustedCatalog[0];
    const provider = new TrustedCatalogSourceProvider([
      active,
      {
        ...structuredClone(active),
        id: "deprecated-fixture",
        catalogStatus: "deprecated",
        statusReason: "superseded"
      },
      {
        ...structuredClone(active),
        id: "revoked-fixture",
        catalogStatus: "revoked",
        statusReason: "compromised"
      }
    ]);

    expect(
      provider.search({
        resourceIds: [
          active.id,
          "deprecated-fixture",
          "revoked-fixture"
        ]
      }).map((resource) => resource.id)
    ).toEqual([active.id]);
  });

  it("rejects invalid and duplicate registry entries", () => {
    const registry = new DomainSkillRegistry();
    const invalid = {
      id: "Invalid ID",
      displayName: "invalid",
      matches: () => false,
      clarify: () => [],
      buildRequirements: () => [],
      generateGuide: () => ({ title: "", summary: "", nextActions: [] })
    } satisfies DomainSkill;
    expect(() => registry.register(invalid)).toThrow(/ID 非法/);
  });
});
