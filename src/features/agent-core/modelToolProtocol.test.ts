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
  it("publishes compatible closed schemas plus only the available runtime tools", () => {
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
          !("strict" in tool.function) &&
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

  it("registers and parses propose_task_plan as a model action without exposing runtime tools", () => {
    const tools = createOpenAiAgentTools([], ["propose_task_plan"]);
    expect(tools.map((tool) => tool.function.name)).toEqual([
      "propose_task_plan"
    ]);

    const decision = parseOpenAiToolDecision(
      toolCall("propose_task_plan", {
        proposal: {
          objective: "查找名为 tau 的 GitHub 仓库。",
          deliverables: ["GitHub 仓库候选列表"],
          assumptions: ["tau 是仓库名称。"],
          constraints: ["搜索阶段只读。"],
          steps: [{
            id: "search-tau",
            title: "搜索仓库",
            description: "按仓库名称调用 GitHub API。",
            kind: "read_tool",
            tool: "search_github_repositories",
            dependsOn: [],
            staticInput: { mode: "name", query: "tau", limit: 10 },
            inputBindings: {},
            expectedOutput: "带许可证的候选仓库",
            risk: "read_only",
            approval: { required: false, reason: null }
          }],
          confirmation: {
            required: true,
            reason: "工具调用前先确认处理流程。"
          }
        },
        explanation: "先确认目标与只读边界。"
      }),
      "test-model",
      ["search_github_repositories"],
      ["propose_task_plan"]
    );

    expect(decision.action).toMatchObject({
      type: "propose_task_plan",
      proposal: {
        objective: "查找名为 tau 的 GitHub 仓库。",
        confirmation: { required: true },
        steps: [{ tool: "search_github_repositories" }]
      }
    });
  });

  it("accepts provider metadata alongside the required tool_call fields", () => {
    const message = toolCall("finish", {
      summary: "完成。",
      explanation: "连接测试完成。"
    });
    const decision = parseOpenAiToolDecision(
      {
        ...message,
        tool_calls: message.tool_calls.map((call) => ({
          ...call,
          index: 0
        }))
      },
      "deepseek-v4-flash",
      []
    );

    expect(decision.action).toEqual({
      actionId: "call-test",
      type: "finish",
      summary: "完成。"
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

  it("publishes and parses the bounded GitHub repository search tool", () => {
    const tools = createOpenAiAgentTools(["search_github_repositories"]);
    expect(
      tools.find(
        (tool) => tool.function.name === "search_github_repositories"
      )
    ).toBeDefined();

    const decision = parseOpenAiToolDecision(
      toolCall("search_github_repositories", {
        mode: "discovery",
        keywords: "typescript",
        createdWithinDays: 30,
        sort: "stars",
        limit: 10,
        purpose: "查找近期热门 TypeScript 项目。",
        explanation: "用户明确要求 GitHub 开源项目榜单。"
      }),
      "test-model",
      ["search_github_repositories"]
    );

    expect(decision.action).toEqual({
      actionId: "call-test",
      type: "call_tool",
      purpose: "查找近期热门 TypeScript 项目。",
      call: {
        callId: "call-test",
        name: "search_github_repositories",
        input: {
          mode: "discovery",
          keywords: "typescript",
          createdWithinDays: 30,
          sort: "stars",
          limit: 10
        }
      }
    });
  });

  it("parses a repository-name GitHub search without discovery-only fields", () => {
    const decision = parseOpenAiToolDecision(
      toolCall("search_github_repositories", {
        mode: "name",
        query: "tau",
        limit: 10,
        purpose: "按仓库名查找 tau。",
        explanation: "用户明确给出了仓库名称。"
      }),
      "test-model",
      ["search_github_repositories"]
    );

    expect(decision.action).toMatchObject({
      type: "call_tool",
      call: {
        name: "search_github_repositories",
        input: { mode: "name", query: "tau", limit: 10 }
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
