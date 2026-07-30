import type { AgentState } from "../agent-core/types";

export type TaskHistorySummary = {
  taskId: string;
  task: string;
  phase: string;
  revision: number;
  approvedRevision: number | null;
  updatedAt: string;
  resourceCount: number;
  verifiedResourceCount: number;
  workspaceReady: boolean;
  hasErrors: boolean;
};

export type TaskHistoryApproval = {
  taskId: string;
  revision: number;
  actor: "local-user";
  approvedAt: string;
  expiresAt: string;
  status: "active" | "expired" | "revoked";
  catalogVersion: string;
  catalogSourceSha256: string;
};

export type TaskHistoryDownloadArtifact = {
  taskId: string;
  revision: number;
  resourceId: string;
  signatureStatus:
    | "pending"
    | "valid"
    | "invalid"
    | "unsigned"
    | "unavailable"
    | "not-applicable";
  expectedPublisher: string | null;
  actualPublisher: string | null;
  certificateThumbprint: string | null;
  signatureMessage: string | null;
  signatureCheckedAt: string | null;
};

export type TaskHistoryOperationEvent = {
  eventId: string;
  taskId: string;
  revision: number;
  resourceId: string | null;
  eventType: string;
  outcome: "success" | "denied" | "error";
  detail: unknown;
  createdAt: string;
};

export type TaskHistoryWorkspaceExport = {
  taskId: string;
  revision: number;
  rootPath: string;
  generatedAt: string;
  reusedExisting: boolean;
  files: Array<{
    relativePath: string;
    absolutePath: string;
    bytesWritten: number;
    sha256: string;
  }>;
};

export type TaskHistoryDetailPayload = {
  summary: TaskHistorySummary;
  state: unknown;
  approvals: TaskHistoryApproval[];
  workspaceExports: TaskHistoryWorkspaceExport[];
  downloadArtifacts: TaskHistoryDownloadArtifact[];
  operationEvents: TaskHistoryOperationEvent[];
};

export type TaskHistoryDetail = Omit<TaskHistoryDetailPayload, "state"> & {
  state: AgentState;
};

export type TaskHistoryIpcError = {
  code: "TASK_HISTORY_INVALID_REQUEST" | "TASK_HISTORY_READ_FAILED";
  message: string;
  retriable: boolean;
};
