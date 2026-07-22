import { describe, expect, it } from "vitest";
import { DefaultAgentPolicy, InMemoryAgentToolExecutor } from "./agentServices";
import { createInitialAgentState, transition } from "./machine";
import { createSystemProfileToolOutput } from "./systemProfile";
import type { AgentAction, AgentState, HostSystemProfile } from "./types";

function createWaitingApprovalState(): AgentState {
  let state = createInitialAgentState();
  state = transition(state, { type: "SUBMIT_TASK", task: "准备 Windows AI 环境" });
  state = transition(state, { type: "ROUTE_RESOLVED", route: "windows-ai-development" });
  state = transition(state, {
    type: "ANSWER_CLARIFICATION",
    questionId: "primary-workload",
    answer: "Python AI 开发"
  });
  state = transition(state, {
    type: "SKIP_CLARIFICATION",
    questionId: "mirror-policy"
  });
  return transition(state, { type: "PLAN_GENERATED" });
}

function createApprovedState() {
  return transition(createWaitingApprovalState(), { type: "APPROVE_PLAN", revision: 1 });
}

describe("default agent policy", () => {
  const policy = new DefaultAgentPolicy();

  it("requires approval for plans and matching replans", () => {
    const createPlan: AgentAction = {
      actionId: "create-plan",
      type: "create_plan",
      resourceIds: ["python-312", "vscode", "git", "sample-project"],
      explanation: "Create a trusted plan."
    };
    expect(policy.evaluate(createPlan, createInitialAgentState())).toMatchObject({
      outcome: "require_approval",
      approvalId: "plan-r1"
    });

    const replanningState: AgentState = {
      ...createWaitingApprovalState(),
      phase: "replanning",
      requestedReplanStrategy: "trusted-mirror"
    };
    const matchingReplan: AgentAction = {
      actionId: "matching-replan",
      type: "create_replan",
      strategy: "trusted-mirror",
      explanation: "Use the requested trusted mirror."
    };
    const mismatchedReplan: AgentAction = {
      ...matchingReplan,
      actionId: "mismatched-replan",
      strategy: "primary-retry"
    };

    expect(policy.evaluate(matchingReplan, replanningState).outcome).toBe("require_approval");
    expect(policy.evaluate(mismatchedReplan, replanningState).outcome).toBe("deny");
  });

  it("allows read-only tools and rejects downloads without current approval", () => {
    const readProfile: AgentAction = {
      actionId: "read-profile",
      type: "call_tool",
      purpose: "Read the target profile.",
      call: { callId: "read-profile", name: "read_system_profile", input: {} }
    };
    const download: AgentAction = {
      actionId: "download",
      type: "call_tool",
      purpose: "Download an approved resource.",
      call: {
        callId: "download",
        name: "simulate_download",
        input: { resourceId: "python-312" }
      }
    };

    expect(policy.evaluate(readProfile, createInitialAgentState()).outcome).toBe("allow");
    expect(policy.evaluate(download, createWaitingApprovalState()).outcome).toBe("deny");

    const approved = createApprovedState();
    const activeDownload: AgentAction = {
      ...download,
      call: {
        ...download.call,
        name: "simulate_download",
        input: { resourceId: approved.activeResourceId! }
      }
    };
    expect(policy.evaluate(activeDownload, approved).outcome).toBe("allow");
    expect(policy.evaluate(activeDownload, { ...approved, approvedRevision: null }).outcome).toBe("deny");
  });

  it("allows controlled downloads only after approval and trusted HTTPS catalog host validation", () => {
    const approved = createApprovedState();
    const controlledDownload: AgentAction = {
      actionId: "controlled-download",
      type: "call_tool",
      purpose: "Download an approved resource through the controlled main-process downloader.",
      call: {
        callId: "controlled-download",
        name: "controlled_download",
        input: { resourceId: approved.activeResourceId! }
      }
    };

    expect(policy.evaluate(controlledDownload, createWaitingApprovalState()).outcome).toBe("deny");
    expect(policy.evaluate(controlledDownload, approved)).toMatchObject({
      outcome: "allow",
      risk: "medium"
    });

    const untrustedHostState: AgentState = {
      ...approved,
      resources: approved.resources.map((resource) =>
        resource.id === approved.activeResourceId
          ? {
              ...resource,
              download: {
                ...resource.download,
                url: "https://evil.example/windows-ai-dev/python.exe"
              }
            }
          : resource
      )
    };

    expect(policy.evaluate(controlledDownload, untrustedHostState)).toMatchObject({
      outcome: "deny",
      risk: "high"
    });
  });
});

