import { describe, expect, it } from "vitest";
import { createInitialAgentState, transition } from "./machine";
import { isRestorableAgentState } from "./persistence";

function createPersistableState() {
  let state = createInitialAgentState();
  state = transition(state, {
    type: "SUBMIT_TASK",
    task: "准备 Windows AI 环境",
    taskId: "task-persistence-test"
  });
  state = transition(state, {
    type: "ROUTE_RESOLVED",
    route: "windows-ai-development"
  });
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
});
