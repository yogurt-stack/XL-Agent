import { z } from "zod";
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

export const agentToolCallSchema = z.discriminatedUnion("name", [
  z.object({
    callId: identifierSchema,
    name: z.literal("read_system_profile"),
    input: z.object({}).strict()
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
    type: z.literal("ANSWER_CLARIFICATION"),
    questionId: z.string().trim().min(1).max(120),
    answer: z.string().trim().min(1).max(4000)
  }).strict(),
  z.object({
    type: z.literal("SKIP_CLARIFICATION"),
    questionId: z.string().trim().min(1).max(120)
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
    type: z.literal("RESOLVE_DOWNLOAD_FAILURE"),
    action: z.enum(["trusted-mirror", "primary-retry", "delegate-agent-b"])
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
