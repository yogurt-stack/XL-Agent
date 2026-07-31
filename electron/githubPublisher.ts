import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  GitHubPublishPlan,
  GitHubPublishResult
} from "../src/features/agent-core/types";
import {
  inspectLocalRepository,
  readLocalRepositoryBlob,
  type LocalRepositoryInspection
} from "./localRepository";

const githubApiOrigin = "https://api.github.com";
const githubApiVersion = "2022-11-28";
const maxPublishFiles = 2_000;
const maxPublishFileBytes = 5 * 1024 * 1024;
const maxPublishTotalBytes = 50 * 1024 * 1024;

const publishInputSchema = z
  .object({
    repositoryName: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]+$/u),
    visibility: z.enum(["private", "public"]),
    branch: z.string().trim().min(1).max(100).optional(),
    commitMessage: z.string().trim().min(1).max(200).optional()
  })
  .strict();

const userSchema = z
  .object({
    login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/u)
  })
  .passthrough();

const repositorySchema = z
  .object({
    name: z.string(),
    full_name: z.string(),
    html_url: z.string().url(),
    private: z.boolean(),
    owner: z.object({ login: z.string() }).passthrough()
  })
  .passthrough();

const shaSchema = z
  .object({
    sha: z.string().regex(/^[a-f0-9]{40,64}$/iu)
  })
  .passthrough();

export type GitHubPublisherEnvironment = {
  XL_AGENT_GITHUB_PUBLISH_TOKEN?: string;
};

export type GitHubPublishFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type GitHubPublishPreparationResult =
  | { ok: true; plan: GitHubPublishPlan }
  | {
      ok: false;
      error: { code: string; message: string; retriable: boolean };
    };

export type GitHubPublishExecutionResult =
  | { ok: true; output: GitHubPublishResult }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        retriable: boolean;
        partialRepositoryUrl?: string;
      };
    };

function failure(
  code: string,
  message: string,
  retriable: boolean,
  partialRepositoryUrl?: string
): GitHubPublishExecutionResult {
  return {
    ok: false,
    error: {
      code,
      message,
      retriable,
      ...(partialRepositoryUrl ? { partialRepositoryUrl } : {})
    }
  };
}

function preparationFailure(
  code: string,
  message: string,
  retriable: boolean
): GitHubPublishPreparationResult {
  return { ok: false, error: { code, message, retriable } };
}

function safeBranch(value: string) {
  return (
    value.length > 0 &&
    !value.startsWith(".") &&
    !value.startsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !/[\u0000-\u0020~^:?*[\\]/u.test(value)
  );
}

function sensitivePath(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  const name = normalized.split("/").pop() ?? "";
  if (name === ".env.example" || name === ".env.sample") return false;
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".npmrc" ||
    name === ".pypirc" ||
    name === ".git-credentials" ||
    name === "id_rsa" ||
    name === "id_ed25519" ||
    /(?:^|[-_.])(credential|credentials|secret|secrets)(?:[-_.]|$)/u.test(
      name
    ) ||
    /\.(?:pem|key|p12|pfx)$/u.test(name)
  );
}

function isGitHubRepositoryUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password &&
      url.pathname.split("/").filter(Boolean).length === 2
    );
  } catch {
    return false;
  }
}

function planPayload(plan: Omit<GitHubPublishPlan, "planSha256">) {
  return {
    publishId: plan.publishId,
    repositoryHandleId: plan.repositoryHandleId,
    sourceFingerprint: plan.sourceFingerprint,
    sourceCommitSha: plan.sourceCommitSha,
    sourceBranch: plan.sourceBranch,
    targetOwner: plan.targetOwner,
    targetRepository: plan.targetRepository,
    targetVisibility: plan.targetVisibility,
    targetBranch: plan.targetBranch,
    commitMessage: plan.commitMessage,
    fileCount: plan.fileCount,
    totalBytes: plan.totalBytes,
    createRepository: plan.createRepository,
    force: plan.force,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt
  };
}

export function githubPublishPlanSha256(
  plan: Omit<GitHubPublishPlan, "planSha256">
) {
  return createHash("sha256")
    .update(JSON.stringify(planPayload(plan)))
    .digest("hex");
}

function tokenFrom(environment: GitHubPublisherEnvironment) {
  return environment.XL_AGENT_GITHUB_PUBLISH_TOKEN?.trim() || null;
}

async function safeGitHubMessage(response: Response, token: string) {
  try {
    const payload = (await response.json()) as { message?: unknown };
    if (typeof payload.message !== "string") return null;
    return payload.message
      .split(token)
      .join("[redacted]")
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 300);
  } catch {
    return null;
  }
}

