import { z } from "zod";
import type {
  AgentAssistantTurn,
  AgentLoopEvidence
} from "./agentLoop";
import {
  ModelToolProtocolError,
  parseOpenAiToolDecision,
  type OpenAiFunctionTool
} from "./modelToolProtocol";
import type { AgentToolName } from "./types";

/** Control calls terminate the current Agent Loop turn instead of invoking a runtime tool. */
export const AGENT_LOOP_CONTROL_TOOL_NAMES = [
  "complete_step",
  "ask_clarification",
  "propose_plan_revision"
] as const;

export type AgentLoopControlToolName =
  (typeof AGENT_LOOP_CONTROL_TOOL_NAMES)[number];

export type AgentLoopJsonValue =
  | null
  | boolean
  | number
  | string
  | AgentLoopJsonValue[]
  | { [key: string]: AgentLoopJsonValue };

export type AgentLoopJsonObject = {
  [key: string]: AgentLoopJsonValue;
};

export type AgentLoopRuntimeToolSource =
  | readonly OpenAiFunctionTool[]
  | Readonly<Partial<Record<AgentToolName, OpenAiFunctionTool>>>;

export type OpenAiNativeFunctionToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ParsedAgentLoopRuntimeCall = {
  input: unknown;
  explanation: string;
};

export type ParseAgentLoopRuntimeCall = (context: {
  call: OpenAiNativeFunctionToolCall;
  arguments: unknown;
  model: string;
  availableTools: readonly AgentToolName[];
}) => ParsedAgentLoopRuntimeCall;

export type ParseOpenAiAgentTurnOptions = {
  /** Capability-filtered runtime tools. Every member is authoritative read-only. */
  availableTools?: readonly AgentToolName[];
  /** More explicit alias for availableTools; preferred by new integrations. */
  availableRuntimeTools?: readonly AgentToolName[];
  /** Tools that may appear together in the same independent read batch. */
  parallelReadTools?: readonly AgentToolName[];
  maxCalls?: number;
  /** OpenAI-compatible finish reason normally found on choices[0]. */
  finishReason?: string | null;
  /** Host-generated turn identifier when the provider message has no id. */
  turnId?: string;
  /** Override for non-legacy runtime tools. It cannot declare or alter risk. */
  parseRuntimeToolCall?: ParseAgentLoopRuntimeCall;
};

export type AgentLoopModelProtocolErrorKind =
  | "invalid-response"
  | "truncated-response"
  | "invalid-json"
  | "invalid-tool-call"
  | "invalid-control-action";

export class AgentLoopModelProtocolError extends Error {
  constructor(
    readonly kind: AgentLoopModelProtocolErrorKind,
    message: string
  ) {
    super(message);
    this.name = "AgentLoopModelProtocolError";
  }
}

const explanationProperty = {
  type: "string",
  minLength: 1,
  maxLength: 4000,
  description: "可审计的简短决策依据；不得包含隐藏思维链。"
};

const jsonValueProperty = {
  description: "JSON 兼容值。"
};

export function createOpenAiFunctionTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[]
): OpenAiFunctionTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties,
        required: [...required]
      }
    }
  };
}

export function createCompleteStepTool(): OpenAiFunctionTool {
  return createOpenAiFunctionTool(
    "complete_step",
    "证据满足当前步骤的完成契约时，提交结构化结果并结束该步骤。",
    {
      summary: {
        type: "string",
        minLength: 1,
        maxLength: 4000,
        description: "面向审计记录的完成摘要。"
      },
      output: jsonValueProperty,
      evidence: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            source: { type: "string", minLength: 1, maxLength: 400 },
            reference: { type: "string", minLength: 1, maxLength: 2000 },
            summary: { type: "string", minLength: 1, maxLength: 4000 }
          },
          required: ["source", "reference"]
        }
      },
      explanation: explanationProperty
    },
    ["summary", "output", "explanation"]
  );
}

export function createAskClarificationTool(): OpenAiFunctionTool {
  return createOpenAiFunctionTool(
    "ask_clarification",
    "只有缺少用户信息且无法在已授权只读能力内继续时，提出一个澄清问题。",
    {
      questionId: { type: "string", minLength: 1, maxLength: 120 },
      question: { type: "string", minLength: 1, maxLength: 4000 },
      reason: { type: "string", minLength: 1, maxLength: 4000 },
      required: { type: "boolean" },
      options: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string", minLength: 1, maxLength: 4000 }
      },
      explanation: explanationProperty
    },
    ["questionId", "question", "reason", "required", "explanation"]
  );
}

