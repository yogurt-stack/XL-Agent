import { describe, expect, it, vi } from "vitest";
import {
  AgentLoopKernel,
  type AgentAssistantTurn,
  type AgentLoopBudget,
  type AgentLoopCompletionValidator,
  type AgentLoopKernelDependencies,
  type AgentLoopMessage,
  type AgentLoopRunInput,
  type AgentLoopToolExecutor,
  type AgentLoopToolPolicy,
  type AgentTurnContext,
  type AgentTurnModel
} from "./agentLoop";

type ToolName = "inspect_environment" | "write_environment";
type Completion = { assessment: string };
type PlanRevision = { objective: string };

const budget: AgentLoopBudget = {
  maxTurns: 5,
  maxToolCalls: 8,
  maxRepeatedIdenticalCalls: 2,
  maxWallTimeMs: 10_000
};

const initialTranscript: AgentLoopMessage<
  ToolName,
  Completion,
  PlanRevision
>[] = [
  {
    id: "user-1",
    role: "user",
    content: "检查本机环境并给出结论。",
    createdAt: "2026-08-07T00:00:00.000Z"
  }
];

function toolTurn(
  turnId: string,
  callId: string,
  name: ToolName = "inspect_environment",
  input: unknown = { target: "pytorch" }
): AgentAssistantTurn<ToolName, Completion, PlanRevision> {
  return {
    turnId,
    rationaleSummary: "需要先取得一项可验证的本机观察。",
    action: {
      type: "tool_calls",
      calls: [{ callId, name, input, risk: "read_only" }]
    }
  };
}

function completeTurn(
  turnId: string,
  assessment = "环境满足要求"
): AgentAssistantTurn<ToolName, Completion, PlanRevision> {
  return {
    turnId,
    rationaleSummary: "已有工具证据足以完成当前分析步骤。",
    action: {
      type: "complete_step",
      summary: "兼容性评估完成。",
      output: { assessment },
      evidence: [
        {
          source: "inspect_environment",
          reference: "tool-result:inspect-1"
        }
      ]
    }
  };
}

function runInput(
  overrides: Partial<
    AgentLoopRunInput<ToolName, Completion, PlanRevision>
  > = {}
): AgentLoopRunInput<ToolName, Completion, PlanRevision> {
  return {
    runId: "run-1",
    stepId: "assess-environment",
    objective: "评估本机开发环境",
    transcript: initialTranscript,
    capabilityEnvelope: {
      allowedTools: ["inspect_environment"],
      maxRisk: "read_only"
    },
    completionContract: {
      requiredFields: ["assessment"]
    },
    budget,
    ...overrides
  };
}

function kernelDependencies(
  model: AgentTurnModel<ToolName, Completion, PlanRevision>,
  overrides: Partial<
    AgentLoopKernelDependencies<ToolName, Completion, PlanRevision>
  > = {}
): AgentLoopKernelDependencies<ToolName, Completion, PlanRevision> {
  const policy: AgentLoopToolPolicy<ToolName, Completion, PlanRevision> = {
    beforeToolCall: () => ({ decision: "allow" })
  };
  const executor: AgentLoopToolExecutor<
    ToolName,
    Completion,
    PlanRevision
  > = {
    async execute() {
      return { ok: true, output: { python: "3.12.4" } };
    }
  };
  const validateCompletion: AgentLoopCompletionValidator<
    ToolName,
    Completion,
    PlanRevision
  > = ({ action }) =>
    action.output.assessment
      ? { ok: true }
      : {
          ok: false,
          code: "ASSESSMENT_REQUIRED",
          message: "缺少评估结论。"
        };
  return {
    model,
    tools: [
      {
        name: "inspect_environment",
        description: "只读检查本机环境。",
        risk: "read_only",
        inputSchema: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"]
        },
        validateInput(input) {
          return typeof input === "object" && input !== null
            ? { ok: true, value: input }
            : { ok: false, message: "input 必须是对象。" };
        }
      },
      {
        name: "write_environment",
        description: "修改本机环境。",
        risk: "local_write"
      }
    ],
    policy,
    executor,
    validateCompletion,
    ...overrides
  };
}

