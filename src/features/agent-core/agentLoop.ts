/**
 * A bounded, read-only Agent loop for TaskPlan analysis steps.
 *
 * This module deliberately owns no product state. It receives an existing
 * transcript, asks the model for one turn, executes approved tools, appends
 * their observations, and asks the model again. TaskPlan remains responsible
 * for macro planning, approval and persistence.
 */

export type AgentLoopToolRisk =
  | "read_only"
  | "local_write"
  | "external_write"
  | "code_execution";

export type AgentLoopToolCall<TToolName extends string = string> = {
  callId: string;
  name: TToolName;
  input: unknown;
  /** Untrusted declaration from the model; the registry remains authoritative. */
  risk: AgentLoopToolRisk;
};

export type AgentLoopEvidence = {
  source: string;
  reference: string;
  summary?: string;
};

export type CompleteStepAction<TCompletion = unknown> = {
  type: "complete_step";
  summary: string;
  output: TCompletion;
  evidence?: AgentLoopEvidence[];
};

export type AskClarificationAction = {
  type: "ask_clarification";
  questionId: string;
  question: string;
  reason: string;
  required: boolean;
  options?: string[];
};

export type ProposePlanRevisionAction<TPlanRevision = unknown> = {
  type: "propose_plan_revision";
  reason: string;
  proposal: TPlanRevision;
};

export type AgentLoopControlAction<
  TCompletion = unknown,
  TPlanRevision = unknown
> =
  | CompleteStepAction<TCompletion>
  | AskClarificationAction
  | ProposePlanRevisionAction<TPlanRevision>;

export type AgentLoopAssistantAction<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
> =
  | {
      type: "tool_calls";
      /** A turn may request several independent observations. */
      calls: [
        AgentLoopToolCall<TToolName>,
        ...AgentLoopToolCall<TToolName>[]
      ];
    }
  | AgentLoopControlAction<TCompletion, TPlanRevision>;

export type AgentAssistantTurn<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
> = {
  turnId: string;
  /** Auditable summary only. Hidden chain-of-thought is never requested. */
  rationaleSummary: string;
  action: AgentLoopAssistantAction<TToolName, TCompletion, TPlanRevision>;
};

export type AgentLoopUserMessage = {
  id: string;
  role: "user";
  content: string;
  createdAt: string;
};

export type CompletionValidationAnnotation =
  | { status: "accepted" }
  | {
      status: "rejected";
      code: string;
      message: string;
    };

export type AgentLoopAssistantMessage<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
> = AgentAssistantTurn<TToolName, TCompletion, TPlanRevision> & {
  id: string;
  role: "assistant";
  createdAt: string;
  /** Engine feedback is visible on the next turn after a rejected completion. */
  completionValidation?: CompletionValidationAnnotation;
};

export type AgentLoopToolErrorKind =
  | "schema"
  | "capability"
  | "policy"
  | "execution"
  | "budget";

export type AgentLoopToolError = {
  kind: AgentLoopToolErrorKind;
  code: string;
  message: string;
  retriable: boolean;
};

export type AgentLoopToolResultMessage<TToolName extends string = string> = {
  id: string;
  role: "toolResult";
  callId: string;
  tool: TToolName;
  status: "success" | "error" | "blocked" | "cancelled";
  output?: unknown;
  error?: AgentLoopToolError;
  startedAt: string;
  finishedAt: string;
};

export type AgentLoopMessage<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
> =
  | AgentLoopUserMessage
  | AgentLoopAssistantMessage<TToolName, TCompletion, TPlanRevision>
  | AgentLoopToolResultMessage<TToolName>;

export type AgentLoopToolInputValidation =
  | { ok: true; value: unknown }
  | { ok: false; code?: string; message: string };

export type AgentLoopToolDefinition<TToolName extends string = string> = {
  name: TToolName;
  description: string;
  risk: AgentLoopToolRisk;
  /** Provider-facing JSON Schema. The kernel never treats it as validation. */
  inputSchema?: Record<string, unknown>;
  validateInput?: (
    input: unknown
  ) => AgentLoopToolInputValidation | Promise<AgentLoopToolInputValidation>;
};

export type AgentTurnToolDefinition<TToolName extends string = string> = Pick<
  AgentLoopToolDefinition<TToolName>,
  "name" | "description" | "risk" | "inputSchema"
>;

export type AgentLoopCapabilityEnvelope<TToolName extends string = string> = {
  allowedTools: readonly TToolName[];
  /** First-stage loops are intentionally unable to authorize mutations. */
  maxRisk: "read_only";
  allowParallelReads?: boolean;
};

export type AgentLoopBudget = {
  maxTurns: number;
  maxToolCalls: number;
  /** Maximum total occurrences of the same tool name + canonical input. */
  maxRepeatedIdenticalCalls: number;
  maxWallTimeMs: number;
};

export type AgentLoopUsage = {
  turns: number;
  toolCalls: number;
  executedToolCalls: number;
  elapsedMs: number;
};

