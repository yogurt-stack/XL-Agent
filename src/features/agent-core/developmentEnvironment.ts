import type {
  AgentState,
  DevelopmentEnvironmentToolId,
  DevelopmentEnvironmentToolStatus,
  LocalDevelopmentEnvironmentOutput,
  ToolResult
} from "./types";

const toolIds = new Set<DevelopmentEnvironmentToolId>([
  "node",
  "npm",
  "python3",
  "python",
  "py",
  "pip3",
  "pip",
  "git",
  "cmake",
  "qt",
  "occt",
  "cuda-compiler",
  "nvidia-gpu"
]);

const toolStatuses = new Set<DevelopmentEnvironmentToolStatus>([
  "available",
  "not_found",
  "not_applicable",
  "error"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length <= 100 &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.trim().length > 0 &&
        item.length <= 1_000
    );
}

export type LocalEnvironmentCompatibilityAssessment = {
  /** The current inspector does not read framework/project requirements. */
  overallCompatibility: "unresolved";
  observedTools: Array<{
    toolId: DevelopmentEnvironmentToolId;
    status: DevelopmentEnvironmentToolStatus;
    observedVersion: string | null;
    observedDetail: string | null;
  }>;
  unresolved: string[];
  conflicts?: string[];
  proposedNextActions?: string[];
};

const compatibilityAssessmentKeys = new Set([
  "overallCompatibility",
  "observedTools",
  "unresolved",
  "conflicts",
  "proposedNextActions"
]);

function isObservedToolClaim(
  value: unknown
): value is LocalEnvironmentCompatibilityAssessment["observedTools"][number] {
  if (!isRecord(value)) return false;
  if (
    Object.keys(value).some((key) =>
      !["toolId", "status", "observedVersion", "observedDetail"].includes(key)
    )
  ) return false;
  return (
    toolIds.has(value.toolId as DevelopmentEnvironmentToolId) &&
    toolStatuses.has(value.status as DevelopmentEnvironmentToolStatus) &&
    (value.observedVersion === null ||
      typeof value.observedVersion === "string") &&
    (value.observedDetail === null || typeof value.observedDetail === "string")
  );
}

export type CompatibilityAssessmentValidation =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function canonicalLocalEnvironmentCompatibilitySummary(
  assessment: unknown
) {
  if (!isRecord(assessment) || !Array.isArray(assessment.observedTools)) {
    return "本机环境探测已结束，但目标环境兼容性仍无法确认。";
  }
  const claims = assessment.observedTools.filter(isObservedToolClaim);
  const available = claims.filter((claim) => claim.status === "available").length;
  const missing = claims.filter((claim) => claim.status === "not_found").length;
  const unresolved = claims.filter(
    (claim) => claim.status === "not_applicable" || claim.status === "error"
  ).length;
  return (
    `本机固定环境探测完成：${available} 项可用，${missing} 项未找到，` +
    `${unresolved} 项不适用或探测失败；尚未读取目标框架或项目的版本要求，` +
    "因此整体兼容性仍无法确认。"
  );
}

/**
 * Validates the factual part of a compatibility report against the fixed
 * command observation. Target-package compatibility remains unresolved until
 * a later tool can inspect packages/project requirements.
 */
