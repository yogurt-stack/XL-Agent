import { trustedCatalog } from "./catalog";
import type {
  PlanValidationIssue,
  PlanValidationResult,
  PlannedResource,
  ResourceCapability,
  ResourceSourceTrust,
  SystemProfile,
  TaskRequirements,
  TrustedResource
} from "./types";

const defaultAllowedLicenses = [
  "PSF License",
  "Microsoft Software License Terms",
  "GPL-2.0-only",
  "MIT",
  "BSD-3-Clause"
];

const defaultAllowedSourceTrust: ResourceSourceTrust[] = [
  "official",
  "trusted-catalog",
  "trusted-mirror"
];

export type PlanValidationContext = {
  requirements: TaskRequirements;
  systemProfile: SystemProfile;
  revision: number;
  approvalRevision?: number;
  catalog?: readonly TrustedResource[];
  allowedLicenses?: readonly string[];
  allowedSourceTrust?: readonly ResourceSourceTrust[];
};

type CandidateResource = TrustedResource & { selected: boolean };

function issue(
  code: PlanValidationIssue["code"],
  message: string,
  detail: Pick<PlanValidationIssue, "resourceId" | "capability"> = {}
): PlanValidationIssue {
  return { code, message, ...detail };
}

function sameMetadata(resource: TrustedResource, canonical: TrustedResource) {
  const scalarKeys: (keyof TrustedResource)[] = [
    "name",
    "version",
    "source",
    "sizeMb",
    "license",
    "purpose",
    "recommendation",
    "required",
    "sourceTrust",
    "fallbackId"
  ];
  if (scalarKeys.some((key) => resource[key] !== canonical[key])) return false;

  const arrayKeys: (keyof TrustedResource)[] = [
    "dependsOn",
    "provides",
    "requiresCapabilities",
    "supportedOperatingSystems",
    "supportedArchitectures"
  ];
  return arrayKeys.every((key) => JSON.stringify(resource[key]) === JSON.stringify(canonical[key]));
}

