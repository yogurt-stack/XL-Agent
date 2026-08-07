import { describe, expect, it, vi } from "vitest";
import {
  DefaultAgentPolicy,
  InMemoryAgentToolExecutor
} from "./agentServices";
import type {
  AgentAssistantTurn,
  AgentTurnContext
} from "./agentLoop";
import type {
  AgentScheduler,
  AgentToolExecutionOptions,
  ModelRuntime
} from "./interfaces";
import { LocalRuleModelRuntime } from "./localRuleModel";
import { FixedWindowsPlanner, MockVerifier } from "./mockServices";
import { ExtensibleAgentRouter } from "./router";
import { AgentRuntime } from "./runtime";
import { analyzeProjectRequirementFiles } from "./projectRequirements";
import type {
  AgentState,
  AgentToolCall,
  AgentToolName,
  TaskPlanProposal
} from "./types";

type ScheduledJob = () => void | Promise<void>;

function queuedScheduler() {
  const jobs: ScheduledJob[] = [];
  const scheduler: AgentScheduler = {
    schedule(job) {
      jobs.push(job);
      return () => {
        const index = jobs.indexOf(job);
        if (index >= 0) jobs.splice(index, 1);
      };
    }
  };
  return { jobs, scheduler };
}

async function runNext(jobs: ScheduledJob[], runtime: AgentRuntime) {
  const job = jobs.shift();
  if (!job) {
    throw new Error(`Runtime stalled at ${runtime.getState().phase}.`);
  }
  await job();
}

async function runUntil(
  jobs: ScheduledJob[],
  runtime: AgentRuntime,
  predicate: (state: AgentState) => boolean,
  limit = 20
) {
  for (let index = 0; index < limit && !predicate(runtime.getState()); index += 1) {
    await runNext(jobs, runtime);
  }
  if (!predicate(runtime.getState())) {
    throw new Error(`Runtime did not reach the expected state from ${runtime.getState().phase}.`);
  }
}

function compatibilityTurnModel(
  contexts: AgentTurnContext<AgentToolName, unknown, TaskPlanProposal>[]
): ModelRuntime {
  const planner = new LocalRuleModelRuntime();
  return {
    decide: (context) => planner.decide(context),
    async generateTurn(context) {
      contexts.push(structuredClone(context));
      if (context.turn === 1) {
        return {
          turnId: "compatibility-turn-1",
          rationaleSummary: "先读取本机环境，再判断 PyTorch 兼容性。",
          action: {
            type: "tool_calls",
            calls: [{
              callId: "inspect-local-environment-1",
              name: "inspect_local_development_environment",
              input: {},
              risk: "read_only"
            }]
          }
        };
      }
      return {
        turnId: "compatibility-turn-2",
        rationaleSummary: "已读取只读探测结果，可以交付有证据的评估。",
        action: {
          type: "complete_step",
          summary: "PyTorch 本机环境兼容性评估完成。",
          output: {
            overallCompatibility: "unresolved",
            observedTools: [{
              toolId: "python3",
              status: "available",
              observedVersion: "Python 3.12.4",
              observedDetail: null
            }, {
              toolId: "cuda-compiler",
              status: "not_found",
              observedVersion: null,
              observedDetail: null
            }],
            unresolved: ["PyTorch wheel 与 Python 3.12 的具体版本匹配"]
          },
          evidence: [{
            source: "inspect_local_development_environment",
            reference: "tool-result:inspect-local-environment-1"
          }]
        }
      };
    }
  };
}

