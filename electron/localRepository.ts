import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { analyzeProjectPaths } from "../src/features/agent-core/projectAnalysis";
import type { LocalRepositorySummary } from "../src/features/agent-core/types";

const maxGitOutputBytes = 8 * 1024 * 1024;
const maxPublishBlobBytes = 5 * 1024 * 1024 + 1;
const maxRepositoryFiles = 20_000;
const gitTimeoutMs = 10_000;
const fixedGitConfig = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "advice.detachedHead=false"
];

export class LocalRepositoryInspectionError extends Error {
  constructor(
    readonly code:
      | "LOCAL_REPOSITORY_INVALID"
      | "LOCAL_REPOSITORY_GIT_UNAVAILABLE"
      | "LOCAL_REPOSITORY_READ_FAILED"
      | "LOCAL_REPOSITORY_TOO_LARGE",
    message: string
  ) {
    super(message);
  }
}

export type LocalRepositoryInspection = {
  sourcePath: string;
  summary: LocalRepositorySummary;
  trackedFiles: Array<{
    relativePath: string;
    mode: "100644" | "100755";
    objectId: string;
    bytesWritten: number;
  }>;
};

type GitResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function runGit(
  rootPath: string,
  args: string[],
  allowedExitCodes: number[] = [0]
) {
  return new Promise<GitResult>((resolve, reject) => {
    execFile(
      "git",
      [...fixedGitConfig, ...args],
      {
        cwd: rootPath,
        encoding: "utf8",
        maxBuffer: maxGitOutputBytes,
        timeout: gitTimeoutMs,
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1"
        }
      },
      (error, stdout, stderr) => {
        const exitCode =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? (error as NodeJS.ErrnoException & { code: number }).code
            : error
              ? 1
              : 0;
        if (!error || allowedExitCodes.includes(exitCode)) {
          resolve({ stdout, stderr, exitCode });
          return;
        }
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" ||
          /not found|not recognized/iu.test(error.message)
        ) {
          reject(
            new LocalRepositoryInspectionError(
              "LOCAL_REPOSITORY_GIT_UNAVAILABLE",
              "未找到 Git。请先安装 Git，再导入本地仓库。"
            )
          );
          return;
        }
        reject(
          new LocalRepositoryInspectionError(
            "LOCAL_REPOSITORY_READ_FAILED",
            `Git 只读检查失败：${stderr.trim().slice(0, 300) || error.message}`
          )
        );
      }
    );
  });
}

function safeRelativePath(value: string) {
  const normalized = value.replace(/\\/g, "/").normalize("NFC");
  return (
    normalized.length > 0 &&
    Buffer.byteLength(normalized, "utf8") <= 1_024 &&
    !normalized.includes("\uFFFD") &&
    !/[\u0000-\u001f\u007f]/u.test(normalized) &&
    !path.posix.isAbsolute(normalized) &&
    !normalized.split("/").includes("..") &&
    !normalized.split("/").includes(".git")
  );
}

function parseTreeEntries(value: string) {
  const entries = value
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(
        /^([0-9]{6}) (blob|commit) ([a-f0-9]{40,64}) +([0-9]+|-)\t([\s\S]+)$/iu
      );
      if (!match || !safeRelativePath(match[5])) {
        throw new LocalRepositoryInspectionError(
          "LOCAL_REPOSITORY_READ_FAILED",
          "Git 索引包含无法安全处理的路径或模式。"
        );
      }
      return {
        mode: match[1],
        type: match[2],
        objectId: match[3].toLowerCase(),
        bytesWritten: match[4] === "-" ? 0 : Number(match[4]),
        relativePath: match[5].replace(/\\/g, "/")
      };
    });
  if (entries.length > maxRepositoryFiles) {
    throw new LocalRepositoryInspectionError(
      "LOCAL_REPOSITORY_TOO_LARGE",
      `仓库包含 ${entries.length} 个已跟踪文件，超过 ${maxRepositoryFiles} 个文件的安全上限。`
    );
  }
  return entries;
}

