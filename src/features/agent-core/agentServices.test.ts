import { describe, expect, it } from "vitest";
import { DefaultAgentPolicy, InMemoryAgentToolExecutor } from "./agentServices";
import { createInitialAgentState, transition } from "./machine";
import { ExtensibleAgentRouter } from "./router";
import { createSystemProfileToolOutput } from "./systemProfile";
import { confirmTaskPlanForTest } from "./taskPlanTestSupport";
import type { AgentAction, AgentState, HostSystemProfile } from "./types";

function createWaitingApprovalState(): AgentState {
  let state = createInitialAgentState();
  state = transition(state, { type: "SUBMIT_TASK", task: "准备 Windows AI 环境" });
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
  return transition(state, { type: "PLAN_GENERATED" });
}

function createApprovedState() {
  return transition(createWaitingApprovalState(), { type: "APPROVE_PLAN", revision: 1 });
}

function createExportingState(exportStatus: "pending" | "exporting" = "pending"): AgentState {
  const approved = createApprovedState();
  return {
    ...approved,
    phase: "exporting",
    activeResourceId: null,
    resources: approved.resources.map((resource) =>
      resource.selected ? { ...resource, status: "verified" } : resource
    ),
    workspace: {
      ...approved.workspace,
      exportStatus
    }
  };
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

  it("contains GitHub discovery to one read-only search before finish", () => {
    let state = transition(createInitialAgentState(), {
      type: "SUBMIT_TASK",
      task: "查找 GitHub 热门开源项目"
    });
    state = transition(state, new ExtensibleAgentRouter().route(state)!);
    state = confirmTaskPlanForTest(state);
    state = transition(state, {
      type: "ANSWER_CLARIFICATION",
      questionId: "github-created-window",
      answer: "最近 30 天新建"
    });
    state = transition(state, {
      type: "ANSWER_CLARIFICATION",
      questionId: "github-sort",
      answer: "按 Star 数"
    });
    const search: AgentAction = {
      actionId: "github-search",
      type: "call_tool",
      purpose: "查询公开仓库。",
      call: {
        callId: "github-search",
        name: "search_github_repositories",
        input: {
          mode: "discovery",
          keywords: "",
          createdWithinDays: 30,
          sort: "stars",
          limit: 10
        }
      }
    };
    const finish: AgentAction = {
      actionId: "github-finish",
      type: "finish",
      summary: "查询完成。"
    };
    const createPlan: AgentAction = {
      actionId: "github-plan",
      type: "create_plan",
      resourceIds: ["git"],
      explanation: "不应创建计划。"
    };

    expect(policy.evaluate(search, state).outcome).toBe("allow");
    expect(policy.evaluate(finish, state).outcome).toBe("deny");
    expect(policy.evaluate(createPlan, state).outcome).toBe("deny");

    const searched: AgentState = {
      ...state,
      agentRun: {
        ...state.agentRun,
        toolResults: [{
          callId: "github-search",
          tool: "search_github_repositories",
          status: "success",
          output: {},
          startedAt: "start",
          finishedAt: "finish"
        }]
      }
    };
    expect(policy.evaluate(search, searched).outcome).toBe("deny");
    expect(policy.evaluate(finish, searched).outcome).toBe("allow");
  });

  it("allows the inferred repository-name query and rejects a trending substitution", () => {
    let state = transition(createInitialAgentState(), {
      type: "SUBMIT_TASK",
      task: "帮我找一个 GitHub 上名叫 tau 的项目"
    });
    state = transition(state, new ExtensibleAgentRouter().route(state)!);
    state = confirmTaskPlanForTest(state);
    const namedSearch: AgentAction = {
      actionId: "github-name-search",
      type: "call_tool",
      purpose: "按仓库名称查询。",
      call: {
        callId: "github-name-search",
        name: "search_github_repositories",
        input: { mode: "name", query: "tau", limit: 10 }
      }
    };
    const substitutedDiscovery: AgentAction = {
      ...namedSearch,
      actionId: "github-wrong-search",
      call: {
        callId: "github-wrong-search",
        name: "search_github_repositories",
        input: {
          mode: "discovery",
          keywords: "",
          createdWithinDays: 30,
          sort: "stars",
          limit: 10
        }
      }
    };

    expect(state.phase).toBe("planning");
    expect(policy.evaluate(namedSearch, state).outcome).toBe("allow");
    expect(policy.evaluate(substitutedDiscovery, state)).toMatchObject({
      outcome: "deny",
      reason: "GitHub 搜索参数与用户已确认的检索意图不一致。"
    });
    expect(policy.evaluate(namedSearch, {
      ...state,
      phase: "clarifying"
    })).toMatchObject({
      outcome: "deny",
      reason: expect.stringContaining("当前阶段为 clarifying")
    });
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

  it("allows workspace export only for the verified current revision", () => {
    const exporting = createExportingState();
    const action: AgentAction = {
      actionId: "workspace-export",
      type: "call_tool",
      purpose: "Export the approved workspace.",
      call: {
        callId: "workspace-export",
        name: "export_workspace",
        input: { taskId: exporting.taskId, revision: exporting.revision }
      }
    };

    expect(policy.evaluate(action, exporting)).toMatchObject({
      outcome: "allow",
      risk: "medium"
    });
    expect(
      policy.evaluate(action, { ...exporting, approvedRevision: null })
    ).toMatchObject({ outcome: "deny", risk: "high" });
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

  it("returns a complete primary-resource bundle for a full-stack natural-language query", async () => {
    const state: AgentState = {
      ...createInitialAgentState(),
      phase: "planning",
      task: "帮我准备一个 Windows 下的 AI 开发环境",
      answers: {
        "primary-workload": "全栈 AI 应用"
      }
    };
    const result = await tools.execute(
      {
        callId: "fullstack-catalog",
        name: "search_trusted_catalog",
        input: {
          query: "Windows 11 AI development environment full stack"
        }
      },
      state
    );

    expect(result.status).toBe("success");
    expect(result.output).toEqual([
      expect.objectContaining({ id: "python-312" }),
      expect.objectContaining({ id: "vscode" }),
      expect.objectContaining({ id: "git" }),
      expect.objectContaining({ id: "node-lts" }),
      expect.objectContaining({ id: "sample-project" })
    ]);
    expect(
      (result.output as Array<{ sourceTrust: string }>).some(
        (resource) => resource.sourceTrust === "trusted-mirror"
      )
    ).toBe(false);
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

  it("keeps controlled downloads unavailable without an Electron bridge", async () => {
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

  it("executes an approved controlled download and validates the bridge output", async () => {
    const approved = createApprovedState();
    const activeResource = approved.resources.find(
      (resource) => resource.id === approved.activeResourceId
    )!;
    const toolsWithBridge = new InMemoryAgentToolExecutor(undefined, async ({ resourceId }) => ({
      ok: true,
      output: {
        resourceId,
        fileName: `${resourceId}.download`,
        urlHost: new URL(activeResource.download.url).host,
        bytesWritten: 7,
        sha256: activeResource.download.expectedSha256!,
        tempFilePath: `/tmp/${resourceId}.download`,
        elapsedMs: 1
      }
    }));
    const result = await toolsWithBridge.execute(
      {
        callId: "controlled-download",
        name: "controlled_download",
        input: { resourceId: activeResource.id }
      },
      approved
    );

    expect(result).toMatchObject({
      status: "success",
      tool: "controlled_download",
      output: {
        resourceId: activeResource.id,
        sha256: activeResource.download.expectedSha256,
        bytesWritten: 7
      }
    });
  });

  it("preserves structured controlled download failures from Electron", async () => {
    const approved = createApprovedState();
    const toolsWithBridge = new InMemoryAgentToolExecutor(undefined, async () => ({
      ok: false,
      error: {
        code: "CHECKSUM_MISMATCH",
        message: "下载文件 SHA256 与可信目录不一致。",
        retriable: true
      }
    }));
    const result = await toolsWithBridge.execute(
      {
        callId: "controlled-download-error",
        name: "controlled_download",
        input: { resourceId: approved.activeResourceId! }
      },
      approved
    );

    expect(result).toMatchObject({
      status: "error",
      tool: "controlled_download",
      error: { code: "CHECKSUM_MISMATCH", retriable: true }
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

  it("exports a verified approved workspace through the injected bridge", async () => {
    const exporting = createExportingState("exporting");
    const toolsWithExporter = new InMemoryAgentToolExecutor(
      undefined,
      undefined,
      async ({ taskId, revision }) => ({
        ok: true,
        output: {
          taskId,
          revision,
          rootPath: `/tmp/${taskId}/revision-${revision}`,
          generatedAt: "test-static",
          reusedExisting: false,
          files: [
            {
              relativePath: "resource-manifest.json",
              absolutePath: `/tmp/${taskId}/revision-${revision}/resource-manifest.json`,
              bytesWritten: 42,
              sha256: "a".repeat(64)
            }
          ]
        }
      })
    );
    const result = await toolsWithExporter.execute(
      {
        callId: "workspace-export",
        name: "export_workspace",
        input: { taskId: exporting.taskId, revision: exporting.revision }
      },
      exporting
    );

    expect(result).toMatchObject({
      status: "success",
      tool: "export_workspace",
      output: {
        taskId: exporting.taskId,
        revision: exporting.revision
      }
    });
  });
});
