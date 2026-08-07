import type {
  PlanValidationIssue,
  PlanValidationResult,
  PlannedResource,
  TaskRequirements
} from "./types";

export const githubAcquisitionRequirements: TaskRequirements = {
  intent: "skill:github-project-discovery",
  label: "GitHub 固定提交源码快照",
  requiredCapabilities: ["project-source"]
};

function issue(
  code: PlanValidationIssue["code"],
  message: string,
  resourceId?: string
): PlanValidationIssue {
  return { code, message, ...(resourceId ? { resourceId } : {}) };
}

export function validateGitHubAcquisitionPlan(
  resources: readonly PlannedResource[],
  revision: number,
  approvalRevision?: number
): PlanValidationResult {
  const issues: PlanValidationIssue[] = [];
  if (approvalRevision !== undefined && approvalRevision !== revision) {
    issues.push(
      issue(
        "REVISION_MISMATCH",
        `审批 revision r${approvalRevision} 与当前计划 r${revision} 不一致。`
      )
    );
  }
  const sourceResources = resources.filter((resource) => resource.github);
  if (sourceResources.length !== 1 || !sourceResources[0]?.selected) {
    issues.push(
      issue("EMPTY_PLAN", "GitHub 计划必须且只能包含一个已选择的源码仓库。")
    );
  }
  const source = sourceResources[0];
  for (const resource of resources) {
    if (resource.npm) {
      const integrity = resource.download.expectedIntegrity;
      let resolved: URL | null = null;
      try {
        resolved = new URL(resource.download.url);
      } catch {
        resolved = null;
      }
      if (
        !source?.github ||
        resource.required ||
        resource.sourceTrust !== "npm-lockfile" ||
        resource.catalogStatus !== "active" ||
        !resource.provides.includes("offline-node-package") ||
        !resource.requiresCapabilities.includes("project-source") ||
        resource.npm.repositoryFullName !== source.github.fullName ||
        resource.npm.repositoryCommitSha !== source.github.commitSha ||
        resource.npm.resolvedUrl !== resource.download.url ||
        resource.npm.integrity !==
          `sha512-${integrity?.digestBase64 ?? ""}` ||
        resource.download.expectedSha256 !== null ||
        resource.download.digestPolicy !== "lockfile-integrity" ||
        integrity?.algorithm !== "sha512" ||
        !/^[A-Za-z0-9+/]{86}==$/.test(integrity.digestBase64) ||
        resource.download.allowedHosts.length !== 1 ||
        resource.download.allowedHosts[0] !== "registry.npmjs.org" ||
        resolved?.protocol !== "https:" ||
        resolved.hostname !== "registry.npmjs.org" ||
        resource.verification.checksumAlgorithm !== "sha512" ||
        resource.verification.checksumSource !== "npm-lockfile-integrity"
      ) {
        issues.push(
          issue(
            "RESOURCE_METADATA_MISMATCH",
            `npm 资源 ${resource.id} 未被当前固定 commit 的锁文件和 SHA512 完整约束。`,
            resource.id
          )
        );
      }
      if (
        !resource.license ||
        ["UNLICENSED", "UNKNOWN", "NOASSERTION"].includes(
          resource.license.toUpperCase()
        )
      ) {
        issues.push(
          issue(
            "LICENSE_NOT_ALLOWED",
            `npm 资源 ${resource.id} 没有明确许可证元数据。`,
            resource.id
          )
        );
      }
      continue;
    }
    const github = resource.github;
    const expectedUrl = github
      ? `https://codeload.github.com/${github.owner}/${github.repository}/zip/${github.commitSha}`
      : "";
    if (
      !github ||
      resource.sourceTrust !== "github-api" ||
      resource.catalogStatus !== "active" ||
      !resource.provides.includes("project-source") ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(github.commitSha) ||
      github.fullName !== `${github.owner}/${github.repository}` ||
      resource.download.url !== expectedUrl ||
      resource.download.expectedSha256 !== null ||
      resource.download.digestPolicy !== "record-after-download" ||
      resource.download.allowedHosts.length !== 1 ||
      resource.download.allowedHosts[0] !== "codeload.github.com" ||
      resource.verification.checksumSource !== "computed-on-download"
    ) {
      issues.push(
        issue(
          "RESOURCE_METADATA_MISMATCH",
          `GitHub 资源 ${resource.id} 的固定提交、下载地址或摘要策略不合法。`,
          resource.id
        )
      );
    }
    if (
      !resource.license ||
      resource.license.toUpperCase() === "NOASSERTION"
    ) {
      issues.push(
        issue(
          "LICENSE_NOT_ALLOWED",
          `GitHub 资源 ${resource.id} 没有明确的 SPDX 许可证。`,
          resource.id
        )
      );
    }
  }
  return {
    valid: issues.length === 0,
    checkedRevision: revision,
    issues
  };
}
