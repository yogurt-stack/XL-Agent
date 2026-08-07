import { transition } from "./machine";
import {
  createTaskPlan,
  defaultTaskPlanToolPolicies,
  prepareTaskPlanForConfirmation,
  validateTaskPlan
} from "./taskPlan";
import { createLocalTaskPlanProposal } from "./taskPlanTemplates";
import type { AgentState, AgentToolName } from "./types";

const testTools: AgentToolName[] = [
  "read_system_profile",
  "inspect_local_development_environment",
  "list_local_repository_tree",
  "read_local_repository_file",
  "inspect_project_requirements",
  "list_github_repository_tree",
  "read_github_repository_file",
  "inspect_github_project_requirements",
  "search_trusted_catalog",
  "search_github_repositories",
  "controlled_download",
  "export_workspace"
];

/** Test-only helper that creates the validated proposal shown at the confirmation gate. */
export function proposeTaskPlanForTest(state: AgentState): AgentState {
  if (state.phase !== "task_planning") {
    throw new Error(`Expected task_planning, received ${state.phase}.`);
  }
  const context = {
    state,
    step: state.agentRun.step,
    maxSteps: state.agentRun.maxSteps,
    availableTools: testTools,
    toolResults: state.agentRun.toolResults
  };
  const timestamp = "2026-07-31T00:00:00.000Z";
  const validationContext = {
    tools: defaultTaskPlanToolPolicies.filter((policy) =>
      testTools.includes(policy.name as AgentToolName)
    ),
    requireInitialConfirmation: true
  };
  const draft = createTaskPlan({
    planId: `test-plan-${state.taskId}`.slice(0, 80),
    taskId: state.taskId,
    proposal: createLocalTaskPlanProposal(context),
    createdBy: "local-rule",
    createdAt: timestamp
  });
  const validation = validateTaskPlan(draft, validationContext);
  return transition(state, {
    type: "TASK_PLAN_PROPOSED",
    plan: prepareTaskPlanForConfirmation(
      draft,
      validationContext,
      timestamp
    ),
    validation
  });
}

/** Test-only helper that crosses the explicit first-round Task Plan confirmation gate. */
export function confirmTaskPlanForTest(state: AgentState): AgentState {
  const proposed = proposeTaskPlanForTest(state);
  return transition(proposed, {
    type: "TASK_PLAN_CONFIRMED",
    revision: 1,
    confirmedAt: "2026-07-31T00:01:00.000Z"
  });
}
