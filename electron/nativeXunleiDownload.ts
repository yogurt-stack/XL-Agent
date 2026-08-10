import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ControlledDownloadResult } from "../src/features/agent-core/types";
import type {
  ControlledDownloadOptions,
  ControlledDownloadProgress
} from "./downloadClient";
import type { TrustedDownloadMetadata } from "./trustedDownloadCatalog";

type HostMessage = {
  type?: string;
  requestId?: string;
  code?: number;
  message?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  bytesWritten?: number;
};

export type NativeXunleiDownloadOptions = {
  appId: string;
  apiKey: string;
  helperPath: string;
  configRoot: string;
  appVersion?: string;
  tempRoot?: string;
};

function errorResult(code: string, message: string, retriable: boolean): ControlledDownloadResult {
  return { ok: false, error: { code, message, retriable } };
}

function safeFileName(url: string, resourceId: string) {
  const candidate = path.basename(new URL(url).pathname) || `${resourceId}.download`;
  return candidate
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-")
    .replace(/^\.+/u, "")
    .slice(0, 160) || `${resourceId}.download`;
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  const sha512 = createHash("sha512");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buffer.byteLength;
      hash.update(buffer);
      sha512.update(buffer);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { bytes, sha256: hash.digest("hex"), sha512Base64: sha512.digest("base64") };
}

function validateUrl(metadata: TrustedDownloadMetadata) {
  const parsed = new URL(metadata.url);
  if (parsed.protocol !== "https:" || !metadata.allowedHosts.includes(parsed.host)) {
    return errorResult("URL_NOT_ALLOWED", "下载 URL 不在可信目录允许的 HTTPS 主机内。", false);
  }
  return null;
}

export class NativeXunleiDownloadClient {
  constructor(private readonly options: NativeXunleiDownloadOptions) {}

