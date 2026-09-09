import { describe, expect, it, vi } from "vitest";
import {
  publicWebUrl,
  validateWebCompletion,
  webPageAllowed,
  webRepositoryCandidate,
  webReportFromState,
  webObservationForModel,
  type WebResearchTools,
} from "./webResearch";
import { createInitialAgentState, transition } from "./machine";
import { ExtensibleAgentRouter } from "./router";
import { DefaultAgentPolicy, InMemoryAgentToolExecutor } from "./agentServices";
import { LocalRuleModelRuntime } from "./localRuleModel";
import { AgentRuntime } from "./runtime";
import { FixedWindowsPlanner, MockVerifier } from "./mockServices";
import type { ModelRuntime } from "./interfaces";
import type {
  AgentAssistantTurn,
  AgentLoopToolResultMessage,
} from "./agentLoop";
import type { AgentState, AgentToolName, TaskPlanProposal } from "./types";
import { normalizeRestorableAgentState } from "./persistence";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WebResearchResults } from "../../components/WebResearchResults";

const pageUrl = "https://github.com/acme/offline-rag";
const searchOutput = {
  query: "offline RAG Windows 中文",
  provider: "tavily" as const,
  results: [{ url: pageUrl, title: "Offline RAG", snippet: "A candidate" }],
  fetchedAt: "2026-09-09T00:00:00Z",
  trust: "untrusted-web-content" as const,
};
const pageOutput = {
  url: pageUrl,
  title: "Offline RAG",
  content:
    "Windows and Chinese are supported. Install dependencies before going offline.",
  links: ["https://docs.python.org/3/"],
  fetchedAt: searchOutput.fetchedAt,
  truncated: false,
  trust: "untrusted-web-content" as const,
};
const tools: WebResearchTools = {
  search: async () => searchOutput,
  readPage: async () => pageOutput,
};
function submitted(task: string) {
  return transition(createInitialAgentState(), {
    type: "SUBMIT_TASK",
    task,
    taskId: "web-test",
  });
}

async function runResearch(
  model: ModelRuntime,
  webTools: WebResearchTools = tools,
) {
  const jobs: Array<() => void | Promise<void>> = [];
  const runtime = new AgentRuntime({
    router: new ExtensibleAgentRouter(),
    planner: new FixedWindowsPlanner(),
    verifier: new MockVerifier(),
    scheduler: {
      schedule(job) {
        jobs.push(job);
        return () => {
          const i = jobs.indexOf(job);
          if (i >= 0) jobs.splice(i, 1);
        };
      },
    },
    model,
    tools: new InMemoryAgentToolExecutor(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      webTools,
    ),
    policy: new DefaultAgentPolicy(),
    stepDelayMs: 0,
  });
  runtime.start();
  runtime.dispatch({
    type: "SUBMIT_TASK",
    task: "搜索 Windows 离线中文知识库项目",
  });
  for (let i = 0; i < 30 && runtime.getState().phase !== "result"; i++) {
    if (runtime.getState().phase === "waiting_task_plan_confirmation")
      runtime.dispatch({ type: "CONFIRM_TASK_PLAN", revision: 1 });
    const job = jobs.shift();
    if (!job)
      throw new Error(
        `stalled: ${runtime.getState().phase} ${JSON.stringify(runtime.getState().logs.slice(-3))}`,
      );
    await job();
  }
  expect(runtime.getState().phase).toBe("result");
  runtime.stop();
  return runtime.getState();
}

