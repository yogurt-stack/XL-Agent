import type {
  AgentLoopEvent,
  AgentLoopMessage,
  AgentLoopResult,
  AgentLoopUsage
} from "./agentLoop";

export type AgentPhase =
  | "intake"
  | "routing"
  | "unsupported"
  | "task_planning"
  | "waiting_task_plan_confirmation"
  | "clarifying"
  | "planning"
  | "waiting_approval"
  | "downloading"
  | "awaiting_failure_action"
  | "verifying"
  | "exporting"
  | "awaiting_export_retry"
  | "replanning"
  | "result"
  | "handoff"
  | "cancelled";

export type ResourceStatus =
  | "pending"
  | "queued"
  | "downloading"
  | "paused"
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
  | "powershell-runtime"
  | "project-source"
  | "offline-node-package"
  | "workspace-template";

export type ResourceSourceTrust =
  | "official"
  | "trusted-catalog"
  | "trusted-mirror"
  | "github-api"
  | "npm-lockfile"
  | "unverified";

export type TrustedCatalogStatus = "active" | "not-yet-valid" | "expired" | "invalid";

export type TrustedCatalogMetadata = {
  schemaVersion: 1;
  catalogVersion: string;
  generatedAt: string;
  expiresAt: string;
  sourceSha256: string;
};

export type TrustedResourceVerification = {
  checksumAlgorithm: "sha256" | "sha512";
  checksumSource:
    | "vendor-manifest"
    | "github-release-asset-digest"
    | "computed-on-download"
    | "npm-lockfile-integrity"
    | "pinned-repository-snapshot";
  checksumSourceUrl: string;
  signatureType: "authenticode" | "upstream-release" | "none";
  expectedPublisher?: string;
  signatureEnforcement: "required" | "checksum-only" | "not-applicable";
};

export type LocalTaskIntent = "python-ai" | "fullstack-ai" | "base-development" | "ambiguous";

export type TaskRequirements = {
  intent: LocalTaskIntent | "user-links" | `skill:${string}`;
  label: string;
  requiredCapabilities: ResourceCapability[];
};

export type RouteStatus = "supported" | "needs_links" | "unsupported";