  async download(
    resourceId: string,
    metadata: TrustedDownloadMetadata,
    downloadOptions: ControlledDownloadOptions = {}
  ): Promise<ControlledDownloadResult> {
    const invalidUrl = validateUrl(metadata);
    if (invalidUrl) return invalidUrl;
    await downloadOptions.waitIfPaused?.();

    const requestId = randomUUID();
    const root = downloadOptions.tempRoot ?? this.options.tempRoot ?? path.join(os.tmpdir(), "xunlei-agent-sdk");
    await mkdir(root, { recursive: true });
    const outputRoot = await mkdtemp(path.join(root, `${resourceId.replace(/[^a-zA-Z0-9._-]/g, "-")}-`));
    const saveName = safeFileName(metadata.url, resourceId);
    const outputPath = path.join(outputRoot, saveName);
    await mkdir(this.options.configRoot, { recursive: true });

    const child = spawn(this.options.helperPath, [], {
      cwd: path.dirname(this.options.helperPath),
      windowsHide: true,
      env: {
        ...process.env,
        XL_AGENT_XUNLEI_APP_ID: this.options.appId,
        XL_AGENT_XUNLEI_API_KEY: this.options.apiKey,
        XL_AGENT_XUNLEI_APP_VERSION: this.options.appVersion ?? "1.0.0",
        XL_AGENT_XUNLEI_CONFIG_DIR: this.options.configRoot
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk).slice(-2000);
    });
    let aborted = downloadOptions.signal?.aborted ?? false;
    let abortTimer: ReturnType<typeof setTimeout> | null = null;
    const abort = () => {
      aborted = true;
      if (!child.killed) child.kill();
    };
    downloadOptions.signal?.addEventListener("abort", abort, { once: true });

    const result = await new Promise<ControlledDownloadResult>((resolve) => {
      let settled = false;
      const finish = (value: ControlledDownloadResult) => {
        if (settled) return;
        settled = true;
        if (abortTimer) clearTimeout(abortTimer);
        resolve(value);
      };
      child.once("error", (error) =>
        finish(errorResult("DOWNLOAD_NATIVE_HOST_FAILED", error.message, true))
      );
      child.once("close", (code) => {
        if (!settled) {
          finish(aborted
            ? errorResult("DOWNLOAD_CANCELLED", "下载已取消。", true)
            : errorResult("DOWNLOAD_NATIVE_HOST_FAILED", stderr || `迅雷下载宿主退出（${code ?? "unknown"}）。`, true));
        }
      });
      (async () => {
        for await (const line of lines) {
          let message: HostMessage;
          try {
            message = JSON.parse(line) as HostMessage;
          } catch {
            continue;
          }
          if (message.type === "error") {
            finish(errorResult(
              `XUNLEI_${message.code ?? "UNKNOWN"}`,
              message.message ?? "迅雷 SDK 下载失败。",
              true
            ));
            child.kill();
            return;
          }
          if (message.type === "progress" && message.requestId === requestId) {
            const bytesWritten = message.downloadedBytes ?? 0;
            const totalBytes = message.totalBytes && message.totalBytes > 0 ? message.totalBytes : null;
            if (bytesWritten > metadata.maxSizeMb * 1024 * 1024) {
              abort();
              finish(errorResult("DOWNLOAD_SIZE_LIMIT_EXCEEDED", "迅雷下载超过可信目录允许的大小上限。", false));
              return;
            }
            const progress: ControlledDownloadProgress = {
              resourceId,
              bytesWritten,
              totalBytes,
              progress: totalBytes ? Math.min(99, Math.floor(bytesWritten * 100 / totalBytes)) : 0,
              speedBytesPerSecond: message.speedBytesPerSecond ?? 0,
              etaSeconds: totalBytes && message.speedBytesPerSecond
                ? Math.max(0, Math.ceil((totalBytes - bytesWritten) / message.speedBytesPerSecond))
                : null,
              tempFilePath: outputPath,
              etag: null,
              lastModified: null,
              resumeCapable: false,
              resumedFromBytes: 0
            };
            await downloadOptions.onProgress?.(progress);
          }
          if (message.type === "completed" && message.requestId === requestId) {
            try {
              const fileInfo = await stat(outputPath);
              const digest = await sha256File(outputPath);
              if (fileInfo.size > metadata.maxSizeMb * 1024 * 1024) {
                finish(errorResult("DOWNLOAD_SIZE_LIMIT_EXCEEDED", "迅雷下载超过可信目录允许的大小上限。", false));
              } else if (metadata.expectedSha256 && digest.sha256.toLowerCase() !== metadata.expectedSha256.toLowerCase()) {
                finish(errorResult("CHECKSUM_MISMATCH", "下载文件 SHA256 与可信目录不一致。", true));
              } else if (
                metadata.expectedIntegrity &&
                digest.sha512Base64 !== metadata.expectedIntegrity.digestBase64
              ) {
                finish(errorResult("CHECKSUM_MISMATCH", "下载文件 SHA512 与锁文件完整性信息不一致。", true));
              } else {
                await downloadOptions.onProgress?.({
                  resourceId,
                  bytesWritten: digest.bytes,
                  totalBytes: digest.bytes,
                  progress: 100,
                  speedBytesPerSecond: 0,
                  etaSeconds: 0,
                  tempFilePath: outputPath,
                  etag: null,
                  lastModified: null,
                  resumeCapable: false,
                  resumedFromBytes: 0
                });
                finish({ ok: true, output: {
                  resourceId,
                  fileName: saveName,
                  urlHost: new URL(metadata.url).host,
                  bytesWritten: digest.bytes,
                  sha256: digest.sha256,
                  tempFilePath: outputPath,
                  elapsedMs: 0,
                  resumedFromBytes: 0
                }});
              }
            } catch (error) {
              finish(errorResult("DOWNLOAD_WRITE_FAILED", error instanceof Error ? error.message : "无法读取迅雷下载文件。", true));
            }
            child.kill();
            return;
          }
        }
      })().catch((error) => finish(errorResult("DOWNLOAD_NATIVE_HOST_FAILED", error instanceof Error ? error.message : "读取迅雷 SDK 输出失败。", true)));
      child.once("spawn", () => {
        child.stdin.write(`${JSON.stringify({ action: "download", requestId, url: metadata.url, savePath: outputRoot, saveName })}\n`);
      });
      if (aborted) abort();
      abortTimer = setTimeout(() => {
        if (!settled) finish(errorResult("DOWNLOAD_NATIVE_HOST_FAILED", "迅雷 SDK 下载宿主响应超时。", true));
        child.kill();
      }, 30 * 60 * 1000);
    });
    downloadOptions.signal?.removeEventListener("abort", abort);
    return result;
  }
}
