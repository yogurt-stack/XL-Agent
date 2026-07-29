import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const verifyRoot = mkdtempSync(
  path.join(tmpdir(), "xunlei-p3-verify-")
);
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
if (compilation.status !== 0) {
  process.exit(compilation.status ?? 1);
}

const require = createRequire(import.meta.url);
const {
  TaskStore,
  TASK_STORE_SCHEMA_VERSION
} = require(
  path.join(root, "dist-electron", "electron", "taskStore.js")
);
const {
  createInitialAgentState,
  transition
} = require(
  path.join(
    root,
    "dist-electron",
    "src",
    "features",
    "agent-core",
    "machine.js"
  )
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const databasePath = path.join(verifyRoot, "p3.sqlite");
  const now = Date.parse("2026-07-29T08:00:00.000Z");
  let store = await TaskStore.open({
    databasePath,
    now: () => now
  });
  const submitted = transition(createInitialAgentState(), {
    type: "SUBMIT_TASK",
    task: "P3 Demo reset fixture",
    taskId: "p3-demo-task"
  });
  await store.saveSnapshot(submitted);
  await store.recordOperationEvent({
    taskId: submitted.taskId,
    revision: 1,
    resourceId: null,
    eventType: "catalog-pin-rejected",
    outcome: "denied",
    detail: { fixture: true },
    createdAt: "2026-07-29T08:00:00.000Z"
  });
  assert(
    (await store.listTaskHistory()).length === 1,
    "Reset fixture must persist task history before clearing."
  );

  const reset = await store.resetDemoData();
  assert(
    reset.removedRecords >= 2 &&
      reset.removedByTable.task_snapshots === 1 &&
      reset.removedByTable.operation_events === 1,
    "Demo reset must report the transactionally removed records."
  );
  assert(
    (await store.listTaskHistory()).length === 0 &&
      (await store.listOperationEvents("p3-demo-task")).length === 0,
    "Demo reset must clear task and operation data."
  );
  const maintenance = await store.getLatestMaintenanceEvent();
  assert(
    maintenance?.eventType === "demo-reset" &&
      maintenance.createdAt === reset.resetAt,
    "Demo reset must retain a separate maintenance audit event."
  );
  const schema = await store.getSchemaInfo();
  assert(
    TASK_STORE_SCHEMA_VERSION === 5 &&
      schema.version === 5 &&
      schema.migrations.at(-1)?.name === "p3-demo-operations",
    "P3 must migrate persistence to SQLite v5."
  );
  await store.close();

  store = await TaskStore.open({
    databasePath,
    now: () => now + 1_000
  });
  assert(
    (await store.getLatestMaintenanceEvent())?.eventId ===
      maintenance.eventId,
    "Maintenance reset evidence must survive application restart."
  );
  await store.close();

  console.log(
    "P3 demo distribution passed: SQLite v5 transactional reset and persistent maintenance audit verified"
  );
} finally {
  rmSync(verifyRoot, { force: true, recursive: true });
}