export class GitHubPublisher {
  constructor(
    private readonly environment: GitHubPublisherEnvironment = process.env,
    private readonly fetchRequest: GitHubPublishFetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID
  ) {}

  private async request(
    token: string,
    pathname: string,
    init: Omit<RequestInit, "headers"> & { body?: string } = {}
  ) {
    return this.fetchRequest(new URL(pathname, githubApiOrigin), {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": githubApiVersion,
        "user-agent": "xunlei-ai-task-agent"
      },
      signal: AbortSignal.timeout(20_000)
    });
  }

  async prepare(
    inspection: LocalRepositoryInspection,
    input: unknown
  ): Promise<GitHubPublishPreparationResult> {
    const parsed = publishInputSchema.safeParse(input);
    if (!parsed.success || [".", ".."].includes(parsed.data?.repositoryName ?? "")) {
      return preparationFailure(
        "GITHUB_PUBLISH_INPUT_INVALID",
        "GitHub 仓库名、可见性、分支或提交说明不合法。",
        false
      );
    }
    const token = tokenFrom(this.environment);
    if (!token) {
      return preparationFailure(
        "GITHUB_PUBLISH_NOT_CONFIGURED",
        "未配置独立的 XL_AGENT_GITHUB_PUBLISH_TOKEN；只读搜索 Token 不会被用于发布。",
        false
      );
    }
    const repository = inspection.summary;
    if (!repository.clean) {
      return preparationFailure(
        "GITHUB_PUBLISH_DIRTY_REPOSITORY",
        "本地仓库存在未提交修改、删除、未跟踪文件或冲突；首版只发布 clean HEAD。",
        false
      );
    }
    if (repository.hasSubmodules || repository.hasSymlinks) {
      return preparationFailure(
        "GITHUB_PUBLISH_UNSUPPORTED_INDEX",
        "首版发布不接收 Git 子模块或符号链接。",
        false
      );
    }
    const trackedFiles = inspection.trackedFiles;
    const totalBytes = trackedFiles.reduce(
      (total, file) => total + file.bytesWritten,
      0
    );
    const sensitive = trackedFiles.find((file) =>
      sensitivePath(file.relativePath)
    );
    if (
      trackedFiles.length === 0 ||
      trackedFiles.length > maxPublishFiles ||
      totalBytes > maxPublishTotalBytes ||
      trackedFiles.some((file) => file.bytesWritten > maxPublishFileBytes) ||
      sensitive
    ) {
      return preparationFailure(
        "GITHUB_PUBLISH_SCOPE_REJECTED",
        sensitive
          ? `检测到疑似敏感文件 ${sensitive.relativePath}，发布计划已拒绝。`
          : `首版发布要求 1-${maxPublishFiles} 个文件、单文件不超过 5 MiB、总量不超过 50 MiB。`,
        false
      );
    }
    const branch =
      parsed.data.branch ?? repository.branch ?? "main";
    if (!safeBranch(branch)) {
      return preparationFailure(
        "GITHUB_PUBLISH_BRANCH_INVALID",
        "目标分支名不符合 Git ref 安全规则。",
        false
      );
    }

    let userResponse: Response;
    try {
      userResponse = await this.request(token, "/user", { method: "GET" });
    } catch {
      return preparationFailure(
        "GITHUB_PUBLISH_NETWORK_ERROR",
        "无法使用独立发布凭证连接 GitHub API。",
        true
      );
    }
    const userPayload = userResponse.ok
      ? userSchema.safeParse(await userResponse.json().catch(() => null))
      : null;
    if (!userResponse.ok || !userPayload?.success) {
      return preparationFailure(
        userResponse.status === 401 || userResponse.status === 403
          ? "GITHUB_PUBLISH_AUTH_FAILED"
          : "GITHUB_PUBLISH_USER_UNAVAILABLE",
        "独立 GitHub 发布 Token 无效、权限不足或账号信息不可用。",
        false
      );
    }
    const owner = userPayload.data.login;
    let existingResponse: Response;
    try {
      existingResponse = await this.request(
        token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(parsed.data.repositoryName)}`,
        { method: "GET" }
      );
    } catch {
      return preparationFailure(
        "GITHUB_PUBLISH_NETWORK_ERROR",
        "无法确认 GitHub 目标仓库是否已存在。",
        true
      );
    }
    if (existingResponse.status !== 404) {
      return preparationFailure(
        existingResponse.ok
          ? "GITHUB_PUBLISH_TARGET_EXISTS"
          : "GITHUB_PUBLISH_TARGET_CHECK_FAILED",
        existingResponse.ok
          ? "目标 GitHub 仓库已存在；首版不会覆盖、追加或强推已有仓库。"
          : "无法确认目标仓库不存在，因此拒绝创建发布计划。",
        false
      );
    }

    const createdAt = this.now();
    const planWithoutHash: Omit<GitHubPublishPlan, "planSha256"> = {
      publishId: `github-publish-${this.createId().replace(/[^a-z0-9]/giu, "")}`,
      repositoryHandleId: repository.repositoryHandleId,
      sourceFingerprint: repository.fingerprint,
      sourceCommitSha: repository.commitSha,
      sourceBranch: repository.branch,
      targetOwner: owner,
      targetRepository: parsed.data.repositoryName,
      targetVisibility: parsed.data.visibility,
      targetBranch: branch,
      commitMessage:
        parsed.data.commitMessage ??
        `Publish ${repository.displayName}@${repository.commitSha.slice(0, 12)}`,
      fileCount: trackedFiles.length,
      totalBytes,
      createRepository: true,
      force: false,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 10 * 60 * 1000).toISOString()
    };
    return {
      ok: true,
      plan: {
        ...planWithoutHash,
        planSha256: githubPublishPlanSha256(planWithoutHash)
      }
    };
  }

  async execute(
    plan: GitHubPublishPlan,
    originalInspection: LocalRepositoryInspection
  ): Promise<GitHubPublishExecutionResult> {
    const token = tokenFrom(this.environment);
    if (!token) {
      return failure(
        "GITHUB_PUBLISH_NOT_CONFIGURED",
        "独立 GitHub 发布凭证不可用。",
        false
      );
    }
    if (
      githubPublishPlanSha256(plan) !== plan.planSha256 ||
      Date.parse(plan.expiresAt) <= this.now().getTime()
    ) {
      return failure(
        "GITHUB_PUBLISH_APPROVAL_INVALID",
        "GitHub 发布计划已变化或审批窗口已过期，请重新生成计划。",
        false
      );
    }
    const currentInspection = await inspectLocalRepository(
      originalInspection.sourcePath
    ).catch(() => null);
    if (
      !currentInspection ||
      !currentInspection.summary.clean ||
      currentInspection.summary.fingerprint !== plan.sourceFingerprint ||
      currentInspection.summary.commitSha !== plan.sourceCommitSha ||
      currentInspection.summary.repositoryHandleId ===
        plan.repositoryHandleId
    ) {
      return failure(
        "GITHUB_PUBLISH_SOURCE_CHANGED",
        "本地仓库在计划审批后发生变化或已无法重新校验，请重新导入并生成计划。",
        false
      );
    }
    const files: Array<{
      relativePath: string;
      mode: "100644" | "100755";
      content: Buffer;
    }> = [];
    for (const file of currentInspection.trackedFiles) {
      if (sensitivePath(file.relativePath)) {
        return failure(
          "GITHUB_PUBLISH_SCOPE_REJECTED",
          `重新检查时检测到疑似敏感文件 ${file.relativePath}。`,
          false
        );
      }
      if (file.bytesWritten > maxPublishFileBytes) {
        return failure(
          "GITHUB_PUBLISH_SOURCE_CHANGED",
          `文件 ${file.relativePath} 超过已审批的安全大小上限。`,
          false
        );
      }
      const content = await readLocalRepositoryBlob(
        currentInspection,
        file.objectId
      ).catch(() => null);
      if (!content || content.byteLength !== file.bytesWritten) {
        return failure(
          "GITHUB_PUBLISH_SOURCE_CHANGED",
          `无法从固定 HEAD 读取文件 ${file.relativePath}。`,
          false
        );
      }
      files.push({
        relativePath: file.relativePath,
        mode: file.mode,
        content
      });
    }
    if (
      files.length !== plan.fileCount ||
      files.reduce((sum, file) => sum + file.content.byteLength, 0) !==
        plan.totalBytes
    ) {
      return failure(
        "GITHUB_PUBLISH_SOURCE_CHANGED",
        "本地仓库文件范围与已审批计划不一致。",
        false
      );
    }

    let repositoryUrl: string | undefined;
    try {
      const repositoryResponse = await this.request(token, "/user/repos", {
        method: "POST",
        body: JSON.stringify({
          name: plan.targetRepository,
          private: plan.targetVisibility === "private",
          auto_init: false
        })
      });
      const repositoryPayload = repositoryResponse.ok
        ? repositorySchema.safeParse(
            await repositoryResponse.json().catch(() => null)
          )
        : null;
      if (!repositoryResponse.ok || !repositoryPayload?.success) {
        const detail = await safeGitHubMessage(repositoryResponse, token);
        return failure(
          "GITHUB_PUBLISH_CREATE_FAILED",
          detail
            ? `GitHub 仓库创建失败：${detail}`
            : "GitHub 仓库创建失败。",
          repositoryResponse.status >= 500
        );
      }
      if (
        repositoryPayload.data.owner.login.toLowerCase() !==
          plan.targetOwner.toLowerCase() ||
        repositoryPayload.data.name.toLowerCase() !==
          plan.targetRepository.toLowerCase() ||
        repositoryPayload.data.private !==
          (plan.targetVisibility === "private") ||
        !isGitHubRepositoryUrl(repositoryPayload.data.html_url)
      ) {
        return failure(
          "GITHUB_PUBLISH_TARGET_MISMATCH",
          "GitHub 返回的仓库与已审批目标不一致，已停止上传。",
          false,
          repositoryPayload.data.html_url
        );
      }
      repositoryUrl = repositoryPayload.data.html_url;
      const treeEntries: Array<{
        path: string;
        mode: "100644" | "100755";
        type: "blob";
        sha: string;
      }> = [];
      for (const file of files) {
        const blobResponse = await this.request(
          token,
          `/repos/${encodeURIComponent(plan.targetOwner)}/${encodeURIComponent(plan.targetRepository)}/git/blobs`,
          {
            method: "POST",
            body: JSON.stringify({
              content: file.content.toString("base64"),
              encoding: "base64"
            })
          }
        );
        const blob = blobResponse.ok
          ? shaSchema.safeParse(await blobResponse.json().catch(() => null))
          : null;
        if (!blobResponse.ok || !blob?.success) {
          throw new Error(`文件 ${file.relativePath} 的 Git blob 创建失败。`);
        }
        treeEntries.push({
          path: file.relativePath,
          mode: file.mode,
          type: "blob",
          sha: blob.data.sha.toLowerCase()
        });
      }
      const treeResponse = await this.request(
        token,
        `/repos/${encodeURIComponent(plan.targetOwner)}/${encodeURIComponent(plan.targetRepository)}/git/trees`,
        {
          method: "POST",
          body: JSON.stringify({ tree: treeEntries })
        }
      );
      const tree = treeResponse.ok
        ? shaSchema.safeParse(await treeResponse.json().catch(() => null))
        : null;
      if (!treeResponse.ok || !tree?.success) {
        throw new Error("Git tree 创建失败。");
      }
      const commitResponse = await this.request(
        token,
        `/repos/${encodeURIComponent(plan.targetOwner)}/${encodeURIComponent(plan.targetRepository)}/git/commits`,
        {
          method: "POST",
          body: JSON.stringify({
            message: plan.commitMessage,
            tree: tree.data.sha,
            parents: []
          })
        }
      );
      const commit = commitResponse.ok
        ? shaSchema.safeParse(await commitResponse.json().catch(() => null))
        : null;
      if (!commitResponse.ok || !commit?.success) {
        throw new Error("Git commit 创建失败。");
      }
      const refResponse = await this.request(
        token,
        `/repos/${encodeURIComponent(plan.targetOwner)}/${encodeURIComponent(plan.targetRepository)}/git/refs`,
        {
          method: "POST",
          body: JSON.stringify({
            ref: `refs/heads/${plan.targetBranch}`,
            sha: commit.data.sha
          })
        }
      );
      if (!refResponse.ok) {
        throw new Error("Git 分支引用创建失败。");
      }
      return {
        ok: true,
        output: {
          publishId: plan.publishId,
          repositoryUrl,
          fullName: `${plan.targetOwner}/${plan.targetRepository}`,
          branch: plan.targetBranch,
          commitSha: commit.data.sha.toLowerCase(),
          fileCount: files.length,
          publishedAt: this.now().toISOString()
        }
      };
    } catch (error) {
      return failure(
        "GITHUB_PUBLISH_UPLOAD_FAILED",
        `${error instanceof Error ? error.message : "GitHub 文件上传失败。"}${
          repositoryUrl
            ? " 目标仓库已经创建，但未完成发布；系统不会自动删除或重试写入。"
            : ""
        }`,
        false,
        repositoryUrl
      );
    }
  }
}
