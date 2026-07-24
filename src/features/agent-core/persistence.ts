import type { AgentPhase, AgentState, ResourceStatus } from "./types";

const phases = new Set<AgentPhase>([
  "intake",
  "routing",
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
    !Array.isArray(value.logs) ||
    !Array.isArray(value.clarifications) ||
    !isRecord(value.answers) ||
    !Array.isArray(value.agentRun.decisions) ||
    !Array.isArray(value.agentRun.toolResults) ||
    !Array.isArray(value.agentRun.policyAudit)
  ) {
    return false;
  }

  return value.resources.every(
    (resource) =>
      isRecord(resource) &&
      typeof resource.id === "string" &&
      typeof resource.name === "string" &&
      typeof resource.version === "string" &&
      typeof resource.source === "string" &&
      typeof resource.sizeMb === "number" &&
      Number.isFinite(resource.sizeMb) &&
      typeof resource.license === "string" &&
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
      typeof resource.download.maxSizeMb === "number" &&
      isStringArray(resource.download.allowedHosts)
  );
}
