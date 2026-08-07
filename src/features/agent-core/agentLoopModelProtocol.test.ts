import { describe, expect, it } from "vitest";
import {
  AGENT_LOOP_CONTROL_TOOL_NAMES,
  AgentLoopModelProtocolError,
  createOpenAiAgentLoopTools,
  parseOpenAiAgentTurn
} from "./agentLoopModelProtocol";
import { createOpenAiAgentTools } from "./modelToolProtocol";

function nativeCall(name: string, value: unknown, id: string) {
  return {
    id,
    type: "function" as const,
    function: {
      name,
      arguments: typeof value === "string" ? value : JSON.stringify(value)
    }
  };
}

function nativeMessage(...toolCalls: ReturnType<typeof nativeCall>[]) {
  return {
    id: "assistant-turn-1",
    content: null,
    tool_calls: toolCalls
  };
}

const readProfileCall = (id = "read-profile") =>
  nativeCall(
    "read_system_profile",
    {
      purpose: "读取目标系统画像。",
      explanation: "需要系统架构证据才能判断兼容性。"
    },
    id
  );

const inspectEnvironmentCall = (id = "inspect-environment") =>
  nativeCall(
    "inspect_local_development_environment",
    {
      purpose: "盘点本机开发环境。",
      explanation: "需要本机工具版本证据才能完成匹配。"
    },
    id
  );

