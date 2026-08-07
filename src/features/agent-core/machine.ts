import { catalogById, clarificationQuestions, windows11Profile } from "./catalog";
import { validatePlannedResources, validatePlanResourceIds } from "./planValidation";
import {
  githubAcquisitionRequirements,
  validateGitHubAcquisitionPlan
} from "./githubAcquisition";
import {
  isGitHubRepositorySearchOutput,
  latestGitHubRepositorySearchResult
} from "./githubSearch";
import { isSystemProfileToolOutput } from "./systemProfile";
import { deriveTaskRequirements } from "./taskRequirements";
import {
  approveTaskPlanStep,
  beginTaskPlanReplanning,
  cancelTaskPlan,
  completeTaskPlanStep,
  confirmTaskPlan,
  defaultTaskPlanToolPolicies,
  extendCompletedTaskPlan,
  failTaskPlanStep,
  prepareTaskPlanForConfirmation,
  requestTaskPlanStepApproval,
  requestTaskPlanStepInput,
  reviseTaskPlan,
  resumeTaskPlanStepAfterInput,
  startTaskPlanStep,
  suspendTaskPlanStepForInput,
  validateTaskPlan
} from "./taskPlan";
import type {
  AgentEvent,
  AgentLogEntry,
  AgentState,
  PlannedResource,
  ReplanReason,
  ReplanStrategy,
  ResourceStatus,
  TaskPlanProposal,
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

function applyLocalArtifactMatches(
  resources: PlannedResource[],
  state: AgentState
) {
  const matchedIds = new Set(
    state.localArtifacts.flatMap((artifact) =>
      artifact.matchedResourceId ? [artifact.matchedResourceId] : []
    )
  );
  return resources.map((resource) =>
    matchedIds.has(resource.id)
      ? {
          ...resource,
          selected: true,
          status: "downloaded" as const,
          progress: 100
        }
      : resource
  );
}

/**
 * 根据可信目录和澄清答案生成第一版资源计划。
 * @param state 当前 Agent 状态，读取工作负载澄清答案。
 * @returns 按固定目录顺序生成的计划资源数组。
 */
function createInitialPlan(state: AgentState): PlannedResource[] {
  const fullStack = state.answers["primary-workload"] === "全栈 AI 应用";

  return applyLocalArtifactMatches(primaryCatalogIds.map((resourceId) => {
    const resource = catalogById.get(resourceId);
    if (!resource) {
      throw new Error(`Trusted catalog resource is missing: ${resourceId}`);
    }

    return toPlannedResource(resource, resource.required || (resource.id === "node-lts" && fullStack));
  }), state);
}

/**
 * 将模型提出的资源 ID 转换为可信目录中的计划资源。
 * @param resourceIds 模型建议的可信资源 ID 列表。
 * @returns 去重并过滤未知 ID 后的计划资源数组。
 */
function createModelPlan(
  resourceIds: string[],
  state: AgentState
): PlannedResource[] {
  return applyLocalArtifactMatches([...new Set(resourceIds)].flatMap((resourceId) => {
    const resource = catalogById.get(resourceId);
    return resource ? [toPlannedResource(resource, true)] : [];
  }), state);
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
  if (!fallback || fallback.catalogStatus !== "active") {
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
    (state.answers["mirror-policy"] !== "仅使用主来源" && failedResource?.fallbackId
      ? "trusted-mirror"
      : "primary-retry");
  const resources = state.resources.map((resource) =>
    resource.id === resourceId
      ? { ...resource, status: "failed" as ResourceStatus, failureReason: message }
      : resource
  );
  const replanningState: AgentState = {
    ...state,
    phase: "replanning",
    resources,
    activeResourceId: null,
    replanReason: reason,
    requestedReplanStrategy,
    approvedRevision: null,
    agentRun: { ...state.agentRun, status: "thinking" }
  };
  const revisedAt =
    state.taskPlan?.updatedAt ?? new Date(0).toISOString();
  const taskPlanRevision = reviseTaskPlanForRecovery(
    replanningState,
    message,
    revisedAt
  );

  return withLog(
    {
      ...replanningState,
      phase: taskPlanRevision
        ? "waiting_task_plan_confirmation"
        : "replanning",
      taskPlan: taskPlanRevision?.taskPlan ?? state.taskPlan,
      taskPlanValidation:
        taskPlanRevision?.validation ?? state.taskPlanValidation,
      agentRun: taskPlanRevision
        ? { ...state.agentRun, status: "waiting_approval" }
        : replanningState.agentRun
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
    taskId: "unassigned",
    phase: "intake",
    revision: 0,
    task: "",
    route: null,
    routeDecision: null,
    taskPlan: null,
    taskPlanValidation: null,
    systemProfile: windows11Profile,
    hostProfile: null,
    clarifications: clarificationQuestions,
    clarificationIndex: 0,
    answers: {},
    resources: [],
    localArtifacts: [],
    localRepository: null,
    githubPublish: {
      status: "idle",
      plan: null,
      approvedAt: null,
      result: null,
      error: null,
      partialRepositoryUrl: null
    },
    replanReason: null,
    requestedReplanStrategy: null,
    activeResourceId: null,
    logs: [],
    workspace: {
      ready: false,
      files: handoffFiles,
      nextAction: "等待任务输入。",
      exportStatus: "not_started",
      manifestRevision: 0,
      overallStatus: "preparing",
      fileRecords: []
    },
    planExplanation: null,
    taskRequirements: null,
    planValidation: null,
    approvedRevision: null,
    agentRun: {
      step: 0,
      maxSteps: 6,
      status: "idle",
      decisions: [],
      toolResults: [],
      policyAudit: []
    },
    agentB: {
      status: "idle",
      runId: null,
      grantId: null,
      manifestRevision: null,
      answer: null,
      error: null
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

function resolveTaskPlanClarification(
  state: AgentState,
  questionId: string,
  answer: string,
  resolvedAt: string
) {
  const plan = state.taskPlan;
  const step = plan?.steps.find(
    (candidate) => candidate.status === "waiting_user_input"
  );
  if (!plan || !step) return plan;
  if (step.kind === "user_decision") {
    const plannedQuestionId = step.staticInput.questionId;
    if (
      typeof plannedQuestionId === "string" &&
      plannedQuestionId !== questionId
    ) {
      return plan;
    }
    return completeTaskPlanStep(plan, {
      stepId: step.id,
      completedAt: resolvedAt,
      result: {
        reference: `user-answer:${questionId}`,
        summary: `用户已回答：${answer}`,
        output: { questionId, answer }
      }
    });
  }
  if (step.kind === "resource_plan") {
    return resumeTaskPlanStepAfterInput(plan, step.id, resolvedAt);
  }
  return plan;
}

function requestNextPlannedClarification(
  plan: AgentState["taskPlan"],
  questionId: string | undefined,
  requestedAt: string
) {
  if (!plan || !questionId || plan.status !== "executing") return plan;
  const step = plan.steps.find(
    (candidate) =>
      candidate.status === "pending" &&
      candidate.kind === "user_decision" &&
      candidate.staticInput.questionId === questionId
  );
  if (!step) return plan;
  try {
    return requestTaskPlanStepInput(plan, step.id, requestedAt);
  } catch {
    return plan;
  }
}

function proposalFromTaskPlan(plan: NonNullable<AgentState["taskPlan"]>) {
  return {
    objective: plan.objective,
    deliverables: [...plan.deliverables],
    assumptions: [...plan.assumptions],
    constraints: [...plan.constraints],
    steps: plan.steps.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description,
      kind: step.kind,
      tool: step.tool,
      dependsOn: [...step.dependsOn],
      staticInput: structuredClone(step.staticInput),
      inputBindings: structuredClone(step.inputBindings),
      expectedOutput: step.expectedOutput,
      risk: step.risk,
      approval: {
        required: step.approval.required,
        reason: step.approval.reason
      }
    })),
    confirmation: {
      required: plan.confirmation.required,
      reason: plan.confirmation.reason
    }
  };
}

function reviseTaskPlanForRecovery(
  state: AgentState,
  reason: string,
  revisedAt: string
) {
  const plan = state.taskPlan;
  if (!plan) return null;
  try {
    const running = plan.steps.find((step) =>
      ["running", "waiting_user_input", "waiting_approval"].includes(
        step.status
      )
    );
    const failed = running
      ? failTaskPlanStep(plan, running.id, reason, revisedAt)
      : plan;
    const replanning = beginTaskPlanReplanning(failed, revisedAt);
    const preservedStepIds = replanning.steps
      .filter(
        (step) =>
          step.status === "completed" &&
          (step.kind === "user_decision" || step.kind === "read_tool")
      )
      .map((step) => step.id);
    const draft = reviseTaskPlan(replanning, {
      proposal: proposalFromTaskPlan(replanning),
      reason,
      revisedAt,
      createdBy: "local-rule",
      preserveCompletedStepIds: preservedStepIds
    });
    const validationContext = {
      tools: defaultTaskPlanToolPolicies,
      requireInitialConfirmation: true
    };
    const validation = validateTaskPlan(draft, validationContext);
    const taskPlan = prepareTaskPlanForConfirmation(
      draft,
      validationContext,
      revisedAt
    );
    return { taskPlan, validation };
  } catch {
    return null;
  }
}

function failOrCancelTaskPlan(state: AgentState, reason: string) {
  const plan = state.taskPlan;
  if (!plan || plan.status === "completed" || plan.status === "cancelled") {
    return plan;
  }
  const active = plan.steps.find((step) =>
    ["running", "waiting_user_input", "waiting_approval"].includes(
      step.status
    )
  );
  try {
    return active
      ? failTaskPlanStep(plan, active.id, reason, plan.updatedAt)
      : cancelTaskPlan(plan, plan.updatedAt);
  } catch {
    return plan;
  }
}

function localAcquisitionExtensionProposal(
  objective: string,
  downloadTitle: string,
  downloadDescription: string
): TaskPlanProposal {
  return {
    objective,
    deliverables: ["经验证的本地资源", "更新后的工作区与 Manifest"],
    assumptions: ["资源详情和不可变版本已经由上一阶段固定。"],
    constraints: [
      "只处理当前资源 revision 中已选择的资源。",
      "不会执行仓库代码、安装依赖或运行脚本。"
    ],
    steps: [
      {
        id: "download-extension-resources",
        title: downloadTitle,
        description: downloadDescription,
        kind: "write_tool",
        tool: "controlled_download",
        dependsOn: [],
        staticInput: {},
        inputBindings: {},
        expectedOutput: "写入受控临时目录的固定版本文件",
        risk: "local_write",
        approval: {
          required: true,
          reason: "该步骤会访问已固定来源并写入本地文件。"
        }
      },
      {
        id: "verify-extension-resources",
        title: "验证新增资源",
        description: "复核摘要、来源、许可证和固定版本信息。",
        kind: "verification",
        tool: null,
        dependsOn: ["download-extension-resources"],
        staticInput: {},
        inputBindings: {},
        expectedOutput: "新增资源的可审计验证记录",
        risk: "read_only",
        approval: { required: false, reason: null }
      },
      {
        id: "export-extension-workspace",
        title: "更新工作区与 Manifest",
        description: "将新增资源原子写入新的工作区快照。",
        kind: "write_tool",
        tool: "export_workspace",
        dependsOn: ["verify-extension-resources"],
        staticInput: {},
        inputBindings: {},
        expectedOutput: "包含新增资源的工作区快照",
        risk: "local_write",
        approval: {
          required: true,
          reason: "该步骤会创建新的工作区快照并更新 Manifest。"
        }
      },
      {
        id: "handoff-extension-workspace",
        title: "交接更新后的工作区",
        description: "展示新快照路径和验证摘要。",
        kind: "handoff",
        tool: null,
        dependsOn: ["export-extension-workspace"],
        staticInput: {},
        inputBindings: {},
        expectedOutput: "可供用户与 Agent B 检查的工作区",
        risk: "read_only",
        approval: { required: false, reason: null }
      }
    ],
    confirmation: {
      required: true,
      reason: "这是用户在查询或交接完成后新增的本地写入范围，需要重新确认处理流程。"
    }
  };
}

function extendCompletedPlan(
  state: AgentState,
  proposal: TaskPlanProposal,
  reason: string
) {
  if (!state.taskPlan || state.taskPlan.status !== "completed") return null;
  try {
    const draft = extendCompletedTaskPlan(state.taskPlan, {
      proposal,
      reason,
      extendedAt: state.taskPlan.updatedAt,
      createdBy: "local-rule"
    });
    const validationContext = {
      tools: defaultTaskPlanToolPolicies,
      requireInitialConfirmation: true
    };
    const validation = validateTaskPlan(draft, validationContext);
    const taskPlan = prepareTaskPlanForConfirmation(
      draft,
      validationContext,
      state.taskPlan.updatedAt
    );
    return { taskPlan, validation };
  } catch {
    return null;
  }
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
      return state.githubPublish.status === "publishing"
        ? state
        : createInitialAgentState();

    case "SUBMIT_TASK": {
      const task = event.task.trim();
      if (
        !task ||
        state.phase === "downloading" ||
        state.phase === "verifying" ||
        state.phase === "exporting" ||
        state.githubPublish.status === "publishing"
      ) {
        return state;
      }
      const initialState = createInitialAgentState();

      return withLog(
        {
          ...initialState,
          taskId: event.taskId ?? `local-task-${state.logs.length + 1}`,
          task,
          phase: "routing",
          agentRun: { ...initialState.agentRun, status: "thinking" },
          workspace: {
            ready: false,
            files: handoffFiles,
            nextAction: "等待路由判断。",
            exportStatus: "not_started",
            manifestRevision: 0,
            overallStatus: "preparing",
            fileRecords: []
          }
        },
        "info",
        "收到任务，正在依据 Windows 11 x64 系统画像执行路由判断。"
      );
    }

    case "LOCAL_REPOSITORY_IMPORTED": {
      if (
        state.phase === "downloading" ||
        state.phase === "verifying" ||
        state.phase === "exporting" ||
        state.agentB.status === "running" ||
        state.githubPublish.status === "publishing"
      ) {
        return state;
      }
      const initialState = createInitialAgentState();
      const repository = event.repository;
      return withLog(
        {
          ...initialState,
          taskId: event.taskId,
          phase: "handoff",
          revision: 1,
          task: `检查本地仓库 ${repository.displayName}`,
          route: "local-repository-import",
          routeDecision: {
            status: "supported",
            reason:
              "用户明确选择本地 Git 仓库；Main 仅执行固定用途的只读 Git 检查。",
            skillId: "local-repository-import",
            sourceProviderId: "local-git",
            userLinks: [],
            resourceIds: [],
            clarifications: [],
            requirements: {
              intent: "user-links",
              label: "本地 Git 仓库只读检查",
              requiredCapabilities: ["project-source"]
            }
          },
          localRepository: repository,
          taskRequirements: {
            intent: "user-links",
            label: "本地 Git 仓库只读检查",
            requiredCapabilities: ["project-source"]
          },
          planExplanation:
            "仓库保留在原目录；Agent 只接收脱敏元数据，不执行代码、安装依赖或修改仓库。",
          workspace: {
            ready: true,
            files: [
              "README.md",
              "RESOURCE_MANIFEST.md",
              "AGENTS.md",
              "resource-manifest.json"
            ],
            nextAction: "运行 Agent B 读取 Manifest，或单独创建 GitHub 发布计划。",
            exportStatus: "ready",
            manifestRevision: 0,
            overallStatus: "ready",
            fileRecords: []
          },
          agentRun: {
            ...initialState.agentRun,
            status: "complete"
          }
        },
        "success",
        `已只读导入本地仓库 ${repository.displayName}@${repository.commitSha.slice(0, 12)}；源目录未被修改。`
      );
    }

    case "GITHUB_PUBLISH_PLAN_PREPARED":
      if (
        state.phase !== "handoff" ||
        state.route !== "local-repository-import" ||
        state.localRepository?.repositoryHandleId !==
          event.plan.repositoryHandleId
      ) {
        return state;
      }
      return withLog(
        {
          ...state,
          githubPublish: {
            status: "waiting_approval",
            plan: event.plan,
            approvedAt: null,
            result: null,
            error: null,
            partialRepositoryUrl: null
          }
        },
        "info",
        `GitHub 发布计划已固定到 ${event.plan.targetOwner}/${event.plan.targetRepository}，等待独立审批。`
      );

    case "GITHUB_PUBLISH_STARTED":
      if (
        state.githubPublish.status !== "waiting_approval" ||
        state.githubPublish.plan?.publishId !== event.publishId
      ) {
        return state;
      }
      return withLog(
        {
          ...state,
          githubPublish: {
            ...state.githubPublish,
            status: "publishing",
            approvedAt: event.approvedAt,
            error: null
          }
        },
        "warning",
        "GitHub 发布计划已由本地用户明确批准，开始执行受控写入。"
      );

    case "GITHUB_PUBLISH_COMPLETED":
      if (
        state.githubPublish.plan?.publishId !== event.result.publishId
      ) {
        return state;
      }
      return withLog(
        {
          ...state,
          githubPublish: {
            ...state.githubPublish,
            status: "published",
            result: event.result,
            error: null,
            partialRepositoryUrl: null
          }
        },
        "success",
        `已发布到 ${event.result.fullName}@${event.result.commitSha.slice(0, 12)}。`
      );

    case "GITHUB_PUBLISH_FAILED":
      if (state.githubPublish.plan?.publishId !== event.publishId) {
        return state;
      }
      return withLog(
        {
          ...state,
          githubPublish: {
            ...state.githubPublish,
            status: "failed",
            error: event.reason,
            partialRepositoryUrl: event.partialRepositoryUrl ?? null
          }
        },
        "error",
        event.reason
      );

    case "ROUTE_RESOLVED":
      if (state.phase !== "routing") return state;
      if (event.decision.status === "unsupported") {
        return withLog(
          {
            ...state,
            phase: "unsupported",
            route: null,
            routeDecision: event.decision,
            clarifications: [],
            clarificationIndex: 0,
            taskRequirements: null,
            agentRun: { ...state.agentRun, status: "complete" },
            workspace: {
              ...state.workspace,
              nextAction: event.decision.reason
            }
          },
          "warning",
          event.decision.reason
        );
      }
      if (event.decision.status === "needs_links") {
        return withLog(
          {
            ...state,
            phase: "task_planning",
            route: "user-provided-links",
            routeDecision: event.decision,
            clarifications: event.decision.clarifications,
            clarificationIndex: 0,
            taskRequirements: event.decision.requirements,
            agentRun: { ...state.agentRun, status: "thinking" }
          },
          "success",
          "用户链接已由可信来源 Provider 精确解析，正在提出首轮 Task Plan。"
        );
      }
      return withLog(
        {
          ...state,
          phase: "task_planning",
          route: event.decision.skillId,
          routeDecision: event.decision,
          clarifications: event.decision.clarifications,
          clarificationIndex: 0,
          taskRequirements: event.decision.requirements,
          agentRun: { ...state.agentRun, status: "thinking" }
        },
        "success",
        `已路由到 ${event.decision.skillId ?? "未知"} Domain Skill，正在生成可确认的 Task Plan。`
      );

    case "TASK_PLAN_PROPOSED":
      if (
        state.phase !== "task_planning" ||
        event.plan.taskId !== state.taskId ||
        event.validation.checkedRevision !== event.plan.revision ||
        !event.validation.valid ||
        event.plan.status !== "waiting_confirmation"
      ) {
        return state;
      }
      return withLog(
        {
          ...state,
          phase: "waiting_task_plan_confirmation",
          taskPlan: event.plan,
          taskPlanValidation: event.validation,
          agentRun: { ...state.agentRun, status: "waiting_approval" },
          workspace: {
            ...state.workspace,
            nextAction: `确认 Task Plan r${event.plan.revision} 后继续；确认不会授予下载或写入权限。`
          }
        },
        "success",
        `Task Plan r${event.plan.revision} 已通过结构与权限校验，等待用户确认。`
      );

    case "TASK_PLAN_CONFIRMED": {
      if (
        state.phase !== "waiting_task_plan_confirmation" ||
        !state.taskPlan ||
        state.taskPlan.revision !== event.revision ||
        state.taskPlanValidation?.checkedRevision !== event.revision ||
        !state.taskPlanValidation.valid
      ) {
        return state;
      }
      let taskPlan;
      try {
        taskPlan = confirmTaskPlan(state.taskPlan, {
          revision: event.revision,
          confirmedAt: event.confirmedAt
        });
      } catch {
        return state;
      }
      const recovering = state.requestedReplanStrategy !== null;
      const preparedExtension =
        !recovering &&
        state.revision > 0 &&
        state.planValidation?.valid === true &&
        state.resources.some((resource) => resource.selected) &&
        taskPlan.steps.some((step) => step.approval.required);
      const requiresClarification =
        !recovering &&
        state.clarificationIndex < state.clarifications.length;
      const confirmedTaskPlan = requiresClarification
        ? requestNextPlannedClarification(
            taskPlan,
            state.clarifications[0]?.id,
            event.confirmedAt
          )
        : taskPlan;
      return withLog(
        {
          ...state,
          phase: recovering
            ? "replanning"
            : preparedExtension
              ? "waiting_approval"
            : requiresClarification
              ? "clarifying"
              : "planning",
          taskPlan: confirmedTaskPlan,
          agentRun: {
            ...state.agentRun,
            status: requiresClarification ? "idle" : "thinking"
          },
          workspace: {
            ...state.workspace,
            nextAction: recovering
              ? "按确认后的 Task Plan 生成新的资源计划 revision。"
              : preparedExtension
                ? "Task Plan 已确认，等待当前资源 revision 的独立审批。"
              : requiresClarification
              ? "按已确认的 Task Plan 完成关键需求澄清。"
              : "按已确认的 Task Plan 进入只读工具与资源规划阶段。"
          }
        },
        "info",
        `用户已确认 Task Plan r${event.revision}；下载、导出等写入步骤仍需后续独立审批。`
      );
    }

    case "TASK_PLAN_STEP_INPUT_REQUESTED": {
      if (!state.taskPlan) return state;
      const step = state.taskPlan.steps.find(
        (candidate) => candidate.id === event.stepId
      );
      if (!step) return state;
      let taskPlan;
      try {
        taskPlan = step.status === "running"
          ? suspendTaskPlanStepForInput(
              state.taskPlan,
              event.stepId,
              event.requestedAt
            )
          : requestTaskPlanStepInput(
              state.taskPlan,
              event.stepId,
              event.requestedAt
            );
      } catch {
        return state;
      }
      const repositorySelection =
        state.routeDecision?.skillId === "github-project-discovery" &&
        step.kind === "user_decision" &&
        step.staticInput.interaction === "repository_selection" &&
        (() => {
          const searchResult = latestGitHubRepositorySearchResult(state);
          return searchResult?.status === "success" &&
            isGitHubRepositorySearchOutput(searchResult.output);
        })();
      return withLog(
        {
          ...state,
          taskPlan,
          phase: repositorySelection ? "result" : "clarifying",
          agentRun: { ...state.agentRun, status: "idle" }
        },
        "info",
        `Task Plan 步骤 ${step.title} 正在等待用户输入。`
      );
    }

    case "TASK_PLAN_STEP_STARTED": {
      if (!state.taskPlan) return state;
      try {
        const taskPlan = startTaskPlanStep(
          state.taskPlan,
          event.stepId,
          event.startedAt
        );
        return withLog(
          {
            ...state,
            taskPlan,
            agentRun: { ...state.agentRun, status: "executing" }
          },
          "info",
          `Task Plan 开始执行步骤 ${event.stepId}。`
        );
      } catch {
        return state;
      }
    }

    case "TASK_PLAN_STEP_COMPLETED": {
      if (!state.taskPlan) return state;
      try {
        const taskPlan = completeTaskPlanStep(state.taskPlan, {
          stepId: event.stepId,
          completedAt: event.completedAt,
          result: event.result
        });
        const terminal = event.terminalPhase ?? null;
        return withLog(
          {
            ...state,
            taskPlan,
            phase: terminal ?? state.phase,
            agentRun: {
              ...state.agentRun,
              status: taskPlan.status === "completed"
                ? "complete"
                : state.agentRun.status
            },
            workspace: terminal === "result"
              ? {
                  ...state.workspace,
                  nextAction: event.result.summary
                }
              : state.workspace
          },
          "success",
          `Task Plan 步骤 ${event.stepId} 已完成：${event.result.summary}`
        );
      } catch {
        return state;
      }
    }

    case "TASK_PLAN_STEP_FAILED": {
      if (!state.taskPlan) return state;
      try {
        const failed = failTaskPlanStep(
          state.taskPlan,
          event.stepId,
          event.reason,
          event.failedAt
        );
        const taskPlan = event.replanning
          ? beginTaskPlanReplanning(failed, event.failedAt)
          : failed;
        return withLog(
          { ...state, taskPlan },
          "error",
          `Task Plan 步骤 ${event.stepId} 失败：${event.reason}`
        );
      } catch {
        return state;
      }
    }

    case "TASK_PLAN_STEP_APPROVAL_REQUESTED": {
      if (!state.taskPlan) return state;
      try {
        const taskPlan = requestTaskPlanStepApproval(
          state.taskPlan,
          event.stepId,
          event.requestedAt
        );
        return withLog(
          {
            ...state,
            taskPlan,
            agentRun: { ...state.agentRun, status: "waiting_approval" }
          },
          "info",
          `Task Plan 步骤 ${event.stepId} 等待当前资源计划审批。`
        );
      } catch {
        return state;
      }
    }

    case "TASK_PLAN_STEP_AUTO_APPROVED": {
      if (!state.taskPlan) return state;
      try {
        const waiting = requestTaskPlanStepApproval(
          state.taskPlan,
          event.stepId,
          event.approvedAt
        );
        const taskPlan = approveTaskPlanStep(waiting, {
          stepId: event.stepId,
          revision: event.revision,
          approvedAt: event.approvedAt
        });
        return withLog(
          { ...state, taskPlan },
          "info",
          `Task Plan 步骤 ${event.stepId} 继承当前资源计划 r${event.revision} 的本地写入审批。`
        );
      } catch {
        return state;
      }
    }

    case "TASK_REQUIREMENTS_RESOLVED":
      if (state.phase !== "planning" || state.taskRequirements !== null) {
        return state;
      }
      return {
        ...state,
        taskRequirements: event.requirements
      };

    case "ANSWER_CLARIFICATION": {
      const question = getActiveClarification(state);
      if (!question || question.id !== event.questionId || !event.answer.trim()) return state;
      const answers = { ...state.answers, [question.id]: event.answer };
      const nextIndex = state.clarificationIndex + 1;
      const nextPhase = nextIndex >= state.clarifications.length ? "planning" : "clarifying";
      const resolvedAt =
        event.answeredAt ?? state.taskPlan?.updatedAt ?? new Date(0).toISOString();
      const resolvedTaskPlan = resolveTaskPlanClarification(
        state,
        question.id,
        event.answer,
        resolvedAt
      );
      const taskPlan = requestNextPlannedClarification(
        resolvedTaskPlan,
        state.clarifications[nextIndex]?.id,
        resolvedAt
      );
      return withLog(
        { ...state, answers, clarificationIndex: nextIndex, phase: nextPhase, taskPlan },
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
      const resolvedAt =
        event.skippedAt ?? state.taskPlan?.updatedAt ?? new Date(0).toISOString();
      const resolvedTaskPlan = resolveTaskPlanClarification(
        state,
        question.id,
        "已跳过",
        resolvedAt
      );
      const taskPlan = requestNextPlannedClarification(
        resolvedTaskPlan,
        state.clarifications[nextIndex]?.id,
        resolvedAt
      );
      return withLog(
        { ...state, answers, clarificationIndex: nextIndex, phase: nextPhase, taskPlan },
        "info",
        nextPhase === "planning" ? "已跳过非必填澄清，正在生成资源计划。" : "已跳过非必填澄清。"
      );
    }

    case "PLAN_GENERATED": {
      if (state.phase !== "planning") return state;
      const revision = state.revision + 1;
      const resources = createInitialPlan(state);
      const taskRequirements = state.taskRequirements ?? deriveTaskRequirements(state);
      const planValidation = validatePlannedResources(resources, {
        requirements: taskRequirements,
        systemProfile: state.systemProfile,
        revision
      });
      if (!planValidation.valid) {
        return withLog(
          { ...state, taskRequirements, planValidation, approvedRevision: null },
          "error",
          `固定计划未通过验证：${planValidation.issues[0]?.message ?? "未知计划错误"}`
        );
      }
      return withLog(
        {
          ...state,
          phase: "waiting_approval",
          revision,
          resources,
          taskRequirements,
          planValidation,
          approvedRevision: null,
          workspace: { ...state.workspace, nextAction: "确认资源计划后开始受控下载。" }
        },
        "success",
        `可信资源计划 r${revision} 已通过严格验证，等待用户确认。`
      );
    }

    case "GITHUB_ACQUISITION_PREPARED": {
      if (
        state.phase !== "result" ||
        state.routeDecision?.skillId !== "github-project-discovery"
      ) return state;
      const revision = state.revision + 1;
      const resources = event.resources.map((resource) => ({
        ...resource,
        selected: resource.github ? true : resource.selected,
        status: "pending" as const,
        progress: 0,
        attempts: 0
      }));
      const planValidation = validateGitHubAcquisitionPlan(
        resources,
        revision
      );
      if (!planValidation.valid) {
        return withLog(
          { ...state, planValidation },
          "error",
          `GitHub 源码快照计划无效：${planValidation.issues[0]?.message ?? "未知错误"}`
        );
      }
      const taskPlanExtension = extendCompletedPlan(
        state,
        localAcquisitionExtensionProposal(
          `将 ${resources.find((resource) => resource.github)?.github?.fullName ?? "已选择的 GitHub 仓库"} 准备到本地`,
          "下载固定 commit 源码",
          "下载已经固定 commit SHA 的仓库归档和当前 revision 中选择的离线资源。"
        ),
        "用户在 GitHub 查询完成后选择将仓库准备到本地。"
      );
      return withLog(
        {
          ...state,
          phase: taskPlanExtension
            ? "waiting_task_plan_confirmation"
            : "waiting_approval",
          revision,
          resources,
          taskPlan: taskPlanExtension?.taskPlan ?? state.taskPlan,
          taskPlanValidation:
            taskPlanExtension?.validation ?? state.taskPlanValidation,
          taskRequirements: githubAcquisitionRequirements,
          planValidation,
          approvedRevision: null,
          planExplanation: event.explanation,
          agentRun: { ...state.agentRun, status: "waiting_approval" },
          workspace: {
            ...state.workspace,
            nextAction:
              taskPlanExtension
                ? "先确认新增的本地准备流程，再选择目录并审批资源计划。"
                : "选择本地工作区目录并确认后，下载固定 commit 的源码快照。"
          }
        },
        "success",
        `GitHub 仓库已固定为不可变源码快照计划 r${revision}。`
      );
    }

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

    case "MODEL_TOOL_COMPLETED": {
      const systemProfileUpdate =
        event.result.tool === "read_system_profile" &&
        event.result.status === "success" &&
        isSystemProfileToolOutput(event.result.output)
          ? {
              systemProfile: event.result.output.targetProfile,
              hostProfile: event.result.output.hostProfile
            }
          : {};

      return withLog(
        {
          ...state,
          ...systemProfileUpdate,
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
    }

    case "MODEL_CLARIFICATION_REQUESTED":
      return withLog(
        {
          ...state,
          phase: "clarifying",
          route: state.route ?? "ai-development-environment",
          clarifications: [event.question],
          clarificationIndex: 0,
          agentRun: { ...state.agentRun, status: "idle" }
        },
        "info",
        `模型请求澄清：${event.question.prompt}`
      );

    case "MODEL_PLAN_PROPOSED": {
      if (state.phase !== "planning") return state;
      const revision = state.revision + 1;
      const taskRequirements = state.taskRequirements ?? deriveTaskRequirements(state);
      const planValidation = validatePlanResourceIds(event.resourceIds, {
        requirements: taskRequirements,
        systemProfile: state.systemProfile,
        revision
      });
      if (!planValidation.valid) {
        return withLog(
          {
            ...state,
            taskRequirements,
            planValidation,
            approvedRevision: null,
            agentRun: { ...state.agentRun, status: "thinking" }
          },
          "error",
          `模型计划未通过严格验证：${planValidation.issues[0]?.message ?? "未知计划错误"}`
        );
      }
      const resources = createModelPlan(event.resourceIds, state);
      return withLog(
        {
          ...state,
          phase: "waiting_approval",
          route: state.route ?? "ai-development-environment",
          revision,
          resources,
          planExplanation: event.explanation,
          taskRequirements,
          planValidation,
          approvedRevision: null,
          agentRun: { ...state.agentRun, status: "waiting_approval" },
          workspace: { ...state.workspace, nextAction: "确认模型生成的资源计划后开始受控下载。" }
        },
        "success",
        `模型资源计划 r${revision} 已通过严格验证，等待用户确认。`
      );
    }

    case "MODEL_REPLAN_PROPOSED": {
      if (state.phase !== "replanning") return state;
      if (state.requestedReplanStrategy && event.strategy !== state.requestedReplanStrategy) return state;
      const revision = state.revision + 1;
      const resources = buildReplacementPlan(state, event.strategy);
      const taskRequirements = state.taskRequirements ?? deriveTaskRequirements(state);
      const planValidation = validatePlannedResources(resources, {
        requirements: taskRequirements,
        systemProfile: state.systemProfile,
        revision
      });
      if (!planValidation.valid) {
        return withLog(
          { ...state, taskRequirements, planValidation, approvedRevision: null },
          "error",
          `模型替代计划未通过严格验证：${planValidation.issues[0]?.message ?? "未知计划错误"}`
        );
      }
      return withLog(
        {
          ...state,
          phase: "waiting_approval",
          revision,
          resources,
          activeResourceId: null,
          requestedReplanStrategy: null,
          planExplanation: event.explanation,
          taskRequirements,
          planValidation,
          approvedRevision: null,
          agentRun: { ...state.agentRun, status: "waiting_approval" },
          workspace: { ...state.workspace, nextAction: "模型替代计划需再次确认后才会执行。" }
        },
        "success",
        `模型已生成${event.strategy === "trusted-mirror" ? "可信备用来源" : "主来源重试"}计划 r${revision}，严格验证通过并等待再次确认。`
      );
    }

    case "MODEL_FINISHED":
      return withLog(
        {
          ...state,
          phase:
            state.routeDecision?.skillId === "github-project-discovery"
              ? "result"
              : state.phase,
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
          taskPlan: failOrCancelTaskPlan(
            state,
            `模型已达到 ${state.agentRun.maxSteps} 步安全上限。`
          ),
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
          taskPlan: failOrCancelTaskPlan(state, event.reason),
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
      if (
        resource.npm &&
        !(
          state.agentB.status === "completed" &&
          state.agentB.answer?.integrity === "valid" &&
          state.agentB.answer.planRevision < state.revision
        )
      ) {
        return state;
      }
      if (resource.required && !event.selected) {
        return enterReplanning(
          state,
          resource.id,
          "required_resource_cancelled",
          `用户取消了必需资源 ${resource.name}`
        );
      }

      const resources = state.resources.map((item) =>
        item.id === event.resourceId ? { ...item, selected: event.selected } : item
      );
      const taskRequirements = state.taskRequirements ?? deriveTaskRequirements(state);
      const planValidation =
        state.routeDecision?.skillId === "github-project-discovery"
          ? validateGitHubAcquisitionPlan(resources, state.revision)
          : validatePlannedResources(resources, {
              requirements: taskRequirements,
              systemProfile: state.systemProfile,
              revision: state.revision
            });
      return withLog(
        {
          ...state,
          resources,
          taskRequirements,
          planValidation,
          approvedRevision: null
        },
        "info",
        `${event.selected ? "已选择" : "已取消"}可选资源 ${resource.name}。`
      );
    }

    case "TOGGLE_NODE_DEPENDENCIES": {
      if (
        state.phase !== "waiting_approval" ||
        state.routeDecision?.skillId !== "github-project-discovery" ||
        state.agentB.status !== "completed" ||
        state.agentB.answer?.integrity !== "valid" ||
        state.agentB.answer.planRevision >= state.revision
      ) {
        return state;
      }
      const resources = state.resources.map((resource) =>
        resource.npm
          ? {
              ...resource,
              selected: event.selected,
              status: "pending" as const,
              progress: 0
            }
          : resource
      );
      const planValidation = validateGitHubAcquisitionPlan(
        resources,
        state.revision
      );
      return withLog(
        {
          ...state,
          resources,
          planValidation,
          approvedRevision: null
        },
        "info",
        event.selected
          ? "已将锁文件完整约束的 npm tarball 加入当前审批范围。"
          : "已从当前审批范围移除 npm 离线依赖，只准备源码归档。"
      );
    }

    case "PREPARE_NODE_DEPENDENCIES": {
      const npmResources = state.resources.filter((resource) => resource.npm);
      if (
        state.phase !== "handoff" ||
        !state.workspace.ready ||
        state.routeDecision?.skillId !== "github-project-discovery" ||
        state.agentB.status !== "completed" ||
        state.agentB.answer?.integrity !== "valid" ||
        state.agentB.answer.projectReadiness?.dependencyPreparation !==
          "package-lock-supported" ||
        npmResources.length === 0
      ) {
        return state;
      }
      const revision = state.revision + 1;
      const resources = state.resources.map((resource) =>
        resource.npm
          ? {
              ...resource,
              selected: true,
              status: "pending" as const,
              progress: 0,
              attempts: 0,
              bytesWritten: undefined,
              totalBytes: undefined,
              speedBytesPerSecond: undefined,
              etaSeconds: undefined,
              failureReason: undefined
            }
          : resource
      );
      const planValidation = validateGitHubAcquisitionPlan(
        resources,
        revision
      );
      if (!planValidation.valid) {
        return withLog(
          { ...state, planValidation },
          "error",
          `npm 离线依赖计划无效：${planValidation.issues[0]?.message ?? "未知错误"}`
        );
      }
      const taskPlanExtension = extendCompletedPlan(
        state,
        localAcquisitionExtensionProposal(
          "为已验证的 GitHub 工作区准备锁文件依赖",
          "下载锁文件固定的 npm 包",
          "仅下载 package-lock 完整固定且由 Agent B 确认可离线准备的 npm tarball。"
        ),
        "用户在源码交接完成后新增 npm 离线依赖准备范围。"
      );
      return withLog(
        {
          ...state,
          phase: taskPlanExtension
            ? "waiting_task_plan_confirmation"
            : "waiting_approval",
          revision,
          resources,
          taskPlan: taskPlanExtension?.taskPlan ?? state.taskPlan,
          taskPlanValidation:
            taskPlanExtension?.validation ?? state.taskPlanValidation,
          approvedRevision: null,
          planValidation,
          planExplanation:
            `Agent B 已确认源码 Manifest 完整；${npmResources.length} 个 tarball 由同一 commit 的 package-lock SHA512 固定。`,
          workspace: {
            ...state.workspace,
            ready: false,
            exportStatus: "pending",
            exportError: undefined,
            nextAction:
              taskPlanExtension
                ? "确认新增的依赖准备流程后，再审批资源 revision。"
                : "确认新的依赖 revision 后，仅下载并校验 npm tarball。"
          },
          agentRun: { ...state.agentRun, status: "waiting_approval" }
        },
        "success",
        `已生成 npm 离线依赖计划 r${revision}，等待第二次用户审批。`
      );
    }

    case "APPROVE_PLAN": {
      if (state.phase !== "waiting_approval") return state;
      const taskRequirements = state.taskRequirements ?? deriveTaskRequirements(state);
      const githubPlan =
        state.routeDecision?.skillId === "github-project-discovery";
      const currentPlanValidation = githubPlan
        ? validateGitHubAcquisitionPlan(state.resources, state.revision)
        : validatePlannedResources(state.resources, {
            requirements: taskRequirements,
            systemProfile: state.systemProfile,
            revision: state.revision
          });
      const approvalValidation = githubPlan
        ? validateGitHubAcquisitionPlan(
            state.resources,
            state.revision,
            event.revision
          )
        : validatePlannedResources(state.resources, {
            requirements: taskRequirements,
            systemProfile: state.systemProfile,
            revision: state.revision,
            approvalRevision: event.revision
          });
      if (!approvalValidation.valid || !hasRequiredSelection(state.resources)) {
        return withLog(
          {
            ...state,
            taskRequirements,
            planValidation: currentPlanValidation,
            approvedRevision: null
          },
          "error",
          `计划 r${state.revision} 审批被拒绝：${approvalValidation.issues[0]?.message ?? "必需资源未选择"}`
        );
      }
      const prepared = prepareDownloads(state.resources);
      const resourcesReadyForExport =
        state.resources.some((resource) => resource.selected) &&
        state.resources.every(
          (resource) => !resource.selected || resource.status === "verified"
        );
      const resourcesReadyForVerification =
        !resourcesReadyForExport &&
        state.resources.some((resource) => resource.selected) &&
        state.resources.every(
          (resource) =>
            !resource.selected ||
            resource.status === "downloaded" ||
            resource.status === "verified"
        );
      const executionPhase = resourcesReadyForExport
        ? "exporting" as const
        : resourcesReadyForVerification
          ? "verifying" as const
          : "downloading" as const;
      let taskPlan = state.taskPlan;
      const waitingTaskPlanStep = taskPlan?.steps.find(
        (step) => step.status === "waiting_approval"
      );
      if (taskPlan && waitingTaskPlanStep) {
        try {
          taskPlan = approveTaskPlanStep(taskPlan, {
            stepId: waitingTaskPlanStep.id,
            revision: taskPlan.revision,
            approvedAt:
              event.approvedAt ?? taskPlan.updatedAt
          });
        } catch {
          return withLog(
            state,
            "error",
            `Task Plan 步骤 ${waitingTaskPlanStep.id} 的审批状态无效。`
          );
        }
      }
      return withLog(
        {
          ...state,
          taskPlan,
          phase: executionPhase,
          resources: prepared.resources,
          activeResourceId: prepared.activeResourceId,
          replanReason: null,
          requestedReplanStrategy: null,
          taskRequirements,
          planValidation: currentPlanValidation,
          approvedRevision: state.revision,
          agentRun: { ...state.agentRun, step: 0, status: "executing" },
          workspace: {
            ...state.workspace,
            exportStatus: resourcesReadyForExport ? "pending" : state.workspace.exportStatus,
            exportError: undefined,
            nextAction: resourcesReadyForExport
              ? "审批已更新，等待重新导出工作区交接包。"
              : resourcesReadyForVerification
                ? "本地资源已接入，开始验证来源与完整性。"
              : "等待资源下载和验证完成。"
          }
        },
        "success",
        resourcesReadyForExport
          ? `用户重新确认资源计划 r${state.revision}，继续导出工作区。`
          : resourcesReadyForVerification
            ? `用户确认资源计划 r${state.revision}，开始验证已接入的本地资源。`
          : `用户确认资源计划 r${state.revision}，开始受控下载。`
      );
    }

    case "DOWNLOAD_PROGRESS": {
      if (state.phase !== "downloading" || state.activeResourceId !== event.resourceId) return state;
      const progress = Math.max(0, Math.min(100, event.progress));
      const resources = state.resources.map((resource) =>
        resource.id === event.resourceId
          ? {
              ...resource,
              progress,
              status:
                progress === 100
                  ? ("downloaded" as ResourceStatus)
                  : resource.status === "paused"
                    ? ("paused" as ResourceStatus)
                    : ("downloading" as ResourceStatus),
              bytesWritten: event.bytesWritten ?? resource.bytesWritten,
              totalBytes: event.totalBytes ?? resource.totalBytes,
              speedBytesPerSecond:
                event.speedBytesPerSecond ?? resource.speedBytesPerSecond,
              etaSeconds: event.etaSeconds ?? resource.etaSeconds
            }
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

    case "PAUSE_DOWNLOAD":
    case "RESUME_DOWNLOAD":
      return state;

    case "DOWNLOAD_PAUSED":
      if (
        state.phase !== "downloading" ||
        state.activeResourceId !== event.resourceId
      ) {
        return state;
      }
      return withLog(
        {
          ...state,
          resources: state.resources.map((resource) =>
            resource.id === event.resourceId
              ? { ...resource, status: "paused" as const }
              : resource
          )
        },
        "info",
        `资源 ${event.resourceId} 已暂停。`
      );

    case "DOWNLOAD_RESUMED":
      if (
        state.phase !== "downloading" ||
        state.activeResourceId !== event.resourceId
      ) {
        return state;
      }
      return withLog(
        {
          ...state,
          resources: state.resources.map((resource) =>
            resource.id === event.resourceId
              ? { ...resource, status: "downloading" as const }
              : resource
          )
        },
        "info",
        `资源 ${event.resourceId} 已恢复。`
      );

    case "DOWNLOAD_FAILED":
      if (state.phase !== "downloading" || state.activeResourceId !== event.resourceId) return state;
      return enterFailureResolution(state, event.resourceId, event.reason);

    case "DOWNLOAD_APPROVAL_EXPIRED":
      if (
        state.phase !== "downloading" &&
        state.phase !== "exporting" &&
        state.phase !== "awaiting_export_retry"
      ) {
        return state;
      }
      return withLog(
        {
          ...state,
          phase: "waiting_approval",
          approvedRevision: null,
          activeResourceId: null,
          resources: state.resources.map((resource) =>
            resource.selected &&
            resource.status !== "downloaded" &&
            resource.status !== "verified"
              ? {
                  ...resource,
                  status: "pending" as ResourceStatus,
                  progress: 0,
                  failureReason: undefined
                }
              : resource
          ),
          agentRun: { ...state.agentRun, status: "waiting_approval" },
          workspace: {
            ...state.workspace,
            ready: false,
            exportStatus:
              state.phase === "exporting" || state.phase === "awaiting_export_retry"
                ? "pending"
                : state.workspace.exportStatus,
            exportError: undefined,
            nextAction: "执行审批已过期，请重新确认当前 revision。"
          }
        },
        "warning",
        event.reason
      );

    case "RESOLVE_DOWNLOAD_FAILURE": {
      if (state.phase !== "awaiting_failure_action") return state;
      const failedResource = state.resources.find((resource) => resource.status === "failed");
      if (!failedResource) return state;

      if (event.action === "delegate-agent-b") {
        let taskPlan = state.taskPlan;
        const runningStep = taskPlan?.steps.find((step) =>
          ["running", "waiting_user_input", "waiting_approval"].includes(
            step.status
          )
        );
        if (taskPlan && runningStep) {
          try {
            taskPlan = failTaskPlanStep(
              taskPlan,
              runningStep.id,
              failedResource.failureReason ?? "资源下载失败并交由 Agent B 处理。",
              event.resolvedAt ?? taskPlan.updatedAt
            );
          } catch {
            // 保留原计划，交接状态仍由现有状态机处理。
          }
        }
        return withLog(
          {
            ...state,
            taskPlan,
            phase: "handoff",
            agentRun: { ...state.agentRun, status: "delegated" },
            workspace: {
              ready: false,
              files: handoffFiles,
              nextAction: `Agent B 处理 ${failedResource.name}：${failedResource.failureReason ?? "下载失败"}`,
              exportStatus: "not_started",
              manifestRevision: state.workspace.manifestRevision,
              overallStatus: state.resources.some(
                (resource) =>
                  resource.status === "downloaded" ||
                  resource.status === "verified"
              )
                ? "partially_ready"
                : "failed",
              targetRootPath: state.workspace.targetRootPath,
              currentSnapshotRootPath:
                state.workspace.currentSnapshotRootPath,
              fileRecords: []
            }
          },
          "warning",
          `已将 ${failedResource.name} 的失败上下文和当前资源清单交给 Agent B。`
        );
      }

      if (event.action === "trusted-mirror" && !failedResource.fallbackId) return state;
      const revisedAt =
        event.resolvedAt ?? state.taskPlan?.updatedAt ?? new Date(0).toISOString();
      const taskPlanRevision = reviseTaskPlanForRecovery(
        state,
        `用户选择${event.action === "trusted-mirror" ? "可信替代来源" : "重试原来源"}：${failedResource.failureReason ?? "下载失败"}`,
        revisedAt
      );
      return withLog(
        {
          ...state,
          phase: taskPlanRevision
            ? "waiting_task_plan_confirmation"
            : "replanning",
          requestedReplanStrategy: event.action,
          approvedRevision: null,
          taskPlan: taskPlanRevision?.taskPlan ?? state.taskPlan,
          taskPlanValidation:
            taskPlanRevision?.validation ?? state.taskPlanValidation,
          agentRun: {
            ...state.agentRun,
            status: taskPlanRevision ? "waiting_approval" : "thinking"
          },
          workspace: {
            ...state.workspace,
            nextAction: taskPlanRevision
              ? "确认修订后的 Task Plan，再生成新的待审批资源计划。"
              : "等待模型生成新的待审批资源计划。"
          }
        },
        "info",
        event.action === "trusted-mirror"
          ? `用户要求为 ${failedResource.name} 生成可信替代来源计划。`
          : `用户要求重试 ${failedResource.name} 的主来源。`
      );
    }

    case "REPLAN_GENERATED": {
      if (state.phase !== "replanning") return state;
      if (state.requestedReplanStrategy && event.strategy !== state.requestedReplanStrategy) return state;
      const revision = state.revision + 1;
      const resources = buildReplacementPlan(state, event.strategy);
      const taskRequirements = state.taskRequirements ?? deriveTaskRequirements(state);
      const planValidation = validatePlannedResources(resources, {
        requirements: taskRequirements,
        systemProfile: state.systemProfile,
        revision
      });
      if (!planValidation.valid) {
        return withLog(
          { ...state, taskRequirements, planValidation, approvedRevision: null },
          "error",
          `替代计划未通过严格验证：${planValidation.issues[0]?.message ?? "未知计划错误"}`
        );
      }
      return withLog(
        {
          ...state,
          phase: "waiting_approval",
          revision,
          resources,
          activeResourceId: null,
          requestedReplanStrategy: null,
          taskRequirements,
          planValidation,
          approvedRevision: null,
          agentRun: { ...state.agentRun, status: "waiting_approval" },
          workspace: { ...state.workspace, nextAction: "替代计划需再次确认后才会执行。" }
        },
        "success",
        `已生成${event.strategy === "trusted-mirror" ? "可信备用来源" : "主来源重试"}计划 r${revision}，严格验证通过并等待再次确认。`
      );
    }

    case "VERIFY_RESOURCES": {
      if (state.phase !== "verifying") return state;
      if (event.failure) {
        return event.failure.retriable
          ? enterFailureResolution(
              state,
              event.failure.resourceId,
              `${event.failure.code}: ${event.failure.reason}`
            )
          : enterReplanning(
              state,
              event.failure.resourceId,
              "version_mismatch",
              `${event.failure.code}: ${event.failure.reason}`
            );
      }
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
          phase: "exporting",
          resources: state.resources.map((resource) =>
            resource.selected && resource.status === "downloaded"
              ? { ...resource, status: "verified" as ResourceStatus }
              : resource
          ),
          workspace: {
            ready: false,
            files: handoffFiles,
            nextAction: "正在原子写入工作区交接包。",
            exportStatus: "pending",
            manifestRevision: state.workspace.manifestRevision,
            overallStatus: "preparing",
            targetRootPath: state.workspace.targetRootPath,
            currentSnapshotRootPath: state.workspace.currentSnapshotRootPath,
            fileRecords: []
          },
          agentRun: { ...state.agentRun, status: "executing" }
        },
        "success",
        "资源验证通过，开始生成真实工作区交接包。"
      );
    }

    case "WORKSPACE_EXPORT_STARTED":
      if (state.phase !== "exporting") return state;
      return {
        ...state,
        workspace: {
          ...state.workspace,
          exportStatus: "exporting",
          exportError: undefined
        }
      };

    case "WORKSPACE_EXPORT_COMPLETED":
      if (
        state.phase !== "exporting" ||
        event.output.taskId !== state.taskId ||
        event.output.revision !== state.revision
      ) {
        return state;
      }
      return withLog(
        {
          ...state,
          phase: "handoff",
          workspace: {
            ready: true,
            generatedAt: event.output.generatedAt,
            files: event.output.files.map((file) => file.relativePath),
            nextAction:
              state.routeDecision?.skillId === "github-project-discovery"
                ? "核对固定 commit、sources/ 源码归档和 dependencies/npm/ 锁文件依赖，再运行 Agent B 只读检查。"
                : "核对 resource-manifest.json 与 downloads/ 校验信息，再按 README.md 人工处理资源。",
            exportStatus: "ready",
            manifestRevision: state.workspace.manifestRevision,
            overallStatus: "ready",
            rootPath: event.output.rootPath,
            targetRootPath: state.workspace.targetRootPath,
            currentSnapshotRootPath: state.workspace.currentSnapshotRootPath,
            fileRecords: event.output.files,
            exportError: undefined
          },
          agentRun: {
            ...state.agentRun,
            status:
              state.taskPlan && state.taskPlan.status !== "completed"
                ? "executing"
                : "complete"
          }
        },
        "success",
        `工作区交接包已原子写入 ${event.output.rootPath}。`
      );

    case "WORKSPACE_EXPORT_FAILED":
      if (state.phase !== "exporting") return state;
      return withLog(
        {
          ...state,
          phase: "awaiting_export_retry",
          workspace: {
            ...state.workspace,
            ready: false,
            exportStatus: "failed",
            exportError: event.reason,
            nextAction: "检查磁盘权限或目标目录后重试工作区导出。"
          },
          agentRun: { ...state.agentRun, status: "failed" }
        },
        "error",
        `工作区交接包导出失败：${event.reason}`
      );

    case "RETRY_WORKSPACE_EXPORT":
      if (state.phase !== "awaiting_export_retry") return state;
      return withLog(
        {
          ...state,
          phase: "exporting",
          workspace: {
            ...state.workspace,
            exportStatus: "pending",
            exportError: undefined,
            nextAction: "正在重试原子写入工作区交接包。"
          },
          agentRun: { ...state.agentRun, status: "executing" }
        },
        "info",
        "用户请求重试工作区交接包导出。"
      );

    case "LOCAL_ARTIFACTS_ADDED": {
      if (!event.artifacts.length) return state;
      const byId = new Map(
        [...state.localArtifacts, ...event.artifacts].map((artifact) => [
          artifact.artifactId,
          artifact
        ])
      );
      const matchedIds = new Set(
        event.artifacts.flatMap((artifact) =>
          artifact.matchedResourceId ? [artifact.matchedResourceId] : []
        )
      );
      const resources = state.resources.map((resource) =>
        matchedIds.has(resource.id)
          ? {
              ...resource,
              selected: true,
              status: "downloaded" as const,
              progress: 100,
              failureReason: undefined
            }
          : resource
      );
      const revision =
        state.phase === "waiting_approval" && matchedIds.size > 0
          ? state.revision + 1
          : state.revision;
      const taskRequirements =
        state.taskRequirements ?? deriveTaskRequirements(state);
      const planValidation =
        resources.length > 0 && revision > 0
          ? validatePlannedResources(resources, {
              requirements: taskRequirements,
              systemProfile: state.systemProfile,
              revision
            })
          : state.planValidation;
      return withLog(
        {
          ...state,
          revision,
          resources,
          localArtifacts: [...byId.values()],
          approvedRevision: matchedIds.size > 0 ? null : state.approvedRevision,
          taskRequirements,
          planValidation
        },
        "success",
        `已接入 ${event.artifacts.length} 个本地资源，其中 ${matchedIds.size} 个匹配当前可信资源计划。`
      );
    }

    case "WORKSPACE_ROOT_SELECTED":
      if (state.phase !== "waiting_approval") return state;
      return withLog(
        {
          ...state,
          workspace: {
            ...state.workspace,
            targetRootPath: event.rootPath
          }
        },
        "info",
        "已更新当前任务的工作区目标目录。"
      );

    case "MANIFEST_SNAPSHOT_WRITTEN":
      if (event.manifestRevision <= state.workspace.manifestRevision) return state;
      return {
        ...state,
        workspace: {
          ...state.workspace,
          manifestRevision: event.manifestRevision,
          currentSnapshotRootPath: event.rootPath,
          rootPath:
            state.route === "local-repository-import"
              ? event.rootPath
              : state.workspace.rootPath,
          overallStatus: event.status
        }
      };

    case "RUN_AGENT_B":
      return state;

    case "AGENT_B_STARTED":
      return {
        ...state,
        agentB: {
          status: "running",
          runId: event.runId,
          grantId: event.grantId,
          manifestRevision: null,
          answer: null,
          error: null
        }
      };

    case "AGENT_B_COMPLETED":
      if (state.agentB.runId !== event.runId) return state;
      return withLog(
        {
          ...state,
          agentB: {
            ...state.agentB,
            status: "completed",
            manifestRevision: event.answer.manifestRevision,
            answer: event.answer,
            error: null
          }
        },
        "success",
        `Agent B 已读取 Manifest r${event.answer.manifestRevision} 并完成只读检查。`
      );

    case "AGENT_B_FAILED":
      if (state.agentB.runId !== event.runId) return state;
      return withLog(
        {
          ...state,
          agentB: {
            ...state.agentB,
            status: "failed",
            answer: null,
            error: event.reason
          }
        },
        "error",
        `Agent B 检查失败：${event.reason}`
      );

    case "TASK_STATE_RESTORED": {
      if (state.phase !== "intake" || !event.state.task.trim()) return state;
      const restored =
        event.state.phase === "exporting"
          ? {
              ...event.state,
              workspace: {
                ...event.state.workspace,
                exportStatus: "pending" as const,
                exportError: undefined
              }
            }
          : event.state;
      if (
        !event.approvalValid &&
        (restored.phase === "downloading" ||
          restored.phase === "exporting" ||
          restored.phase === "awaiting_export_retry")
      ) {
        return transition(restored, {
          type: "DOWNLOAD_APPROVAL_EXPIRED",
          reason: "恢复任务时发现执行审批已过期，请重新确认当前 revision。"
        });
      }
      return withLog(restored, "info", "已从 SQLite 恢复未完成任务。");
    }

    case "CANCEL_TASK":
      if (
        state.phase === "result" ||
        state.phase === "handoff" ||
        state.phase === "cancelled" ||
        state.phase === "intake"
      ) return state;
      {
        const taskPlan =
          state.taskPlan && state.taskPlan.status !== "completed"
            ? cancelTaskPlan(
                state.taskPlan,
                event.cancelledAt ?? state.taskPlan.updatedAt
              )
            : state.taskPlan;
      return withLog(
        { ...state, phase: "cancelled", activeResourceId: null, taskPlan },
        "warning",
        "用户取消了当前任务。"
      );
      }

    default:
      return state;
  }
}