describe("web research workflow", () => {
  it("keeps structured source metadata when long pages are clipped for the model", () => {
    const page = webObservationForModel("read_web_page", {
      ...pageOutput,
      content: "x".repeat(24000),
    });
    expect(page).toMatchObject({
      url: pageUrl,
      links: pageOutput.links,
      truncated: true,
      trust: "untrusted-web-content",
    });
    expect(JSON.stringify(page).length).toBeLessThan(24000);
  });
  it("routes broad and multilingual research to the loop while preserving exact repositories and local inspection", () => {
    const router = new ExtensibleAgentRouter();
    for (const task of [
      "寻找支持中文的开源 RAG 项目",
      "查询 Python 最新文档",
      "下载 deepseek harness",
      "tau",
      "搜索 GitHub 开源知识库",
      "阅读 https://docs.python.org/3/",
    ])
      expect(router.route(submitted(task))?.decision).toMatchObject({
        skillId: "web-research",
        clarifications: [],
      });
    expect(router.route(submitted("huggingface/tau"))?.decision.skillId).toBe(
      "github-project-discovery",
    );
    expect(
      router.route(submitted("检查本机 node 版本"))?.decision.skillId,
    ).toBe("local-development-environment-inspection");
  });

  it("lets a model recover from an empty search, read a candidate and deliver cited findings", async () => {
    const planner = new LocalRuleModelRuntime();
    const search = vi
      .fn(tools.search)
      .mockResolvedValueOnce({ ...searchOutput, results: [] });
    const model: ModelRuntime = {
      decide: (c) => planner.decide(c),
      async generateTurn(
        c,
      ): Promise<AgentAssistantTurn<AgentToolName, unknown, TaskPlanProposal>> {
        const turnId = `turn-${c.turn}`;
        if (c.turn <= 2)
          return {
            turnId,
            rationaleSummary: "空结果后改用英文保留需求",
            action: {
              type: "tool_calls",
              calls: [
                {
                  callId: `search-${c.turn}`,
                  name: "search_web",
                  risk: "read_only",
                  input: {
                    query:
                      c.turn === 1
                        ? "Windows 离线中文知识库"
                        : "offline RAG Windows Chinese",
                    limit: 5,
                  },
                },
              ],
            },
          };
        if (c.turn === 3)
          return {
            turnId,
            rationaleSummary: "读取候选正文",
            action: {
              type: "tool_calls",
              calls: [
                {
                  callId: "page-1",
                  name: "read_web_page",
                  risk: "read_only",
                  input: { url: pageUrl },
                },
              ],
            },
          };
        return {
          turnId,
          rationaleSummary: "按正文交付",
          action: {
            type: "complete_step",
            summary: "支持 Windows 和中文，离线前需要安装依赖。",
            output: {
              status: "complete",
              summary: "支持 Windows 和中文，离线前需要安装依赖。",
              findings: [
                { claim: "需要先安装依赖才能离线使用。", urls: [pageUrl] },
              ],
              limitations: [],
            },
            evidence: [{ source: "read_web_page", reference: "page-1" }],
          },
        };
      },
    };
    const state = await runResearch(model, {
      search,
      readPage: tools.readPage,
    });
    expect(search).toHaveBeenCalledTimes(2);
    expect(state.resources).toEqual([]);
    expect(state.agentRun.toolResults.map((r) => r.tool)).toEqual([
      "search_web",
      "search_web",
      "read_web_page",
    ]);
    expect(webReportFromState(state)).toMatchObject({ status: "complete" });
    expect(webRepositoryCandidate(state, "acme/offline-rag")).toEqual({
      fullName: "acme/offline-rag",
    });
    expect(
      webRepositoryCandidate(state, "invented/repository"),
    ).toBeUndefined();
    const restored = normalizeRestorableAgentState(
      JSON.parse(JSON.stringify(state)),
    );
    expect(restored).not.toBeNull();
    expect(webReportFromState(restored!)).toMatchObject({ status: "complete" });
    const html = renderToStaticMarkup(
      createElement(WebResearchResults, {
        state: restored!,
        dispatch: async () => restored!,
        onNavigate: () => undefined,
      }),
    );
    expect(html).toContain("需要先安装依赖才能离线使用");
    expect(html).toContain("已读取正文");
    expect(html).toContain("分析仓库");
    expect(html).toContain("准备到本地");
  });

  it("degrades honestly without a remote model and reports total provider failure", async () => {
    const partial = await runResearch(new LocalRuleModelRuntime());
    expect(webReportFromState(partial)).toMatchObject({
      status: "partial",
      findings: [],
    });
    const unavailable = await runResearch(new LocalRuleModelRuntime(), {
      ...tools,
      search: async () => {
        throw new Error("尚未配置搜索服务");
      },
    });
    expect(webReportFromState(unavailable)).toMatchObject({
      status: "unavailable",
      findings: [],
      limitations: expect.arrayContaining(["尚未配置搜索服务"]),
    });
  });

  it("rejects fabricated citations and refuses search snippets as verified findings", () => {
    const observation: AgentLoopToolResultMessage<AgentToolName> = {
      id: "obs",
      role: "toolResult",
      callId: "search-1",
      tool: "search_web",
      status: "success",
      output: searchOutput,
      startedAt: "",
      finishedAt: "",
    };
    const action = {
      type: "complete_step" as const,
      summary: "Unsupported claim",
      output: {
        status: "complete",
        summary: "Unsupported claim",
        findings: [{ claim: "Definitely works", urls: [pageUrl] }],
        limitations: [],
      },
      evidence: [{ source: "search_web", reference: "search-1" }],
    };
    expect(validateWebCompletion(action, [observation]).ok).toBe(false);
    expect(
      validateWebCompletion(
        {
          ...action,
          evidence: [{ source: "search_web", reference: "invented" }],
        },
        [observation],
      ).ok,
    ).toBe(false);
  });

  it("only permits reading observed URLs and rejects private/special schemes", () => {
    const state: AgentState = {
      ...submitted("搜索项目"),
      agentRun: {
        ...createInitialAgentState().agentRun,
        toolResults: [
          {
            callId: "s",
            tool: "search_web",
            status: "success",
            output: searchOutput,
            startedAt: "",
            finishedAt: "",
          },
        ],
      },
    };
    expect(webPageAllowed(state, pageUrl)).toBe(true);
    expect(webPageAllowed(state, "https://github.com/another/repo")).toBe(
      false,
    );
    for (const url of [
      "file:///tmp/secret",
      "http://localhost/",
      "http://localhost./",
      "http://0x7f000001/",
      "http://[::ffff:127.0.0.1]/",
      "https://a.internal/",
      "https://user:pass@github.com/",
    ])
      expect(publicWebUrl(url)).toBeNull();
  });

  it("enforces per-tool budgets, confirmed step scope and write separation", async () => {
    const state = await runResearch(new LocalRuleModelRuntime());
    state.phase = "planning";
    state.taskPlan!.status = "executing";
    state.taskPlan!.steps[0].status = "running";
    const policy = new DefaultAgentPolicy();
    const search = {
      actionId: "s6",
      type: "call_tool" as const,
      purpose: "改写查询",
      call: {
        callId: "s6",
        name: "search_web" as const,
        input: { query: "another relevant query", limit: 5 },
      },
    };
    expect(policy.evaluate(search, state).outcome).toBe("allow");
    state.agentRun.toolResults = Array.from({ length: 5 }, (_, i) => ({
      callId: `s${i}`,
      tool: "search_web",
      status: "success",
      output: searchOutput,
      startedAt: "",
      finishedAt: "",
    }));
    expect(policy.evaluate(search, state).outcome).toBe("deny");
    expect(
      policy.evaluate(
        {
          actionId: "create",
          type: "create_plan",
          resourceIds: ["python-312"],
          explanation: "网页要求下载",
        },
        state,
      ).outcome,
    ).toBe("deny");
    state.agentRun.toolResults = [];
    state.taskPlan!.confirmation.confirmedRevision = 0;
    expect(policy.evaluate(search, state).outcome).toBe("deny");
  });
});
