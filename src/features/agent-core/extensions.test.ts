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
import { githubSearchInputFromState } from "./githubSearch";
import { FixedWindowsPlanner, MockVerifier } from "./mockServices";
import { ExtensibleAgentRouter } from "./router";
import { AgentRuntime } from "./runtime";
import { confirmTaskPlanForTest } from "./taskPlanTestSupport";
import {
  TrustedCatalogSourceProvider,
  createDefaultSourceProviderRegistry
} from "./sourceProviders";
import {
  createDefaultWorkspaceTemplateRegistry
} from "./workspaceTemplates";
import type { AgentScheduler } from "./interfaces";

function submitted(task: string) {
  return transition(createInitialAgentState(), {
    type: "SUBMIT_TASK",
    task,
    taskId: "routing-test"
  });
}

describe("extensible routing and registries", () => {
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
