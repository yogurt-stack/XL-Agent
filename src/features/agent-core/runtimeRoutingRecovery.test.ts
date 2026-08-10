import { describe, expect, it } from "vitest";
import {
  createDefaultDomainSkillRegistry,
} from "./domainSkills";
import {
  DefaultAgentPolicy,
  InMemoryAgentToolExecutor
} from "./agentServices";
import { parseAgentUserEvent } from "./agentSchemas";
import type { IntentClassifier } from "./intentClassifier";
import type { AgentRouter, AgentScheduler } from "./interfaces";
import {
  FixedWindowsPlanner,
  FixedWindowsRouter,
  MockVerifier
} from "./mockServices";
import { githubSearchInputFromState } from "./githubSearch";
import { ExtensibleAgentRouter } from "./router";
import { AgentRuntime } from "./runtime";
import { createDefaultSourceProviderRegistry } from "./sourceProviders";
import type { RouteIntentDecision } from "./intentSchemas";
import type { AgentPhase } from "./types";

function createNeverRunningScheduler() {
  let scheduledCount = 0;
  const scheduler: AgentScheduler = {
    schedule() {
      scheduledCount += 1;
      return () => undefined;
    }
  };

  return {
    scheduler,
    scheduledCount: () => scheduledCount
  };
}

function createRuntime(router: AgentRouter) {
  const scheduled = createNeverRunningScheduler();
  const runtime = new AgentRuntime({
    router,
    planner: new FixedWindowsPlanner(),
    verifier: new MockVerifier(),
    scheduler: scheduled.scheduler,
    tools: new InMemoryAgentToolExecutor(),
    policy: new DefaultAgentPolicy(),
    stepDelayMs: 0,
    createTaskId: () => "routing-recovery-test"
  });

  return { runtime, scheduledCount: scheduled.scheduledCount };
}

