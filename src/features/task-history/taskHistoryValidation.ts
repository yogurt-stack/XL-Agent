import { isRestorableAgentState } from "../agent-core/persistence";
import type {
  TaskHistoryApproval,
  TaskHistoryDetail,
  TaskHistoryDownloadArtifact,
  TaskHistoryOperationEvent,
  TaskHistorySummary,
  TaskHistoryWorkspaceExport
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTaskHistorySummary(
  value: unknown
): value is TaskHistorySummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.taskId === "string" &&
    value.taskId.length > 0 &&
    typeof value.task === "string" &&
    value.task.trim().length > 0 &&
    typeof value.phase === "string" &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    (value.approvedRevision === null ||
      (typeof value.approvedRevision === "number" &&
        Number.isSafeInteger(value.approvedRevision) &&
        value.approvedRevision <= value.revision)) &&
    typeof value.updatedAt === "string" &&
    !Number.isNaN(Date.parse(value.updatedAt)) &&
    typeof value.resourceCount === "number" &&
    Number.isSafeInteger(value.resourceCount) &&
    value.resourceCount >= 0 &&
    typeof value.verifiedResourceCount === "number" &&
    Number.isSafeInteger(value.verifiedResourceCount) &&
    value.verifiedResourceCount >= 0 &&
    value.verifiedResourceCount <= value.resourceCount &&
    typeof value.workspaceReady === "boolean" &&
    typeof value.hasErrors === "boolean"
  );
}

function isApproval(value: unknown): value is TaskHistoryApproval {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    Number.isSafeInteger(value.revision) &&
    value.actor === "local-user" &&
    typeof value.approvedAt === "string" &&
    typeof value.expiresAt === "string" &&
    typeof value.catalogVersion === "string" &&
    typeof value.catalogSourceSha256 === "string" &&
    (value.status === "active" ||
      value.status === "expired" ||
      value.status === "revoked")
  );
}

function isDownloadArtifact(
  value: unknown
): value is TaskHistoryDownloadArtifact {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    Number.isSafeInteger(value.revision) &&
    typeof value.resourceId === "string" &&
    (value.signatureStatus === "pending" ||
      value.signatureStatus === "valid" ||
      value.signatureStatus === "invalid" ||
      value.signatureStatus === "unsigned" ||
      value.signatureStatus === "unavailable" ||
      value.signatureStatus === "not-applicable") &&
    (value.expectedPublisher === null ||
      typeof value.expectedPublisher === "string") &&
    (value.actualPublisher === null ||
      typeof value.actualPublisher === "string") &&
    (value.certificateThumbprint === null ||
      typeof value.certificateThumbprint === "string") &&
    (value.signatureMessage === null ||
      typeof value.signatureMessage === "string") &&
    (value.signatureCheckedAt === null ||
      typeof value.signatureCheckedAt === "string")
  );
}

function isOperationEvent(
  value: unknown
): value is TaskHistoryOperationEvent {
  return (
    isRecord(value) &&
    typeof value.eventId === "string" &&
    typeof value.taskId === "string" &&
    Number.isSafeInteger(value.revision) &&
    (value.resourceId === null || typeof value.resourceId === "string") &&
    typeof value.eventType === "string" &&
    (value.outcome === "success" ||
      value.outcome === "denied" ||
      value.outcome === "error") &&
    typeof value.createdAt === "string"
  );
}

function isWorkspaceExport(
  value: unknown
): value is TaskHistoryWorkspaceExport {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    Number.isSafeInteger(value.revision) &&
    typeof value.rootPath === "string" &&
    typeof value.generatedAt === "string" &&
    typeof value.reusedExisting === "boolean" &&
    Array.isArray(value.files) &&
    value.files.every(
      (file) =>
        isRecord(file) &&
        typeof file.relativePath === "string" &&
        typeof file.absolutePath === "string" &&
        typeof file.bytesWritten === "number" &&
        typeof file.sha256 === "string"
    )
  );
}

export function parseTaskHistoryDetail(
  value: unknown,
  expectedTaskId: string
): TaskHistoryDetail | null {
  if (
    !isRecord(value) ||
    !isTaskHistorySummary(value.summary) ||
    value.summary.taskId !== expectedTaskId ||
    !isRestorableAgentState(value.state) ||
    value.state.taskId !== expectedTaskId ||
    value.state.task !== value.summary.task ||
    value.state.phase !== value.summary.phase ||
    value.state.revision !== value.summary.revision ||
    !Array.isArray(value.approvals) ||
    !value.approvals.every(
      (approval) =>
        isApproval(approval) && approval.taskId === expectedTaskId
    ) ||
    !Array.isArray(value.workspaceExports) ||
    !value.workspaceExports.every(
      (output) =>
        isWorkspaceExport(output) && output.taskId === expectedTaskId
    ) ||
    !Array.isArray(value.downloadArtifacts) ||
    !value.downloadArtifacts.every(
      (artifact) =>
        isDownloadArtifact(artifact) &&
        artifact.taskId === expectedTaskId
    ) ||
    !Array.isArray(value.operationEvents) ||
    !value.operationEvents.every(
      (event) =>
        isOperationEvent(event) && event.taskId === expectedTaskId
    )
  ) {
    return null;
  }

  return {
    summary: value.summary,
    state: value.state,
    approvals: value.approvals,
    workspaceExports: value.workspaceExports,
    downloadArtifacts: value.downloadArtifacts,
    operationEvents: value.operationEvents
  };
}
