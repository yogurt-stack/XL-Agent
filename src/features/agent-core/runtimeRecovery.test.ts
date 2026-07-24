import { describe, expect, it } from "vitest";
import { DefaultAgentPolicy, InMemoryAgentToolExecutor } from "./agentServices";
import { catalogById } from "./catalog";
import type { AgentScheduler } from "./interfaces";
import { createResourceManifest } from "./manifest";
import { FixedWindowsPlanner, FixedWindowsRouter, MockVerifier } from "./mockServices";
import { AgentRuntime, type RuntimeDownloadTool } from "./runtime";
import type {
  AgentPhase,
  AgentState,
  FailureResolutionAction
} from "./types";

type ScheduledJob = {
  cancelled: boolean;
  task: () => void | Promise<void>;
};

function createRuntimeHarness(
  options: {
    downloadTool?: RuntimeDownloadTool;
    tools?: InMemoryAgentToolExecutor;
  } = {}
) {
  const queue: ScheduledJob[] = [];
  const scheduler: AgentScheduler = {
    schedule(task) {
      const job = { cancelled: false, task };
      queue.push(job);
      return () => {
        job.cancelled = true;
      };
    }
  };
  const runtime = new AgentRuntime({
    router: new FixedWindowsRouter(),
    planner: new FixedWindowsPlanner(),
    verifier: new MockVerifier(),
    scheduler,
    tools: options.tools ?? new InMemoryAgentToolExecutor(),
    policy: new DefaultAgentPolicy(),
    stepDelayMs: 0,
    downloadTool: options.downloadTool
  });
  let state = runtime.getState();
  runtime.subscribe((nextState) => {
    state = nextState;
  });
  runtime.start();

  const runUntil = async (phase: AgentPhase, maxSteps = 120) => {
    for (let step = 0; step < maxSteps && state.phase !== phase; step += 1) {
      const job = queue.shift();
      if (!job) throw new Error(`Runtime stalled at ${state.phase}; expected ${phase}.`);
      if (!job.cancelled) await job.task();
    }
    expect(state.phase).toBe(phase);
    return state;
  };

  return {
    runtime,
    getState: () => state,
    runUntil
  };
}

async function runToDownloadFailure(
  options: Parameters<typeof createRuntimeHarness>[0] = {}
) {
  const harness = createRuntimeHarness(options);
  harness.runtime.dispatch({ type: "SUBMIT_TASK", task: "准备 Windows AI 环境" });
  await harness.runUntil("clarifying");
  harness.runtime.dispatch({
    type: "ANSWER_CLARIFICATION",
    questionId: "primary-workload",
    answer: "全栈 AI 应用"
  });
  harness.runtime.dispatch({
    type: "ANSWER_CLARIFICATION",
    questionId: "mirror-policy",
    answer: "允许备用镜像"
  });
  await harness.runUntil("waiting_approval");
  harness.runtime.dispatch({ type: "APPROVE_PLAN", revision: harness.getState().revision });
  await harness.runUntil("awaiting_failure_action");
  return harness;
}

async function recoverAndComplete(
  action: Extract<FailureResolutionAction, "primary-retry" | "trusted-mirror">
): Promise<AgentState> {
  const harness = await runToDownloadFailure();
  const failedState = harness.getState();
  expect(failedState.revision).toBe(1);
  expect(failedState.agentRun.toolResults).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        tool: "simulate_download",
        status: "error",
        error: expect.objectContaining({ code: "CHECKSUM_MISMATCH", retriable: true })
      })
    ])
  );

  harness.runtime.dispatch({ type: "RESOLVE_DOWNLOAD_FAILURE", action });
  await harness.runUntil("waiting_approval");
  expect(harness.getState().revision).toBe(2);
  expect(harness.getState().approvedRevision).toBeNull();

  harness.runtime.dispatch({ type: "APPROVE_PLAN", revision: 2 });
  await harness.runUntil("handoff");
  return harness.getState();
}

