import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createInitialAgentState, transition } from "../features/agent-core/machine";
import { ExtensibleAgentRouter } from "../features/agent-core/router";
import { proposeTaskPlanForTest } from "../features/agent-core/taskPlanTestSupport";
import type { AgentState, AgentUserEvent } from "../features/agent-core/types";
import {
  AgentHomeView,
  AgentTopBar,
  cancelActiveTaskAndReturnHome,
  ClarificationView,
  ExecutionView,
  ResourcePlanView
} from "./AgentViews";

function createTaskPlanningState() {
  const submitted = transition(createInitialAgentState(), {
    type: "SUBMIT_TASK",
    task: "准备 Python 机器学习环境",
    taskId: "cancel-control-test"
  });
  const routed = new ExtensibleAgentRouter().route(submitted);
  if (!routed) throw new Error("Expected the test task to be routed.");
  return transition(submitted, routed);
}

function createWaitingApprovalState() {
  const planning = {
    ...proposeTaskPlanForTest(createTaskPlanningState()),
    phase: "planning" as const,
    clarifications: [],
    clarificationIndex: 0
  };
  const waitingApproval = transition(planning, { type: "PLAN_GENERATED" });
  if (waitingApproval.phase !== "waiting_approval") {
    throw new Error(
      `Expected waiting_approval, received ${waitingApproval.phase}.`
    );
  }
  return waitingApproval;
}

function renderClarification(state: AgentState) {
  return renderToStaticMarkup(
    createElement(ClarificationView, {
      dispatch: async (event) => transition(state, event),
      onNavigate: () => undefined,
      onRetryLocally: async () => state,
      state
    })
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function elementText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!isValidElement<{ children?: ReactNode }>(node)) {
    return Children.toArray(node).map(elementText).join("");
  }
  return elementText(node.props.children);
}

function findButtonByText(
  node: ReactNode,
  text: string
): ReactElement<{
  children?: ReactNode;
  onClick?: () => void | Promise<unknown>;
}> | null {
  if (
    node === null ||
    node === undefined ||
    typeof node === "boolean" ||
    typeof node === "string" ||
    typeof node === "number"
  ) {
    return null;
  }
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void | Promise<unknown> }>(node)) {
    for (const child of Children.toArray(node)) {
      const found = findButtonByText(child, text);
      if (found) return found;
    }
    return null;
  }
  if (node.type === "button" && elementText(node.props.children).includes(text)) {
    return node;
  }
  for (const child of Children.toArray(node.props.children)) {
    const found = findButtonByText(child, text);
    if (found) return found;
  }
  return null;
}

