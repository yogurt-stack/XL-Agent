import { z } from "zod";
import { parseModelDecision } from "./agentSchemas";
import type {
  AgentAction,
  AgentToolName,
  ModelDecision
} from "./types";

export type OpenAiFunctionTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    strict: true;
    parameters: Record<string, unknown>;
  };
};

export type ModelToolProtocolErrorKind =
  | "invalid-response"
  | "invalid-json"
  | "invalid-decision";

export class ModelToolProtocolError extends Error {
  constructor(
    readonly kind: ModelToolProtocolErrorKind,
    message: string
  ) {
    super(message);
    this.name = "ModelToolProtocolError";
  }
}

const explanationProperty = {
  type: "string",
  minLength: 1,
  description: "说明为什么当前状态下应选择此动作。"
};

function functionTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[]
): OpenAiFunctionTool {
  return {
    type: "function",
    function: {
      name,
      description,
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties,
        required
      }
    }
  };
}

const actionTools: OpenAiFunctionTool[] = [
  functionTool(
    "ask_clarification",
    "向用户询问一个完成当前任务所必需的澄清问题。",
    {
      questionId: { type: "string", minLength: 1 },
      question: { type: "string", minLength: 1 },
      reason: { type: "string", minLength: 1 },
      required: { type: "boolean" },
      options: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string", minLength: 1 }
      },
      explanation: explanationProperty
    },
    ["questionId", "question", "reason", "required", "options", "explanation"]
  ),
  functionTool(
    "create_plan",
    "根据可信目录查询结果创建第一版资源计划。",
    {
      resourceIds: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { type: "string", minLength: 1 }
      },
      explanation: explanationProperty
    },
    ["resourceIds", "explanation"]
  ),
  functionTool(
    "create_replan",
    "在下载失败后的 replanning 阶段创建新的计划 revision。",
    {
      strategy: {
        type: "string",
        enum: ["trusted-mirror", "primary-retry"]
      },
      explanation: explanationProperty
    },
    ["strategy", "explanation"]
  ),
  functionTool(
    "finish",
    "当前任务无需其他动作时结束本轮模型规划。",
    {
      summary: { type: "string", minLength: 1 },
      explanation: explanationProperty
    },
    ["summary", "explanation"]
  )
];

const runtimeToolDefinitions: Record<AgentToolName, OpenAiFunctionTool> = {
  read_system_profile: functionTool(
    "read_system_profile",
    "读取经过隐私裁剪的主机画像和锁定的 Windows 目标画像。",
    {
      purpose: { type: "string", minLength: 1 },
      explanation: explanationProperty
    },
    ["purpose", "explanation"]
  ),
  search_trusted_catalog: functionTool(
    "search_trusted_catalog",
    "只读查询宿主提供的可信资源目录。",
    {
      query: { type: "string", minLength: 1 },
      resourceIds: {
        type: "array",
        maxItems: 100,
        items: { type: "string", minLength: 1 }
      },
      purpose: { type: "string", minLength: 1 },
      explanation: explanationProperty
    },
    ["query", "resourceIds", "purpose", "explanation"]
  ),
  simulate_download: functionTool(
    "simulate_download",
    "执行当前已审批资源的模拟下载步骤。",
    {
      resourceId: { type: "string", minLength: 1 },
      purpose: { type: "string", minLength: 1 },
      explanation: explanationProperty
    },
    ["resourceId", "purpose", "explanation"]
  ),
  controlled_download: functionTool(
    "controlled_download",
    "执行当前已审批资源的 Electron Main 受控真实下载步骤。",
    {
      resourceId: { type: "string", minLength: 1 },
      purpose: { type: "string", minLength: 1 },
      explanation: explanationProperty
    },
    ["resourceId", "purpose", "explanation"]
  ),
  export_workspace: functionTool(
    "export_workspace",
    "把当前已审批且全部验证完成的 revision 导出为工作区。",
    {
      taskId: { type: "string", minLength: 1 },
      revision: { type: "integer", minimum: 1 },
      purpose: { type: "string", minLength: 1 },
      explanation: explanationProperty
    },
    ["taskId", "revision", "purpose", "explanation"]
  )
};

export function createOpenAiAgentTools(
  availableTools: AgentToolName[]
): OpenAiFunctionTool[] {
  return [
    ...actionTools,
    ...availableTools.map((name) => runtimeToolDefinitions[name])
  ];
}

const nativeToolCallSchema = z.object({
  id: z.string().trim().min(1).max(160),
  type: z.literal("function"),
  function: z.object({
    name: z.string().trim().min(1).max(80),
    arguments: z.string()
  }).strict()
}).strict();

const nativeMessageSchema = z.object({
  tool_calls: z.array(nativeToolCallSchema).length(1)
}).passthrough();

const explanationSchema = z.string().trim().min(1).max(4000);
const identifierSchema = z.string().trim().min(1).max(160);
const resourceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/i);
const purposeSchema = z.string().trim().min(1).max(4000);

const askClarificationArgumentsSchema = z.object({
  questionId: identifierSchema,
  question: purposeSchema,
  reason: purposeSchema,
  required: z.boolean(),
  options: z.array(purposeSchema).min(1).max(20),
  explanation: explanationSchema
}).strict();

const createPlanArgumentsSchema = z.object({
  resourceIds: z.array(resourceIdSchema).min(1).max(100),
  explanation: explanationSchema
}).strict();

