import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { trustedCatalog } from "../src/features/agent-core/catalog";
import type { LocalArtifactSummary } from "../src/features/agent-core/types";

export type LocalArtifactRecord = LocalArtifactSummary & {
  taskId: string;
  planRevision: number;
  sourcePath: string;
};

export type LocalArtifactScanOptions = {
  taskId: string;
  planRevision: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  now?: () => Date;
  createId?: () => string;
};

export class LocalArtifactScanError extends Error {
  constructor(
    readonly code:
      | "LOCAL_RESOURCE_INVALID"
      | "LOCAL_RESOURCE_LIMIT_EXCEEDED"
      | "LOCAL_RESOURCE_READ_FAILED",
    message: string
  ) {
    super(message);
    this.name = "LocalArtifactScanError";
  }
}

async function collectFiles(
  selectedPath: string,
  rootPath: string,
  output: Array<{ sourcePath: string; displayPath: string }>,
  maxFiles: number
) {
  const info = await lstat(selectedPath);
  if (info.isSymbolicLink()) {
    throw new LocalArtifactScanError(
      "LOCAL_RESOURCE_INVALID",
      "本地资源不能包含符号链接。"
    );
  }
  if (info.isFile()) {
    if (output.length >= maxFiles) {
      throw new LocalArtifactScanError(
        "LOCAL_RESOURCE_LIMIT_EXCEEDED",
        `单次最多接入 ${maxFiles} 个本地文件。`
      );
    }
    output.push({
      sourcePath: selectedPath,
      displayPath:
        rootPath === selectedPath
          ? path.basename(selectedPath)
          : path.join(path.basename(rootPath), path.relative(rootPath, selectedPath))
    });
    return;
  }
  if (!info.isDirectory()) {
    throw new LocalArtifactScanError(
      "LOCAL_RESOURCE_INVALID",
      "只支持普通文件和目录。"
    );
  }
  const children = await readdir(selectedPath, { withFileTypes: true });
  for (const child of children) {
    await collectFiles(
      path.join(selectedPath, child.name),
      rootPath,
      output,
      maxFiles
    );
  }
}

async function hashFile(filePath: string) {
  return new Promise<{ sha256: string; bytesWritten: number }>(
    (resolve, reject) => {
      const hash = createHash("sha256");
      let bytesWritten = 0;
      const stream = createReadStream(filePath);
      stream.on("data", (chunk: string | Buffer) => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        bytesWritten += buffer.byteLength;
        hash.update(buffer);
      });
      stream.on("error", reject);
      stream.on("end", () =>
        resolve({ sha256: hash.digest("hex"), bytesWritten })
      );
    }
  );
}

export async function scanLocalArtifacts(
  selectedPaths: string[],
  options: LocalArtifactScanOptions
): Promise<LocalArtifactRecord[]> {
  const maxFiles = options.maxFiles ?? 500;
  const maxTotalBytes = options.maxTotalBytes ?? 4 * 1024 * 1024 * 1024;
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const candidates: Array<{ sourcePath: string; displayPath: string }> = [];

  try {
    for (const selectedPath of selectedPaths) {
      if (!path.isAbsolute(selectedPath)) {
        throw new LocalArtifactScanError(
          "LOCAL_RESOURCE_INVALID",
          "本地资源路径必须是绝对路径。"
        );
      }
      await collectFiles(selectedPath, selectedPath, candidates, maxFiles);
    }
  } catch (error) {
    if (error instanceof LocalArtifactScanError) throw error;
    throw new LocalArtifactScanError(
      "LOCAL_RESOURCE_READ_FAILED",
      error instanceof Error ? error.message : "本地资源扫描失败。"
    );
  }

  const catalogBySha = new Map(
    trustedCatalog.flatMap((resource) =>
      resource.download.expectedSha256
        ? [[resource.download.expectedSha256.toLowerCase(), resource.id] as const]
        : []
    )
  );
  const importedAt = now().toISOString();
  let totalBytes = 0;
  const records: LocalArtifactRecord[] = [];
  for (const candidate of candidates) {
    const actual = await hashFile(candidate.sourcePath);
    totalBytes += actual.bytesWritten;
    if (totalBytes > maxTotalBytes) {
      throw new LocalArtifactScanError(
        "LOCAL_RESOURCE_LIMIT_EXCEEDED",
        "本次接入的本地资源总大小超过 4 GiB 上限。"
      );
    }
    const matchedResourceId =
      catalogBySha.get(actual.sha256.toLowerCase()) ?? null;
    records.push({
      artifactId: `local-${actual.sha256.slice(0, 16)}-${createId()
        .replace(/[^a-z0-9]/gi, "")
        .slice(0, 12)}`,
      taskId: options.taskId,
      planRevision: options.planRevision,
      fileName: path.basename(candidate.sourcePath),
      displayPath: candidate.displayPath,
      sourcePath: candidate.sourcePath,
      bytesWritten: actual.bytesWritten,
      sha256: actual.sha256,
      matchedResourceId,
      verificationStatus: matchedResourceId
        ? "local-verified"
        : "unverified",
      importedAt
    });
  }
  return records;
}