export type RouteDecision = {
  status: RouteStatus;
  reason: string;
  skillId: string | null;
  sourceProviderId: string | null;
  userLinks: string[];
  resourceIds: string[];
  clarifications: ClarificationQuestion[];
  requirements: TaskRequirements | null;
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

export type TaskPlanStatus =
  | "draft"
  | "waiting_confirmation"
  | "executing"
  | "waiting_user_input"
  | "waiting_approval"
  | "replanning"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskPlanStepKind =
  | "read_tool"
  | "analysis"
  | "user_decision"
  | "resource_plan"
  | "write_tool"
  | "verification"
  | "handoff";

export type TaskPlanStepStatus =
  | "pending"
  | "running"
  | "waiting_user_input"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "skipped"
  | "blocked";

export type TaskPlanRisk =
  | "read_only"
  | "local_write"
  | "external_write"
  | "code_execution";

export type TaskPlanInputBinding = {
  sourceStepId: string;
  outputPath: string;
  required: boolean;
};

export type TaskPlanStepApproval = {
  required: boolean;
  reason: string | null;
  status: "not_required" | "pending" | "approved";
  approvedAt: string | null;
  approvedRevision: number | null;
};

export type TaskPlanStepResult = {
  reference: string;
  summary: string;
  output?: unknown;
};

/**
 * How a TaskPlan step is executed. Existing plans omit this field and retain
 * the deterministic executor behavior. Agent-loop execution is deliberately
 * limited to a read-only capability envelope; any broader action must be
 * proposed as a new TaskPlan revision.
 */
export type TaskPlanStepExecution =
  | {
      mode: "deterministic";
    }
  | {
      mode: "agent_loop";
      allowedTools: AgentToolName[];
      maxRisk: "read_only";
      allowParallelReads: boolean;
      maxTurns: number;
      maxToolCalls: number;
      maxRepeatedCalls: number;
      maxWallTimeMs: number;
      completionCriteria: string[];
    };

export type TaskPlanStepProposal = {
  id: string;
  title: string;
  description: string;
  kind: TaskPlanStepKind;
  tool: string | null;
  dependsOn: string[];
  staticInput: Record<string, unknown>;
  inputBindings: Record<string, TaskPlanInputBinding>;
  expectedOutput: string;
  risk: TaskPlanRisk;
  approval: {
    required: boolean;
    reason: string | null;
  };
  /** Omitted by legacy plans and deterministic steps. */
  execution?: TaskPlanStepExecution;
};

export type TaskPlanProposal = {
  objective: string;
  deliverables: string[];
  assumptions: string[];
  constraints: string[];
  steps: TaskPlanStepProposal[];
  confirmation: {
    required: boolean;
    reason: string | null;
  };
};

export type TaskPlanStep = Omit<TaskPlanStepProposal, "execution"> & {
  execution: TaskPlanStepExecution;
  status: TaskPlanStepStatus;
  approval: TaskPlanStepApproval;
  result: TaskPlanStepResult | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type TaskPlanConfirmation = {
  required: boolean;
  reason: string | null;
  status: "not_required" | "pending" | "confirmed";
  confirmedAt: string | null;
  confirmedRevision: number | null;
};

export type TaskPlan = {
  schemaVersion: 2;
  planId: string;
  taskId: string;
  revision: number;
  previousRevision: number | null;
  revisionReason: string;
  objective: string;
  deliverables: string[];
  assumptions: string[];
  constraints: string[];
  steps: TaskPlanStep[];
  status: TaskPlanStatus;
  confirmation: TaskPlanConfirmation;
  createdBy: "local-rule" | "remote-llm" | "user";
  createdAt: string;
  updatedAt: string;
};

export type TaskPlanToolPolicy = {
  name: string;
  allowedStepKinds: TaskPlanStepKind[];
  risk: TaskPlanRisk;
  approvalRequired: boolean;
  /** Explicit opt-in; read_only alone is not enough to enter AgentLoop. */
  agentLoopAllowed: boolean;
};

export type TaskPlanValidationIssueCode =
  | "INVALID_REVISION"
  | "INITIAL_CONFIRMATION_REQUIRED"
  | "EMPTY_PLAN"
  | "TOO_MANY_STEPS"
  | "DUPLICATE_STEP"
  | "UNKNOWN_DEPENDENCY"
  | "SELF_DEPENDENCY"
  | "CYCLIC_DEPENDENCY"
  | "UNKNOWN_BINDING_SOURCE"
  | "BINDING_DEPENDENCY_MISSING"
  | "USER_DECISION_PROTOCOL_INVALID"
  | "TOOL_REQUIRED"
  | "TOOL_NOT_ALLOWED"
  | "TOOL_KIND_MISMATCH"
  | "TOOL_RISK_MISMATCH"
  | "AGENT_LOOP_EXECUTION_REQUIRED"
  | "AGENT_LOOP_STEP_KIND_INVALID"
  | "AGENT_LOOP_TOOL_NOT_ALLOWED"
  | "AGENT_LOOP_TOOL_DUPLICATE"
  | "AGENT_LOOP_TOOL_RISK_INVALID"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_REASON_REQUIRED"
  | "APPROVAL_REVISION_MISMATCH"
  | "INVALID_PLAN_STATUS"
  | "INVALID_STEP_STATUS";

export type TaskPlanValidationIssue = {
  code: TaskPlanValidationIssueCode;
  message: string;
  stepId?: string;
  dependencyId?: string;
  tool?: string;
};

export type TaskPlanValidationResult = {
  valid: boolean;
  checkedRevision: number;
  issues: TaskPlanValidationIssue[];
  topologicalOrder: string[];
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
  publisher: string;
  source: string;
  homepage: string;
  releasePage: string;
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
  catalogStatus: "active" | "deprecated" | "revoked";
  statusReason?: string;
  replacedBy?: string;
  verification: TrustedResourceVerification;
  download: TrustedDownloadMetadata;
  github?: GitHubRepositoryProvenance;
  npm?: NpmPackageProvenance;
  fallbackId?: string;
};

export type TrustedDownloadMetadata = {
  url: string;
  expectedSha256: string | null;
  digestPolicy?:
    | "preverified"
    | "record-after-download"
    | "lockfile-integrity";
  expectedIntegrity?: {
    algorithm: "sha512";
    digestBase64: string;
  };
  maxSizeMb: number;
  allowedHosts: string[];
};

export type GitHubProjectEcosystem =
  | "node"
  | "python"
  | "rust"
  | "go"
  | "cpp"
  | "unknown";

export type GitHubProjectAnalysis = {
  ecosystems: GitHubProjectEcosystem[];
  manifests: string[];
  lockfiles: string[];
  runtimeHints: string[];
  nodeOfflinePreparation:
    | "package-lock-supported"
    | "lockfile-unsupported"
    | "not-node";
  nodeOfflinePackageCount: number;
  nodeOfflineBlockers: string[];
  treeTruncated: boolean;
};

export type GitHubRepositoryProvenance = {
  fullName: string;
  owner: string;
  repository: string;
  defaultBranch: string;
  commitSha: string;
  treeSha: string;
  archiveFormat: "zip";
  inspectedAt: string;
  analysis: GitHubProjectAnalysis;
};

export type LocalRepositorySummary = {
  repositoryHandleId: string;
  displayName: string;
  fingerprint: string;
  commitSha: string;
  branch: string | null;
  detached: boolean;
  clean: boolean;
  status: {
    modified: number;
    deleted: number;
    untracked: number;
    conflicted: number;
    ahead: number;
    behind: number;
  };
  fileCount: number;
  trackedFileCount: number;
  hasSubmodules: boolean;
  hasSymlinks: boolean;
  inspectedAt: string;
  analysis: GitHubProjectAnalysis;
};

export type GitHubRepositoryAnalysisSummary = {
  repositoryHandleId: string;
  fullName: string;
  displayName: string;
  defaultBranch: string;
  commitSha: string;
  treeSha: string;
  trackedFileCount: number;
  treeTruncated: boolean;
  inspectedAt: string;
  analysis: GitHubProjectAnalysis;
};

export type GitHubPublishPlan = {
  publishId: string;
  repositoryHandleId: string;
  sourceFingerprint: string;
  sourceCommitSha: string;
  sourceBranch: string | null;
  targetOwner: string;
  targetRepository: string;
  targetVisibility: "private" | "public";
  targetBranch: string;
  commitMessage: string;
  fileCount: number;
  totalBytes: number;
  createRepository: true;
  force: false;
  createdAt: string;
  expiresAt: string;
  planSha256: string;
};

export type GitHubPublishResult = {
  publishId: string;
  repositoryUrl: string;
  fullName: string;
  branch: string;
  commitSha: string;
  fileCount: number;
  publishedAt: string;
};

export type GitHubPublishState = {
  status:
    | "idle"
    | "waiting_approval"
    | "publishing"
    | "published"
    | "failed";
  plan: GitHubPublishPlan | null;
  approvedAt: string | null;
  result: GitHubPublishResult | null;
  error: string | null;
  partialRepositoryUrl: string | null;
};

export type NpmPackageProvenance = {
  packageName: string;
  version: string;
  resolvedUrl: string;
  integrity: string;
  license: string;
  dependencyKind: "production" | "development" | "optional";
  lockfilePath: string;
  repositoryFullName: string;
  repositoryCommitSha: string;
};

export type PlannedResource = TrustedResource & {
  selected: boolean;
  status: ResourceStatus;
  progress: number;
  attempts: number;
  bytesWritten?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
  replacedFrom?: string;
  failureReason?: string;
};

export type LocalArtifactSummary = {
  artifactId: string;
  fileName: string;
  displayPath: string;
  bytesWritten: number;
  sha256: string;
  matchedResourceId: string | null;
  verificationStatus: "local-verified" | "unverified";
  importedAt: string;
};

export type WorkspaceOverallStatus =
  | "preparing"
  | "ready"
  | "partially_ready"
  | "failed";

export type AgentBInspectionAnswer = {
  manifestRevision: number;
  planRevision: number;
  workspaceStatus: WorkspaceOverallStatus;
  preparedRequiredResources: string[];
  missingOrFailedResources: string[];
  allowedActions: string[];
  forbiddenActions: string[];
  integrity: "valid" | "invalid";
  projectReadiness?: {
    source?: "github" | "local";
    fullName: string;
    commitSha: string;
    branch?: string | null;
    clean?: boolean;
    ecosystems: GitHubProjectEcosystem[];
    manifests: string[];
    lockfiles: string[];
    runtimeHints: string[];
    dependencyPreparation:
      | "package-lock-supported"
      | "lockfile-unsupported"
      | "not-node";
    offlinePackageCount: number;
    offlineBlockers: string[];
    selectedOfflinePackages: number;
    treeTruncated: boolean;
  } | null;
  summary: string;
};

export type AgentBRunState = {
  status: "idle" | "running" | "completed" | "failed";
  runId: string | null;
  grantId: string | null;
  manifestRevision: number | null;
  answer: AgentBInspectionAnswer | null;
  error: string | null;
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
  exportStatus: "not_started" | "pending" | "exporting" | "ready" | "failed";
  rootPath?: string;
  targetRootPath?: string;
  currentSnapshotRootPath?: string;
  manifestRevision: number;
  overallStatus: WorkspaceOverallStatus;
  fileRecords: WorkspaceFileRecord[];
  exportError?: string;
};

export type WorkspaceFileRecord = {
  relativePath: string;
  absolutePath: string;
  bytesWritten: number;
  sha256: string;
};

export type AgentState = {
  taskId: string;
  phase: AgentPhase;
  revision: number;
  task: string;
  route: string | null;
  routeDecision: RouteDecision | null;
  taskPlan: TaskPlan | null;
  taskPlanValidation: TaskPlanValidationResult | null;
  systemProfile: SystemProfile;
  hostProfile: HostSystemProfile | null;
  clarifications: ClarificationQuestion[];
  clarificationIndex: number;
  answers: Record<string, string | "skipped">;
  resources: PlannedResource[];
  localArtifacts: LocalArtifactSummary[];
  localRepository: LocalRepositorySummary | null;
  githubRepository: GitHubRepositoryAnalysisSummary | null;
  githubPublish: GitHubPublishState;
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
  agentB: AgentBRunState;
};

export type AgentToolName =
  | "read_system_profile"
  | "inspect_local_development_environment"
  | "list_local_repository_tree"
  | "read_local_repository_file"
  | "inspect_project_requirements"
  | "list_github_repository_tree"
  | "read_github_repository_file"
  | "inspect_github_project_requirements"
  | "search_trusted_catalog"
  | "search_github_repositories"
  | "simulate_download"
  | "controlled_download"
  | "export_workspace";

export type GitHubRepositorySort = "stars" | "updated" | "forks";

export type GitHubRepositoryDiscoverySearchInput = {
  mode: "discovery";
  keywords: string;
  createdWithinDays: 7 | 30 | 90;
  sort: GitHubRepositorySort;
  limit: number;
};

export type GitHubRepositoryNameSearchInput = {
  mode: "name";
  query: string;
  limit: number;
};

export type GitHubRepositoryExactSearchInput = {
  mode: "exact";
  fullName: string;
  limit: 1;
};

export type GitHubRepositorySearchInput =
  | GitHubRepositoryDiscoverySearchInput
  | GitHubRepositoryNameSearchInput
  | GitHubRepositoryExactSearchInput;

export type GitHubRepositorySummary = {
  id: number;
  fullName: string;
  url: string;
  description: string | null;
  stars: number;
  forks: number;
  openIssues: number;
  language: string | null;
  topics: string[];
  license: {
    spdxId: string;
    name: string;
  };
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
};

export type GitHubRepositorySearchOutput = {
  criteria:
    | {
        mode: "discovery";
        keywords: string;
        createdWithinDays: 7 | 30 | 90;
        createdAfter: string;
        sort: GitHubRepositorySort;
        order: "desc";
        licenseRequired: true;
      }
    | {
        mode: "name";
        query: string;
        match: "repository-name";
        order: "best-match";
        licenseRequired: true;
      }
    | {
        mode: "exact";
        fullName: string;
        match: "exact";
        licenseRequired: true;
      };
  repositories: GitHubRepositorySummary[];
  totalCount: number;
  incompleteResults: boolean;
  fetchedAt: string;
  authenticated: boolean;
  rateLimit: {
    remaining: number | null;
    resetAt: string | null;
  };
};

export type GitHubRepositorySearchError = {
  code: string;
  message: string;
  retriable: boolean;
};

export type GitHubRepositorySearchResult =
  | { ok: true; output: GitHubRepositorySearchOutput }
  | { ok: false; error: GitHubRepositorySearchError };

export type DevelopmentEnvironmentToolId =
  | "node"
  | "npm"
  | "python3"
  | "python"
  | "py"
  | "pip3"
  | "pip"
  | "git"
  | "cmake"
  | "qt"
  | "occt"
  | "cuda-compiler"
  | "nvidia-gpu";

export type DevelopmentEnvironmentToolStatus =
  | "available"
  | "not_found"
  | "not_applicable"
  | "error";

export type DevelopmentEnvironmentToolVersion = {
  id: DevelopmentEnvironmentToolId;
  name: string;
  command: string;
  status: DevelopmentEnvironmentToolStatus;
  version: string | null;
  detail: string | null;
};

export type LocalDevelopmentEnvironmentOutput = {
  host: {
    platform: HostPlatform;
    architecture: HostArchitecture;
  };
  tools: DevelopmentEnvironmentToolVersion[];
  collectedAt: string;
  source: "electron-main-fixed-command-allowlist" | "in-memory-fallback";
  boundary: "read-only-fixed-command-allowlist";
};

export type LocalRepositoryTreeOutput = {
  repository: {
    repositoryHandleId: string;
    displayName: string;
    commitSha: string;
  };
  pathPrefix: string;
  entries: Array<{
    relativePath: string;
    objectId: string;
    bytes: number;
  }>;
  totalMatchingEntries: number;
  truncated: boolean;
  boundary: "fixed-head-tracked-files-only";
};

export type LocalRepositoryFileOutput = {
  repository: {
    repositoryHandleId: string;
    commitSha: string;
  };
  relativePath: string;
  objectId: string;
  content: string;
  bytes: number;
  truncated: boolean;
  trust: "untrusted-repository-content";
  boundary: "fixed-head-text-evidence-only";
};

export type GitHubRepositoryTreeOutput = {
  repository: {
    repositoryHandleId: string;
    displayName: string;
    commitSha: string;
  };
  pathPrefix: string;
  entries: Array<{
    relativePath: string;
    objectId: string;
    bytes: number;
  }>;
  totalMatchingEntries: number;
  truncated: boolean;
  boundary: "fixed-commit-github-blobs-only";
};

export type GitHubRepositoryFileOutput = {
  repository: {
    repositoryHandleId: string;
    commitSha: string;
  };
  relativePath: string;
  objectId: string;
  content: string;
  bytes: number;
  truncated: boolean;
  trust: "untrusted-repository-content";
  boundary: "fixed-commit-github-text-evidence-only";
};

export type ProjectRequirementKind =
  | "runtime"
  | "tool"
  | "framework"
  | "library"
  | "package-manager"
  | "operating-system";

export type ProjectRequirement = {
  id: string;
  kind: ProjectRequirementKind;
  name: string;
  constraint: string | null;
  sourcePath: string;
  evidence: string;
  confidence: "explicit" | "inferred";
};

export type ProjectRequirementsOutput = {
  repository: {
    repositoryHandleId: string;
    displayName: string;
    commitSha: string;
  };
  inspectedFiles: Array<{
    relativePath: string;
    objectId: string;
    bytesRead: number;
    truncated: boolean;
  }>;
  requirements: ProjectRequirement[];
  unresolved: string[];
  warnings: string[];
  trust: "untrusted-repository-content";
  boundary: "fixed-head-known-project-files-only";
};

export type ProjectCompatibilityAssessment = {
  repository: ProjectRequirementsOutput["repository"];
  overallCompatibility: "compatible" | "incompatible" | "partial" | "unresolved";
  requirements: ProjectRequirement[];
  observedTools: Array<{
    toolId: DevelopmentEnvironmentToolId;
    status: DevelopmentEnvironmentToolStatus;
    observedVersion: string | null;
    observedDetail: string | null;
  }>;
  assessment: Array<{
    requirementId: string;
    status: "satisfied" | "missing" | "unresolved";
    localEvidenceToolId: DevelopmentEnvironmentToolId | null;
    reason: string;
  }>;
  unresolved: string[];
  proposedNextActions: string[];
  boundary: "read-only-evidence-comparison";
};

export type AgentToolCall =
  | {
      callId: string;
      name: "read_system_profile";
      input: Record<never, never>;
    }
  | {
      callId: string;
      name: "inspect_local_development_environment";
      input: Record<never, never>;
    }
  | {
      callId: string;
      name: "list_local_repository_tree";
      input: {
        repositoryHandleId: string;
        pathPrefix?: string;
        maxEntries?: number;
      };
    }
  | {
      callId: string;
      name: "read_local_repository_file";
      input: {
        repositoryHandleId: string;
        relativePath: string;
      };
    }
  | {
      callId: string;
      name: "inspect_project_requirements";
      input: {
        repositoryHandleId: string;
      };
    }
  | {
      callId: string;
      name: "list_github_repository_tree";
      input: {
        repositoryHandleId: string;
        pathPrefix?: string;
        maxEntries?: number;
      };
    }
  | {
      callId: string;
      name: "read_github_repository_file";
      input: {
        repositoryHandleId: string;
        relativePath: string;
      };
    }
  | {
      callId: string;
      name: "inspect_github_project_requirements";
      input: {
        repositoryHandleId: string;
      };
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
      name: "search_github_repositories";
      input: GitHubRepositorySearchInput;
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
    }
  | {
      callId: string;
      name: "export_workspace";
      input: {
        taskId: string;
        revision: number;
      };
    };

export type AgentAction =
  | {
      actionId: string;
      type: "propose_task_plan";
      proposal: TaskPlanProposal;
      explanation: string;
    }
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
  fileName: string;
  urlHost: string;
  bytesWritten: number;
  sha256: string;
  tempFilePath: string;
  elapsedMs: number;
  resumedFromBytes?: number;
};

export type ControlledDownloadError = {
  code: string;
  message: string;
  retriable: boolean;
};

export type ControlledDownloadResult =
  | { ok: true; output: ControlledDownloadOutput }
  | { ok: false; error: ControlledDownloadError };

export type WorkspaceExportOutput = {
  taskId: string;
  revision: number;
  rootPath: string;
  generatedAt: string;
  reusedExisting: boolean;
  files: WorkspaceFileRecord[];
};

export type WorkspaceExportResult =
  | { ok: true; output: WorkspaceExportOutput }
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
  agentLoop: AgentLoopRunRecord | null;
};