export function createProposePlanRevisionTool(): OpenAiFunctionTool {
  return createOpenAiFunctionTool(
    "propose_plan_revision",
    "当前步骤需要超出已确认能力范围的动作时，提出新的结构化 TaskPlan revision；此调用本身不执行写入。",
    {
      reason: { type: "string", minLength: 1, maxLength: 4000 },
      proposal: {
        type: "object",
        description: "JSON 兼容的 TaskPlan revision 提案。"
      },
      explanation: explanationProperty
    },
    ["reason", "proposal", "explanation"]
  );
}

export function createOpenAiAgentLoopControlTools(): OpenAiFunctionTool[] {
  return [
    createCompleteStepTool(),
    createAskClarificationTool(),
    createProposePlanRevisionTool()
  ];
}

function runtimeToolsByName(source: AgentLoopRuntimeToolSource) {
  const tools = new Map<string, OpenAiFunctionTool>();
  if (Array.isArray(source)) {
    for (const tool of source) {
      const name = tool.function.name;
      if (tools.has(name)) {
        throw new Error(`Duplicate OpenAI runtime tool definition: ${name}`);
      }
      tools.set(name, tool);
    }
    return tools;
  }

  for (const [registeredName, candidate] of Object.entries(source)) {
    if (!candidate) continue;
    if (candidate.function.name !== registeredName) {
      throw new Error(
        `OpenAI runtime tool registry key ${registeredName} does not match definition ${candidate.function.name}.`
      );
    }
    if (tools.has(registeredName)) {
      throw new Error(
        `Duplicate OpenAI runtime tool definition: ${registeredName}`
      );
    }
    tools.set(registeredName, candidate);
  }
  return tools;
}

/**
 * Selects existing provider definitions without re-declaring their schemas.
 * Array order is retained unless availableTools supplies an explicit order.
 */
export function createOpenAiAgentLoopRuntimeTools(
  source: AgentLoopRuntimeToolSource,
  availableTools?: readonly AgentToolName[]
): OpenAiFunctionTool[] {
  const byName = runtimeToolsByName(source);
  const selectedNames = availableTools ?? [...byName.keys()];
  const seen = new Set<string>();

  return selectedNames.map((name) => {
    if (seen.has(name)) {
      throw new Error(`Duplicate available Agent Loop runtime tool: ${name}`);
    }
    seen.add(name);
    if ((AGENT_LOOP_CONTROL_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new Error(`Runtime tool collides with Agent Loop control: ${name}`);
    }
    const definition = byName.get(name);
    if (!definition) {
      throw new Error(`Missing OpenAI runtime tool definition: ${name}`);
    }
    return definition;
  });
}

/** Builds the complete OpenAI-compatible tool list for one Agent Loop turn. */
export function createOpenAiAgentLoopTools(
  source: AgentLoopRuntimeToolSource,
  availableTools?: readonly AgentToolName[]
): OpenAiFunctionTool[] {
  return [
    ...createOpenAiAgentLoopControlTools(),
    ...createOpenAiAgentLoopRuntimeTools(source, availableTools)
  ];
}

const nativeToolCallSchema = z.object({
  id: z.string().trim().min(1).max(160),
  type: z.literal("function"),
  function: z.object({
    name: z.string().trim().min(1).max(80),
    arguments: z.string().max(64_000)
  }).strict()
}).passthrough();

const nativeMessageSchema = z.object({
  id: z.string().trim().min(1).max(200).optional(),
  tool_calls: z.array(nativeToolCallSchema).min(1)
}).passthrough();

const nonEmptyTextSchema = z.string().trim().min(1).max(4000);
const identifierSchema = z.string().trim().min(1).max(120);
const jsonValueSchema = z.json();
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

const evidenceSchema = z.object({
  source: z.string().trim().min(1).max(400),
  reference: z.string().trim().min(1).max(2000),
  summary: nonEmptyTextSchema.optional()
}).strict();

const completeStepArgumentsSchema = z.object({
  summary: nonEmptyTextSchema,
  output: jsonValueSchema,
  evidence: z.array(evidenceSchema).max(100).optional(),
  explanation: nonEmptyTextSchema
}).strict();

const askClarificationArgumentsSchema = z.object({
  questionId: identifierSchema,
  question: nonEmptyTextSchema,
  reason: nonEmptyTextSchema,
  required: z.boolean(),
  options: z.array(nonEmptyTextSchema).min(1).max(20).optional(),
  explanation: nonEmptyTextSchema
}).strict();

const proposePlanRevisionArgumentsSchema = z.object({
  reason: nonEmptyTextSchema,
  proposal: jsonObjectSchema,
  explanation: nonEmptyTextSchema
}).strict();

function jsonValueWithinLimits(value: unknown) {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > 5_000 || current.depth > 20) return false;
    const children = Array.isArray(current.value)
      ? current.value
      : typeof current.value === "object" && current.value !== null
        ? Object.values(current.value)
        : [];
    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
}

