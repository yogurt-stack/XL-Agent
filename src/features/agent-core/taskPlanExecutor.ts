import { parseAgentToolCall } from "./agentSchemas";
import { githubSearchInputFromState } from "./githubSearch";
import { getReadyTaskPlanSteps } from "./taskPlan";
import type {
  AgentState,
  AgentToolCall,
  TaskPlan,
  TaskPlanStep
} from "./types";

export type TaskPlanExecutorCommand =
  | { type: "request_input"; stepId: string }
  | { type: "request_approval"; stepId: string }
  | { type: "auto_approve"; stepId: string }
  | { type: "start_step"; stepId: string }
  | { type: "run_agent_loop"; stepId: string }
  | { type: "execute_tool"; stepId: string; call: AgentToolCall }
  | { type: "generate_resource_plan"; stepId: string }
  | { type: "execute_download_batch"; stepId: string }
  | { type: "verify_resources"; stepId: string }
  | { type: "export_workspace"; stepId: string }
  | {
      type: "complete_passive";
      stepId: string;
      terminalPhase?: "result" | "handoff";
    };

export function activeTaskPlanStep(plan: TaskPlan | null) {
  return plan?.steps.find((step) =>
    ["running", "waiting_user_input", "waiting_approval"].includes(
      step.status
    )
  ) ?? null;
}

function commandForRunningStep(
  state: AgentState,
  step: TaskPlanStep
): TaskPlanExecutorCommand | null {
  if (step.status !== "running") return null;
  if (step.tool === "controlled_download" || step.tool === "simulate_download") {
    const activeResource = state.resources.find(
      (resource) => resource.id === state.activeResourceId
    );
    return (state.phase === "downloading" &&
      activeResource !== undefined &&
      activeResource.status !== "paused") ||
      state.phase === "verifying"
      ? { type: "execute_download_batch", stepId: step.id }
      : null;
  }
  if (step.tool === "export_workspace") {
    return state.phase === "exporting" || state.phase === "handoff"
      ? { type: "export_workspace", stepId: step.id }
      : null;
  }
  if (step.kind === "read_tool" && step.tool) {
    return state.phase === "planning"
      ? {
          type: "execute_tool",
          stepId: step.id,
          call: createTaskPlanToolCall(state, step)
        }
      : null;
  }
  if (
    step.kind === "analysis" &&
    step.execution?.mode === "agent_loop"
  ) {
    return state.phase === "planning"
      ? { type: "run_agent_loop", stepId: step.id }
      : null;
  }
  if (step.kind === "resource_plan") {
    return state.phase === "planning" || state.phase === "replanning"
      ? { type: "generate_resource_plan", stepId: step.id }
      : null;
  }
  if (step.kind === "verification") {
    return state.phase === "verifying" ||
      state.phase === "exporting" ||
      state.phase === "handoff"
      ? { type: "verify_resources", stepId: step.id }
      : null;
  }
  if (step.kind === "handoff") {
    const readOnlyResultTask =
      state.routeDecision?.skillId === "github-project-discovery" ||
      [
        "local-development-environment-inspection",
        "local-environment-compatibility-assessment",
        "local-project-environment-compatibility",
        "github-project-environment-compatibility"
      ].includes(state.routeDecision?.skillId ?? "");
    return {
      type: "complete_passive",
      stepId: step.id,
      terminalPhase: readOnlyResultTask && state.resources.length === 0
        ? "result"
        : "handoff"
    };
  }
  return { type: "complete_passive", stepId: step.id };
}

/**
 * 计算 TaskPlan DAG 的唯一下一条命令。
 * phase 只作为具体执行后端的就绪信号；步骤选择完全来自 TaskPlan。
 */
export function nextTaskPlanExecutorCommand(
  state: AgentState
): TaskPlanExecutorCommand | null {
  const plan = state.taskPlan;
  if (!plan || plan.status === "completed" || plan.status === "cancelled") {
    return null;
  }
  const active = activeTaskPlanStep(plan);
  if (active) return commandForRunningStep(state, active);
  if (plan.status !== "executing") return null;

  const [step] = getReadyTaskPlanSteps(plan);
  if (!step) return null;
  if (step.approval.required && step.approval.status !== "approved") {
    return state.approvedRevision === state.revision &&
      step.risk === "local_write"
      ? { type: "auto_approve", stepId: step.id }
      : { type: "request_approval", stepId: step.id };
  }
  if (step.kind === "user_decision") {
    return { type: "request_input", stepId: step.id };
  }
  if (step.kind === "read_tool" && state.phase !== "planning") {
    return null;
  }
  return { type: "start_step", stepId: step.id };
}

function readPath(value: unknown, path: string) {
  const normalized = path.replace(/^\$\.?/u, "");
  if (!normalized) return value;
  const tokens = normalized.match(/[A-Za-z_][A-Za-z0-9_-]*|\d+/gu) ?? [];
  let current = value;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

export function resolveTaskPlanStepInput(
  plan: TaskPlan,
  step: TaskPlanStep
) {
  const input: Record<string, unknown> = structuredClone(step.staticInput);
  for (const [name, binding] of Object.entries(step.inputBindings)) {
    const source = plan.steps.find(
      (candidate) => candidate.id === binding.sourceStepId
    );
    const value = readPath(source?.result?.output, binding.outputPath);
    if (value === undefined && binding.required) {
      throw new Error(
        `步骤 ${step.id} 无法解析 ${binding.sourceStepId}.${binding.outputPath}。`
      );
    }
    if (value !== undefined) input[name] = value;
  }
  return input;
}

export function createTaskPlanToolCall(
  state: AgentState,
  step: TaskPlanStep
): AgentToolCall {
  if (!state.taskPlan || !step.tool) {
    throw new Error(`步骤 ${step.id} 没有可执行工具。`);
  }
  const input = resolveTaskPlanStepInput(state.taskPlan, step);
  const callId = `task-plan-r${state.taskPlan.revision}-${step.id}`;
  if (step.tool === "read_system_profile") {
    return parseAgentToolCall({ callId, name: step.tool, input: {} });
  }
  if (step.tool === "inspect_local_development_environment") {
    return parseAgentToolCall({ callId, name: step.tool, input: {} });
  }
  if (step.tool === "search_trusted_catalog") {
    return parseAgentToolCall({
      callId,
      name: step.tool,
      input: {
        query:
          typeof input.query === "string" && input.query.trim()
            ? input.query
            : state.task,
        ...(Array.isArray(input.resourceIds)
          ? { resourceIds: input.resourceIds }
          : {})
      }
    });
  }
  if (step.tool === "search_github_repositories") {
    return parseAgentToolCall({
      callId,
      name: step.tool,
      input: githubSearchInputFromState(state)
    });
  }
  throw new Error(`步骤 ${step.id} 的工具 ${step.tool} 由专用执行后端处理。`);
}
