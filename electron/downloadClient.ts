import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ControlledDownloadRequest = {
  resourceId: string;
  url: string;
  expectedSha256: string;
  maxSizeMb: number;
  allowedHosts: string[];
};

export type ControlledDownloadOutput = {
  resourceId: string;
  fileName: string;
  urlHost: string;
  bytesWritten: number;
  sha256: string;
  tempFilePath: string;
  elapsedMs: number;
};

export type ControlledDownloadErrorCode =
  | "URL_NOT_ALLOWED"
  | "DOWNLOAD_HTTP_ERROR"
  | "DOWNLOAD_SIZE_LIMIT_EXCEEDED"
  | "DOWNLOAD_WRITE_FAILED"
  | "DOWNLOAD_NETWORK_ERROR"
  | "CHECKSUM_METADATA_INVALID"
  | "CHECKSUM_MISMATCH"
  | "DOWNLOAD_CANCELLED";

export type ControlledDownloadError = {
  code: ControlledDownloadErrorCode;
  message: string;
  retriable: boolean;
};

export type DownloadFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ControlledDownloadOptions = {
  fetchRequest?: DownloadFetch;
  tempRoot?: string;
  now?: () => number;
  createId?: () => string;
  signal?: AbortSignal;
  waitIfPaused?: () => Promise<void>;
  onProgress?: (
    progress: ControlledDownloadProgress
  ) => Promise<void> | void;
};

export type ControlledDownloadProgress = {
  resourceId: string;
  bytesWritten: number;
  totalBytes: number | null;
  progress: number;
  speedBytesPerSecond: number;
  etaSeconds: number | null;
};

export class ControlledDownloadRequestError extends Error {
  constructor(readonly detail: ControlledDownloadError) {
    super(detail.message);
    this.name = "ControlledDownloadRequestError";
  }
}

function downloadError(
  code: ControlledDownloadErrorCode,
  message: string,
  retriable: boolean
) {
  return new ControlledDownloadRequestError({ code, message, retriable });
}

async function writeAll(
  file: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array
) {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await file.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null
    );
    if (result.bytesWritten <= 0) {
      throw downloadError(
        "DOWNLOAD_WRITE_FAILED",
        "下载文件写入临时目录失败。",
        true
      );
    }
    offset += result.bytesWritten;
  }
}

export function toControlledDownloadError(error: unknown): ControlledDownloadError {
  if (error instanceof ControlledDownloadRequestError) return error.detail;
  if (error instanceof TypeError) {
    return {
      code: "DOWNLOAD_NETWORK_ERROR",
      message: "下载请求失败，请检查网络连接。",
      retriable: true
    };
  }
  return {
    code: "DOWNLOAD_NETWORK_ERROR",
    message: error instanceof Error ? error.message : "未知下载错误。",
    retriable: true
  };
}

function parseTrustedUrl(url: string, allowedHosts: string[]) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw downloadError("URL_NOT_ALLOWED", "下载 URL 不是合法地址。", false);
  }

  if (parsed.protocol !== "https:" || !allowedHosts.includes(parsed.host)) {
    throw downloadError("URL_NOT_ALLOWED", "下载 URL 不在可信目录允许的 HTTPS 主机内。", false);
  }
  return parsed;
}

function maxBytesFromMb(maxSizeMb: number) {
  if (!Number.isFinite(maxSizeMb) || maxSizeMb <= 0) {
    throw downloadError("DOWNLOAD_SIZE_LIMIT_EXCEEDED", "下载大小上限必须是正数。", false);
  }
  return Math.floor(maxSizeMb * 1024 * 1024);
}

function sanitizeResourceId(resourceId: string) {
  const safe = resourceId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
  return safe || "resource";
}

function sanitizeFileName(value: string, resourceId: string) {
  const baseName = path.basename(value)
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 160);
  return baseName || `${sanitizeResourceId(resourceId)}.download`;
}

function responseFileName(
  response: Response,
  parsedUrl: URL,
  resourceId: string
) {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encodedMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  const candidate =
    encodedMatch?.[1] ??
    plainMatch?.[1] ??
    path.basename(parsedUrl.pathname) ??
    "";
  let decoded = candidate;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    decoded = candidate;
  }
  return sanitizeFileName(decoded, resourceId);
}

function normalizeExpectedSha256(expectedSha256: string) {
  const normalized = expectedSha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw downloadError(
      "CHECKSUM_METADATA_INVALID",
      "可信目录中的 SHA256 不是合法的 64 位十六进制值。",
      false
    );
  }
  return normalized;
}

/**
 * 受控真实下载客户端的最小边界。
 *
 * 当前负责主进程侧的 URL/Host/Size/SHA256/临时文件写入控制；安装执行会在后续阶段接入。
 */
