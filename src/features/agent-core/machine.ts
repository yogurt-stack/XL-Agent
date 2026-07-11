import { catalogById, clarificationQuestions, windows11Profile } from "./catalog";
import type {
  AgentEvent,
  AgentLogEntry,
  AgentState,
  PlannedResource,
  ReplanReason,
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

function createLog(state: AgentState, level: AgentLogEntry["level"], message: string): AgentLogEntry {
  const id = state.logs.length + 1;
  return { id, at: `事件 ${id}`, level, message };
}

function withLog(state: AgentState, level: AgentLogEntry["level"], message: string): AgentState {
  return { ...state, logs: [...state.logs, createLog(state, level, message)] };
}

function toPlannedResource(resource: TrustedResource, selected: boolean): PlannedResource {
  return {
    ...resource,
    selected,
    status: "pending",
    progress: 0,
    attempts: 0
  };
}

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

function prepareDownloads(resources: PlannedResource[]) {
  const queued = resources.map((resource) => {
    if (!resource.selected || resource.status === "downloaded" || resource.status === "verified") {
      return resource;
    }

    return { ...resource, status: "queued" as ResourceStatus, progress: 0, failureReason: undefined };
  });

  return setNextDownload(queued);
}

function replacementFor(resource: PlannedResource): PlannedResource {
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

function buildReplacementPlan(state: AgentState): PlannedResource[] {
  const failedResource = state.resources.find((resource) => resource.status === "failed");
  if (!failedResource) {
    return state.resources;
  }

  return state.resources.map((resource) => {
    if (resource.id === failedResource.id) {
      return replacementFor(resource);
    }

    if (resource.status === "failed") {
      return { ...resource, status: "pending", progress: 0, failureReason: undefined };
    }

    return resource;
  });
}

function enterReplanning(
  state: AgentState,
  resourceId: string,
  reason: ReplanReason,
  message: string
): AgentState {
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
      replanReason: reason
    },
    "warning",
    `${message}，进入重规划。`
  );
}

function hasRequiredSelection(resources: PlannedResource[]) {
  return resources.every((resource) => !resource.required || resource.selected);
}

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
    activeResourceId: null,
    logs: [],
    workspace: {
      ready: false,
      files: handoffFiles,
      nextAction: "等待任务输入。"
    }
  };
}

export function getActiveClarification(state: AgentState) {
  return state.phase === "clarifying" ? state.clarifications[state.clarificationIndex] ?? null : null;
}

export function transition(state: AgentState, event: AgentEvent): AgentState {
  switch (event.type) {
    case "RESET":
      return createInitialAgentState();

    case "SUBMIT_TASK": {
      const task = event.task.trim();
      if (!task || state.phase === "downloading" || state.phase === "verifying") return state;

      return withLog(
        {
          ...createInitialAgentState(),
          task,
          phase: "routing",
          workspace: { ready: false, files: handoffFiles, nextAction: "等待路由判断。" }
        },
        "info",
        "收到任务，正在依据 Windows 11 x64 系统画像执行路由判断。"
      );
    }

    case "ROUTE_RESOLVED":
      if (state.phase !== "routing") return state;
      return withLog(
        { ...state, phase: "clarifying", route: "windows-ai-development", clarificationIndex: 0 },
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
      return enterReplanning(state, event.resourceId, "download_failed", event.reason);

    case "REPLAN_GENERATED":
      if (state.phase !== "replanning") return state;
      return withLog(
        {
          ...state,
          phase: "waiting_approval",
          revision: state.revision + 1,
          resources: buildReplacementPlan(state),
          activeResourceId: null,
          workspace: { ...state.workspace, nextAction: "替代计划需再次确认后才会执行。" }
        },
        "success",
        `已生成替代资源计划 r${state.revision + 1}，等待再次确认。`
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
          }
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
