import { describe, expect, it } from "vitest";
import { InMemoryAgentToolExecutor } from "./agentServices";
import { createInitialAgentState } from "./machine";
import type {
  AgentState,
  GitHubRepositorySearchOutput
} from "./types";

type CandidateSelector = {
  select(input: {
    task: string;
    candidates: Array<{
      fullName: string;
      description: string | null;
      stars: number;
      language: string | null;
      topics: string[];
    }>;
  }, signal?: AbortSignal): Promise<{
    decisionId: string;
    provider: "remote-llm";
    model: string;
    selectedFullNames: string[];
    reason: string;
  }>;
};

// CandidateSelector 尚未进入生产构造器；保持结构化的第九个依赖参数，
// 让测试先表达期望契约，而不会用 any 绕过调用侧类型检查。
const CandidateAwareExecutor = InMemoryAgentToolExecutor as unknown as new (
  ...dependencies: unknown[]
) => InMemoryAgentToolExecutor;

function planningState(task = "寻找 tau 项目"): AgentState {
  return {
    ...createInitialAgentState(),
    phase: "planning",
    task,
    routeDecision: {
      status: "supported",
      reason: "测试固定到 GitHub 项目检索。",
      skillId: "github-project-discovery",
      sourceProviderId: "github-api",
      userLinks: [],
      resourceIds: [],
      clarifications: [],
      requirements: null
    }
  };
}

function searchOutput(): GitHubRepositorySearchOutput {
  const repository = (
    id: number,
    fullName: string,
    description: string,
    stars: number
  ) => ({
    id,
    fullName,
    url: `https://github.com/${fullName}`,
    description,
    stars,
    forks: 10,
    openIssues: 2,
    language: "TypeScript",
    topics: ["agent", "developer-tools"],
    license: { spdxId: "MIT", name: "MIT License" },
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    pushedAt: "2026-08-01T00:00:00.000Z"
  });

  return {
    criteria: {
      mode: "name",
      query: "tau",
      match: "repository-name",
      order: "best-match",
      licenseRequired: true
    },
    repositories: [
      repository(1, "example/tau", "Unrelated project named tau", 5000),
      repository(2, "taubyte/tau", "Open-source coding platform", 2500)
    ],
    totalCount: 2,
    incompleteResults: false,
    fetchedAt: "2026-08-10T00:00:00.000Z",
    authenticated: false,
    rateLimit: { remaining: 9, resetAt: null }
  };
}

function executorWithSelector(
  selector: CandidateSelector,
  output: GitHubRepositorySearchOutput
) {
  return new CandidateAwareExecutor(
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ({ ok: true as const, output }),
    undefined,
    undefined,
    undefined,
    selector
  );
}

const searchCall = {
  callId: "github-search-tau",
  name: "search_github_repositories" as const,
  input: { mode: "name" as const, query: "tau", limit: 10 }
};

describe("GitHub candidate convergence in AgentServices", () => {
  it("attaches a validated recommendation when selector converges multiple candidates", async () => {
    const output = searchOutput();
    let selectorInput: Parameters<CandidateSelector["select"]>[0] | null = null;
    const tools = executorWithSelector({
      async select(input) {
        selectorInput = input;
        return {
          decisionId: "candidate-selection-1",
          provider: "remote-llm",
          model: "test-model",
          selectedFullNames: ["taubyte/tau"],
          reason: "描述与用户寻找开发工具项目的意图最匹配。"
        };
      }
    }, output);

    const result = await tools.execute(
      searchCall,
      planningState("寻找 tau 这个开发工具项目")
    );

    expect(selectorInput).toMatchObject({
      task: "寻找 tau 这个开发工具项目",
      candidates: [
        expect.objectContaining({ fullName: "example/tau" }),
        expect.objectContaining({ fullName: "taubyte/tau" })
      ]
    });
    expect(result).toMatchObject({
      status: "success",
      output: {
        recommendation: {
          selectedFullNames: ["taubyte/tau"],
          reason: "描述与用户寻找开发工具项目的意图最匹配。",
          source: "remote-llm"
        }
      }
    });
  });

  it("keeps the successful original search output when selector fails", async () => {
    const output = searchOutput();
    let selectorCalls = 0;
    const tools = executorWithSelector({
      async select() {
        selectorCalls += 1;
        throw new Error("selector unavailable");
      }
    }, output);

    const result = await tools.execute(searchCall, planningState());

    expect(selectorCalls).toBe(1);
    expect(result).toMatchObject({ status: "success", output });
    if (result.status !== "success") return;
    expect(result.output).toEqual(output);
  });
});