export type AgentLoopRunRecord = {
  runId: string;
  planId: string;
  planRevision: number;
  stepId: string;
  status:
    | "running"
    | "completed"
    | "waiting_user_input"
    | "plan_revision_proposed"
    | "stopped"
    | "aborted"
    | "failed";
  transcript: AgentLoopMessage<AgentToolName, unknown, TaskPlanProposal>[];
  events: AgentLoopEvent<AgentToolName>[];
  usage: AgentLoopUsage | null;
  outcome: AgentLoopResult<AgentToolName, unknown, TaskPlanProposal> | null;
  startedAt: string;
  finishedAt: string | null;
};

export type AgentEvent =
  | { type: "SUBMIT_TASK"; task: string; taskId?: string }
  | { type: "ROUTE_RESOLVED"; decision: RouteDecision }
  | {
      type: "TASK_PLAN_PROPOSED";
      plan: TaskPlan;
      validation: TaskPlanValidationResult;
    }
  | {
      type: "TASK_PLAN_REVISION_PROPOSED";
      plan: TaskPlan;
      validation: TaskPlanValidationResult;
      reason: string;
    }
  | { type: "CONFIRM_TASK_PLAN"; revision: number }
  | {
      type: "TASK_PLAN_CONFIRMED";
      revision: number;
      confirmedAt: string;
    }
  | { type: "TASK_PLAN_STEP_INPUT_REQUESTED"; stepId: string; requestedAt: string }
  | { type: "TASK_PLAN_STEP_STARTED"; stepId: string; startedAt: string }
  | {
      type: "TASK_PLAN_STEP_COMPLETED";
      stepId: string;
      completedAt: string;
      result: TaskPlanStepResult;
      terminalPhase?: Extract<AgentPhase, "result" | "handoff">;
    }
  | {
      type: "TASK_PLAN_STEP_FAILED";
      stepId: string;
      failedAt: string;
      reason: string;
      replanning?: boolean;
    }
  | { type: "TASK_PLAN_STEP_APPROVAL_REQUESTED"; stepId: string; requestedAt: string }
  | {
      type: "TASK_PLAN_STEP_AUTO_APPROVED";
      stepId: string;
      revision: number;
      approvedAt: string;
    }
  | { type: "TASK_REQUIREMENTS_RESOLVED"; requirements: TaskRequirements }
  | { type: "ANSWER_CLARIFICATION"; questionId: string; answer: string; answeredAt?: string }
  | { type: "SKIP_CLARIFICATION"; questionId: string; skippedAt?: string }
  | { type: "PREPARE_GITHUB_REPOSITORY"; fullName: string }
  | { type: "ANALYZE_GITHUB_REPOSITORY"; fullName: string }
  | { type: "PREPARE_NODE_DEPENDENCIES" }
  | { type: "TOGGLE_NODE_DEPENDENCIES"; selected: boolean }
  | { type: "PLAN_GENERATED" }
  | {
      type: "GITHUB_ACQUISITION_PREPARED";
      resources: PlannedResource[];
      explanation: string;
    }
  | { type: "TOGGLE_RESOURCE"; resourceId: string; selected: boolean }
  | { type: "APPROVE_PLAN"; revision: number; approvedAt?: string }
  | { type: "PAUSE_DOWNLOAD"; resourceId: string }
  | { type: "RESUME_DOWNLOAD"; resourceId: string }
  | {
      type: "DOWNLOAD_PROGRESS";
      resourceId: string;
      progress: number;
      bytesWritten?: number;
      totalBytes?: number;
      speedBytesPerSecond?: number;
      etaSeconds?: number;
    }
  | { type: "DOWNLOAD_PAUSED"; resourceId: string }
  | { type: "DOWNLOAD_RESUMED"; resourceId: string }
  | { type: "DOWNLOAD_FAILED"; resourceId: string; reason: string }
  | { type: "DOWNLOAD_APPROVAL_EXPIRED"; reason: string }
  | {
      type: "RESOLVE_DOWNLOAD_FAILURE";
      action: FailureResolutionAction;
      resolvedAt?: string;
    }
  | { type: "REPLAN_GENERATED"; strategy: ReplanStrategy }
  | {
      type: "VERIFY_RESOURCES";
      versionMismatchResourceId?: string;
      failure?: {
        resourceId: string;
        code: string;
        reason: string;
        retriable: boolean;
      };
    }
  | { type: "LOCAL_ARTIFACTS_ADDED"; artifacts: LocalArtifactSummary[] }
  | {
      type: "LOCAL_REPOSITORY_IMPORTED";
      taskId: string;
      repository: LocalRepositorySummary;
    }
  | {
      type: "GITHUB_REPOSITORY_ANALYSIS_ATTACHED";
      taskId: string;
      repository: GitHubRepositoryAnalysisSummary;
    }
  | { type: "GITHUB_PUBLISH_PLAN_PREPARED"; plan: GitHubPublishPlan }
  | {
      type: "GITHUB_PUBLISH_STARTED";
      publishId: string;
      approvedAt: string;
    }
  | { type: "GITHUB_PUBLISH_COMPLETED"; result: GitHubPublishResult }
  | {
      type: "GITHUB_PUBLISH_FAILED";
      publishId: string;
      reason: string;
      partialRepositoryUrl?: string;
    }
  | { type: "WORKSPACE_ROOT_SELECTED"; rootPath: string }
  | {
      type: "MANIFEST_SNAPSHOT_WRITTEN";
      manifestRevision: number;
      rootPath: string;
      status: WorkspaceOverallStatus;
    }
  | { type: "RUN_AGENT_B" }
  | { type: "AGENT_B_STARTED"; runId: string; grantId: string }
  | {
      type: "AGENT_B_COMPLETED";
      runId: string;
      answer: AgentBInspectionAnswer;
    }
  | { type: "AGENT_B_FAILED"; runId: string; reason: string }
  | { type: "WORKSPACE_EXPORT_STARTED" }
  | { type: "WORKSPACE_EXPORT_COMPLETED"; output: WorkspaceExportOutput }
  | { type: "WORKSPACE_EXPORT_FAILED"; reason: string }
  | { type: "RETRY_WORKSPACE_EXPORT" }
  | { type: "TASK_STATE_RESTORED"; state: AgentState; approvalValid: boolean }
  | { type: "MODEL_DECISION_RECORDED"; decision: ModelDecision }
  | { type: "MODEL_POLICY_RECORDED"; actionId: string; decision: PolicyDecision }
  | { type: "MODEL_TOOL_COMPLETED"; result: ToolResult }
  | { type: "MODEL_CLARIFICATION_REQUESTED"; question: ClarificationQuestion }
  | { type: "MODEL_PLAN_PROPOSED"; resourceIds: string[]; explanation: string }
  | { type: "MODEL_REPLAN_PROPOSED"; strategy: ReplanStrategy; explanation: string }
  | { type: "MODEL_FINISHED"; summary: string }
  | { type: "MODEL_STEP_LIMIT_REACHED" }
  | { type: "MODEL_RUNTIME_FAILED"; reason: string }
  | {
      type: "AGENT_LOOP_STARTED";
      runId: string;
      planId: string;
      planRevision: number;
      stepId: string;
      startedAt: string;
    }
  | {
      type: "AGENT_LOOP_EVENT_RECORDED";
      event: AgentLoopEvent<AgentToolName>;
    }
  | {
      type: "AGENT_LOOP_SETTLED";
      stepId: string;
      result: AgentLoopResult<AgentToolName, unknown, TaskPlanProposal>;
      settledAt: string;
    }
  | {
      type: "AGENT_LOOP_INPUT_REQUESTED";
      stepId: string;
      result: Extract<
        AgentLoopResult<AgentToolName, unknown, TaskPlanProposal>,
        { status: "waiting_user_input" }
      >;
      requestedAt: string;
    }
  | {
      type: "AGENT_LOOP_RECOVERY_REJECTED";
      runId: string;
      stepId: string;
      reason: string;
      rejectedAt: string;
    }
  | { type: "CANCEL_TASK"; cancelledAt?: string }
  | { type: "RESET" };

export type AgentUserEvent = Extract<
  AgentEvent,
  {
    type:
      | "SUBMIT_TASK"
      | "CONFIRM_TASK_PLAN"
      | "ANSWER_CLARIFICATION"
      | "SKIP_CLARIFICATION"
      | "PREPARE_GITHUB_REPOSITORY"
      | "ANALYZE_GITHUB_REPOSITORY"
      | "PREPARE_NODE_DEPENDENCIES"
      | "TOGGLE_NODE_DEPENDENCIES"
      | "TOGGLE_RESOURCE"
      | "APPROVE_PLAN"
      | "PAUSE_DOWNLOAD"
      | "RESUME_DOWNLOAD"
      | "RESOLVE_DOWNLOAD_FAILURE"
      | "RUN_AGENT_B"
      | "RETRY_WORKSPACE_EXPORT"
      | "CANCEL_TASK"
      | "RESET";
  }
>;
