import { isLocalDevelopmentEnvironmentOutput } from "./developmentEnvironment";
import { isProjectRequirementsOutput } from "./projectRequirements";
import type {
  DevelopmentEnvironmentToolId,
  DevelopmentEnvironmentToolVersion,
  LocalDevelopmentEnvironmentOutput,
  ProjectCompatibilityAssessment,
  ProjectRequirement,
  ProjectRequirementsOutput
} from "./types";

const toolMapping: Record<string, DevelopmentEnvironmentToolId[]> = {
  node: ["node"],
  "node.js": ["node"],
  npm: ["npm"],
  python: ["python3", "python", "py"],
  "python 3": ["python3", "python", "py"],
  pip: ["pip3", "pip"],
  pip3: ["pip3", "pip"],
  git: ["git"],
  cmake: ["cmake"],
  qt: ["qt"],
  qt5: ["qt"],
  qt6: ["qt"],
  occt: ["occt"],
  opencascade: ["occt"],
  "open cascade": ["occt"],
  cuda: ["cuda-compiler"],
  cudatoolkit: ["cuda-compiler"],
  "nvidia gpu": ["nvidia-gpu"]
};

type NumericVersion = [number, number, number];

function numericVersion(value: string | null): NumericVersion | null {
  const match = value?.match(/(?:^|[^0-9])(\d+)(?:\.(\d+))?(?:\.(\d+))?/u);
  return match
    ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
    : null;
}

function compareVersion(left: NumericVersion, right: NumericVersion) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function satisfiesSimpleConstraint(version: string | null, constraint: string | null) {
  if (!constraint) return true;
  const normalized = constraint.trim();
  const match = normalized.match(/^(>=|<=|>|<|==|=)\s*v?(\d+(?:\.\d+){0,2})$/u);
  if (!match) return null;
  const actual = numericVersion(version);
  const expected = numericVersion(match[2]);
  if (!actual || !expected) return null;
  const comparison = compareVersion(actual, expected);
  return ({
    ">=": comparison >= 0,
    "<=": comparison <= 0,
    ">": comparison > 0,
    "<": comparison < 0,
    "==": comparison === 0,
    "=": comparison === 0
  } as const)[match[1] as ">=" | "<=" | ">" | "<" | "==" | "="];
}

function observationsForRequirement(
  requirement: ProjectRequirement,
  tools: DevelopmentEnvironmentToolVersion[]
) {
  const normalizedName = requirement.name.trim().toLowerCase();
  const ids = toolMapping[normalizedName] ??
    (normalizedName.startsWith("qt ") ? ["qt"] : []);
  return tools.filter((tool) => ids.includes(tool.id));
}

function assessRequirement(
  requirement: ProjectRequirement,
  tools: DevelopmentEnvironmentToolVersion[]
): ProjectCompatibilityAssessment["assessment"][number] {
  const observations = observationsForRequirement(requirement, tools);
  if (observations.length === 0) {
    return {
      requirementId: requirement.id,
      status: "unresolved",
      localEvidenceToolId: null,
      reason: "当前固定本机探测工具未覆盖该项目要求。"
    };
  }
  const available = observations.find((tool) => tool.status === "available");
  if (available) {
    const satisfies = satisfiesSimpleConstraint(
      available.version,
      requirement.constraint
    );
    if (satisfies === true) {
      return {
        requirementId: requirement.id,
        status: "satisfied",
        localEvidenceToolId: available.id,
        reason: requirement.constraint
          ? `本机版本 ${available.version} 满足可安全比较的约束 ${requirement.constraint}。`
          : `本机固定探测确认 ${available.name} 可用。`
      };
    }
    if (satisfies === false) {
      return {
        requirementId: requirement.id,
        status: "missing",
        localEvidenceToolId: available.id,
        reason: `本机版本 ${available.version} 不满足约束 ${requirement.constraint}。`
      };
    }
    return {
      requirementId: requirement.id,
      status: "unresolved",
      localEvidenceToolId: available.id,
      reason: `已检测到 ${available.name} ${available.version ?? "未知版本"}，但约束 ${requirement.constraint} 超出当前安全版本比较器范围。`
    };
  }
  const notFound = observations.find((tool) => tool.status === "not_found");
  if (notFound) {
    return {
      requirementId: requirement.id,
      status: "missing",
      localEvidenceToolId: notFound.id,
      reason: `本机固定探测未找到 ${notFound.name} 命令入口。`
    };
  }
  const first = observations[0];
  return {
    requirementId: requirement.id,
    status: "unresolved",
    localEvidenceToolId: first.id,
    reason: first.detail ?? "本机探测无法确认该工具状态。"
  };
}

