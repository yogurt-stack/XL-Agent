import { describe, expect, it } from "vitest";
import { createInitialAgentState, transition } from "../agent-core/machine";
import {
  isTaskHistorySummary,
  parseTaskHistoryDetail
} from "./taskHistoryValidation";

function createHistoricalState() {
  return transition(createInitialAgentState(), {
    type: "SUBMIT_TASK",
    task: "准备历史任务测试环境"
  });
}

describe("task history response validation", () => {
  it("accepts a matching persisted task detail", () => {
    const state = createHistoricalState();
    const summary = {
      taskId: state.taskId,
      task: state.task,
      phase: state.phase,
      revision: state.revision,
      approvedRevision: state.approvedRevision,
      updatedAt: "2026-07-25T08:00:00.000Z",
      resourceCount: state.resources.length,
      verifiedResourceCount: 0,
      workspaceReady: state.workspace.ready,
      hasErrors: false
    };

    expect(isTaskHistorySummary(summary)).toBe(true);
    expect(
      parseTaskHistoryDetail(
        {
          summary,
          state,
          approvals: [],
          workspaceExports: [],
          downloadArtifacts: [],
          operationEvents: []
        },
        state.taskId
      )
    ).toMatchObject({
      summary,
      state: { taskId: state.taskId }
    });
  });

  it("rejects mismatched and malformed history responses", () => {
    const state = createHistoricalState();
    const summary = {
      taskId: state.taskId,
      task: state.task,
      phase: state.phase,
      revision: state.revision,
      approvedRevision: state.approvedRevision,
      updatedAt: "2026-07-25T08:00:00.000Z",
      resourceCount: 0,
      verifiedResourceCount: 1,
      workspaceReady: false,
      hasErrors: false
    };

    expect(isTaskHistorySummary(summary)).toBe(false);
    expect(
      parseTaskHistoryDetail(
        {
          summary: {
            ...summary,
            verifiedResourceCount: 0
          },
          state,
          approvals: [],
          workspaceExports: [],
          downloadArtifacts: [],
          operationEvents: []
        },
        "another-task"
      )
    ).toBeNull();
  });
});
