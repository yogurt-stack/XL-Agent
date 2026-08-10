import { describe, expect, it, vi } from "vitest";
import { LlmIntentClassifier } from "./intentClassifier";
import {
  parseRouteIntentDecision,
  parseRouteIntentToolArguments
} from "./intentSchemas";

const validDecision = {
  decisionId: "route-intent-tau-1",
  provider: "remote-llm" as const,
  model: "deepseek-chat",
  skillId: "github-project-discovery",
  githubSearch: { mode: "name" as const, query: "tau" },
  reason: "用户想定位名为 tau 的开源仓库。"
};

describe("intent classification protocol", () => {
  it("accepts a strict GitHub name-search classification", async () => {
    expect(parseRouteIntentDecision(validDecision)).toEqual(validDecision);
    expect(parseRouteIntentToolArguments({
      skillId: "github-project-discovery",
      githubSearch: { mode: "name", query: "tau" },
      reason: "用户想定位名为 tau 的开源仓库。"
    })).toEqual({
      skillId: "github-project-discovery",
      githubSearch: { mode: "name", query: "tau" },
      reason: "用户想定位名为 tau 的开源仓库。"
    });

    const request = vi.fn().mockResolvedValue(validDecision);
    const classifier = new LlmIntentClassifier(request);

    await expect(classifier.classify({
      task: "目标是 tau",
      links: [],
      profile: {
        os: "Windows 11",
        architecture: "x64",
        shell: "PowerShell 7",
        workspaceRoot: "C:\\XunleiAgent\\ai-dev-env-windows"
      },
      skills: [{
        id: "github-project-discovery",
        displayName: "GitHub 开源项目检索",
        description: "从 GitHub 只读检索公开仓库。"
      }]
    })).resolves.toEqual(validDecision);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    ["rejects an untrusted provider", { ...validDecision, provider: "local-rule" }],
    [
      "rejects a GitHub hint attached to another skill",
      { ...validDecision, skillId: "ai-development-environment" }
    ],
    [
      "rejects an unsafe repository name query",
      {
        ...validDecision,
        githubSearch: { mode: "name", query: "owner/tau" }
      }
    ],
    ["rejects unknown fields", { ...validDecision, confidence: 0.99 }]
  ])("%s", async (_label, invalidDecision) => {
    expect(() => parseRouteIntentDecision(invalidDecision)).toThrow();

    const classifier = new LlmIntentClassifier(async () => invalidDecision);
    await expect(classifier.classify({
      task: "目标是 tau",
      links: [],
      profile: {
        os: "Windows 11",
        architecture: "x64",
        shell: "PowerShell 7",
        workspaceRoot: "C:\\XunleiAgent\\ai-dev-env-windows"
      },
      skills: []
    })).rejects.toThrow();
  });
});