describe("in-memory agent tool executor", () => {
  const tools = new InMemoryAgentToolExecutor();
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

  it("returns the system profile and filters the trusted catalog", async () => {
    const state = createInitialAgentState();
    const profile = await tools.execute(
      { callId: "profile", name: "read_system_profile", input: {} },
      state
    );
    const catalog = await tools.execute(
      {
        callId: "catalog",
        name: "search_trusted_catalog",
        input: { query: "", resourceIds: ["git", "vscode"] }
      },
      state
    );

    expect(profile).toMatchObject({
      status: "success",
      output: {
        targetProfile: state.systemProfile,
        planningProfileSource: "locked-demo-target",
        hostProfile: { collectedBy: "renderer-fallback" }
      }
    });
    expect(catalog.status).toBe("success");
    expect(catalog.output).toEqual([
      expect.objectContaining({ id: "vscode" }),
      expect.objectContaining({ id: "git" })
    ]);
  });

  it("uses an injected host profile reader without changing the locked target profile", async () => {
    const state = createInitialAgentState();
    const injectedTools = new InMemoryAgentToolExecutor(() => createSystemProfileToolOutput(linuxHostProfile));
    const result = await injectedTools.execute(
      { callId: "profile", name: "read_system_profile", input: {} },
      state
    );

    expect(result).toMatchObject({
      status: "success",
      output: {
        targetProfile: state.systemProfile,
        hostProfile: linuxHostProfile,
        planningProfileSource: "locked-demo-target"
      }
    });
  });

  it("rejects unapproved downloads and advances an approved active resource", async () => {
    const waitingApproval = createWaitingApprovalState();
    const rejected = await tools.execute(
      {
        callId: "rejected-download",
        name: "simulate_download",
        input: { resourceId: "python-312" }
      },
      waitingApproval
    );
    expect(rejected).toMatchObject({
      status: "error",
      error: { code: "RESOURCE_NOT_APPROVED", retriable: false }
    });

    const approved = createApprovedState();
    const accepted = await tools.execute(
      {
        callId: "accepted-download",
        name: "simulate_download",
        input: { resourceId: approved.activeResourceId! }
      },
      approved
    );
    expect(accepted).toMatchObject({
      status: "success",
      output: { resourceId: approved.activeResourceId, progress: 25 }
    });
  });

  it("keeps controlled downloads unavailable until renderer workflow integration", async () => {
    const approved = createApprovedState();
    const result = await tools.execute(
      {
        callId: "controlled-download",
        name: "controlled_download",
        input: { resourceId: approved.activeResourceId! }
      },
      approved
    );

    expect(result).toMatchObject({
      status: "error",
      error: { code: "CONTROLLED_DOWNLOAD_UNAVAILABLE", retriable: false }
    });
  });

  it("returns a retriable checksum error for the first sample project failure", async () => {
    const approved = createApprovedState();
    const sampleProjectState: AgentState = {
      ...approved,
      activeResourceId: "sample-project",
      resources: approved.resources.map((resource) =>
        resource.id === "sample-project"
          ? { ...resource, status: "downloading", progress: 56, attempts: 1 }
          : resource
      )
    };

    const result = await tools.execute(
      {
        callId: "sample-project-failure",
        name: "simulate_download",
        input: { resourceId: "sample-project" }
      },
      sampleProjectState
    );

    expect(result).toMatchObject({
      status: "error",
      error: { code: "CHECKSUM_MISMATCH", retriable: true }
    });
  });
});
