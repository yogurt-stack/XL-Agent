import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifyRoot = mkdtempSync(path.join(tmpdir(), "xunlei-p1-verify-"));
const tscBin = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc"
);
const compilation = spawnSync(
  tscBin,
  ["-p", path.join("electron", "tsconfig.json")],
  { cwd: root, stdio: "inherit" }
);
if (compilation.status !== 0) process.exit(compilation.status ?? 1);

const require = createRequire(import.meta.url);
const {
  downloadTrustedResource,
  toControlledDownloadError
} = require(path.join(root, "dist-electron", "electron", "downloadClient.js"));
const {
  WindowsAuthenticodeVerifier,
  publisherMatches
} = require(
  path.join(root, "dist-electron", "electron", "authenticodeVerifier.js")
);
const {
  ElectronArtifactVerifier
} = require(path.join(root, "dist-electron", "electron", "artifactVerifier.js"));
const {
  LocalXunleiAdapter
} = require(path.join(root, "dist-electron", "electron", "xunleiAdapter.js"));
const {
  TaskStore,
  TASK_STORE_SCHEMA_VERSION
} = require(path.join(root, "dist-electron", "electron", "taskStore.js"));
const {
  TrustedCatalogSourceProvider
} = require(
  path.join(
    root,
    "dist-electron",
    "src",
    "features",
    "agent-core",
    "sourceProviders.js"
  )
);
const {
  trustedCatalog
} = require(
  path.join(
    root,
    "dist-electron",
    "src",
    "features",
    "agent-core",
    "catalog.js"
  )
);
const initSqlJs = require("sql.js/dist/sql-asm.js");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function assertRejectCode(task, expectedCode) {
  try {
    await task();
  } catch (error) {
    const detail = toControlledDownloadError(error);
    assert(
      detail.code === expectedCode,
      `Expected ${expectedCode}, received ${detail.code}`
    );
    return;
  }
  throw new Error(`Expected ${expectedCode}, but the request succeeded`);
}

