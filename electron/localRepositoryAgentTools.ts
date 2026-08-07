import type { AgentToolExecutionOptions } from "../src/features/agent-core/interfaces";
import {
  analyzeProjectRequirementFiles,
  isProjectEvidencePath,
  isSafeRepositoryRelativePath,
  projectEvidencePriority
} from "../src/features/agent-core/projectRequirements";
import type {
  LocalRepositoryFileOutput,
  LocalRepositoryTreeOutput,
  ProjectRequirementsOutput
} from "../src/features/agent-core/types";
import {
  LocalRepositoryInspectionError,
  readLocalRepositoryBlob,
  type LocalRepositoryInspection
} from "./localRepository";

const maxTreeEntries = 500;
const defaultTreeEntries = 200;
const maxReadableBlobBytes = 256 * 1024;
const maxReturnedCharacters = 48 * 1024;
const maxRequirementFiles = 20;
const maxRequirementBytes = 768 * 1024;

export type LocalRepositorySessionResolver = (
  repositoryHandleId: string
) => LocalRepositoryInspection | null;

function aborted(options?: AgentToolExecutionOptions) {
  return options?.signal?.aborted ||
    (options?.deadlineAt !== undefined && Date.now() >= options.deadlineAt);
}

function assertActive(options?: AgentToolExecutionOptions) {
  if (aborted(options)) {
    throw new DOMException("本地仓库只读检查已取消或超时。", "AbortError");
  }
}

function inspectionFor(
  resolveSession: LocalRepositorySessionResolver,
  repositoryHandleId: string
) {
  const inspection = resolveSession(repositoryHandleId);
  if (!inspection || inspection.summary.repositoryHandleId !== repositoryHandleId) {
    throw new LocalRepositoryInspectionError(
      "LOCAL_REPOSITORY_READ_FAILED",
      "本地仓库会话不可用；请重新导入仓库后再执行只读分析。"
    );
  }
  return inspection;
}

function identity(inspection: LocalRepositoryInspection) {
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
    throw new LocalRepositoryInspectionError(
      "LOCAL_REPOSITORY_READ_FAILED",
      "仓库目录前缀不是安全的相对路径。"
    );
  }
  return normalized;
}

function decodeText(blob: Buffer, relativePath: string) {
  if (blob.includes(0)) {
    throw new LocalRepositoryInspectionError(
      "LOCAL_REPOSITORY_READ_FAILED",
      `${relativePath} 不是允许交给 Agent 的文本证据文件。`
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(blob);
  } catch {
    throw new LocalRepositoryInspectionError(
      "LOCAL_REPOSITORY_READ_FAILED",
      `${relativePath} 不是合法 UTF-8 文本。`
    );
  }
}

export function createLocalRepositoryAgentTools(
  resolveSession: LocalRepositorySessionResolver
) {
  return {
    async listTree(
      input: {
        repositoryHandleId: string;
        pathPrefix?: string;
        maxEntries?: number;
      },
      options?: AgentToolExecutionOptions
    ): Promise<LocalRepositoryTreeOutput> {
      assertActive(options);
      const inspection = inspectionFor(resolveSession, input.repositoryHandleId);
      const pathPrefix = normalizePrefix(input.pathPrefix);
      const limit = Math.min(
        Math.max(input.maxEntries ?? defaultTreeEntries, 1),
        maxTreeEntries
      );
      const matches = inspection.trackedFiles
        .filter((file) => !pathPrefix ||
          file.relativePath === pathPrefix ||
          file.relativePath.startsWith(`${pathPrefix}/`))
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      assertActive(options);
      return {
        repository: identity(inspection),
        pathPrefix,
        entries: matches.slice(0, limit).map((file) => ({
          relativePath: file.relativePath,
          objectId: file.objectId,
          bytes: file.bytesWritten
        })),
        totalMatchingEntries: matches.length,
        truncated: matches.length > limit,
        boundary: "fixed-head-tracked-files-only"
      };
    },

    async readFile(
      input: { repositoryHandleId: string; relativePath: string },
      options?: AgentToolExecutionOptions
    ): Promise<LocalRepositoryFileOutput> {
      assertActive(options);
      const inspection = inspectionFor(resolveSession, input.repositoryHandleId);
      const relativePath = input.relativePath.replace(/\\/gu, "/").normalize("NFC");
      if (!isProjectEvidencePath(relativePath)) {
        throw new LocalRepositoryInspectionError(
          "LOCAL_REPOSITORY_READ_FAILED",
          "Agent 只能读取固定 HEAD 中经过白名单筛选的项目说明或依赖清单。"
        );
      }
      const file = inspection.trackedFiles.find(
        (candidate) => candidate.relativePath === relativePath
      );
      if (!file || file.bytesWritten > maxReadableBlobBytes) {
        throw new LocalRepositoryInspectionError(
          "LOCAL_REPOSITORY_READ_FAILED",
          file
            ? `${relativePath} 超过 ${maxReadableBlobBytes} 字节的只读证据上限。`
            : "请求的文件不属于当前固定 HEAD。"
        );
      }
      const blob = await readLocalRepositoryBlob(inspection, file.objectId);
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
        boundary: "fixed-head-text-evidence-only"
      };
    },

    async inspectRequirements(
      input: { repositoryHandleId: string },
      options?: AgentToolExecutionOptions
    ): Promise<ProjectRequirementsOutput> {
      assertActive(options);
      const inspection = inspectionFor(resolveSession, input.repositoryHandleId);
      const candidates = inspection.trackedFiles
        .filter((file) =>
          isProjectEvidencePath(file.relativePath) &&
          file.relativePath.length <= 300 &&
          file.bytesWritten <= maxReadableBlobBytes
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
          selectedBytes + candidate.bytesWritten > maxRequirementBytes
        ) continue;
        selected.push(candidate);
        selectedBytes += candidate.bytesWritten;
      }
      const files = [];
      for (const file of selected) {
        assertActive(options);
        const blob = await readLocalRepositoryBlob(inspection, file.objectId);
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
      assertActive(options);
      const output = analyzeProjectRequirementFiles({
        repository: identity(inspection),
        files
      });
      if (candidates.length > selected.length) {
        output.warnings.push(
          `另有 ${candidates.length - selected.length} 个候选证据文件因数量或总字节上限未读取。`
        );
      }
      return output;
    }
  };
}
