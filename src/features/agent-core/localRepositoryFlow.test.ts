import { describe, expect, it } from "vitest";
import { createInitialAgentState, transition } from "./machine";
import { analyzeProjectPaths } from "./projectAnalysis";
import type {
  GitHubPublishPlan,
  LocalRepositorySummary
} from "./types";

function localRepository(): LocalRepositorySummary {
  return {
    repositoryHandleId: "local-repo-test",
    displayName: "example",
    fingerprint: "a".repeat(64),
    commitSha: "b".repeat(40),
    branch: "main",
    detached: false,
    clean: true,
    status: {
      modified: 0,
      deleted: 0,
      untracked: 0,
      conflicted: 0,
      ahead: 0,
      behind: 0
    },
    fileCount: 2,
    trackedFileCount: 2,
    hasSubmodules: false,
    hasSymlinks: false,
    inspectedAt: "2026-07-30T12:00:00.000Z",
    analysis: analyzeProjectPaths(
      ["package.json", "package-lock.json"],
      false
    )
  };
}

function publishPlan(): GitHubPublishPlan {
  return {
    publishId: "github-publish-test",
    repositoryHandleId: "local-repo-test",
    sourceFingerprint: "a".repeat(64),
    sourceCommitSha: "b".repeat(40),
    sourceBranch: "main",
    targetOwner: "owner",
    targetRepository: "example",
    targetVisibility: "private",
    targetBranch: "main",
    commitMessage: "Publish example",
    fileCount: 2,
    totalBytes: 100,
    createRepository: true,
    force: false,
    createdAt: "2026-07-30T12:01:00.000Z",
    expiresAt: "2026-07-30T12:11:00.000Z",
    planSha256: "c".repeat(64)
  };
}

describe("local repository Agent flow", () => {
  it("creates a ready read-only handoff without download approval", () => {
    const imported = transition(createInitialAgentState(), {
      type: "LOCAL_REPOSITORY_IMPORTED",
      taskId: "task-local",
      repository: localRepository()
    });

    expect(imported).toMatchObject({
      taskId: "task-local",
      phase: "handoff",
      revision: 1,
      route: "local-repository-import",
      approvedRevision: null,
      resources: [],
      workspace: {
        ready: true,
        exportStatus: "ready",
        overallStatus: "ready",
        manifestRevision: 0
      }
    });
    expect(imported.localRepository?.displayName).toBe("example");
  });

  it("keeps publish planning, approval and completion as explicit states", () => {
    const imported = transition(createInitialAgentState(), {
      type: "LOCAL_REPOSITORY_IMPORTED",
      taskId: "task-local",
      repository: localRepository()
    });
    const planned = transition(imported, {
      type: "GITHUB_PUBLISH_PLAN_PREPARED",
      plan: publishPlan()
    });
    const started = transition(planned, {
      type: "GITHUB_PUBLISH_STARTED",
      publishId: "github-publish-test",
      approvedAt: "2026-07-30T12:02:00.000Z"
    });
    const completed = transition(started, {
      type: "GITHUB_PUBLISH_COMPLETED",
      result: {
        publishId: "github-publish-test",
        repositoryUrl: "https://github.com/owner/example",
        fullName: "owner/example",
        branch: "main",
        commitSha: "d".repeat(40),
        fileCount: 2,
        publishedAt: "2026-07-30T12:03:00.000Z"
      }
    });

    expect(planned.githubPublish.status).toBe("waiting_approval");
    expect(planned.approvedRevision).toBeNull();
    expect(started.githubPublish).toMatchObject({
      status: "publishing",
      approvedAt: "2026-07-30T12:02:00.000Z"
    });
    expect(completed.githubPublish).toMatchObject({
      status: "published",
      result: { fullName: "owner/example" }
    });
  });

  it("ignores a publish plan for a different repository handle", () => {
    const imported = transition(createInitialAgentState(), {
      type: "LOCAL_REPOSITORY_IMPORTED",
      taskId: "task-local",
      repository: localRepository()
    });
    const mismatched = transition(imported, {
      type: "GITHUB_PUBLISH_PLAN_PREPARED",
      plan: {
        ...publishPlan(),
        repositoryHandleId: "local-repo-other"
      }
    });

    expect(mismatched).toBe(imported);
  });

  it("cannot replace or reset the active task while an approved publish is running", () => {
    const imported = transition(createInitialAgentState(), {
      type: "LOCAL_REPOSITORY_IMPORTED",
      taskId: "task-local",
      repository: localRepository()
    });
    const planned = transition(imported, {
      type: "GITHUB_PUBLISH_PLAN_PREPARED",
      plan: publishPlan()
    });
    const publishing = transition(planned, {
      type: "GITHUB_PUBLISH_STARTED",
      publishId: "github-publish-test",
      approvedAt: "2026-07-30T12:02:00.000Z"
    });

    expect(transition(publishing, { type: "RESET" })).toBe(publishing);
    expect(
      transition(publishing, {
        type: "SUBMIT_TASK",
        task: "replace active publish"
      })
    ).toBe(publishing);
    expect(
      transition(publishing, {
        type: "LOCAL_REPOSITORY_IMPORTED",
        taskId: "other-task",
        repository: {
          ...localRepository(),
          repositoryHandleId: "local-repo-other"
        }
      })
    ).toBe(publishing);
  });
});
