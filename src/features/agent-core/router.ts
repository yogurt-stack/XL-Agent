import type { AgentRouter } from "./interfaces";
import type {
  AgentState,
  RouteDecision,
  TaskRequirements
} from "./types";
import {
  createDefaultDomainSkillRegistry,
  type DomainSkillRegistry,
  type UserGoal
} from "./domainSkills";
import {
  createDefaultSourceProviderRegistry,
  type SourceProviderRegistry
} from "./sourceProviders";

function stripTrailingPunctuation(value: string) {
  return value.replace(/[),.;!?，。；！？、）】》]+$/u, "");
}

export function extractHttpsLinks(text: string) {
  return [...text.matchAll(/https:\/\/[^\s<>"']+/giu)]
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
  constructor(
    private readonly skills: DomainSkillRegistry =
      createDefaultDomainSkillRegistry(),
    private readonly providers: SourceProviderRegistry =
      createDefaultSourceProviderRegistry()
  ) {}

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
    const skill = this.skills.match(skillGoal);

    if (skill) {
      const decision: RouteDecision = {
        status: "supported",
        reason: `任务匹配已安装的 ${skill.displayName} Domain Skill。`,
        skillId: skill.id,
        sourceProviderId: "trusted-catalog",
        userLinks: goal.links,
        resourceIds: [],
        clarifications: skill.clarify(skillGoal, state.systemProfile),
        requirements: null
      };
      return { type: "ROUTE_RESOLVED" as const, decision };
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
