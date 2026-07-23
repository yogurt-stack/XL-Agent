export type AgentPhase =
  | "intake"
  | "routing"
  | "clarifying"
  | "planning"
  | "waiting_approval"
  | "downloading"
  | "awaiting_failure_action"
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

export type ReplanStrategy = "trusted-mirror" | "primary-retry";

export type FailureResolutionAction = ReplanStrategy | "delegate-agent-b";

export type TargetOperatingSystem = "Windows 11";

export type TargetArchitecture = "x64";

export type HostPlatform = "darwin" | "linux" | "win32" | "unknown";

export type HostArchitecture = "x64" | "arm64" | "other";

export type ResourceCapability =
  | "python-runtime"
  | "code-editor"
  | "source-control"
  | "node-runtime"
  | "workspace-template";

export type ResourceSourceTrust = "official" | "trusted-catalog" | "trusted-mirror" | "unverified";

export type LocalTaskIntent = "python-ai" | "fullstack-ai" | "base-development" | "ambiguous";

export type TaskRequirements = {
  intent: LocalTaskIntent;
  label: string;
  requiredCapabilities: ResourceCapability[];
};

export type PlanValidationIssueCode =
  | "TASK_REQUIREMENTS_UNRESOLVED"
  | "EMPTY_PLAN"
  | "UNKNOWN_RESOURCE"
  | "DUPLICATE_RESOURCE"
  | "REQUIRED_RESOURCE_NOT_SELECTED"
  | "MISSING_REQUIRED_CAPABILITY"
  | "MISSING_DEPENDENCY_CAPABILITY"
  | "INCOMPATIBLE_SYSTEM"
  | "UNTRUSTED_SOURCE"
  | "LICENSE_NOT_ALLOWED"
  | "INVALID_FALLBACK"
  | "RESOURCE_METADATA_MISMATCH"
  | "REVISION_MISMATCH";

export type PlanValidationIssue = {
  code: PlanValidationIssueCode;
  message: string;
  resourceId?: string;
  capability?: ResourceCapability;
};

export type PlanValidationResult = {
  valid: boolean;
  checkedRevision: number;
  issues: PlanValidationIssue[];
};

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
  provides: ResourceCapability[];
  requiresCapabilities: ResourceCapability[];
  supportedOperatingSystems: TargetOperatingSystem[];
  supportedArchitectures: TargetArchitecture[];
  sourceTrust: ResourceSourceTrust;
  download: TrustedDownloadMetadata;
  fallbackId?: string;
};

export type TrustedDownloadMetadata = {
  url: string;
  expectedSha256: string;
  maxSizeMb: number;
  allowedHosts: string[];
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
  os: TargetOperatingSystem;
  architecture: TargetArchitecture;
  shell: "PowerShell 7";
  workspaceRoot: "C:\\XunleiAgent\\ai-dev-env-windows";
};

export type HostSystemProfile = {
  platform: HostPlatform;
  platformLabel: string;
  architecture: HostArchitecture;
  release: string;
  cpuCount: number;
  totalMemoryGb: number;
  defaultShell: string;
  collectedBy: "electron-main" | "renderer-fallback";
  collectedAt: string;
  privacy: {
    hostname: false;
    username: false;
    homeDirectory: false;
    environment: false;
    shellPath: false;
  };
};

export type SystemProfileToolOutput = {
  targetProfile: SystemProfile;
  hostProfile: HostSystemProfile;
  planningProfileSource: "locked-demo-target";
  boundary: "Host profile is read-only telemetry; plan validation still uses the locked Windows target profile.";
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
  hostProfile: HostSystemProfile | null;
  clarifications: ClarificationQuestion[];
  clarificationIndex: number;
  answers: Record<string, string | "skipped">;
  resources: PlannedResource[];
  replanReason: ReplanReason | null;
  requestedReplanStrategy: ReplanStrategy | null;
  activeResourceId: string | null;
  logs: AgentLogEntry[];
  workspace: WorkspaceHandoff;
  planExplanation: string | null;
  taskRequirements: TaskRequirements | null;
  planValidation: PlanValidationResult | null;
  approvedRevision: number | null;
  agentRun: AgentRunState;
};

export type AgentToolName =
  | "read_system_profile"
  | "search_trusted_catalog"
  | "simulate_download"
  | "controlled_download";

export type AgentToolCall =
  | {
      callId: string;
      name: "read_system_profile";
      input: Record<never, never>;
    }
  | {
      callId: string;
      name: "search_trusted_catalog";
      input: {
        query: string;
        resourceIds?: string[];
      };
    }
  | {
      callId: string;
      name: "simulate_download";
      input: {
        resourceId: string;
      };
    }
  | {
      callId: string;
      name: "controlled_download";
      input: {
        resourceId: string;
      };
    };

