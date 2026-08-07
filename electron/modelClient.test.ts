import { describe, expect, it } from "vitest";
import type {
  AgentLoopMessage,
  AgentTurnContext
} from "../src/features/agent-core/agentLoop";
import type {
  AgentToolName,
  TaskPlanProposal
} from "../src/features/agent-core/types";
import { RemoteModelClient, type ModelFetch } from "./modelClient";

function responseWithToolCall(
  name: string,
  argumentsValue: unknown,
  callId: string
) {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: callId,
          type: "function",
          function: {
            name,
            arguments: JSON.stringify(argumentsValue)
          }
        }]
      }
    }]
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function context(
  turn: number,
  transcript: AgentLoopMessage<
    AgentToolName,
    unknown,
    TaskPlanProposal
  >[]
): AgentTurnContext<AgentToolName, unknown, TaskPlanProposal> {
  return {
    runId: "loop-test",
    stepId: "assess-environment",
    objective: "评估本机是否满足 PyTorch 环境要求。",
    turn,
    transcript,
    availableTools: [{
      name: "inspect_local_development_environment",
      description: "只读环境盘点",
      risk: "read_only"
    }],
    completionContract: {
      requireEvidence: true,
      criteria: ["列出已具备、缺少和无法确认项"]
    },
    remainingBudget: {
      turns: 6,
      toolCalls: 8,
      wallTimeMs: 60_000
    }
  };
}

describe("RemoteModelClient Agent Loop turns", () => {
  it("replays a native tool result before the model completes the next turn", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchRequest: ModelFetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return requestBodies.length === 1
        ? responseWithToolCall(
            "inspect_local_development_environment",
            {
              purpose: "盘点本机环境。",
              explanation: "需要真实版本证据。"
            },
            "inspect-call"
          )
        : responseWithToolCall(
            "complete_step",
            {
              summary: "本机环境初步匹配完成。",
              output: {
                available: ["Python 3.12"],
                missing: ["PyTorch package"],
                unresolved: ["CUDA build compatibility"]
              },
              evidence: [{
                source: "inspect_local_development_environment",
                reference: "inspect-call"
              }],
              explanation: "已根据只读探测结果完成评估。"
            },
            "complete-call"
          );
    };
    const client = new RemoteModelClient({
      XL_AGENT_LLM_PROVIDER: "openai-compatible",
      XL_AGENT_LLM_ENDPOINT: "https://api.deepseek.com/chat/completions",
      XL_AGENT_LLM_API_KEY: "test-secret",
      XL_AGENT_LLM_MODEL: "deepseek-chat"
    }, fetchRequest);
    const userMessage = {
      id: "objective",
      role: "user" as const,
      content: "检查 PyTorch 本机匹配程度。",
      createdAt: "2026-08-07T00:00:00.000Z"
    };

    const first = await client.requestTurn(
      context(1, [userMessage]),
      new AbortController().signal
    );
    expect(first.action).toMatchObject({
      type: "tool_calls",
      calls: [{
        callId: "inspect-call",
        name: "inspect_local_development_environment",
        input: {},
        risk: "read_only"
      }]
    });

    const assistantMessage = {
      ...first,
      id: first.turnId,
      role: "assistant" as const,
      createdAt: "2026-08-07T00:00:01.000Z"
    };
    const toolResult = {
      id: "tool-result:inspect-call",
      role: "toolResult" as const,
      callId: "inspect-call",
      tool: "inspect_local_development_environment" as const,
      status: "success" as const,
      output: {
        tools: [{ id: "python", status: "available", version: "3.12" }]
      },
      startedAt: "2026-08-07T00:00:01.000Z",
      finishedAt: "2026-08-07T00:00:02.000Z"
    };
    const second = await client.requestTurn(
      context(2, [userMessage, assistantMessage, toolResult]),
      new AbortController().signal
    );

    expect(second.action).toMatchObject({
      type: "complete_step",
      output: {
        available: ["Python 3.12"],
        missing: ["PyTorch package"]
      }
    });
    expect(requestBodies[0]).toMatchObject({
      model: "deepseek-chat",
      thinking: { type: "disabled" },
      tool_choice: "required"
    });
    const secondMessages = requestBodies[1].messages as Array<Record<string, unknown>>;
    expect(secondMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        tool_calls: [expect.objectContaining({ id: "inspect-call" })]
      }),
      expect.objectContaining({
        role: "tool",
        tool_call_id: "inspect-call",
        content: expect.stringContaining("3.12")
      })
    ]));
  });

  it("rejects an oversized provider response before parsing or persistence", async () => {
    const client = new RemoteModelClient({
      XL_AGENT_LLM_PROVIDER: "openai-compatible",
      XL_AGENT_LLM_ENDPOINT: "https://api.deepseek.com/chat/completions",
      XL_AGENT_LLM_API_KEY: "test-secret",
      XL_AGENT_LLM_MODEL: "deepseek-chat"
    }, async () => new Response("x".repeat(512 * 1024 + 1), { status: 200 }));

    await expect(client.requestTurn(
      context(1, []),
      new AbortController().signal
    )).rejects.toMatchObject({
      detail: { code: "MODEL_INVALID_RESPONSE" }
    });
  });
});
