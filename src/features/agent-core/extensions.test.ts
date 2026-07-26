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
import { FixedWindowsPlanner, MockVerifier } from "./mockServices";
import { ExtensibleAgentRouter } from "./router";
import { AgentRuntime } from "./runtime";
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
    expect(next.phase).toBe("planning");
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
    const planning = transition(
      submitted("准备国考申论学习资料"),
      routedEvent!
    );
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