describe("AgentLoopKernel", () => {
  it("feeds a successful tool result into the next model turn", async () => {
    const contexts: AgentTurnContext<
      ToolName,
      Completion,
      PlanRevision
    >[] = [];
    const model: AgentTurnModel<ToolName, Completion, PlanRevision> = {
      async generateTurn(context) {
        contexts.push(context);
        return context.turn === 1
          ? toolTurn("turn-1", "inspect-1")
          : completeTurn("turn-2");
      }
    };
    const execute = vi.fn(async () => ({
      ok: true as const,
      output: { python: "3.12.4", cuda: null }
    }));
    const kernel = new AgentLoopKernel(
      kernelDependencies(model, { executor: { execute } })
    );

    const result = await kernel.run(runInput());

    expect(result.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(2);
    expect(
      contexts[1].transcript[contexts[1].transcript.length - 1]
    ).toMatchObject({
      role: "toolResult",
      callId: "inspect-1",
      tool: "inspect_environment",
      status: "success",
      output: { python: "3.12.4", cuda: null }
    });
  });

  it("does not execute a policy-blocked tool and exposes the block to the model", async () => {
    const contexts: AgentTurnContext<
      ToolName,
      Completion,
      PlanRevision
    >[] = [];
    const model: AgentTurnModel<ToolName, Completion, PlanRevision> = {
      async generateTurn(context) {
        contexts.push(context);
        return context.turn === 1
          ? toolTurn("turn-1", "inspect-1")
          : completeTurn("turn-2", "无法读取受策略保护的信息");
      }
    };
    const execute = vi.fn(async () => ({ ok: true as const }));
    const policy: AgentLoopToolPolicy<
      ToolName,
      Completion,
      PlanRevision
    > = {
      beforeToolCall: () => ({
        decision: "block",
        code: "PATH_SCOPE_DENIED",
        message: "请求超出已确认的路径范围。"
      })
    };
    const kernel = new AgentLoopKernel(
      kernelDependencies(model, { executor: { execute }, policy })
    );

    const result = await kernel.run(runInput());

    expect(result.status).toBe("completed");
    expect(execute).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(2);
    expect(
      contexts[1].transcript[contexts[1].transcript.length - 1]
    ).toMatchObject({
      role: "toolResult",
      callId: "inspect-1",
      status: "blocked",
      error: {
        kind: "policy",
        code: "PATH_SCOPE_DENIED"
      }
    });
  });

  it("never executes the same read call twice inside one parallel batch", async () => {
    const contexts: AgentTurnContext<
      ToolName,
      Completion,
      PlanRevision
    >[] = [];
    const model: AgentTurnModel<ToolName, Completion, PlanRevision> = {
      async generateTurn(context) {
        contexts.push(context);
        if (context.turn > 1) return completeTurn("turn-2");
        return {
          turnId: "turn-1",
          rationaleSummary: "请求并行读取环境。",
          action: {
            type: "tool_calls",
            calls: [
              {
                callId: "inspect-1",
                name: "inspect_environment",
                input: { target: "pytorch" },
                risk: "read_only"
              },
              {
                callId: "inspect-2",
                name: "inspect_environment",
                input: { target: "pytorch" },
                risk: "read_only"
              }
            ]
          }
        };
      }
    };
    const execute = vi.fn(async () => ({
      ok: true as const,
      output: { python: "3.12.4" }
    }));
    const kernel = new AgentLoopKernel(
      kernelDependencies(model, { executor: { execute } })
    );

    const result = await kernel.run(runInput({
      capabilityEnvelope: {
        allowedTools: ["inspect_environment"],
        maxRisk: "read_only",
        allowParallelReads: true
      },
      toolExecution: "parallel_read_only"
    }));

    expect(result.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(contexts[1].transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "toolResult",
        callId: "inspect-2",
        status: "blocked",
        error: expect.objectContaining({
          code: "DUPLICATE_TOOL_CALL_IN_BATCH"
        })
      })
    ]));
  });

  it("stops a repeated identical-call loop before executing beyond the budget", async () => {
    const model: AgentTurnModel<ToolName, Completion, PlanRevision> = {
      async generateTurn(context) {
        return toolTurn(`turn-${context.turn}`, `inspect-${context.turn}`);
      }
    };
    const execute = vi.fn(async () => ({
      ok: true as const,
      output: { python: "3.12.4" }
    }));
    const kernel = new AgentLoopKernel(
      kernelDependencies(model, { executor: { execute } })
    );

    const result = await kernel.run(
      runInput({
        budget: { ...budget, maxRepeatedIdenticalCalls: 1 }
      })
    );

    expect(result).toMatchObject({
      status: "stopped",
      reason: "max_repeated_identical_calls"
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.transcript[result.transcript.length - 1]).toMatchObject({
      role: "toolResult",
      callId: "inspect-2",
      status: "error",
      error: {
        kind: "budget",
        code: "REPEATED_TOOL_CALL_LIMIT"
      }
    });
  });

  it("rejects persisted usage lower than the supplied transcript", async () => {
    const model: AgentTurnModel<ToolName, Completion, PlanRevision> = {
      async generateTurn() {
        return completeTurn("should-not-run", "unused");
      }
    };
    const kernel = new AgentLoopKernel(kernelDependencies(model));
    const priorAssistant = toolTurn("prior-turn", "prior-inspect");

    await expect(kernel.run(runInput({
      transcript: [{
        ...priorAssistant,
        id: priorAssistant.turnId,
        role: "assistant",
        createdAt: "2026-08-07T00:00:00.000Z"
      }],
      priorUsage: {
        turns: 0,
        toolCalls: 0,
        executedToolCalls: 0,
        elapsedMs: 0
      }
    }))).rejects.toThrow(/lower than the transcript-derived usage/u);
  });

  it("settles only after the completion contract accepts complete_step", async () => {
    const model: AgentTurnModel<ToolName, Completion, PlanRevision> = {
      async generateTurn() {
        return completeTurn("turn-1", "所有必需项均有证据");
      }
    };
    const validateCompletion = vi.fn<
      AgentLoopCompletionValidator<ToolName, Completion, PlanRevision>
    >(() => ({ ok: true }));
    const events: string[] = [];
    const kernel = new AgentLoopKernel(
      kernelDependencies(model, {
        validateCompletion,
        onEvent(event) {
          events.push(event.type);
        }
      })
    );

    const result = await kernel.run(runInput());

    expect(validateCompletion).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "completed",
      action: {
        type: "complete_step",
        output: { assessment: "所有必需项均有证据" }
      }
    });
    expect(result.transcript[result.transcript.length - 1]).toMatchObject({
      role: "assistant",
      completionValidation: { status: "accepted" }
    });
    expect(events).toEqual([
      "agent_loop_started",
      "model_turn_started",
      "assistant_turn_completed",
      "model_turn_finished",
      "agent_loop_settled"
    ]);
  });

  it("continues turn, tool and event budgets when a clarified run resumes", async () => {
    const priorTranscript: AgentLoopMessage<
      ToolName,
      Completion,
      PlanRevision
    >[] = [
      ...initialTranscript,
      {
        id: "turn-1",
        role: "assistant",
        turnId: "turn-1",
        rationaleSummary: "需要用户确认目标版本。",
        action: {
          type: "ask_clarification",
          questionId: "target-version",
          question: "目标版本是什么？",
          reason: "缺少目标条件。",
          required: true
        },
        createdAt: "2026-08-07T00:00:01.000Z"
      },
      {
        id: "answer-1",
        role: "user",
        content: "目标版本是 2.7。",
        createdAt: "2026-08-07T00:00:02.000Z"
      }
    ];
    const seenTurns: number[] = [];
    const eventSequences: number[] = [];
    const model: AgentTurnModel<ToolName, Completion, PlanRevision> = {
      async generateTurn(context) {
        seenTurns.push(context.turn);
        return completeTurn(`turn-${context.turn}`);
      }
    };
    const kernel = new AgentLoopKernel(kernelDependencies(model, {
      onEvent(event) {
        eventSequences.push(event.sequence);
      }
    }));

    const result = await kernel.run(runInput({
      transcript: priorTranscript,
      priorUsage: {
        turns: 1,
        toolCalls: 0,
        executedToolCalls: 0,
        elapsedMs: 25
      },
      eventSequenceOffset: 7
    }));

    expect(result.status).toBe("completed");
    expect(seenTurns).toEqual([2]);
    expect(result.usage.turns).toBe(2);
    expect(eventSequences[0]).toBe(8);
  });
});
