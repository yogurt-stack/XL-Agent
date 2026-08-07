import type {
  AgentPhase,
  AgentState,
  ClarificationQuestion,
  ResourceStatus,
  RouteDecision,
  TaskRequirements
} from "./types";
import {
  defaultTaskPlanToolPolicies,
  parseTaskPlan,
  taskPlanSchema,
  validateTaskPlan
} from "./taskPlan";

const phases = new Set<AgentPhase>([
  "intake",
  "routing",
  "unsupported",
  "task_planning",
  "waiting_task_plan_confirmation",
  "clarifying",
  "planning",
  "waiting_approval",
  "downloading",
  "awaiting_failure_action",
  "verifying",
  "exporting",
  "awaiting_export_retry",
  "replanning",
  "result",
  "handoff",
  "cancelled"
]);

const resourceStatuses = new Set<ResourceStatus>([
  "pending",
  "queued",
  "downloading",
  "paused",
  "downloaded",
  "verified",
  "failed",
  "skipped",
  "replaced"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isLocalRepositorySummary(value: unknown) {
  if (value === null) return true;
  if (!isRecord(value) || !isRecord(value.status) || !isRecord(value.analysis)) {
    return false;
  }
  const repositoryStatus = value.status as Record<string, unknown>;
  return (
    typeof value.repositoryHandleId === "string" &&
    value.repositoryHandleId.startsWith("local-repo-") &&
    typeof value.displayName === "string" &&
    typeof value.fingerprint === "string" &&
    /^[a-f0-9]{64}$/iu.test(value.fingerprint) &&
    typeof value.commitSha === "string" &&
    /^[a-f0-9]{40,64}$/iu.test(value.commitSha) &&
    (value.branch === null || typeof value.branch === "string") &&
    typeof value.detached === "boolean" &&
    typeof value.clean === "boolean" &&
    ["modified", "deleted", "untracked", "conflicted", "ahead", "behind"].every(
      (key) =>
        typeof repositoryStatus[key] === "number" &&
        Number.isSafeInteger(repositoryStatus[key]) &&
        (repositoryStatus[key] as number) >= 0
    ) &&
    typeof value.fileCount === "number" &&
    Number.isSafeInteger(value.fileCount) &&
    typeof value.trackedFileCount === "number" &&
    Number.isSafeInteger(value.trackedFileCount) &&
    typeof value.hasSubmodules === "boolean" &&
    typeof value.hasSymlinks === "boolean" &&
    typeof value.inspectedAt === "string" &&
    isStringArray(value.analysis.ecosystems) &&
    isStringArray(value.analysis.manifests) &&
    isStringArray(value.analysis.lockfiles) &&
    isStringArray(value.analysis.runtimeHints)
  );
}

function isGitHubRepositoryAnalysisSummary(value: unknown) {
  if (value === null) return true;
  if (!isRecord(value) || !isRecord(value.analysis)) return false;
  return (
    typeof value.repositoryHandleId === "string" &&
    value.repositoryHandleId.startsWith("github-repo-") &&
    typeof value.fullName === "string" &&
    /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value.fullName) &&
    typeof value.displayName === "string" &&
    typeof value.defaultBranch === "string" &&
    typeof value.commitSha === "string" &&
    /^[a-f0-9]{40,64}$/iu.test(value.commitSha) &&
    typeof value.treeSha === "string" &&
    /^[a-f0-9]{40,64}$/iu.test(value.treeSha) &&
    Number.isSafeInteger(value.trackedFileCount) &&
    Number(value.trackedFileCount) >= 0 &&
    typeof value.treeTruncated === "boolean" &&
    typeof value.inspectedAt === "string" &&
    isStringArray(value.analysis.ecosystems) &&
    isStringArray(value.analysis.manifests) &&
    isStringArray(value.analysis.lockfiles) &&
    isStringArray(value.analysis.runtimeHints)
  );
}

function isGitHubPublishState(value: unknown) {
  if (!isRecord(value)) return false;
  if (
    ![
      "idle",
      "waiting_approval",
      "publishing",
      "published",
      "failed"
    ].includes(String(value.status)) ||
    (value.approvedAt !== null && typeof value.approvedAt !== "string") ||
    (value.error !== null && typeof value.error !== "string") ||
    (value.partialRepositoryUrl !== null &&
      typeof value.partialRepositoryUrl !== "string")
  ) {
    return false;
  }
  if (value.plan !== null) {
    if (
      !isRecord(value.plan) ||
      typeof value.plan.publishId !== "string" ||
      typeof value.plan.repositoryHandleId !== "string" ||
      typeof value.plan.sourceFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/iu.test(value.plan.sourceFingerprint) ||
      typeof value.plan.planSha256 !== "string" ||
      !/^[a-f0-9]{64}$/iu.test(value.plan.planSha256) ||
      typeof value.plan.targetOwner !== "string" ||
      typeof value.plan.targetRepository !== "string"
    ) {
      return false;
    }
  }
  return value.result === null || isRecord(value.result);
}

function isTaskPlanValidation(value: unknown) {
  return value === null || (
    isRecord(value) &&
    typeof value.valid === "boolean" &&
    typeof value.checkedRevision === "number" &&
    Number.isInteger(value.checkedRevision) &&
    Array.isArray(value.issues) &&
    Array.isArray(value.topologicalOrder) &&
    isStringArray(value.topologicalOrder)
  );
}

const agentLoopStatuses = new Set([
  "running",
  "completed",
  "waiting_user_input",
  "plan_revision_proposed",
  "stopped",
  "aborted",
  "failed"
]);

const agentLoopToolNames = new Set([
  "read_system_profile",
  "inspect_local_development_environment",
  "list_local_repository_tree",
  "read_local_repository_file",
  "inspect_project_requirements",
  "list_github_repository_tree",
  "read_github_repository_file",
  "inspect_github_project_requirements",
  "search_trusted_catalog",
  "search_github_repositories",
  "simulate_download",
  "controlled_download",
  "export_workspace"
]);

function isAgentLoopUsage(value: unknown) {
  return isRecord(value) &&
    ["turns", "toolCalls", "executedToolCalls", "elapsedMs"].every(
      (key) =>
        Number.isSafeInteger(value[key]) &&
        (value[key] as number) >= 0
    ) &&
    (value.executedToolCalls as number) <= (value.toolCalls as number);
}

function isAgentLoopAction(
  value: unknown
): value is Record<string, unknown> & { type: string } {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "tool_calls") {
    return Array.isArray(value.calls) &&
      value.calls.length > 0 &&
      value.calls.length <= 8 &&
      value.calls.every(
        (call) =>
          isRecord(call) &&
          typeof call.callId === "string" &&
          call.callId.length > 0 &&
          typeof call.name === "string" &&
          agentLoopToolNames.has(call.name) &&
          call.risk === "read_only"
      );
  }
  if (value.type === "complete_step") {
    return typeof value.summary === "string" &&
      value.summary.length <= 4_000 &&
      (value.evidence === undefined || Array.isArray(value.evidence));
  }
  if (value.type === "ask_clarification") {
    return typeof value.questionId === "string" &&
      value.questionId.length <= 120 &&
      typeof value.question === "string" &&
      typeof value.reason === "string" &&
      typeof value.required === "boolean" &&
      (value.options === undefined || isStringArray(value.options));
  }
  return value.type === "propose_plan_revision" &&
    typeof value.reason === "string" &&
    isRecord(value.proposal);
}

