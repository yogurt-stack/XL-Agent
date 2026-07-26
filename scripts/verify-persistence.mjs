import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifyRoot = mkdtempSync(path.join(tmpdir(), "xunlei-persistence-verify-"));
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
  TaskStore,
  TASK_STORE_SCHEMA_VERSION
} = require(path.join(root, "dist-electron", "electron", "taskStore.js"));
const {
  exportWorkspace,
  toWorkspaceExportError
} = require(
  path.join(root, "dist-electron", "electron", "workspaceExporter.js")
);
const initSqlJs = require("sql.js/dist/sql-asm.js");
const SQL = await initSqlJs();

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const artifactPayload = Buffer.from("verified download payload");
const artifactSha256 = sha256(artifactPayload);
const artifactRoot = path.join(verifyRoot, "download-cache");
mkdirSync(artifactRoot, { recursive: true });
const artifactPath = path.join(artifactRoot, "python-3.12.4-amd64.exe");
writeFileSync(artifactPath, artifactPayload);

function createSnapshot(overrides = {}) {
  return {
    taskId: "task-persistence",
    task: "准备 Python AI 工作区",
    phase: "exporting",
    revision: 2,
    approvedRevision: 2,
    route: "ai-development-environment",
    routeDecision: {
      status: "supported",
      skillId: "ai-development-environment",
      sourceProviderId: "trusted-catalog"
    },
    systemProfile: {
      os: "Windows 11",
      architecture: "x64",
      shell: "PowerShell 7",
      workspaceRoot: "C:\\XunleiAgent\\ai-dev-env-windows"
    },
    hostProfile: null,
    clarifications: [],
    clarificationIndex: 0,
    answers: {},
    taskRequirements: {
      intent: "python-ai",
      label: "Python AI",
      requiredCapabilities: ["python-runtime"]
    },
    planValidation: {
      valid: true,
      checkedRevision: 2,
      issues: []
    },
    resources: [{
      id: "python-312",
      name: "Python",
      version: "3.12.4 x64",
      publisher: "Python Software Foundation",
      source: "python.org",
      purpose: "Python runtime",
      recommendation: "Official runtime",
      sizeMb: 25.8,
      license: "PSF License",
      status: "verified",
      selected: true,
      attempts: 1,
      download: { expectedSha256: artifactSha256 }
    }],
    activeResourceId: null,
    replanReason: null,
    requestedReplanStrategy: null,
    logs: [{ id: 1, at: "事件 1", level: "success", message: "ready" }],
    workspace: {
      ready: false,
      files: [],
      fileRecords: [],
      exportStatus: "exporting",
      nextAction: "export"
    },
    planExplanation: null,
    agentRun: {
      step: 0,
      maxSteps: 6,
      status: "executing",
      decisions: [],
      toolResults: [{
        callId: "download",
        tool: "controlled_download",
        status: "success",
        output: {
          resourceId: "python-312",
          tempFilePath: artifactPath
        },
        startedAt: "start",
        finishedAt: "finish"
      }],
      policyAudit: [{
        actionId: "download",
        decision: {
          outcome: "allow",
          risk: "medium",
          reason: "approved"
        }
      }]
    },
    ...overrides
  };
}

function createArtifact(taskId = "task-persistence", revision = 2, overrides = {}) {
  return {
    taskId,
    revision,
    resourceId: "python-312",
    fileName: "python-3.12.4-amd64.exe",
    sourceHost: "www.python.org",
    tempFilePath: artifactPath,
    bytesWritten: artifactPayload.byteLength,
    sha256: artifactSha256,
    expectedSha256: artifactSha256,
    verificationStatus: "verified",
    verifiedAt: "2026-07-24T00:00:00.000Z",
    ...overrides
  };
}

