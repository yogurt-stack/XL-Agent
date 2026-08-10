import { describe, expect, it, vi } from "vitest";
import { githubSearchInputFromState } from "./githubSearch";
import type { IntentClassifier } from "./intentClassifier";
import { createInitialAgentState, transition } from "./machine";
import { ExtensibleAgentRouter } from "./router";
import type { RouteIntentDecision } from "./intentSchemas";

function submitted(task: string) {
  return transition(createInitialAgentState(), {
    type: "SUBMIT_TASK",
    task,
    taskId: `semantic-route-${task}`
  });
}

function remoteDecision(
  overrides: Partial<RouteIntentDecision> = {}
): RouteIntentDecision {
  return {
    decisionId: "semantic-route-decision-1",
    provider: "remote-llm",
    model: "deepseek-chat",
    skillId: "github-project-discovery",
    githubSearch: { mode: "name", query: "tau" },
    reason: "用户的模糊表达指向名为 tau 的 GitHub 仓库。",
    ...overrides
  };
}

function fakeClassifier(
  classify: IntentClassifier["classify"]
): IntentClassifier & { classify: ReturnType<typeof vi.fn> } {
  return { classify: vi.fn(classify) };
}

describe("ExtensibleAgentRouter semantic intent fallback", () => {
  it("does not call the classifier when a deterministic skill matches", async () => {
    const classifier = fakeClassifier(async () => {
      throw new Error("classifier must not run");
    });
    const router = new ExtensibleAgentRouter(undefined, undefined, classifier);
    const state = submitted("检查本机 git 版本");

    const event = await router.routeWithIntent?.(
      state,
      new AbortController().signal
    );

    expect(event?.decision).toMatchObject({
      status: "supported",
      skillId: "local-development-environment-inspection",
      sourceProviderId: "electron-main"
    });
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it("uses a fake classifier for a fuzzy goal and preserves its GitHub name query", async () => {
    const classifier = fakeClassifier(async () => remoteDecision());
    const router = new ExtensibleAgentRouter(undefined, undefined, classifier);
    const state = submitted("目标是 tau");

    expect(router.route(state)?.decision.status).toBe("unsupported");

    const event = await router.routeWithIntent?.(
      state,
      new AbortController().signal
    );

    expect(event?.decision).toMatchObject({
      status: "supported",
      skillId: "github-project-discovery",
      sourceProviderId: "github-api",
      clarifications: [],
      semanticIntent: {
        source: "remote-llm",
        decisionId: "semantic-route-decision-1",
        model: "deepseek-chat",
        githubSearch: { mode: "name", query: "tau" }
      }
    });
    expect(classifier.classify).toHaveBeenCalledOnce();
    expect(classifier.classify).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "目标是 tau",
        links: [],
        skills: expect.arrayContaining([
          expect.objectContaining({
            id: "github-project-discovery",
            description: expect.stringContaining("GitHub")
          })
        ])
      }),
      expect.any(AbortSignal)
    );

    const routedState = transition(state, event!);
    expect(githubSearchInputFromState(routedState)).toEqual({
      mode: "name",
      query: "tau",
      limit: 10
    });
  });

  it("falls back to unsupported when the classifier names an unregistered skill", async () => {
    const classifier = fakeClassifier(async () => remoteDecision({
      skillId: "not-installed-skill",
      githubSearch: undefined,
      reason: "模型返回了一个未注册的能力。"
    }));
    const router = new ExtensibleAgentRouter(undefined, undefined, classifier);

    const event = await router.routeWithIntent?.(
      submitted("目标能力尚不明确"),
      new AbortController().signal
    );

    expect(event?.decision).toMatchObject({
      status: "unsupported",
      skillId: null,
      sourceProviderId: null
    });
    expect(event?.decision.semanticIntent).toBeUndefined();
    expect(classifier.classify).toHaveBeenCalledOnce();
  });

  it("falls back to unsupported when classification throws", async () => {
    const classifier = fakeClassifier(async () => {
      throw new Error("synthetic classifier failure");
    });
    const router = new ExtensibleAgentRouter(undefined, undefined, classifier);

    const event = await router.routeWithIntent?.(
      submitted("目标能力尚不明确"),
      new AbortController().signal
    );

    expect(event?.decision).toMatchObject({
      status: "unsupported",
      skillId: null,
      sourceProviderId: null
    });
    expect(classifier.classify).toHaveBeenCalledOnce();
  });

  it("does not ask the classifier to reinterpret an unrecognized URL", async () => {
    const classifier = fakeClassifier(async () => remoteDecision());
    const router = new ExtensibleAgentRouter(undefined, undefined, classifier);
    const task = "处理 https://untrusted.example.invalid/tau";

    const event = await router.routeWithIntent?.(
      submitted(task),
      new AbortController().signal
    );

    expect(event?.decision).toMatchObject({
      status: "unsupported",
      skillId: null,
      sourceProviderId: null,
      userLinks: ["https://untrusted.example.invalid/tau"]
    });
    expect(classifier.classify).not.toHaveBeenCalled();
  });
});
