import { describe, expect, it } from "vitest";
import { createInitialAgentState, transition } from "./machine";
import {
  isRestorableAgentState,
  normalizeRestorableAgentState
} from "./persistence";
import { ExtensibleAgentRouter } from "./router";

function createPersistableState() {
  let state = createInitialAgentState();
  state = transition(state, {
    type: "SUBMIT_TASK",
    task: "准备 Windows AI 环境",
    taskId: "task-persistence-test"
  });
  state = transition(state, new ExtensibleAgentRouter().route(state)!);
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

  it("migrates the legacy fixed route snapshot without changing task progress", () => {
    const current = createPersistableState();
    const legacy = {
      ...current,
      route: "windows-ai-development"
    } as Record<string, unknown>;
    delete legacy.routeDecision;

    const restored = normalizeRestorableAgentState(legacy);

    expect(restored).not.toBeNull();
    expect(restored?.route).toBe("ai-development-environment");
    expect(restored?.routeDecision).toMatchObject({
      status: "supported",
      skillId: "ai-development-environment",
      sourceProviderId: "trusted-catalog"
    });
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
});