function expectProtocolError(
  run: () => unknown,
  kind?: AgentLoopModelProtocolError["kind"]
) {
  try {
    run();
    throw new Error("expected Agent Loop protocol validation to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentLoopModelProtocolError);
    if (kind) {
      expect((error as AgentLoopModelProtocolError).kind).toBe(kind);
    }
  }
}

describe("OpenAI-compatible Agent Loop model protocol", () => {
  it("reuses supplied runtime definitions and adds the three strict controls", () => {
    const legacyRuntimeTools = createOpenAiAgentTools(
      ["read_system_profile", "inspect_local_development_environment"],
      []
    );
    const tools = createOpenAiAgentLoopTools(legacyRuntimeTools);

    expect(tools.map((tool) => tool.function.name)).toEqual([
      ...AGENT_LOOP_CONTROL_TOOL_NAMES,
      "read_system_profile",
      "inspect_local_development_environment"
    ]);
    expect(tools[3]).toBe(legacyRuntimeTools[0]);
    expect(
      tools.slice(0, 3).every(
        (tool) => tool.function.parameters.additionalProperties === false
      )
    ).toBe(true);
  });

  it("selects supplied runtime definitions from a name-to-definition record", () => {
    const [profile, environment] = createOpenAiAgentTools(
      ["read_system_profile", "inspect_local_development_environment"],
      []
    );
    const tools = createOpenAiAgentLoopTools(
      {
        read_system_profile: profile,
        inspect_local_development_environment: environment
      },
      ["inspect_local_development_environment"]
    );

    expect(tools.map((tool) => tool.function.name)).toEqual([
      ...AGENT_LOOP_CONTROL_TOOL_NAMES,
      "inspect_local_development_environment"
    ]);
    expect(tools[3]).toBe(environment);
  });

  it("maps one legacy runtime call and derives risk from the host envelope", () => {
    const turn = parseOpenAiAgentTurn(
      nativeMessage(inspectEnvironmentCall()),
      "test-model",
      {
        availableRuntimeTools: ["inspect_local_development_environment"],
        maxCalls: 2
      }
    );

    expect(turn).toEqual({
      turnId: "assistant-turn-1",
      rationaleSummary: "需要本机工具版本证据才能完成匹配。",
      action: {
        type: "tool_calls",
        calls: [
          {
            callId: "inspect-environment",
            name: "inspect_local_development_environment",
            input: {},
            risk: "read_only"
          }
        ]
      }
    });
  });

  it("keeps two authorized parallel reads in provider order", () => {
    const turn = parseOpenAiAgentTurn(
      nativeMessage(readProfileCall(), inspectEnvironmentCall()),
      "test-model",
      {
        availableTools: [
          "read_system_profile",
          "inspect_local_development_environment"
        ],
        parallelReadTools: [
          "read_system_profile",
          "inspect_local_development_environment"
        ],
        maxCalls: 2
      }
    );

    expect(turn.action).toMatchObject({
      type: "tool_calls",
      calls: [
        { callId: "read-profile", name: "read_system_profile" },
        {
          callId: "inspect-environment",
          name: "inspect_local_development_environment"
        }
      ]
    });
    expect(turn.rationaleSummary).toBe(
      "需要系统架构证据才能判断兼容性。\n需要本机工具版本证据才能完成匹配。"
    );
  });

  it("rejects a control call mixed with a runtime call", () => {
    expectProtocolError(
      () =>
        parseOpenAiAgentTurn(
          nativeMessage(
            readProfileCall(),
            nativeCall(
              "complete_step",
              {
                summary: "完成。",
                output: { compatible: true },
                explanation: "证据充分。"
              },
              "complete"
            )
          ),
          "test-model",
          {
            availableTools: ["read_system_profile"],
            parallelReadTools: ["read_system_profile"],
            maxCalls: 2
          }
        ),
      "invalid-control-action"
    );
  });

  it("rejects clarification IDs that the renderer-to-Main protocol cannot answer", () => {
    expectProtocolError(
      () => parseOpenAiAgentTurn(
        nativeMessage(nativeCall("ask_clarification", {
          questionId: "q".repeat(121),
          question: "请补充目标版本。",
          reason: "缺少目标条件。",
          required: true,
          explanation: "需要用户输入。"
        }, "ask-too-long")),
        "test-model",
        { availableTools: [] }
      ),
      "invalid-control-action"
    );
  });

  it("rejects duplicate call IDs", () => {
    expectProtocolError(
      () =>
        parseOpenAiAgentTurn(
          nativeMessage(
            readProfileCall("duplicate"),
            inspectEnvironmentCall("duplicate")
          ),
          "test-model",
          {
            availableTools: [
              "read_system_profile",
              "inspect_local_development_environment"
            ],
            parallelReadTools: [
              "read_system_profile",
              "inspect_local_development_environment"
            ],
            maxCalls: 2
          }
        ),
      "invalid-tool-call"
    );
  });

  it("rejects the whole parallel batch when one member has malformed JSON", () => {
    expectProtocolError(
      () =>
        parseOpenAiAgentTurn(
          nativeMessage(
            readProfileCall(),
            nativeCall(
              "inspect_local_development_environment",
              "{malformed",
              "not-json"
            )
          ),
          "test-model",
          {
            availableTools: [
              "read_system_profile",
              "inspect_local_development_environment"
            ],
            parallelReadTools: [
              "read_system_profile",
              "inspect_local_development_environment"
            ],
            maxCalls: 2
          }
        ),
      "invalid-json"
    );
  });

  it("rejects multiple runtime calls when one is not parallel-authorized", () => {
    expectProtocolError(
      () =>
        parseOpenAiAgentTurn(
          nativeMessage(readProfileCall(), inspectEnvironmentCall()),
          "test-model",
          {
            availableTools: [
              "read_system_profile",
              "inspect_local_development_environment"
            ],
            parallelReadTools: ["read_system_profile"],
            maxCalls: 2
          }
        ),
      "invalid-tool-call"
    );
  });

  it("maps a strict complete_step control without leaking explanation into output", () => {
    const turn = parseOpenAiAgentTurn(
      nativeMessage(
        nativeCall(
          "complete_step",
          {
            summary: "本机环境评估完成。",
            output: {
              compatible: false,
              missing: ["CUDA Toolkit"]
            },
            evidence: [
              {
                source: "inspect_local_development_environment",
                reference: "tool-result:inspect-environment"
              }
            ],
            explanation: "已有可审计工具证据，可以提交评估结果。"
          },
          "complete"
        )
      ),
      "test-model",
      { availableTools: [], maxCalls: 1 }
    );

    expect(turn).toEqual({
      turnId: "assistant-turn-1",
      rationaleSummary: "已有可审计工具证据，可以提交评估结果。",
      action: {
        type: "complete_step",
        summary: "本机环境评估完成。",
        output: {
          compatible: false,
          missing: ["CUDA Toolkit"]
        },
        evidence: [
          {
            source: "inspect_local_development_environment",
            reference: "tool-result:inspect-environment"
          }
        ]
      }
    });
  });

  it("rejects control JSON that exceeds the bounded nesting depth", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 22; depth += 1) {
      nested = { next: nested };
    }
    expectProtocolError(
      () => parseOpenAiAgentTurn(
        nativeMessage(nativeCall("complete_step", {
          summary: "完成。",
          output: nested,
          explanation: "提交结果。"
        }, "too-deep")),
        "test-model",
        { availableTools: [] }
      ),
      "invalid-json"
    );
  });

  it("rejects content-only, empty, unavailable and truncated responses", () => {
    expectProtocolError(
      () =>
        parseOpenAiAgentTurn({ content: "done" }, "test-model", {
          availableTools: []
        }),
      "invalid-response"
    );
    expectProtocolError(
      () =>
        parseOpenAiAgentTurn({ tool_calls: [] }, "test-model", {
          availableTools: []
        }),
      "invalid-response"
    );
    expectProtocolError(
      () =>
        parseOpenAiAgentTurn(
          nativeMessage(readProfileCall()),
          "test-model",
          { availableTools: [] }
        ),
      "invalid-tool-call"
    );
    expectProtocolError(
      () =>
        parseOpenAiAgentTurn(
          { ...nativeMessage(readProfileCall()), finish_reason: "length" },
          "test-model",
          { availableTools: ["read_system_profile"] }
        ),
      "truncated-response"
    );
  });
});
