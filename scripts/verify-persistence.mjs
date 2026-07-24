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
const outputDir = path.join(root, "node_modules", ".cache", "xunlei-persistence-compile");
const verifyRoot = mkdtempSync(path.join(tmpdir(), "xunlei-persistence-verify-"));
const tscBin = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc"
);

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
    path.join("electron", "taskStore.ts"),
    path.join("electron", "workspaceExporter.ts"),
    path.join("electron", "sql-js-asm.d.ts")
  ],
  { cwd: root, stdio: "inherit" }
);
if (compilation.status !== 0) process.exit(compilation.status ?? 1);

const require = createRequire(import.meta.url);
const {
  TaskStore,
  TASK_STORE_SCHEMA_VERSION
} = require(path.join(outputDir, "taskStore.js"));
const initSqlJs = require("sql.js/dist/sql-asm.js");
const SQL = await initSqlJs();
const {
  exportWorkspace,
  toWorkspaceExportError
} = require(path.join(outputDir, "workspaceExporter.js"));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function createSnapshot(overrides = {}) {
  return {
    taskId: "task-persistence",
    task: "准备 Python AI 工作区",
    phase: "exporting",
    revision: 2,
    approvedRevision: 2,
    route: "windows-ai-development",
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
    resources: [
      {
        id: "python-312",
        name: "Python",
        version: "3.12.4 x64",
        source: "python.org",
        sizeMb: 25.8,
        license: "PSF License",
        status: "verified",
        selected: true,
        attempts: 1
      }
    ],
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
      toolResults: [
        {
          callId: "download",
          tool: "controlled_download",
          status: "success",
          startedAt: "start",
          finishedAt: "finish"
        }
      ],
      policyAudit: [
        {
          actionId: "download",
          decision: {
            outcome: "allow",
            risk: "medium",
            reason: "approved"
          }
        }
      ]
    },
    ...overrides
  };
}

