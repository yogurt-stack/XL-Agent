import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntimeHost } from "./agentRuntimeHost";
import { TaskStore } from "./taskStore";
import { RemoteModelClient } from "./modelClient";
import { normalizeRestorableAgentState } from "../src/features/agent-core/persistence";
import type { GitHubRepositoryInspectionResult } from "./githubClient";

const unavailable = {
  ok: false as const,
  error: {
    code: "TEST_INSPECTION",
    message: "Inspection boundary reached",
    retriable: false,
  },
};
describe("web research Main integration", () => {
  it("binds repository actions to observed candidates and rejects stale asynchronous inspection results", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xl-web-host-"));
    const store = await TaskStore.open({
      databasePath: path.join(root, "tasks.sqlite"),
    });
    let host: AgentRuntimeHost | undefined;
    const inspect = vi.fn(
      async (): Promise<GitHubRepositoryInspectionResult> => unavailable,
    );
    const analyze = vi.fn(async () => unavailable);
    const download = vi.fn(async () => unavailable);
    try {
      host = await AgentRuntimeHost.create({
        store,
        modelClient: new RemoteModelClient({}),
        githubRepositorySearch: async () => unavailable,
        inspectGitHubRepository: inspect,
        inspectGitHubRepositoryForAnalysis: analyze,
        performDownload: download,
        workspaceRoot: path.join(root, "workspace"),
        stepDelayMs: 0,
        webResearchTools: {
          search: async ({ query }) => ({
            query,
            provider: "tavily",
            results: [
              {
                title: "Project",
                url: "https://github.com/acme/project",
                snippet: "Candidate",
              },
            ],
            fetchedAt: "2026-09-09T00:00:00Z",
            trust: "untrusted-web-content",
          }),
          readPage: async ({ url }) => ({
            url,
            title: "Project",
            content: "Project documentation",
            links: [],
            fetchedAt: "2026-09-09T00:00:00Z",
            truncated: false,
            trust: "untrusted-web-content",
          }),
        },
      });
      await host.dispatch({
        type: "SUBMIT_TASK",
        task: "搜索适合离线使用的开源项目",
      });
      await vi.waitFor(() =>
        expect(host!.getSnapshot().state.phase).toBe(
          "waiting_task_plan_confirmation",
        ),
      );
      await host.dispatch({ type: "CONFIRM_TASK_PLAN", revision: 1 });
      await vi.waitFor(() =>
        expect(host!.getSnapshot().state.phase).toBe("result"),
      );
      await expect(
        host.dispatch({
          type: "ANALYZE_GITHUB_REPOSITORY",
          fullName: "invented/repo",
        }),
      ).rejects.toThrow("明确选择");
      await expect(
        host.dispatch({
          type: "PREPARE_GITHUB_REPOSITORY",
          fullName: "invented/repo",
        }),
      ).rejects.toThrow("明确选择");
      expect(inspect).not.toHaveBeenCalled();
      expect(analyze).not.toHaveBeenCalled();
      await expect(
        host.dispatch({
          type: "ANALYZE_GITHUB_REPOSITORY",
          fullName: "acme/project",
        }),
      ).rejects.toThrow("Inspection boundary reached");
      await expect(
        host.dispatch({
          type: "PREPARE_GITHUB_REPOSITORY",
          fullName: "acme/project",
        }),
      ).rejects.toThrow("Inspection boundary reached");
      expect(inspect).toHaveBeenCalledWith("acme/project");
      expect(analyze).toHaveBeenCalledWith("acme/project");
      expect(download).not.toHaveBeenCalled();
      await host.flushPersistence();
      const persisted = normalizeRestorableAgentState(
        await store.getTaskState(host.getSnapshot().state.taskId),
      );
      expect(persisted?.agentRun.toolResults.map((r) => r.tool)).toEqual([
        "search_web",
        "read_web_page",
      ]);

      // Reset while an inspection is in flight: a late successful answer must not replace the new task.
      let resolveInspection!: (value: GitHubRepositoryInspectionResult) => void;
      inspect.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInspection = resolve;
          }),
      );
      const pending = host.dispatch({
        type: "PREPARE_GITHUB_REPOSITORY",
        fullName: "acme/project",
      });
      await vi.waitFor(() => expect(resolveInspection).toBeDefined());
      await host.dispatch({ type: "RESET" });
      resolveInspection({
        ok: true,
        resource: {} as never,
        dependencyResources: [],
      });
      await expect(pending).rejects.toThrow("任务上下文已变化");
      expect(host.getSnapshot().state.phase).toBe("intake");
      expect(download).not.toHaveBeenCalled();
    } finally {
      host?.stop();
      await host?.flushPersistence();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
