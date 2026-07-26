import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import initSqlJs = require("sql.js/dist/sql-asm.js");
import type { Database, ParamsObject, SqlValue } from "sql.js";
import type {
  WorkspaceExportOutput,
  WorkspaceSnapshot
} from "./workspaceExporter";
import type {
  AgentBInspectionAnswer,
  AgentState
} from "../src/features/agent-core/types";
import type { DownloadArtifactRecord } from "./downloadArtifacts";
import type {
  DownloadTaskRecord,
  DownloadTaskStatus
} from "./downloadTasks";
import type { LocalArtifactRecord } from "./localArtifacts";
import {
  createManifestSnapshot,
  type ManifestSnapshotRecord,
  type ResourceManifestSnapshot
} from "./manifestSnapshots";
import { trustedCatalogMetadata } from "./trustedDownloadCatalog";

export type PersistedAgentState = WorkspaceSnapshot & {
  activeResourceId: string | null;
  replanReason: string | null;
  requestedReplanStrategy: string | null;
  logs: unknown[];
  workspace: WorkspaceSnapshot["workspace"] & {
    ready: boolean;
    exportStatus: string;
    rootPath?: string;
  };
  [key: string]: unknown;
};

export type ApprovalRecord = {
  taskId: string;
  revision: number;
  actor: "local-user";
  approvedAt: string;
  expiresAt: string;
  status: "active" | "expired" | "revoked";
  catalogVersion: string;
  catalogSourceSha256: string;
};

export type RestoredTask = {
  state: PersistedAgentState;
  approval: {
    valid: boolean;
    expiresAt: string | null;
  };
  savedAt: string;
};

export type TaskHistorySummary = {
  taskId: string;
  task: string;
  phase: string;
  revision: number;
  approvedRevision: number | null;
  updatedAt: string;
  resourceCount: number;
  verifiedResourceCount: number;
  workspaceReady: boolean;
  hasErrors: boolean;
};

export type TaskHistoryDetail = {
  summary: TaskHistorySummary;
  state: PersistedAgentState;
  approvals: ApprovalRecord[];
  workspaceExports: WorkspaceExportOutput[];
  downloadArtifacts: DownloadArtifactRecord[];
  operationEvents: OperationEventRecord[];
};

export type TaskStoreOptions = {
  databasePath: string;
  approvalTtlMs?: number;
  now?: () => number;
};

export const TASK_STORE_SCHEMA_VERSION = 4;

export type TaskStoreSchemaInfo = {
  version: number;
  supportedVersion: number;
  migrations: Array<{
    version: number;
    name: string;
    appliedAt: string;
  }>;
};