const createReplanArgumentsSchema = z.object({
  strategy: z.enum(["trusted-mirror", "primary-retry"]),
  explanation: explanationSchema
}).strict();

const finishArgumentsSchema = z.object({
  summary: purposeSchema,
  explanation: explanationSchema
}).strict();

const readProfileArgumentsSchema = z.object({
  purpose: purposeSchema,
  explanation: explanationSchema
}).strict();

const searchCatalogArgumentsSchema = z.object({
  query: purposeSchema,
  resourceIds: z.array(resourceIdSchema).max(100),
  purpose: purposeSchema,
  explanation: explanationSchema
}).strict();

const resourceToolArgumentsSchema = z.object({
  resourceId: resourceIdSchema,
  purpose: purposeSchema,
  explanation: explanationSchema
}).strict();

const exportWorkspaceArgumentsSchema = z.object({
  taskId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/i),
  revision: z.number().int().positive(),
  purpose: purposeSchema,
  explanation: explanationSchema
}).strict();

function parseArguments(rawArguments: string) {
  try {
    return JSON.parse(rawArguments) as unknown;
  } catch {
    throw new ModelToolProtocolError(
      "invalid-json",
      "远程 LLM 的 tool_call.arguments 不是合法 JSON。"
    );
  }
}

function createAction(
  name: string,
  actionId: string,
  value: unknown,
  availableTools: AgentToolName[]
): { action: AgentAction; explanation: string } {
  try {
    if (name === "ask_clarification") {
      const args = askClarificationArgumentsSchema.parse(value);
      const { explanation, ...question } = args;
      return {
        explanation,
        action: { actionId, type: "ask_clarification", ...question }
      };
    }
    if (name === "create_plan") {
      const args = createPlanArgumentsSchema.parse(value);
      return {
        explanation: args.explanation,
        action: { actionId, type: "create_plan", ...args }
      };
    }
    if (name === "create_replan") {
      const args = createReplanArgumentsSchema.parse(value);
      return {
        explanation: args.explanation,
        action: { actionId, type: "create_replan", ...args }
      };
    }
    if (name === "finish") {
      const args = finishArgumentsSchema.parse(value);
      return {
        explanation: args.explanation,
        action: { actionId, type: "finish", summary: args.summary }
      };
    }

    if (!availableTools.includes(name as AgentToolName)) {
      throw new ModelToolProtocolError(
        "invalid-decision",
        `远程 LLM 调用了当前上下文未提供的工具：${name}。`
      );
    }

    if (name === "read_system_profile") {
      const args = readProfileArgumentsSchema.parse(value);
      return {
        explanation: args.explanation,
        action: {
          actionId,
          type: "call_tool",
          purpose: args.purpose,
          call: { callId: actionId, name, input: {} }
        }
      };
    }
    if (name === "search_trusted_catalog") {
      const args = searchCatalogArgumentsSchema.parse(value);
      return {
        explanation: args.explanation,
        action: {
          actionId,
          type: "call_tool",
          purpose: args.purpose,
          call: {
            callId: actionId,
            name,
            input: { query: args.query, resourceIds: args.resourceIds }
          }
        }
      };
    }
    if (name === "simulate_download" || name === "controlled_download") {
      const args = resourceToolArgumentsSchema.parse(value);
      return {
        explanation: args.explanation,
        action: {
          actionId,
          type: "call_tool",
          purpose: args.purpose,
          call: {
            callId: actionId,
            name,
            input: { resourceId: args.resourceId }
          }
        }
      };
    }
    if (name === "export_workspace") {
      const args = exportWorkspaceArgumentsSchema.parse(value);
      return {
        explanation: args.explanation,
        action: {
          actionId,
          type: "call_tool",
          purpose: args.purpose,
          call: {
            callId: actionId,
            name,
            input: { taskId: args.taskId, revision: args.revision }
          }
        }
      };
    }
  } catch (error) {
    if (error instanceof ModelToolProtocolError) throw error;
    if (error instanceof z.ZodError) {
      throw new ModelToolProtocolError(
        "invalid-decision",
        `远程 LLM 为 ${name} 返回了非法工具参数。`
      );
    }
    throw error;
  }

  throw new ModelToolProtocolError(
    "invalid-decision",
    `远程 LLM 返回了未知工具调用：${name}。`
  );
}

export function parseOpenAiToolDecision(
  message: unknown,
  model: string,
  availableTools: AgentToolName[]
): ModelDecision {
  let parsedMessage: z.infer<typeof nativeMessageSchema>;
  try {
    parsedMessage = nativeMessageSchema.parse(message);
  } catch {
    throw new ModelToolProtocolError(
      "invalid-response",
      "远程 LLM 必须通过且只能通过一个 tool_call 返回下一步动作。"
    );
  }

  const toolCall = parsedMessage.tool_calls[0];
  const { action, explanation } = createAction(
    toolCall.function.name,
    toolCall.id,
    parseArguments(toolCall.function.arguments),
    availableTools
  );

  try {
    return parseModelDecision({
      decisionId: toolCall.id,
      provider: "remote-llm",
      model,
      explanation,
      action
    });
  } catch {
    throw new ModelToolProtocolError(
      "invalid-decision",
      "远程 LLM 的工具调用无法转换为合法 ModelDecision。"
    );
  }
}
