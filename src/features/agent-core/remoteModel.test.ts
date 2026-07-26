import { describe, expect, it } from "vitest";
import {
  DefaultAgentPolicy,
  InMemoryAgentToolExecutor
} from "./agentServices";
import { ModelConnectionController } from "./modelConnection";
import { LocalRuleModelRuntime } from "./localRuleModel";
import { createInitialAgentState } from "./machine";
import {
  FixedWindowsPlanner,
  FixedWindowsRouter,
  MockVerifier
} from "./mockServices";
import {
  FallbackModelRuntime,
  RemoteLlmModelRuntime
} from "./remoteModel";
import { AgentRuntime } from "./runtime";
import type { AgentScheduler } from "./interfaces";
import type { ModelContext, ToolResult } from "./types";

function successfulToolResult(
  tool: ToolResult["tool"],
  output: unknown
): ToolResult {
  return {
    callId: `successful-${tool}`,
    tool,
    status: "success",
    output,
    startedAt: "test-start",
    finishedAt: "test-finish"
  };
}

function fullStackPlanningContext(): ModelContext {
  return {
    state: {
      ...createInitialAgentState(),
      phase: "planning",
      task: "帮我准备一个 Windows 下的 AI 开发环境",
      answers: {
        "primary-workload": "全栈 AI 应用",
        "fullstack-scope": "包含可验证示例项目"
      }
    },
    step: 3,
    maxSteps: 6,
    availableTools: [
      "read_system_profile",
      "search_trusted_catalog",
      "controlled_download",
      "export_workspace"
    ],
    toolResults: [
      successfulToolResult("read_system_profile", {}),
      successfulToolResult("search_trusted_catalog", [
        { id: "python-312" },
        { id: "vscode" },
        { id: "git" },
        { id: "node-lts" },
        { id: "sample-project" }
      ])
    ]
  };
}