export type AgentBRunRecord = {
  runId: string;
  taskId: string;
  planRevision: number;
  manifestRevision: number | null;
  grantId: string;
  status: "running" | "completed" | "failed";
  toolResult: unknown;
  answer: AgentBInspectionAnswer | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type OperationEventRecord = {
  eventId: string;
  taskId: string;
  revision: number;
  resourceId: string | null;
  eventType:
    | "catalog-approval-pinned"
    | "catalog-pin-rejected"
    | "download-checkpointed"
    | "download-resumed"
    | "signature-verified"
    | "signature-rejected";
  outcome: "success" | "denied" | "error";
  detail: unknown;
  createdAt: string;
};

const terminalPhases = new Set(["intake", "unsupported", "handoff", "cancelled"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPersistedAgentState(value: unknown): value is PersistedAgentState {
  if (!isRecord(value) || !isRecord(value.agentRun) || !isRecord(value.workspace)) {
    return false;
  }
  return (
    typeof value.taskId === "string" &&
    value.taskId.length > 0 &&
    typeof value.task === "string" &&
    value.task.trim().length > 0 &&
    typeof value.phase === "string" &&
    typeof value.revision === "number" &&
    Number.isInteger(value.revision) &&
    value.revision >= 0 &&
    (value.approvedRevision === null || Number.isInteger(value.approvedRevision)) &&
    (value.activeResourceId === null || typeof value.activeResourceId === "string") &&
    Array.isArray(value.resources) &&
    Array.isArray(value.logs) &&
    Array.isArray(value.agentRun.toolResults) &&
    Array.isArray(value.agentRun.policyAudit) &&
    typeof value.workspace.ready === "boolean" &&
    typeof value.workspace.exportStatus === "string" &&
    (typeof value.route === "string" || value.route === null) &&
    value.resources.every(
      (resource) =>
        isRecord(resource) &&
        typeof resource.id === "string" &&
        typeof resource.name === "string" &&
        typeof resource.version === "string" &&
        typeof resource.source === "string" &&
        typeof resource.sizeMb === "number" &&
        typeof resource.license === "string" &&
        typeof resource.status === "string" &&
        typeof resource.selected === "boolean" &&
        typeof resource.attempts === "number"
    )
  );
}

function firstRow(
  database: Database,
  sql: string,
  params: SqlValue[] = []
): ParamsObject | null {
  const statement = database.prepare(sql);
  try {
    statement.bind(params);
    return statement.step() ? statement.getAsObject() : null;
  } finally {
    statement.free();
  }
}

function tableHasColumn(
  database: Database,
  tableName: string,
  columnName: string
) {
  const statement = database.prepare(`PRAGMA table_info(${tableName})`);
  try {
    while (statement.step()) {
      if (asString(statement.getAsObject().name) === columnName) return true;
    }
    return false;
  } finally {
    statement.free();
  }
}

function addColumnIfMissing(
  database: Database,
  tableName: string,
  columnName: string,
  declaration: string
) {
  if (!tableHasColumn(database, tableName, columnName)) {
    database.run(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${declaration}`
    );
  }
}

function asString(value: SqlValue | undefined) {
  return typeof value === "string" ? value : null;
}

function asNumber(value: SqlValue | undefined) {
  return typeof value === "number" ? value : null;
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isWorkspaceExportOutput(value: unknown): value is WorkspaceExportOutput {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    Number.isInteger(value.revision) &&
    typeof value.rootPath === "string" &&
    typeof value.generatedAt === "string" &&
    typeof value.reusedExisting === "boolean" &&
    Array.isArray(value.files)
  );
}

function isDownloadArtifactRecord(
  value: unknown
): value is DownloadArtifactRecord {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.taskId) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) > 0 &&
    typeof value.resourceId === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value.resourceId) &&
    typeof value.fileName === "string" &&
    value.fileName === path.basename(value.fileName) &&
    value.fileName !== "." &&
    value.fileName !== ".." &&
    typeof value.sourceHost === "string" &&
    value.sourceHost.length > 0 &&
    typeof value.tempFilePath === "string" &&
    path.isAbsolute(value.tempFilePath) &&
    Number.isSafeInteger(value.bytesWritten) &&
    (value.bytesWritten as number) >= 0 &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(value.sha256) &&
    typeof value.expectedSha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(value.expectedSha256) &&
    (value.verificationStatus === "downloaded" ||
      value.verificationStatus === "verified" ||
      value.verificationStatus === "local-verified" ||
      value.verificationStatus === "test-fixture") &&
    typeof value.verifiedAt === "string" &&
    Number.isFinite(Date.parse(value.verifiedAt)) &&
    (value.signatureStatus === "pending" ||
      value.signatureStatus === "valid" ||
      value.signatureStatus === "invalid" ||
      value.signatureStatus === "unsigned" ||
      value.signatureStatus === "unavailable" ||
      value.signatureStatus === "not-applicable") &&
    (value.expectedPublisher === null ||
      typeof value.expectedPublisher === "string") &&
    (value.actualPublisher === null ||
      typeof value.actualPublisher === "string") &&
    (value.certificateThumbprint === null ||
      typeof value.certificateThumbprint === "string") &&
    (value.signatureMessage === null ||
      typeof value.signatureMessage === "string") &&
    (value.signatureCheckedAt === null ||
      (typeof value.signatureCheckedAt === "string" &&
        Number.isFinite(Date.parse(value.signatureCheckedAt))))
  );
}

function downloadArtifactFromRow(
  row: ParamsObject
): DownloadArtifactRecord | null {
  const candidate = {
    taskId: asString(row.task_id),
    revision: asNumber(row.revision),
    resourceId: asString(row.resource_id),
    fileName: asString(row.file_name),
    sourceHost: asString(row.source_host),
    tempFilePath: asString(row.temp_file_path),
    bytesWritten: asNumber(row.bytes_written),
    sha256: asString(row.sha256),
    expectedSha256: asString(row.expected_sha256),
    verificationStatus: asString(row.verification_status),
    verifiedAt: asString(row.verified_at),
    signatureStatus: asString(row.signature_status),
    expectedPublisher: asString(row.expected_publisher),
    actualPublisher: asString(row.actual_publisher),
    certificateThumbprint: asString(row.certificate_thumbprint),
    signatureMessage: asString(row.signature_message),
    signatureCheckedAt: asString(row.signature_checked_at)
  };
  return isDownloadArtifactRecord(candidate) ? candidate : null;
}

function isDownloadTaskStatus(value: unknown): value is DownloadTaskStatus {
  return (
    value === "queued" ||
    value === "downloading" ||
    value === "paused" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted"
  );
}

function downloadTaskFromRow(row: ParamsObject): DownloadTaskRecord | null {
  const taskId = asString(row.task_id);
  const revision = asNumber(row.revision);
  const resourceId = asString(row.resource_id);
  const status = asString(row.status);
  const progress = asNumber(row.progress);
  const bytesWritten = asNumber(row.bytes_written);
  const totalBytes = asNumber(row.total_bytes);
  const speedBytesPerSecond = asNumber(row.speed_bytes_per_second);
  const etaSeconds = asNumber(row.eta_seconds);
  const createdAt = asString(row.created_at);
  const updatedAt = asString(row.updated_at);
  if (
    !taskId ||
    revision === null ||
    !resourceId ||
    !isDownloadTaskStatus(status) ||
    progress === null ||
    bytesWritten === null ||
    speedBytesPerSecond === null ||
    !createdAt ||
    !updatedAt
  ) {
    return null;
  }
  return {
    taskId,
    revision,
    resourceId,
    status,
    progress,
    bytesWritten,
    totalBytes,
    speedBytesPerSecond,
    etaSeconds,
    tempFilePath: asString(row.temp_file_path),
    errorCode: asString(row.error_code),
    errorMessage: asString(row.error_message),
    resumeEtag: asString(row.resume_etag),
    resumeLastModified: asString(row.resume_last_modified),
    resumeCapable: asNumber(row.resume_capable) === 1,
    resumedFromBytes: asNumber(row.resumed_from_bytes) ?? 0,
    createdAt,
    updatedAt
  };
}

function localArtifactFromRow(row: ParamsObject): LocalArtifactRecord | null {
  const artifactId = asString(row.artifact_id);
  const taskId = asString(row.task_id);
  const planRevision = asNumber(row.plan_revision);
  const fileName = asString(row.file_name);
  const displayPath = asString(row.display_path);
  const sourcePath = asString(row.source_path);
  const bytesWritten = asNumber(row.bytes_written);
  const sha256 = asString(row.sha256);
  const verificationStatus = asString(row.verification_status);
  const importedAt = asString(row.imported_at);
  if (
    !artifactId ||
    !taskId ||
    planRevision === null ||
    !fileName ||
    !displayPath ||
    !sourcePath ||
    bytesWritten === null ||
    !sha256 ||
    !importedAt ||
    (verificationStatus !== "local-verified" &&
      verificationStatus !== "unverified")
  ) {
    return null;
  }
  return {
    artifactId,
    taskId,
    planRevision,
    fileName,
    displayPath,
    sourcePath,
    bytesWritten,
    sha256,
    matchedResourceId: asString(row.matched_resource_id),
    verificationStatus,
    importedAt
  };
}

function agentBRunFromRow(row: ParamsObject): AgentBRunRecord | null {
  const runId = asString(row.run_id);
  const taskId = asString(row.task_id);
  const planRevision = asNumber(row.plan_revision);
  const grantId = asString(row.grant_id);
  const status = asString(row.status);
  const startedAt = asString(row.started_at);
  if (
    !runId ||
    !taskId ||
    planRevision === null ||
    !grantId ||
    !startedAt ||
    (status !== "running" && status !== "completed" && status !== "failed")
  ) {
    return null;
  }
  const answer = parseJson(asString(row.answer_json));
  return {
    runId,
    taskId,
    planRevision,
    manifestRevision: asNumber(row.manifest_revision),
    grantId,
    status,
    toolResult: parseJson(asString(row.tool_result_json)),
    answer: isRecord(answer)
      ? (answer as AgentBInspectionAnswer)
      : null,
    errorMessage: asString(row.error_message),
    startedAt,
    completedAt: asString(row.completed_at)
  };
}

function stateHasErrors(state: PersistedAgentState) {
  return (
    state.resources.some((resource) => resource.status === "failed") ||
    state.logs.some(
      (entry) => isRecord(entry) && entry.level === "error"
    )
  );
}

function taskHistorySummary(
  state: PersistedAgentState,
  updatedAt: string
): TaskHistorySummary {
  return {
    taskId: state.taskId,
    task: state.task,
    phase: state.phase,
    revision: state.revision,
    approvedRevision: state.approvedRevision,
    updatedAt,
    resourceCount: state.resources.length,
    verifiedResourceCount: state.resources.filter(
      (resource) => resource.status === "verified"
    ).length,
    workspaceReady: state.workspace.ready,
    hasErrors: stateHasErrors(state)
  };
}

type SchemaMigration = {
  version: number;
  name: string;
  up(database: Database): void;
};

const schemaMigrations: SchemaMigration[] = [
  {
    version: 1,
    name: "initial-task-persistence",
    up(database) {
      database.run(`
        CREATE TABLE IF NOT EXISTS task_snapshots (
          task_id TEXT PRIMARY KEY,
          phase TEXT NOT NULL,
          revision INTEGER NOT NULL,
          approved_revision INTEGER,
          state_json TEXT NOT NULL,
          tool_results_json TEXT NOT NULL,
          policy_audit_json TEXT NOT NULL,
          recovery_context_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS approval_records (
          task_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          actor TEXT NOT NULL,
          approved_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          status TEXT NOT NULL,
          PRIMARY KEY (task_id, revision)
        );
        CREATE TABLE IF NOT EXISTS workspace_exports (
          task_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          root_path TEXT NOT NULL,
          output_json TEXT NOT NULL,
          exported_at TEXT NOT NULL,
          PRIMARY KEY (task_id, revision)
        );
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 2,
    name: "verified-download-artifacts",
    up(database) {
      database.run(`
        CREATE TABLE IF NOT EXISTS download_artifacts (
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
        CREATE INDEX IF NOT EXISTS download_artifacts_task_revision
          ON download_artifacts (task_id, revision);
      `);
    }
  },
  {
    version: 3,
    name: "p0-resource-orchestration",
    up(database) {
      database.run(`
        CREATE TABLE IF NOT EXISTS download_tasks (
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
        CREATE INDEX IF NOT EXISTS download_tasks_task_status
          ON download_tasks (task_id, status);

        CREATE TABLE IF NOT EXISTS local_artifacts (
          artifact_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          plan_revision INTEGER NOT NULL,
          file_name TEXT NOT NULL,
          display_path TEXT NOT NULL,
          source_path TEXT NOT NULL,
          bytes_written INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          matched_resource_id TEXT,
          verification_status TEXT NOT NULL,
          imported_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS local_artifacts_task
          ON local_artifacts (task_id, plan_revision);

        CREATE TABLE IF NOT EXISTS resource_manifest_snapshots (
          task_id TEXT NOT NULL,
          manifest_revision INTEGER NOT NULL,
          plan_revision INTEGER NOT NULL,
          status TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          root_path TEXT,
          generated_at TEXT NOT NULL,
          PRIMARY KEY (task_id, manifest_revision)
        );
        CREATE INDEX IF NOT EXISTS manifest_snapshots_task_plan
          ON resource_manifest_snapshots (task_id, plan_revision);

        CREATE TABLE IF NOT EXISTS agent_b_runs (
          run_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          plan_revision INTEGER NOT NULL,
          manifest_revision INTEGER,
          grant_id TEXT NOT NULL,
          status TEXT NOT NULL,
          tool_result_json TEXT,
          answer_json TEXT,
          error_message TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS agent_b_runs_task
          ON agent_b_runs (task_id, plan_revision);
      `);
    }
  },
  {
    version: 4,
    name: "p1-supply-chain-resilience",
    up(database) {
      addColumnIfMissing(
        database,
        "approval_records",
        "catalog_version",
        "TEXT NOT NULL DEFAULT 'legacy-unpinned'"
      );
      addColumnIfMissing(
        database,
        "approval_records",
        "catalog_source_sha256",
        "TEXT NOT NULL DEFAULT 'legacy-unpinned'"
      );
      addColumnIfMissing(
        database,
        "download_artifacts",
        "signature_status",
        "TEXT NOT NULL DEFAULT 'pending'"
      );
      addColumnIfMissing(database, "download_artifacts", "expected_publisher", "TEXT");
      addColumnIfMissing(database, "download_artifacts", "actual_publisher", "TEXT");
      addColumnIfMissing(database, "download_artifacts", "certificate_thumbprint", "TEXT");
      addColumnIfMissing(database, "download_artifacts", "signature_message", "TEXT");
      addColumnIfMissing(database, "download_artifacts", "signature_checked_at", "TEXT");
      addColumnIfMissing(database, "download_tasks", "resume_etag", "TEXT");
      addColumnIfMissing(database, "download_tasks", "resume_last_modified", "TEXT");
      addColumnIfMissing(
        database,
        "download_tasks",
        "resume_capable",
        "INTEGER NOT NULL DEFAULT 0"
      );
      addColumnIfMissing(
        database,
        "download_tasks",
        "resumed_from_bytes",
        "INTEGER NOT NULL DEFAULT 0"
      );
      database.run(`
        CREATE TABLE IF NOT EXISTS operation_events (
          event_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          resource_id TEXT,
          event_type TEXT NOT NULL,
          outcome TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS operation_events_task
          ON operation_events (task_id, revision, created_at);

        UPDATE approval_records
        SET status = 'revoked'
        WHERE status = 'active'
          AND catalog_version = 'legacy-unpinned';
      `);
    }
  }
];

function readSchemaVersion(database: Database) {
  const row = firstRow(database, "PRAGMA user_version");
  return row ? asNumber(row.user_version) ?? 0 : 0;
}

function migrateSchema(database: Database, appliedAt: string) {
  const definitionsAreSequential =
    schemaMigrations.length === TASK_STORE_SCHEMA_VERSION &&
    schemaMigrations.every(
      (migration, index) => migration.version === index + 1
    );
  if (!definitionsAreSequential) {
    throw new Error(
      `SQLite task store migrations must define every version from v1 to v${TASK_STORE_SCHEMA_VERSION}.`
    );
  }

  database.run("PRAGMA foreign_keys = ON");
  const fromVersion = readSchemaVersion(database);
  if (fromVersion > TASK_STORE_SCHEMA_VERSION) {
    throw new Error(
      `SQLite task store schema v${fromVersion} is newer than supported v${TASK_STORE_SCHEMA_VERSION}.`
    );
  }

  const appliedVersions: number[] = [];
  for (const migration of schemaMigrations) {
    if (migration.version <= fromVersion) continue;
    database.run("BEGIN IMMEDIATE");
    try {
      migration.up(database);
      database.run(
        `INSERT OR REPLACE INTO schema_migrations (version, name, applied_at)
         VALUES (?, ?, ?)`,
        [migration.version, migration.name, appliedAt]
      );
      database.run(`PRAGMA user_version = ${migration.version}`);
      database.run("COMMIT");
      appliedVersions.push(migration.version);
    } catch (error) {
      database.run("ROLLBACK");
      throw error;
    }
  }

  const toVersion = readSchemaVersion(database);
  if (toVersion !== TASK_STORE_SCHEMA_VERSION) {
    throw new Error(
      `SQLite task store migration stopped at v${toVersion}; expected v${TASK_STORE_SCHEMA_VERSION}.`
    );
  }
  return { fromVersion, toVersion, appliedVersions };
}

export class TaskStore {
  private operationQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly database: Database,
    private readonly options: Required<Omit<TaskStoreOptions, "databasePath">> & {
      databasePath: string;
    }
  ) {}

  static async open(options: TaskStoreOptions) {
    if (!path.isAbsolute(options.databasePath)) {
      throw new Error("SQLite task store path must be absolute.");
    }
    const SQL = await initSqlJs();
    let data: Uint8Array | undefined;
    try {
      data = await readFile(options.databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const database = data ? new SQL.Database(data) : new SQL.Database();
    const resolvedOptions = {
      databasePath: options.databasePath,
      approvalTtlMs: options.approvalTtlMs ?? 30 * 60 * 1000,
      now: options.now ?? Date.now
    };
    try {
      migrateSchema(database, new Date(resolvedOptions.now()).toISOString());
      database.run(
        `UPDATE download_tasks
         SET status = 'interrupted',
             error_code = 'APPLICATION_RESTARTED',
             error_message = '应用重启中断了下载，可重新审批后恢复执行。',
             updated_at = ?
         WHERE status IN ('downloading', 'paused')`,
        [new Date(resolvedOptions.now()).toISOString()]
      );
      database.run(
        `UPDATE approval_records
         SET status = 'revoked'
         WHERE status = 'active'
           AND task_id IN (
             SELECT DISTINCT task_id
             FROM download_tasks
             WHERE status = 'interrupted'
               AND error_code = 'APPLICATION_RESTARTED'
           )`
      );
    } catch (error) {
      database.close();
      throw error;
    }
    const store = new TaskStore(database, resolvedOptions);
    await store.persist();
    return store;
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private insertOperationEvent(
    value: Omit<OperationEventRecord, "eventId"> & { eventId?: string }
  ) {
    const eventId = value.eventId ?? `operation-${randomUUID()}`;
    this.database.run(
      `INSERT INTO operation_events (
        event_id, task_id, revision, resource_id, event_type,
        outcome, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        value.taskId,
        value.revision,
        value.resourceId,
        value.eventType,
        value.outcome,
        JSON.stringify(value.detail),
        value.createdAt
      ]
    );
    return eventId;
  }

  private listOperationEventsFromDatabase(taskId: string) {
    const records: OperationEventRecord[] = [];
    const statement = this.database.prepare(
      `SELECT event_id, task_id, revision, resource_id, event_type,
              outcome, detail_json, created_at
       FROM operation_events
       WHERE task_id = ?
       ORDER BY created_at DESC, event_id DESC`
    );
    try {
      statement.bind([taskId]);
      while (statement.step()) {
        const row = statement.getAsObject();
        const eventId = asString(row.event_id);
        const storedTaskId = asString(row.task_id);
        const revision = asNumber(row.revision);
        const eventType = asString(row.event_type) as
          | OperationEventRecord["eventType"]
          | null;
        const outcome = asString(row.outcome) as
          | OperationEventRecord["outcome"]
          | null;
        const createdAt = asString(row.created_at);
        if (
          !eventId ||
          !storedTaskId ||
          revision === null ||
          !eventType ||
          !outcome ||
          !createdAt
        ) {
          continue;
        }
        records.push({
          eventId,
          taskId: storedTaskId,
          revision,
          resourceId: asString(row.resource_id),
          eventType,
          outcome,
          detail: parseJson(asString(row.detail_json)),
          createdAt
        });
      }
    } finally {
      statement.free();
    }
    return records;
  }

  async recordOperationEvent(
    value: Omit<OperationEventRecord, "eventId">
  ) {
    return this.enqueue(async () => {
      const eventId = this.insertOperationEvent(value);
      await this.persist();
      return eventId;
    });
  }

  async listOperationEvents(taskId: string) {
    return this.enqueue(() =>
      this.listOperationEventsFromDatabase(taskId)
    );
  }

  private async persist() {
    const directory = path.dirname(this.options.databasePath);
    const tempPath = `${this.options.databasePath}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(tempPath, this.database.export(), { flag: "w" });
    await rename(tempPath, this.options.databasePath);
  }

  async saveSnapshot(value: unknown) {
    return this.enqueue(async () => {
      if (!isPersistedAgentState(value)) {
        throw new Error("Refusing to persist an invalid AgentState.");
      }
      const state = value;
      const nowMs = this.options.now();
      const savedAt = new Date(nowMs).toISOString();
      const recoveryContext = {
        activeResourceId: state.activeResourceId,
        replanReason: state.replanReason,
        requestedReplanStrategy: state.requestedReplanStrategy,
        workspaceExportStatus: state.workspace.exportStatus
      };

      this.database.run("BEGIN IMMEDIATE");
      try {
        const previousSnapshot = firstRow(
          this.database,
          `SELECT approved_revision
           FROM task_snapshots
           WHERE task_id = ?`,
          [state.taskId]
        );
        const previousApprovedRevision = previousSnapshot
          ? asNumber(previousSnapshot.approved_revision)
          : null;
        this.database.run(
          `INSERT INTO task_snapshots (
            task_id, phase, revision, approved_revision, state_json,
            tool_results_json, policy_audit_json, recovery_context_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            phase = excluded.phase,
            revision = excluded.revision,
            approved_revision = excluded.approved_revision,
            state_json = excluded.state_json,
            tool_results_json = excluded.tool_results_json,
            policy_audit_json = excluded.policy_audit_json,
            recovery_context_json = excluded.recovery_context_json,
            updated_at = excluded.updated_at`,
          [
            state.taskId,
            state.phase,
            state.revision,
            state.approvedRevision,
            JSON.stringify(state),
            JSON.stringify(state.agentRun.toolResults),
            JSON.stringify(state.agentRun.policyAudit),
            JSON.stringify(recoveryContext),
            savedAt
          ]
        );

        const approvalJustGranted =
          state.approvedRevision === state.revision &&
          state.revision > 0 &&
          previousApprovedRevision !== state.revision;
        if (approvalJustGranted) {
          const expiresAt = new Date(nowMs + this.options.approvalTtlMs).toISOString();
          this.database.run(
            `INSERT INTO approval_records (
              task_id, revision, actor, approved_at, expires_at, status,
              catalog_version, catalog_source_sha256
            ) VALUES (?, ?, 'local-user', ?, ?, 'active', ?, ?)
            ON CONFLICT(task_id, revision) DO UPDATE SET
              actor = excluded.actor,
              approved_at = excluded.approved_at,
              expires_at = excluded.expires_at,
              status = 'active',
              catalog_version = excluded.catalog_version,
              catalog_source_sha256 = excluded.catalog_source_sha256
            WHERE approval_records.status != 'active'
               OR approval_records.expires_at <= excluded.approved_at`,
            [
              state.taskId,
              state.revision,
              savedAt,
              expiresAt,
              trustedCatalogMetadata.catalogVersion,
              trustedCatalogMetadata.sourceSha256
            ]
          );
          this.insertOperationEvent({
            taskId: state.taskId,
            revision: state.revision,
            resourceId: null,
            eventType: "catalog-approval-pinned",
            outcome: "success",
            detail: {
              catalogVersion: trustedCatalogMetadata.catalogVersion,
              sourceSha256: trustedCatalogMetadata.sourceSha256
            },
            createdAt: savedAt
          });
          for (const resource of state.resources) {
            if (
              !resource.selected ||
              (resource.status !== "downloaded" &&
                resource.status !== "verified")
            ) {
              continue;
            }
            const previousArtifact = firstRow(
              this.database,
              `SELECT file_name, source_host, temp_file_path, bytes_written,
                      sha256, expected_sha256, verification_status, verified_at,
                      signature_status, expected_publisher, actual_publisher,
                      certificate_thumbprint, signature_message,
                      signature_checked_at
               FROM download_artifacts
               WHERE task_id = ? AND resource_id = ? AND revision < ?
               ORDER BY revision DESC
               LIMIT 1`,
              [state.taskId, resource.id, state.revision]
            );
            if (!previousArtifact) continue;
            this.database.run(
              `INSERT OR IGNORE INTO download_artifacts (
                task_id, revision, resource_id, file_name, source_host,
                temp_file_path, bytes_written, sha256, expected_sha256,
                verification_status, verified_at, signature_status,
                expected_publisher, actual_publisher, certificate_thumbprint,
                signature_message, signature_checked_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                state.taskId,
                state.revision,
                resource.id,
                asString(previousArtifact.file_name),
                asString(previousArtifact.source_host),
                asString(previousArtifact.temp_file_path),
                asNumber(previousArtifact.bytes_written),
                asString(previousArtifact.sha256),
                asString(previousArtifact.expected_sha256),
                asString(previousArtifact.verification_status),
                asString(previousArtifact.verified_at),
                asString(previousArtifact.signature_status),
                asString(previousArtifact.expected_publisher),
                asString(previousArtifact.actual_publisher),
                asString(previousArtifact.certificate_thumbprint),
                asString(previousArtifact.signature_message),
                asString(previousArtifact.signature_checked_at)
              ]
            );
          }
        } else if (state.approvedRevision === null) {
          this.database.run(
            `UPDATE approval_records
             SET status = 'revoked'
             WHERE task_id = ? AND status = 'active'`,
            [state.taskId]
          );
        }
        this.database.run("COMMIT");
      } catch (error) {
        this.database.run("ROLLBACK");
        throw error;
      }
      await this.persist();
      return { savedAt };
    });
  }

  private approvalRecordFromRow(
    row: ParamsObject,
    fallbackTaskId: string,
    fallbackRevision: number
  ): ApprovalRecord | null {
    const expiresAt = asString(row.expires_at);
    const storedStatus = asString(row.status);
    if (!expiresAt || !storedStatus) return null;
    const expired =
      storedStatus === "active" &&
      Date.parse(expiresAt) <= this.options.now();
    return {
      taskId: asString(row.task_id) ?? fallbackTaskId,
      revision: asNumber(row.revision) ?? fallbackRevision,
      actor: "local-user",
      approvedAt: asString(row.approved_at) ?? "",
      expiresAt,
      status: expired
        ? "expired"
        : storedStatus === "revoked"
          ? "revoked"
          : "active",
      catalogVersion:
        asString(row.catalog_version) ?? "legacy-unpinned",
      catalogSourceSha256:
        asString(row.catalog_source_sha256) ?? "legacy-unpinned"
    };
  }

  private approvalRecord(taskId: string, revision: number): ApprovalRecord | null {
    const row = firstRow(
      this.database,
      `SELECT task_id, revision, actor, approved_at, expires_at, status,
              catalog_version, catalog_source_sha256
       FROM approval_records
       WHERE task_id = ? AND revision = ?`,
      [taskId, revision]
    );
    if (!row) return null;
    return this.approvalRecordFromRow(row, taskId, revision);
  }

  async getApproval(taskId: string, revision: number) {
    return this.enqueue(async () => {
      const record = this.approvalRecord(taskId, revision);
      if (record?.status === "expired") {
        this.database.run(
          `UPDATE approval_records SET status = 'expired'
           WHERE task_id = ? AND revision = ? AND status = 'active'`,
          [taskId, revision]
        );
        await this.persist();
      }
      return record;
    });
  }

  async hasValidApproval(taskId: string, revision: number) {
    const record = await this.getApproval(taskId, revision);
    const catalogPinned =
      record?.catalogVersion === trustedCatalogMetadata.catalogVersion &&
      record.catalogSourceSha256 === trustedCatalogMetadata.sourceSha256;
    return {
      valid: record?.status === "active" && catalogPinned,
      expiresAt: record?.expiresAt ?? null,
      status:
        record?.status === "active" && !catalogPinned
          ? "catalog-mismatch"
          : record?.status ?? "missing",
      catalogVersion: record?.catalogVersion ?? null,
      catalogSourceSha256: record?.catalogSourceSha256 ?? null
    };
  }

  async loadLatestUnfinished(): Promise<RestoredTask | null> {
    return this.enqueue(async () => {
      const placeholders = [...terminalPhases].map(() => "?").join(", ");
      const row = firstRow(
        this.database,
        `SELECT task_id, revision, state_json, updated_at
         FROM task_snapshots
         WHERE phase NOT IN (${placeholders})
         ORDER BY updated_at DESC
         LIMIT 1`,
        [...terminalPhases]
      );
      if (!row) return null;
      const stateJson = asString(row.state_json);
      if (!stateJson) return null;
      const state = parseJson(stateJson);
      if (!isPersistedAgentState(state)) return null;
      const approval = this.approvalRecord(state.taskId, state.revision);
      return {
        state,
        approval: {
          valid: approval?.status === "active",
          expiresAt: approval?.expiresAt ?? null
        },
        savedAt: asString(row.updated_at) ?? ""
      };
    });
  }

  async getTaskState(taskId: string): Promise<PersistedAgentState | null> {
    return this.enqueue(() => {
      const row = firstRow(
        this.database,
        `SELECT state_json FROM task_snapshots WHERE task_id = ?`,
        [taskId]
      );
      const stateJson = row ? asString(row.state_json) : null;
      if (!stateJson) return null;
      const state = parseJson(stateJson);
      return isPersistedAgentState(state) ? state : null;
    });
  }

  async listTaskHistory(limit = 50): Promise<TaskHistorySummary[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Task history limit must be an integer from 1 to 100.");
    }
    return this.enqueue(() => {
      const statement = this.database.prepare(
        `SELECT state_json, updated_at
         FROM task_snapshots
         ORDER BY updated_at DESC
         LIMIT ?`
      );
      const history: TaskHistorySummary[] = [];
      try {
        statement.bind([limit]);
        while (statement.step()) {
          const row = statement.getAsObject();
          const state = parseJson(asString(row.state_json));
          const updatedAt = asString(row.updated_at);
          if (isPersistedAgentState(state) && updatedAt) {
            history.push(taskHistorySummary(state, updatedAt));
          }
        }
      } finally {
        statement.free();
      }
      return history;
    });
  }

  async getTaskHistoryDetail(taskId: string): Promise<TaskHistoryDetail | null> {
    return this.enqueue(() => {
      const snapshotRow = firstRow(
        this.database,
        `SELECT state_json, updated_at
         FROM task_snapshots
         WHERE task_id = ?`,
        [taskId]
      );
      const state = parseJson(
        snapshotRow ? asString(snapshotRow.state_json) : null
      );
      const updatedAt = snapshotRow ? asString(snapshotRow.updated_at) : null;
      if (!isPersistedAgentState(state) || !updatedAt) return null;

      const approvals: ApprovalRecord[] = [];
      const approvalStatement = this.database.prepare(
        `SELECT task_id, revision, actor, approved_at, expires_at, status,
                catalog_version, catalog_source_sha256
         FROM approval_records
         WHERE task_id = ?
         ORDER BY revision DESC`
      );
      try {
        approvalStatement.bind([taskId]);
        while (approvalStatement.step()) {
          const row = approvalStatement.getAsObject();
          const revision = asNumber(row.revision);
          if (revision === null) continue;
          const approval = this.approvalRecordFromRow(row, taskId, revision);
          if (approval) approvals.push(approval);
        }
      } finally {
        approvalStatement.free();
      }

      const workspaceExports: WorkspaceExportOutput[] = [];
      const exportStatement = this.database.prepare(
        `SELECT output_json
         FROM workspace_exports
         WHERE task_id = ?
         ORDER BY revision DESC`
      );
      try {
        exportStatement.bind([taskId]);
        while (exportStatement.step()) {
          const row = exportStatement.getAsObject();
          const output = parseJson(asString(row.output_json));
          if (isWorkspaceExportOutput(output)) workspaceExports.push(output);
        }
      } finally {
        exportStatement.free();
      }

      const downloadArtifacts: DownloadArtifactRecord[] = [];
      const artifactStatement = this.database.prepare(
        `SELECT task_id, revision, resource_id, file_name, source_host,
                temp_file_path, bytes_written, sha256, expected_sha256,
                verification_status, verified_at, signature_status,
                expected_publisher, actual_publisher, certificate_thumbprint,
                signature_message, signature_checked_at
         FROM download_artifacts
         WHERE task_id = ?
         ORDER BY revision DESC, resource_id`
      );
      try {
        artifactStatement.bind([taskId]);
        while (artifactStatement.step()) {
          const artifact = downloadArtifactFromRow(
            artifactStatement.getAsObject()
          );
          if (artifact) downloadArtifacts.push(artifact);
        }
      } finally {
        artifactStatement.free();
      }

      return {
        summary: taskHistorySummary(state, updatedAt),
        state,
        approvals,
        workspaceExports,
        downloadArtifacts,
        operationEvents: this.listOperationEventsFromDatabase(taskId)
      };
    });
  }

  async recordDownloadTask(value: DownloadTaskRecord) {
    return this.enqueue(async () => {
      if (
        !isDownloadTaskStatus(value.status) ||
        !Number.isSafeInteger(value.revision) ||
        value.revision <= 0 ||
        !Number.isFinite(value.progress) ||
        value.progress < 0 ||
        value.progress > 100 ||
        !Number.isSafeInteger(value.bytesWritten) ||
        value.bytesWritten < 0
      ) {
        throw new Error("Refusing to persist an invalid download task.");
      }
      this.database.run(
        `INSERT INTO download_tasks (
          task_id, revision, resource_id, status, progress, bytes_written,
          total_bytes, speed_bytes_per_second, eta_seconds, temp_file_path,
          error_code, error_message, resume_etag, resume_last_modified,
          resume_capable, resumed_from_bytes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, revision, resource_id) DO UPDATE SET
          status = excluded.status,
          progress = excluded.progress,
          bytes_written = excluded.bytes_written,
          total_bytes = excluded.total_bytes,
          speed_bytes_per_second = excluded.speed_bytes_per_second,
          eta_seconds = excluded.eta_seconds,
          temp_file_path = excluded.temp_file_path,
          error_code = excluded.error_code,
          error_message = excluded.error_message,
          resume_etag = excluded.resume_etag,
          resume_last_modified = excluded.resume_last_modified,
          resume_capable = excluded.resume_capable,
          resumed_from_bytes = excluded.resumed_from_bytes,
          updated_at = excluded.updated_at`,
        [
          value.taskId,
          value.revision,
          value.resourceId,
          value.status,
          value.progress,
          value.bytesWritten,
          value.totalBytes,
          value.speedBytesPerSecond,
          value.etaSeconds,
          value.tempFilePath,
          value.errorCode,
          value.errorMessage,
          value.resumeEtag ?? null,
          value.resumeLastModified ?? null,
          value.resumeCapable ? 1 : 0,
          value.resumedFromBytes ?? 0,
          value.createdAt,
          value.updatedAt
        ]
      );
      await this.persist();
    });
  }

  async recordLocalArtifacts(values: LocalArtifactRecord[]) {
    return this.enqueue(async () => {
      this.database.run("BEGIN IMMEDIATE");
      try {
        for (const value of values) {
          if (
            !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.artifactId) ||
            !path.isAbsolute(value.sourcePath) ||
            value.fileName !== path.basename(value.fileName) ||
            !Number.isSafeInteger(value.bytesWritten) ||
            value.bytesWritten < 0 ||
            !/^[a-f0-9]{64}$/i.test(value.sha256)
          ) {
            throw new Error("Refusing to persist an invalid local artifact.");
          }
          this.database.run(
            `INSERT INTO local_artifacts (
              artifact_id, task_id, plan_revision, file_name, display_path,
              source_path, bytes_written, sha256, matched_resource_id,
              verification_status, imported_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(artifact_id) DO UPDATE SET
              task_id = excluded.task_id,
              plan_revision = excluded.plan_revision,
              file_name = excluded.file_name,
              display_path = excluded.display_path,
              source_path = excluded.source_path,
              bytes_written = excluded.bytes_written,
              sha256 = excluded.sha256,
              matched_resource_id = excluded.matched_resource_id,
              verification_status = excluded.verification_status,
              imported_at = excluded.imported_at`,
            [
              value.artifactId,
              value.taskId,
              value.planRevision,
              value.fileName,
              value.displayPath,
              value.sourcePath,
              value.bytesWritten,
              value.sha256.toLowerCase(),
              value.matchedResourceId,
              value.verificationStatus,
              value.importedAt
            ]
          );
        }
        this.database.run("COMMIT");
      } catch (error) {
        this.database.run("ROLLBACK");
        throw error;
      }
      await this.persist();
    });
  }

  async listLocalArtifacts(taskId: string, planRevision?: number) {
    return this.enqueue(() => {
      const records: LocalArtifactRecord[] = [];
      const statement = this.database.prepare(
        planRevision === undefined
          ? `SELECT * FROM local_artifacts
             WHERE task_id = ? ORDER BY imported_at, artifact_id`
          : `SELECT * FROM local_artifacts
             WHERE task_id = ? AND plan_revision = ?
             ORDER BY imported_at, artifact_id`
      );
      try {
        statement.bind(
          planRevision === undefined
            ? [taskId]
            : [taskId, planRevision]
        );
        while (statement.step()) {
          const row = statement.getAsObject();
          const artifactId = asString(row.artifact_id);
          const revision = asNumber(row.plan_revision);
          const fileName = asString(row.file_name);
          const displayPath = asString(row.display_path);
          const sourcePath = asString(row.source_path);
          const bytesWritten = asNumber(row.bytes_written);
          const sha256 = asString(row.sha256);
          const verificationStatus = asString(row.verification_status);
          const importedAt = asString(row.imported_at);
          if (
            !artifactId ||
            revision === null ||
            !fileName ||
            !displayPath ||
            !sourcePath ||
            bytesWritten === null ||
            !sha256 ||
            !importedAt ||
            (verificationStatus !== "local-verified" &&
              verificationStatus !== "unverified")
          ) {
            continue;
          }
          records.push({
            artifactId,
            taskId,
            planRevision: revision,
            fileName,
            displayPath,
            sourcePath,
            bytesWritten,
            sha256,
            matchedResourceId: asString(row.matched_resource_id),
            verificationStatus,
            importedAt
          });
        }
      } finally {
        statement.free();
      }
      return records;
    });
  }

  async updateDownloadTaskProgress(
    value: Pick<
      DownloadTaskRecord,
      | "taskId"
      | "revision"
      | "resourceId"
      | "status"
      | "progress"
      | "bytesWritten"
      | "totalBytes"
      | "speedBytesPerSecond"
      | "etaSeconds"
      | "tempFilePath"
      | "resumeEtag"
      | "resumeLastModified"
      | "resumeCapable"
      | "resumedFromBytes"
      | "updatedAt"
    >
  ) {
    return this.enqueue(async () => {
      if (!isDownloadTaskStatus(value.status)) {
        throw new Error("Download task status is invalid.");
      }
      this.database.run(
        `UPDATE download_tasks
         SET status = ?, progress = ?, bytes_written = ?, total_bytes = ?,
             speed_bytes_per_second = ?, eta_seconds = ?, temp_file_path = ?,
             resume_etag = ?, resume_last_modified = ?, resume_capable = ?,
             resumed_from_bytes = ?, updated_at = ?
         WHERE task_id = ? AND revision = ? AND resource_id = ?`,
        [
          value.status,
          value.progress,
          value.bytesWritten,
          value.totalBytes,
          value.speedBytesPerSecond,
          value.etaSeconds,
          value.tempFilePath,
          value.resumeEtag,
          value.resumeLastModified,
          value.resumeCapable ? 1 : 0,
          value.resumedFromBytes,
          value.updatedAt,
          value.taskId,
          value.revision,
          value.resourceId
        ]
      );
      await this.persist();
    });
  }

  async setDownloadTaskStatus(
    taskId: string,
    revision: number,
    resourceId: string,
    status: DownloadTaskStatus,
    updatedAt: string
  ) {
    return this.enqueue(async () => {
      if (!isDownloadTaskStatus(status)) {
        throw new Error("Download task status is invalid.");
      }
      this.database.run(
        `UPDATE download_tasks SET status = ?, updated_at = ?
         WHERE task_id = ? AND revision = ? AND resource_id = ?`,
        [status, updatedAt, taskId, revision, resourceId]
      );
      await this.persist();
    });
  }

  async completeDownloadTask(value: {
    taskId: string;
    revision: number;
    resourceId: string;
    tempFilePath: string;
    bytesWritten: number;
    updatedAt: string;
  }) {
    return this.enqueue(async () => {
      this.database.run(
        `UPDATE download_tasks
         SET status = 'completed', progress = 100, bytes_written = ?,
             total_bytes = ?, speed_bytes_per_second = 0, eta_seconds = 0,
             temp_file_path = ?, error_code = NULL, error_message = NULL,
             updated_at = ?
         WHERE task_id = ? AND revision = ? AND resource_id = ?`,
        [
          value.bytesWritten,
          value.bytesWritten,
          value.tempFilePath,
          value.updatedAt,
          value.taskId,
          value.revision,
          value.resourceId
        ]
      );
      await this.persist();
    });
  }

  async failDownloadTask(value: {
    taskId: string;
    revision: number;
    resourceId: string;
    status: "failed" | "cancelled";
    errorCode: string;
    errorMessage: string;
    updatedAt: string;
  }) {
    return this.enqueue(async () => {
      this.database.run(
        `UPDATE download_tasks
         SET status = ?, error_code = ?, error_message = ?, updated_at = ?
         WHERE task_id = ? AND revision = ? AND resource_id = ?`,
        [
          value.status,
          value.errorCode,
          value.errorMessage,
          value.updatedAt,
          value.taskId,
          value.revision,
          value.resourceId
        ]
      );
      await this.persist();
    });
  }

  async listDownloadTasks(taskId: string, revision?: number) {
    return this.enqueue(() => {
      const records: DownloadTaskRecord[] = [];
      const statement = this.database.prepare(
        revision === undefined
          ? `SELECT * FROM download_tasks WHERE task_id = ?
             ORDER BY revision DESC, resource_id`
          : `SELECT * FROM download_tasks
             WHERE task_id = ? AND revision = ? ORDER BY resource_id`
      );
      try {
        statement.bind(
          revision === undefined ? [taskId] : [taskId, revision]
        );
        while (statement.step()) {
          const record = downloadTaskFromRow(statement.getAsObject());
          if (record) records.push(record);
        }
      } finally {
        statement.free();
      }
      return records;
    });
  }

  async recordDownloadArtifact(value: DownloadArtifactRecord) {
    return this.enqueue(async () => {
      if (!isDownloadArtifactRecord(value)) {
        throw new Error("Refusing to persist an invalid download artifact.");
      }
      if (
        (value.verificationStatus === "verified" ||
          value.verificationStatus === "local-verified") &&
        value.sha256.toLowerCase() !== value.expectedSha256.toLowerCase()
      ) {
        throw new Error("Verified download artifact SHA256 does not match expected SHA256.");
      }
      this.database.run(
        `INSERT INTO download_artifacts (
          task_id, revision, resource_id, file_name, source_host,
          temp_file_path, bytes_written, sha256, expected_sha256,
          verification_status, verified_at, signature_status,
          expected_publisher, actual_publisher, certificate_thumbprint,
          signature_message, signature_checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, revision, resource_id) DO UPDATE SET
          file_name = excluded.file_name,
          source_host = excluded.source_host,
          temp_file_path = excluded.temp_file_path,
          bytes_written = excluded.bytes_written,
          sha256 = excluded.sha256,
          expected_sha256 = excluded.expected_sha256,
          verification_status = excluded.verification_status,
          verified_at = excluded.verified_at,
          signature_status = excluded.signature_status,
          expected_publisher = excluded.expected_publisher,
          actual_publisher = excluded.actual_publisher,
          certificate_thumbprint = excluded.certificate_thumbprint,
          signature_message = excluded.signature_message,
          signature_checked_at = excluded.signature_checked_at`,
        [
          value.taskId,
          value.revision,
          value.resourceId,
          value.fileName,
          value.sourceHost,
          value.tempFilePath,
          value.bytesWritten,
          value.sha256.toLowerCase(),
          value.expectedSha256.toLowerCase(),
          value.verificationStatus,
          value.verifiedAt,
          value.signatureStatus,
          value.expectedPublisher,
          value.actualPublisher,
          value.certificateThumbprint,
          value.signatureMessage,
          value.signatureCheckedAt
        ]
      );
      await this.persist();
    });
  }

  async listDownloadArtifacts(taskId: string, revision: number) {
    return this.enqueue(() => {
      const artifacts: DownloadArtifactRecord[] = [];
      const statement = this.database.prepare(
        `SELECT task_id, revision, resource_id, file_name, source_host,
                temp_file_path, bytes_written, sha256, expected_sha256,
                verification_status, verified_at, signature_status,
                expected_publisher, actual_publisher, certificate_thumbprint,
                signature_message, signature_checked_at
         FROM download_artifacts
         WHERE task_id = ? AND revision = ?
         ORDER BY resource_id`
      );
      try {
        statement.bind([taskId, revision]);
        while (statement.step()) {
          const artifact = downloadArtifactFromRow(statement.getAsObject());
          if (artifact) artifacts.push(artifact);
        }
      } finally {
        statement.free();
      }
      return artifacts;
    });
  }

  async updateDownloadArtifactVerification(
    taskId: string,
    revision: number,
    resourceId: string,
    verificationStatus: "verified" | "local-verified",
    verifiedAt: string
  ) {
    return this.enqueue(async () => {
      this.database.run(
        `UPDATE download_artifacts
         SET verification_status = ?, verified_at = ?
         WHERE task_id = ? AND revision = ? AND resource_id = ?`,
        [
          verificationStatus,
          verifiedAt,
          taskId,
          revision,
          resourceId
        ]
      );
      await this.persist();
    });
  }

  async updateDownloadArtifactSignature(
    taskId: string,
    revision: number,
    resourceId: string,
    result: {
      status: DownloadArtifactRecord["signatureStatus"];
      expectedPublisher: string | null;
      actualPublisher: string | null;
      certificateThumbprint: string | null;
      message: string | null;
      checkedAt: string;
    }
  ) {
    return this.enqueue(async () => {
      this.database.run(
        `UPDATE download_artifacts
         SET signature_status = ?, expected_publisher = ?,
             actual_publisher = ?, certificate_thumbprint = ?,
             signature_message = ?, signature_checked_at = ?
         WHERE task_id = ? AND revision = ? AND resource_id = ?`,
        [
          result.status,
          result.expectedPublisher,
          result.actualPublisher,
          result.certificateThumbprint,
          result.message,
          result.checkedAt,
          taskId,
          revision,
          resourceId
        ]
      );
      this.insertOperationEvent({
        taskId,
        revision,
        resourceId,
        eventType:
          result.status === "valid"
            ? "signature-verified"
            : result.status === "not-applicable"
              ? "signature-verified"
              : "signature-rejected",
        outcome:
          result.status === "valid" || result.status === "not-applicable"
            ? "success"
            : result.status === "unavailable"
              ? "error"
              : "denied",
        detail: result,
        createdAt: result.checkedAt
      });
      await this.persist();
    });
  }

  async createManifestSnapshotRecord(
    state: PersistedAgentState
  ): Promise<ManifestSnapshotRecord> {
    return this.enqueue(async () => {
      const revisionRow = firstRow(
        this.database,
        `SELECT MAX(manifest_revision) AS manifest_revision
         FROM resource_manifest_snapshots WHERE task_id = ?`,
        [state.taskId]
      );
      const manifestRevision =
        (revisionRow ? asNumber(revisionRow.manifest_revision) : null) ?? 0;
      const nextManifestRevision = manifestRevision + 1;

      const downloadArtifacts: DownloadArtifactRecord[] = [];
      const artifactStatement = this.database.prepare(
        `SELECT task_id, revision, resource_id, file_name, source_host,
                temp_file_path, bytes_written, sha256, expected_sha256,
                verification_status, verified_at, signature_status,
                expected_publisher, actual_publisher, certificate_thumbprint,
                signature_message, signature_checked_at
         FROM download_artifacts
         WHERE task_id = ? AND revision = ?
         ORDER BY resource_id`
      );
      try {
        artifactStatement.bind([state.taskId, state.revision]);
        while (artifactStatement.step()) {
          const artifact = downloadArtifactFromRow(
            artifactStatement.getAsObject()
          );
          if (artifact) downloadArtifacts.push(artifact);
        }
      } finally {
        artifactStatement.free();
      }

      const localArtifacts: LocalArtifactRecord[] = [];
      const localStatement = this.database.prepare(
        `SELECT * FROM local_artifacts
         WHERE task_id = ?
         ORDER BY imported_at, artifact_id`
      );
      try {
        localStatement.bind([state.taskId]);
        while (localStatement.step()) {
          const artifact = localArtifactFromRow(localStatement.getAsObject());
          if (artifact) localArtifacts.push(artifact);
        }
      } finally {
        localStatement.free();
      }

      const generatedAt = new Date(this.options.now()).toISOString();
      const manifest = createManifestSnapshot({
        state: state as AgentState,
        manifestRevision: nextManifestRevision,
        generatedAt,
        downloadArtifacts,
        localArtifacts
      });
      this.database.run(
        `INSERT INTO resource_manifest_snapshots (
          task_id, manifest_revision, plan_revision, status, manifest_json,
          root_path, generated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        [
          state.taskId,
          nextManifestRevision,
          state.revision,
          manifest.status,
          JSON.stringify(manifest),
          generatedAt
        ]
      );
      await this.persist();
      return {
        taskId: state.taskId,
        manifestRevision: nextManifestRevision,
        planRevision: state.revision,
        status: manifest.status,
        manifest,
        rootPath: null,
        generatedAt
      };
    });
  }

  async setManifestSnapshotRoot(
    taskId: string,
    manifestRevision: number,
    rootPath: string
  ) {
    return this.enqueue(async () => {
      if (!path.isAbsolute(rootPath)) {
        throw new Error("Manifest snapshot root must be absolute.");
      }
      this.database.run(
        `UPDATE resource_manifest_snapshots SET root_path = ?
         WHERE task_id = ? AND manifest_revision = ?`,
        [rootPath, taskId, manifestRevision]
      );
      await this.persist();
    });
  }

  async getLatestManifestSnapshot(
    taskId: string,
    planRevision?: number
  ): Promise<ManifestSnapshotRecord | null> {
    return this.enqueue(() => {
      const row = firstRow(
        this.database,
        planRevision === undefined
          ? `SELECT * FROM resource_manifest_snapshots
             WHERE task_id = ?
             ORDER BY manifest_revision DESC LIMIT 1`
          : `SELECT * FROM resource_manifest_snapshots
             WHERE task_id = ? AND plan_revision = ?
             ORDER BY manifest_revision DESC LIMIT 1`,
        planRevision === undefined
          ? [taskId]
          : [taskId, planRevision]
      );
      if (!row) return null;
      const manifestJson = asString(row.manifest_json);
      const manifestRevision = asNumber(row.manifest_revision);
      const storedPlanRevision = asNumber(row.plan_revision);
      const status = asString(row.status);
      const generatedAt = asString(row.generated_at);
      if (
        !manifestJson ||
        manifestRevision === null ||
        storedPlanRevision === null ||
        !generatedAt ||
        (status !== "preparing" &&
          status !== "ready" &&
          status !== "partially_ready" &&
          status !== "failed")
      ) {
        return null;
      }
      const manifest = parseJson(manifestJson) as ResourceManifestSnapshot;
      if (
        !isRecord(manifest) ||
        manifest.schemaVersion !== "xunlei-agent-manifest-3.0"
      ) {
        return null;
      }
      return {
        taskId,
        manifestRevision,
        planRevision: storedPlanRevision,
        status,
        manifest,
        rootPath: asString(row.root_path),
        generatedAt
      };
    });
  }

  async startAgentBRun(value: {
    runId: string;
    taskId: string;
    planRevision: number;
    grantId: string;
    startedAt: string;
  }) {
    return this.enqueue(async () => {
      this.database.run(
        `INSERT INTO agent_b_runs (
          run_id, task_id, plan_revision, manifest_revision, grant_id,
          status, tool_result_json, answer_json, error_message, started_at,
          completed_at
        ) VALUES (?, ?, ?, NULL, ?, 'running', NULL, NULL, NULL, ?, NULL)`,
        [
          value.runId,
          value.taskId,
          value.planRevision,
          value.grantId,
          value.startedAt
        ]
      );
      await this.persist();
    });
  }

  async completeAgentBRun(value: {
    runId: string;
    manifestRevision: number;
    toolResult: unknown;
    answer: unknown;
    completedAt: string;
  }) {
    return this.enqueue(async () => {
      this.database.run(
        `UPDATE agent_b_runs
         SET manifest_revision = ?, status = 'completed',
             tool_result_json = ?, answer_json = ?, error_message = NULL,
             completed_at = ?
         WHERE run_id = ?`,
        [
          value.manifestRevision,
          JSON.stringify(value.toolResult),
          JSON.stringify(value.answer),
          value.completedAt,
          value.runId
        ]
      );
      await this.persist();
    });
  }

  async failAgentBRun(value: {
    runId: string;
    errorMessage: string;
    completedAt: string;
  }) {
    return this.enqueue(async () => {
      this.database.run(
        `UPDATE agent_b_runs
         SET status = 'failed', error_message = ?, completed_at = ?
         WHERE run_id = ?`,
        [value.errorMessage, value.completedAt, value.runId]
      );
      await this.persist();
    });
  }

  async listAgentBRuns(taskId: string, planRevision?: number) {
    return this.enqueue(() => {
      const records: AgentBRunRecord[] = [];
      const statement = this.database.prepare(
        planRevision === undefined
          ? `SELECT * FROM agent_b_runs
             WHERE task_id = ? ORDER BY started_at DESC, run_id`
          : `SELECT * FROM agent_b_runs
             WHERE task_id = ? AND plan_revision = ?
             ORDER BY started_at DESC, run_id`
      );
      try {
        statement.bind(
          planRevision === undefined
            ? [taskId]
            : [taskId, planRevision]
        );
        while (statement.step()) {
          const record = agentBRunFromRow(statement.getAsObject());
          if (record) records.push(record);
        }
      } finally {
        statement.free();
      }
      return records;
    });
  }

  async recordWorkspaceExport(output: WorkspaceExportOutput) {
    return this.enqueue(async () => {
      this.database.run(
        `INSERT INTO workspace_exports (
          task_id, revision, root_path, output_json, exported_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(task_id, revision) DO UPDATE SET
          root_path = excluded.root_path,
          output_json = excluded.output_json,
          exported_at = excluded.exported_at`,
        [
          output.taskId,
          output.revision,
          output.rootPath,
          JSON.stringify(output),
          output.generatedAt
        ]
      );
      await this.persist();
    });
  }

  async getWorkspaceExport(taskId: string, revision: number) {
    return this.enqueue(() => {
      const row = firstRow(
        this.database,
        `SELECT output_json FROM workspace_exports
         WHERE task_id = ? AND revision = ?`,
        [taskId, revision]
      );
      const outputJson = row ? asString(row.output_json) : null;
      return outputJson
        ? (JSON.parse(outputJson) as WorkspaceExportOutput)
        : null;
    });
  }

  async getSchemaInfo(): Promise<TaskStoreSchemaInfo> {
    return this.enqueue(() => {
      const statement = this.database.prepare(
        `SELECT version, name, applied_at
         FROM schema_migrations
         ORDER BY version`
      );
      const migrations: TaskStoreSchemaInfo["migrations"] = [];
      try {
        while (statement.step()) {
          const row = statement.getAsObject();
          const version = asNumber(row.version);
          const name = asString(row.name);
          const appliedAt = asString(row.applied_at);
          if (version !== null && name && appliedAt) {
            migrations.push({ version, name, appliedAt });
          }
        }
      } finally {
        statement.free();
      }
      return {
        version: readSchemaVersion(this.database),
        supportedVersion: TASK_STORE_SCHEMA_VERSION,
        migrations
      };
    });
  }

  async flush() {
    await this.operationQueue;
  }

  async close() {
    await this.flush();
    this.database.close();
  }
}
