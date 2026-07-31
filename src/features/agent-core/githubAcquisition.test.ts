import { describe, expect, it } from "vitest";
import { createInitialAgentState, transition } from "./machine";
import type { PlannedResource } from "./types";

const commitSha = "a".repeat(40);
const digestBase64 = `${"A".repeat(86)}==`;

function sourceResource(): PlannedResource {
  return {
    id: "github-openai-example-aaaaaaaaaaaa",
    name: "openai/example",
    version: "aaaaaaaaaaaa",
    publisher: "openai",
    source: "GitHub Repository API",
    homepage: "https://github.com/openai/example",
    releasePage: "https://github.com/openai/example/releases",
    sizeMb: 1,
    license: "MIT",
    purpose: "固定 commit 的开源项目源码快照。",
    recommendation: "不执行代码。",
    required: true,
    dependsOn: [],
    provides: ["project-source"],
    requiresCapabilities: [],
    supportedOperatingSystems: ["Windows 11"],
    supportedArchitectures: ["x64"],
    sourceTrust: "github-api",
    catalogStatus: "active",
    verification: {
      checksumAlgorithm: "sha256",
      checksumSource: "computed-on-download",
      checksumSourceUrl: `https://github.com/openai/example/commit/${commitSha}`,
      signatureType: "none",
      signatureEnforcement: "not-applicable"
    },
    download: {
      url: `https://codeload.github.com/openai/example/zip/${commitSha}`,
      expectedSha256: null,
      digestPolicy: "record-after-download",
      maxSizeMb: 10,
      allowedHosts: ["codeload.github.com"]
    },
    github: {
      fullName: "openai/example",
      owner: "openai",
      repository: "example",
      defaultBranch: "main",
      commitSha,
      treeSha: "b".repeat(40),
      archiveFormat: "zip",
      inspectedAt: "2026-07-30T00:00:00.000Z",
      analysis: {
        ecosystems: ["node"],
        manifests: ["package.json"],
        lockfiles: ["package-lock.json"],
        runtimeHints: ["Node.js"],
        nodeOfflinePreparation: "package-lock-supported",
        nodeOfflinePackageCount: 1,
        nodeOfflineBlockers: [],
        treeTruncated: false
      }
    },
    selected: true,
    status: "pending",
    progress: 0,
    attempts: 0
  };
}

function npmResource(): PlannedResource {
  const resolvedUrl =
    "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz";
  return {
    id: "npm-left-pad-1234567890abcdef",
    name: "left-pad（npm 离线包）",
    version: "1.3.0",
    publisher: "npm registry / package-lock",
    source: "package-lock.json @ aaaaaaaaaaaa",
    homepage: "https://www.npmjs.com/package/left-pad",
    releasePage: "https://www.npmjs.com/package/left-pad/v/1.3.0",
    sizeMb: 1,
    license: "WTFPL",
    purpose: "Node 开发依赖的离线 tarball。",
    recommendation: "不执行 npm install。",
    required: false,
    dependsOn: [],
    provides: ["offline-node-package"],
    requiresCapabilities: ["project-source"],
    supportedOperatingSystems: ["Windows 11"],
    supportedArchitectures: ["x64"],
    sourceTrust: "npm-lockfile",
    catalogStatus: "active",
    verification: {
      checksumAlgorithm: "sha512",
      checksumSource: "npm-lockfile-integrity",
      checksumSourceUrl:
        `https://github.com/openai/example/blob/${commitSha}/package-lock.json`,
      signatureType: "none",
      signatureEnforcement: "checksum-only"
    },
    download: {
      url: resolvedUrl,
      expectedSha256: null,
      digestPolicy: "lockfile-integrity",
      expectedIntegrity: {
        algorithm: "sha512",
        digestBase64
      },
      maxSizeMb: 100,
      allowedHosts: ["registry.npmjs.org"]
    },
    npm: {
      packageName: "left-pad",
      version: "1.3.0",
      resolvedUrl,
      integrity: `sha512-${digestBase64}`,
      license: "WTFPL",
      dependencyKind: "development",
      lockfilePath: "package-lock.json",
      repositoryFullName: "openai/example",
      repositoryCommitSha: commitSha
    },
    selected: false,
    status: "pending",
    progress: 0,
    attempts: 0
  };
}

