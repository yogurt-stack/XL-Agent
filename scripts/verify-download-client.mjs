import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(tmpdir(), "xunlei-download-client-compile");
const coreOutputDir = path.join(outputDir, "core");
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
    path.join("electron", "downloadClient.ts"),
    path.join("electron", "trustedDownloadCatalog.ts")
  ],
  { cwd: root, stdio: "inherit" }
);
if (compilation.status !== 0) process.exit(compilation.status ?? 1);

const coreCatalogCompilation = spawnSync(
  tscBin,
  [
    "--target", "ES2020",
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--skipLibCheck",
    "--outDir", coreOutputDir,
    path.join("src", "features", "agent-core", "catalog.ts"),
    path.join("src", "features", "agent-core", "types.ts")
  ],
  { cwd: root, stdio: "inherit" }
);
if (coreCatalogCompilation.status !== 0) process.exit(coreCatalogCompilation.status ?? 1);

const require = createRequire(import.meta.url);
const { downloadTrustedResource, toControlledDownloadError } = require(path.join(outputDir, "downloadClient.js"));
const { getTrustedDownloadMetadata } = require(path.join(outputDir, "trustedDownloadCatalog.js"));
const { trustedCatalog } = require(path.join(coreOutputDir, "catalog.js"));

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

const payload = "payload";
const payloadSha256 = createHash("sha256").update(payload).digest("hex");
const baseRequest = {
  resourceId: "python-312",
  url: "https://downloads.xunlei.example/windows-ai-dev/python.exe",
  expectedSha256: payloadSha256,
  maxSizeMb: 1,
  allowedHosts: ["downloads.xunlei.example"]
};

try {
  const trustedMetadata = getTrustedDownloadMetadata("python-312");
  assert(trustedMetadata?.url.startsWith("https://downloads.xunlei.example/"), "Main-process catalog must resolve trusted resource IDs");
  assert(getTrustedDownloadMetadata("unknown-resource") === null, "Main-process catalog must reject unknown resource IDs");
  trustedMetadata.allowedHosts.push("evil.example");
  assert(
    !getTrustedDownloadMetadata("python-312").allowedHosts.includes("evil.example"),
    "Trusted catalog lookups must return defensive copies"
  );
  for (const resource of trustedCatalog) {
    assert(
      JSON.stringify(getTrustedDownloadMetadata(resource.id)) === JSON.stringify(resource.download),
      `Main-process download metadata drifted from Agent Core for ${resource.id}`
    );
  }

  const success = await downloadTrustedResource(baseRequest, {
    tempRoot: verifyTempRoot,
    now: () => 1000,
    createId: () => "stable-id",
    fetchRequest: async (input) => {
      assert(String(input) === baseRequest.url, "Download client must request the trusted catalog URL");
      return new Response(payload, {
        status: 200,
        headers: { "content-length": "7" }
      });
    }
  });
  assert(success.resourceId === baseRequest.resourceId, "Success output must keep the resource ID");
  assert(success.urlHost === "downloads.xunlei.example", "Success output must report the trusted URL host");
  assert(success.bytesWritten === 7, "Success output must report written bytes");
  assert(success.sha256 === payloadSha256, "Success output must report the verified SHA256");
  assert(readFileSync(success.tempFilePath, "utf8") === payload, "Downloaded payload must be written to disk");

  await assertRejectCode(
    () => downloadTrustedResource({ ...baseRequest, url: "http://downloads.xunlei.example/file.exe" }),
    "URL_NOT_ALLOWED"
  );
  await assertRejectCode(
    () => downloadTrustedResource({ ...baseRequest, url: "https://evil.example/file.exe" }),
    "URL_NOT_ALLOWED"
  );

  const redirectedResponse = new Response(payload, { status: 200 });
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
            new Response(payload, {
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
          fetchRequest: async () => new Response(payload, { status: 200 })
        }
      ),
    "DOWNLOAD_SIZE_LIMIT_EXCEEDED"
  );

  await assertRejectCode(
    () =>
      downloadTrustedResource(
        { ...baseRequest, expectedSha256: "not-a-sha256" },
        {
          tempRoot: verifyTempRoot,
          fetchRequest: async () => new Response(payload, { status: 200 })
        }
      ),
    "CHECKSUM_METADATA_INVALID"
  );

  const checksumMismatchTempRoot = path.join(verifyTempRoot, "checksum-mismatch");
  await assertRejectCode(
    () =>
      downloadTrustedResource(
        { ...baseRequest, expectedSha256: "0".repeat(64) },
        {
          tempRoot: checksumMismatchTempRoot,
          fetchRequest: async () => new Response(payload, { status: 200 })
        }
      ),
    "CHECKSUM_MISMATCH"
  );
  assert(
    !existsSync(checksumMismatchTempRoot) || readdirSync(checksumMismatchTempRoot).length === 0,
    "Checksum mismatch must not leave a downloaded temp file"
  );
} finally {
  rmSync(verifyTempRoot, { force: true, recursive: true });
}

console.log("Controlled download client passed: URL, host, HTTP, size, SHA256 and temp-file write cases verified");
