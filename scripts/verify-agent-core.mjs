import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(tmpdir(), "xunlei-agent-core-verify");
const tscBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const coreFiles = ["types.ts", "catalog.ts", "machine.ts", "interfaces.ts", "agentServices.ts", "mockServices.ts", "localRuleModel.ts", "remoteModel.ts", "runtime.ts", "manifest.ts"].map((file) =>
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
const { AgentRuntime } = require(path.join(outputDir, "runtime.js"));
const { FixedWindowsPlanner, FixedWindowsRouter, MockVerifier } = require(path.join(outputDir, "mockServices.js"));
const { DefaultAgentPolicy, InMemoryAgentToolExecutor } = require(path.join(outputDir, "agentServices.js"));
const { LocalRuleModelRuntime, inferLocalTaskIntent } = require(path.join(outputDir, "localRuleModel.js"));
const { FallbackModelRuntime } = require(path.join(outputDir, "remoteModel.js"));
const { createResourceManifest } = require(path.join(outputDir, "manifest.js"));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const queue = [];
const scheduler = {
  schedule(task) {
    const job = { cancelled: false, task };
    queue.push(job);
    return () => {
      job.cancelled = true;
    };
  }
};

const runtime = new AgentRuntime({
  router: new FixedWindowsRouter(),
  planner: new FixedWindowsPlanner(),
  verifier: new MockVerifier(),
  scheduler,
  tools: new InMemoryAgentToolExecutor(),
  policy: new DefaultAgentPolicy(),
  stepDelayMs: 0
});
let state = runtime.getState();
runtime.subscribe((nextState) => {
  state = nextState;
});
runtime.start();

const send = (event) => runtime.dispatch(event);
const runUntil = async (phase) => {
  for (let step = 0; step < 80 && state.phase !== phase; step += 1) {
    const job = queue.shift();
    assert(job, `Runtime stalled at ${state.phase}`);
    if (!job.cancelled) await job.task();
  }
  assert(state.phase === phase, `Expected ${phase}, received ${state.phase}`);
};

send({ type: "SUBMIT_TASK", task: "准备 Windows AI 环境" });
await runUntil("clarifying");
send({ type: "ANSWER_CLARIFICATION", questionId: "primary-workload", answer: "全栈 AI 应用" });
send({ type: "ANSWER_CLARIFICATION", questionId: "mirror-policy", answer: "允许备用镜像" });
await runUntil("waiting_approval");
assert(state.phase === "waiting_approval" && state.revision === 1, "Initial plan must await approval");

send({ type: "TOGGLE_RESOURCE", resourceId: "python-312", selected: false });
assert(state.phase === "replanning", "Cancelling a required resource must trigger replanning");
await runUntil("waiting_approval");
assert(state.phase === "waiting_approval" && state.revision === 2, "Replacement plan must await approval");
assert(state.resources.some((resource) => resource.id === "miniforge-py312"), "Mirror policy must select the trusted fallback");

send({ type: "APPROVE_PLAN" });
await runUntil("awaiting_failure_action");
assert(state.revision === 2, "A download failure must not create a new revision before user action");
send({ type: "RESOLVE_DOWNLOAD_FAILURE", action: "trusted-mirror" });
await runUntil("waiting_approval");
assert(state.revision === 3, "Injected download failure must create a new approval revision");
assert(state.resources.some((resource) => resource.id === "sample-project-mirror"), "Download failure must select the project mirror");

send({ type: "APPROVE_PLAN" });
await runUntil("verifying");
send({ type: "VERIFY_RESOURCES", versionMismatchResourceId: "sample-project-mirror" });
assert(state.phase === "replanning", "Version mismatch must trigger replanning");
await runUntil("waiting_approval");
assert(state.phase === "waiting_approval" && state.revision === 4, "Version replacement must await approval");

send({ type: "APPROVE_PLAN" });
await runUntil("handoff");
const manifest = createResourceManifest(state);
assert(state.workspace.ready && manifest.revision === 4, "Handoff Manifest revision is invalid");

let primaryOnlyState = createInitialAgentState();
const directSend = (event) => {
  primaryOnlyState = transition(primaryOnlyState, event);
};
directSend({ type: "SUBMIT_TASK", task: "准备 Windows AI 环境" });
directSend({ type: "ROUTE_RESOLVED", route: "windows-ai-development" });
directSend({ type: "ANSWER_CLARIFICATION", questionId: "primary-workload", answer: "Python AI 开发" });
directSend({ type: "SKIP_CLARIFICATION", questionId: "mirror-policy" });
directSend({ type: "PLAN_GENERATED" });
directSend({ type: "TOGGLE_RESOURCE", resourceId: "python-312", selected: false });
directSend({ type: "REPLAN_GENERATED", strategy: "primary-retry" });
assert(
  primaryOnlyState.resources.some((resource) => resource.id === "python-312") &&
    !primaryOnlyState.resources.some((resource) => resource.id === "miniforge-py312"),
  "Primary-only policy must keep the primary source for retry"
);

const localModel = new LocalRuleModelRuntime();
const completedToolResults = [
  {
    callId: "system-profile",
    tool: "read_system_profile",
    status: "success",
    output: { os: "Windows 11", architecture: "x64" },
    startedAt: "mock-start",
    finishedAt: "mock-finish"
  },
  {
    callId: "trusted-catalog",
    tool: "search_trusted_catalog",
    status: "success",
    output: [],
    startedAt: "mock-start",
    finishedAt: "mock-finish"
  }
];
const modelContextFor = (task, answers = {}, toolResults = completedToolResults) => ({
  state: { ...createInitialAgentState(), task, answers, phase: "planning" },
  step: 2,
  maxSteps: 6,
  availableTools: ["read_system_profile", "search_trusted_catalog", "simulate_download"],
  toolResults
});

assert(inferLocalTaskIntent("准备 React 和 Node.js 全栈环境") === "fullstack-ai", "Full-stack intent was not recognized");
assert(inferLocalTaskIntent("准备 Python 机器学习环境") === "python-ai", "Python AI intent was not recognized");
assert(inferLocalTaskIntent("只安装 Git 和 VSCode 开发工具") === "base-development", "Base intent was not recognized");

const fullStackQuestion = await localModel.decide(modelContextFor("准备 React 和 Node.js 全栈环境"));
assert(fullStackQuestion.action.type === "ask_clarification", "Full-stack task must ask a scoped question");
assert(fullStackQuestion.action.questionId === "fullstack-scope", "Full-stack question is incorrect");
const fullStackDecision = await localModel.decide(
  modelContextFor("准备 React 和 Node.js 全栈环境", { "fullstack-scope": "包含可验证示例项目" })
);
assert(fullStackDecision.action.type === "create_plan", "Full-stack task must create a plan");
assert(fullStackDecision.action.resourceIds.includes("node-lts"), "Full-stack plan must include Node.js");

const pythonQuestion = await localModel.decide(modelContextFor("准备 Python 机器学习环境"));
assert(pythonQuestion.action.type === "ask_clarification", "Python AI task must ask a scoped question");
assert(pythonQuestion.action.questionId === "python-scope", "Python question is incorrect");
const pythonDecision = await localModel.decide(
  modelContextFor("准备 Python 机器学习环境", { "python-scope": "仅 Python AI" })
);
assert(pythonDecision.action.type === "create_plan", "Python AI task must create a plan");
assert(!pythonDecision.action.resourceIds.includes("node-lts"), "Python AI plan must not include Node.js by default");

const baseQuestion = await localModel.decide(modelContextFor("只安装 Git 和 VSCode 开发工具"));
assert(baseQuestion.action.type === "ask_clarification", "Base task must ask a scoped question");
assert(baseQuestion.action.questionId === "base-editor", "Base question is incorrect");
const baseDecision = await localModel.decide(
  modelContextFor("只安装 Git 和 VSCode 开发工具", { "base-editor": "包含 VS Code" })
);
assert(baseDecision.action.type === "create_plan", "Base task must create a plan");
assert(baseDecision.action.resourceIds.length === 2, "Base plan must contain only two resources");

const ambiguousDecision = await localModel.decide(modelContextFor("帮我准备开发环境"));
assert(ambiguousDecision.action.type === "ask_clarification", "Ambiguous task must ask one clarification");

const firstDecision = await localModel.decide(modelContextFor("准备 Python AI 环境", {}, []));
assert(
  firstDecision.action.type === "call_tool" && firstDecision.action.call.name === "read_system_profile",
  "First model step must request the system profile tool"
);

const fallbackModel = new FallbackModelRuntime(
  { decide: async () => { throw new Error("remote unavailable"); } },
  localModel
);
const fallbackDecision = await fallbackModel.decide(modelContextFor("准备 Python AI 环境", {}, []));
assert(fallbackDecision.provider === "local-rule", "Remote failure must fall back to the local model");

const modelQueue = [];
const modelScheduler = {
  schedule(task) {
    const job = { cancelled: false, task };
    modelQueue.push(job);
    return () => {
      job.cancelled = true;
    };
  }
};
const modelRuntime = new AgentRuntime({
  router: new FixedWindowsRouter(),
  planner: new FixedWindowsPlanner(),
  verifier: new MockVerifier(),
  scheduler: modelScheduler,
  model: localModel,
  tools: new InMemoryAgentToolExecutor(),
  policy: new DefaultAgentPolicy(),
  stepDelayMs: 0
});
let modelState = modelRuntime.getState();
modelRuntime.subscribe((nextState) => {
  modelState = nextState;
});
modelRuntime.start();

const runModelUntil = async (phase) => {
  for (let step = 0; step < 100 && modelState.phase !== phase; step += 1) {
    const job = modelQueue.shift();
    assert(job, `Model runtime stalled at ${modelState.phase}`);
    if (!job.cancelled) await job.task();
  }
  assert(modelState.phase === phase, `Expected model phase ${phase}, received ${modelState.phase}`);
};

modelRuntime.dispatch({ type: "SUBMIT_TASK", task: "为 React 和 Node.js 准备全栈 AI 环境" });
await runModelUntil("clarifying");
assert(modelState.clarifications[0]?.id === "fullstack-scope", "Runtime must show the full-stack clarification");
modelRuntime.dispatch({
  type: "ANSWER_CLARIFICATION",
  questionId: "fullstack-scope",
  answer: "包含可验证示例项目"
});
await runModelUntil("waiting_approval");
assert(modelState.resources.some((resource) => resource.id === "node-lts"), "Runtime plan must include Node.js");
assert(modelState.agentRun.step === 4, "Known task must produce four model decisions");
assert(modelState.agentRun.toolResults.length === 2, "Runtime must record both read-only tool results");
assert(modelState.agentRun.policyAudit.length === 4, "Runtime must audit every model action");

modelRuntime.dispatch({ type: "APPROVE_PLAN" });
await runModelUntil("awaiting_failure_action");
assert(modelState.revision === 1, "A model must not replan before the user selects a failure action");
assert(
  !modelState.agentRun.decisions.some((decision) => decision.action.type === "create_replan"),
  "The model must pause after a recoverable failure"
);
const retryRequestedState = transition(modelState, {
  type: "RESOLVE_DOWNLOAD_FAILURE",
  action: "primary-retry"
});
assert(
  retryRequestedState.phase === "replanning" && retryRequestedState.requestedReplanStrategy === "primary-retry",
  "Retrying the original source must lock replanning to primary-retry"
);
const retryDecision = await localModel.decide({
  state: retryRequestedState,
  step: retryRequestedState.agentRun.step,
  maxSteps: retryRequestedState.agentRun.maxSteps,
  availableTools: ["read_system_profile", "search_trusted_catalog", "simulate_download"],
  toolResults: retryRequestedState.agentRun.toolResults
});
assert(
  retryDecision.action.type === "create_replan" && retryDecision.action.strategy === "primary-retry",
  "The model must follow the user's primary source retry choice"
);
assert(
  new DefaultAgentPolicy().evaluate(retryDecision.action, retryRequestedState).outcome === "require_approval",
  "A primary source retry plan must still require approval"
);
const retryPlanState = transition(retryRequestedState, {
  type: "MODEL_REPLAN_PROPOSED",
  strategy: "primary-retry",
  explanation: "Retry the approved primary source."
});
assert(
  retryPlanState.phase === "waiting_approval" &&
    retryPlanState.revision === 2 &&
    retryPlanState.resources.some((resource) => resource.id === "sample-project"),
  "A primary source retry must keep the original resource and create a new approval revision"
);
const delegatedState = transition(modelState, {
  type: "RESOLVE_DOWNLOAD_FAILURE",
  action: "delegate-agent-b"
});
assert(
  delegatedState.phase === "handoff" &&
    delegatedState.agentRun.status === "delegated" &&
    !delegatedState.workspace.ready,
  "Agent B delegation must preserve an incomplete handoff"
);
modelRuntime.dispatch({ type: "RESOLVE_DOWNLOAD_FAILURE", action: "trusted-mirror" });
await runModelUntil("waiting_approval");
assert(modelState.revision === 2, "Download failure must still create a second approval revision");
assert(
  modelState.agentRun.decisions.some((decision) => decision.action.type === "create_replan"),
  "The model must create the replacement plan after a download failure"
);
const modelReplanDecision = modelState.agentRun.decisions.find(
  (decision) => decision.action.type === "create_replan"
);
assert(
  modelReplanDecision &&
    modelState.agentRun.policyAudit.some(
      (entry) =>
        entry.actionId === modelReplanDecision.action.actionId &&
        entry.decision.outcome === "require_approval"
    ),
  "A model replacement plan must require a new user approval"
);
assert(
  modelState.resources.some((resource) => resource.id === "sample-project-mirror"),
  "The model replacement plan must use the trusted project fallback"
);
assert(
  modelState.agentRun.toolResults.some((result) => result.tool === "simulate_download"),
  "Downloads must execute through the Agent Tool interface"
);
assert(
  modelState.agentRun.toolResults.some(
    (result) => result.tool === "simulate_download" && result.error?.code === "CHECKSUM_MISMATCH"
  ),
  "The simulated checksum failure must be returned as a retriable tool error"
);
assert(
  modelState.agentRun.toolResults.filter((result) => result.tool === "simulate_download").length ===
    modelState.agentRun.policyAudit.filter((entry) => entry.actionId.startsWith("runtime-download-r1")).length,
  "Every controlled download tool call must pass through policy evaluation"
);
modelRuntime.dispatch({ type: "APPROVE_PLAN" });
await runModelUntil("handoff");
assert(modelState.workspace.ready, "Model-driven runtime must reach workspace handoff");

const ambiguousQueue = [];
const ambiguousRuntime = new AgentRuntime({
  router: new FixedWindowsRouter(),
  planner: new FixedWindowsPlanner(),
  verifier: new MockVerifier(),
  scheduler: {
    schedule(task) {
      const job = { cancelled: false, task };
      ambiguousQueue.push(job);
      return () => {
        job.cancelled = true;
      };
    }
  },
  model: localModel,
  tools: new InMemoryAgentToolExecutor(),
  policy: new DefaultAgentPolicy(),
  stepDelayMs: 0
});
let ambiguousState = ambiguousRuntime.getState();
ambiguousRuntime.subscribe((nextState) => {
  ambiguousState = nextState;
});
ambiguousRuntime.start();
const runAmbiguousUntil = async (phase) => {
  for (let step = 0; step < 30 && ambiguousState.phase !== phase; step += 1) {
    const job = ambiguousQueue.shift();
    assert(job, `Ambiguous runtime stalled at ${ambiguousState.phase}`);
    if (!job.cancelled) await job.task();
  }
  assert(ambiguousState.phase === phase, `Expected ambiguous phase ${phase}, received ${ambiguousState.phase}`);
};

ambiguousRuntime.dispatch({ type: "SUBMIT_TASK", task: "帮我准备开发环境" });
await runAmbiguousUntil("clarifying");
assert(ambiguousState.clarifications[0]?.id === "primary-workload", "Generic task must ask its workload first");
ambiguousRuntime.dispatch({
  type: "ANSWER_CLARIFICATION",
  questionId: "primary-workload",
  answer: "Python AI 开发"
});
await runAmbiguousUntil("clarifying");
assert(ambiguousState.clarifications[0]?.id === "python-scope", "Python intent must ask its scoped question");
ambiguousRuntime.dispatch({
  type: "ANSWER_CLARIFICATION",
  questionId: "python-scope",
  answer: "仅 Python AI"
});
await runAmbiguousUntil("waiting_approval");
assert(ambiguousState.agentRun.step === 5, "Ambiguous task must finish planning within five model steps");

const limitState = createInitialAgentState();
const limitRuntime = new AgentRuntime({
  router: new FixedWindowsRouter(),
  planner: new FixedWindowsPlanner(),
  verifier: new MockVerifier(),
  scheduler: modelScheduler,
  model: localModel,
  tools: new InMemoryAgentToolExecutor(),
  policy: new DefaultAgentPolicy(),
  initialState: {
    ...limitState,
    phase: "routing",
    task: "准备 Python AI 环境",
    agentRun: { ...limitState.agentRun, step: 6, status: "thinking" }
  },
  stepDelayMs: 0
});
limitRuntime.start();
assert(limitRuntime.getState().phase === "cancelled", "Runtime must stop when the six-step limit is reached");

console.log(`Agent Core scenario passed: revision=${manifest.revision}, phase=${state.phase}`);