describe("AgentRuntime TaskPlan analysis AgentLoop", () => {
  it("runs repository understanding, requirement extraction and local comparison as one read-only loop", async () => {
    const { jobs, scheduler } = queuedScheduler();
    const repositoryHandleId = "local-repo-runtimefixture";
    const commitSha = "a".repeat(40);
    const project = analyzeProjectRequirementFiles({
      repository: {
        repositoryHandleId,
        displayName: "runtime-fixture",
        commitSha
      },
      files: [{
        relativePath: "package.json",
        objectId: "b".repeat(40),
        content: JSON.stringify({ engines: { node: ">=20" } }),
        bytesRead: 35,
        truncated: false
      }]
    });
    const localTools = {
      listTree: async () => ({
        repository: {
          repositoryHandleId,
          displayName: "runtime-fixture",
          commitSha
        },
        pathPrefix: "",
        entries: [{
          relativePath: "package.json",
          objectId: "b".repeat(40),
          bytes: 35
        }],
        totalMatchingEntries: 1,
        truncated: false,
        boundary: "fixed-head-tracked-files-only" as const
      }),
      readFile: async () => ({
        repository: { repositoryHandleId, commitSha },
        relativePath: "package.json",
        objectId: "b".repeat(40),
        content: JSON.stringify({ engines: { node: ">=20" } }),
        bytes: 35,
        truncated: false,
        trust: "untrusted-repository-content" as const,
        boundary: "fixed-head-text-evidence-only" as const
      }),
      inspectRequirements: async () => project
    };
    const tools = new InMemoryAgentToolExecutor(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({
        host: { platform: "darwin", architecture: "arm64" },
        tools: [{
          id: "node",
          name: "Node.js",
          command: "node",
          status: "available",
          version: "v22.1.0",
          detail: null
        }],
        collectedAt: "2026-08-07T00:00:00.000Z",
        source: "electron-main-fixed-command-allowlist",
        boundary: "read-only-fixed-command-allowlist"
      }),
      localTools
    );
    const runtime = new AgentRuntime({
      router: new ExtensibleAgentRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler,
      model: new LocalRuleModelRuntime(),
      tools,
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0,
      createTaskId: () => "runtime-project-compatibility"
    });
    runtime.start();
    runtime.reportExternalEvent({
      type: "LOCAL_REPOSITORY_IMPORTED",
      taskId: "import-task",
      repository: {
        repositoryHandleId,
        displayName: "runtime-fixture",
        fingerprint: "f".repeat(64),
        commitSha,
        branch: "main",
        detached: false,
        clean: true,
        status: {
          modified: 0,
          deleted: 0,
          untracked: 0,
          conflicted: 0,
          ahead: 0,
          behind: 0
        },
        fileCount: 1,
        trackedFileCount: 1,
        hasSubmodules: false,
        hasSymlinks: false,
        inspectedAt: "2026-08-07T00:00:00.000Z",
        analysis: {
          ecosystems: ["node"],
          manifests: ["package.json"],
          lockfiles: [],
          runtimeHints: ["Node.js"],
          nodeOfflinePreparation: "lockfile-unsupported",
          nodeOfflinePackageCount: 0,
          nodeOfflineBlockers: [],
          treeTruncated: false
        }
      }
    });
    runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "分析当前项目的运行要求，并告诉我本机还缺什么"
    });
    await runUntil(
      jobs,
      runtime,
      (state) => state.phase === "waiting_task_plan_confirmation",
      30
    );
    runtime.dispatch({ type: "CONFIRM_TASK_PLAN", revision: 1 });
    await runUntil(jobs, runtime, (state) => state.phase === "result", 40);

    expect(runtime.getState()).toMatchObject({
      phase: "result",
      resources: [],
      taskPlan: {
        status: "completed",
        steps: [{
          id: "analyze-local-project-environment",
          status: "completed",
          result: {
            summary: expect.stringContaining("1 项满足")
          }
        }, {
          id: "present-local-project-environment-assessment",
          status: "completed"
        }]
      },
      agentRun: {
        agentLoop: {
          status: "completed",
          usage: { turns: 4, toolCalls: 3, executedToolCalls: 3 }
        }
      }
    });
    expect(runtime.getState().agentRun.toolResults.map((result) => result.tool))
      .toEqual([
        "list_local_repository_tree",
        "inspect_project_requirements",
        "inspect_local_development_environment"
      ]);
  });

  it("runs fixed GitHub Tree requirement extraction and local comparison without downloading", async () => {
    const { jobs, scheduler } = queuedScheduler();
    const repositoryHandleId = "github-repo-runtimefixture";
    const commitSha = "a".repeat(40);
    const project = analyzeProjectRequirementFiles({
      repository: {
        repositoryHandleId,
        displayName: "owner/runtime-fixture",
        commitSha
      },
      files: [{
        relativePath: "package.json",
        objectId: "b".repeat(40),
        content: JSON.stringify({ engines: { node: ">=20" } }),
        bytesRead: 35,
        truncated: false
      }]
    });
    const githubTools = {
      listTree: async () => ({
        repository: {
          repositoryHandleId,
          displayName: "owner/runtime-fixture",
          commitSha
        },
        pathPrefix: "",
        entries: [{
          relativePath: "package.json",
          objectId: "b".repeat(40),
          bytes: 35
        }],
        totalMatchingEntries: 1,
        truncated: false,
        boundary: "fixed-commit-github-blobs-only" as const
      }),
      readFile: async () => ({
        repository: { repositoryHandleId, commitSha },
        relativePath: "package.json",
        objectId: "b".repeat(40),
        content: JSON.stringify({ engines: { node: ">=20" } }),
        bytes: 35,
        truncated: false,
        trust: "untrusted-repository-content" as const,
        boundary: "fixed-commit-github-text-evidence-only" as const
      }),
      inspectRequirements: async () => project
    };
    const tools = new InMemoryAgentToolExecutor(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({
        host: { platform: "darwin", architecture: "arm64" },
        tools: [{
          id: "node",
          name: "Node.js",
          command: "node",
          status: "available",
          version: "v22.1.0",
          detail: null
        }],
        collectedAt: "2026-08-07T00:00:00.000Z",
        source: "electron-main-fixed-command-allowlist",
        boundary: "read-only-fixed-command-allowlist"
      }),
      undefined,
      githubTools
    );
    const runtime = new AgentRuntime({
      router: new ExtensibleAgentRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler,
      model: new LocalRuleModelRuntime(),
      tools,
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0,
      createTaskId: () => "runtime-github-project-compatibility"
    });
    runtime.start();
    runtime.reportExternalEvent({
      type: "GITHUB_REPOSITORY_ANALYSIS_ATTACHED",
      taskId: "github-analysis-task",
      repository: {
        repositoryHandleId,
        fullName: "owner/runtime-fixture",
        displayName: "owner/runtime-fixture",
        defaultBranch: "main",
        commitSha,
        treeSha: "c".repeat(40),
        trackedFileCount: 1,
        treeTruncated: false,
        inspectedAt: "2026-08-07T00:00:00.000Z",
        analysis: {
          ecosystems: ["node"],
          manifests: ["package.json"],
          lockfiles: [],
          runtimeHints: ["Node.js"],
          nodeOfflinePreparation: "lockfile-unsupported",
          nodeOfflinePackageCount: 0,
          nodeOfflineBlockers: [],
          treeTruncated: false
        }
      }
    });
    await runUntil(
      jobs,
      runtime,
      (state) => state.phase === "waiting_task_plan_confirmation",
      30
    );
    runtime.dispatch({ type: "CONFIRM_TASK_PLAN", revision: 1 });
    await runUntil(jobs, runtime, (state) => state.phase === "result", 40);

    expect(runtime.getState()).toMatchObject({
      phase: "result",
      resources: [],
      githubRepository: {
        fullName: "owner/runtime-fixture",
        commitSha
      },
      taskPlan: {
        status: "completed",
        steps: [{
          id: "analyze-github-project-environment",
          status: "completed",
          result: { summary: expect.stringContaining("1 项满足") }
        }, {
          id: "present-github-project-environment-assessment",
          status: "completed"
        }]
      }
    });
    expect(runtime.getState().agentRun.toolResults.map((result) => result.tool))
      .toEqual([
        "list_github_repository_tree",
        "inspect_github_project_requirements",
        "inspect_local_development_environment"
      ]);
  });

  it("feeds the approved read-only observation into turn 2 and completes without write tools", async () => {
    const { jobs, scheduler } = queuedScheduler();
    const contexts: AgentTurnContext<
      AgentToolName,
      unknown,
      TaskPlanProposal
    >[] = [];
    const executedTools: AgentToolName[] = [];
    const delegate = new InMemoryAgentToolExecutor(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({
        host: { platform: "darwin", architecture: "arm64" },
        tools: [{
          id: "python3",
          name: "Python 3",
          command: "python3",
          status: "available",
          version: "Python 3.12.4",
          detail: null
        }, {
          id: "cuda-compiler",
          name: "CUDA Compiler",
          command: "nvcc",
          status: "not_found",
          version: null,
          detail: null
        }],
        collectedAt: "2026-08-07T00:00:00.000Z",
        source: "electron-main-fixed-command-allowlist",
        boundary: "read-only-fixed-command-allowlist"
      })
    );
    const execute = vi.fn(async (...args: Parameters<typeof delegate.execute>) => {
      executedTools.push(args[0].name);
      return delegate.execute(...args);
    });
    const runtime = new AgentRuntime({
      router: new ExtensibleAgentRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler,
      model: compatibilityTurnModel(contexts),
      tools: { execute },
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0,
      createTaskId: () => "runtime-agent-loop-compatibility"
    });
    let completedSnapshot: AgentState | null = null;
    const unsubscribe = runtime.subscribe((state) => {
      if (
        state.agentRun.agentLoop?.status === "completed" &&
        state.taskPlan?.steps[0]?.status === "running"
      ) {
        completedSnapshot = structuredClone(state);
      }
    });

    runtime.start();
    runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "我想在本地使用 PyTorch，帮我查询本地环境的匹配程度，哪些已具备，哪些缺少"
    });
    await runUntil(
      jobs,
      runtime,
      (state) => state.phase === "waiting_task_plan_confirmation"
    );

    expect(runtime.getState().taskPlan?.steps[0]).toMatchObject({
      id: "assess-local-environment-compatibility",
      kind: "analysis",
      execution: {
        mode: "agent_loop",
        allowedTools: ["inspect_local_development_environment"],
        maxRisk: "read_only"
      }
    });

    runtime.dispatch({ type: "CONFIRM_TASK_PLAN", revision: 1 });
    await runUntil(jobs, runtime, (state) => state.phase === "result");

    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toMatchObject({
      turn: 1,
      availableTools: [{
        name: "inspect_local_development_environment",
        risk: "read_only"
      }]
    });
    expect(contexts[1].turn).toBe(2);
    expect(contexts[1].transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "toolResult",
        callId: "inspect-local-environment-1",
        tool: "inspect_local_development_environment",
        status: "success",
        output: expect.objectContaining({
          tools: expect.arrayContaining([
            expect.objectContaining({ id: "python3", version: "Python 3.12.4" })
          ])
        })
      })
    ]));
    expect(executedTools).toEqual(["inspect_local_development_environment"]);
    expect(executedTools).not.toEqual(expect.arrayContaining([
      "controlled_download",
      "simulate_download",
      "export_workspace"
    ]));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runtime.getState()).toMatchObject({
      phase: "result",
      resources: [],
      taskPlan: {
        status: "completed",
        steps: [{
          id: "assess-local-environment-compatibility",
          status: "completed",
          result: {
            summary: expect.stringContaining("整体兼容性仍无法确认")
          }
        }, {
          id: "present-local-environment-assessment",
          status: "completed"
        }]
      },
      agentRun: {
        status: "complete",
        agentLoop: {
          status: "completed",
          usage: { turns: 2, toolCalls: 1, executedToolCalls: 1 }
        }
      }
    });
    unsubscribe();

    expect(completedSnapshot).not.toBeNull();
    const recovery = queuedScheduler();
    const recoveredGenerateTurn = vi.fn();
    const recoveredExecute = vi.fn();
    const recovered = new AgentRuntime({
      router: new ExtensibleAgentRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler: recovery.scheduler,
      model: {
        decide: (context) => new LocalRuleModelRuntime().decide(context),
        generateTurn: recoveredGenerateTurn
      },
      tools: { execute: recoveredExecute },
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0
    });
    recovered.dispatch({
      type: "TASK_STATE_RESTORED",
      state: completedSnapshot!,
      approvalValid: true
    });
    recovered.start();
    await runUntil(
      recovery.jobs,
      recovered,
      (state) => state.phase === "cancelled"
    );
    expect(recoveredGenerateTurn).not.toHaveBeenCalled();
    expect(recoveredExecute).not.toHaveBeenCalled();
    expect(recovered.getState().logs.some((entry) =>
      entry.message.includes("可信 checkpoint")
    )).toBe(true);
  });

  it("aborts an in-flight loop on cancellation and never executes its requested tool", async () => {
    const { jobs, scheduler } = queuedScheduler();
    const planner = new LocalRuleModelRuntime();
    let notifyTurnStarted!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      notifyTurnStarted = resolve;
    });
    const model: ModelRuntime = {
      decide: (context) => planner.decide(context),
      generateTurn: (_context, signal) => new Promise<AgentAssistantTurn<
        AgentToolName,
        unknown,
        TaskPlanProposal
      >>((resolve, reject) => {
        notifyTurnStarted();
        signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      })
    };
    const execute = vi.fn();
    const runtime = new AgentRuntime({
      router: new ExtensibleAgentRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler,
      model,
      tools: { execute },
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0,
      createTaskId: () => "runtime-agent-loop-cancellation"
    });

    runtime.start();
    runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "我想在本地使用 PyTorch，帮我查询本地环境的匹配程度"
    });
    await runUntil(
      jobs,
      runtime,
      (state) => state.phase === "waiting_task_plan_confirmation"
    );
    runtime.dispatch({ type: "CONFIRM_TASK_PLAN", revision: 1 });
    await runNext(jobs, runtime); // start analysis step
    const loopJob = jobs.shift();
    if (!loopJob) throw new Error("Agent Loop was not scheduled.");
    const pendingLoop = loopJob();
    await turnStarted;

    runtime.dispatch({
      type: "CANCEL_TASK",
      cancelledAt: "2026-08-07T00:00:01.000Z"
    });
    await pendingLoop;

    expect(runtime.getState()).toMatchObject({
      phase: "cancelled",
      taskPlan: { status: "cancelled" }
    });
    expect(execute).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
  });

  it("propagates cancellation into an in-flight runtime tool", async () => {
    const { jobs, scheduler } = queuedScheduler();
    const planner = new LocalRuleModelRuntime();
    let notifyToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      notifyToolStarted = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const execute = vi.fn((
      _call: AgentToolCall,
      _state: AgentState,
      options?: AgentToolExecutionOptions
    ) => new Promise<never>((_resolve, reject) => {
      receivedSignal = options?.signal;
      notifyToolStarted();
      options?.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    }));
    const model: ModelRuntime = {
      decide: (context) => planner.decide(context),
      async generateTurn() {
        return {
          turnId: "tool-cancellation-turn",
          rationaleSummary: "先执行已授权的只读环境探测。",
          action: {
            type: "tool_calls",
            calls: [{
              callId: "tool-cancellation-inspection",
              name: "inspect_local_development_environment",
              input: {},
              risk: "read_only"
            }]
          }
        };
      }
    };
    const runtime = new AgentRuntime({
      router: new ExtensibleAgentRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler,
      model,
      tools: { execute },
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0,
      createTaskId: () => "runtime-agent-loop-tool-cancellation"
    });

    runtime.start();
    runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "我想在本地使用 PyTorch，帮我查询本地环境的匹配程度"
    });
    await runUntil(
      jobs,
      runtime,
      (state) => state.phase === "waiting_task_plan_confirmation"
    );
    runtime.dispatch({ type: "CONFIRM_TASK_PLAN", revision: 1 });
    await runNext(jobs, runtime);
    const loopJob = jobs.shift();
    if (!loopJob) throw new Error("Agent Loop was not scheduled.");
    const pendingLoop = loopJob();
    await toolStarted;

    runtime.dispatch({
      type: "CANCEL_TASK",
      cancelledAt: "2026-08-07T00:00:01.000Z"
    });
    await pendingLoop;

    expect(receivedSignal?.aborted).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runtime.getState().phase).toBe("cancelled");
    expect(runtime.getState().agentRun.toolResults).toHaveLength(0);
  });

  it("fails safe instead of replaying a persisted loop interrupted mid-turn", async () => {
    const first = queuedScheduler();
    const planner = new LocalRuleModelRuntime();
    const original = new AgentRuntime({
      router: new ExtensibleAgentRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler: first.scheduler,
      model: planner,
      tools: new InMemoryAgentToolExecutor(),
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0,
      createTaskId: () => "runtime-agent-loop-interrupted"
    });
    original.start();
    original.dispatch({
      type: "SUBMIT_TASK",
      task: "我想在本地使用 PyTorch，帮我查询本地环境的匹配程度"
    });
    await runUntil(
      first.jobs,
      original,
      (state) => state.phase === "waiting_task_plan_confirmation"
    );
    original.dispatch({ type: "CONFIRM_TASK_PLAN", revision: 1 });
    await runUntil(
      first.jobs,
      original,
      (state) => state.taskPlan?.steps[0]?.status === "running"
    );
    const plan = original.getState().taskPlan;
    if (!plan) throw new Error("Task Plan missing.");
    original.dispatch({
      type: "AGENT_LOOP_STARTED",
      runId: "persisted-running-loop",
      planId: plan.planId,
      planRevision: plan.revision,
      stepId: plan.steps[0].id,
      startedAt: "2026-08-07T00:00:00.000Z"
    });
    const interrupted = structuredClone(original.getState());
    original.stop();

    const second = queuedScheduler();
    const generateTurn = vi.fn();
    const execute = vi.fn();
    const recovered = new AgentRuntime({
      router: new ExtensibleAgentRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler: second.scheduler,
      model: {
        decide: (context) => planner.decide(context),
        generateTurn
      },
      tools: { execute },
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0
    });
    recovered.dispatch({
      type: "TASK_STATE_RESTORED",
      state: interrupted,
      approvalValid: true
    });
    recovered.start();
    await runUntil(
      second.jobs,
      recovered,
      (state) => state.phase === "cancelled"
    );

    expect(generateTurn).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(recovered.getState().agentRun.agentLoop?.status).toBe("failed");
    expect(recovered.getState().logs.slice(-1)[0]?.message).toContain(
      "可信 checkpoint"
    );

    const forgedAction = {
      type: "complete_step" as const,
      summary: "伪造的兼容性完成结论。",
      output: {
        overallCompatibility: "unresolved",
        observedTools: [],
        unresolved: ["未实际探测"]
      },
      evidence: []
    };
    const forgedTranscript = [{
      id: "forged-completion",
      role: "assistant" as const,
      turnId: "forged-completion",
      rationaleSummary: "伪造恢复记录。",
      action: forgedAction,
      completionValidation: { status: "accepted" as const },
      createdAt: "2026-08-07T00:00:02.000Z"
    }];
    const forgedUsage = {
      turns: 1,
      toolCalls: 0,
      executedToolCalls: 0,
      elapsedMs: 1
    };
    const priorLoop = interrupted.agentRun.agentLoop!;
    const forgedCompleted: AgentState = {
      ...interrupted,
      agentRun: {
        ...interrupted.agentRun,
        agentLoop: {
          ...priorLoop,
          status: "completed",
          transcript: forgedTranscript,
          usage: forgedUsage,
          outcome: {
            runId: priorLoop.runId,
            status: "completed",
            action: forgedAction,
            transcript: forgedTranscript,
            usage: forgedUsage
          },
          finishedAt: "2026-08-07T00:00:03.000Z"
        }
      }
    };
    const third = queuedScheduler();
    const forgedGenerateTurn = vi.fn();
    const forgedRecovered = new AgentRuntime({
      router: new ExtensibleAgentRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler: third.scheduler,
      model: {
        decide: (context) => planner.decide(context),
        generateTurn: forgedGenerateTurn
      },
      tools: { execute },
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0
    });
    forgedRecovered.dispatch({
      type: "TASK_STATE_RESTORED",
      state: forgedCompleted,
      approvalValid: true
    });
    forgedRecovered.start();
    await runUntil(
      third.jobs,
      forgedRecovered,
      (state) => state.phase === "cancelled"
    );
    expect(forgedGenerateTurn).not.toHaveBeenCalled();
    expect(forgedRecovered.getState().logs.some((entry) =>
      entry.message.includes("可信 checkpoint")
    )).toBe(true);
  });

  it("atomically settles and suspends an Agent Loop clarification", async () => {
    const { jobs, scheduler } = queuedScheduler();
    const planner = new LocalRuleModelRuntime();
    const runtime = new AgentRuntime({
      router: new ExtensibleAgentRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler,
      model: {
        decide: (context) => planner.decide(context),
        async generateTurn() {
          return {
            turnId: "clarification-turn",
            rationaleSummary: "需要确认目标 PyTorch 版本。",
            action: {
              type: "ask_clarification",
              questionId: "target-pytorch-version",
              question: "目标 PyTorch 版本是什么？",
              reason: "当前只读工具无法推导用户的目标版本。",
              required: true
            }
          };
        }
      },
      tools: { execute: vi.fn() },
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0
    });
    runtime.start();
    runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "检查 PyTorch 本机环境匹配程度"
    });
    await runUntil(
      jobs,
      runtime,
      (state) => state.phase === "waiting_task_plan_confirmation"
    );
    runtime.dispatch({ type: "CONFIRM_TASK_PLAN", revision: 1 });
    await runUntil(jobs, runtime, (state) => state.phase === "clarifying");

    expect(runtime.getState()).toMatchObject({
      phase: "clarifying",
      clarifications: [{ id: "target-pytorch-version" }],
      agentRun: {
        agentLoop: {
          status: "waiting_user_input",
          outcome: { status: "waiting_user_input" }
        }
      }
    });
    expect(runtime.getState().taskPlan?.steps[0]?.status).toBe(
      "waiting_user_input"
    );
  });

  it("turns an out-of-envelope request into a newly confirmable TaskPlan revision", async () => {
    const { jobs, scheduler } = queuedScheduler();
    const planner = new LocalRuleModelRuntime();
    const revisedProposal: TaskPlanProposal = {
      objective: "在用户确认的新范围内重新盘点环境。",
      deliverables: ["新的只读环境盘点结果"],
      assumptions: ["尚未获得任何下载或写入授权。"],
      constraints: ["只允许执行固定白名单只读探测。"],
      steps: [{
        id: "inspect-revised-environment",
        title: "重新盘点环境",
        description: "执行固定白名单只读探测。",
        kind: "read_tool",
        tool: "inspect_local_development_environment",
        dependsOn: [],
        staticInput: {},
        inputBindings: {},
        expectedOutput: "本机工具版本清单",
        risk: "read_only",
        approval: { required: false, reason: null }
      }, {
        id: "present-revised-assessment",
        title: "交付修订后的结论",
        description: "展示新的只读评估结果。",
        kind: "handoff",
        tool: null,
        dependsOn: ["inspect-revised-environment"],
        staticInput: {},
        inputBindings: {},
        expectedOutput: "修订后的评估报告",
        risk: "read_only",
        approval: { required: false, reason: null }
      }],
      confirmation: {
        required: true,
        reason: "执行范围已经变化，需要重新确认。"
      }
    };
    const model: ModelRuntime = {
      decide: (context) => planner.decide(context),
      async generateTurn() {
        return {
          turnId: "propose-revision-turn",
          rationaleSummary: "当前能力范围不足，只提出计划修订，不执行新增动作。",
          action: {
            type: "propose_plan_revision",
            reason: "需要改变已确认的分析步骤。",
            proposal: revisedProposal
          }
        };
      }
    };
    const execute = vi.fn();
    const runtime = new AgentRuntime({
      router: new ExtensibleAgentRouter(),
      planner: new FixedWindowsPlanner(),
      verifier: new MockVerifier(),
      scheduler,
      model,
      tools: { execute },
      policy: new DefaultAgentPolicy(),
      stepDelayMs: 0,
      createTaskId: () => "runtime-agent-loop-plan-revision"
    });

    runtime.start();
    runtime.dispatch({
      type: "SUBMIT_TASK",
      task: "我想在本地使用 PyTorch，帮我查询本地环境的匹配程度"
    });
    await runUntil(
      jobs,
      runtime,
      (state) => state.phase === "waiting_task_plan_confirmation"
    );
    runtime.dispatch({ type: "CONFIRM_TASK_PLAN", revision: 1 });
    await runUntil(
      jobs,
      runtime,
      (state) =>
        state.phase === "waiting_task_plan_confirmation" &&
        state.taskPlan?.revision === 2
    );

    expect(execute).not.toHaveBeenCalled();
    expect(runtime.getState()).toMatchObject({
      phase: "waiting_task_plan_confirmation",
      approvedRevision: null,
      taskPlan: {
        revision: 2,
        previousRevision: 1,
        status: "waiting_confirmation",
        confirmation: {
          status: "pending",
          confirmedRevision: null
        }
      },
      agentRun: {
        status: "waiting_approval",
        agentLoop: { status: "plan_revision_proposed" }
      }
    });
  });
});
