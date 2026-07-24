import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import initSqlJs = require("sql.js/dist/sql-asm.js");
import type { Database, ParamsObject, SqlValue } from "sql.js";
import type {
  WorkspaceExportOutput,
  WorkspaceSnapshot
} from "./workspaceExporter";

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

export type TaskStoreOptions = {
  databasePath: string;
  approvalTtlMs?: number;
  now?: () => number;
};

const terminalPhases = new Set(["intake", "handoff", "cancelled"]);

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
    database.run(`
      PRAGMA foreign_keys = ON;
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
    `);
    const store = new TaskStore(database, {
      databasePath: options.databasePath,
      approvalTtlMs: options.approvalTtlMs ?? 30 * 60 * 1000,
      now: options.now ?? Date.now
    });
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

  private approvalRecord(taskId: string, revision: number): ApprovalRecord | null {
    const row = firstRow(
      this.database,
      `SELECT task_id, revision, actor, approved_at, expires_at, status
       FROM approval_records
       WHERE task_id = ? AND revision = ?`,
      [taskId, revision]
    );
    if (!row) return null;
    const expiresAt = asString(row.expires_at);
    const storedStatus = asString(row.status);
    if (!expiresAt || !storedStatus) return null;
    const expired =
      storedStatus === "active" &&
      Date.parse(expiresAt) <= this.options.now();
    return {
      taskId: asString(row.task_id) ?? taskId,
      revision: asNumber(row.revision) ?? revision,
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
      const state = JSON.parse(stateJson) as unknown;
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
      const state = JSON.parse(stateJson) as unknown;
      return isPersistedAgentState(state) ? state : null;
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

  async flush() {
    await this.operationQueue;
  }

  async close() {
    await this.flush();
    this.database.close();
  }
}