export type AgentAction =
  | {
      actionId: string;
      type: "ask_clarification";
      questionId: string;
      question: string;
      reason: string;
      required: boolean;
      options: string[];
    }
  | {
      actionId: string;
      type: "create_plan";
      resourceIds: string[];
      explanation: string;
    }
  | {
      actionId: string;
      type: "create_replan";
      strategy: ReplanStrategy;
      explanation: string;
    }
  | {
      actionId: string;
      type: "call_tool";
      call: AgentToolCall;
      purpose: string;
    }
  | {
      actionId: string;
      type: "finish";
      summary: string;
    };

export type ToolResult = {
  callId: string;
  tool: AgentToolName;
  status: "success" | "error" | "cancelled";
  output?: unknown;
  error?: {
    code: string;
    message: string;
    retriable: boolean;
  };
  startedAt: string;
  finishedAt: string;
};

export type SimulatedDownloadOutput = {
  resourceId: string;
  progress: number;
};

export type ControlledDownloadOutput = {
  resourceId: string;
  urlHost: string;
  bytesWritten: number;
  sha256: string;
  tempFilePath: string;
  elapsedMs: number;
};

export type ControlledDownloadError = {
  code: string;
  message: string;
  retriable: boolean;
};

export type ControlledDownloadResult =
  | { ok: true; output: ControlledDownloadOutput }
  | { ok: false; error: ControlledDownloadError };

export type ModelContext = {
  state: AgentState;
  step: number;
  maxSteps: number;
  availableTools: AgentToolName[];
  toolResults: ToolResult[];
};

export type ModelDecision = {
  decisionId: string;
  provider: "local-rule" | "remote-llm";
  model: string;
  explanation: string;
  action: AgentAction;
};

export type PolicyRiskLevel = "low" | "medium" | "high";

export type PolicyDecision =
  | {
      outcome: "allow";
      risk: PolicyRiskLevel;
      reason: string;
    }
  | {
      outcome: "require_approval";
      risk: "medium" | "high";
      reason: string;
      approvalId: string;
    }
  | {
      outcome: "deny";
      risk: PolicyRiskLevel;
      reason: string;
    };

export type PolicyAuditEntry = {
  actionId: string;
  decision: PolicyDecision;
};

export type AgentRunState = {
  step: number;
  maxSteps: number;
  status:
    | "idle"
    | "thinking"
    | "waiting_tool"
    | "waiting_approval"
    | "executing"
    | "delegated"
    | "complete"
    | "failed";
  decisions: ModelDecision[];
  toolResults: ToolResult[];
  policyAudit: PolicyAuditEntry[];
};

export type AgentEvent =
  | { type: "SUBMIT_TASK"; task: string }
  | { type: "ROUTE_RESOLVED"; route: string }
  | { type: "ANSWER_CLARIFICATION"; questionId: string; answer: string }
  | { type: "SKIP_CLARIFICATION"; questionId: string }
  | { type: "PLAN_GENERATED" }
  | { type: "TOGGLE_RESOURCE"; resourceId: string; selected: boolean }
  | { type: "APPROVE_PLAN"; revision: number }
  | { type: "DOWNLOAD_PROGRESS"; resourceId: string; progress: number }
  | { type: "DOWNLOAD_FAILED"; resourceId: string; reason: string }
  | { type: "RESOLVE_DOWNLOAD_FAILURE"; action: FailureResolutionAction }
  | { type: "REPLAN_GENERATED"; strategy: ReplanStrategy }
  | { type: "VERIFY_RESOURCES"; versionMismatchResourceId?: string }
  | { type: "MODEL_DECISION_RECORDED"; decision: ModelDecision }
  | { type: "MODEL_POLICY_RECORDED"; actionId: string; decision: PolicyDecision }
  | { type: "MODEL_TOOL_COMPLETED"; result: ToolResult }
  | { type: "MODEL_CLARIFICATION_REQUESTED"; question: ClarificationQuestion }
  | { type: "MODEL_PLAN_PROPOSED"; resourceIds: string[]; explanation: string }
  | { type: "MODEL_REPLAN_PROPOSED"; strategy: ReplanStrategy; explanation: string }
  | { type: "MODEL_FINISHED"; summary: string }
  | { type: "MODEL_STEP_LIMIT_REACHED" }
  | { type: "MODEL_RUNTIME_FAILED"; reason: string }
  | { type: "CANCEL_TASK" }
  | { type: "RESET" };