export function buildProjectCompatibilityAssessment(
  project: ProjectRequirementsOutput,
  environment: LocalDevelopmentEnvironmentOutput
): ProjectCompatibilityAssessment {
  const assessment = project.requirements.map((requirement) =>
    assessRequirement(requirement, environment.tools)
  );
  const missing = assessment.filter((item) => item.status === "missing").length;
  const unresolvedItems = assessment.filter((item) => item.status === "unresolved");
  const overallCompatibility = project.requirements.length === 0 ||
      unresolvedItems.length === project.requirements.length
    ? "unresolved"
    : missing > 0
      ? "incompatible"
      : unresolvedItems.length > 0
        ? "partial"
        : "compatible";
  return {
    repository: project.repository,
    overallCompatibility,
    requirements: project.requirements,
    observedTools: environment.tools.map((tool) => ({
      toolId: tool.id,
      status: tool.status,
      observedVersion: tool.version,
      observedDetail: tool.detail
    })),
    assessment,
    unresolved: [
      ...project.unresolved,
      ...unresolvedItems.map((item) => {
        const requirement = project.requirements.find(
          (candidate) => candidate.id === item.requirementId
        );
        return `${requirement?.name ?? item.requirementId}: ${item.reason}`;
      })
    ].slice(0, 200),
    proposedNextActions: [
      "若要补全缺失项或验证包级依赖，请创建新的 Task Plan revision 并单独审批安装或执行权限。"
    ],
    boundary: "read-only-evidence-comparison"
  };
}

export type ProjectCompatibilityValidation =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function isProjectCompatibilityAssessment(
  value: unknown
): value is ProjectCompatibilityAssessment {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const repository = record.repository;
  const repositoryValid = typeof repository === "object" && repository !== null &&
    typeof (repository as Record<string, unknown>).repositoryHandleId === "string" &&
    typeof (repository as Record<string, unknown>).displayName === "string" &&
    typeof (repository as Record<string, unknown>).commitSha === "string";
  const requirementsValid = Array.isArray(record.requirements) &&
    record.requirements.length <= 200 &&
    record.requirements.every((item) =>
      typeof item === "object" && item !== null &&
      typeof (item as Record<string, unknown>).id === "string" &&
      typeof (item as Record<string, unknown>).name === "string" &&
      (
        (item as Record<string, unknown>).constraint === null ||
        typeof (item as Record<string, unknown>).constraint === "string"
      ) &&
      typeof (item as Record<string, unknown>).sourcePath === "string" &&
      typeof (item as Record<string, unknown>).evidence === "string"
    );
  const assessmentValid = Array.isArray(record.assessment) &&
    record.assessment.length <= 200 &&
    record.assessment.every((item) =>
      typeof item === "object" && item !== null &&
      typeof (item as Record<string, unknown>).requirementId === "string" &&
      ["satisfied", "missing", "unresolved"].includes(
        String((item as Record<string, unknown>).status)
      ) &&
      (
        (item as Record<string, unknown>).localEvidenceToolId === null ||
        typeof (item as Record<string, unknown>).localEvidenceToolId === "string"
      ) &&
      typeof (item as Record<string, unknown>).reason === "string"
    );
  return record.boundary === "read-only-evidence-comparison" &&
    repositoryValid && requirementsValid && assessmentValid &&
    ["compatible", "incompatible", "partial", "unresolved"].includes(
      String(record.overallCompatibility)
    ) &&
    Array.isArray(record.observedTools) &&
    record.observedTools.length <= 100 &&
    Array.isArray(record.unresolved) && record.unresolved.length <= 200 &&
    record.unresolved.every((item) => typeof item === "string") &&
    Array.isArray(record.proposedNextActions) &&
    record.proposedNextActions.length <= 100 &&
    record.proposedNextActions.every((item) => typeof item === "string");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function validateProjectCompatibilityAssessment(
  value: unknown,
  projectObservation: unknown,
  environmentObservation: unknown
): ProjectCompatibilityValidation {
  if (!isProjectRequirementsOutput(projectObservation)) {
    return {
      ok: false,
      code: "PROJECT_REQUIREMENTS_OBSERVATION_INVALID",
      message: "项目兼容性结论没有关联合法的固定仓库要求观测。"
    };
  }
  if (!isLocalDevelopmentEnvironmentOutput(environmentObservation)) {
    return {
      ok: false,
      code: "PROJECT_ENVIRONMENT_OBSERVATION_INVALID",
      message: "项目兼容性结论没有关联合法的本机环境观测。"
    };
  }
  const canonical = buildProjectCompatibilityAssessment(
    projectObservation,
    environmentObservation
  );
  if (canonicalJson(value) !== canonicalJson(canonical)) {
    return {
      ok: false,
      code: "PROJECT_COMPATIBILITY_FACT_MISMATCH",
      message: "项目兼容性输出必须逐字段复述固定仓库要求和本机观测，并使用宿主的保守版本比较结果。"
    };
  }
  return { ok: true };
}

export function canonicalProjectCompatibilitySummary(value: unknown) {
  if (
    typeof value !== "object" || value === null ||
    !("assessment" in value) || !Array.isArray(value.assessment)
  ) {
    return "项目要求与本机环境的只读对比已结束，但结果无法解析。";
  }
  const assessment = value.assessment as Array<{ status?: unknown }>;
  const satisfied = assessment.filter((item) => item.status === "satisfied").length;
  const missing = assessment.filter((item) => item.status === "missing").length;
  const unresolved = assessment.filter((item) => item.status === "unresolved").length;
  return `固定仓库要求对比完成：${satisfied} 项满足，${missing} 项缺失或版本不符，${unresolved} 项仍需确认；未执行安装或仓库代码。`;
}
