import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
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
  RemoteModelClient,
  resolveRemoteModelConfig
} = require(
  path.join(root, "dist-electron", "electron", "modelClient.js")
);
const {
  createDefaultDomainSkillRegistry
} = require(
  path.join(
    root,
    "dist-electron",
    "src",
    "features",
    "agent-core",
    "domainSkills.js"
  )
);
const {
  createDefaultWorkspaceTemplateRegistry
} = require(
  path.join(
    root,
    "dist-electron",
    "src",
    "features",
    "agent-core",
    "workspaceTemplates.js"
  )
);
const {
  ExtensibleAgentRouter
} = require(
  path.join(
    root,
    "dist-electron",
    "src",
    "features",
    "agent-core",
    "router.js"
  )
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
const {
  resourceIdsForCapabilities
} = require(
  path.join(
    root,
    "dist-electron",
    "src",
    "features",
    "agent-core",
    "taskRequirements.js"
  )
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const baseConfig = {
  XL_AGENT_LLM_PROVIDER: "openai-compatible",
  XL_AGENT_LLM_BASE_URL: "https://models.example.test/v1/",
  XL_AGENT_LLM_API_KEY: "p2-secret",
  XL_AGENT_LLM_MODEL: "p2-model"
};
const resolved = resolveRemoteModelConfig(baseConfig);
assert(
  resolved.endpoint ===
    "https://models.example.test/v1/chat/completions" &&
    resolved.endpointMode === "base-url" &&
    resolved.providerId === "openai-compatible",
  "Base URL must resolve to the registered Chat Completions adapter."
);

const conflicting = new RemoteModelClient({
  ...baseConfig,
  XL_AGENT_LLM_ENDPOINT:
    "https://models.example.test/custom/chat/completions"
}).getSafeConnectionInfo();
assert(
  !conflicting.configured &&
    conflicting.error?.code === "MODEL_CONFIGURATION_CONFLICT",
  "Endpoint and Base URL must fail closed when both are configured."
);
const unsupported = new RemoteModelClient({
  ...baseConfig,
  XL_AGENT_LLM_PROVIDER: "unregistered-provider"
}).getSafeConnectionInfo();
assert(
  !unsupported.configured &&
    unsupported.error?.code === "MODEL_PROVIDER_UNSUPPORTED",
  "Unknown provider adapters must fail closed."
);

const skills = createDefaultDomainSkillRegistry();
const templates = createDefaultWorkspaceTemplateRegistry();
assert(
  skills.list().map((skill) => skill.id).includes(
    "research-data-environment"
  ),
  "The second production Domain Skill must be registered."
);
assert(
  templates.resolve("research-data-environment")?.id ===
    "research-data-workspace",
  "The research Domain Skill must resolve a dedicated workspace template."
);

const router = new ExtensibleAgentRouter();
const submitted = transition(createInitialAgentState(), {
  type: "SUBMIT_TASK",
  task: "准备一个科研数据分析工作区",
  taskId: "p2-research-task"
});
const route = router.route(submitted);
assert(
  route?.decision.skillId === "research-data-environment" &&
    route.decision.status === "supported",
  "Research goals must route through the installed second Domain Skill."
);
const clarifying = transition(submitted, route);
const planning = transition(clarifying, {
  type: "ANSWER_CLARIFICATION",
  questionId: "research-template",
  answer: "只准备科研基础工具"
});
const requirements = router.resolveRequirements(planning);
assert(
  requirements?.intent === "skill:research-data-environment" &&
    JSON.stringify(requirements.requiredCapabilities) ===
      JSON.stringify([
        "python-runtime",
        "code-editor",
        "source-control"
      ]),
  "The second Domain Skill must own its deterministic capability requirements."
);
const resources = resourceIdsForCapabilities(
  requirements.requiredCapabilities
);
assert(
  resources.includes("python-312") &&
    resources.includes("vscode") &&
    resources.includes("git"),
  "The local fallback must map extension capabilities to trusted resources."
);

console.log(
  "P2 platform extensibility passed: model Base URL/provider policy, second Domain Skill, capability planning and workspace template verified"
);
