import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createInitialAgentState, transition } from "../features/agent-core/machine";
import type { TaskHistoryViewState } from "../features/task-history/useTaskHistory";
import { TaskHistoryView } from "./TaskHistoryView";

function createViewState(
  overrides: Partial<TaskHistoryViewState> = {}
): TaskHistoryViewState {
  const state = transition(createInitialAgentState(), {
    type: "SUBMIT_TASK",
    task: "准备可查阅的历史任务"
  });
  const summary = {
    taskId: state.taskId,
    task: state.task,
    phase: state.phase,
    revision: state.revision,
    approvedRevision: state.approvedRevision,
    updatedAt: "2026-07-25T08:00:00.000Z",
    resourceCount: state.resources.length,
    verifiedResourceCount: 0,
    workspaceReady: false,
    hasErrors: false
  };
  return {
    listStatus: "ready",
    detailStatus: "ready",
    history: [summary],
    selectedTaskId: state.taskId,
    detail: {
      summary,
      state,
      approvals: [],
      workspaceExports: [],
      downloadArtifacts: [],
      operationEvents: []
    },
    error: null,
    refresh: () => undefined,
    selectTask: () => undefined,
    ...overrides
  };
}

describe("task history view", () => {
  it("renders a read-only task list and selected task detail", () => {
    const html = renderToStaticMarkup(
      createElement(TaskHistoryView, {
        historyState: createViewState()
      })
    );

    expect(html).toContain("历史任务");
    expect(html).toContain("准备可查阅的历史任务");
    expect(html).toContain("SQLite 只读记录");
    expect(html).toContain("模型与工具审计");
    expect(html).toContain("运行日志");
    expect(html).not.toContain("删除");
    expect(html).not.toContain("恢复任务");
  });

  it("renders empty and error states", () => {
    const emptyHtml = renderToStaticMarkup(
      createElement(TaskHistoryView, {
        historyState: createViewState({
          history: [],
          selectedTaskId: null,
          detail: null,
          detailStatus: "idle"
        })
      })
    );
    const errorHtml = renderToStaticMarkup(
      createElement(TaskHistoryView, {
        historyState: createViewState({
          listStatus: "error",
          history: [],
          selectedTaskId: null,
          detail: null,
          detailStatus: "idle",
          error: "TASK_HISTORY_READ_FAILED: 读取失败"
        })
      })
    );

    expect(emptyHtml).toContain("还没有历史任务");
    expect(errorHtml).toContain("历史任务读取失败");
    expect(errorHtml).toContain("TASK_HISTORY_READ_FAILED");
  });
});