try {
  const workspaceRoot = path.join(verifyRoot, "workspaces");
  const exportSnapshot = createSnapshot();
  const firstExport = await exportWorkspace(exportSnapshot, {
    workspaceRoot,
    now: () => new Date("2026-07-24T00:00:00.000Z")
  });
  assert(!firstExport.reusedExisting, "First workspace export must create a new atomic directory");
  assert(firstExport.files.length === 6, "Workspace export must create all six handoff files");
  for (const file of firstExport.files) {
    assert(existsSync(file.absolutePath), `Exported file is missing: ${file.relativePath}`);
    assert(/^[a-f0-9]{64}$/.test(file.sha256), `Exported file has invalid SHA256: ${file.relativePath}`);
  }
  const manifest = JSON.parse(
    readFileSync(path.join(firstExport.rootPath, "resource-manifest.json"), "utf8")
  );
  assert(manifest.taskId === exportSnapshot.taskId, "Manifest must bind the task ID");
  assert(manifest.revision === exportSnapshot.revision, "Manifest must bind the approved revision");
  assert(manifest.audit.toolResults.length === 1, "Manifest must preserve ToolResult audit data");
  assert(manifest.audit.policyDecisions.length === 1, "Manifest must preserve Policy audit data");

  const repeatedExport = await exportWorkspace(exportSnapshot, { workspaceRoot });
  assert(repeatedExport.reusedExisting, "Repeated export must reuse the matching complete workspace");

  let invalidApprovalRejected = false;
  try {
    await exportWorkspace(
      createSnapshot({
        taskId: "task-unapproved",
        approvedRevision: null
      }),
      { workspaceRoot }
    );
  } catch (error) {
    invalidApprovalRejected =
      toWorkspaceExportError(error).code === "WORKSPACE_EXPORT_INVALID_STATE";
  }
  assert(invalidApprovalRejected, "Workspace export must reject an unapproved revision");

  const rollbackTaskId = "task-rollback";
  let rollbackRejected = false;
  try {
    await exportWorkspace(
      createSnapshot({ taskId: rollbackTaskId }),
      {
        workspaceRoot,
        beforeCommit: () => {
          throw new Error("injected commit failure");
        }
      }
    );
  } catch (error) {
    rollbackRejected =
      toWorkspaceExportError(error).code === "WORKSPACE_EXPORT_WRITE_FAILED";
  }
  assert(rollbackRejected, "Injected workspace commit failure must be surfaced");
  const rollbackParent = path.join(workspaceRoot, rollbackTaskId);
  assert(
    !existsSync(rollbackParent) ||
      readdirSync(rollbackParent).every((entry) => !entry.includes("staging")),
    "Failed workspace export must remove its staging directory"
  );

  const conflictTaskId = "task-conflict";
  const conflictTarget = path.join(workspaceRoot, conflictTaskId, "revision-2");
  mkdirSync(conflictTarget, { recursive: true });
  let conflictRejected = false;
  try {
    await exportWorkspace(createSnapshot({ taskId: conflictTaskId }), {
      workspaceRoot
    });
  } catch (error) {
    conflictRejected =
      toWorkspaceExportError(error).code === "WORKSPACE_EXPORT_CONFLICT";
  }
  assert(conflictRejected, "Incomplete existing workspace must be rejected without overwrite");
  assert(
    readdirSync(conflictTarget).length === 0,
    "Conflict handling must not modify the existing target directory"
  );

  const databasePath = path.join(verifyRoot, "agent-tasks.sqlite");
  let nowMs = Date.parse("2026-07-24T01:00:00.000Z");
  const store = await TaskStore.open({
    databasePath,
    approvalTtlMs: 1_000,
    now: () => nowMs
  });
  const freshSchema = await store.getSchemaInfo();
  assert(
    freshSchema.version === TASK_STORE_SCHEMA_VERSION &&
      freshSchema.supportedVersion === TASK_STORE_SCHEMA_VERSION,
    "Fresh task stores must be migrated to the current schema version"
  );
  assert(
    freshSchema.migrations.length === 1 &&
      freshSchema.migrations[0].name === "initial-task-persistence",
    "Fresh task stores must record the initial schema migration"
  );
  await store.saveSnapshot(exportSnapshot);
  const activeApproval = await store.hasValidApproval(
    exportSnapshot.taskId,
    exportSnapshot.revision
  );
  assert(activeApproval.valid, "Current revision approval must be active after persistence");
  await store.recordWorkspaceExport(firstExport);
  const storedExport = await store.getWorkspaceExport(
    firstExport.taskId,
    firstExport.revision
  );
  assert(storedExport?.rootPath === firstExport.rootPath, "Workspace export metadata must persist in SQLite");

  nowMs += 500;
  await store.saveSnapshot(exportSnapshot);
  nowMs += 600;
  const expiredApproval = await store.hasValidApproval(
    exportSnapshot.taskId,
    exportSnapshot.revision
  );
  assert(
    !expiredApproval.valid && expiredApproval.status === "expired",
    "Ordinary state persistence must not renew an approval beyond its configured TTL"
  );

  await store.saveSnapshot(
    createSnapshot({
      approvedRevision: null,
      phase: "waiting_approval"
    })
  );
  nowMs += 100;
  await store.saveSnapshot(exportSnapshot);
  const renewedApproval = await store.hasValidApproval(
    exportSnapshot.taskId,
    exportSnapshot.revision
  );
  assert(renewedApproval.valid, "Explicit reapproval must create a fresh active approval");
  await store.close();

  assert(
    readFileSync(databasePath).subarray(0, 15).toString() === "SQLite format 3",
    "Task store must persist a real SQLite database file"
  );

  const reopened = await TaskStore.open({
    databasePath,
    approvalTtlMs: 1_000,
    now: () => nowMs
  });
  const restored = await reopened.loadLatestUnfinished();
  assert(restored?.state.taskId === exportSnapshot.taskId, "Restart must restore the latest unfinished task");
  assert(
    restored.state.agentRun.toolResults.length === 1 &&
      restored.state.agentRun.policyAudit.length === 1,
    "Restored task must preserve ToolResult and Policy audit data"
  );
  await reopened.saveSnapshot(
    createSnapshot({
      phase: "handoff",
      workspace: {
        ready: true,
        files: firstExport.files.map((file) => file.relativePath),
        fileRecords: firstExport.files,
        exportStatus: "ready",
        rootPath: firstExport.rootPath,
        nextAction: "done"
      }
    })
  );
  assert(
    (await reopened.loadLatestUnfinished()) === null,
    "Completed handoff tasks must not auto-restore"
  );
  await reopened.close();

  const legacyDatabasePath = path.join(verifyRoot, "legacy-agent-tasks.sqlite");
  const legacyDatabase = new SQL.Database(readFileSync(databasePath));
  legacyDatabase.run(`
    PRAGMA user_version = 0;
    DROP TABLE schema_migrations;
  `);
  writeFileSync(legacyDatabasePath, legacyDatabase.export());
  legacyDatabase.close();

  const migratedLegacyStore = await TaskStore.open({
    databasePath: legacyDatabasePath,
    approvalTtlMs: 1_000,
    now: () => nowMs
  });
  const migratedSchema = await migratedLegacyStore.getSchemaInfo();
  assert(
    migratedSchema.version === TASK_STORE_SCHEMA_VERSION &&
      migratedSchema.migrations.some(
        (migration) => migration.version === TASK_STORE_SCHEMA_VERSION
      ),
    "An unversioned legacy database must migrate to the current schema"
  );
  assert(
    (await migratedLegacyStore.getTaskState(exportSnapshot.taskId))?.taskId ===
      exportSnapshot.taskId,
    "Legacy schema migration must preserve existing task data"
  );
  await migratedLegacyStore.close();

  const futureDatabasePath = path.join(verifyRoot, "future-agent-tasks.sqlite");
  const futureDatabase = new SQL.Database(readFileSync(legacyDatabasePath));
  futureDatabase.run(
    `PRAGMA user_version = ${TASK_STORE_SCHEMA_VERSION + 1}`
  );
  writeFileSync(futureDatabasePath, futureDatabase.export());
  futureDatabase.close();

  let futureSchemaRejected = false;
  try {
    const unsupportedStore = await TaskStore.open({
      databasePath: futureDatabasePath
    });
    await unsupportedStore.close();
  } catch (error) {
    futureSchemaRejected =
      error instanceof Error &&
      error.message.includes("newer than supported");
  }
  assert(
    futureSchemaRejected,
    "A database from a newer application version must be rejected without downgrade"
  );
} finally {
  rmSync(verifyRoot, { force: true, recursive: true });
}

console.log("Persistence passed: atomic export, SQLite schema migration, recovery, audit and approval expiry verified");