function isAgentLoopMessage(value: unknown) {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.role !== "string") {
    return false;
  }
  if (value.role === "user") {
    return typeof value.content === "string" && typeof value.createdAt === "string";
  }
  if (value.role === "assistant") {
    return typeof value.turnId === "string" &&
      typeof value.rationaleSummary === "string" &&
      typeof value.createdAt === "string" &&
      isAgentLoopAction(value.action) &&
      (
        value.completionValidation === undefined ||
        (
          isRecord(value.completionValidation) &&
          (
            value.completionValidation.status === "accepted" ||
            (
              value.completionValidation.status === "rejected" &&
              typeof value.completionValidation.code === "string" &&
              typeof value.completionValidation.message === "string"
            )
          )
        )
      );
  }
  return value.role === "toolResult" &&
    typeof value.callId === "string" &&
    value.callId.length > 0 &&
    typeof value.tool === "string" &&
    agentLoopToolNames.has(value.tool) &&
    ["success", "error", "blocked", "cancelled"].includes(
      String(value.status)
    ) &&
    typeof value.startedAt === "string" &&
    typeof value.finishedAt === "string";
}

function isAgentLoopRunRecord(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    typeof value.planId !== "string" ||
    !Number.isSafeInteger(value.planRevision) ||
    typeof value.stepId !== "string" ||
    typeof value.status !== "string" ||
    !agentLoopStatuses.has(value.status) ||
    !Array.isArray(value.transcript) ||
    value.transcript.length > 500 ||
    !value.transcript.every(isAgentLoopMessage) ||
    !Array.isArray(value.events) ||
    value.events.length > 1_000 ||
    typeof value.startedAt !== "string" ||
    (value.finishedAt !== null && typeof value.finishedAt !== "string") ||
    !(value.usage === null || isAgentLoopUsage(value.usage))
  ) return false;

  let previousSequence = 0;
  for (const event of value.events) {
    if (
      !isRecord(event) ||
      event.runId !== value.runId ||
      (event.stepId !== undefined && event.stepId !== value.stepId) ||
      !Number.isSafeInteger(event.sequence) ||
      (event.sequence as number) <= previousSequence ||
      typeof event.at !== "string" ||
      typeof event.type !== "string"
    ) return false;
    previousSequence = event.sequence as number;
  }

  if (value.outcome === null) {
    return value.status === "running" || value.status === "failed";
  }
  if (
    !isRecord(value.outcome) ||
    value.outcome.runId !== value.runId ||
    value.outcome.status !== value.status ||
    !Array.isArray(value.outcome.transcript) ||
    !isAgentLoopUsage(value.outcome.usage) ||
    JSON.stringify(value.outcome.transcript) !== JSON.stringify(value.transcript) ||
    JSON.stringify(value.outcome.usage) !== JSON.stringify(value.usage)
  ) return false;
  if (
    value.status === "completed" ||
    value.status === "waiting_user_input" ||
    value.status === "plan_revision_proposed"
  ) {
    return isAgentLoopAction(value.outcome.action) &&
      value.outcome.action.type === (
        value.status === "completed"
          ? "complete_step"
          : value.status === "waiting_user_input"
            ? "ask_clarification"
            : "propose_plan_revision"
      );
  }
  return true;
}

