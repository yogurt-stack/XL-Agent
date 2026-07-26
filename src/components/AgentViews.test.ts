import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createInitialAgentState, transition } from "../features/agent-core/machine";
import { ClarificationView } from "./AgentViews";

describe("clarification view", () => {
  it("shows recovery actions instead of an infinite loader after the model step limit", () => {
    const submitted = transition(createInitialAgentState(), {
      type: "SUBMIT_TASK",
      task: "准备全栈 AI 应用环境"
    });
    const cancelled = transition(
      {
        ...submitted,
        phase: "planning",
        agentRun: {
          ...submitted.agentRun,
          step: submitted.agentRun.maxSteps
        }
      },
      { type: "MODEL_STEP_LIMIT_REACHED" }
    );

    const html = renderToStaticMarkup(createElement(ClarificationView, {
      dispatch: async (event) => transition(cancelled, event),
      onNavigate: () => undefined,
      onRetryLocally: async () => cancelled,
      state: cancelled
    }));

    expect(html).toContain("资源计划未能在安全步数内生成");
    expect(html).toContain("模型已达到 6 步安全上限");
    expect(html).toContain("使用本地模型重新开始");
    expect(html).toContain("返回首页");
    expect(html).not.toContain("正在生成资源计划");
  });
});