describe("remote model runtime", () => {
  it("rejects a repeated successful catalog query", async () => {
    const model = new RemoteLlmModelRuntime({
      async requestDecision() {
        return {
          decisionId: "remote-repeat",
          provider: "remote-llm",
          model: "test-remote",
          explanation: "Search again.",
          action: {
            actionId: "repeat-catalog",
            type: "call_tool",
            purpose: "Search again.",
            call: {
              callId: "repeat-catalog",
              name: "search_trusted_catalog",
              input: { query: "Windows development resources" }
            }
          }
        };
      }
    });

    await expect(model.decide(fullStackPlanningContext())).rejects.toMatchObject({
      detail: {
        code: "MODEL_INVALID_DECISION",
        message: expect.stringContaining("重复调用")
      }
    });
  });

  it("falls back to a deterministic complete plan when the remote model repeats a catalog query", async () => {
    const primary = new RemoteLlmModelRuntime({
      async requestDecision() {
        return {
          decisionId: "remote-repeat",
          provider: "remote-llm",
          model: "test-remote",
          explanation: "Search again.",
          action: {
            actionId: "repeat-catalog",
            type: "call_tool",
            purpose: "Search again.",
            call: {
              callId: "repeat-catalog",
              name: "search_trusted_catalog",
              input: { query: "Windows development resources" }
            }
          }
        };
      }
    });
    const model = new FallbackModelRuntime(
      primary,
      new LocalRuleModelRuntime()
    );

    const decision = await model.decide(fullStackPlanningContext());

    expect(decision).toMatchObject({
      provider: "local-rule",
      action: {
        type: "create_plan",
        resourceIds: [
          "python-312",
          "vscode",
          "git",
          "node-lts",
          "sample-project"
        ]
      }
    });
  });

  it("falls back to the missing full-stack clarification instead of exhausting the step limit", async () => {
    const context = fullStackPlanningContext();
    delete context.state.answers["fullstack-scope"];
    const primary = new RemoteLlmModelRuntime({
      async requestDecision() {
        return {
          decisionId: "remote-repeat",
          provider: "remote-llm",
          model: "test-remote",
          explanation: "Search again.",
          action: {
            actionId: "repeat-catalog",
            type: "call_tool",
            purpose: "Search again.",
            call: {
              callId: "repeat-catalog",
              name: "search_trusted_catalog",
              input: { query: "Windows development resources" }
            }
          }
        };
      }
    });
    const model = new FallbackModelRuntime(
      primary,
      new LocalRuleModelRuntime()
    );

    const decision = await model.decide(context);

    expect(decision).toMatchObject({
      provider: "local-rule",
      action: {
        type: "ask_clarification",
        questionId: "fullstack-scope"
      }
    });
  });

  it("completes the reported full-stack planning path after a repeated remote catalog query", async () => {
    const queuedJobs: Array<() => void | Promise<void>> = [];
    const scheduler: AgentScheduler = {
      schedule(task) {
        queuedJobs.push(task);
        return () => undefined;
      }
    };
    const controller = new ModelConnectionController({
      async getConnectionInfo() {
        return {
          configured: true,
          endpointHost: "api.example.test",
          model: "test-model"
        };
      },
      async testConnection() {
        return { ok: true };
      }
    });
    const remote = new RemoteLlmModelRuntime({
      async requestDecision(context) {
        const modelContext = context as ModelContext;
        const actionBase = {
          provider: "remote-llm",
          model: "test-model"
        };
        if (modelContext.state.phase === "routing") {
          return {
            ...actionBase,
            decisionId: "remote-primary-workload",
            explanation: "Clarify the workload.",
            action: {
              actionId: "remote-primary-workload",
              type: "ask_clarification",
              questionId: "primary-workload",
              question: "这个环境的主要工作负载是什么？",
              reason: "选择资源范围。",
              required: true,
              options: ["Python AI 开发", "全栈 AI 应用", "仅准备基础环境"]
            }
          };
        }
        if (
          !modelContext.toolResults.some(
            (result) =>
              result.tool === "read_system_profile" &&
              result.status === "success"
          )
        ) {
          return {
            ...actionBase,
            decisionId: "remote-profile",
            explanation: "Read the system profile.",
            action: {
              actionId: "remote-profile",
              type: "call_tool",
              purpose: "Read the system profile.",
              call: {
                callId: "remote-profile",
                name: "read_system_profile",
                input: {}
              }
            }
          };
        }
        return {
          ...actionBase,
          decisionId: "remote-catalog",
          explanation: "Search the catalog.",
          action: {
            actionId: "remote-catalog",
            type: "call_tool",
            purpose: "Search the catalog.",
            call: {
              callId: `remote-catalog-${modelContext.step}`,
              name: "search_trusted_catalog",
              input: {
                query: "Windows 11 AI development environment full stack"
              }
            }
          }
        };
      }
    });
    const model = new FallbackModelRuntime(
      remote,
      new LocalRuleModelRuntime(),
      {
        shouldAttemptPrimary: () => controller.shouldAttemptRemote(),
        onPrimaryFailure: (error) => controller.recordFallback(error)
      }
    );
    const runtime = new AgentRuntime({
      router: new FixedWindowsRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler,
      model,
      tools: new InMemoryAgentToolExecutor(),
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0,
      createTaskId: () => "fullstack-regression"
    });
    runtime.start();
    runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "帮我准备一个 Windows 下的 AI 开发环境"
    });

    const runUntil = async (predicate: () => boolean) => {
      for (let index = 0; index < 20 && !predicate(); index += 1) {
        const job = queuedJobs.shift();
        if (!job) throw new Error("Runtime stopped before reaching the expected state.");
        await job();
      }
      expect(predicate()).toBe(true);
    };

    await runUntil(() => runtime.getState().phase === "clarifying");
    runtime.dispatch({
      type: "ANSWER_CLARIFICATION",
      questionId: "primary-workload",
      answer: "全栈 AI 应用"
    });
    runtime.dispatch({
      type: "SKIP_CLARIFICATION",
      questionId: "mirror-policy"
    });
    await runUntil(
      () =>
        runtime.getState().phase === "clarifying" &&
        runtime.getState().clarifications[0]?.id === "fullstack-scope"
    );
    expect(controller.getState()).toMatchObject({
      status: "fallback_local",
      activeProvider: "local-rule",
      error: { code: "MODEL_INVALID_DECISION" }
    });

    runtime.dispatch({
      type: "ANSWER_CLARIFICATION",
      questionId: "fullstack-scope",
      answer: "包含可验证示例项目"
    });
    await runUntil(() => runtime.getState().phase === "waiting_approval");

    expect(runtime.getState()).toMatchObject({
      phase: "waiting_approval",
      revision: 1,
      agentRun: { step: 4 }
    });
    expect(runtime.getState().resources.map((resource) => resource.id)).toEqual([
      "python-312",
      "vscode",
      "git",
      "node-lts",
      "sample-project"
    ]);
  });
});