describe("agent runtime recovery", () => {
  it("retries the primary source behind a new approval revision", async () => {
    const state = await recoverAndComplete("primary-retry");

    expect(state.workspace.ready).toBe(true);
    expect(state.resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "sample-project", status: "verified" })])
    );
    expect(state.resources.some((resource) => resource.id === "sample-project-mirror")).toBe(false);
  });

  it("uses the trusted fallback behind a new approval revision", async () => {
    const state = await recoverAndComplete("trusted-mirror");

    expect(state.workspace.ready).toBe(true);
    expect(state.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "sample-project-mirror",
          replacedFrom: "sample-project",
          status: "verified"
        })
      ])
    );
    const manifest = createResourceManifest(state);
    expect(manifest).toMatchObject({
      revision: 2,
      approvedRevision: 2,
      handoff: { ready: true, missingItems: [] }
    });
  });

  it("creates an incomplete handoff when the user delegates to Agent B", async () => {
    const harness = await runToDownloadFailure();
    harness.runtime.dispatch({
      type: "RESOLVE_DOWNLOAD_FAILURE",
      action: "delegate-agent-b"
    });
    const state = harness.getState();
    const manifest = createResourceManifest(state);

    expect(state.phase).toBe("handoff");
    expect(state.agentRun.status).toBe("delegated");
    expect(manifest.handoff.ready).toBe(false);
    const failedResource = manifest.resources.find((resource) => resource.status === "failed");
    expect(failedResource).toBeDefined();
    expect(manifest.handoff.missingItems).toContain(failedResource!.name);
    expect(manifest.handoff.nextAction).toContain("Agent B");
  });

  it("routes every simulated download through policy evaluation", async () => {
    const harness = await runToDownloadFailure();
    const state = harness.getState();
    const downloads = state.agentRun.toolResults.filter(
      (result) => result.tool === "simulate_download"
    );
    const downloadAudits = state.agentRun.policyAudit.filter((entry) =>
      entry.actionId.startsWith("runtime-download-r1")
    );

    expect(downloads.length).toBeGreaterThan(0);
    expect(downloadAudits).toHaveLength(downloads.length);
    expect(downloadAudits.every((entry) => entry.decision.outcome === "allow")).toBe(true);
  });

  it("runs Electron controlled downloads through policy and preserves checksum recovery", async () => {
    const attempts = new Map<string, number>();
    const tools = new InMemoryAgentToolExecutor(undefined, async ({ resourceId }) => {
      const resource = catalogById.get(resourceId);
      if (!resource) {
        return {
          ok: false,
          error: {
            code: "RESOURCE_NOT_TRUSTED",
            message: "Resource is missing from the trusted catalog.",
            retriable: false
          }
        };
      }
      const attempt = (attempts.get(resourceId) ?? 0) + 1;
      attempts.set(resourceId, attempt);
      if (resourceId === "sample-project" && attempt === 1) {
        return {
          ok: false,
          error: {
            code: "CHECKSUM_MISMATCH",
            message: "下载文件 SHA256 与可信目录不一致。",
            retriable: true
          }
        };
      }
      return {
        ok: true,
        output: {
          resourceId,
          urlHost: new URL(resource.download.url).host,
          bytesWritten: 7,
          sha256: resource.download.expectedSha256,
          tempFilePath: `/tmp/${resourceId}.download`,
          elapsedMs: 1
        }
      };
    });
    const harness = await runToDownloadFailure({
      downloadTool: "controlled_download",
      tools
    });
    const state = harness.getState();
    const downloads = state.agentRun.toolResults.filter(
      (result) => result.tool === "controlled_download"
    );
    const downloadAudits = state.agentRun.policyAudit.filter((entry) =>
      entry.actionId.startsWith("runtime-download-r1")
    );

    expect(downloads.length).toBeGreaterThan(0);
    expect(downloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "success",
          output: expect.objectContaining({
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
          })
        }),
        expect.objectContaining({
          status: "error",
          error: expect.objectContaining({
            code: "CHECKSUM_MISMATCH",
            retriable: true
          })
        })
      ])
    );
    expect(downloadAudits).toHaveLength(downloads.length);
    expect(downloadAudits.every((entry) => entry.decision.outcome === "allow")).toBe(true);
  });
});
