import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import initSqlJs = require("sql.js/dist/sql-asm.js");
import type { Database, ParamsObject, SqlValue } from "sql.js";
import type {
  WorkspaceExportOutput,
  WorkspaceSnapshot
} from "./workspaceExporter";
import type { DownloadArtifactRecord } from "./downloadArtifacts";

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
};

export type TaskStoreOptions = {
  databasePath: string;
  approvalTtlMs?: number;
  now?: () => number;
};

export const TASK_STORE_SCHEMA_VERSION = 2;

export type TaskStoreSchemaInfo = {
  version: number;
  supportedVersion: number;
  migrations: Array<{
    version: number;
    name: string;
    appliedAt: string;
  }>;
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
    (value.verificationStatus === "verified" ||
      value.verificationStatus === "test-fixture") &&
    typeof value.verifiedAt === "string" &&
    Number.isFinite(Date.parse(value.verifiedAt))
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
    verifiedAt: asString(row.verified_at)
  };
  return isDownloadArtifactRecord(candidate) ? candidate : null;
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
              task_id, revision, actor, approved_at, expires_at, status
            ) VALUES (?, ?, 'local-user', ?, ?, 'active')
            ON CONFLICT(task_id, revision) DO UPDATE SET
              actor = excluded.actor,
              approved_at = excluded.approved_at,
              expires_at = excluded.expires_at,
              status = 'active'
            WHERE approval_records.status != 'active'
               OR approval_records.expires_at <= excluded.approved_at`,
            [state.taskId, state.revision, savedAt, expiresAt]
          );
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
                      sha256, expected_sha256, verification_status, verified_at
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
                verification_status, verified_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                asString(previousArtifact.verified_at)
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
          : "active"
    };
  }

  private approvalRecord(taskId: string, revision: number): ApprovalRecord | null {
    const row = firstRow(
      this.database,
      `SELECT task_id, revision, actor, approved_at, expires_at, status
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
    return {
      valid: record?.status === "active",
      expiresAt: record?.expiresAt ?? null,
      status: record?.status ?? "missing"
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
        `SELECT task_id, revision, actor, approved_at, expires_at, status
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
                verification_status, verified_at
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
        downloadArtifacts
      };
    });
  }

  async recordDownloadArtifact(value: DownloadArtifactRecord) {
    return this.enqueue(async () => {
      if (!isDownloadArtifactRecord(value)) {
        throw new Error("Refusing to persist an invalid download artifact.");
      }
      if (
        value.verificationStatus === "verified" &&
        value.sha256.toLowerCase() !== value.expectedSha256.toLowerCase()
      ) {
        throw new Error("Verified download artifact SHA256 does not match expected SHA256.");
      }
      this.database.run(
        `INSERT INTO download_artifacts (
          task_id, revision, resource_id, file_name, source_host,
          temp_file_path, bytes_written, sha256, expected_sha256,
          verification_status, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, revision, resource_id) DO UPDATE SET
          file_name = excluded.file_name,
          source_host = excluded.source_host,
          temp_file_path = excluded.temp_file_path,
          bytes_written = excluded.bytes_written,
          sha256 = excluded.sha256,
          expected_sha256 = excluded.expected_sha256,
          verification_status = excluded.verification_status,
          verified_at = excluded.verified_at`,
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
          value.verifiedAt
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
                verification_status, verified_at
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