function parseJsonArguments(rawArguments: string, name: string) {
  if (rawArguments.length > 64_000) {
    throw new AgentLoopModelProtocolError(
      "invalid-json",
      `远程 LLM 为 ${name} 返回的 tool_call.arguments 超过 64000 字符上限。`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments) as unknown;
  } catch {
    throw new AgentLoopModelProtocolError(
      "invalid-json",
      `远程 LLM 为 ${name} 返回的 tool_call.arguments 不是合法 JSON。`
    );
  }
  if (!jsonValueWithinLimits(parsed)) {
    throw new AgentLoopModelProtocolError(
      "invalid-json",
      `远程 LLM 为 ${name} 返回的 JSON 超过嵌套深度或节点数量上限。`
    );
  }
  return parsed;
}

function isControlToolName(name: string): name is AgentLoopControlToolName {
  return (AGENT_LOOP_CONTROL_TOOL_NAMES as readonly string[]).includes(name);
}

function messageFinishReason(message: unknown): unknown {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as Record<string, unknown>;
  return record.finish_reason ?? record.finishReason;
}

function defaultRuntimeCallParser(
  context: Parameters<ParseAgentLoopRuntimeCall>[0]
): ParsedAgentLoopRuntimeCall {
  let decision;
  try {
    decision = parseOpenAiToolDecision(
      { tool_calls: [context.call] },
      context.model,
      [...context.availableTools],
      []
    );
  } catch (error) {
    if (error instanceof ModelToolProtocolError) {
      throw new AgentLoopModelProtocolError(
        error.kind === "invalid-json" ? "invalid-json" : "invalid-tool-call",
        error.message
      );
    }
    throw error;
  }

  if (decision.action.type !== "call_tool") {
    throw new AgentLoopModelProtocolError(
      "invalid-tool-call",
      `Agent Loop 运行时工具 ${context.call.function.name} 未映射为 call_tool。`
    );
  }
  return {
    input: decision.action.call.input,
    explanation: decision.explanation
  };
}

function parseControlAction(
  call: OpenAiNativeFunctionToolCall,
  value: unknown
): {
  rationaleSummary: string;
  action: AgentAssistantTurn<
    AgentToolName,
    AgentLoopJsonValue,
    AgentLoopJsonObject
  >["action"];
} {
  try {
    if (call.function.name === "complete_step") {
      const args = completeStepArgumentsSchema.parse(value);
      return {
        rationaleSummary: args.explanation,
        action: {
          type: "complete_step",
          summary: args.summary,
          output: args.output as AgentLoopJsonValue,
          ...(args.evidence
            ? { evidence: args.evidence as AgentLoopEvidence[] }
            : {})
        }
      };
    }
    if (call.function.name === "ask_clarification") {
      const args = askClarificationArgumentsSchema.parse(value);
      return {
        rationaleSummary: args.explanation,
        action: {
          type: "ask_clarification",
          questionId: args.questionId,
          question: args.question,
          reason: args.reason,
          required: args.required,
          ...(args.options ? { options: args.options } : {})
        }
      };
    }
    if (call.function.name === "propose_plan_revision") {
      const args = proposePlanRevisionArgumentsSchema.parse(value);
      return {
        rationaleSummary: args.explanation,
        action: {
          type: "propose_plan_revision",
          reason: args.reason,
          proposal: args.proposal as AgentLoopJsonObject
        }
      };
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new AgentLoopModelProtocolError(
        "invalid-control-action",
        `远程 LLM 为 ${call.function.name} 返回了非法控制参数。`
      );
    }
    throw error;
  }

  throw new AgentLoopModelProtocolError(
    "invalid-control-action",
    `未知的 Agent Loop 控制调用：${call.function.name}。`
  );
}

/**
 * Parses one OpenAI-compatible assistant message into a provider-neutral turn.
 * Classification and batch validation complete before any member is mapped.
 */
export function parseOpenAiAgentTurn(
  message: unknown,
  model: string,
  options: ParseOpenAiAgentTurnOptions
): AgentAssistantTurn<
  AgentToolName,
  AgentLoopJsonValue,
  AgentLoopJsonObject
