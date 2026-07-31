import type { ModelRuntime } from "./interfaces";
import {
  githubSearchPurpose,
  githubSearchInputFromState,
  isGitHubRepositorySearchOutput,
  latestGitHubRepositorySearchResult
} from "./githubSearch";
import type {
  AgentAction,
  AgentState,
  AgentToolName,
  ModelContext,
  ModelDecision,
  ToolResult
} from "./types";

import {
  inferLocalTaskIntent,
  resourceIdsForCapabilities,
  resourceIdsForTaskIntent
} from "./taskRequirements";
import type { LocalTaskIntent } from "./types";
import { createLocalTaskPlanProposal } from "./taskPlanTemplates";

export { inferLocalTaskIntent } from "./taskRequirements";

type SupportedLocalIntent = Exclude<LocalTaskIntent, "ambiguous">;

const intentLabels: Record<SupportedLocalIntent, string> = {
  "python-ai": "Python AI 开发环境",
  "fullstack-ai": "全栈 AI 应用环境",
  "base-development": "基础开发工具环境"
};

const clarificationByIntent: Record<
  SupportedLocalIntent,
  { questionId: string; question: string; reason: string; options: string[] }
> = {
  "python-ai": {
    questionId: "python-scope",
    question: "Python AI 环境是否需要同时准备前端工具链？",
    reason: "只有需要开发可视化界面时才加入 Node.js，避免增加不必要资源。",
    options: ["仅 Python AI", "同时准备 Node.js"]
  },
  "fullstack-ai": {
    questionId: "fullstack-scope",
    question: "全栈环境是否需要包含可验证的示例项目？",
    reason: "示例项目可以验证工具链，但只准备基础工具时可以省略。",
    options: ["包含可验证示例项目", "只准备全栈工具链"]
  },
  "base-development": {
    questionId: "base-editor",
    question: "基础开发工具是否需要包含 Visual Studio Code？",
    reason: "仅使用 Git 命令行时可以不准备编辑器安装包。",
    options: ["包含 VS Code", "仅 Git 命令行"]
  }
};

function hasSuccessfulResult(results: ToolResult[], tool: AgentToolName) {
  return results.some((result) => result.tool === tool && result.status === "success");
}

function createActionId(context: ModelContext, suffix: string) {
  return `local-action-r${context.state.revision}-${context.step}-${context.state.phase}-${suffix}`;
}

function createDecision(context: ModelContext, action: AgentAction, explanation: string): ModelDecision {
  return {
    decisionId: `local-decision-r${context.state.revision}-${context.step}-${context.state.phase}`,
    provider: "local-rule",
    model: "xunlei-local-rules-v1",
    explanation,
    action
  };
}

function workloadAnswerFrom(state: AgentState) {
  const answer = state.answers["primary-workload"];
  return answer === "skipped" ? undefined : answer;
}

/**
 * 离线、确定性的最小模型适配器，用于在接入真实 LLM 前验证 Agent Action 协议。
 */