export function readLocalRepositoryBlob(
  inspection: LocalRepositoryInspection,
  objectId: string
) {
  if (
    !/^[a-f0-9]{40,64}$/iu.test(objectId) ||
    !inspection.trackedFiles.some((file) => file.objectId === objectId)
  ) {
    return Promise.reject(
      new LocalRepositoryInspectionError(
        "LOCAL_REPOSITORY_READ_FAILED",
        "请求的 Git blob 不属于当前已检查仓库。"
      )
    );
  }
  return new Promise<Buffer>((resolve, reject) => {
    execFile(
      "git",
      [...fixedGitConfig, "cat-file", "blob", objectId],
      {
        cwd: inspection.sourcePath,
        encoding: "buffer",
        maxBuffer: maxPublishBlobBytes,
        timeout: gitTimeoutMs,
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1"
        }
      },
      (error, stdout) => {
        if (error) {
          reject(
            new LocalRepositoryInspectionError(
              "LOCAL_REPOSITORY_READ_FAILED",
              "无法读取固定 HEAD 中的 Git blob。"
            )
          );
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function parseStatus(value: string) {
  let modified = 0;
  let deleted = 0;
  let untracked = 0;
  let conflicted = 0;
  let ahead = 0;
  let behind = 0;
  for (const line of value.split(/\r?\n/u)) {
    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+) -(\d+)/u);
      ahead = match ? Number(match[1]) : 0;
      behind = match ? Number(match[2]) : 0;
      continue;
    }
    if (line.startsWith("? ")) {
      untracked += 1;
      continue;
    }
    if (line.startsWith("u ")) {
      conflicted += 1;
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.slice(2, 4);
      if (xy.includes("D")) deleted += 1;
      else modified += 1;
    }
  }
  return {
    clean: modified + deleted + untracked + conflicted === 0,
    modified,
    deleted,
    untracked,
    conflicted,
    ahead,
    behind
  };
}

function displayName(rootPath: string) {
  return (
    path
      .basename(rootPath)
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/gu, "")
      .trim()
      .slice(0, 120) || "local-repository"
  );
}

/**
 * 使用固定用途、无 shell 的 Git 子命令检查用户明确选择的标准 Git 仓库。
 * 不执行 hooks、不读取任意命令，也不把绝对路径写入返回给 Renderer 的摘要。
 */
export async function inspectLocalRepository(
  selectedPath: string,
  options: { createId?: () => string; now?: () => Date } = {}
): Promise<LocalRepositoryInspection> {
  if (!path.isAbsolute(selectedPath)) {
    throw new LocalRepositoryInspectionError(
      "LOCAL_REPOSITORY_INVALID",
      "本地仓库路径必须是绝对目录。"
    );
  }
  const selectedInfo = await lstat(selectedPath).catch(() => null);
  if (!selectedInfo?.isDirectory() || selectedInfo.isSymbolicLink()) {
    throw new LocalRepositoryInspectionError(
      "LOCAL_REPOSITORY_INVALID",
      "请选择一个真实的本地目录，不能选择符号链接。"
    );
  }
  const gitMetadata = await lstat(path.join(selectedPath, ".git")).catch(
    () => null
  );
  if (!gitMetadata?.isDirectory() || gitMetadata.isSymbolicLink()) {
    throw new LocalRepositoryInspectionError(
      "LOCAL_REPOSITORY_INVALID",
      "当前版本仅接收 .git 为真实目录的标准本地仓库；Git worktree 和子模块工作区暂不接入。"
    );
  }

  const canonicalRoot = await realpath(selectedPath);
  const rootResult = await runGit(canonicalRoot, [
    "rev-parse",
    "--show-toplevel"
  ]);
  const reportedRoot = await realpath(rootResult.stdout.trim()).catch(
    () => ""
  );
  if (reportedRoot !== canonicalRoot) {
    throw new LocalRepositoryInspectionError(
      "LOCAL_REPOSITORY_INVALID",
      "请选择仓库顶层目录，不能从父仓库的子目录导入。"
    );
  }

  const [commit, branchResult, statusResult, filesResult, indexResult] =
    await Promise.all([
      runGit(canonicalRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
      runGit(canonicalRoot, ["symbolic-ref", "--short", "-q", "HEAD"], [0, 1]),
      runGit(canonicalRoot, [
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=normal",
        "--ignore-submodules=none"
      ]),
      runGit(canonicalRoot, [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard"
      ]),
      runGit(canonicalRoot, ["ls-tree", "-rlz", "HEAD"])
    ]);
  const commitSha = commit.stdout.trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(commitSha)) {
    throw new LocalRepositoryInspectionError(
      "LOCAL_REPOSITORY_READ_FAILED",
      "无法把本地仓库 HEAD 固定为合法 commit SHA。"
    );
  }
  const allFiles = filesResult.stdout.split("\0").filter(Boolean);
  if (
    allFiles.length > maxRepositoryFiles ||
    allFiles.some((value) => !safeRelativePath(value))
  ) {
    throw new LocalRepositoryInspectionError(
      "LOCAL_REPOSITORY_TOO_LARGE",
      `仓库文件超过 ${maxRepositoryFiles} 项上限，或包含无法安全处理的路径。`
    );
  }
  const indexEntries = parseTreeEntries(indexResult.stdout);
  const hasSubmodules = indexEntries.some((entry) => entry.mode === "160000");
  const hasSymlinks = indexEntries.some((entry) => entry.mode === "120000");
  const status = parseStatus(statusResult.stdout);
  const branch = branchResult.exitCode === 0
    ? branchResult.stdout.trim().slice(0, 200) || null
    : null;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        commitSha,
        branch,
        status: statusResult.stdout,
        index: indexEntries
      })
    )
    .digest("hex");
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const analysis = analyzeProjectPaths(allFiles, false);

  return {
    sourcePath: canonicalRoot,
    summary: {
      repositoryHandleId: `local-repo-${createId().replace(/[^a-z0-9]/giu, "")}`,
      displayName: displayName(canonicalRoot),
      fingerprint,
      commitSha,
      branch,
      detached: branch === null,
      clean: status.clean,
      status: {
        modified: status.modified,
        deleted: status.deleted,
        untracked: status.untracked,
        conflicted: status.conflicted,
        ahead: status.ahead,
        behind: status.behind
      },
      fileCount: allFiles.length,
      trackedFileCount: indexEntries.length,
      hasSubmodules,
      hasSymlinks,
      inspectedAt: now().toISOString(),
      analysis
    },
    trackedFiles: await Promise.all(
      indexEntries
        .filter((entry) => entry.mode === "100644" || entry.mode === "100755")
        .map(async (entry) => ({
          relativePath: entry.relativePath,
          mode: entry.mode as "100644" | "100755",
          objectId: entry.objectId,
          bytesWritten: entry.bytesWritten
        }))
    )
  };
}
