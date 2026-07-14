import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(tmpdir(), "xunlei-model-client-verify");
const tscBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

rmSync(outputDir, { force: true, recursive: true });
const compilation = spawnSync(
  tscBin,
  [
    "--target", "ES2020",
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--skipLibCheck",
    "--types", "node",
    "--outDir", outputDir,
    path.join("electron", "modelClient.ts")
  ],
  { cwd: root, stdio: "inherit" }
);
if (compilation.status !== 0) process.exit(compilation.status ?? 1);

const require = createRequire(import.meta.url);
const { RemoteModelClient, toModelConnectionError } = require(path.join(outputDir, "modelClient.js"));

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
    assert(detail.code === expectedCode, `Expected ${expectedCode}, received ${detail.code}`);
    assert(!JSON.stringify(detail).includes(environment.XL_AGENT_LLM_API_KEY), "Structured errors must not expose the API key");
    return;
  }
  throw new Error(`Expected ${expectedCode}, but the request succeeded`);
};

const missingConfig = new RemoteModelClient({}, async () => new Response());
const missingInfo = missingConfig.getSafeConnectionInfo();
assert(!missingInfo.configured && missingInfo.error?.code === "MODEL_UNCONFIGURED", "Missing configuration must be reported safely");

const invalidEndpoint = new RemoteModelClient({ ...environment, XL_AGENT_LLM_ENDPOINT: "http://models.example.test" }, async () => new Response());
assert(invalidEndpoint.getSafeConnectionInfo().error?.code === "MODEL_ENDPOINT_INVALID", "Non-HTTPS endpoints must be rejected");

const malformedEndpoint = new RemoteModelClient({ ...environment, XL_AGENT_LLM_ENDPOINT: "not-a-url" }, async () => new Response());
assert(malformedEndpoint.getSafeConnectionInfo().error?.code === "MODEL_ENDPOINT_INVALID", "Malformed endpoints must be rejected as configuration errors");

const authFailure = new RemoteModelClient(environment, async () => new Response("", { status: 401 }));
await assertRejectCode(() => authFailure.testConnection(), "MODEL_AUTH_FAILED");

const timeoutFailure = new RemoteModelClient(environment, async () => {
  const error = new Error("internal timeout detail");
  error.name = "TimeoutError";
  throw error;
});
await assertRejectCode(() => timeoutFailure.testConnection(), "MODEL_TIMEOUT");

const invalidResponse = new RemoteModelClient(environment, async () => new Response("not-json", { status: 200 }));
await assertRejectCode(() => invalidResponse.testConnection(), "MODEL_INVALID_RESPONSE");

const invalidDecisionJson = new RemoteModelClient(
  environment,
  async () => new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), { status: 200 })
);
await assertRejectCode(() => invalidDecisionJson.testConnection(), "MODEL_INVALID_JSON");

let capturedAuthorization = "";
const successfulClient = new RemoteModelClient(environment, async (_input, init) => {
  capturedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
  return new Response(
    JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            decisionId: "connection-test",
            explanation: "Connection test succeeded.",
            action: { actionId: "connection-test", type: "finish", summary: "Connection test succeeded." }
          })
        }
      }]
    }),
    { status: 200 }
  );
});
const decision = await successfulClient.testConnection();
assert(decision.model === environment.XL_AGENT_LLM_MODEL, "Successful responses must use the configured model ID");
assert(capturedAuthorization === `Bearer ${environment.XL_AGENT_LLM_API_KEY}`, "The API key must only be sent in the main-process Authorization header");
assert(!JSON.stringify(decision).includes(environment.XL_AGENT_LLM_API_KEY), "Successful IPC payloads must not expose the API key");

console.log("Remote model client passed: configuration, auth, timeout, response and success cases verified");
