import { z } from "zod";
import { taskPlanProposalSchema } from "./taskPlan";
import type {
  AgentAction,
  AgentToolCall,
  AgentUserEvent,
  ModelDecision
} from "./types";

const resourceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/i);
const identifierSchema = z.string().trim().min(1).max(160);
const descriptionSchema = z.string().trim().min(1).max(4000);
const taskIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/i);
const localRepositoryHandleSchema = z.string().regex(
  /^local-repo-[a-z0-9-]{1,120}$/i
);
const githubRepositoryHandleSchema = z.string().regex(
  /^github-repo-[a-z0-9-]{1,120}$/i
);
const repositoryRelativePathSchema = z.string().trim().min(1).max(1024)
  .refine(
    (value) => {
      const normalized = value.replace(/\\/gu, "/");
      return !normalized.startsWith("/") &&
        !normalized.split("/").some((part) =>
          part === "" || part === "." || part === ".." || part === ".git"
        ) &&
        !/[\u0000-\u001f\u007f]/u.test(normalized);
    },
    "必须是安全的仓库相对路径"
  );
const githubDiscoverySearchInputSchema = z.object({
  mode: z.literal("discovery"),
  keywords: z.string().trim().max(200),
  createdWithinDays: z.union([
    z.literal(7),
    z.literal(30),
    z.literal(90)
  ]),
  sort: z.enum(["stars", "updated", "forks"]),
  limit: z.number().int().min(1).max(10)
}).strict();
const githubSearchInputSchema = z.union([
  githubDiscoverySearchInputSchema,
  z.object({
    mode: z.literal("name"),
    query: z.string().trim().min(1).max(100),
    limit: z.number().int().min(1).max(10)
  }).strict(),
  z.object({
    mode: z.literal("exact"),
    fullName: z.string().regex(
      /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
    ),
    limit: z.literal(1)
  }).strict()
]);

export const agentToolCallSchema = z.discriminatedUnion("name", [
  z.object({
    callId: identifierSchema,
    name: z.literal("read_system_profile"),
    input: z.object({}).strict()
  }).strict(),
  z.object({
    callId: identifierSchema,
    name: z.literal("inspect_local_development_environment"),
    input: z.object({}).strict()
  }).strict(),
  z.object({
    callId: identifierSchema,
    name: z.literal("list_local_repository_tree"),
    input: z.object({
      repositoryHandleId: localRepositoryHandleSchema,
      pathPrefix: repositoryRelativePathSchema.optional(),
      maxEntries: z.number().int().min(1).max(500).optional()
    }).strict()
  }).strict(),
  z.object({
    callId: identifierSchema,
    name: z.literal("read_local_repository_file"),
    input: z.object({
      repositoryHandleId: localRepositoryHandleSchema,
      relativePath: repositoryRelativePathSchema
    }).strict()
  }).strict(),
  z.object({
    callId: identifierSchema,
    name: z.literal("inspect_project_requirements"),
    input: z.object({
      repositoryHandleId: localRepositoryHandleSchema
    }).strict()
  }).strict(),
  z.object({
    callId: identifierSchema,
    name: z.literal("list_github_repository_tree"),
    input: z.object({
      repositoryHandleId: githubRepositoryHandleSchema,
      pathPrefix: repositoryRelativePathSchema.optional(),
      maxEntries: z.number().int().min(1).max(500).optional()
    }).strict()
  }).strict(),
  z.object({
    callId: identifierSchema,
    name: z.literal("read_github_repository_file"),
    input: z.object({
      repositoryHandleId: githubRepositoryHandleSchema,
      relativePath: repositoryRelativePathSchema
    }).strict()
  }).strict(),
  z.object({
    callId: identifierSchema,
    name: z.literal("inspect_github_project_requirements"),
    input: z.object({
      repositoryHandleId: githubRepositoryHandleSchema
    }).strict()
  }).strict(),
  z.object({
    callId: identifierSchema,
    name: z.literal("search_trusted_catalog"),
    input: z.object({
      query: z.string().trim().max(4000),
      resourceIds: z.array(resourceIdSchema).max(100).optional()
    }).strict()
  }).strict(),
  z.object({
    callId: identifierSchema,
    name: z.literal("search_github_repositories"),
    input: githubSearchInputSchema
  }).strict(),
  z.object({
    callId: identifierSchema,
    name: z.literal("simulate_download"),
    input: z.object({ resourceId: resourceIdSchema }).strict()
  }).strict(),
  z.object({
    callId: identifierSchema,
    name: z.literal("controlled_download"),
    input: z.object({ resourceId: resourceIdSchema }).strict()
  }).strict(),
  z.object({
    callId: identifierSchema,
    name: z.literal("export_workspace"),
    input: z.object({
      taskId: taskIdSchema,
      revision: z.number().int().positive()
    }).strict()
  }).strict()
]);

