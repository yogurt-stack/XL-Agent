import { catalogById, clarificationQuestions, windows11Profile } from "./catalog";
import type {
  AgentEvent,
  AgentLogEntry,
  AgentState,
  PlannedResource,
  ReplanReason,
  ReplanStrategy,
  ResourceStatus,
  TrustedResource
} from "./types";

const primaryCatalogIds = ["python-312", "vscode", "git", "node-lts", "sample-project"];

const handoffFiles = [
  "README.md",
  "RESOURCE_MANIFEST.md",
  "AGENTS.md",
  "resource-manifest.json",
  "scripts/bootstrap.ps1",
  "scripts/verify-environment.ps1"
];

/**
 * 创建一条顺序编号的 Agent 日志。
 * @param state 当前 Agent 状态，用于计算下一条日志编号。
 * @param level 日志级别。
 * @param message 日志内容。
 * @returns 新的日志条目，不修改当前状态。
 */
function createLog(state: AgentState, level: AgentLogEntry["level"], message: string): AgentLogEntry {
  const id = state.logs.length + 1;
  return { id, at: `事件 ${id}`, level, message };
}

/**
 * 在现有状态末尾追加一条日志。
 * @param state 当前 Agent 状态。
 * @param level 要追加的日志级别。
 * @param message 要追加的日志内容。
 * @returns 包含新日志的 Agent 状态副本。
 */
function withLog(state: AgentState, level: AgentLogEntry["level"], message: string): AgentState {
  return { ...state, logs: [...state.logs, createLog(state, level, message)] };
}

/**
 * 将可信资源目录条目转换为计划资源。
 * @param resource 可信资源目录中的原始资源。
 * @param selected 资源是否默认被用户选中。
 * @returns 初始化为待确认、零进度的计划资源。
 */
function toPlannedResource(resource: TrustedResource, selected: boolean): PlannedResource {
  return {
    ...resource,
    selected,
    status: "pending",
    progress: 0,
    attempts: 0
  };
}

/**
 * 根据可信目录和澄清答案生成第一版资源计划。
 * @param state 当前 Agent 状态，读取工作负载澄清答案。
 * @returns 按固定目录顺序生成的计划资源数组。
 */
function createInitialPlan(state: AgentState): PlannedResource[] {
  const fullStack = state.answers["primary-workload"] === "全栈 AI 应用";

  return primaryCatalogIds.map((resourceId) => {
    const resource = catalogById.get(resourceId);
    if (!resource) {
      throw new Error(`Trusted catalog resource is missing: ${resourceId}`);
    }

    return toPlannedResource(resource, resource.required || (resource.id === "node-lts" && fullStack));
  });
}

/**
 * 将模型提出的资源 ID 转换为可信目录中的计划资源。
 * @param resourceIds 模型建议的可信资源 ID 列表。
 * @returns 去重并过滤未知 ID 后的计划资源数组。
 */
function createModelPlan(resourceIds: string[]): PlannedResource[] {
  return [...new Set(resourceIds)].flatMap((resourceId) => {
    const resource = catalogById.get(resourceId);
    return resource ? [toPlannedResource(resource, true)] : [];
  });
}

/**
 * 从等待队列中选择下一项资源并标记为下载中。
 * @param resources 当前计划资源数组。
 * @returns 更新后的资源数组及当前活动资源 ID；无待下载项时 ID 为 null。
 */
function setNextDownload(resources: PlannedResource[]): {
  resources: PlannedResource[];
  activeResourceId: string | null;
} {
  const next = resources.find((resource) => resource.selected && resource.status === "queued");
  if (!next) {
    return { resources, activeResourceId: null };
  }

  return {
    activeResourceId: next.id,
    resources: resources.map((resource) =>
      resource.id === next.id
        ? { ...resource, status: "downloading", attempts: resource.attempts + 1 }
        : resource
    )
  };
}

/**
 * 将已选择且未完成的资源放入下载队列，并启动第一项下载。
 * @param resources 用户确认前的计划资源数组。
 * @returns 更新后的资源数组及第一项活动资源 ID。
 */
function prepareDownloads(resources: PlannedResource[]) {
  const queued = resources.map((resource) => {
    if (!resource.selected || resource.status === "downloaded" || resource.status === "verified") {
      return resource;
    }

    return { ...resource, status: "queued" as ResourceStatus, progress: 0, failureReason: undefined };
  });

  return setNextDownload(queued);
}

/**
 * 根据重规划策略为失败资源生成重试项或可信替代项。
 * @param resource 需要重规划的失败资源。
 * @param strategy 使用可信备用源或继续重试主来源的策略。
 * @returns 已重置执行状态的替代计划资源。
 */