export class LocalRuleModelRuntime implements ModelRuntime {
  async decide(context: ModelContext): Promise<ModelDecision> {
    const { state } = context;

    if (context.step >= context.maxSteps) {
      return createDecision(
        context,
        {
          actionId: createActionId(context, "step-limit"),
          type: "finish",
          summary: `已达到 ${context.maxSteps} 步上限，停止自动决策并等待人工处理。`
        },
        "达到最小 Agent 的安全步数限制。"
      );
    }

    if (state.phase === "task_planning") {
      return createDecision(
        context,
        {
          actionId: createActionId(context, "task-plan"),
          type: "propose_task_plan",
          proposal: createLocalTaskPlanProposal(context),
          explanation:
            "已将首轮目标拆解为带依赖、风险和审批边界的 Task Plan；确认前不执行任何工具。"
        },
        "路由完成后先提出可审阅的任务计划，由用户确认流程再继续。"
      );
    }

    if (state.phase === "handoff") {
      return createDecision(
        context,
        {
          actionId: createActionId(context, "handoff"),
          type: "finish",
          summary: `工作区交接包 r${state.revision} 已准备完成。`
        },
        "资源已经验证，可以结束当前任务。"
      );
    }

    if (state.phase === "replanning") {
      const failedResource = state.resources.find((resource) => resource.status === "failed");
      const strategy =
        state.requestedReplanStrategy ?? (failedResource?.fallbackId ? "trusted-mirror" : "primary-retry");
      return createDecision(
        context,
        {
          actionId: createActionId(context, "replan"),
          type: "create_replan",
          strategy,
          explanation:
            strategy === "trusted-mirror"
              ? `资源 ${failedResource?.name ?? "未知资源"} 执行失败，改用可信目录中的备用来源。`
              : `资源 ${failedResource?.name ?? "未知资源"} 没有可信备用来源，重置后重试主来源。`
        },
        `已分析 ${state.replanReason ?? "未知"} 失败上下文，生成需要重新审批的替代计划。`
      );
    }

    if (state.routeDecision?.skillId === "github-project-discovery") {
      const result = latestGitHubRepositorySearchResult(state);
      if (!result) {
        const input = githubSearchInputFromState(state);
        return createDecision(
          context,
          {
            actionId: createActionId(context, "github-search"),
            type: "call_tool",
            purpose: githubSearchPurpose(input),
            call: {
              callId: `local-call-${context.step}-github-search`,
              name: "search_github_repositories",
              input
            }
          },
          "GitHub 仓库任务先执行一次与用户意图一致的受控只读查询。"
        );
      }
      const count =
        result.status === "success" &&
        isGitHubRepositorySearchOutput(result.output)
          ? result.output.repositories.length
          : 0;
      return createDecision(
        context,
        {
          actionId: createActionId(context, "github-finish"),
          type: "finish",
          summary:
            result.status === "success"
              ? `GitHub 公开仓库检索完成，共返回 ${count} 个带明确开源许可证的项目。`
              : `GitHub 公开仓库检索未完成：${result.error?.message ?? "未知错误"}`
        },
        "GitHub API Tool 已返回候选仓库；用户可在结果页选择仓库并进入固定提交与审批下载流程。"
      );
    }

    if (!hasSuccessfulResult(context.toolResults, "read_system_profile")) {
      return createDecision(
        context,
        {
          actionId: createActionId(context, "system-profile"),
          type: "call_tool",
          purpose: "确认资源计划适用的操作系统与架构。",
          call: {
            callId: `local-call-${context.step}-system-profile`,
            name: "read_system_profile",
            input: {}
          }
        },
        "生成资源计划前需要读取固定系统画像。"
      );
    }

    if (state.routeDecision?.status === "needs_links") {
      const resourceIds = state.routeDecision.resourceIds;
      if (!hasSuccessfulResult(context.toolResults, "search_trusted_catalog")) {
        return createDecision(
          context,
          {
            actionId: createActionId(context, "linked-resources"),
            type: "call_tool",
            purpose: "按用户明确提供并由 Provider 解析的链接读取可信资源元数据。",
            call: {
              callId: `local-call-${context.step}-linked-resources`,
              name: "search_trusted_catalog",
              input: {
                query: "用户明确提供的可信链接资源",
                resourceIds
              }
            }
          },
          "needs_links 路由不推荐新资源，只解析用户已经提供的可信链接。"
        );
      }
      return createDecision(
        context,
        {
          actionId: createActionId(context, "linked-plan"),
          type: "create_plan",
          resourceIds,
          explanation: "计划只包含用户明确提供且已由可信来源 Provider 精确解析的资源。"
        },
        "可信链接元数据已读取，可以生成不含额外推荐项的基础资源计划。"
      );
    }

    if (state.taskRequirements?.intent.startsWith("skill:")) {
      const resourceIds = resourceIdsForCapabilities(
        state.taskRequirements.requiredCapabilities
      );
      if (!hasSuccessfulResult(context.toolResults, "search_trusted_catalog")) {
        return createDecision(
          context,
          {
            actionId: createActionId(context, "domain-skill-catalog"),
            type: "call_tool",
            purpose: `查询${state.taskRequirements.label}所需的可信资源。`,
            call: {
              callId: `local-call-${context.step}-domain-skill-catalog`,
              name: "search_trusted_catalog",
              input: {
                query: state.taskRequirements.label,
                resourceIds
              }
            }
          },
          `Domain Skill 已定义必需能力，需要先核对可信来源 Provider。`
        );
      }
      return createDecision(
        context,
        {
          actionId: createActionId(context, "domain-skill-plan"),
          type: "create_plan",
          resourceIds,
          explanation: `根据 ${state.taskRequirements.label} Domain Skill 的能力需求生成资源组合。`
        },
        "Domain Skill 需求和可信目录查询已经完成，可以生成计划。"
      );
    }

    const intent = inferLocalTaskIntent(state.task, workloadAnswerFrom(state));
    if (intent === "ambiguous") {
      return createDecision(
        context,
        {
          actionId: createActionId(context, "clarification"),
          type: "ask_clarification",
          questionId: "primary-workload",
          question: "这个环境主要用于哪类开发？",
          reason: "当前任务没有提供足够信息，无法确定 Python、Node.js 和示例项目的资源组合。",
          required: true,
          options: ["Python AI 开发", "全栈 AI 应用", "仅准备基础环境"]
        },
        "自然语言任务缺少可确定工作负载的关键词。"
      );
    }

    const clarification = clarificationByIntent[intent];
    if (!state.answers[clarification.questionId]) {
      return createDecision(
        context,
        {
          actionId: createActionId(context, "intent-clarification"),
          type: "ask_clarification",
          questionId: clarification.questionId,
          question: clarification.question,
          reason: clarification.reason,
          required: true,
          options: clarification.options
        },
        `已识别为${intentLabels[intent]}，需要确认该领域的一项资源范围。`
      );
    }

    const resourceIds = resourceIdsForTaskIntent(intent, state.answers);
    if (!hasSuccessfulResult(context.toolResults, "search_trusted_catalog")) {
      return createDecision(
        context,
        {
          actionId: createActionId(context, "trusted-catalog"),
          type: "call_tool",
          purpose: `查询${intentLabels[intent]}所需的可信资源。`,
          call: {
            callId: `local-call-${context.step}-trusted-catalog`,
            name: "search_trusted_catalog",
            input: {
              query: intentLabels[intent],
              resourceIds
            }
          }
        },
        `已识别为${intentLabels[intent]}，需要先核对可信资源目录。`
      );
    }

    return createDecision(
      context,
      {
        actionId: createActionId(context, "plan"),
        type: "create_plan",
        resourceIds,
        explanation: `根据 Windows 11 x64 系统画像和${intentLabels[intent]}意图生成资源组合。`
      },
      `系统画像与可信目录查询完成，可以生成${intentLabels[intent]}计划。`
    );
  }
}