export function isRestorableAgentState(value: unknown): value is AgentState {
  if (
    !isRecord(value) ||
    typeof value.taskId !== "string" ||
    !value.taskId ||
    value.taskId === "unassigned" ||
    typeof value.phase !== "string" ||
    !phases.has(value.phase as AgentPhase) ||
    typeof value.revision !== "number" ||
    !Number.isInteger(value.revision) ||
    typeof value.task !== "string" ||
    !value.task.trim() ||
    (value.approvedRevision !== null &&
      (!Number.isInteger(value.approvedRevision) ||
        (value.approvedRevision as number) > value.revision)) ||
    (value.activeResourceId !== null &&
      typeof value.activeResourceId !== "string") ||
    typeof value.route !== "string" && value.route !== null ||
    !(
      value.routeDecision === null ||
      (isRecord(value.routeDecision) &&
        (value.routeDecision.status === "supported" ||
          value.routeDecision.status === "needs_links" ||
          value.routeDecision.status === "unsupported"))
    ) ||
    !isRecord(value.systemProfile) ||
    !isRecord(value.workspace) ||
    !isRecord(value.agentRun) ||
    !(value.taskPlan === null || taskPlanSchema.safeParse(value.taskPlan).success) ||
    !isTaskPlanValidation(value.taskPlanValidation) ||
    (value.phase === "waiting_task_plan_confirmation" &&
      (value.taskPlan === null ||
        !isRecord(value.taskPlan) ||
        value.taskPlan.status !== "waiting_confirmation" ||
        value.taskPlanValidation === null ||
        !isRecord(value.taskPlanValidation) ||
        value.taskPlanValidation.valid !== true))
  ) {
    return false;
  }

  if (
    value.systemProfile.os !== "Windows 11" ||
    value.systemProfile.architecture !== "x64" ||
    value.systemProfile.shell !== "PowerShell 7" ||
    typeof value.systemProfile.workspaceRoot !== "string" ||
    typeof value.workspace.ready !== "boolean" ||
    typeof value.workspace.manifestRevision !== "number" ||
    !Number.isInteger(value.workspace.manifestRevision) ||
    (value.workspace.overallStatus !== "preparing" &&
      value.workspace.overallStatus !== "ready" &&
      value.workspace.overallStatus !== "partially_ready" &&
      value.workspace.overallStatus !== "failed") ||
    typeof value.workspace.exportStatus !== "string" ||
    !["not_started", "pending", "exporting", "ready", "failed"].includes(
      value.workspace.exportStatus
    ) ||
    !isStringArray(value.workspace.files) ||
    !Array.isArray(value.workspace.fileRecords) ||
    !value.workspace.fileRecords.every(
      (file) =>
        isRecord(file) &&
        typeof file.relativePath === "string" &&
        typeof file.absolutePath === "string" &&
        typeof file.bytesWritten === "number" &&
        Number.isFinite(file.bytesWritten) &&
        typeof file.sha256 === "string" &&
        /^[a-f0-9]{64}$/i.test(file.sha256)
    ) ||
    typeof value.workspace.nextAction !== "string" ||
    !Array.isArray(value.resources) ||
    !Array.isArray(value.localArtifacts) ||
    !isLocalRepositorySummary(value.localRepository) ||
    !isGitHubRepositoryAnalysisSummary(value.githubRepository) ||
    !isGitHubPublishState(value.githubPublish) ||
    !Array.isArray(value.logs) ||
    !Array.isArray(value.clarifications) ||
    !isRecord(value.answers) ||
    !Array.isArray(value.agentRun.decisions) ||
    !Array.isArray(value.agentRun.toolResults) ||
    !Array.isArray(value.agentRun.policyAudit) ||
    !(value.agentRun.agentLoop === null ||
      isAgentLoopRunRecord(value.agentRun.agentLoop)) ||
    !isRecord(value.agentB) ||
    (value.agentB.status !== "idle" &&
      value.agentB.status !== "running" &&
      value.agentB.status !== "completed" &&
      value.agentB.status !== "failed")
  ) {
    return false;
  }

  return value.resources.every(
    (resource) =>
      isRecord(resource) &&
      typeof resource.id === "string" &&
      typeof resource.name === "string" &&
      typeof resource.version === "string" &&
      typeof resource.publisher === "string" &&
      typeof resource.source === "string" &&
      typeof resource.homepage === "string" &&
      typeof resource.releasePage === "string" &&
      typeof resource.sizeMb === "number" &&
      Number.isFinite(resource.sizeMb) &&
      typeof resource.license === "string" &&
      (resource.catalogStatus === "active" ||
        resource.catalogStatus === "deprecated" ||
        resource.catalogStatus === "revoked") &&
      isRecord(resource.verification) &&
      (resource.verification.checksumAlgorithm === "sha256" ||
        resource.verification.checksumAlgorithm === "sha512") &&
      typeof resource.verification.checksumSource === "string" &&
      typeof resource.verification.checksumSourceUrl === "string" &&
      typeof resource.verification.signatureType === "string" &&
      typeof resource.verification.signatureEnforcement === "string" &&
      typeof resource.selected === "boolean" &&
      typeof resource.status === "string" &&
      resourceStatuses.has(resource.status as ResourceStatus) &&
      typeof resource.progress === "number" &&
      Number.isFinite(resource.progress) &&
      typeof resource.attempts === "number" &&
      Number.isInteger(resource.attempts) &&
      isRecord(resource.download) &&
      typeof resource.download.url === "string" &&
      ((typeof resource.download.expectedSha256 === "string" &&
        /^[a-f0-9]{64}$/i.test(resource.download.expectedSha256)) ||
        (resource.download.expectedSha256 === null &&
          (resource.download.digestPolicy === "record-after-download" ||
            (resource.download.digestPolicy === "lockfile-integrity" &&
              isRecord(resource.download.expectedIntegrity) &&
              resource.download.expectedIntegrity.algorithm === "sha512" &&
              typeof resource.download.expectedIntegrity.digestBase64 ===
                "string" &&
              /^[A-Za-z0-9+/]{86}==$/.test(
                resource.download.expectedIntegrity.digestBase64
              ))))) &&
      typeof resource.download.maxSizeMb === "number" &&
      isStringArray(resource.download.allowedHosts)
  );
}