try {
  const workspaceRoot = path.join(verifyRoot, "workspaces");
  const exportSnapshot = createSnapshot();
  const firstExport = await exportWorkspace(exportSnapshot, {
    workspaceRoot,
    downloadArtifacts: [createArtifact()],
    now: () => new Date("2026-07-24T00:00:00.000Z")
  });
  assert(!firstExport.reusedExisting, "First export must create an atomic directory");
  assert(firstExport.files.length === 7, "Workspace must contain six documents plus one download");
  const downloadRecord = firstExport.files.find((file) =>
    file.relativePath.startsWith("downloads/")
  );
  assert(downloadRecord && existsSync(downloadRecord.absolutePath), "Verified artifact must be copied into downloads/");
  assert(readFileSync(downloadRecord.absolutePath).equals(artifactPayload), "Copied artifact bytes must match");

  const manifestPath = path.join(firstExport.rootPath, "resource-manifest.json");
  const manifestText = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  assert(manifest.schemaVersion === "xunlei-agent-workspace-2.0", "Manifest schema must be v2");
  assert(manifest.revision === 2 && manifest.approvedRevision === 2, "Manifest must bind the approved revision");
  assert(manifest.resources[0].artifact.relativePath === downloadRecord.relativePath, "Manifest must link the copied download");
  assert(manifest.resources[0].artifact.sha256 === artifactSha256, "Manifest must record the copied SHA256");
  assert(!manifestText.includes(artifactPath), "Manifest must not expose temporary absolute download paths");
  assert(
    readFileSync(path.join(firstExport.rootPath, "RESOURCE_MANIFEST.md"), "utf8")
      .includes(artifactSha256),
    "Markdown must be derived from Manifest artifact data"
  );

  const repeatedExport = await exportWorkspace(exportSnapshot, { workspaceRoot });
  assert(repeatedExport.reusedExisting, "Repeated export must reuse a matching complete workspace");

  let missingArtifactRejected = false;
  try {
    await exportWorkspace(
      createSnapshot({ taskId: "task-missing-artifact" }),
      { workspaceRoot, downloadArtifacts: [] }
    );
  } catch (error) {
    missingArtifactRejected =
      toWorkspaceExportError(error).code === "WORKSPACE_EXPORT_ARTIFACT_MISSING";
  }
  assert(missingArtifactRejected, "Export must reject a verified state without a SQLite artifact record");

  let mismatchedArtifactRejected = false;
  try {
    await exportWorkspace(
      createSnapshot({ taskId: "task-bad-artifact" }),
      {
        workspaceRoot,
        downloadArtifacts: [
          createArtifact("task-bad-artifact", 2, {
            sha256: "0".repeat(64),
            expectedSha256: "0".repeat(64)
          })
        ]
      }
    );
  } catch (error) {
    mismatchedArtifactRejected =
      toWorkspaceExportError(error).code === "WORKSPACE_EXPORT_ARTIFACT_INVALID";
  }
  assert(mismatchedArtifactRejected, "Export must rehash and reject a tampered artifact");

  let invalidApprovalRejected = false;
  try {
    await exportWorkspace(
      createSnapshot({ taskId: "task-unapproved", approvedRevision: null }),
      { workspaceRoot, downloadArtifacts: [createArtifact("task-unapproved")] }
    );
  } catch (error) {
    invalidApprovalRejected =
      toWorkspaceExportError(error).code === "WORKSPACE_EXPORT_INVALID_STATE";
  }
  assert(invalidApprovalRejected, "Export must reject an unapproved revision");

  const rollbackTaskId = "task-rollback";
  let rollbackRejected = false;
  try {
    await exportWorkspace(
      createSnapshot({ taskId: rollbackTaskId }),
      {
        workspaceRoot,
        downloadArtifacts: [createArtifact(rollbackTaskId)],
        beforeCommit: () => {
          throw new Error("injected commit failure");
        }
      }
    );
  } catch (error) {
    rollbackRejected =
      toWorkspaceExportError(error).code === "WORKSPACE_EXPORT_WRITE_FAILED";
  }
  assert(rollbackRejected, "Injected commit failure must be surfaced");
  const rollbackParent = path.join(workspaceRoot, rollbackTaskId);
  assert(
    !existsSync(rollbackParent) ||
      readdirSync(rollbackParent).every((entry) => !entry.includes("staging")),
    "Failed export must remove its staging directory"
  );

  const conflictTaskId = "task-conflict";
  const conflictTarget = path.join(workspaceRoot, conflictTaskId, "revision-2");
  mkdirSync(conflictTarget, { recursive: true });
  let conflictRejected = false;
  try {
    await exportWorkspace(createSnapshot({ taskId: conflictTaskId }), {
      workspaceRoot,
      downloadArtifacts: [createArtifact(conflictTaskId)]
    });
  } catch (error) {
    conflictRejected =
      toWorkspaceExportError(error).code === "WORKSPACE_EXPORT_CONFLICT";
  }
  assert(conflictRejected && readdirSync(conflictTarget).length === 0, "Existing incomplete workspaces must not be overwritten");

  const databasePath = path.join(verifyRoot, "agent-tasks.sqlite");
  let nowMs = Date.parse("2026-07-24T01:00:00.000Z");
  const store = await TaskStore.open({
    databasePath,
    approvalTtlMs: 1_000,
    now: () => nowMs
  });
  const freshSchema = await store.getSchemaInfo();
  assert(
    freshSchema.version === 3 &&
      freshSchema.supportedVersion === TASK_STORE_SCHEMA_VERSION &&
      freshSchema.migrations.length === 3 &&
      freshSchema.migrations[2].name === "p0-resource-orchestration",
    "Fresh stores must apply and record SQLite schema v3"
  );

  await store.saveSnapshot(exportSnapshot);
  await store.recordDownloadArtifact(createArtifact());
  assert(
    (await store.listDownloadArtifacts(exportSnapshot.taskId, 2))[0]?.sha256 === artifactSha256,
    "Verified download artifacts must persist in SQLite"
  );
  assert(
    (await store.hasValidApproval(exportSnapshot.taskId, 2)).valid,
    "Current revision approval must be active"
  );
  await store.recordWorkspaceExport(firstExport);

  nowMs += 500;
  await store.saveSnapshot(exportSnapshot);
  nowMs += 600;
  const expiredApproval = await store.hasValidApproval(exportSnapshot.taskId, 2);
  assert(!expiredApproval.valid && expiredApproval.status === "expired", "State saves must not renew approval TTL");

  await store.saveSnapshot(createSnapshot({
    approvedRevision: null,
    phase: "waiting_approval"
  }));
  nowMs += 100;
  await store.saveSnapshot(exportSnapshot);
  assert(
    (await store.hasValidApproval(exportSnapshot.taskId, 2)).valid,
    "Explicit reapproval must create a fresh approval"
  );

  nowMs += 100;
  await store.saveSnapshot(createSnapshot({
    taskId: "task-history-newer",
    task: "已取消的历史任务",
    phase: "cancelled",
    approvedRevision: null
  }));
  const history = await store.listTaskHistory();
  assert(history.length === 2 && history[0].taskId === "task-history-newer", "History must be newest first");
  const detail = await store.getTaskHistoryDetail(exportSnapshot.taskId);
  assert(
    detail?.downloadArtifacts.length === 1 &&
      detail.workspaceExports[0]?.rootPath === firstExport.rootPath,
    "History detail must include download artifacts and workspace exports"
  );
  await store.close();

  assert(
    readFileSync(databasePath).subarray(0, 15).toString() === "SQLite format 3",
    "Task store must persist a real SQLite file"
  );

  const reopened = await TaskStore.open({
    databasePath,
    approvalTtlMs: 1_000,
    now: () => nowMs
  });
  const restored = await reopened.loadLatestUnfinished();
  assert(restored?.state.taskId === exportSnapshot.taskId, "Restart must restore the unfinished task");
  await reopened.saveSnapshot(createSnapshot({
    phase: "handoff",
    workspace: {
      ready: true,
      files: firstExport.files.map((file) => file.relativePath),
      fileRecords: firstExport.files,
      exportStatus: "ready",
      rootPath: firstExport.rootPath,
      nextAction: "done"
    }
  }));
  assert((await reopened.loadLatestUnfinished()) === null, "Handoff tasks must not auto-restore");
  await reopened.close();

  const legacyDatabasePath = path.join(verifyRoot, "legacy-agent-tasks.sqlite");
  const legacyDatabase = new SQL.Database(readFileSync(databasePath));
  legacyDatabase.run(`
    PRAGMA user_version = 1;
    DELETE FROM schema_migrations WHERE version > 1;
    DROP TABLE download_artifacts;
  `);
  writeFileSync(legacyDatabasePath, legacyDatabase.export());
  legacyDatabase.close();
  const migratedLegacyStore = await TaskStore.open({
    databasePath: legacyDatabasePath,
    now: () => nowMs
  });
  const migratedSchema = await migratedLegacyStore.getSchemaInfo();
  assert(
    migratedSchema.version === 3 &&
      migratedSchema.migrations.some((migration) => migration.version === 3),
    "A v1 database must migrate forward to v3"
  );
  assert(
    (await migratedLegacyStore.getTaskState(exportSnapshot.taskId))?.taskId === exportSnapshot.taskId,
    "Schema migration must preserve task snapshots"
  );
  await migratedLegacyStore.close();

  const futureDatabasePath = path.join(verifyRoot, "future-agent-tasks.sqlite");
  const futureDatabase = new SQL.Database(readFileSync(legacyDatabasePath));
  futureDatabase.run(`PRAGMA user_version = ${TASK_STORE_SCHEMA_VERSION + 1}`);
  writeFileSync(futureDatabasePath, futureDatabase.export());
  futureDatabase.close();
  let futureSchemaRejected = false;
  try {
    const unsupportedStore = await TaskStore.open({ databasePath: futureDatabasePath });
    await unsupportedStore.close();
  } catch (error) {
    futureSchemaRejected =
      error instanceof Error && error.message.includes("newer than supported");
  }
  assert(futureSchemaRejected, "Newer schemas must be rejected without downgrade");
} finally {
  rmSync(verifyRoot, { force: true, recursive: true });
}

console.log(
  "Persistence passed: SQLite v3 tasks/artifacts, atomic workspace export, recovery and approval expiry verified"
);
