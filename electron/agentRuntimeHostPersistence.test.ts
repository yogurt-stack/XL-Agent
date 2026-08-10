import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createInitialAgentState, transition } from "../src/features/agent-core/machine";
import { ExtensibleAgentRouter } from "../src/features/agent-core/router";
import { proposeTaskPlanForTest } from "../src/features/agent-core/taskPlanTestSupport";
import { AgentRuntimeHost } from "./agentRuntimeHost";
import { RemoteModelClient } from "./modelClient";
import { TaskStore } from "./taskStore";

function createRoutingState(
  taskId = "reset-recovery-test",
  task = "帮我准备一个 Windows 下的 AI 开发环境"
) {
  return transition(createInitialAgentState(), {
    type: "SUBMIT_TASK",
    task,
    taskId
  });
}

function createTaskPlanningState(
  taskId = "reset-recovery-test",
  task = "帮我准备一个 Windows 下的 AI 开发环境"
) {
  const submitted = createRoutingState(taskId, task);
  const routed = new ExtensibleAgentRouter().route(submitted);
  if (!routed) throw new Error("Expected the test task to be routed.");
  return transition(submitted, routed);
}

function createAwaitingConfirmationState(
  taskId = "reset-recovery-test",
  task = "帮我准备一个 Windows 下的 AI 开发环境"
) {
  return proposeTaskPlanForTest(createTaskPlanningState(taskId, task));
}

function createPlanningState(taskId: string) {
  const awaitingConfirmation = createAwaitingConfirmationState(taskId);
  const confirmed = transition(
    {
      ...awaitingConfirmation,
      clarifications: [],
      clarificationIndex: 0
    },
    {
      type: "TASK_PLAN_CONFIRMED",
      revision: awaitingConfirmation.taskPlan?.revision ?? 1,
      confirmedAt: "2026-08-10T08:00:00.000Z"
    }
  );
  if (confirmed.phase !== "planning") {
    throw new Error(`Expected planning fixture, received ${confirmed.phase}.`);
  }
  return confirmed;
}

const unavailable = {
  ok: false as const,
  error: {
    code: "NOT_USED",
    message: "This dependency is outside the persistence test path.",
    retriable: false
  }
};