function validateCandidates(
  resources: CandidateResource[],
  inputIds: readonly string[],
  context: PlanValidationContext
): PlanValidationResult {
  const catalog = context.catalog ?? trustedCatalog;
  const catalogById = new Map(catalog.map((resource) => [resource.id, resource]));
  const allowedLicenses = new Set(context.allowedLicenses ?? defaultAllowedLicenses);
  const allowedSourceTrust = new Set(context.allowedSourceTrust ?? defaultAllowedSourceTrust);
  const issues: PlanValidationIssue[] = [];
  const seen = new Set<string>();

  if (context.requirements.intent === "ambiguous" || context.requirements.requiredCapabilities.length === 0) {
    issues.push(
      issue(
        "TASK_REQUIREMENTS_UNRESOLVED",
        "任务需求尚未明确，不能生成可审批的资源计划。"
      )
    );
  }

  if (inputIds.length === 0 || resources.every((resource) => !resource.selected)) {
    issues.push(issue("EMPTY_PLAN", "资源计划不能为空，且至少需要选择一项资源。"));
  }

  for (const resourceId of inputIds) {
    if (seen.has(resourceId)) {
      issues.push(issue("DUPLICATE_RESOURCE", `资源 ${resourceId} 在计划中重复出现。`, { resourceId }));
    }
    seen.add(resourceId);
    if (!catalogById.has(resourceId)) {
      issues.push(issue("UNKNOWN_RESOURCE", `资源 ${resourceId} 不属于可信目录。`, { resourceId }));
    }
  }

  const selectedResources = resources.filter((resource) => resource.selected);
  const selectedCapabilities = new Set<ResourceCapability>(
    selectedResources.flatMap((resource) => resource.provides)
  );

  for (const capability of context.requirements.requiredCapabilities) {
    if (!selectedCapabilities.has(capability)) {
      issues.push(
        issue(
          "MISSING_REQUIRED_CAPABILITY",
          `${context.requirements.label}缺少必需能力：${capability}。`,
          { capability }
        )
      );
    }
  }

  for (const resource of resources) {
    const canonical = catalogById.get(resource.id);
    if (canonical && !sameMetadata(resource, canonical)) {
      issues.push(
        issue("RESOURCE_METADATA_MISMATCH", `资源 ${resource.id} 的来源、版本或策略元数据与可信目录不一致。`, {
          resourceId: resource.id
        })
      );
    }

    if (resource.required && !resource.selected) {
      issues.push(
        issue("REQUIRED_RESOURCE_NOT_SELECTED", `必需资源 ${resource.id} 尚未选择。`, {
          resourceId: resource.id
        })
      );
    }

    if (!resource.selected) continue;

    if (
      !resource.supportedOperatingSystems.includes(context.systemProfile.os) ||
      !resource.supportedArchitectures.includes(context.systemProfile.architecture)
    ) {
      issues.push(
        issue(
          "INCOMPATIBLE_SYSTEM",
          `资源 ${resource.id} 不兼容 ${context.systemProfile.os} ${context.systemProfile.architecture}。`,
          { resourceId: resource.id }
        )
      );
    }

    if (!allowedSourceTrust.has(resource.sourceTrust)) {
      issues.push(
        issue("UNTRUSTED_SOURCE", `资源 ${resource.id} 的来源未达到可信策略要求。`, {
          resourceId: resource.id
        })
      );
    }

    if (!allowedLicenses.has(resource.license)) {
      issues.push(
        issue("LICENSE_NOT_ALLOWED", `资源 ${resource.id} 的授权 ${resource.license} 不在允许列表中。`, {
          resourceId: resource.id
        })
      );
    }

    for (const capability of resource.requiresCapabilities) {
      if (!selectedCapabilities.has(capability)) {
        issues.push(
          issue(
            "MISSING_DEPENDENCY_CAPABILITY",
            `资源 ${resource.id} 缺少依赖能力：${capability}。`,
            { resourceId: resource.id, capability }
          )
        );
      }
    }

    if (resource.fallbackId) {
      const fallback = catalogById.get(resource.fallbackId);
      const preservesCapabilities = resource.provides.every((capability) => fallback?.provides.includes(capability));
      const fallbackAllowed = Boolean(
        fallback &&
          allowedSourceTrust.has(fallback.sourceTrust) &&
          allowedLicenses.has(fallback.license) &&
          fallback.supportedOperatingSystems.includes(context.systemProfile.os) &&
          fallback.supportedArchitectures.includes(context.systemProfile.architecture)
      );
      if (!fallback || !preservesCapabilities || !fallbackAllowed) {
        issues.push(
          issue("INVALID_FALLBACK", `资源 ${resource.id} 的备用资源不能提供等价能力。`, {
            resourceId: resource.id
          })
        );
      }
    }
  }

  if (context.approvalRevision !== undefined && context.approvalRevision !== context.revision) {
    issues.push(
      issue(
        "REVISION_MISMATCH",
        `审批 revision r${context.approvalRevision} 与当前计划 r${context.revision} 不一致。`
      )
    );
  }

  return {
    valid: issues.length === 0,
    checkedRevision: context.revision,
    issues
  };
}

/** 校验模型提出的资源 ID，不再静默接受未知或重复资源。 */
export function validatePlanResourceIds(
  resourceIds: readonly string[],
  context: PlanValidationContext
): PlanValidationResult {
  const catalog = context.catalog ?? trustedCatalog;
  const catalogById = new Map(catalog.map((resource) => [resource.id, resource]));
  const resources = resourceIds.flatMap((resourceId) => {
    const resource = catalogById.get(resourceId);
    return resource ? [{ ...resource, selected: true }] : [];
  });
  return validateCandidates(resources, resourceIds, context);
}

/** 校验等待审批的完整计划，包括选择状态和可信目录元数据一致性。 */
export function validatePlannedResources(
  resources: readonly PlannedResource[],
  context: PlanValidationContext
): PlanValidationResult {
  return validateCandidates(
    resources.map((resource) => ({ ...resource })),
    resources.map((resource) => resource.id),
    context
  );
}
