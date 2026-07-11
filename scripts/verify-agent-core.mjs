import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(tmpdir(), "xunlei-agent-core-verify");
const tscBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const coreFiles = ["types.ts", "catalog.ts", "machine.ts", "mockRunner.ts", "manifest.ts"].map((file) =>
  path.join("src", "features", "agent-core", file)
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
    "--outDir",
    outputDir,
    ...coreFiles
  ],
  { cwd: root, stdio: "inherit" }
);

if (compilation.status !== 0) {
  process.exit(compilation.status ?? 1);
}

const require = createRequire(import.meta.url);
const { createInitialAgentState, transition } = require(path.join(outputDir, "machine.js"));
const { getNextMockEvent } = require(path.join(outputDir, "mockRunner.js"));
const { createResourceManifest } = require(path.join(outputDir, "manifest.js"));

let state = createInitialAgentState();
const send = (event) => {
  state = transition(state, event);
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const runUntil = (phase) => {
  for (let step = 0; step < 80 && state.phase !== phase; step += 1) {
    const event = getNextMockEvent(state);
    assert(event, `Mock runner stalled at ${state.phase}`);
    send(event);
  }
  assert(state.phase === phase, `Expected ${phase}, received ${state.phase}`);
};

send({ type: "SUBMIT_TASK", task: "准备 Windows AI 环境" });
send({ type: "ROUTE_RESOLVED" });
send({ type: "ANSWER_CLARIFICATION", questionId: "primary-workload", answer: "全栈 AI 应用" });
send({ type: "SKIP_CLARIFICATION", questionId: "mirror-policy" });
send({ type: "PLAN_GENERATED" });
assert(state.phase === "waiting_approval" && state.revision === 1, "Initial plan must await approval");

send({ type: "TOGGLE_RESOURCE", resourceId: "python-312", selected: false });
assert(state.phase === "replanning", "Cancelling a required resource must trigger replanning");
send({ type: "REPLAN_GENERATED" });
assert(state.phase === "waiting_approval" && state.revision === 2, "Replacement plan must await approval");

send({ type: "APPROVE_PLAN" });
runUntil("waiting_approval");
assert(state.revision === 3, "Injected download failure must create a new approval revision");

send({ type: "APPROVE_PLAN" });
runUntil("verifying");
send({ type: "VERIFY_RESOURCES", versionMismatchResourceId: "sample-project-mirror" });
assert(state.phase === "replanning", "Version mismatch must trigger replanning");
send({ type: "REPLAN_GENERATED" });
assert(state.phase === "waiting_approval" && state.revision === 4, "Version replacement must await approval");

send({ type: "APPROVE_PLAN" });
runUntil("handoff");
const manifest = createResourceManifest(state);
assert(state.workspace.ready && manifest.revision === 4, "Handoff Manifest revision is invalid");

console.log(`Agent Core scenario passed: revision=${manifest.revision}, phase=${state.phase}`);