function replacementFor(resource: PlannedResource, strategy: ReplanStrategy): PlannedResource {
  if (strategy === "primary-retry") {
    return {
      ...resource,
      selected: true,
      status: "pending",
      progress: 0,
      attempts: 0,
      failureReason: undefined
    };
  }

  const fallback = resource.fallbackId ? catalogById.get(resource.fallbackId) : undefined;
  if (!fallback) {
    return {
      ...resource,
      selected: true,
      status: "pending",
      progress: 0,
      attempts: 0,
      failureReason: undefined
    };
  }

  return {
    ...toPlannedResource(fallback, true),
    replacedFrom: resource.id
  };
}

/**
 * 替换计划中的失败资源，并保留其他资源的当前结果。
 * @param state 当前处于重规划阶段的 Agent 状态。
 * @param strategy 本次重规划采用的资源替代策略。
 * @returns 新的资源计划数组；没有失败资源时返回原数组。
 */
function buildReplacementPlan(state: AgentState, strategy: ReplanStrategy): PlannedResource[] {
  const failedResource = state.resources.find((resource) => resource.status === "failed");
  if (!failedResource) {
    return state.resources;
  }

  return state.resources.map((resource) => {
    if (resource.id === failedResource.id) {
      return replacementFor(resource, strategy);
    }

    if (resource.status === "failed") {
      return { ...resource, status: "pending", progress: 0, failureReason: undefined };
    }

    return resource;
  });
}

/**
 * 标记指定资源失败，并将任务切换到重规划阶段。
 * @param state 当前 Agent 状态。
 * @param resourceId 触发重规划的资源 ID。
 * @param reason 结构化的重规划原因。
 * @param message 面向日志和失败详情的说明。
 * @returns 进入 replanning 阶段并追加警告日志的新状态。
 */
function enterReplanning(
  state: AgentState,
  resourceId: string,
  reason: ReplanReason,
  message: string
): AgentState {
  const failedResource = state.resources.find((resource) => resource.id === resourceId);
  const requestedReplanStrategy =
    state.requestedReplanStrategy ??
    (state.answers["mirror-policy"] === "允许备用镜像" && failedResource?.fallbackId
      ? "trusted-mirror"
      : "primary-retry");
  const resources = state.resources.map((resource) =>
    resource.id === resourceId
      ? { ...resource, status: "failed" as ResourceStatus, failureReason: message }
      : resource
  );

  return withLog(
    {
      ...state,
      phase: "replanning",
      resources,
      activeResourceId: null,
      replanReason: reason,
      requestedReplanStrategy,
      agentRun: { ...state.agentRun, status: "thinking" }
    },
    "warning",
    `${message}，进入重规划。`
  );
}

/**
 * 记录可恢复的下载失败，并暂停自动流程等待用户选择恢复方式。
 * @param state 当前下载状态。
 * @param resourceId 下载失败的资源 ID。
 * @param message 工具返回的失败原因。
 * @returns 进入 awaiting_failure_action 阶段的新状态。
 */
function enterFailureResolution(state: AgentState, resourceId: string, message: string): AgentState {
  const resources = state.resources.map((resource) =>
    resource.id === resourceId
      ? { ...resource, status: "failed" as ResourceStatus, failureReason: message }
      : resource
  );

  return withLog(
    {
      ...state,
      phase: "awaiting_failure_action",
      resources,
      activeResourceId: null,
      replanReason: "download_failed",
      requestedReplanStrategy: null,
      agentRun: { ...state.agentRun, status: "idle" },
      workspace: { ...state.workspace, nextAction: "选择重试、可信替代来源或交给 Agent B。" }
    },
    "error",
    `${message}，等待用户选择恢复方式。`
  );
}

/**
 * 检查所有必需资源是否仍被选中。
 * @param resources 当前资源计划。
 * @returns 所有必需资源均已选择时返回 true，否则返回 false。
 */
function hasRequiredSelection(resources: PlannedResource[]) {
  return resources.every((resource) => !resource.required || resource.selected);
}

/**
 * 创建一份全新的 Agent 初始状态。
 * @returns 使用固定 Windows 11 x64 画像、澄清问题和交接文件清单的 intake 状态。
 */
