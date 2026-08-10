import { describe, expect, it } from "vitest";
import {
  createInitialAgentState,
  getActiveClarification,
  transition
} from "./machine";
import {
  createTaskPlan,
  defaultTaskPlanToolPolicies,
  prepareTaskPlanForConfirmation,
  validateTaskPlan
} from "./taskPlan";
import { nextTaskPlanExecutorCommand } from "./taskPlanExecutor";
import type {
  AgentState,
  ClarificationQuestion,
  TaskPlanProposal
} from "./types";

const timestamps = {
  created: "2026-08-10T00:00:00.000Z",
  confirmed: "2026-08-10T00:01:00.000Z",
  profileStarted: "2026-08-10T00:02:00.000Z",
  profileCompleted: "2026-08-10T00:03:00.000Z",
  catalogStarted: "2026-08-10T00:04:00.000Z",
  catalogCompleted: "2026-08-10T00:05:00.000Z",
  inputRequested: "2026-08-10T00:06:00.000Z",
  answered: "2026-08-10T00:07:00.000Z",
  staleInputRequested: "2026-08-10T00:08:00.000Z"
};

const workloadQuestion: ClarificationQuestion = {
  id: "primary-workload",
  prompt: "主要准备哪类开发工作负载？",
  reason: "工作负载会影响资源组合。",
  required: true,
  options: ["Python AI 开发", "全栈 AI 应用"]
};

function proposalWithReadDependencies(): TaskPlanProposal {
  return {
    objective: "先读取本机与可信目录，再确认工作负载。",
    deliverables: ["与用户选择匹配的资源计划"],
    assumptions: [],
    constraints: ["读取步骤必须先于用户决策。"],
    steps: [
      {
        id: "read-system-profile",
        title: "读取系统画像",
        description: "读取安全裁剪后的系统画像。",
        kind: "read_tool",
        tool: "read_system_profile",
        dependsOn: [],
        staticInput: {},
        inputBindings: {},
        expectedOutput: "系统画像",
        risk: "read_only",
        approval: { required: false, reason: null }
      },
      {
        id: "search-trusted-catalog",
        title: "查询可信目录",
        description: "根据系统画像读取可信资源候选。",
        kind: "read_tool",
        tool: "search_trusted_catalog",
        dependsOn: ["read-system-profile"],
        staticInput: { query: "Windows AI 开发环境" },
        inputBindings: {},
        expectedOutput: "可信资源候选",
        risk: "read_only",
        approval: { required: false, reason: null }
      },
      {
        id: "confirm-workload",
        title: "确认工作负载",
        description: workloadQuestion.reason,
        kind: "user_decision",
        tool: null,
        dependsOn: ["search-trusted-catalog"],
        staticInput: {
          questionId: workloadQuestion.id,
          required: workloadQuestion.required
        },
        inputBindings: {},
        expectedOutput: "用户确认的工作负载",
        risk: "read_only",
        approval: { required: false, reason: null }
      },
      {
        id: "create-resource-plan",
        title: "生成资源计划",
        description: "按已确认的工作负载生成资源计划。",
        kind: "resource_plan",
        tool: null,
        dependsOn: ["confirm-workload"],
        staticInput: {},
        inputBindings: {},
        expectedOutput: "待独立审批的资源计划",
        risk: "read_only",
        approval: { required: false, reason: null }
      }
    ],
    confirmation: {
      required: true,
      reason: "先确认完整处理流程。"
    }
  };
}

function createWaitingConfirmationState(): AgentState {
  const submitted = transition(createInitialAgentState(), {
    type: "SUBMIT_TASK",
    task: "准备 Windows AI 开发环境",
    taskId: "read-before-decision-regression"
  });
  const routed = transition(submitted, {
    type: "ROUTE_RESOLVED",
    decision: {
      status: "supported",
      reason: "regression fixture",
      skillId: "ai-development-environment",
      sourceProviderId: "trusted-catalog",
      userLinks: [],
      resourceIds: [],
      clarifications: [workloadQuestion],
      requirements: null
    }
  });
  const validationContext = {
    tools: defaultTaskPlanToolPolicies,
    requireInitialConfirmation: true
  };
  const draft = createTaskPlan({
    planId: "read-before-decision-plan",
    taskId: routed.taskId,
    proposal: proposalWithReadDependencies(),
    createdBy: "local-rule",
    createdAt: timestamps.created
  });
  const validation = validateTaskPlan(draft, validationContext);
  expect(validation.valid).toBe(true);

  return transition(routed, {
    type: "TASK_PLAN_PROPOSED",
    plan: prepareTaskPlanForConfirmation(
      draft,
      validationContext,
      timestamps.created
    ),
    validation
  });
}