describe("GitHub source and npm dependency revisions", () => {
  it("keeps npm packages out of the first approval and enables them only after Agent B", () => {
    const initial = createInitialAgentState();
    const resultState = {
      ...initial,
      taskId: "task-github",
      task: "准备 GitHub 项目",
      phase: "result" as const,
      route: "github-project-discovery",
      routeDecision: {
        status: "supported" as const,
        reason: "matched",
        skillId: "github-project-discovery",
        sourceProviderId: "github-api",
        userLinks: [],
        resourceIds: [],
        clarifications: [],
        requirements: null
      }
    };
    const firstPlan = transition(resultState, {
      type: "GITHUB_ACQUISITION_PREPARED",
      resources: [sourceResource(), npmResource()],
      explanation: "固定提交并识别锁文件。"
    });

    expect(firstPlan).toMatchObject({
      phase: "waiting_approval",
      revision: 1,
      approvedRevision: null
    });
    expect(firstPlan.resources.find((resource) => resource.npm)?.selected).toBe(
      false
    );
    const prematureToggle = transition(firstPlan, {
      type: "TOGGLE_NODE_DEPENDENCIES",
      selected: true
    });
    expect(
      prematureToggle.resources.find((resource) => resource.npm)?.selected
    ).toBe(false);

    const handoff = {
      ...firstPlan,
      phase: "handoff" as const,
      resources: firstPlan.resources.map((resource) =>
        resource.github
          ? { ...resource, status: "verified" as const, progress: 100 }
          : resource
      ),
      workspace: {
        ...firstPlan.workspace,
        ready: true,
        exportStatus: "ready" as const,
        manifestRevision: 1
      },
      agentB: {
        status: "completed" as const,
        runId: "agent-b-1",
        grantId: "grant-1",
        manifestRevision: 1,
        error: null,
        answer: {
          manifestRevision: 1,
          planRevision: 1,
          workspaceStatus: "ready" as const,
          preparedRequiredResources: ["openai/example"],
          missingOrFailedResources: [],
          allowedActions: ["核对"],
          forbiddenActions: ["执行脚本"],
          integrity: "valid" as const,
          projectReadiness: {
            fullName: "openai/example",
            commitSha,
            ecosystems: ["node" as const],
            manifests: ["package.json"],
            lockfiles: ["package-lock.json"],
            runtimeHints: ["Node.js"],
            dependencyPreparation: "package-lock-supported" as const,
            offlinePackageCount: 1,
            offlineBlockers: [],
            selectedOfflinePackages: 0,
            treeTruncated: false
          },
          summary: "源码准备完成。"
        }
      }
    };

    const dependencyPlan = transition(handoff, {
      type: "PREPARE_NODE_DEPENDENCIES"
    });
    expect(dependencyPlan).toMatchObject({
      phase: "waiting_approval",
      revision: 2,
      approvedRevision: null,
      workspace: { ready: false }
    });
    expect(
      dependencyPlan.resources.find((resource) => resource.npm)?.selected
    ).toBe(true);
    expect(
      dependencyPlan.resources.find((resource) => resource.github)?.status
    ).toBe("verified");

    const approved = transition(dependencyPlan, {
      type: "APPROVE_PLAN",
      revision: 2
    });
    expect(approved.phase).toBe("downloading");
    expect(approved.activeResourceId).toBe("npm-left-pad-1234567890abcdef");
    expect(
      approved.resources.find((resource) => resource.github)?.status
    ).toBe("verified");
  });
});