describe("AgentRuntimeHost reset persistence", () => {
  it.each([
    ["routing", createRoutingState],
    ["task_planning", createTaskPlanningState],
    ["planning", createPlanningState]
  ] as const)("terminalizes a restored transient %s snapshot without calling the model again", async (
    expectedPhase,
    createState
  ) => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "xunlei-transient-restart-test-")
    );
    let store: TaskStore | null = null;
    let host: AgentRuntimeHost | null = null;
    try {
      store = await TaskStore.open({
        databasePath: path.join(tempRoot, "agent-tasks.sqlite"),
        now: () => Date.parse("2026-08-10T08:30:00.000Z")
      });
      const taskId = `restored-transient-${expectedPhase}-task`;
      const transient = createState(taskId);
      expect(transient.phase).toBe(expectedPhase);
      await store.saveSnapshot(transient);

      const fetchRequest = vi.fn(async () => {
        throw new Error("A restored transient task must not call the model.");
      });
      const modelClient = new RemoteModelClient({
        XL_AGENT_LLM_PROVIDER: "openai-compatible",
        XL_AGENT_LLM_ENDPOINT: "https://api.deepseek.com/chat/completions",
        XL_AGENT_LLM_API_KEY: "test-secret",
        XL_AGENT_LLM_MODEL: "deepseek-chat"
      }, fetchRequest);

      host = await AgentRuntimeHost.create({
        store,
        modelClient,
        githubRepositorySearch: async () => unavailable,
        inspectGitHubRepository: async () => unavailable,
        inspectGitHubRepositoryForAnalysis: async () => unavailable,
        workspaceRoot: path.join(tempRoot, "workspace"),
        performDownload: async () => unavailable,
        createTaskId: () => "unused-task-id",
        stepDelayMs: 0
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await host.flushPersistence();

      expect(host.getSnapshot()).toMatchObject({
        state: {
          taskId,
          phase: "cancelled"
        }
      });
      expect(fetchRequest).not.toHaveBeenCalled();
      expect(
        await store.getTaskState(taskId)
      ).toMatchObject({
        phase: "cancelled"
      });
      expect(await store.loadLatestUnfinished()).toBeNull();
    } finally {
      await host?.flushPersistence().catch(() => undefined);
      host?.stop();
      await store?.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["routing", "帮我看看那个神秘目标"],
    ["task_planning", "帮我准备一个 Windows 下的 AI 开发环境"]
  ] as const)("aborts an in-flight %s request and persists cancellation before acknowledging stop", async (
    expectedPhase,
    task
  ) => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "xunlei-active-cancel-persistence-test-")
    );
    let store: TaskStore | null = null;
    let host: AgentRuntimeHost | null = null;
    let receivedSignal: AbortSignal | undefined;
    let notifyRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      notifyRequestStarted = resolve;
    });
    try {
      store = await TaskStore.open({
        databasePath: path.join(tempRoot, "agent-tasks.sqlite"),
        now: () => Date.parse("2026-08-10T09:15:00.000Z")
      });
      const fetchRequest = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          receivedSignal = init?.signal ?? undefined;
          notifyRequestStarted();
          receivedSignal?.addEventListener("abort", () => {
            reject(new DOMException("Request cancelled by user.", "AbortError"));
          }, { once: true });
        })
      );
      host = await AgentRuntimeHost.create({
        store,
        modelClient: new RemoteModelClient({
          XL_AGENT_LLM_PROVIDER: "openai-compatible",
          XL_AGENT_LLM_ENDPOINT: "https://api.deepseek.com/chat/completions",
          XL_AGENT_LLM_API_KEY: "test-secret",
          XL_AGENT_LLM_MODEL: "deepseek-chat"
        }, fetchRequest),
        githubRepositorySearch: async () => unavailable,
        inspectGitHubRepository: async () => unavailable,
        inspectGitHubRepositoryForAnalysis: async () => unavailable,
        workspaceRoot: path.join(tempRoot, "workspace"),
        performDownload: async () => unavailable,
        createTaskId: () => `active-${expectedPhase}-task`,
        stepDelayMs: 0
      });

      await host.dispatch({ type: "SUBMIT_TASK", task });
      await requestStarted;
      expect(host.getSnapshot().state.phase).toBe(expectedPhase);
      expect(receivedSignal?.aborted).toBe(false);

      const cancelled = await host.dispatch({ type: "CANCEL_TASK" });

      expect(receivedSignal?.aborted).toBe(true);
      expect(cancelled.state).toMatchObject({
        taskId: `active-${expectedPhase}-task`,
        phase: "cancelled"
      });
      expect(cancelled.persistence.lastSavedAt).toBe(
        "2026-08-10T09:15:00.000Z"
      );
      expect(
        await store.getTaskState(`active-${expectedPhase}-task`)
      ).toMatchObject({ phase: "cancelled" });
      expect(await store.loadLatestUnfinished()).toBeNull();
    } finally {
      await host?.flushPersistence().catch(() => undefined);
      host?.stop();
      await store?.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("never falls back to an older unfinished task after the newest task is cancelled", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "xunlei-no-stale-task-recovery-test-")
    );
    let store: TaskStore | null = null;
    let now = Date.parse("2026-08-10T08:00:00.000Z");
    try {
      store = await TaskStore.open({
        databasePath: path.join(tempRoot, "agent-tasks.sqlite"),
        now: () => now
      });
      const olderPlanning = createPlanningState("older-planning-task");
      await store.saveSnapshot(olderPlanning);

      now = Date.parse("2026-08-10T08:01:00.000Z");
      const latestWaiting = createAwaitingConfirmationState(
        "latest-waiting-task"
      );
      await store.saveSnapshot(latestWaiting);

      expect(await store.loadLatestUnfinished()).toMatchObject({
        state: {
          taskId: "latest-waiting-task",
          phase: "waiting_task_plan_confirmation"
        }
      });

      now = Date.parse("2026-08-10T08:02:00.000Z");
      const latestCancelled = transition(latestWaiting, {
        type: "CANCEL_TASK",
        cancelledAt: "2026-08-10T08:02:00.000Z"
      });
      await store.saveSnapshot(latestCancelled);

      expect(await store.getTaskState("latest-waiting-task")).toMatchObject({
        phase: "cancelled"
      });
      expect(await store.loadLatestUnfinished()).toBeNull();
    } finally {
      await store?.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("acknowledges cancellation only after the terminal snapshot is durable", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "xunlei-cancel-persistence-test-")
    );
    let store: TaskStore | null = null;
    let host: AgentRuntimeHost | null = null;
    try {
      store = await TaskStore.open({
        databasePath: path.join(tempRoot, "agent-tasks.sqlite"),
        now: () => Date.parse("2026-08-10T09:00:00.000Z")
      });
      await store.saveSnapshot(createAwaitingConfirmationState());

      host = await AgentRuntimeHost.create({
        store,
        modelClient: new RemoteModelClient({}),
        githubRepositorySearch: async () => unavailable,
        inspectGitHubRepository: async () => unavailable,
        inspectGitHubRepositoryForAnalysis: async () => unavailable,
        workspaceRoot: path.join(tempRoot, "workspace"),
        performDownload: async () => unavailable,
        createTaskId: () => "unused-task-id",
        stepDelayMs: 0
      });

      const cancelled = await host.dispatch({ type: "CANCEL_TASK" });

      expect(cancelled.state.phase).toBe("cancelled");
      expect(cancelled.persistence.lastSavedAt).toBe(
        "2026-08-10T09:00:00.000Z"
      );
      expect(await store.getTaskState("reset-recovery-test")).toMatchObject({
        phase: "cancelled"
      });

      const reset = await host.dispatch({ type: "RESET" });
      expect(reset.state).toMatchObject({
        taskId: "unassigned",
        phase: "intake"
      });
      expect(await store.loadLatestUnfinished()).toBeNull();
    } finally {
      await host?.flushPersistence().catch(() => undefined);
      host?.stop();
      await store?.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not restore an unfinished task after the user resets it", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "xunlei-reset-recovery-test-")
    );
    let store: TaskStore | null = null;
    let host: AgentRuntimeHost | null = null;
    try {
      store = await TaskStore.open({
        databasePath: path.join(tempRoot, "agent-tasks.sqlite"),
        now: () => Date.parse("2026-08-09T15:30:00.000Z")
      });
      await store.saveSnapshot(createAwaitingConfirmationState());

      host = await AgentRuntimeHost.create({
        store,
        modelClient: new RemoteModelClient({}),
        githubRepositorySearch: async () => unavailable,
        inspectGitHubRepository: async () => unavailable,
        inspectGitHubRepositoryForAnalysis: async () => unavailable,
        workspaceRoot: path.join(tempRoot, "workspace"),
        performDownload: async () => unavailable,
        createTaskId: () => "unused-task-id",
        stepDelayMs: 0
      });

      expect(host.getSnapshot()).toMatchObject({
        state: { taskId: "reset-recovery-test" },
        persistence: { restoredAt: "2026-08-09T15:30:00.000Z" }
      });

      const reset = await host.dispatch({ type: "RESET" });
      expect(reset.state).toMatchObject({
        taskId: "unassigned",
        phase: "intake"
      });
      await host.flushPersistence();

      expect(await store.loadLatestUnfinished()).toBeNull();
    } finally {
      host?.stop();
      await store?.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
