import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  createInitialAgentState,
  transition
} from "../features/agent-core/machine";
import type { AgentState } from "../features/agent-core/types";
import { ClarificationView } from "./AgentViews";

describe("ClarificationView corrupted state recovery", () => {
  it("does not mislabel an exhausted clarifying state as active routing", () => {
    const initial = createInitialAgentState();
    const state: AgentState = {
      ...initial,
      phase: "clarifying",
      clarifications: [{
        id: "primary-workload",
        prompt: "主要准备哪类开发工作负载？",
        reason: "工作负载会影响资源组合。",
        required: true,
        options: ["Python AI 开发", "全栈 AI 应用"]
      }],
      clarificationIndex: 1,
      answers: { "primary-workload": "Python AI 开发" }
    };

    const html = renderToStaticMarkup(createElement(ClarificationView, {
      dispatch: async (event) => transition(state, event),
      onNavigate: () => undefined,
      onRetryLocally: async () => state,
      state
    }));

    expect(html).not.toContain("正在路由任务");
    expect(html).not.toContain("Agent 正在读取系统画像并决定下一项动作");
  });
});