export function createInitialAgentState(): AgentState {
  return {
    phase: "intake",
    revision: 0,
    task: "",
    route: null,
    systemProfile: windows11Profile,
    clarifications: clarificationQuestions,
    clarificationIndex: 0,
    answers: {},
    resources: [],
    replanReason: null,
    requestedReplanStrategy: null,
    activeResourceId: null,
    logs: [],
    workspace: {
      ready: false,
      files: handoffFiles,
      nextAction: "等待任务输入。"
    },
    planExplanation: null,
    agentRun: {
      step: 0,
      maxSteps: 6,
      status: "idle",
      decisions: [],
      toolResults: [],
      policyAudit: []
    }
  };
}

/**
 * 获取当前应该展示的单个澄清问题。
 * @param state 当前 Agent 状态。
 * @returns clarifying 阶段对应的问题；其他阶段或问题已结束时返回 null。
 */
export function getActiveClarification(state: AgentState) {
  return state.phase === "clarifying" ? state.clarifications[state.clarificationIndex] ?? null : null;
}

/**
 * 按状态机规则处理一个事件并计算下一状态。
 * @param state 事件发生前的 Agent 状态。
 * @param event 用户或 Runtime 派发的 Agent 事件。
 * @returns 合法事件对应的新状态；事件不适用于当前阶段时返回原状态。
 */
