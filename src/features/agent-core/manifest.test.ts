import { describe, expect, it } from "vitest";
import { createResourceManifest } from "./manifest";
import { createInitialAgentState, transition } from "./machine";
import type { AgentState } from "./types";

function createApprovedPlan(): AgentState {
  let state = createInitialAgentState();
  state = transition(state, { type: "SUBMIT_TASK", task: "准备 Windows AI 环境" });
  state = transition(state, { type: "ROUTE_RESOLVED", route: "windows-ai-development" });
  state = transition(state, {
    type: "ANSWER_CLARIFICATION",
    questionId: "primary-workload",
    answer: "Python AI 开发"
  });
  state = transition(state, { type: "SKIP_CLARIFICATION", questionId: "mirror-policy" });
  state = transition(state, { type: "PLAN_GENERATED" });
  return transition(state, { type: "APPROVE_PLAN", revision: 1 });
}

describe("resource manifest", () => {
  it("describes a verified workspace without missing required resources", () => {
    const approved = createApprovedPlan();
    const verifying: AgentState = {
      ...approved,
      phase: "verifying",
      activeResourceId: null,
      resources: approved.resources.map((resource) =>
        resource.selected ? { ...resource, status: "downloaded", progress: 100 } : resource
      )
    };
    const handoff = transition(verifying, { type: "VERIFY_RESOURCES" });
    const manifest = createResourceManifest(handoff);

    expect(manifest).toMatchObject({
      schemaVersion: "agent-core-demo-1.0",
      revision: 1,
      approvedRevision: 1,
      handoff: { ready: true, missingItems: [] }
    });
    expect(manifest.resources.filter((resource) => resource.selected)).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "verified" })])
    );
  });

  it("preserves failure details in an Agent B handoff", () => {
    const approved = createApprovedPlan();
    const awaitingAction: AgentState = {
      ...approved,
      phase: "awaiting_failure_action",
      activeResourceId: null,
      resources: approved.resources.map((resource) =>
        resource.id === "sample-project"
          ? { ...resource, status: "failed", failureReason: "模拟 SHA256 不一致" }
          : resource
      )
    };
    const delegated = transition(awaitingAction, {
      type: "RESOLVE_DOWNLOAD_FAILURE",
      action: "delegate-agent-b"
    });
    const manifest = createResourceManifest(delegated);
    const failedResource = manifest.resources.find((resource) => resource.id === "sample-project");

    expect(manifest.handoff).toMatchObject({ ready: false });
    expect(failedResource).toBeDefined();
    expect(manifest.handoff.missingItems).toContain(failedResource!.name);
    expect(failedResource).toMatchObject({
      status: "failed",
      failureReason: "模拟 SHA256 不一致"
    });
  });
});
