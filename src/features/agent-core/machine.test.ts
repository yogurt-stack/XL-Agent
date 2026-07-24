import { describe, expect, it } from "vitest";
import { createInitialAgentState, transition } from "./machine";
import { createSystemProfileToolOutput } from "./systemProfile";
import type { AgentState, HostSystemProfile } from "./types";

const linuxHostProfile: HostSystemProfile = {
  platform: "linux",
  platformLabel: "Linux",
  architecture: "x64",
  release: "test-release",
  cpuCount: 8,
  totalMemoryGb: 16,
  defaultShell: "zsh",
  collectedBy: "electron-main",
  collectedAt: "test-static",
  privacy: {
    hostname: false,
    username: false,
    homeDirectory: false,
    environment: false,
    shellPath: false
  }
};

function createWaitingApprovalState(): AgentState {
  let state = createInitialAgentState();
  state = transition(state, { type: "SUBMIT_TASK", task: "准备 Windows AI 环境" });
  state = transition(state, { type: "ROUTE_RESOLVED", route: "windows-ai-development" });
  state = transition(state, {
    type: "ANSWER_CLARIFICATION",
    questionId: "primary-workload",
    answer: "全栈 AI 应用"
  });
  state = transition(state, {
    type: "ANSWER_CLARIFICATION",
    questionId: "mirror-policy",
    answer: "允许备用镜像"
  });
  return transition(state, { type: "PLAN_GENERATED" });
}

describe("agent state machine", () => {
  it("records sanitized host profile output while preserving the planning target", () => {
    const initial = createInitialAgentState();
    const profiled = transition(initial, {
      type: "MODEL_TOOL_COMPLETED",
      result: {
        callId: "profile",
        tool: "read_system_profile",
        status: "success",
        output: createSystemProfileToolOutput(linuxHostProfile),
        startedAt: "start",
        finishedAt: "finish"
      }
    });

    expect(profiled.systemProfile).toEqual(initial.systemProfile);
    expect(profiled.hostProfile).toEqual(linuxHostProfile);
    expect(profiled.agentRun.toolResults.at(-1)?.output).toMatchObject({
      hostProfile: linuxHostProfile,
      planningProfileSource: "locked-demo-target"
    });
  });

  it("binds approval to the current plan revision", () => {
    const waitingApproval = createWaitingApprovalState();

    expect(waitingApproval).toMatchObject({
      phase: "waiting_approval",
      revision: 1,
      approvedRevision: null
    });
    expect(waitingApproval.planValidation?.valid).toBe(true);

    const staleApproval = transition(waitingApproval, { type: "APPROVE_PLAN", revision: 0 });
    expect(staleApproval.phase).toBe("waiting_approval");
    expect(staleApproval.approvedRevision).toBeNull();
    expect(staleApproval.logs.at(-1)?.message).toContain("审批被拒绝");

    const approved = transition(staleApproval, { type: "APPROVE_PLAN", revision: 1 });
    expect(approved.phase).toBe("downloading");
    expect(approved.approvedRevision).toBe(1);
    expect(approved.activeResourceId).toBeTruthy();
  });

  it("does not let a new task replace an active download", () => {
    const approved = transition(createWaitingApprovalState(), { type: "APPROVE_PLAN", revision: 1 });

    const result = transition(approved, {
      type: "SUBMIT_TASK",
      task: "不应覆盖正在执行的任务"
    });

    expect(result).toBe(approved);
    expect(result.task).toBe("准备 Windows AI 环境");
  });

  it("creates a new approval revision when a required resource is replaced", () => {
    const waitingApproval = createWaitingApprovalState();
    const replanning = transition(waitingApproval, {
      type: "TOGGLE_RESOURCE",
      resourceId: "python-312",
      selected: false
    });

    expect(replanning).toMatchObject({
      phase: "replanning",
      revision: 1,
      replanReason: "required_resource_cancelled",
      requestedReplanStrategy: "trusted-mirror",
      approvedRevision: null
    });

    const mismatchedStrategy = transition(replanning, {
      type: "REPLAN_GENERATED",
      strategy: "primary-retry"
    });
    expect(mismatchedStrategy).toBe(replanning);

    const replacement = transition(replanning, {
      type: "REPLAN_GENERATED",
      strategy: "trusted-mirror"
    });
    expect(replacement).toMatchObject({
      phase: "waiting_approval",
      revision: 2,
      approvedRevision: null
    });
    expect(replacement.planValidation?.valid).toBe(true);
    expect(replacement.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "miniforge-py312", replacedFrom: "python-312" })
      ])
    );
  });

  it("pauses a recoverable failure until the user chooses a strategy", () => {
    const approved = transition(createWaitingApprovalState(), { type: "APPROVE_PLAN", revision: 1 });
    const activeResourceId = approved.activeResourceId;
    expect(activeResourceId).toBeTruthy();

    const failed = transition(approved, {
      type: "DOWNLOAD_FAILED",
      resourceId: activeResourceId!,
      reason: "模拟校验失败"
    });

    expect(failed).toMatchObject({
      phase: "awaiting_failure_action",
      revision: 1,
      requestedReplanStrategy: null,
      activeResourceId: null
    });

    const delegated = transition(failed, {
      type: "RESOLVE_DOWNLOAD_FAILURE",
      action: "delegate-agent-b"
    });
    expect(delegated.phase).toBe("handoff");
    expect(delegated.agentRun.status).toBe("delegated");
    expect(delegated.workspace.ready).toBe(false);
  });

  it("requires fresh approval for export and resumes without an empty download queue", () => {
    const approved = transition(createWaitingApprovalState(), {
      type: "APPROVE_PLAN",
      revision: 1
    });
    const exporting: AgentState = {
      ...approved,
      phase: "exporting",
      activeResourceId: null,
      resources: approved.resources.map((resource) =>
        resource.selected ? { ...resource, status: "verified" } : resource
      ),
      workspace: {
        ...approved.workspace,
        exportStatus: "pending"
      }
    };

    const expired = transition(exporting, {
      type: "DOWNLOAD_APPROVAL_EXPIRED",
      reason: "工作区导出审批已过期。"
    });
    expect(expired).toMatchObject({
      phase: "waiting_approval",
      approvedRevision: null,
      activeResourceId: null,
      workspace: { ready: false, exportStatus: "pending" }
    });

    const reapproved = transition(expired, {
      type: "APPROVE_PLAN",
      revision: 1
    });
    expect(reapproved).toMatchObject({
      phase: "exporting",
      approvedRevision: 1,
      activeResourceId: null,
      workspace: { exportStatus: "pending" }
    });
  });
});
