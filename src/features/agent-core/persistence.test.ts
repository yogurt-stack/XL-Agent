import { describe, expect, it } from "vitest";
import { createInitialAgentState, transition } from "./machine";
import {
  isRestorableAgentState,
  normalizeRestorableAgentState
} from "./persistence";
import { ExtensibleAgentRouter } from "./router";
import { confirmTaskPlanForTest } from "./taskPlanTestSupport";

function createPersistableState() {
  let state = createInitialAgentState();
  state = transition(state, {
    type: "SUBMIT_TASK",
    task: "准备 Windows AI 环境",
    taskId: "task-persistence-test"
  });
  state = transition(state, new ExtensibleAgentRouter().route(state)!);
  state = confirmTaskPlanForTest(state);
  state = transition(state, {
    type: "ANSWER_CLARIFICATION",
    questionId: "primary-workload",
    answer: "Python AI 开发"
  });
  state = transition(state, {
    type: "SKIP_CLARIFICATION",
    questionId: "mirror-policy"
  });
  state = transition(state, { type: "PLAN_GENERATED" });
  return transition(state, { type: "APPROVE_PLAN", revision: 1 });
}

function createRunningCompatibilityLoopState() {
  let state = createInitialAgentState();
  state = transition(state, {
    type: "SUBMIT_TASK",
    task: "检查 PyTorch 本机环境匹配程度",
    taskId: "task-agent-loop-persistence"
  });
  state = transition(state, new ExtensibleAgentRouter().route(state)!);
  state = confirmTaskPlanForTest(state);
  const step = state.taskPlan?.steps[0];
  if (!state.taskPlan || !step) throw new Error("Compatibility Task Plan missing.");
  state = transition(state, {
    type: "TASK_PLAN_STEP_STARTED",
    stepId: step.id,
    startedAt: "2026-08-07T00:00:00.000Z"
  });
  return transition(state, {
    type: "AGENT_LOOP_STARTED",
    runId: "persisted-agent-loop",
    planId: state.taskPlan!.planId,
    planRevision: state.taskPlan!.revision,
    stepId: step.id,
    startedAt: "2026-08-07T00:00:01.000Z"
  });
}

describe("persisted AgentState validation", () => {
  it("accepts a complete in-progress state", () => {
    expect(isRestorableAgentState(createPersistableState())).toBe(true);
  });

  it("rejects idle or structurally damaged state", () => {
    expect(isRestorableAgentState(createInitialAgentState())).toBe(false);
    const state = createPersistableState();
    expect(
      isRestorableAgentState({
        ...state,
        resources: state.resources.map((resource, index) =>
          index === 0
            ? {
                ...resource,
                download: { ...resource.download, expectedSha256: null }
              }
            : resource
        )
      })
    ).toBe(false);
  });

  it("migrates the legacy fixed route snapshot without changing task progress", () => {
    const current = createPersistableState();
    const legacy = {
      ...current,
      route: "windows-ai-development"
    } as Record<string, unknown>;
    delete legacy.routeDecision;
    delete legacy.taskPlan;
    delete legacy.taskPlanValidation;

    const restored = normalizeRestorableAgentState(legacy);

    expect(restored).not.toBeNull();
    expect(restored?.route).toBe("ai-development-environment");
    expect(restored?.routeDecision).toMatchObject({
      status: "supported",
      skillId: "ai-development-environment",
      sourceProviderId: "trusted-catalog"
    });
    expect(restored?.taskPlan).toBeNull();
    expect(restored?.taskPlanValidation).toBeNull();
    expect(restored?.revision).toBe(current.revision);
    expect(restored?.approvedRevision).toBe(current.approvedRevision);
    expect(restored?.resources).toEqual(current.resources);
  });

  it("does not disguise a structurally damaged legacy snapshot as migrated", () => {
    const current = createPersistableState();
    const legacy = {
      ...current,
      route: "windows-ai-development",
      resources: null
    } as Record<string, unknown>;
    delete legacy.routeDecision;

    expect(normalizeRestorableAgentState(legacy)).toBeNull();
  });

  it("rejects negative Agent Loop usage restored from persistence", () => {
    const state = createRunningCompatibilityLoopState();
    const agentLoop = state.agentRun.agentLoop!;
    const tampered = {
      ...state,
      agentRun: {
        ...state.agentRun,
        agentLoop: {
          ...agentLoop,
          usage: {
            turns: -1,
            toolCalls: 0,
            executedToolCalls: 0,
            elapsedMs: 0
          }
        }
      }
    };

    expect(normalizeRestorableAgentState(tampered)).toBeNull();
  });

  it("revalidates persisted TaskPlan capability envelopes", () => {
    const state = createRunningCompatibilityLoopState();
    const plan = state.taskPlan!;
    const tampered = {
      ...state,
      taskPlan: {
        ...plan,
        steps: plan.steps.map((step, index) =>
          index === 0 && step.execution.mode === "agent_loop"
            ? {
                ...step,
                execution: {
                  ...step.execution,
                  allowedTools: ["controlled_download"]
                }
              }
            : step
        )
      }
    };

    expect(normalizeRestorableAgentState(tampered)).toBeNull();
  });
});
