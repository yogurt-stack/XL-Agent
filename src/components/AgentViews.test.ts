import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { catalogById } from "../features/agent-core/catalog";
import { createInitialAgentState, transition } from "../features/agent-core/machine";
import type { ModelConnectionState } from "../features/agent-core/modelConnection";
import {
  AgentHomeView,
  ClarificationView,
  ExecutionView,
  SettingsView
} from "./AgentViews";

const localModelConnection: ModelConnectionState = {
  status: "unconfigured",
  activeProvider: "local-rule",
  configured: false,
  endpointHost: null,
  model: null,
  providerId: null,
  endpointMode: null,
  lastCheckedAt: null
};

describe("clarification view", () => {
  it("renders Main-registered P2 capabilities and the P3 reset control", () => {
    const state = createInitialAgentState();
    const capabilities = {
      domainSkills: [
        {
          id: "ai-development-environment",
          displayName: "AI 开发环境"
        },
        {
          id: "research-data-environment",
          displayName: "科研数据环境"
        }
      ],
      sourceProviders: [{ id: "trusted-catalog" }],
      workspaceTemplates: [
        { id: "ai-development-workspace" },
        { id: "research-data-workspace" }
      ]
    };
    const homeHtml = renderToStaticMarkup(
      createElement(AgentHomeView, {
        capabilities,
        dispatch: async (event) => transition(state, event),
        onNavigate: () => undefined,
        state
      })
    );
    const settingsHtml = renderToStaticMarkup(
      createElement(SettingsView, {
        capabilities,
        modelConnection: localModelConnection,
        onResetDemoData: async () => ({
          ok: true as const,
          reset: {
            resetAt: "2026-07-29T00:00:00.000Z",
            removedRecords: 0,
            cleanupWarning: null
          }
        }),
        onTestConnection: async () => localModelConnection,
        persistence: {
          status: "ready",
          restoredAt: null,
          lastSavedAt: null,
          lastResetAt: null,
          lastResetRemovedRecords: 0,
          error: null
        },
        state
      })
    );

    expect(homeHtml).toContain("科研数据环境");
    expect(homeHtml).toContain("1 个 Provider · 2 个模板");
    expect(settingsHtml).toContain("平台扩展能力");
    expect(settingsHtml).toContain("重置 Demo 数据");
  });

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

  it("only shows speed and ETA while a download is active or paused", () => {
    const initial = createInitialAgentState();
    const resource = catalogById.get("python-312")!;
    const completedHtml = renderToStaticMarkup(createElement(ExecutionView, {
      dispatch: async () => initial,
      modelConnection: localModelConnection,
      onNavigate: () => undefined,
      state: {
        ...initial,
        phase: "awaiting_failure_action",
        resources: [
          {
            ...resource,
            selected: true,
            status: "downloaded",
            progress: 100,
            attempts: 1,
            speedBytesPerSecond: 1024,
            etaSeconds: 0
          }
        ]
      }
    }));
    const activeHtml = renderToStaticMarkup(createElement(ExecutionView, {
      dispatch: async () => initial,
      modelConnection: localModelConnection,
      onNavigate: () => undefined,
      state: {
        ...initial,
        phase: "downloading",
        activeResourceId: resource.id,
        resources: [
          {
            ...resource,
            selected: true,
            status: "downloading",
            progress: 50,
            attempts: 1,
            speedBytesPerSecond: 1024 * 1024,
            etaSeconds: 8
          }
        ]
      }
    }));

    expect(completedHtml).not.toContain("剩余约 0s");
    expect(activeHtml).toContain("1.0 MB/s");
    expect(activeHtml).toContain("剩余约 8s");
  });
});
