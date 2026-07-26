import type {
  AgentPhase,
  AgentState,
  ClarificationQuestion,
  ResourceStatus,
  RouteDecision,
  TaskRequirements
} from "./types";

const phases = new Set<AgentPhase>([
  "intake",
  "routing",
  "unsupported",
  "clarifying",
  "planning",
  "waiting_approval",
  "downloading",
  "awaiting_failure_action",
  "verifying",
  "exporting",
  "awaiting_export_retry",
  "replanning",
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
    !isRecord(value.agentRun)
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
    !Array.isArray(value.logs) ||
    !Array.isArray(value.clarifications) ||
    !isRecord(value.answers) ||
    !Array.isArray(value.agentRun.decisions) ||
    !Array.isArray(value.agentRun.toolResults) ||
    !Array.isArray(value.agentRun.policyAudit) ||
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
      resource.verification.checksumAlgorithm === "sha256" &&
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
      typeof resource.download.expectedSha256 === "string" &&
      /^[a-f0-9]{64}$/i.test(resource.download.expectedSha256) &&
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
  candidate = {
    ...candidateRecord,
    localArtifacts: Array.isArray(candidateRecord.localArtifacts)
      ? candidateRecord.localArtifacts
      : [],
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
