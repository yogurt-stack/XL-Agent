import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const { RemoteModelClient, toModelConnectionError } = require(
  path.join(root, "dist-electron", "electron", "modelClient.js")
);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const environment = {
  XL_AGENT_LLM_ENDPOINT: "https://models.example.test/v1/chat/completions",
  XL_AGENT_LLM_API_KEY: "test-secret-that-must-not-leak",
  XL_AGENT_LLM_MODEL: "test-model"
};
const assertRejectCode = async (task, expectedCode) => {
  try {
    await task();
  } catch (error) {
    const detail = toModelConnectionError(error);
    assert(
      detail.code === expectedCode,
      `Expected ${expectedCode}, received ${detail.code}`
    );
    assert(
      !JSON.stringify(detail).includes(environment.XL_AGENT_LLM_API_KEY),
      "Structured errors must not expose the API key"
    );
    return;
  }
  throw new Error(`Expected ${expectedCode}, but the request succeeded`);
};

const toolResponse = (id, name, args) =>
  new Response(
    JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id,
            type: "function",
            function: {
              name,
              arguments: typeof args === "string" ? args : JSON.stringify(args)
            }
          }]
        }
      }]
    }),
    { status: 200 }
  );

const missingConfig = new RemoteModelClient({}, async () => new Response());
const missingInfo = missingConfig.getSafeConnectionInfo();
assert(
  !missingInfo.configured && missingInfo.error?.code === "MODEL_UNCONFIGURED",
  "Missing configuration must be reported safely"
);

const invalidEndpoint = new RemoteModelClient(
  { ...environment, XL_AGENT_LLM_ENDPOINT: "http://models.example.test" },
  async () => new Response()
);
assert(
  invalidEndpoint.getSafeConnectionInfo().error?.code === "MODEL_ENDPOINT_INVALID",
  "Non-HTTPS endpoints must be rejected"
);

const malformedEndpoint = new RemoteModelClient(
  { ...environment, XL_AGENT_LLM_ENDPOINT: "not-a-url" },
  async () => new Response()
);
assert(
  malformedEndpoint.getSafeConnectionInfo().error?.code === "MODEL_ENDPOINT_INVALID",
  "Malformed endpoints must be rejected as configuration errors"
);

const authFailure = new RemoteModelClient(
  environment,
  async () => new Response("", { status: 401 })
);
await assertRejectCode(() => authFailure.testConnection(), "MODEL_AUTH_FAILED");

const timeoutFailure = new RemoteModelClient(environment, async () => {
  const error = new Error("internal timeout detail");
  error.name = "TimeoutError";
  throw error;
});
await assertRejectCode(() => timeoutFailure.testConnection(), "MODEL_TIMEOUT");

const invalidResponse = new RemoteModelClient(
  environment,
  async () => new Response("not-json", { status: 200 })
);
await assertRejectCode(
  () => invalidResponse.testConnection(),
  "MODEL_INVALID_RESPONSE"
);

const contentOnlyResponse = new RemoteModelClient(
  environment,
  async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "{\"action\":\"finish\"}" } }]
      }),
      { status: 200 }
    )
);
await assertRejectCode(
  () => contentOnlyResponse.testConnection(),
  "MODEL_INVALID_RESPONSE"
);

const invalidToolArguments = new RemoteModelClient(
  environment,
  async () => toolResponse("bad-json", "finish", "not-json")
);
await assertRejectCode(
  () => invalidToolArguments.testConnection(),
  "MODEL_INVALID_JSON"
);

const invalidToolDecision = new RemoteModelClient(
  environment,
  async () =>
    toolResponse("bad-finish", "finish", {
      summary: "Connection test succeeded.",
      explanation: "valid",
      extra: "strict schema must reject this"
    })
);
await assertRejectCode(
  () => invalidToolDecision.testConnection(),
  "MODEL_INVALID_DECISION"
);

let capturedAuthorization = "";
let capturedTestBody = null;
const successfulClient = new RemoteModelClient(environment, async (_input, init) => {
  capturedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
  capturedTestBody = JSON.parse(String(init?.body ?? "{}"));
  return toolResponse("connection-test", "finish", {
    summary: "Connection test succeeded.",
    explanation: "Connection test succeeded."
  });
});
const decision = await successfulClient.testConnection();
assert(
  decision.model === environment.XL_AGENT_LLM_MODEL,
  "Successful responses must use the configured model ID"
);
assert(
  decision.action.type === "finish",
  "Connection test must parse a native finish tool_call"
);
assert(
  capturedAuthorization === `Bearer ${environment.XL_AGENT_LLM_API_KEY}`,
  "The API key must only be sent in the main-process Authorization header"
);
assert(
  !JSON.stringify(decision).includes(environment.XL_AGENT_LLM_API_KEY),
  "Successful IPC payloads must not expose the API key"
);
assert(
  !("response_format" in capturedTestBody),
  "Native tool calling must not depend on JSON response_format"
);
assert(
  capturedTestBody?.tool_choice?.function?.name === "finish" &&
    capturedTestBody?.parallel_tool_calls === false &&
    capturedTestBody?.tools?.length === 1,
  "Connection tests must force exactly one native finish tool"
);

let capturedDecisionBody = null;
const decisionClient = new RemoteModelClient(environment, async (_input, init) => {
  capturedDecisionBody = JSON.parse(String(init?.body ?? "{}"));
  return toolResponse("remote-profile", "read_system_profile", {
    purpose: "读取系统画像。",
    explanation: "规划前需要经过隐私裁剪的系统画像。"
  });
});
const remoteDecision = await decisionClient.requestDecision({
  state: { phase: "planning" },
  step: 0,
  maxSteps: 6,
  availableTools: [
    "read_system_profile",
    "search_trusted_catalog",
    "controlled_download",
    "export_workspace"
  ],
  toolResults: []
});
assert(
  remoteDecision.action.type === "call_tool" &&
    remoteDecision.action.call.name === "read_system_profile",
  "Native runtime tool_calls must map to call_tool ModelDecision actions"
);
const offeredToolNames = capturedDecisionBody.tools.map(
  (tool) => tool.function.name
);
assert(
  capturedDecisionBody.tool_choice === "required" &&
    capturedDecisionBody.parallel_tool_calls === false,
  "Decision requests must require exactly one non-parallel native tool_call"
);
assert(
  offeredToolNames.includes("create_plan") &&
    offeredToolNames.includes("controlled_download") &&
    !offeredToolNames.includes("simulate_download"),
  "Decision requests must expose action functions plus only context-available runtime tools"
);
assert(
  capturedDecisionBody.tools.every(
    (tool) =>
      tool.type === "function" &&
      tool.function.strict === true &&
      tool.function.parameters.additionalProperties === false
  ),
  "Every native function tool must use a strict closed JSON Schema"
);
assert(
  capturedDecisionBody.messages[0].content.includes("原生 function tools") &&
    capturedDecisionBody.messages[0].content.includes("不得添加额外字段"),
  "The system prompt must instruct native tool calling and strict arguments"
);

console.log(
  "Remote model client passed: native tools/tool_calls, strict schemas, configuration and safe errors verified"
);
