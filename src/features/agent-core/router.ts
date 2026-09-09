import type { AgentRouter } from "./interfaces";
import type {
  AgentEvent,
  AgentState,
  RouteDecision,
  TaskRequirements
} from "./types";
import {
  createDefaultDomainSkillRegistry,
  type DomainSkill,
  type DomainSkillRegistry,
  type UserGoal
} from "./domainSkills";
import type {
  IntentClassifier,
  IntentClassifierContext
} from "./intentClassifier";
import type { RouteIntentDecision } from "./intentSchemas";
import {
  createDefaultSourceProviderRegistry,
  type SourceProviderRegistry
} from "./sourceProviders";

function stripTrailingPunctuation(value: string) {
  return value.replace(/[),.;!?，。；！？、）】》]+$/u, "");
}

export function extractHttpsLinks(text: string) {
  return [...text.matchAll(/https?:\/\/[^\s<>"']+/giu)]
    .map((match) => stripTrailingPunctuation(match[0]))
    .filter((link, index, links) => links.indexOf(link) === index);
}

function requirementsForLinks(
  resourceIds: string[],
  providers: SourceProviderRegistry
): TaskRequirements {
  const provider = providers.get("trusted-catalog");
  const resources = provider?.search({ resourceIds }) ?? [];
  return {
    intent: "user-links",
    label: "用户明确提供的可信链接资源",
    requiredCapabilities: [
      ...new Set(resources.flatMap((resource) => resource.provides))
    ]
  };
}

function goalFromState(state: AgentState): UserGoal {
  return {
    text: state.task,
    links: state.routeDecision?.userLinks ?? extractHttpsLinks(state.task)
  };
}

export class ExtensibleAgentRouter implements AgentRouter {
  readonly routeWithIntent?: AgentRouter["routeWithIntent"];

  constructor(
    private readonly skills: DomainSkillRegistry =
      createDefaultDomainSkillRegistry(),
    private readonly providers: SourceProviderRegistry =
      createDefaultSourceProviderRegistry(),
    private readonly classifier?: IntentClassifier
  ) {
    if (classifier) {
      this.routeWithIntent = (state, signal) =>
        this.routeUsingIntentClassifier(state, signal);
    }
  }

  route(state: AgentState) {
    if (state.phase !== "routing") return null;
    const goal = goalFromState(state);
    const skillGoal: UserGoal = {
      ...goal,
      text: goal.links.reduce(
        (text, link) => text.replace(link, " "),
        goal.text
      )
    };
    let skill = this.skills.match(skillGoal, state);
    if (skill?.id === "web-research" && goal.links.length &&
      !/(搜索|检索|阅读|查阅|研究|search|research|read)/iu.test(skillGoal.text) &&
      this.providers.list().some((provider) => provider.resolveUserLinks(goal.links).length === goal.links.length)) {
      skill = null;
    }

    if (skill) {
      return this.buildSkillDecision(skill, skillGoal, state);
    }

    if (goal.links.length > 0) {
      for (const provider of this.providers.list()) {
        const resources = provider.resolveUserLinks(goal.links);
        if (resources.length === goal.links.length) {
          const resourceIds = resources.map((resource) => resource.id);
          const decision: RouteDecision = {
            status: "needs_links",
            reason: "没有匹配的 Domain Skill，但所有用户链接均可由可信来源 Provider 精确解析。",
            skillId: null,
            sourceProviderId: provider.id,
            userLinks: goal.links,
            resourceIds,
            clarifications: [],
            requirements: requirementsForLinks(resourceIds, this.providers)
          };
          return { type: "ROUTE_RESOLVED" as const, decision };
        }
      }
    }

    const decision: RouteDecision = {
      status: "unsupported",
      reason:
        goal.links.length > 0
          ? "任务没有匹配的 Domain Skill，且用户链接不属于当前可信来源目录。"
          : "当前任务不属于已安装 Domain Skill 支持的资源准备需求，且未提供可验证的可信下载链接。",
      skillId: null,
      sourceProviderId: null,
      userLinks: goal.links,
      resourceIds: [],
      clarifications: [],
      requirements: null
    };
    return { type: "ROUTE_RESOLVED" as const, decision };
  }

  private buildSkillDecision(
    skill: DomainSkill,
    goal: UserGoal,
    state: AgentState,
    semantic?: RouteIntentDecision
  ): Extract<AgentEvent, { type: "ROUTE_RESOLVED" }> {
    const githubSearch =
      skill.id === "github-project-discovery"
        ? semantic?.githubSearch
        : undefined;
    const decision: RouteDecision = {
      status: "supported",
      reason: semantic
        ? `模型语义路由匹配 ${skill.displayName}：${semantic.reason}`
        : `任务匹配已安装的 ${skill.displayName} Domain Skill。`,
      skillId: skill.id,
      sourceProviderId: skill.sourceProviderId ?? "trusted-catalog",
      userLinks: goal.links,
      resourceIds: [],
      clarifications:
        githubSearch?.mode === "name"
          ? []
          : skill.clarify(goal, state.systemProfile),
      requirements: null,
      ...(semantic
        ? {
            semanticIntent: {
              source: "remote-llm" as const,
              decisionId: semantic.decisionId,
              model: semantic.model,
              reason: semantic.reason,
              ...(githubSearch ? { githubSearch } : {})
            }
          }
        : {})
    };
    return { type: "ROUTE_RESOLVED", decision };
  }

  private classifierContext(
    state: AgentState,
    goal: UserGoal
  ): IntentClassifierContext {
    return {
      task: goal.text,
      links: [...goal.links],
      profile: state.systemProfile,
      skills: this.skills.list().map((skill) => ({
        id: skill.id,
        displayName: skill.displayName,
        description: skill.describeForModel?.() ?? skill.displayName
      }))
    };
  }

  private semanticSkillAllowed(skillId: string, state: AgentState) {
    if (skillId === "local-project-environment-compatibility") {
      return Boolean(state.localRepository);
    }
    if (skillId === "github-project-environment-compatibility") {
      return Boolean(state.githubRepository);
    }
    return true;
  }

  private async routeUsingIntentClassifier(
    state: AgentState,
    signal: AbortSignal
  ) {
    const deterministic = this.route(state);
    if (
      !deterministic ||
      deterministic.decision.status !== "unsupported" ||
      deterministic.decision.userLinks.length > 0 ||
      !this.classifier
    ) {
      return deterministic;
    }

    const goal = goalFromState(state);
    try {
      const semantic = await this.classifier.classify(
        this.classifierContext(state, goal),
        signal
      );
      if (signal.aborted) {
        throw new DOMException("Intent classification aborted.", "AbortError");
      }
      if (!semantic.skillId) {
        return {
          ...deterministic,
          decision: {
            ...deterministic.decision,
            reason: `${deterministic.decision.reason} 模型语义分类未匹配已安装能力：${semantic.reason}`
          }
        };
      }
      const skill = this.skills.get(semantic.skillId);
      if (!skill || !this.semanticSkillAllowed(skill.id, state)) {
        return deterministic;
      }
      return this.buildSkillDecision(skill, goal, state, semantic);
    } catch (error) {
      if (signal.aborted) throw error;
      return deterministic;
    }
  }

  resolveRequirements(state: AgentState): TaskRequirements | null {
    if (
      state.phase !== "planning" ||
      state.routeDecision?.status !== "supported" ||
      !state.routeDecision.skillId
    ) {
      return state.taskRequirements;
    }
    const skill = this.skills.get(state.routeDecision.skillId);
    if (!skill) return null;
    const requirements = skill.buildRequirements({
      goal: goalFromState(state),
      profile: state.systemProfile,
      answers: state.answers
    });
    return {
      intent: `skill:${skill.id}`,
      label: skill.displayName,
      requiredCapabilities: [
        ...new Set(
          requirements
            .filter((requirement) => requirement.required)
            .map((requirement) => requirement.capability)
        )
      ]
    };
  }
}
