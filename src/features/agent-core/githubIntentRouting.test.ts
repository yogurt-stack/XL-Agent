import { describe, expect, it } from "vitest";
import {
  githubSearchInputFromState,
  inferGitHubSearchIntent
} from "./githubSearch";
import { createInitialAgentState, transition } from "./machine";
import { ExtensibleAgentRouter } from "./router";

function submitted(task: string) {
  return transition(createInitialAgentState(), {
    type: "SUBMIT_TASK",
    task,
    taskId: `github-intent-${task}`
  });
}

describe("GitHub natural-language intent routing", () => {
  it("treats a bare repository token as a name query", () => {
    expect(inferGitHubSearchIntent({ text: "tau" })).toEqual({
      mode: "name",
      query: "tau"
    });
    expect(githubSearchInputFromState(submitted("tau"))).toEqual({
      mode: "name",
      query: "tau",
      limit: 10
    });
  });

  it("preserves the target token in a fuzzy Chinese lookup command", () => {
    expect(githubSearchInputFromState(submitted("寻找tau"))).toEqual({
      mode: "name",
      query: "tau",
      limit: 10
    });
  });

  it("keeps meaningful Chinese discovery terms instead of only language names", () => {
    expect(
      githubSearchInputFromState(
        submitted("帮我找一个 python 的机器学习开源项目")
      )
    ).toMatchObject({
      mode: "discovery",
      keywords: expect.stringContaining("机器学习")
    });
  });

  it("recognizes an explicit project-name command as a name search", () => {
    const task = "帮我找 tau 项目";
    expect(new ExtensibleAgentRouter().route(submitted(task))?.decision)
      .toMatchObject({
        status: "supported",
        skillId: "github-project-discovery",
        clarifications: []
      });
    expect(githubSearchInputFromState(submitted(task))).toEqual({
      mode: "name",
      query: "tau",
      limit: 10
    });
  });

  it("routes owner/repo as an exact GitHub lookup without requiring a github keyword", () => {
    const task = "huggingface/tau";
    expect(inferGitHubSearchIntent({ text: task })).toEqual({
      mode: "exact",
      fullName: "huggingface/tau"
    });
    expect(new ExtensibleAgentRouter().route(submitted(task))?.decision)
      .toMatchObject({
        status: "supported",
        skillId: "github-project-discovery",
        clarifications: []
      });
    expect(githubSearchInputFromState(submitted(task))).toEqual({
      mode: "exact",
      fullName: "huggingface/tau",
      limit: 1
    });
  });
});