export async function downloadTrustedResource(
  request: ControlledDownloadRequest,
  options: ControlledDownloadOptions = {}
): Promise<ControlledDownloadOutput> {
  const startedAt = options.now?.() ?? Date.now();
  const parsedUrl = parseTrustedUrl(request.url, request.allowedHosts);
  const expectedSha256 = normalizeExpectedSha256(request.expectedSha256);
  const maxBytes = maxBytesFromMb(request.maxSizeMb);
  const fetchRequest = options.fetchRequest ?? fetch;
  const tempRoot = options.tempRoot ?? path.join(os.tmpdir(), "xunlei-ai-task-agent-downloads");
  const createId = options.createId ?? randomUUID;

  let response: Response;
  try {
    response = await fetchRequest(parsedUrl.toString(), {
      signal: options.signal
    });
  } catch (error) {
    if (error instanceof ControlledDownloadRequestError) throw error;
    if (options.signal?.aborted) {
      throw downloadError("DOWNLOAD_CANCELLED", "下载任务已取消。", false);
    }
    throw downloadError(
      "DOWNLOAD_NETWORK_ERROR",
      error instanceof Error ? error.message : "下载请求失败，请检查网络连接。",
      true
    );
  }

  if (response.url) {
    parseTrustedUrl(response.url, request.allowedHosts);
  }

  if (!response.ok) {
    throw downloadError(
      "DOWNLOAD_HTTP_ERROR",
      `下载请求失败：HTTP ${response.status}。`,
      response.status >= 500 || response.status === 429
    );
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw downloadError("DOWNLOAD_SIZE_LIMIT_EXCEEDED", "下载文件超过可信目录声明的大小上限。", false);
    }
  }

  const fileName = responseFileName(response, parsedUrl, request.resourceId);
  const artifactRoot = path.join(
    tempRoot,
    `${sanitizeResourceId(request.resourceId)}-${createId()}`
  );
  const tempFilePath = path.join(artifactRoot, fileName);
  const declaredBytes = contentLength ? Number(contentLength) : Number.NaN;
  const totalBytes =
    Number.isFinite(declaredBytes) && declaredBytes >= 0
      ? declaredBytes
      : null;
  const hash = createHash("sha256");
  let bytesWritten = 0;
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    await mkdir(artifactRoot, { recursive: true });
    file = await open(tempFilePath, "wx");
    const reader = response.body?.getReader();
    if (!reader) {
      throw downloadError(
        "DOWNLOAD_NETWORK_ERROR",
        "下载响应没有可读取的数据流。",
        true
      );
    }

    while (true) {
      if (options.signal?.aborted) {
        throw downloadError("DOWNLOAD_CANCELLED", "下载任务已取消。", false);
      }
      await options.waitIfPaused?.();
      if (options.signal?.aborted) {
        throw downloadError("DOWNLOAD_CANCELLED", "下载任务已取消。", false);
      }
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value?.byteLength) continue;
      if (bytesWritten + chunk.value.byteLength > maxBytes) {
        throw downloadError(
          "DOWNLOAD_SIZE_LIMIT_EXCEEDED",
          "下载文件超过可信目录声明的大小上限。",
          false
        );
      }
      await writeAll(file, chunk.value);
      hash.update(chunk.value);
      bytesWritten += chunk.value.byteLength;
      const elapsedSeconds = Math.max(
        0.001,
        ((options.now?.() ?? Date.now()) - startedAt) / 1000
      );
      const speedBytesPerSecond = Math.round(bytesWritten / elapsedSeconds);
      const progress =
        totalBytes && totalBytes > 0
          ? Math.min(99, Math.floor((bytesWritten / totalBytes) * 100))
          : Math.min(99, Math.floor((bytesWritten / maxBytes) * 100));
      const remaining =
        totalBytes === null ? null : Math.max(0, totalBytes - bytesWritten);
      await options.onProgress?.({
        resourceId: request.resourceId,
        bytesWritten,
        totalBytes,
        progress,
        speedBytesPerSecond,
        etaSeconds:
          remaining === null || speedBytesPerSecond <= 0
            ? null
            : Math.ceil(remaining / speedBytesPerSecond)
      });
    }
    await file.close();
    file = null;
  } catch (error) {
    await file?.close().catch(() => undefined);
    await rm(artifactRoot, { force: true, recursive: true });
    if (error instanceof ControlledDownloadRequestError) throw error;
    if (options.signal?.aborted) {
      throw downloadError("DOWNLOAD_CANCELLED", "下载任务已取消。", false);
    }
    const nodeError = error as NodeJS.ErrnoException;
    if (
      nodeError.code === "EACCES" ||
      nodeError.code === "ENOSPC" ||
      nodeError.code === "EROFS"
    ) {
      throw downloadError(
        "DOWNLOAD_WRITE_FAILED",
        "下载文件写入临时目录失败。",
        true
      );
    }
    throw downloadError(
      "DOWNLOAD_NETWORK_ERROR",
      error instanceof Error ? error.message : "下载响应读取失败。",
      true
    );
  }

  const actualSha256 = hash.digest("hex");
  if (actualSha256 !== expectedSha256) {
    await rm(artifactRoot, { force: true, recursive: true });
    throw downloadError(
      "CHECKSUM_MISMATCH",
      "下载文件 SHA256 与可信目录不一致。",
      true
    );
  }

  return {
    resourceId: request.resourceId,
    fileName,
    urlHost: parsedUrl.host,
    bytesWritten,
    sha256: actualSha256,
    tempFilePath,
    elapsedMs: Math.max(0, (options.now?.() ?? Date.now()) - startedAt)
  };
}