function completeReadStep(
  state: AgentState,
  stepId: string,
  startedAt: string,
  completedAt: string
) {
  const started = transition(state, {
    type: "TASK_PLAN_STEP_STARTED",
    stepId,
    startedAt
  });
  return transition(started, {
    type: "TASK_PLAN_STEP_COMPLETED",
    stepId,
    completedAt,
    result: {
      reference: `test:${stepId}`,
      summary: `${stepId} completed.`,
      output: { ok: true }
    }
  });
}

describe("Task Plan clarification sequencing", () => {
  it("executes read dependencies before asking once for the matching user decision", () => {
    let state = transition(createWaitingConfirmationState(), {
      type: "TASK_PLAN_CONFIRMED",
      revision: 1,
      confirmedAt: timestamps.confirmed
    });

    expect(state.phase).toBe("planning");
    expect(nextTaskPlanExecutorCommand(state)).toEqual({
      type: "start_step",
      stepId: "read-system-profile"
    });

    state = completeReadStep(
      state,
      "read-system-profile",
      timestamps.profileStarted,
      timestamps.profileCompleted
    );
    expect(nextTaskPlanExecutorCommand(state)).toEqual({
      type: "start_step",
      stepId: "search-trusted-catalog"
    });

    state = completeReadStep(
      state,
      "search-trusted-catalog",
      timestamps.catalogStarted,
      timestamps.catalogCompleted
    );
    expect(nextTaskPlanExecutorCommand(state)).toEqual({
      type: "request_input",
      stepId: "confirm-workload"
    });

    state = transition(state, {
      type: "TASK_PLAN_STEP_INPUT_REQUESTED",
      stepId: "confirm-workload",
      requestedAt: timestamps.inputRequested
    });
    expect(state).toMatchObject({
      phase: "clarifying",
      clarificationIndex: 0,
      taskPlan: { status: "waiting_user_input" }
    });
    expect(getActiveClarification(state)?.id).toBe(workloadQuestion.id);

    state = transition(state, {
      type: "ANSWER_CLARIFICATION",
      questionId: workloadQuestion.id,
      answer: "Python AI 开发",
      answeredAt: timestamps.answered
    });
    expect(state).toMatchObject({
      phase: "planning",
      clarificationIndex: 1,
      answers: { [workloadQuestion.id]: "Python AI 开发" },
      taskPlan: { status: "executing" }
    });
    expect(
      state.taskPlan?.steps.find((step) => step.id === "confirm-workload")
    ).toMatchObject({
      status: "completed",
      result: {
        output: {
          questionId: workloadQuestion.id,
          answer: "Python AI 开发"
        }
      }
    });
    expect(nextTaskPlanExecutorCommand(state)).toEqual({
      type: "start_step",
      stepId: "create-resource-plan"
    });

    const afterStaleRequest = transition(state, {
      type: "TASK_PLAN_STEP_INPUT_REQUESTED",
      stepId: "confirm-workload",
      requestedAt: timestamps.staleInputRequested
    });
    expect(afterStaleRequest).toBe(state);
    expect(afterStaleRequest.phase).toBe("planning");
    expect(getActiveClarification(afterStaleRequest)).toBeNull();
    expect(
      afterStaleRequest.taskPlan?.steps.find(
        (step) => step.id === "confirm-workload"
      )?.status
    ).toBe("completed");
    expect(nextTaskPlanExecutorCommand(afterStaleRequest)).toEqual({
      type: "start_step",
      stepId: "create-resource-plan"
    });
  });
});
