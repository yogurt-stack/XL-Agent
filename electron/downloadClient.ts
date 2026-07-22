import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
  urlHost: string;
  bytesWritten: number;
  tempFilePath: string;
  elapsedMs: number;
};

export type ControlledDownloadErrorCode =
  | "URL_NOT_ALLOWED"
  | "DOWNLOAD_HTTP_ERROR"
  | "DOWNLOAD_SIZE_LIMIT_EXCEEDED"
  | "DOWNLOAD_WRITE_FAILED"
  | "DOWNLOAD_NETWORK_ERROR";

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

/**
 * 受控真实下载客户端的最小边界。
 *
 * 当前只负责主进程侧的 URL/Host/Size/临时文件写入控制；SHA256 校验和安装执行会在后续阶段接入。
 */
export async function downloadTrustedResource(
  request: ControlledDownloadRequest,
  options: ControlledDownloadOptions = {}
): Promise<ControlledDownloadOutput> {
  const startedAt = options.now?.() ?? Date.now();
  const parsedUrl = parseTrustedUrl(request.url, request.allowedHosts);
  const maxBytes = maxBytesFromMb(request.maxSizeMb);
  const fetchRequest = options.fetchRequest ?? fetch;
  const tempRoot = options.tempRoot ?? path.join(os.tmpdir(), "xunlei-ai-task-agent-downloads");
  const createId = options.createId ?? randomUUID;

  let response: Response;
  try {
    response = await fetchRequest(parsedUrl.toString());
  } catch (error) {
    if (error instanceof ControlledDownloadRequestError) throw error;
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

  let buffer: Buffer;
  try {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw downloadError("DOWNLOAD_SIZE_LIMIT_EXCEEDED", "下载文件超过可信目录声明的大小上限。", false);
    }
    buffer = Buffer.from(arrayBuffer);
  } catch (error) {
    if (error instanceof ControlledDownloadRequestError) throw error;
    throw downloadError(
      "DOWNLOAD_NETWORK_ERROR",
      error instanceof Error ? error.message : "下载响应读取失败。",
      true
    );
  }

  const tempFilePath = path.join(
    tempRoot,
    `${sanitizeResourceId(request.resourceId)}-${createId()}.download`
  );

  try {
    await mkdir(tempRoot, { recursive: true });
    await writeFile(tempFilePath, buffer, { flag: "wx" });
  } catch {
    throw downloadError("DOWNLOAD_WRITE_FAILED", "下载文件写入临时目录失败。", true);
  }

  return {
    resourceId: request.resourceId,
    urlHost: parsedUrl.host,
    bytesWritten: buffer.byteLength,
    tempFilePath,
    elapsedMs: Math.max(0, (options.now?.() ?? Date.now()) - startedAt)
  };
}