> {
  if (
    options.finishReason === "length" ||
    messageFinishReason(message) === "length"
  ) {
    throw new AgentLoopModelProtocolError(
      "truncated-response",
      "远程 LLM 的响应因长度限制被截断，拒绝执行其中的工具调用。"
    );
  }

  let parsedMessage: z.infer<typeof nativeMessageSchema>;
  try {
    parsedMessage = nativeMessageSchema.parse(message);
  } catch {
    throw new AgentLoopModelProtocolError(
      "invalid-response",
      "远程 LLM 必须通过一个或多个原生 function tool_calls 返回 Agent Loop 动作。"
    );
  }

  const maxCalls = options.maxCalls ?? 8;
  if (!Number.isInteger(maxCalls) || maxCalls <= 0) {
    throw new RangeError("maxCalls must be a positive integer.");
  }
  if (parsedMessage.tool_calls.length > maxCalls) {
    throw new AgentLoopModelProtocolError(
      "invalid-response",
      `远程 LLM 返回了 ${parsedMessage.tool_calls.length} 个工具调用，超过本轮上限 ${maxCalls}。`
    );
  }

  const availableTools = [
    ...(options.availableRuntimeTools ?? options.availableTools ?? [])
  ];
  const availableSet = new Set<AgentToolName>(availableTools);
  const classified = parsedMessage.tool_calls.map((call) => {
    const name = call.function.name;
    if (isControlToolName(name)) {
      return { kind: "control" as const, call };
    }
    if (!availableSet.has(name as AgentToolName)) {
      throw new AgentLoopModelProtocolError(
        "invalid-tool-call",
        `远程 LLM 调用了未知或当前不可用的 Agent Loop 工具：${name}。`
      );
    }
    return {
      kind: "runtime" as const,
      call,
      name: name as AgentToolName
    };
  });

  const controlCalls = classified.filter(
    (candidate) => candidate.kind === "control"
  );
  if (controlCalls.length > 0 && classified.length !== 1) {
    throw new AgentLoopModelProtocolError(
      "invalid-control-action",
      "Agent Loop 控制调用必须单独出现，不能与运行时工具或其他控制调用混合。"
    );
  }

  const callIds = new Set<string>();
  for (const candidate of classified) {
    if (callIds.has(candidate.call.id)) {
      throw new AgentLoopModelProtocolError(
        "invalid-tool-call",
        `同一 assistant turn 中重复使用了 callId ${candidate.call.id}。`
      );
    }
    callIds.add(candidate.call.id);
  }

  const runtimeCalls = classified.filter(
    (candidate): candidate is Extract<(typeof classified)[number], {
      kind: "runtime";
    }> => candidate.kind === "runtime"
  );
  if (runtimeCalls.length > 1) {
    const parallelReadTools = new Set(options.parallelReadTools ?? []);
    const nonParallel = runtimeCalls.find(
      (candidate) => !parallelReadTools.has(candidate.name)
    );
    if (nonParallel) {
      throw new AgentLoopModelProtocolError(
        "invalid-tool-call",
        `多个运行时工具只能并行调用已授权的只读工具；${nonParallel.name} 不在 parallelReadTools 中。`
      );
    }
  }

  const turnId = options.turnId?.trim() || parsedMessage.id || classified[0].call.id;

  if (controlCalls.length === 1) {
    const control = controlCalls[0];
    const parsed = parseControlAction(
      control.call,
      parseJsonArguments(
        control.call.function.arguments,
        control.call.function.name
      )
    );
    return { turnId, ...parsed };
  }

  const parseRuntimeCall =
    options.parseRuntimeToolCall ?? defaultRuntimeCallParser;
  // Parse every member before invoking a validator callback so a malformed
  // member invalidates the batch without partially mapping earlier calls.
  const parsedRuntimeCalls = runtimeCalls.map((candidate) => ({
    candidate,
    arguments: parseJsonArguments(
      candidate.call.function.arguments,
      candidate.name
    )
  }));
  const mappedCalls: Array<{
    callId: string;
    name: AgentToolName;
    input: unknown;
    risk: "read_only";
  }> = [];
  const explanations: string[] = [];

  for (const { candidate, arguments: parsedArguments } of parsedRuntimeCalls) {
    let mapped: ParsedAgentLoopRuntimeCall;
    try {
      mapped = parseRuntimeCall({
        call: candidate.call,
        arguments: parsedArguments,
        model,
        availableTools
      });
    } catch (error) {
      if (error instanceof AgentLoopModelProtocolError) throw error;
      throw new AgentLoopModelProtocolError(
        "invalid-tool-call",
        `远程 LLM 为 ${candidate.name} 返回了非法运行时工具参数。`
      );
    }
    const explanation =
      typeof mapped === "object" && mapped !== null
        ? nonEmptyTextSchema.safeParse(mapped.explanation)
        : { success: false as const };
    if (!explanation.success) {
      throw new AgentLoopModelProtocolError(
        "invalid-tool-call",
        `运行时工具 ${candidate.name} 缺少可审计的 explanation。`
      );
    }
    mappedCalls.push({
      callId: candidate.call.id,
      name: candidate.name,
      input: mapped.input,
      risk: "read_only"
    });
    explanations.push(explanation.data);
  }

  return {
    turnId,
    rationaleSummary: explanations.join("\n"),
    action: {
      type: "tool_calls",
      calls: mappedCalls as [
        (typeof mappedCalls)[number],
        ...(typeof mappedCalls)[number][]
      ]
    }
  };
}