export const agentActionSchema = z.discriminatedUnion("type", [
  z.object({
    actionId: identifierSchema,
    type: z.literal("propose_task_plan"),
    proposal: taskPlanProposalSchema,
    explanation: descriptionSchema
  }).strict(),
  z.object({
    actionId: identifierSchema,
    type: z.literal("ask_clarification"),
    questionId: identifierSchema,
    question: descriptionSchema,
    reason: descriptionSchema,
    required: z.boolean(),
    options: z.array(descriptionSchema).min(1).max(20)
  }).strict(),
  z.object({
    actionId: identifierSchema,
    type: z.literal("create_plan"),
    resourceIds: z.array(resourceIdSchema).min(1).max(100),
    explanation: descriptionSchema
  }).strict(),
  z.object({
    actionId: identifierSchema,
    type: z.literal("create_replan"),
    strategy: z.enum(["trusted-mirror", "primary-retry"]),
    explanation: descriptionSchema
  }).strict(),
  z.object({
    actionId: identifierSchema,
    type: z.literal("call_tool"),
    call: agentToolCallSchema,
    purpose: descriptionSchema
  }).strict(),
  z.object({
    actionId: identifierSchema,
    type: z.literal("finish"),
    summary: descriptionSchema
  }).strict()
]);

export const modelDecisionSchema = z.object({
  decisionId: identifierSchema,
  provider: z.enum(["local-rule", "remote-llm"]),
  model: identifierSchema,
  explanation: descriptionSchema,
  action: agentActionSchema
}).strict();

export const agentUserEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("SUBMIT_TASK"),
    task: z.string().trim().min(1).max(4000)
  }).strict(),
  z.object({
    type: z.literal("CONFIRM_TASK_PLAN"),
    revision: z.number().int().positive()
  }).strict(),
  z.object({
    type: z.literal("ANSWER_CLARIFICATION"),
    questionId: z.string().trim().min(1).max(120),
    answer: z.string().trim().min(1).max(4000)
  }).strict(),
  z.object({
    type: z.literal("SKIP_CLARIFICATION"),
    questionId: z.string().trim().min(1).max(120)
  }).strict(),
  z.object({
    type: z.literal("PREPARE_GITHUB_REPOSITORY"),
    fullName: z.string().regex(
      /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
    )
  }).strict(),
  z.object({
    type: z.literal("ANALYZE_GITHUB_REPOSITORY"),
    fullName: z.string().regex(
      /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
    )
  }).strict(),
  z.object({
    type: z.literal("TOGGLE_NODE_DEPENDENCIES"),
    selected: z.boolean()
  }).strict(),
  z.object({
    type: z.literal("PREPARE_NODE_DEPENDENCIES")
  }).strict(),
  z.object({
    type: z.literal("TOGGLE_RESOURCE"),
    resourceId: resourceIdSchema,
    selected: z.boolean()
  }).strict(),
  z.object({
    type: z.literal("APPROVE_PLAN"),
    revision: z.number().int().positive()
  }).strict(),
  z.object({
    type: z.literal("PAUSE_DOWNLOAD"),
    resourceId: resourceIdSchema
  }).strict(),
  z.object({
    type: z.literal("RESUME_DOWNLOAD"),
    resourceId: resourceIdSchema
  }).strict(),
  z.object({
    type: z.literal("RESOLVE_DOWNLOAD_FAILURE"),
    action: z.enum(["trusted-mirror", "primary-retry", "delegate-agent-b"])
  }).strict(),
  z.object({
    type: z.literal("RUN_AGENT_B")
  }).strict(),
  z.object({
    type: z.literal("RETRY_WORKSPACE_EXPORT")
  }).strict(),
  z.object({
    type: z.literal("CANCEL_TASK")
  }).strict(),
  z.object({
    type: z.literal("RESET")
  }).strict()
]);

export function parseAgentUserEvent(value: unknown): AgentUserEvent {
  return agentUserEventSchema.parse(value) as AgentUserEvent;
}

export function parseAgentToolCall(value: unknown): AgentToolCall {
  return agentToolCallSchema.parse(value) as AgentToolCall;
}

export function parseAgentAction(value: unknown): AgentAction {
  return agentActionSchema.parse(value) as AgentAction;
}

export function parseModelDecision(value: unknown): ModelDecision {
  return modelDecisionSchema.parse(value) as ModelDecision;
}