export type AgentTurnContext<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
> = {
  runId: string;
  stepId?: string;
  objective: string;
  turn: number;
  transcript: readonly AgentLoopMessage<
    TToolName,
    TCompletion,
    TPlanRevision
  >[];
  availableTools: readonly AgentTurnToolDefinition<TToolName>[];
  completionContract: unknown;
  remainingBudget: {
    turns: number;
    toolCalls: number;
    wallTimeMs: number;
  };
};

export interface AgentTurnModel<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
> {
  generateTurn(
    context: AgentTurnContext<TToolName, TCompletion, TPlanRevision>,
    signal: AbortSignal
  ): Promise<AgentAssistantTurn<TToolName, TCompletion, TPlanRevision>>;
}

export type BeforeToolPolicyDecision =
  | { decision: "allow" }
  | {
      decision: "block";
      code: string;
      message: string;
      retriable?: boolean;
    };

export type BeforeToolPolicyContext<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
> = {
  runId: string;
  stepId?: string;
  turn: number;
  call: AgentLoopToolCall<TToolName>;
  tool: AgentLoopToolDefinition<TToolName>;
  capabilityEnvelope: AgentLoopCapabilityEnvelope<TToolName>;
  transcript: readonly AgentLoopMessage<
    TToolName,
    TCompletion,
    TPlanRevision
  >[];
};

export interface AgentLoopToolPolicy<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
> {
  beforeToolCall(
    context: BeforeToolPolicyContext<
      TToolName,
      TCompletion,
      TPlanRevision
    >,
    signal: AbortSignal
  ): BeforeToolPolicyDecision | Promise<BeforeToolPolicyDecision>;
}

export type AgentLoopToolExecutionResult =
  | { ok: true; output?: unknown }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        retriable: boolean;
      };
    };

export type AgentLoopToolExecutionContext<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
> = {
  runId: string;
  stepId?: string;
  turn: number;
  tool: AgentLoopToolDefinition<TToolName>;
  transcript: readonly AgentLoopMessage<
    TToolName,
    TCompletion,
    TPlanRevision
  >[];
};

export interface AgentLoopToolExecutor<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
> {
  execute(
    call: AgentLoopToolCall<TToolName>,
    context: AgentLoopToolExecutionContext<
      TToolName,
      TCompletion,
      TPlanRevision
    >,
    signal: AbortSignal
  ): Promise<AgentLoopToolExecutionResult>;
}

export type CompletionValidationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export type CompletionValidationContext<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
> = {
  runId: string;
  stepId?: string;
  objective: string;
  completionContract: unknown;
  action: CompleteStepAction<TCompletion>;
  transcript: readonly AgentLoopMessage<
    TToolName,
    TCompletion,
    TPlanRevision
  >[];
};

export type AgentLoopCompletionValidator<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
> = (
  context: CompletionValidationContext<
    TToolName,
    TCompletion,
    TPlanRevision
  >
) => CompletionValidationResult | Promise<CompletionValidationResult>;

type AgentLoopEventBase = {
  runId: string;
  stepId?: string;
  sequence: number;
  at: string;
};

export type AgentLoopEvent<TToolName extends string = string> =
  | (AgentLoopEventBase & { type: "agent_loop_started"; objective: string })
  | (AgentLoopEventBase & { type: "model_turn_started"; turn: number })
  | (AgentLoopEventBase & {
      type: "assistant_turn_completed";
      turn: number;
      turnId: string;
      actionType: AgentLoopAssistantAction<TToolName>["type"];
      rationaleSummary: string;
    })
  | (AgentLoopEventBase & {
      type: "tool_call_started";
      turn: number;
      callId: string;
      tool: TToolName;
    })
  | (AgentLoopEventBase & {
      type: "tool_call_blocked" | "tool_call_completed";
      turn: number;
      callId: string;
      tool: TToolName;
      status: AgentLoopToolResultMessage<TToolName>["status"];
      errorCode?: string;
    })
  | (AgentLoopEventBase & {
      type: "completion_rejected";
      turn: number;
      code: string;
      message: string;
    })
  | (AgentLoopEventBase & {
      type: "model_turn_finished";
      turn: number;
      observationCount: number;
    })
  | (AgentLoopEventBase & {
      type: "agent_loop_settled";
      status: AgentLoopResultStatus;
      reason?: AgentLoopStopReason | AgentLoopFailureReason;
    });

export type AgentLoopStopReason =
  | "max_turns"
  | "max_tool_calls"
  | "max_repeated_identical_calls"
  | "max_wall_time";

export type AgentLoopFailureReason =
  | "model_error"
  | "invalid_model_turn"
  | "completion_validator_error";

export type AgentLoopResultStatus =
  | "completed"
  | "waiting_user_input"
  | "plan_revision_proposed"
  | "stopped"
  | "aborted"
  | "failed";

type AgentLoopResultBase<
  TToolName extends string,
  TCompletion,
  TPlanRevision
> = {
  runId: string;
  transcript: AgentLoopMessage<TToolName, TCompletion, TPlanRevision>[];
  usage: AgentLoopUsage;
};

