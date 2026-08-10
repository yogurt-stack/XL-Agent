import { describe, expect, it } from "vitest";
import { createInitialAgentState, transition } from "./machine";
import { normalizeRestorableAgentState } from "./persistence";
import { ExtensibleAgentRouter } from "./router";
import { confirmTaskPlanForTest } from "./taskPlanTestSupport";
import type { AgentState } from "./types";

function createRoutedState() {
  const submitted = transition(createInitialAgentState(), {
    type: "SUBMIT_TASK",
    task: "帮我准备一个 Windows 下的 AI 开发环境",
    taskId: "restore-clarification-test"
  });
  const routed = new ExtensibleAgentRouter().route(submitted);
  if (!routed) throw new Error("Expected the test task to be routed.");
  return transition(submitted, routed);
}

function createAnsweredWaitingClarificationState() {
  let state = confirmTaskPlanForTest(createRoutedState());
  const question = state.clarifications[state.clarificationIndex];
  if (!question) throw new Error("Expected an initial clarification question.");

  state = transition(state, {
    type: "ANSWER_CLARIFICATION",
    questionId: question.id,
    answer: "仅准备基础环境",
    answeredAt: "2026-08-09T15:30:00.000Z"
  });
  const taskPlan = state.taskPlan;
  if (!taskPlan) throw new Error("Expected a confirmed Task Plan.");
  const decisionStep = taskPlan.steps.find(
    (step) =>
      step.kind === "user_decision" &&
      step.staticInput.questionId === question.id
  );
  if (!decisionStep) {
    throw new Error("Expected a user-decision step for the answered question.");
  }

  // Reproduce a snapshot written by an older runtime: the answer and advanced
  // clarification cursor were persisted, but the corresponding Task Plan step
  // was left waiting for the same input.
  state = {
    ...state,
    phase: "clarifying",
    taskPlan: {
      ...taskPlan,
      status: "waiting_user_input",
      steps: taskPlan.steps.map((step) =>
        step.id === decisionStep.id
          ? {
              ...step,
              status: "waiting_user_input",
              result: null,
              error: null,
              completedAt: null
            }
          : step
      )
    }
  };

  expect(state).toMatchObject({
    phase: "clarifying",
    clarificationIndex: state.clarifications.length,
    answers: { [question.id]: "仅准备基础环境" },
    taskPlan: { status: "waiting_user_input" }
  });
  return { question, state };
}

describe("persisted clarification recovery", () => {
  it("repairs an answered out-of-range clarification and completes its waiting Task Plan step", () => {
    const { question, state } = createAnsweredWaitingClarificationState();

    const restored = normalizeRestorableAgentState(state);

    expect(restored).not.toBeNull();
    expect(restored).toMatchObject({
      phase: "planning",
      answers: { [question.id]: "仅准备基础环境" },
      taskPlan: { status: "executing" }
    });
    expect(
      restored?.taskPlan?.steps.find(
        (step) => step.staticInput.questionId === question.id
      )
    ).toMatchObject({
      kind: "user_decision",
      status: "completed",
      result: {
        output: {
          questionId: question.id,
          answer: "仅准备基础环境"
        }
      }
    });
  });

  it("rejects a clarifying snapshot with no active or derivable question", () => {
    const routed = createRoutedState();
    const irreparable: AgentState = {
      ...routed,
      phase: "clarifying",
      clarifications: [],
      clarificationIndex: 0
    };

    expect(normalizeRestorableAgentState(irreparable)).toBeNull();
  });
});