/**
 * 将旧版持久化状态补齐到当前协议，再执行完整恢复校验。
 *
 * 2026-07 主进程迁移前的快照使用 `windows-ai-development` 固定路由，
 * 且没有 `routeDecision`。这里仅补齐可确定推导的路由元数据，不修改
 * revision、审批、资源或执行进度；无法安全推导的损坏状态仍会被拒绝。
 */
export function normalizeRestorableAgentState(
  value: unknown
): AgentState | null {
  if (!isRecord(value)) return null;

  const hasRouteDecision = Object.prototype.hasOwnProperty.call(
    value,
    "routeDecision"
  );
  const legacyRoute =
    value.route === "windows-ai-development"
      ? "ai-development-environment"
      : value.route;

  let candidate: unknown =
    legacyRoute === value.route ? value : { ...value, route: legacyRoute };

  const candidateRecord = candidate as Record<string, unknown>;
  const legacyWorkspace = isRecord(candidateRecord.workspace)
    ? candidateRecord.workspace
    : {};
  const legacyAgentRun = isRecord(candidateRecord.agentRun)
    ? candidateRecord.agentRun
    : {};
  let normalizedTaskPlan: AgentState["taskPlan"] = null;
  let normalizedTaskPlanValidation: AgentState["taskPlanValidation"] = null;
  if (candidateRecord.taskPlan !== null && candidateRecord.taskPlan !== undefined) {
    try {
      normalizedTaskPlan = parseTaskPlan(candidateRecord.taskPlan);
      normalizedTaskPlanValidation = validateTaskPlan(normalizedTaskPlan, {
        tools: defaultTaskPlanToolPolicies,
        requireInitialConfirmation: true
      });
      if (!normalizedTaskPlanValidation.valid) return null;
    } catch {
      return null;
    }
  }
  candidate = {
    ...candidateRecord,
    taskPlan: normalizedTaskPlan,
    taskPlanValidation: normalizedTaskPlanValidation,
    localArtifacts: Array.isArray(candidateRecord.localArtifacts)
      ? candidateRecord.localArtifacts
      : [],
    localRepository: Object.prototype.hasOwnProperty.call(
      candidateRecord,
      "localRepository"
    )
      ? candidateRecord.localRepository
      : null,
    githubRepository: Object.prototype.hasOwnProperty.call(
      candidateRecord,
      "githubRepository"
    )
      ? candidateRecord.githubRepository
      : null,
    githubPublish: isRecord(candidateRecord.githubPublish)
      ? candidateRecord.githubPublish
      : {
          status: "idle",
          plan: null,
          approvedAt: null,
          result: null,
          error: null,
          partialRepositoryUrl: null
        },
    workspace: {
      ...legacyWorkspace,
      manifestRevision:
        typeof legacyWorkspace.manifestRevision === "number"
          ? legacyWorkspace.manifestRevision
          : 0,
      overallStatus:
        legacyWorkspace.overallStatus === "ready" ||
        legacyWorkspace.overallStatus === "partially_ready" ||
        legacyWorkspace.overallStatus === "failed"
          ? legacyWorkspace.overallStatus
        : "preparing"
    },
    agentRun: {
      ...legacyAgentRun,
      agentLoop: Object.prototype.hasOwnProperty.call(
        legacyAgentRun,
        "agentLoop"
      )
        ? legacyAgentRun.agentLoop
        : null
    },
    agentB: isRecord(candidateRecord.agentB)
      ? candidateRecord.agentB
      : {
          status: "idle",
          runId: null,
          grantId: null,
          manifestRevision: null,
          answer: null,
          error: null
        }
  };

  if (!hasRouteDecision) {
    let routeDecision: RouteDecision | null = null;
    if (typeof legacyRoute === "string" && legacyRoute) {
      routeDecision = {
        status: "supported",
        reason: "由旧版固定路由快照迁移到 Domain Skill 路由。",
        skillId: legacyRoute,
        sourceProviderId: "trusted-catalog",
        userLinks: [],
        resourceIds: [],
        clarifications: Array.isArray(value.clarifications)
          ? (value.clarifications as ClarificationQuestion[])
          : [],
        requirements: isRecord(value.taskRequirements)
          ? (value.taskRequirements as TaskRequirements)
          : null
      };
    }
    candidate = { ...(candidate as Record<string, unknown>), routeDecision };
  }

  return isRestorableAgentState(candidate) ? candidate : null;
}