export type AgentLoopResult<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
> = AgentLoopResultBase<TToolName, TCompletion, TPlanRevision> &
  (
    | { status: "completed"; action: CompleteStepAction<TCompletion> }
    | { status: "waiting_user_input"; action: AskClarificationAction }
    | {
        status: "plan_revision_proposed";
        action: ProposePlanRevisionAction<TPlanRevision>;
      }
    | { status: "stopped"; reason: AgentLoopStopReason }
    | { status: "aborted" }
    | {
        status: "failed";
        reason: AgentLoopFailureReason;
        error: { code: string; message: string };
      }
  );

export type AgentLoopRunInput<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
> = {
  runId: string;
  stepId?: string;
  objective: string;
  transcript: readonly AgentLoopMessage<
    TToolName,
    TCompletion,
    TPlanRevision
  >[];
  capabilityEnvelope: AgentLoopCapabilityEnvelope<TToolName>;
  completionContract: unknown;
  budget: AgentLoopBudget;
  /** Persisted counters used when a clarification resumes the same run. */
  priorUsage?: AgentLoopUsage;
  /** Keeps persisted audit-event sequence numbers monotonic across resumes. */
  eventSequenceOffset?: number;
  /** Sequential is the safe default. */
  toolExecution?: "sequential" | "parallel_read_only";
};

export type AgentLoopKernelDependencies<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
> = {
  model: AgentTurnModel<TToolName, TCompletion, TPlanRevision>;
  tools: readonly AgentLoopToolDefinition<TToolName>[];
  policy: AgentLoopToolPolicy<TToolName, TCompletion, TPlanRevision>;
  executor: AgentLoopToolExecutor<TToolName, TCompletion, TPlanRevision>;
  validateCompletion: AgentLoopCompletionValidator<
    TToolName,
    TCompletion,
    TPlanRevision
  >;
  onEvent?: (event: AgentLoopEvent<TToolName>) => void;
  now?: () => number;
};

type EventPayload<TToolName extends string> = AgentLoopEvent<TToolName> extends
  infer TEvent
  ? TEvent extends AgentLoopEventBase
    ? Omit<TEvent, keyof AgentLoopEventBase>
    : never
  : never;

type PreparedToolCall<TToolName extends string> = {
  call: AgentLoopToolCall<TToolName>;
  tool: AgentLoopToolDefinition<TToolName>;
  startedAt: string;
};

type ToolBatchSlot<TToolName extends string> = {
  call: AgentLoopToolCall<TToolName>;
  prepared?: PreparedToolCall<TToolName>;
  result?: AgentLoopToolResultMessage<TToolName>;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function validateBudget(budget: AgentLoopBudget) {
  const positiveIntegerFields: Array<keyof AgentLoopBudget> = [
    "maxTurns",
    "maxRepeatedIdenticalCalls"
  ];
  for (const field of positiveIntegerFields) {
    if (!Number.isInteger(budget[field]) || budget[field] <= 0) {
      throw new RangeError(`${field} must be a positive integer.`);
    }
  }
  if (!Number.isInteger(budget.maxToolCalls) || budget.maxToolCalls < 0) {
    throw new RangeError("maxToolCalls must be a non-negative integer.");
  }
  if (!Number.isFinite(budget.maxWallTimeMs) || budget.maxWallTimeMs <= 0) {
    throw new RangeError("maxWallTimeMs must be a positive number.");
  }
}

function validateAssistantTurn(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return "模型返回的 assistant turn 不是对象。";
  }
  const turn = value as Partial<AgentAssistantTurn>;
  if (!isNonEmptyString(turn.turnId)) return "assistant turn 缺少 turnId。";
  if (!isNonEmptyString(turn.rationaleSummary)) {
    return "assistant turn 缺少可审计的 rationaleSummary。";
  }
  if (typeof turn.action !== "object" || turn.action === null) {
    return "assistant turn 缺少结构化 action。";
  }
  const action = turn.action as Record<string, unknown>;
  if (action.type === "tool_calls") {
    if (!Array.isArray(action.calls) || action.calls.length === 0) {
      return "tool_calls 必须包含至少一个调用。";
    }
    const callIds = new Set<string>();
    for (const candidate of action.calls) {
      if (typeof candidate !== "object" || candidate === null) {
        return "工具调用不是对象。";
      }
      const call = candidate as Record<string, unknown>;
      if (!isNonEmptyString(call.callId) || !isNonEmptyString(call.name)) {
        return "工具调用缺少 callId 或 name。";
      }
      if (callIds.has(call.callId)) {
        return `同一 assistant turn 中重复使用了 callId ${call.callId}。`;
      }
      callIds.add(call.callId);
      if (
        ![
          "read_only",
          "local_write",
          "external_write",
          "code_execution"
        ].includes(String(call.risk))
      ) {
        return `工具调用 ${call.callId} 缺少有效的 risk 声明。`;
      }
    }
    return null;
  }
  if (action.type === "complete_step") {
    return isNonEmptyString(action.summary)
      ? null
      : "complete_step 缺少 summary。";
  }
  if (action.type === "ask_clarification") {
    if (
      !isNonEmptyString(action.questionId) ||
      !isNonEmptyString(action.question) ||
      !isNonEmptyString(action.reason) ||
      typeof action.required !== "boolean"
    ) {
      return "ask_clarification 缺少必要字段。";
    }
    if (
      action.options !== undefined &&
      (!Array.isArray(action.options) ||
        !action.options.every(isNonEmptyString))
    ) {
      return "ask_clarification 的 options 必须是非空字符串数组。";
    }
    return null;
  }
  if (action.type === "propose_plan_revision") {
    if (!isNonEmptyString(action.reason) || !("proposal" in action)) {
      return "propose_plan_revision 缺少 reason 或 proposal。";
    }
    return null;
  }
  return `未知的 assistant action：${String(action.type)}。`;
}