export function validateLocalEnvironmentCompatibilityAssessment(
  assessment: unknown,
  observation: unknown
): CompatibilityAssessmentValidation {
  if (!isLocalDevelopmentEnvironmentOutput(observation)) {
    return {
      ok: false,
      code: "ENVIRONMENT_OBSERVATION_INVALID",
      message: "兼容性结论没有关联合法的本机环境探测结果。"
    };
  }
  if (
    !isRecord(assessment) ||
    Object.keys(assessment).some((key) => !compatibilityAssessmentKeys.has(key)) ||
    assessment.overallCompatibility !== "unresolved" ||
    !Array.isArray(assessment.observedTools) ||
    assessment.observedTools.length > 100 ||
    !assessment.observedTools.every(isObservedToolClaim) ||
    !isBoundedStringArray(assessment.unresolved) ||
    assessment.unresolved.length === 0 ||
    (
      assessment.conflicts !== undefined &&
      !isBoundedStringArray(assessment.conflicts)
    ) ||
    (
      assessment.proposedNextActions !== undefined &&
      !isBoundedStringArray(assessment.proposedNextActions)
    )
  ) {
    return {
      ok: false,
      code: "COMPATIBILITY_OUTPUT_SCHEMA_INVALID",
      message:
        "兼容性输出必须包含 overallCompatibility=unresolved、逐工具 observedTools 和非空 unresolved。"
    };
  }

  const validatedAssessment = assessment as LocalEnvironmentCompatibilityAssessment;
  const observedTools = validatedAssessment.observedTools;
  const conflicts = validatedAssessment.conflicts ?? [];
  const duplicateToolId = observedTools.find(
    (claim, index) =>
      observedTools.findIndex((candidate) => candidate.toolId === claim.toolId) !==
      index
  );
  if (duplicateToolId) {
    return {
      ok: false,
      code: "OBSERVED_TOOL_DUPLICATE",
      message: `工具 ${duplicateToolId.toolId} 只能在 observedTools 中出现一次。`
    };
  }
  for (const claim of observedTools) {
    const observed = observation.tools.find((tool) => tool.id === claim.toolId);
    if (!observed) {
      return {
        ok: false,
        code: "OBSERVED_TOOL_UNKNOWN",
        message: `工具 ${claim.toolId} 不在本轮本机探测结果中。`
      };
    }
    if (
      claim.status !== observed.status ||
      claim.observedVersion !== observed.version ||
      claim.observedDetail !== observed.detail
    ) {
      return {
        ok: false,
        code: "OBSERVED_TOOL_FACT_MISMATCH",
        message: `工具 ${claim.toolId} 的状态、版本或详情与本轮原始观测不一致。`
      };
    }
  }
  const omittedObservation = observation.tools.find(
    (tool) => !observedTools.some((claim) => claim.toolId === tool.id)
  );
  if (omittedObservation) {
    return {
      ok: false,
      code: "TOOL_OBSERVATION_OMITTED",
      message: `兼容性输出遗漏了工具 ${omittedObservation.id} 的原始观测。`
    };
  }
  if (conflicts.length > 0) {
    return {
      ok: false,
      code: "CONFLICT_REQUIRES_REQUIREMENT_EVIDENCE",
      message: "当前工具尚未读取目标项目或框架要求，不能断言存在版本冲突。"
    };
  }
  return { ok: true };
}

export function isLocalDevelopmentEnvironmentOutput(
  value: unknown
): value is LocalDevelopmentEnvironmentOutput {
  if (
    !isRecord(value) ||
    !isRecord(value.host) ||
    !Array.isArray(value.tools) ||
    typeof value.collectedAt !== "string" ||
    (value.source !== "electron-main-fixed-command-allowlist" &&
      value.source !== "in-memory-fallback") ||
    value.boundary !== "read-only-fixed-command-allowlist"
  ) {
    return false;
  }
  if (
    !["darwin", "linux", "win32", "unknown"].includes(
      String(value.host.platform)
    ) ||
    !["x64", "arm64", "other"].includes(String(value.host.architecture))
  ) {
    return false;
  }
  return value.tools.every(
    (tool) =>
      isRecord(tool) &&
      toolIds.has(tool.id as DevelopmentEnvironmentToolId) &&
      typeof tool.name === "string" &&
      typeof tool.command === "string" &&
      toolStatuses.has(tool.status as DevelopmentEnvironmentToolStatus) &&
      (tool.version === null || typeof tool.version === "string") &&
      (tool.detail === null || typeof tool.detail === "string")
  );
}

export function latestLocalDevelopmentEnvironmentResult(
  state: AgentState
): ToolResult | null {
  const recorded = [...state.agentRun.toolResults]
    .reverse()
    .find(
      (result) => result.tool === "inspect_local_development_environment"
    ) ?? null;
  if (recorded) return recorded;

  const step = [...(state.taskPlan?.steps ?? [])]
    .reverse()
    .find(
      (candidate) =>
        candidate.tool === "inspect_local_development_environment" &&
        (candidate.result !== null || candidate.error !== null)
    );
  if (!step) return null;

  const startedAt = step.startedAt ?? state.taskPlan?.createdAt ?? "unknown";
  const finishedAt = step.completedAt ?? state.taskPlan?.updatedAt ?? startedAt;
  if (
    step.status === "completed" &&
    isLocalDevelopmentEnvironmentOutput(step.result?.output)
  ) {
    return {
      callId: `task-plan-r${state.taskPlan?.revision ?? state.revision}-${step.id}`,
      tool: "inspect_local_development_environment",
      status: "success",
      output: step.result.output,
      startedAt,
      finishedAt
    };
  }
  if (step.error) {
    return {
      callId: `task-plan-r${state.taskPlan?.revision ?? state.revision}-${step.id}`,
      tool: "inspect_local_development_environment",
      status: "error",
      error: {
        code: "TASK_PLAN_STEP_FAILED",
        message: step.error,
        retriable: true
      },
      startedAt,
      finishedAt
    };
  }
  return null;
}