export function transition(state: AgentState, event: AgentEvent): AgentState {
  switch (event.type) {
    case "RESET":
      return createInitialAgentState();

    case "SUBMIT_TASK": {
      const task = event.task.trim();
      if (!task || state.phase === "downloading" || state.phase === "verifying") return state;
      const initialState = createInitialAgentState();

      return withLog(
        {
          ...initialState,
          task,
          phase: "routing",
          agentRun: { ...initialState.agentRun, status: "thinking" },
          workspace: { ready: false, files: handoffFiles, nextAction: "等待路由判断。" }
        },
        "info",
        "收到任务，正在依据 Windows 11 x64 系统画像执行路由判断。"
      );
    }

    case "ROUTE_RESOLVED":
      if (state.phase !== "routing") return state;
      return withLog(
        { ...state, phase: "clarifying", route: event.route, clarificationIndex: 0 },
        "success",
        "已路由到 Windows AI 开发环境准备 Skill，开始逐项澄清。"
      );

    case "ANSWER_CLARIFICATION": {
      const question = getActiveClarification(state);
      if (!question || question.id !== event.questionId || !event.answer.trim()) return state;
      const answers = { ...state.answers, [question.id]: event.answer };
      const nextIndex = state.clarificationIndex + 1;
      const nextPhase = nextIndex >= state.clarifications.length ? "planning" : "clarifying";
      return withLog(
        { ...state, answers, clarificationIndex: nextIndex, phase: nextPhase },
        "info",
        nextPhase === "planning" ? "澄清完成，正在生成资源计划。" : "已记录澄清答案，准备下一项关键问题。"
      );
    }

    case "SKIP_CLARIFICATION": {
      const question = getActiveClarification(state);
      if (!question || question.id !== event.questionId || question.required) return state;
      const answers = { ...state.answers, [question.id]: "skipped" as const };
      const nextIndex = state.clarificationIndex + 1;
      const nextPhase = nextIndex >= state.clarifications.length ? "planning" : "clarifying";
      return withLog(
        { ...state, answers, clarificationIndex: nextIndex, phase: nextPhase },
        "info",
        nextPhase === "planning" ? "已跳过非必填澄清，正在生成资源计划。" : "已跳过非必填澄清。"
      );
    }

    case "PLAN_GENERATED":
      if (state.phase !== "planning") return state;
      return withLog(
        {
          ...state,
          phase: "waiting_approval",
          revision: state.revision + 1,
          resources: createInitialPlan(state),
          workspace: { ...state.workspace, nextAction: "确认资源计划后开始模拟下载。" }
        },
        "success",
        `可信资源计划 r${state.revision + 1} 已生成，等待用户确认。`
      );

    case "MODEL_DECISION_RECORDED":
      if (state.agentRun.step >= state.agentRun.maxSteps) return state;
      return {
        ...state,
        agentRun: {
          ...state.agentRun,
          step: state.agentRun.step + 1,
          status: event.decision.action.type === "call_tool" ? "waiting_tool" : "thinking",
          decisions: [...state.agentRun.decisions, event.decision]
        }
      };

    case "MODEL_POLICY_RECORDED":
      return {
        ...state,
        agentRun: {
          ...state.agentRun,
          status: event.decision.outcome === "require_approval" ? "waiting_approval" : state.agentRun.status,
          policyAudit: [...state.agentRun.policyAudit, { actionId: event.actionId, decision: event.decision }]
        }
      };

    case "MODEL_TOOL_COMPLETED":
      return withLog(
        {
          ...state,
          agentRun: {
            ...state.agentRun,
            status:
              event.result.status === "success"
                ? state.phase === "downloading"
                  ? "executing"
                  : "thinking"
                : "failed",
            toolResults: [...state.agentRun.toolResults, event.result]
          }
        },
        event.result.status === "success" ? "success" : "error",
        `工具 ${event.result.tool} ${event.result.status === "success" ? "执行完成" : "执行失败"}。`
      );

    case "MODEL_CLARIFICATION_REQUESTED":
      return withLog(
        {
          ...state,
          phase: "clarifying",
          route: "windows-ai-development",
          clarifications: [event.question],
          clarificationIndex: 0,
          agentRun: { ...state.agentRun, status: "idle" }
        },
        "info",
        `模型请求澄清：${event.question.prompt}`
      );

    case "MODEL_PLAN_PROPOSED": {
      if (state.phase !== "planning") return state;
      const resources = createModelPlan(event.resourceIds);
      if (resources.length === 0) return state;
      return withLog(
        {
          ...state,
          phase: "waiting_approval",
          route: "windows-ai-development",
          revision: state.revision + 1,
          resources,
          planExplanation: event.explanation,
          agentRun: { ...state.agentRun, status: "waiting_approval" },
          workspace: { ...state.workspace, nextAction: "确认模型生成的资源计划后开始模拟下载。" }
        },
        "success",
        `模型资源计划 r${state.revision + 1} 已生成，等待用户确认。`
      );
    }

    case "MODEL_REPLAN_PROPOSED":
      if (state.phase !== "replanning") return state;
      if (state.requestedReplanStrategy && event.strategy !== state.requestedReplanStrategy) return state;
      return withLog(
        {
          ...state,
          phase: "waiting_approval",
          revision: state.revision + 1,
          resources: buildReplacementPlan(state, event.strategy),
          activeResourceId: null,
          requestedReplanStrategy: null,
          planExplanation: event.explanation,
          agentRun: { ...state.agentRun, status: "waiting_approval" },
          workspace: { ...state.workspace, nextAction: "模型替代计划需再次确认后才会执行。" }
        },
        "success",
        `模型已生成${event.strategy === "trusted-mirror" ? "可信备用来源" : "主来源重试"}计划 r${state.revision + 1}，等待再次确认。`
      );

    case "MODEL_FINISHED":
      return withLog(
        {
          ...state,
          agentRun: { ...state.agentRun, status: "complete" },
          workspace: { ...state.workspace, nextAction: event.summary }
        },
        "success",
        event.summary
      );

    case "MODEL_STEP_LIMIT_REACHED":
      return withLog(
        {
          ...state,
          phase: "cancelled",
          agentRun: { ...state.agentRun, status: "failed" },
          activeResourceId: null
        },
        "error",
        `模型已达到 ${state.agentRun.maxSteps} 步安全上限，任务停止。`
      );

    case "MODEL_RUNTIME_FAILED":
      return withLog(
        {
          ...state,
          phase: "cancelled",
          agentRun: { ...state.agentRun, status: "failed" },
          activeResourceId: null
        },
        "error",
        `模型运行失败：${event.reason}`
      );

    case "TOGGLE_RESOURCE": {
      if (state.phase !== "waiting_approval") return state;
      const resource = state.resources.find((item) => item.id === event.resourceId);
      if (!resource || resource.selected === event.selected) return state;
      if (resource.required && !event.selected) {
        return enterReplanning(
          state,
          resource.id,
          "required_resource_cancelled",
          `用户取消了必需资源 ${resource.name}`
        );
      }

      return withLog(
        {
          ...state,
          resources: state.resources.map((item) =>
            item.id === event.resourceId ? { ...item, selected: event.selected } : item
          )
        },
        "info",
        `${event.selected ? "已选择" : "已取消"}可选资源 ${resource.name}。`
      );
    }

    case "APPROVE_PLAN": {
      if (state.phase !== "waiting_approval" || !hasRequiredSelection(state.resources)) return state;
      const prepared = prepareDownloads(state.resources);
      return withLog(
        {
          ...state,
          phase: "downloading",
          resources: prepared.resources,
          activeResourceId: prepared.activeResourceId,
          replanReason: null,
          requestedReplanStrategy: null,
          agentRun: { ...state.agentRun, step: 0, status: "executing" },
          workspace: { ...state.workspace, nextAction: "等待资源下载和验证完成。" }
        },
        "success",
        `用户确认资源计划 r${state.revision}，开始模拟下载。`
      );
    }

    case "DOWNLOAD_PROGRESS": {
      if (state.phase !== "downloading" || state.activeResourceId !== event.resourceId) return state;
      const progress = Math.max(0, Math.min(100, event.progress));
      const resources = state.resources.map((resource) =>
        resource.id === event.resourceId
          ? { ...resource, progress, status: progress === 100 ? ("downloaded" as ResourceStatus) : resource.status }
          : resource
      );
      if (progress < 100) return { ...state, resources };

      const withNext = setNextDownload(resources);
      if (withNext.activeResourceId) {
        return withLog(
          { ...state, resources: withNext.resources, activeResourceId: withNext.activeResourceId },
          "success",
          `资源 ${event.resourceId} 已完成，继续下一项下载。`
        );
      }

      return withLog(
        { ...state, phase: "verifying", resources, activeResourceId: null },
        "success",
        "所有已选择资源下载完成，开始验证版本与清单。"
      );
    }

    case "DOWNLOAD_FAILED":
      if (state.phase !== "downloading" || state.activeResourceId !== event.resourceId) return state;
      return enterFailureResolution(state, event.resourceId, event.reason);

    case "RESOLVE_DOWNLOAD_FAILURE": {
      if (state.phase !== "awaiting_failure_action") return state;
      const failedResource = state.resources.find((resource) => resource.status === "failed");
      if (!failedResource) return state;

      if (event.action === "delegate-agent-b") {
        return withLog(
          {
            ...state,
            phase: "handoff",
            agentRun: { ...state.agentRun, status: "delegated" },
            workspace: {
              ready: false,
              generatedAt: `mock-delegation-revision-${state.revision}`,
              files: handoffFiles,
              nextAction: `Agent B 处理 ${failedResource.name}：${failedResource.failureReason ?? "下载失败"}`
            }
          },
          "warning",
          `已将 ${failedResource.name} 的失败上下文和当前资源清单交给 Agent B。`
        );
      }

      if (event.action === "trusted-mirror" && !failedResource.fallbackId) return state;
      return withLog(
        {
          ...state,
          phase: "replanning",
          requestedReplanStrategy: event.action,
          agentRun: { ...state.agentRun, status: "thinking" },
          workspace: { ...state.workspace, nextAction: "等待模型生成新的待审批资源计划。" }
        },
        "info",
        event.action === "trusted-mirror"
          ? `用户要求为 ${failedResource.name} 生成可信替代来源计划。`
          : `用户要求重试 ${failedResource.name} 的主来源。`
      );
    }

    case "REPLAN_GENERATED":
      if (state.phase !== "replanning") return state;
      if (state.requestedReplanStrategy && event.strategy !== state.requestedReplanStrategy) return state;
      return withLog(
        {
          ...state,
          phase: "waiting_approval",
          revision: state.revision + 1,
          resources: buildReplacementPlan(state, event.strategy),
          activeResourceId: null,
          requestedReplanStrategy: null,
          agentRun: { ...state.agentRun, status: "waiting_approval" },
          workspace: { ...state.workspace, nextAction: "替代计划需再次确认后才会执行。" }
        },
        "success",
        `已生成${event.strategy === "trusted-mirror" ? "可信备用来源" : "主来源重试"}计划 r${state.revision + 1}，等待再次确认。`
      );

    case "VERIFY_RESOURCES": {
      if (state.phase !== "verifying") return state;
      if (event.versionMismatchResourceId) {
        const resource = state.resources.find((item) => item.id === event.versionMismatchResourceId);
        if (!resource) return state;
        return enterReplanning(
          state,
          resource.id,
          "version_mismatch",
          `验证发现 ${resource.name} 的版本与可信目录不匹配`
        );
      }

      return withLog(
        {
          ...state,
          phase: "handoff",
          resources: state.resources.map((resource) =>
            resource.selected && resource.status === "downloaded"
              ? { ...resource, status: "verified" as ResourceStatus }
              : resource
          ),
          workspace: {
            ready: true,
            generatedAt: `mock-session-revision-${state.revision}`,
            files: handoffFiles,
            nextAction: "阅读 README.md，再执行 scripts/bootstrap.ps1。"
          },
          agentRun: { ...state.agentRun, status: "complete" }
        },
        "success",
        "验证通过，已生成工作区交接包。"
      );
    }

    case "CANCEL_TASK":
      if (state.phase === "handoff" || state.phase === "cancelled" || state.phase === "intake") return state;
      return withLog(
        { ...state, phase: "cancelled", activeResourceId: null },
        "warning",
        "用户取消了当前任务。"
      );

    default:
      return state;
  }
}
