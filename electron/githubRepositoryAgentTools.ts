import type { AgentToolExecutionOptions } from "../src/features/agent-core/interfaces";
import {
  analyzeProjectRequirementFiles,
  isProjectEvidencePath,
  isSafeRepositoryRelativePath,
  projectEvidencePriority
} from "../src/features/agent-core/projectRequirements";
import type {
  GitHubRepositoryFileOutput,
  GitHubRepositoryTreeOutput,
  ProjectRequirementsOutput
} from "../src/features/agent-core/types";
import type { GitHubRepositoryAnalysisInspection } from "./githubClient";

const maxTreeEntries = 500;
const defaultTreeEntries = 200;
const maxReadableBlobBytes = 256 * 1024;
const maxReturnedCharacters = 48 * 1024;
const maxRequirementFiles = 20;
const maxRequirementBytes = 768 * 1024;

export type GitHubRepositorySessionResolver = (
  repositoryHandleId: string
) => GitHubRepositoryAnalysisInspection | null;

function assertActive(options?: AgentToolExecutionOptions) {
  if (
    options?.signal?.aborted ||
    (options?.deadlineAt !== undefined && Date.now() >= options.deadlineAt)
  ) {
    throw new DOMException("GitHub 仓库只读检查已取消或超时。", "AbortError");
  }
}

function inspectionFor(
  resolveSession: GitHubRepositorySessionResolver,
  repositoryHandleId: string
) {
  const inspection = resolveSession(repositoryHandleId);
  if (
    !inspection ||
    inspection.summary.repositoryHandleId !== repositoryHandleId
  ) {
    throw new Error("GitHub 固定仓库会话不可用；请从查询结果重新选择分析。");
  }
  return inspection;
}

function identity(inspection: GitHubRepositoryAnalysisInspection) {
  return {
    repositoryHandleId: inspection.summary.repositoryHandleId,
    displayName: inspection.summary.displayName,
    commitSha: inspection.summary.commitSha
  };
}

function normalizePrefix(value: string | undefined) {
  if (!value) return "";
  const normalized = value.replace(/\\/gu, "/").replace(/\/+$/u, "");
  if (!isSafeRepositoryRelativePath(normalized)) {
    throw new Error("GitHub 仓库目录前缀不是安全的相对路径。");
  }
  return normalized;
}

function decodeText(blob: Buffer, relativePath: string) {
  if (blob.includes(0)) {
    throw new Error(`${relativePath} 不是允许交给 Agent 的文本证据文件。`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(blob);
  } catch {
    throw new Error(`${relativePath} 不是合法 UTF-8 文本。`);
  }
}

export function createGitHubRepositoryAgentTools(
  resolveSession: GitHubRepositorySessionResolver
) {
  return {
    async listTree(
      input: {
        repositoryHandleId: string;
        pathPrefix?: string;
        maxEntries?: number;
      },
      options?: AgentToolExecutionOptions
    ): Promise<GitHubRepositoryTreeOutput> {
      assertActive(options);
      const inspection = inspectionFor(resolveSession, input.repositoryHandleId);
      const pathPrefix = normalizePrefix(input.pathPrefix);
      const limit = Math.min(
        Math.max(input.maxEntries ?? defaultTreeEntries, 1),
        maxTreeEntries
      );
      const matches = inspection.files
        .filter((file) =>
          !pathPrefix ||
          file.relativePath === pathPrefix ||
          file.relativePath.startsWith(`${pathPrefix}/`)
        )
        .sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath)
        );
      return {
        repository: identity(inspection),
        pathPrefix,
        entries: matches.slice(0, limit),
        totalMatchingEntries: matches.length,
        truncated: inspection.summary.treeTruncated || matches.length > limit,
        boundary: "fixed-commit-github-blobs-only"
      };
    },

    async readFile(
      input: { repositoryHandleId: string; relativePath: string },
      options?: AgentToolExecutionOptions
    ): Promise<GitHubRepositoryFileOutput> {
      assertActive(options);
      const inspection = inspectionFor(resolveSession, input.repositoryHandleId);
      const relativePath = input.relativePath.replace(/\\/gu, "/").normalize("NFC");
      if (!isProjectEvidencePath(relativePath)) {
        throw new Error(
          "Agent 只能读取固定 GitHub commit 中经过白名单筛选的项目说明或依赖清单。"
        );
      }
      const file = inspection.files.find(
        (candidate) => candidate.relativePath === relativePath
      );
      if (!file || file.bytes > maxReadableBlobBytes) {
        throw new Error(
          file
            ? `${relativePath} 超过 ${maxReadableBlobBytes} 字节的只读证据上限。`
            : "请求的文件不属于当前固定 GitHub Tree。"
        );
      }
      const blob = await inspection.readBlob(file.objectId, options?.signal);
      assertActive(options);
      const decoded = decodeText(blob, relativePath);
      const content = decoded.slice(0, maxReturnedCharacters);
      return {
        repository: {
          repositoryHandleId: inspection.summary.repositoryHandleId,
          commitSha: inspection.summary.commitSha
        },
        relativePath,
        objectId: file.objectId,
        content,
        bytes: blob.byteLength,
        truncated: content.length < decoded.length,
        trust: "untrusted-repository-content",
        boundary: "fixed-commit-github-text-evidence-only"
      };
    },

    async inspectRequirements(
      input: { repositoryHandleId: string },
      options?: AgentToolExecutionOptions
    ): Promise<ProjectRequirementsOutput> {
      assertActive(options);
      const inspection = inspectionFor(resolveSession, input.repositoryHandleId);
      const candidates = inspection.files
        .filter((file) =>
          isProjectEvidencePath(file.relativePath) &&
          file.relativePath.length <= 300 &&
          file.bytes <= maxReadableBlobBytes
        )
        .sort((left, right) => {
          const priority = projectEvidencePriority(left.relativePath) -
            projectEvidencePriority(right.relativePath);
          return priority || left.relativePath.localeCompare(right.relativePath);
        });
      const selected: typeof candidates = [];
      let selectedBytes = 0;
      for (const candidate of candidates) {
        if (
          selected.length >= maxRequirementFiles ||
          selectedBytes + candidate.bytes > maxRequirementBytes
        ) continue;
        selected.push(candidate);
        selectedBytes += candidate.bytes;
      }
      const files = [];
      for (const file of selected) {
        assertActive(options);
        const blob = await inspection.readBlob(file.objectId, options?.signal);
        const decoded = decodeText(blob, file.relativePath);
        const content = decoded.slice(0, maxReturnedCharacters);
        files.push({
          relativePath: file.relativePath,
          objectId: file.objectId,
          content,
          bytesRead: blob.byteLength,
          truncated: content.length < decoded.length
        });
      }
      const output = analyzeProjectRequirementFiles({
        repository: identity(inspection),
        files
      });
      if (inspection.summary.treeTruncated) {
        output.warnings.push(
          "GitHub recursive Tree 响应被截断；报告只覆盖 API 返回并绑定到当前 treeSha 的文件。"
        );
      }
      if (candidates.length > selected.length) {
        output.warnings.push(
          `另有 ${candidates.length - selected.length} 个候选证据文件因数量或总字节上限未读取。`
        );
      }
      return output;
    }
  };
}
