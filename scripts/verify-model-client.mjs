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
  XL_AGENT_LLM_PROVIDER: "openai-compatible",
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
    return detail;
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
            index: 0,
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

let baseUrlRequest = "";
const baseUrlClient = new RemoteModelClient(
  {
    ...environment,
    XL_AGENT_LLM_ENDPOINT: "",
    XL_AGENT_LLM_BASE_URL: "https://models.example.test/v1/"
  },
  async (input) => {
    baseUrlRequest = String(input);
    return toolResponse("base-url-test", "finish", {
      summary: "Connection test succeeded.",
      explanation: "Connection test succeeded."
    });
  }
);
await baseUrlClient.testConnection();
assert(
  baseUrlRequest ===
    "https://models.example.test/v1/chat/completions" &&
    baseUrlClient.getSafeConnectionInfo().endpointMode === "base-url",
  "Base URL mode must append the Chat Completions path in Main."
);

let capturedDeepSeekBody = null;
const deepSeekClient = new RemoteModelClient(
  {
    ...environment,
    XL_AGENT_LLM_ENDPOINT:
      "https://api.deepseek.com/chat/completions",
    XL_AGENT_LLM_MODEL: "deepseek-v4-flash"
  },
  async (_input, init) => {
    capturedDeepSeekBody = JSON.parse(String(init?.body ?? "{}"));
    return toolResponse("deepseek-test", "finish", {
      summary: "Connection test succeeded.",
      explanation: "Connection test succeeded."
    });
  }
);
await deepSeekClient.testConnection();
assert(
  capturedDeepSeekBody?.thinking?.type === "disabled",
  "DeepSeek requests must disable thinking mode for required tool calls."
);

const conflictingConfig = new RemoteModelClient({
  ...environment,
  XL_AGENT_LLM_BASE_URL: "https://models.example.test/v1"
});
assert(
  conflictingConfig.getSafeConnectionInfo().error?.code ===
    "MODEL_CONFIGURATION_CONFLICT",
  "Endpoint and Base URL must not be accepted together."
);

const unsupportedProvider = new RemoteModelClient({
  ...environment,
  XL_AGENT_LLM_PROVIDER: "unregistered"
});
assert(
  unsupportedProvider.getSafeConnectionInfo().error?.code ===
    "MODEL_PROVIDER_UNSUPPORTED",
  "Unregistered provider adapters must fail closed."
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

const invalidFormatFailure = new RemoteModelClient(
  environment,
  async () =>
    new Response(
      JSON.stringify({
        error: {
          message:
            `Unsupported request field. ${environment.XL_AGENT_LLM_API_KEY}`
        }
      }),
      {
        status: 400,
        headers: { "content-type": "application/json" }
      }
    )
);
const invalidFormatDetail = await assertRejectCode(
  () => invalidFormatFailure.testConnection(),
  "MODEL_HTTP_ERROR"
);
assert(
  invalidFormatDetail.message.includes("Unsupported request field.") &&
    invalidFormatDetail.message.includes("[redacted]"),
  "Safe provider error details must be exposed without leaking secrets"
);

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
  !("thinking" in capturedTestBody),
  "Provider-specific thinking controls must not be sent to generic endpoints"
);
assert(
  capturedTestBody?.tool_choice === "required" &&
    !("parallel_tool_calls" in capturedTestBody) &&
    capturedTestBody?.tools?.length === 1 &&
    capturedTestBody.tools[0]?.function?.name === "finish",
  "Connection tests must require the only offered finish tool without unsupported parallel controls"
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
    !("parallel_tool_calls" in capturedDecisionBody),
  "Decision requests must require a tool_call without unsupported parallel controls"
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
      !("strict" in tool.function) &&
      tool.function.parameters.additionalProperties === false
  ),
  "Every native function tool must use a provider-compatible closed JSON Schema"
);
const serializedTools = JSON.stringify(capturedDecisionBody.tools);
assert(
  !["minLength", "maxLength", "minItems", "maxItems"].some((keyword) =>
    serializedTools.includes(`"${keyword}"`)
  ),
  "Provider tool schemas must omit strict-mode-only size constraints"
);
assert(
  capturedDecisionBody.messages[0].content.includes("原生 function tools") &&
    capturedDecisionBody.messages[0].content.includes("不得添加额外字段"),
  "The system prompt must instruct native tool calling and strict arguments"
);

console.log(
  "Remote model client passed: compatible native tools/tool_calls, provider/Base URL configuration and safe errors verified"
);
