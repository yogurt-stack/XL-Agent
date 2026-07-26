import { describe, expect, it } from "vitest";
import {
  createOpenAiAgentTools,
  ModelToolProtocolError,
  parseOpenAiToolDecision
} from "./modelToolProtocol";

function toolCall(
  name: string,
  value: unknown,
  id = "call-test"
) {
  return {
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: {
          name,
          arguments:
            typeof value === "string" ? value : JSON.stringify(value)
        }
      }
    ]
  };
}

describe("native OpenAI tool protocol", () => {
  it("publishes strict action tools plus only the available runtime tools", () => {
    const tools = createOpenAiAgentTools([
      "read_system_profile",
      "controlled_download"
    ]);
    const names = tools.map((tool) => tool.function.name);

    expect(names).toContain("create_plan");
    expect(names).toContain("read_system_profile");
    expect(names).toContain("controlled_download");
    expect(names).not.toContain("simulate_download");
    expect(
      tools.every(
        (tool) =>
          tool.function.strict &&
          tool.function.parameters.additionalProperties === false
      )
    ).toBe(true);
  });

  it("maps exactly one native action tool_call to ModelDecision", () => {
    const decision = parseOpenAiToolDecision(
      toolCall("create_plan", {
        resourceIds: ["python-3.12"],
        explanation: "可信目录已经返回完成目标所需的资源。"
      }),
      "test-model",
      ["search_trusted_catalog"]
    );

    expect(decision).toMatchObject({
      decisionId: "call-test",
      provider: "remote-llm",
      model: "test-model",
      action: {
        actionId: "call-test",
        type: "create_plan",
        resourceIds: ["python-3.12"]
      }
    });
  });

  it("maps an allowed runtime tool and removes host-only explanation fields", () => {
    const decision = parseOpenAiToolDecision(
      toolCall("controlled_download", {
        resourceId: "python-3.12",
        purpose: "下载当前已审批资源。",
        explanation: "当前状态允许执行下载。"
      }),
      "test-model",
      ["controlled_download"]
    );

    expect(decision.action).toEqual({
      actionId: "call-test",
      type: "call_tool",
      purpose: "下载当前已审批资源。",
      call: {
        callId: "call-test",
        name: "controlled_download",
        input: { resourceId: "python-3.12" }
      }
    });
  });

  it.each([
    [
      "content-only response",
      { content: "{\"action\":\"finish\"}" },
      "invalid-response"
    ],
    [
      "multiple tool calls",
      {
        tool_calls: [
          toolCall("finish", {
            summary: "完成。",
            explanation: "完成。"
          }).tool_calls[0],
          toolCall(
            "finish",
            { summary: "再次完成。", explanation: "再次完成。" },
            "call-two"
          ).tool_calls[0]
        ]
      },
      "invalid-response"
    ],
    [
      "malformed arguments",
      toolCall("finish", "not-json"),
      "invalid-json"
    ],
    [
      "extra argument",
      toolCall("finish", {
        summary: "完成。",
        explanation: "完成。",
        extra: true
      }),
      "invalid-decision"
    ],
    [
      "unavailable runtime tool",
      toolCall("controlled_download", {
        resourceId: "python-3.12",
        purpose: "下载。",
        explanation: "下载。"
      }),
      "invalid-decision"
    ]
  ])("rejects %s", (_label, message, kind) => {
    try {
      parseOpenAiToolDecision(message, "test-model", []);
      throw new Error("expected protocol validation to reject the message");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelToolProtocolError);
      expect((error as ModelToolProtocolError).kind).toBe(kind);
    }
  });
});
