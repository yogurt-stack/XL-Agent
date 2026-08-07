import { describe, expect, it } from "vitest";
import { createInitialAgentState } from "./machine";
import {
  approveTaskPlanStep,
  completeTaskPlanStep,
  confirmTaskPlan,
  createTaskPlan,
  defaultTaskPlanToolPolicies,
  prepareTaskPlanForConfirmation,
  requestTaskPlanStepApproval,
  startTaskPlanStep
} from "./taskPlan";
import {
  nextTaskPlanExecutorCommand,
  resolveTaskPlanStepInput
} from "./taskPlanExecutor";
import type {
  AgentState,
  PlannedResource,
  TaskPlan,
  TaskPlanProposal
} from "./types";

const at = "2026-08-01T00:00:00.000Z";

function createConfirmedPlan(proposal: TaskPlanProposal) {
  const context = {
    tools: defaultTaskPlanToolPolicies,
    requireInitialConfirmation: true
  };
  const draft = createTaskPlan({
    planId: "executor-plan",
    taskId: "executor-task",
    proposal,
    createdBy: "local-rule",
    createdAt: at
  });
  return confirmTaskPlan(
    prepareTaskPlanForConfirmation(draft, context, at),
    { revision: 1, confirmedAt: at }
  );
}

function searchPlan(): TaskPlan {
  return createConfirmedPlan({
    objective: "查找 tau 仓库",
    deliverables: ["仓库结果"],
    assumptions: [],
    constraints: ["只读"],
    steps: [
      {
        id: "search",
        title: "搜索仓库",
        description: "按名称查询 GitHub 仓库。",
        kind: "read_tool",
        tool: "search_github_repositories",
        dependsOn: [],
        staticInput: { mode: "name", query: "tau", limit: 10 },
        inputBindings: {},
        expectedOutput: "仓库列表",
        risk: "read_only",
        approval: { required: false, reason: null }
      },
      {
        id: "present",
        title: "展示结果",
        description: "向用户展示已查询的候选仓库。",
        kind: "handoff",
        tool: null,
        dependsOn: ["search"],
        staticInput: {},
        inputBindings: {
          repositories: {
            sourceStepId: "search",
            outputPath: "repositories",
            required: true
          }
        },
        expectedOutput: "可查看的结果",
        risk: "read_only",
        approval: { required: false, reason: null }
      }
    ],
    confirmation: { required: true, reason: "确认查询方式。" }
  });
}

function stateWithPlan(plan: TaskPlan): AgentState {
  return {
    ...createInitialAgentState(),
    taskId: "executor-task",
    task: "查找 tau 仓库",
    phase: "planning",
    route: "github-project-discovery",
    routeDecision: {
      status: "supported",
      reason: "test",
      skillId: "github-project-discovery",
      sourceProviderId: "github-api",
      userLinks: [],
      resourceIds: [],
      clarifications: [],
      requirements: null
    },
    taskPlan: plan
  };
}

describe("TaskPlan DAG executor", () => {
  it("selects the next command from DAG state and resolves prior outputs", () => {
    let plan = searchPlan();
    let state = stateWithPlan(plan);

    expect(nextTaskPlanExecutorCommand(state)).toEqual({
      type: "start_step",
      stepId: "search"
    });

    plan = startTaskPlanStep(plan, "search", at);
    state = stateWithPlan(plan);
    expect(nextTaskPlanExecutorCommand(state)).toMatchObject({
      type: "execute_tool",
      stepId: "search",
      call: {
        name: "search_github_repositories",
        input: { mode: "name", query: "tau", limit: 10 }
      }
    });

    plan = completeTaskPlanStep(plan, {
      stepId: "search",
      completedAt: at,
      result: {
        reference: "tool:search",
        summary: "查询完成。",
        output: { repositories: [{ fullName: "microsoft/tau" }] }
      }
    });
    const present = plan.steps.find((step) => step.id === "present")!;
    expect(resolveTaskPlanStepInput(plan, present)).toEqual({
      repositories: [{ fullName: "microsoft/tau" }]
    });
    expect(nextTaskPlanExecutorCommand(stateWithPlan(plan))).toEqual({
      type: "start_step",
      stepId: "present"
    });
  });

  it("keeps read tools dormant while the UI is still collecting clarification", () => {
    const state = {
      ...stateWithPlan(searchPlan()),
      phase: "clarifying" as const
    };

    expect(nextTaskPlanExecutorCommand(state)).toBeNull();
  });

  it("builds GitHub discovery input from the confirmed clarification answers", () => {
    const plan = startTaskPlanStep(searchPlan(), "search", at);
    const state = {
      ...stateWithPlan(plan),
      task: "帮我查找 GitHub 最新热门开源项目",
      answers: {
        "github-created-window": "最近 7 天新建",
        "github-sort": "按 Fork 数"
      }
    };

    expect(nextTaskPlanExecutorCommand(state)).toMatchObject({
      type: "execute_tool",
      call: {
        name: "search_github_repositories",
        input: {
          mode: "discovery",
          createdWithinDays: 7,
          sort: "forks",
          limit: 10
        }
      }
    });
  });

  it("does not start a local write until its TaskPlan revision is approved", () => {
    let plan = createConfirmedPlan({
      objective: "下载资源",
      deliverables: ["本地文件"],
      assumptions: [],
      constraints: ["审批后写入"],
      steps: [{
        id: "download",
        title: "下载",
        description: "下载已审批资源。",
        kind: "write_tool",
        tool: "controlled_download",
        dependsOn: [],
        staticInput: {},
        inputBindings: {},
        expectedOutput: "下载文件",
        risk: "local_write",
        approval: { required: true, reason: "写入本地文件。" }
      }],
      confirmation: { required: true, reason: "确认流程。" }
    });
    const initial = stateWithPlan(plan);
    expect(nextTaskPlanExecutorCommand(initial)).toEqual({
      type: "request_approval",
      stepId: "download"
    });

    plan = requestTaskPlanStepApproval(plan, "download", at);
    expect(nextTaskPlanExecutorCommand(stateWithPlan(plan))).toBeNull();
    plan = approveTaskPlanStep(plan, {
      stepId: "download",
      revision: 1,
      approvedAt: at
    });
    expect(nextTaskPlanExecutorCommand(stateWithPlan(plan))).toEqual({
      type: "start_step",
      stepId: "download"
    });
  });

  it("keeps a paused download step dormant until the host reports resume", () => {
    let plan = createConfirmedPlan({
      objective: "模拟下载",
      deliverables: ["传输结果"],
      assumptions: [],
      constraints: ["可暂停"],
      steps: [{
        id: "download",
        title: "模拟下载",
        description: "执行可暂停的模拟传输。",
        kind: "verification",
        tool: "simulate_download",
        dependsOn: [],
        staticInput: {},
        inputBindings: {},
        expectedOutput: "传输结果",
        risk: "read_only",
        approval: { required: false, reason: null }
      }],
      confirmation: { required: true, reason: "确认流程。" }
    });
    plan = startTaskPlanStep(plan, "download", at);
    const resource = {
      id: "resource",
      selected: true,
      status: "paused",
      progress: 50
    } as PlannedResource;
    const state = {
      ...stateWithPlan(plan),
      phase: "downloading" as const,
      resources: [resource],
      activeResourceId: resource.id
    };
    expect(nextTaskPlanExecutorCommand(state)).toBeNull();
    expect(nextTaskPlanExecutorCommand({
      ...state,
      resources: [{ ...resource, status: "downloading" }]
    })).toEqual({ type: "execute_download_batch", stepId: "download" });
  });
});