try {
  const [catalogResource] = trustedCatalog;
  const deprecated = {
    ...structuredClone(catalogResource),
    id: "deprecated-resource",
    catalogStatus: "deprecated",
    statusReason: "superseded"
  };
  const revoked = {
    ...structuredClone(catalogResource),
    id: "revoked-resource",
    catalogStatus: "revoked",
    statusReason: "compromised"
  };
  const provider = new TrustedCatalogSourceProvider([
    catalogResource,
    deprecated,
    revoked
  ]);
  assert(
    provider.search({
      resourceIds: [
        catalogResource.id,
        deprecated.id,
        revoked.id
      ]
    }).map((resource) => resource.id).join(",") === catalogResource.id,
    "Source Provider must exclude deprecated and revoked resources from new plans"
  );

  const fullPayload = Buffer.from("hello world");
  const resumeRoot = path.join(verifyRoot, "resume-cache");
  const resumePath = path.join(resumeRoot, "resource-stable", "artifact.bin");
  mkdirSync(path.dirname(resumePath), { recursive: true });
  writeFileSync(resumePath, "hello ");
  const resumeRequest = {
    resourceId: "range-resource",
    url: "https://downloads.example.test/artifact.bin",
    expectedSha256: sha256(fullPayload),
    maxSizeMb: 1,
    allowedHosts: ["downloads.example.test"]
  };
  const resumed = await downloadTrustedResource(resumeRequest, {
    tempRoot: resumeRoot,
    resume: {
      tempFilePath: resumePath,
      etag: "\"artifact-v1\"",
      lastModified: null
    },
    fetchRequest: async (_input, init) => {
      const headers = new Headers(init?.headers);
      assert(headers.get("range") === "bytes=6-", "Resume must request the persisted byte offset");
      assert(headers.get("if-range") === "\"artifact-v1\"", "Resume must bind the server validator");
      return new Response("world", {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-length": "5",
          "content-range": "bytes 6-10/11",
          etag: "\"artifact-v1\""
        }
      });
    }
  });
  assert(
    resumed.resumedFromBytes === 6 &&
      readFileSync(resumePath).equals(fullPayload),
    "HTTP Range resume must append to, hash and verify the full artifact"
  );

  const invalidResumePath = path.join(
    resumeRoot,
    "resource-invalid",
    "artifact.bin"
  );
  mkdirSync(path.dirname(invalidResumePath), { recursive: true });
  writeFileSync(invalidResumePath, "hello ");
  await assertRejectCode(
    () =>
      downloadTrustedResource(resumeRequest, {
        tempRoot: resumeRoot,
        resume: {
          tempFilePath: invalidResumePath,
          etag: "\"artifact-v1\"",
          lastModified: null
        },
        fetchRequest: async () =>
          new Response("world", {
            status: 206,
            headers: {
              "content-length": "5",
              "content-range": "bytes 7-11/12"
            }
          })
      }),
    "DOWNLOAD_RESUME_REJECTED"
  );
  assert(
    readFileSync(invalidResumePath, "utf8") === "hello ",
    "An invalid server range must not mutate the persisted checkpoint"
  );

  const restartPath = path.join(
    resumeRoot,
    "resource-restart",
    "artifact.bin"
  );
  mkdirSync(path.dirname(restartPath), { recursive: true });
  writeFileSync(restartPath, "stale ");
  const restarted = await downloadTrustedResource(resumeRequest, {
    tempRoot: resumeRoot,
    resume: {
      tempFilePath: restartPath,
      etag: "\"stale\"",
      lastModified: null
    },
    fetchRequest: async () =>
      new Response(fullPayload, {
        status: 200,
        headers: { "content-length": String(fullPayload.byteLength) }
      })
  });
  assert(
    restarted.resumedFromBytes === 0 &&
      readFileSync(restartPath).equals(fullPayload),
    "A server that ignores Range must restart safely instead of appending corrupt bytes"
  );

  const adapterDatabasePath = path.join(verifyRoot, "adapter-resume.sqlite");
  let adapterStore = await TaskStore.open({
    databasePath: adapterDatabasePath
  });
  const adapterCheckpointPath = path.join(
    resumeRoot,
    "adapter-resource",
    "artifact.bin"
  );
  mkdirSync(path.dirname(adapterCheckpointPath), { recursive: true });
  writeFileSync(adapterCheckpointPath, "hello ");
  await adapterStore.recordDownloadTask({
    taskId: "task-adapter-resume",
    revision: 1,
    resourceId: "adapter-resource",
    status: "downloading",
    progress: 54,
    bytesWritten: 6,
    totalBytes: 11,
    speedBytesPerSecond: 1,
    etaSeconds: 5,
    tempFilePath: adapterCheckpointPath,
    errorCode: null,
    errorMessage: null,
    resumeEtag: "\"adapter-v1\"",
    resumeLastModified: null,
    resumeCapable: true,
    resumedFromBytes: 0,
    createdAt: "2026-07-26T09:00:00.000Z",
    updatedAt: "2026-07-26T09:00:01.000Z"
  });
  await adapterStore.close();
  adapterStore = await TaskStore.open({
    databasePath: adapterDatabasePath
  });
  assert(
    (await adapterStore.listDownloadTasks("task-adapter-resume", 1))[0]
      ?.status === "interrupted",
    "Opening the application must mark an in-flight checkpoint as interrupted"
  );
  const adapter = new LocalXunleiAdapter({
    store: adapterStore,
    performDownload: async (resourceId, metadata, options) => {
      try {
        return {
          ok: true,
          output: await downloadTrustedResource(
            { resourceId, ...metadata },
            {
              ...options,
              tempRoot: resumeRoot,
              fetchRequest: async (_input, init) => {
                const headers = new Headers(init?.headers);
                assert(
                  headers.get("range") === "bytes=6-" &&
                    headers.get("if-range") === "\"adapter-v1\"",
                  "Adapter must restore the persisted checkpoint and validators"
                );
                return new Response("world", {
                  status: 206,
                  headers: {
                    "accept-ranges": "bytes",
                    "content-length": "5",
                    "content-range": "bytes 6-10/11",
                    etag: "\"adapter-v1\""
                  }
                });
              }
            }
          )
        };
      } catch (error) {
        return { ok: false, error: toControlledDownloadError(error) };
      }
    }
  });
  const adapterResult = await adapter.createDownloadTask({
    taskId: "task-adapter-resume",
    revision: 1,
    resourceId: "adapter-resource",
    metadata: {
      url: resumeRequest.url,
      expectedSha256: resumeRequest.expectedSha256,
      maxSizeMb: resumeRequest.maxSizeMb,
      allowedHosts: resumeRequest.allowedHosts
    }
  });
  assert(
    adapterResult.ok &&
      adapterResult.output.resumedFromBytes === 6 &&
      (await adapterStore.listOperationEvents("task-adapter-resume")).some(
        (event) => event.eventType === "download-resumed"
      ),
    "LocalXunleiAdapter must resume an interrupted task and audit the recovered byte count"
  );
  await adapterStore.close();

  let inspectedEnvironment;
  const windowsVerifier = new WindowsAuthenticodeVerifier({
    platform: "win32",
    now: () => new Date("2026-07-26T10:00:00.000Z"),
    run: async (executable, args, environment) => {
      inspectedEnvironment = { executable, args, environment };
      return JSON.stringify({
        Status: "Valid",
        StatusMessage: "Signature verified.",
        Subject:
          'CN="Open Source Developer, Johannes Schindelin", O=Git for Windows',
        Thumbprint: "AABBCC"
      });
    }
  });
  const nativeSignature = await windowsVerifier.verify(
    path.join(verifyRoot, "signed.exe")
  );
  assert(
    nativeSignature.status === "valid" &&
      nativeSignature.publisher ===
        "Open Source Developer, Johannes Schindelin" &&
      inspectedEnvironment.environment.XL_AGENT_SIGNATURE_FILE.endsWith("signed.exe") &&
      inspectedEnvironment.args.includes("-EncodedCommand"),
    "Windows verifier must use a fixed encoded inspection command and return signer identity"
  );
  assert(
    publisherMatches(
      "Python Software Foundation",
      "Python Software Foundation"
    ) &&
      !publisherMatches("Unknown Publisher", "Microsoft Corporation") &&
      !publisherMatches("Microsoft", "Microsoft Corporation"),
    "Publisher matching must require the full normalized signer name"
  );
  const nonWindowsSignature = await new WindowsAuthenticodeVerifier({
    platform: "linux"
  }).verify(path.join(verifyRoot, "signed.exe"));
  assert(
    nonWindowsSignature.status === "unavailable",
    "Required Authenticode must report unavailable outside Windows"
  );

  const databasePath = path.join(verifyRoot, "p1.sqlite");
  const store = await TaskStore.open({ databasePath });
  const artifactPayload = Buffer.from("signed fixture");
  const artifactPath = path.join(verifyRoot, "signed-fixture.exe");
  writeFileSync(artifactPath, artifactPayload);
  const artifactSha256 = sha256(artifactPayload);
  const resource = {
    id: "signed-resource",
    selected: true,
    download: {
      expectedSha256: artifactSha256,
      allowedHosts: ["downloads.example.test"]
    },
    verification: {
      signatureEnforcement: "required",
      expectedPublisher: "Python Software Foundation"
    }
  };
  await store.recordDownloadArtifact({
    taskId: "task-signature-valid",
    revision: 1,
    resourceId: resource.id,
    fileName: "signed-fixture.exe",
    sourceHost: "downloads.example.test",
    tempFilePath: artifactPath,
    bytesWritten: artifactPayload.byteLength,
    sha256: artifactSha256,
    expectedSha256: artifactSha256,
    verificationStatus: "downloaded",
    verifiedAt: "2026-07-26T10:00:00.000Z",
    signatureStatus: "pending",
    expectedPublisher: "Python Software Foundation",
    actualPublisher: null,
    certificateThumbprint: null,
    signatureMessage: null,
    signatureCheckedAt: null
  });
  const signatureVerifier = new ElectronArtifactVerifier(
    store,
    false,
    {
      verify: async () => ({
        status: "valid",
        publisher: "Python Software Foundation",
        signerSubject: "CN=Python Software Foundation",
        certificateThumbprint: "AABBCC",
        statusMessage: "valid",
        checkedAt: "2026-07-26T10:01:00.000Z"
      })
    }
  );
  const verified = await signatureVerifier.verify({
    taskId: "task-signature-valid",
    revision: 1,
    phase: "verifying",
    resources: [resource]
  });
  const storedArtifact = (
    await store.listDownloadArtifacts("task-signature-valid", 1)
  )[0];
  assert(
    !verified.failure &&
      storedArtifact.verificationStatus === "verified" &&
      storedArtifact.signatureStatus === "valid" &&
      storedArtifact.actualPublisher === "Python Software Foundation",
    "Artifact verifier must require SHA256, Authenticode and expected publisher before promotion"
  );
  assert(
    (await store.listOperationEvents("task-signature-valid")).some(
      (event) => event.eventType === "signature-verified"
    ),
    "Signature decisions must be written to the operation audit"
  );

  await store.recordDownloadArtifact({
    ...storedArtifact,
    taskId: "task-signature-mismatch",
    revision: 1,
    verificationStatus: "downloaded",
    signatureStatus: "pending",
    actualPublisher: null,
    signatureCheckedAt: null
  });
  const publisherMismatch = await new ElectronArtifactVerifier(
    store,
    false,
    {
      verify: async () => ({
        status: "valid",
        publisher: "Unknown Publisher",
        signerSubject: "CN=Unknown Publisher",
        certificateThumbprint: "DDEEFF",
        statusMessage: "valid but unexpected publisher",
        checkedAt: "2026-07-26T10:02:00.000Z"
      })
    }
  ).verify({
    taskId: "task-signature-mismatch",
    revision: 1,
    phase: "verifying",
    resources: [resource]
  });
  assert(
    publisherMismatch.failure?.code === "ARTIFACT_PUBLISHER_MISMATCH",
    "A cryptographically valid signature from the wrong publisher must be rejected"
  );
  await store.close();

  const SQL = await initSqlJs();
  const legacyPath = path.join(verifyRoot, "legacy-v3.sqlite");
  const legacy = new SQL.Database();
  legacy.run(`
    CREATE TABLE approval_records (
      task_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      actor TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (task_id, revision)
    );
    CREATE TABLE download_artifacts (
      task_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      resource_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      source_host TEXT NOT NULL,
      temp_file_path TEXT NOT NULL,
      bytes_written INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      expected_sha256 TEXT NOT NULL,
      verification_status TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      PRIMARY KEY (task_id, revision, resource_id)
    );
    CREATE TABLE download_tasks (
      task_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      resource_id TEXT NOT NULL,
      status TEXT NOT NULL,
      progress REAL NOT NULL,
      bytes_written INTEGER NOT NULL,
      total_bytes INTEGER,
      speed_bytes_per_second INTEGER NOT NULL,
      eta_seconds INTEGER,
      temp_file_path TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (task_id, revision, resource_id)
    );
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations VALUES
      (1, 'initial-task-persistence', '2026-07-25T00:00:00.000Z'),
      (2, 'verified-download-artifacts', '2026-07-25T00:00:00.000Z'),
      (3, 'p0-resource-orchestration', '2026-07-25T00:00:00.000Z');
    INSERT INTO approval_records VALUES (
      'legacy-task', 1, 'local-user',
      '2026-07-25T00:00:00.000Z',
      '2027-07-25T00:00:00.000Z',
      'active'
    );
    PRAGMA user_version = 3;
  `);
  writeFileSync(legacyPath, legacy.export());
  legacy.close();
  const migrated = await TaskStore.open({ databasePath: legacyPath });
  const schema = await migrated.getSchemaInfo();
  const legacyApproval = await migrated.getApproval("legacy-task", 1);
  assert(
    schema.version === 4 &&
      schema.supportedVersion === TASK_STORE_SCHEMA_VERSION &&
      legacyApproval.status === "revoked" &&
      legacyApproval.catalogVersion === "legacy-unpinned",
    "v3 migration must add P1 columns and revoke unpinned legacy approvals"
  );
  await migrated.close();

  assert(existsSync(databasePath), "P1 verification must persist a real SQLite database");
  console.log(
    "P1 supply-chain resilience passed: catalog lifecycle, pinned approvals, HTTP Range resume, Authenticode publisher enforcement, operation audit and SQLite v4 migration verified"
  );
} finally {
  rmSync(verifyRoot, { recursive: true, force: true });
}
