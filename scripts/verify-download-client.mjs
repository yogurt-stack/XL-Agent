import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(tmpdir(), "xunlei-download-client-compile");
const verifyTempRoot = mkdtempSync(path.join(tmpdir(), "xunlei-download-client-verify-"));
const tscBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

rmSync(outputDir, { force: true, recursive: true });
const compilation = spawnSync(
  tscBin,
  [
    "--target", "ES2020",
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--esModuleInterop",
    "--skipLibCheck",
    "--types", "node",
    "--outDir", outputDir,
    path.join("electron", "downloadClient.ts")
  ],
  { cwd: root, stdio: "inherit" }
);
if (compilation.status !== 0) process.exit(compilation.status ?? 1);

const require = createRequire(import.meta.url);
const { downloadTrustedResource, toControlledDownloadError } = require(path.join(outputDir, "downloadClient.js"));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const assertRejectCode = async (task, expectedCode) => {
  try {
    await task();
  } catch (error) {
    const detail = toControlledDownloadError(error);
    assert(detail.code === expectedCode, `Expected ${expectedCode}, received ${detail.code}`);
    return;
  }
  throw new Error(`Expected ${expectedCode}, but the request succeeded`);
};

const baseRequest = {
  resourceId: "python-312",
  url: "https://downloads.xunlei.example/windows-ai-dev/python.exe",
  expectedSha256: "7b16d7f7610a4c9ebdb31d2b2ed7b0e0c3c9f681d7b9f2d4545cbf88d07a8c3a",
  maxSizeMb: 1,
  allowedHosts: ["downloads.xunlei.example"]
};

try {
  const success = await downloadTrustedResource(baseRequest, {
    tempRoot: verifyTempRoot,
    now: () => 1000,
    createId: () => "stable-id",
    fetchRequest: async (input) => {
      assert(String(input) === baseRequest.url, "Download client must request the trusted catalog URL");
      return new Response("payload", {
        status: 200,
        headers: { "content-length": "7" }
      });
    }
  });
  assert(success.resourceId === baseRequest.resourceId, "Success output must keep the resource ID");
  assert(success.urlHost === "downloads.xunlei.example", "Success output must report the trusted URL host");
  assert(success.bytesWritten === 7, "Success output must report written bytes");
  assert(readFileSync(success.tempFilePath, "utf8") === "payload", "Downloaded payload must be written to disk");

  await assertRejectCode(
    () => downloadTrustedResource({ ...baseRequest, url: "http://downloads.xunlei.example/file.exe" }),
    "URL_NOT_ALLOWED"
  );
  await assertRejectCode(
    () => downloadTrustedResource({ ...baseRequest, url: "https://evil.example/file.exe" }),
    "URL_NOT_ALLOWED"
  );

  const redirectedResponse = new Response("payload", { status: 200 });
  Object.defineProperty(redirectedResponse, "url", {
    value: "https://evil.example/file.exe"
  });
  await assertRejectCode(
    () =>
      downloadTrustedResource(baseRequest, {
        tempRoot: verifyTempRoot,
        fetchRequest: async () => redirectedResponse
      }),
    "URL_NOT_ALLOWED"
  );

  await assertRejectCode(
    () =>
      downloadTrustedResource(baseRequest, {
        tempRoot: verifyTempRoot,
        fetchRequest: async () => new Response("", { status: 500 })
      }),
    "DOWNLOAD_HTTP_ERROR"
  );

  await assertRejectCode(
    () =>
      downloadTrustedResource(
        { ...baseRequest, maxSizeMb: 1 },
        {
          tempRoot: verifyTempRoot,
          fetchRequest: async () =>
            new Response("payload", {
              status: 200,
              headers: { "content-length": String(2 * 1024 * 1024) }
            })
        }
      ),
    "DOWNLOAD_SIZE_LIMIT_EXCEEDED"
  );

  await assertRejectCode(
    () =>
      downloadTrustedResource(
        { ...baseRequest, maxSizeMb: 0.000001 },
        {
          tempRoot: verifyTempRoot,
          fetchRequest: async () => new Response("payload", { status: 200 })
        }
      ),
    "DOWNLOAD_SIZE_LIMIT_EXCEEDED"
  );
} finally {
  rmSync(verifyTempRoot, { force: true, recursive: true });
}

console.log("Controlled download client passed: URL, host, HTTP, size and temp-file write cases verified");