describe("active planning cancellation", () => {
  it.each([
    ["task_planning", () => createTaskPlanningState()],
    [
      "waiting_task_plan_confirmation",
      () => proposeTaskPlanForTest(createTaskPlanningState())
    ],
    [
      "planning",
      () => ({ ...proposeTaskPlanForTest(createTaskPlanningState()), phase: "planning" as const })
    ],
    [
      "clarifying",
      () => ({
        ...proposeTaskPlanForTest(createTaskPlanningState()),
        phase: "clarifying" as const,
        clarifications: [
          {
            id: "frontend-toolchain",
            prompt: "是否同时准备前端工具链？",
            reason: "这会改变环境准备范围。",
            required: true,
            options: ["仅 Python AI", "同时准备前端"]
          }
        ],
        clarificationIndex: 0
      })
    ]
  ] as const)("shows an explicit cancel action during %s", (_phase, createState) => {
    const html = renderClarification(createState());

    expect(html).toContain("取消任务");
  });

  it("returns home after one durable cancellation acknowledgement without dispatching RESET", async () => {
    const initial = createTaskPlanningState();
    const cancelled = transition(initial, {
      type: "CANCEL_TASK",
      cancelledAt: "2026-08-10T09:00:00.000Z"
    });
    const calls: Array<AgentUserEvent["type"] | "navigate-home"> = [];
    const cancellation = deferred<AgentState>();
    const dispatch = vi.fn((event: AgentUserEvent): Promise<AgentState> => {
      calls.push(event.type);
      if (event.type === "CANCEL_TASK") return cancellation.promise;
      throw new Error(`Unexpected event ${event.type}`);
    });
    const onNavigate = vi.fn((view: "home") => {
      calls.push(`navigate-${view}`);
    });

    const operation = cancelActiveTaskAndReturnHome(dispatch, onNavigate);

    expect(calls).toEqual(["CANCEL_TASK"]);
    expect(onNavigate).not.toHaveBeenCalled();

    cancellation.resolve(cancelled);
    const result = await operation;

    expect(result).toBe(cancelled);
    expect(calls).toEqual(["CANCEL_TASK", "navigate-home"]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: "CANCEL_TASK" });
    expect(onNavigate).toHaveBeenCalledWith("home");
  });

  it("does not reset or navigate if cancellation was not acknowledged", async () => {
    const stillPlanning = createTaskPlanningState();
    const dispatch = vi.fn(async () => stillPlanning);
    const onNavigate = vi.fn();

    const result = await cancelActiveTaskAndReturnHome(dispatch, onNavigate);

    expect(result).toBe(stillPlanning);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: "CANCEL_TASK" });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("never presents an idle intake state as active routing", () => {
    const html = renderClarification(createInitialAgentState());

    expect(html).not.toContain("正在路由任务");
    expect(html).not.toContain("Agent 正在读取系统画像并决定下一项动作");
  });

  it("does not render a dead retry action while routing is still active", () => {
    const html = renderClarification({
      ...createTaskPlanningState(),
      phase: "routing",
      route: null,
      routeDecision: null
    });

    expect(html).toContain("正在路由任务");
    expect(html).not.toContain("重新同步并路由");
    expect(html).toContain("放弃并返回任务入口");
  });

  it("keeps cancellation available while the resource plan awaits approval", () => {
    const state = createWaitingApprovalState();
    const planHtml = renderToStaticMarkup(
      createElement(ResourcePlanView, {
        dispatch: async (event) => transition(state, event),
        onNavigate: () => undefined,
        state
      })
    );
    const clarificationHtml = renderClarification(state);

    expect(planHtml).toContain("取消任务");
    expect(clarificationHtml).toContain("取消任务");
  });

  it("offers a global stop action for any cancellable task", () => {
    const state = createWaitingApprovalState();
    const html = renderToStaticMarkup(
      createElement(AgentTopBar, {
        modelConnection: {
          status: "unconfigured",
          activeProvider: "local-rule",
          configured: false,
          endpointHost: null,
          model: null,
          providerId: null,
          endpointMode: null,
          lastCheckedAt: null
        },
        onCancelTask: () => undefined,
        state
      })
    );

    expect(html).toContain("停止当前任务");
  });

  it("uses the unified cancellation flow from execution and returns home", async () => {
    const state: AgentState = {
      ...createTaskPlanningState(),
      phase: "downloading"
    };
    const cancelled = transition(state, {
      type: "CANCEL_TASK",
      cancelledAt: "2026-08-10T09:05:00.000Z"
    });
    const dispatch = vi.fn(async (event: AgentUserEvent) =>
      event.type === "CANCEL_TASK" ? cancelled : state
    );
    const onNavigate = vi.fn();
    const view = ExecutionView({
      capabilities: {
        domainSkills: [],
        sourceProviders: [],
        workspaceTemplates: [],
        downloadTransport: { mode: "http" as const, sdkConfigured: false, label: "受控 HTTPS 下载" }
      },
      dispatch,
      modelConnection: {
        status: "unconfigured",
        activeProvider: "local-rule",
        configured: false,
        endpointHost: null,
        model: null,
        providerId: null,
        endpointMode: null,
        lastCheckedAt: null
      },
      onNavigate,
      state
    });
    const cancelButton = findButtonByText(view, "取消任务");

    expect(cancelButton).not.toBeNull();
    await cancelButton?.props.onClick?.();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: "CANCEL_TASK" });
    expect(onNavigate).toHaveBeenCalledWith("home");
  });

  it("does not allow a second task to replace one that must be cancelled first", () => {
    const active = createTaskPlanningState();
    const replacement = transition(active, {
      type: "SUBMIT_TASK",
      task: "另一个任务",
      taskId: "replacement-task"
    });
    const html = renderToStaticMarkup(
      createElement(AgentHomeView, {
        capabilities: {
          domainSkills: [],
          sourceProviders: [],
          workspaceTemplates: [],
          downloadTransport: { mode: "http" as const, sdkConfigured: false, label: "受控 HTTPS 下载" }
        },
        dispatch: async (event) => transition(active, event),
        onNavigate: () => undefined,
        state: active
      })
    );

    expect(replacement).toBe(active);
    expect(html).toContain(
      "请先返回当前澄清或计划页面取消任务，再开始新任务"
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="请先返回当前澄清或计划页面取消任务，再开始新任务"/u);
  });
});