describe("AgentRuntime routing recovery", () => {
  it("aborts stale semantic routing and immediately routes a replacement task", async () => {
    let receivedSignal: AbortSignal | undefined;
    let releaseClassifier!: (decision: RouteIntentDecision) => void;
    let notifyClassifierStarted!: () => void;
    const classifierStarted = new Promise<void>((resolve) => {
      notifyClassifierStarted = resolve;
    });
    const pendingClassification = new Promise<RouteIntentDecision>(
      (resolve) => {
        releaseClassifier = resolve;
      }
    );
    const classifier: IntentClassifier = {
      classify(_context, signal) {
        receivedSignal = signal;
        notifyClassifierStarted();
        // Deliberately ignore abort and resolve late: Runtime must reject this
        // result by work identity even if a remote transport cannot cancel.
        return pendingClassification;
      }
    };
    const router = new ExtensibleAgentRouter(
      createDefaultDomainSkillRegistry(),
      createDefaultSourceProviderRegistry(),
      classifier
    );
    const scheduled = createNeverRunningScheduler();
    let taskSequence = 0;
    const runtime = new AgentRuntime({
      router,
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler: scheduled.scheduler,
      tools: new InMemoryAgentToolExecutor(),
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0,
      createTaskId: () => `semantic-route-task-${++taskSequence}`
    });

    runtime.start();
    runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "帮我看看那个神秘目标"
    });
    await classifierStarted;

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);

    const cancelled = runtime.dispatch({
      type: "CANCEL_TASK",
      cancelledAt: "2026-08-10T02:55:00.000Z"
    });
    expect(receivedSignal?.aborted).toBe(true);
    expect(cancelled).toMatchObject({
      taskId: "semantic-route-task-1",
      phase: "cancelled"
    });

    runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "检查cuda版本"
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.getState()).toMatchObject({
      taskId: "semantic-route-task-2",
      task: "检查cuda版本",
      phase: "task_planning",
      route: "local-development-environment-inspection",
      routeDecision: {
        status: "supported",
        skillId: "local-development-environment-inspection"
      }
    });

    releaseClassifier({
      decisionId: "late-github-route",
      provider: "remote-llm",
      model: "test-intent-model",
      skillId: "github-project-discovery",
      githubSearch: { mode: "name", query: "tau" },
      reason: "迟到的旧任务分类结果。"
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.getState()).toMatchObject({
      taskId: "semantic-route-task-2",
      task: "检查cuda版本",
      phase: "task_planning",
      route: "local-development-environment-inspection",
      routeDecision: {
        skillId: "local-development-environment-inspection"
      }
    });
    expect(runtime.getState().routeDecision?.semanticIntent).toBeUndefined();
  });

  it.each([
    ["tau", "tau"],
    ["寻找tau", "tau"]
  ])(
    "routes the fuzzy repository request %s to a GitHub name search",
    (task, expectedQuery) => {
      const { runtime } = createRuntime(new ExtensibleAgentRouter());
      runtime.start();

      const state = runtime.dispatch({ type: "SUBMIT_TASK", task });

      expect(state).toMatchObject({
        phase: "task_planning",
        route: "github-project-discovery",
        routeDecision: {
          status: "supported",
          skillId: "github-project-discovery",
          sourceProviderId: "github-api",
          clarifications: []
        }
      });
      expect(githubSearchInputFromState(state)).toEqual({
        mode: "name",
        query: expectedQuery,
        limit: 10
      });
    }
  );

  it.each([
    "检查cuda版本",
    "检查本机 git 版本",
    "查询本地 Node.js、npm、Python 和 CUDA 版本"
  ])(
    "keeps the explicit local-environment request %s out of GitHub routing",
    (task) => {
      const { runtime } = createRuntime(new ExtensibleAgentRouter());
      runtime.start();

      const state = runtime.dispatch({ type: "SUBMIT_TASK", task });

      expect(state).toMatchObject({
        phase: "task_planning",
        route: "local-development-environment-inspection",
        routeDecision: {
          status: "supported",
          skillId: "local-development-environment-inspection",
          sourceProviderId: "electron-main",
          clarifications: []
        }
      });
      expect(state.routeDecision?.skillId).not.toBe(
        "github-project-discovery"
      );
    }
  );

  it("resolves local routing synchronously even when the scheduler never runs", () => {
    const { runtime, scheduledCount } = createRuntime(
      new FixedWindowsRouter()
    );
    const phases: AgentPhase[] = [];
    runtime.subscribe((state) => phases.push(state.phase));
    runtime.start();

    const state = runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "准备 Windows AI 环境"
    });

    expect(state).toMatchObject({
      phase: "task_planning",
      route: "ai-development-environment",
      routeDecision: {
        status: "supported",
        skillId: "ai-development-environment"
      },
      agentRun: { status: "thinking" }
    });
    expect(phases).toEqual(["routing", "task_planning"]);
    expect(scheduledCount()).toBe(1);
  });

  it("records ROUTE_FAILED and succeeds after RETRY_ROUTING", () => {
    const fallbackRouter = new FixedWindowsRouter();
    let routeAttempts = 0;
    const flakyRouter: AgentRouter = {
      route(state) {
        routeAttempts += 1;
        if (routeAttempts === 1) {
          throw new Error("synthetic route failure");
        }
        return fallbackRouter.route(state);
      }
    };
    const { runtime, scheduledCount } = createRuntime(flakyRouter);
    const phases: AgentPhase[] = [];
    runtime.subscribe((state) => phases.push(state.phase));
    runtime.start();

    const failed = runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "准备 Windows AI 环境"
    });

    expect(failed).toMatchObject({
      phase: "cancelled",
      route: null,
      routeDecision: null,
      agentRun: { status: "failed" }
    });
    expect(failed.logs[failed.logs.length - 1]).toMatchObject({
      level: "error",
      message: expect.stringContaining("synthetic route failure")
    });
    expect(routeAttempts).toBe(1);
    expect(scheduledCount()).toBe(0);

    const recovered = runtime.dispatch({ type: "RETRY_ROUTING" });

    expect(recovered).toMatchObject({
      taskId: "routing-recovery-test",
      task: "准备 Windows AI 环境",
      phase: "task_planning",
      route: "ai-development-environment",
      routeDecision: {
        status: "supported",
        skillId: "ai-development-environment"
      },
      agentRun: { status: "thinking" }
    });
    expect(routeAttempts).toBe(2);
    expect(phases).toEqual([
      "routing",
      "cancelled",
      "routing",
      "task_planning"
    ]);
    expect(scheduledCount()).toBe(1);
  });

  it("turns an empty router result into a visible recoverable failure", () => {
    const { runtime } = createRuntime({ route: () => null });
    runtime.start();

    const failed = runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "检查本机开发环境"
    });

    expect(failed).toMatchObject({
      phase: "cancelled",
      routeDecision: null,
      taskPlan: null,
      workspace: {
        nextAction: "重新执行本地任务路由，或放弃本次任务。"
      }
    });
    expect(failed.logs[failed.logs.length - 1]?.message).toContain(
      "本地路由器未返回路由结果"
    );
  });

  it("accepts only the strict user retry protocol", () => {
    expect(parseAgentUserEvent({ type: "RETRY_ROUTING" })).toEqual({
      type: "RETRY_ROUTING"
    });
    expect(() =>
      parseAgentUserEvent({ type: "RETRY_ROUTING", task: "forged" })
    ).toThrow();
  });
});
