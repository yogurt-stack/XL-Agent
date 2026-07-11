export type AgentPhase =
  | "intake"
  | "routing"
  | "clarifying"
  | "planning"
  | "waiting_approval"
  | "downloading"
  | "verifying"
  | "replanning"
  | "handoff"
  | "cancelled";

export type ResourceStatus =
  | "pending"
  | "queued"
  | "downloading"
  | "downloaded"
  | "verified"
  | "failed"
  | "skipped"
  | "replaced";

export type ReplanReason = "download_failed" | "version_mismatch" | "required_resource_cancelled";

export type ClarificationQuestion = {
  id: string;
  prompt: string;
  reason: string;
  required: boolean;
  options: string[];
};

export type TrustedResource = {
  id: string;
  name: string;
  version: string;
  source: string;
  sizeMb: number;
  license: string;
  purpose: string;
  recommendation: string;
  required: boolean;
  dependsOn: string[];
  fallbackId?: string;
};

export type PlannedResource = TrustedResource & {
  selected: boolean;
  status: ResourceStatus;
  progress: number;
  attempts: number;
  replacedFrom?: string;
  failureReason?: string;
};

export type AgentLogEntry = {
  id: number;
  at: string;
  level: "info" | "warning" | "error" | "success";
  message: string;
};

export type SystemProfile = {
  os: "Windows 11";
  architecture: "x64";
  shell: "PowerShell 7";
  workspaceRoot: "C:\\XunleiAgent\\ai-dev-env-windows";
};

export type WorkspaceHandoff = {
  ready: boolean;
  generatedAt?: string;
  files: string[];
  nextAction: string;
};

export type AgentState = {
  phase: AgentPhase;
  revision: number;
  task: string;
  route: string | null;
  systemProfile: SystemProfile;
  clarifications: ClarificationQuestion[];
  clarificationIndex: number;
  answers: Record<string, string | "skipped">;
  resources: PlannedResource[];
  replanReason: ReplanReason | null;
  activeResourceId: string | null;
  logs: AgentLogEntry[];
  workspace: WorkspaceHandoff;
};

export type AgentEvent =
  | { type: "SUBMIT_TASK"; task: string }
  | { type: "ROUTE_RESOLVED" }
  | { type: "ANSWER_CLARIFICATION"; questionId: string; answer: string }
  | { type: "SKIP_CLARIFICATION"; questionId: string }
  | { type: "PLAN_GENERATED" }
  | { type: "TOGGLE_RESOURCE"; resourceId: string; selected: boolean }
  | { type: "APPROVE_PLAN" }
  | { type: "DOWNLOAD_PROGRESS"; resourceId: string; progress: number }
  | { type: "DOWNLOAD_FAILED"; resourceId: string; reason: string }
  | { type: "REPLAN_GENERATED" }
  | { type: "VERIFY_RESOURCES"; versionMismatchResourceId?: string }
  | { type: "CANCEL_TASK" }
  | { type: "RESET" };