function canonicalize(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return String(value);
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`;
  } else {
    result = `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalize(item, ancestors)}`
      )
      .join(",")}}`;
  }
  ancestors.delete(value);
  return result;
}

function callSignature<TToolName extends string>(
  call: AgentLoopToolCall<TToolName>
) {
  return `${call.name}:${canonicalize(call.input)}`;
}

function publicToolDefinition<TToolName extends string>(
  tool: AgentLoopToolDefinition<TToolName>
): AgentTurnToolDefinition<TToolName> {
  return {
    name: tool.name,
    description: tool.description,
    risk: tool.risk,
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {})
  };
}

/**
 * Reusable Agent loop kernel. It is deliberately restricted to a read-only
 * capability envelope; mutations must become a separately approved TaskPlan
 * revision outside this module.
 */
export class AgentLoopKernel<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
> {
  private readonly toolsByName: ReadonlyMap<
    TToolName,
    AgentLoopToolDefinition<TToolName>
  >;

  constructor(
    private readonly dependencies: AgentLoopKernelDependencies<
      TToolName,
      TCompletion,
      TPlanRevision
    >
  ) {
    const toolsByName = new Map<TToolName, AgentLoopToolDefinition<TToolName>>();
    for (const tool of dependencies.tools) {
      if (toolsByName.has(tool.name)) {
        throw new Error(`Duplicate Agent Loop tool registration: ${tool.name}`);
      }
      toolsByName.set(tool.name, tool);
    }
    this.toolsByName = toolsByName;
  }

  async run(
    input: AgentLoopRunInput<TToolName, TCompletion, TPlanRevision>,
    externalSignal?: AbortSignal
  ): Promise<AgentLoopResult<TToolName, TCompletion, TPlanRevision>> {
    validateBudget(input.budget);
    if (!isNonEmptyString(input.runId) || !isNonEmptyString(input.objective)) {
      throw new Error("Agent Loop requires a non-empty runId and objective.");
    }
    if (input.capabilityEnvelope.maxRisk !== "read_only") {
      throw new Error("First-stage Agent Loop maxRisk must be read_only.");
    }

    const now = this.dependencies.now ?? Date.now;
    const transcript = [...input.transcript];
    const transcriptTurns = transcript.filter(
      (message) => message.role === "assistant"
    ).length;
    const transcriptToolCalls = transcript.reduce((count, message) =>
      message.role === "assistant" && message.action.type === "tool_calls"
        ? count + message.action.calls.length
        : count, 0);
    const transcriptExecutedCalls = transcript.filter(
      (message) =>
        message.role === "toolResult" && message.status !== "blocked"
    ).length;
    if (input.priorUsage) {
      const persisted = input.priorUsage;
      const validCounters = [
        persisted.turns,
        persisted.toolCalls,
        persisted.executedToolCalls,
        persisted.elapsedMs
      ].every(
        (value) => Number.isSafeInteger(value) && value >= 0
      );
      if (
        !validCounters ||
        persisted.turns < transcriptTurns ||
        persisted.toolCalls < transcriptToolCalls ||
        persisted.executedToolCalls < transcriptExecutedCalls ||
        persisted.executedToolCalls > persisted.toolCalls ||
        persisted.turns > input.budget.maxTurns ||
        persisted.toolCalls > input.budget.maxToolCalls ||
        persisted.elapsedMs > input.budget.maxWallTimeMs
      ) {
        throw new Error(
          "Persisted Agent Loop usage is invalid or lower than the transcript-derived usage."
        );
      }
    }
    const usage = input.priorUsage
      ? { ...input.priorUsage }
      : {
          turns: transcriptTurns,
          toolCalls: transcriptToolCalls,
          executedToolCalls: transcriptExecutedCalls,
          elapsedMs: 0
        };
    const startedAtMs = now() - usage.elapsedMs;
    const callSignatures = new Map<string, number>();
    for (const message of transcript) {
      if (message.role !== "assistant" || message.action.type !== "tool_calls") {
        continue;
      }
      for (const call of message.action.calls) {
        const signature = callSignature(call);
        callSignatures.set(signature, (callSignatures.get(signature) ?? 0) + 1);
      }
    }
    const observedCallIds = new Set(
      transcript
        .filter(
          (message): message is AgentLoopToolResultMessage<TToolName> =>
            message.role === "toolResult"
        )
        .map((message) => message.callId)
    );
    const availableToolNames = new Set(input.capabilityEnvelope.allowedTools);
    const availableTools = [...this.toolsByName.values()]
      .filter(
        (tool) => availableToolNames.has(tool.name) && tool.risk === "read_only"
      )
      .map(publicToolDefinition);
    if (
      input.eventSequenceOffset !== undefined &&
      (!Number.isSafeInteger(input.eventSequenceOffset) ||
        input.eventSequenceOffset < 0)
    ) {
      throw new Error("Agent Loop eventSequenceOffset must be a non-negative integer.");
    }
    let eventSequence = input.eventSequenceOffset ?? 0;
    let timedOut = false;
    let externallyAborted = externalSignal?.aborted ?? false;
    const runController = new AbortController();
    const onExternalAbort = () => {
      externallyAborted = true;
      runController.abort();
    };
    if (externalSignal?.aborted) runController.abort();
    else externalSignal?.addEventListener("abort", onExternalAbort, {
      once: true
    });
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      runController.abort();
    }, Math.max(0, input.budget.maxWallTimeMs - usage.elapsedMs));

    const timestamp = () => new Date(now()).toISOString();
    const updateElapsed = () => {
      usage.elapsedMs = Math.max(0, now() - startedAtMs);
      if (usage.elapsedMs >= input.budget.maxWallTimeMs) {
        timedOut = true;
        runController.abort();
      }
    };
    const emit = (payload: EventPayload<TToolName>) => {
      this.dependencies.onEvent?.({
        ...payload,
        runId: input.runId,
        ...(input.stepId ? { stepId: input.stepId } : {}),
        sequence: ++eventSequence,
        at: timestamp()
      } as AgentLoopEvent<TToolName>);
    };
    const baseResult = () => {
      updateElapsed();
      return {
        runId: input.runId,
        transcript: [...transcript],
        usage: { ...usage }
      };
    };
    const settle = <TResult extends AgentLoopResult<
      TToolName,
      TCompletion,
      TPlanRevision
    >>(result: TResult): TResult => {
      emit({
        type: "agent_loop_settled",
        status: result.status,
        ...("reason" in result ? { reason: result.reason } : {})
      });
      return result;
    };
    const interruptionResult = () => {
      updateElapsed();
      if (externallyAborted) {
        return settle({ ...baseResult(), status: "aborted" as const });
      }
      return settle({
        ...baseResult(),
        status: "stopped" as const,
        reason: "max_wall_time" as const
      });
    };
    const interruptionPending = () => {
      updateElapsed();
      return externallyAborted || timedOut || runController.signal.aborted;
    };

    emit({ type: "agent_loop_started", objective: input.objective });

    try {
      while (true) {
        if (interruptionPending()) return interruptionResult();
        if (usage.turns >= input.budget.maxTurns) {
          return settle({
            ...baseResult(),
            status: "stopped",
            reason: "max_turns"
          });
        }

        const turnNumber = usage.turns + 1;
        usage.turns = turnNumber;
        emit({ type: "model_turn_started", turn: turnNumber });

        let turn: AgentAssistantTurn<
          TToolName,
          TCompletion,
          TPlanRevision
        >;
        try {
          updateElapsed();
          turn = await this.dependencies.model.generateTurn(
            {
              runId: input.runId,
              ...(input.stepId ? { stepId: input.stepId } : {}),
              objective: input.objective,
              turn: turnNumber,
              transcript: [...transcript],
              availableTools,
              completionContract: input.completionContract,
              remainingBudget: {
                turns: Math.max(0, input.budget.maxTurns - usage.turns),
                toolCalls: Math.max(
                  0,
                  input.budget.maxToolCalls - usage.toolCalls
                ),
                wallTimeMs: Math.max(
                  0,
                  input.budget.maxWallTimeMs - usage.elapsedMs
                )
              }
            },
            runController.signal
          );
        } catch (error) {
          if (interruptionPending()) return interruptionResult();
          return settle({
            ...baseResult(),
            status: "failed",
            reason: "model_error",
            error: {
              code: "MODEL_TURN_FAILED",
              message: errorMessage(error)
            }
          });
        }

        if (interruptionPending()) return interruptionResult();
        const invalidTurn = validateAssistantTurn(turn);
        if (invalidTurn) {
          return settle({
            ...baseResult(),
            status: "failed",
            reason: "invalid_model_turn",
            error: { code: "INVALID_MODEL_TURN", message: invalidTurn }
          });
        }

        const assistantMessage: AgentLoopAssistantMessage<
          TToolName,
          TCompletion,
          TPlanRevision
        > = {
          id: turn.turnId,
          role: "assistant",
          turnId: turn.turnId,
          rationaleSummary: turn.rationaleSummary,
          action: turn.action,
          createdAt: timestamp()
        };
        transcript.push(assistantMessage);
        emit({
          type: "assistant_turn_completed",
          turn: turnNumber,
          turnId: turn.turnId,
          actionType: turn.action.type,
          rationaleSummary: turn.rationaleSummary
        });

        if (turn.action.type === "complete_step") {
          let validation: CompletionValidationResult;
          try {
            validation = await this.dependencies.validateCompletion({
              runId: input.runId,
              ...(input.stepId ? { stepId: input.stepId } : {}),
              objective: input.objective,
              completionContract: input.completionContract,
              action: turn.action,
              transcript: [...transcript]
            });
          } catch (error) {
            return settle({
              ...baseResult(),
              status: "failed",
              reason: "completion_validator_error",
              error: {
                code: "COMPLETION_VALIDATOR_FAILED",
                message: errorMessage(error)
              }
            });
          }
          if (interruptionPending()) return interruptionResult();
          if (validation.ok === true) {
            assistantMessage.completionValidation = { status: "accepted" };
            emit({
              type: "model_turn_finished",
              turn: turnNumber,
              observationCount: 0
            });
            return settle({
              ...baseResult(),
              status: "completed",
              action: turn.action
            });
          }
          assistantMessage.completionValidation = {
            status: "rejected",
            code: validation.code,
            message: validation.message
          };
          emit({
            type: "completion_rejected",
            turn: turnNumber,
            code: validation.code,
            message: validation.message
          });
          emit({
            type: "model_turn_finished",
            turn: turnNumber,
            observationCount: 0
          });
          continue;
        }

        if (turn.action.type === "ask_clarification") {
          emit({
            type: "model_turn_finished",
            turn: turnNumber,
            observationCount: 0
          });
          return settle({
            ...baseResult(),
            status: "waiting_user_input",
            action: turn.action
          });
        }

        if (turn.action.type === "propose_plan_revision") {
          emit({
            type: "model_turn_finished",
            turn: turnNumber,
            observationCount: 0
          });
          return settle({
            ...baseResult(),
            status: "plan_revision_proposed",
            action: turn.action
          });
        }

        const batch = await this.prepareToolBatch({
          input,
          turn: turnNumber,
          calls: turn.action.calls,
          transcript,
          observedCallIds,
          callSignatures,
          usage,
          signal: runController.signal,
          timestamp,
          emit
        });

        const prepared = batch.slots.filter(
          (
            slot
          ): slot is ToolBatchSlot<TToolName> & {
            prepared: PreparedToolCall<TToolName>;
          } => slot.prepared !== undefined
        );
        const canRunInParallel =
          input.toolExecution === "parallel_read_only" &&
          input.capabilityEnvelope.allowParallelReads === true &&
          prepared.every(
            ({ prepared: item }) =>
              item.call.risk === "read_only" && item.tool.risk === "read_only"
          );

        if (canRunInParallel) {
          const results = await Promise.all(
            prepared.map(({ prepared: item }) =>
              this.executePreparedToolCall({
                input,
                turn: turnNumber,
                prepared: item,
                transcript,
                usage,
                signal: runController.signal,
                timestamp,
                emit
              })
            )
          );
          results.forEach((result, index) => {
            prepared[index].result = result;
          });
        } else {
          for (const slot of prepared) {
            if (interruptionPending()) {
              slot.result = this.failureToolResult(
                slot.call,
                "cancelled",
                "execution",
                "TOOL_CALL_CANCELLED",
                "工具调用已取消。",
                true,
                slot.prepared.startedAt,
                timestamp
              );
              continue;
            }
            slot.result = await this.executePreparedToolCall({
              input,
              turn: turnNumber,
              prepared: slot.prepared,
              transcript,
              usage,
              signal: runController.signal,
              timestamp,
              emit
            });
          }
        }

        const observations = batch.slots.map((slot) => {
          if (!slot.result) {
            return this.failureToolResult(
              slot.call,
              "cancelled",
              "execution",
              "TOOL_CALL_CANCELLED",
              "工具调用没有产生结果。",
              true,
              timestamp(),
              timestamp
            );
          }
          return slot.result;
        });
        transcript.push(...observations);
        emit({
          type: "model_turn_finished",
          turn: turnNumber,
          observationCount: observations.length
        });

        if (interruptionPending()) return interruptionResult();
        if (batch.stopReason) {
          return settle({
            ...baseResult(),
            status: "stopped",
            reason: batch.stopReason
          });
        }
      }
    } finally {
      clearTimeout(deadlineTimer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private async prepareToolBatch(args: {
    input: AgentLoopRunInput<TToolName, TCompletion, TPlanRevision>;
    turn: number;
    calls: readonly AgentLoopToolCall<TToolName>[];
    transcript: AgentLoopMessage<TToolName, TCompletion, TPlanRevision>[];
    observedCallIds: Set<string>;
    callSignatures: Map<string, number>;
    usage: AgentLoopUsage;
    signal: AbortSignal;
    timestamp: () => string;
    emit: (payload: EventPayload<TToolName>) => void;
  }): Promise<{
    slots: ToolBatchSlot<TToolName>[];
    stopReason: AgentLoopStopReason | null;
  }> {
    const slots: ToolBatchSlot<TToolName>[] = [];
    const batchSignatures = new Set<string>();
    let stopReason: AgentLoopStopReason | null = null;

    for (let call of args.calls) {
      const startedAt = args.timestamp();
      const slot: ToolBatchSlot<TToolName> = { call };
      slots.push(slot);

      if (stopReason) {
        slot.result = this.failureToolResult(
          call,
          "error",
          "budget",
          "TOOL_BATCH_STOPPED",
          "先前的工具调用已经耗尽本轮预算。",
          false,
          startedAt,
          args.timestamp
        );
        args.emit({
          type: "tool_call_completed",
          turn: args.turn,
          callId: call.callId,
          tool: call.name,
          status: "error",
          errorCode: "TOOL_BATCH_STOPPED"
        });
        continue;
      }
      if (args.usage.toolCalls >= args.input.budget.maxToolCalls) {
        stopReason = "max_tool_calls";
        slot.result = this.failureToolResult(
          call,
          "error",
          "budget",
          "MAX_TOOL_CALLS_EXCEEDED",
          "Agent Loop 已达到工具调用总数上限。",
          false,
          startedAt,
          args.timestamp
        );
        args.emit({
          type: "tool_call_completed",
          turn: args.turn,
          callId: call.callId,
          tool: call.name,
          status: "error",
          errorCode: "MAX_TOOL_CALLS_EXCEEDED"
        });
        continue;
      }
      args.usage.toolCalls += 1;

      const signature = callSignature(call);
      if (batchSignatures.has(signature)) {
        slot.result = this.failureToolResult(
          call,
          "blocked",
          "capability",
          "DUPLICATE_TOOL_CALL_IN_BATCH",
          `同一轮不能并行提交重复的 ${call.name} 调用。`,
          true,
          startedAt,
          args.timestamp
        );
        args.emit({
          type: "tool_call_blocked",
          turn: args.turn,
          callId: call.callId,
          tool: call.name,
          status: "blocked",
          errorCode: "DUPLICATE_TOOL_CALL_IN_BATCH"
        });
        continue;
      }
      batchSignatures.add(signature);
      const signatureCount = (args.callSignatures.get(signature) ?? 0) + 1;
      args.callSignatures.set(signature, signatureCount);
      if (
        signatureCount > args.input.budget.maxRepeatedIdenticalCalls
      ) {
        stopReason = "max_repeated_identical_calls";
        slot.result = this.failureToolResult(
          call,
          "error",
          "budget",
          "REPEATED_TOOL_CALL_LIMIT",
          `工具 ${call.name} 使用相同参数的调用次数超过上限。`,
          false,
          startedAt,
          args.timestamp
        );
        args.emit({
          type: "tool_call_completed",
          turn: args.turn,
          callId: call.callId,
          tool: call.name,
          status: "error",
          errorCode: "REPEATED_TOOL_CALL_LIMIT"
        });
        continue;
      }

      if (args.observedCallIds.has(call.callId)) {
        slot.result = this.failureToolResult(
          call,
          "error",
          "schema",
          "DUPLICATE_TOOL_CALL_ID",
          `callId ${call.callId} 已经存在。`,
          false,
          startedAt,
          args.timestamp
        );
        args.emit({
          type: "tool_call_completed",
          turn: args.turn,
          callId: call.callId,
          tool: call.name,
          status: "error",
          errorCode: "DUPLICATE_TOOL_CALL_ID"
        });
        continue;
      }
      args.observedCallIds.add(call.callId);

      const tool = this.toolsByName.get(call.name);
      if (!tool) {
        slot.result = this.failureToolResult(
          call,
          "blocked",
          "capability",
          "TOOL_NOT_REGISTERED",
          `工具 ${call.name} 未注册。`,
          false,
          startedAt,
          args.timestamp
        );
        args.emit({
          type: "tool_call_blocked",
          turn: args.turn,
          callId: call.callId,
          tool: call.name,
          status: "blocked",
          errorCode: "TOOL_NOT_REGISTERED"
        });
        continue;
      }
      if (!args.input.capabilityEnvelope.allowedTools.includes(call.name)) {
        slot.result = this.failureToolResult(
          call,
          "blocked",
          "capability",
          "TOOL_OUTSIDE_CAPABILITY_ENVELOPE",
          `工具 ${call.name} 不在当前步骤允许的能力范围内。`,
          false,
          startedAt,
          args.timestamp
        );
        args.emit({
          type: "tool_call_blocked",
          turn: args.turn,
          callId: call.callId,
          tool: call.name,
          status: "blocked",
          errorCode: "TOOL_OUTSIDE_CAPABILITY_ENVELOPE"
        });
        continue;
      }
      if (call.risk !== "read_only" || tool.risk !== "read_only") {
        slot.result = this.failureToolResult(
          call,
          "blocked",
          "capability",
          "RISK_EXCEEDS_CAPABILITY_ENVELOPE",
          "第一阶段 Agent Loop 只允许模型和工具均声明为只读的调用。",
          false,
          startedAt,
          args.timestamp
        );
        args.emit({
          type: "tool_call_blocked",
          turn: args.turn,
          callId: call.callId,
          tool: call.name,
          status: "blocked",
          errorCode: "RISK_EXCEEDS_CAPABILITY_ENVELOPE"
        });
        continue;
      }

      if (tool.validateInput) {
        let validation: AgentLoopToolInputValidation;
        try {
          validation = await tool.validateInput(call.input);
        } catch (error) {
          validation = {
            ok: false,
            code: "TOOL_SCHEMA_VALIDATOR_FAILED",
            message: errorMessage(error)
          };
        }
        if (validation.ok === false) {
          slot.result = this.failureToolResult(
            call,
            "error",
            "schema",
            validation.code ?? "TOOL_INPUT_INVALID",
            validation.message,
            true,
            startedAt,
            args.timestamp
          );
          args.emit({
            type: "tool_call_completed",
            turn: args.turn,
            callId: call.callId,
            tool: call.name,
            status: "error",
            errorCode: validation.code ?? "TOOL_INPUT_INVALID"
          });
          continue;
        }
        call = { ...call, input: validation.value };
        slot.call = call;
      }

      let policyDecision: BeforeToolPolicyDecision;
      try {
        policyDecision = await this.dependencies.policy.beforeToolCall(
          {
            runId: args.input.runId,
            ...(args.input.stepId ? { stepId: args.input.stepId } : {}),
            turn: args.turn,
            call,
            tool,
            capabilityEnvelope: args.input.capabilityEnvelope,
            transcript: [...args.transcript]
          },
          args.signal
        );
      } catch (error) {
        policyDecision = {
          decision: "block",
          code: "POLICY_EVALUATION_FAILED",
          message: errorMessage(error),
          retriable: true
        };
      }
      if (policyDecision.decision === "block") {
        slot.result = this.failureToolResult(
          call,
          "blocked",
          "policy",
          policyDecision.code,
          policyDecision.message,
          policyDecision.retriable ?? false,
          startedAt,
          args.timestamp
        );
        args.emit({
          type: "tool_call_blocked",
          turn: args.turn,
          callId: call.callId,
          tool: call.name,
          status: "blocked",
          errorCode: policyDecision.code
        });
        continue;
      }

      slot.prepared = { call, tool, startedAt };
    }

    return { slots, stopReason };
  }

  private async executePreparedToolCall(args: {
    input: AgentLoopRunInput<TToolName, TCompletion, TPlanRevision>;
    turn: number;
    prepared: PreparedToolCall<TToolName>;
    transcript: AgentLoopMessage<TToolName, TCompletion, TPlanRevision>[];
    usage: AgentLoopUsage;
    signal: AbortSignal;
    timestamp: () => string;
    emit: (payload: EventPayload<TToolName>) => void;
  }): Promise<AgentLoopToolResultMessage<TToolName>> {
    const { call, tool, startedAt } = args.prepared;
    args.emit({
      type: "tool_call_started",
      turn: args.turn,
      callId: call.callId,
      tool: call.name
    });
    args.usage.executedToolCalls += 1;

    let result: AgentLoopToolResultMessage<TToolName>;
    try {
      const execution = await this.dependencies.executor.execute(
        call,
        {
          runId: args.input.runId,
          ...(args.input.stepId ? { stepId: args.input.stepId } : {}),
          turn: args.turn,
          tool,
          transcript: [...args.transcript]
        },
        args.signal
      );
      if (
        typeof execution !== "object" ||
        execution === null ||
        typeof execution.ok !== "boolean"
      ) {
        result = this.failureToolResult(
          call,
          "error",
          "execution",
          "INVALID_TOOL_EXECUTION_RESULT",
          "工具执行器没有返回合法的结构化结果。",
          false,
          startedAt,
          args.timestamp
        );
      } else if (execution.ok === true) {
        result = {
          id: `tool-result:${call.callId}`,
          role: "toolResult",
          callId: call.callId,
          tool: call.name,
          status: "success",
          ...(execution.output !== undefined
            ? { output: execution.output }
            : {}),
          startedAt,
          finishedAt: args.timestamp()
        };
      } else {
        result = this.failureToolResult(
          call,
          "error",
          "execution",
          execution.error.code,
          execution.error.message,
          execution.error.retriable,
          startedAt,
          args.timestamp
        );
      }
    } catch (error) {
      const cancelled = args.signal.aborted;
      result = this.failureToolResult(
        call,
        cancelled ? "cancelled" : "error",
        "execution",
        cancelled ? "TOOL_CALL_CANCELLED" : "TOOL_EXECUTION_FAILED",
        cancelled ? "工具调用已取消。" : errorMessage(error),
        !cancelled,
        startedAt,
        args.timestamp
      );
    }

    args.emit({
      type: "tool_call_completed",
      turn: args.turn,
      callId: call.callId,
      tool: call.name,
      status: result.status,
      ...(result.error ? { errorCode: result.error.code } : {})
    });
    return result;
  }

  private failureToolResult(
    call: AgentLoopToolCall<TToolName>,
    status: "error" | "blocked" | "cancelled",
    kind: AgentLoopToolErrorKind,
    code: string,
    message: string,
    retriable: boolean,
    startedAt: string,
    timestamp: () => string
  ): AgentLoopToolResultMessage<TToolName> {
    return {
      id: `tool-result:${call.callId}`,
      role: "toolResult",
      callId: call.callId,
      tool: call.name,
      status,
      error: { kind, code, message, retriable },
      startedAt,
      finishedAt: timestamp()
    };
  }
}

export function runAgentLoop<
  TToolName extends string = string,
  TCompletion = unknown,
  TPlanRevision = unknown
>(
  dependencies: AgentLoopKernelDependencies<
    TToolName,
    TCompletion,
    TPlanRevision
  >,
  input: AgentLoopRunInput<TToolName, TCompletion, TPlanRevision>,
  signal?: AbortSignal
) {
  return new AgentLoopKernel(dependencies).run(input, signal);
}
