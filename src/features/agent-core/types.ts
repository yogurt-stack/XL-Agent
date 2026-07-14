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
  requestedReplanStrategy: ReplanStrategy | null;
  activeResourceId: string | null;
  logs: AgentLogEntry[];
  workspace: WorkspaceHandoff;
  planExplanation: string | null;
  agentRun: AgentRunState;
};

export type AgentToolName =
  | "read_system_profile"
  | "search_trusted_catalog"
  | "simulate_download";

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
  | { type: "APPROVE_PLAN" }
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
