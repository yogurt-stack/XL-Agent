import type { ModelRuntime } from "./interfaces";
import type {
  AgentAction,
  AgentState,
  AgentToolName,
  ModelContext,
  ModelDecision,
  ToolResult
} from "./types";

import { inferLocalTaskIntent } from "./taskRequirements";
import type { LocalTaskIntent } from "./types";

export { inferLocalTaskIntent } from "./taskRequirements";

type SupportedLocalIntent = Exclude<LocalTaskIntent, "ambiguous">;

const resourceIdsByIntent: Record<SupportedLocalIntent, string[]> = {
  "python-ai": ["python-312", "vscode", "git", "sample-project"],
  "fullstack-ai": ["python-312", "vscode", "git", "node-lts", "sample-project"],
  "base-development": ["vscode", "git"]
};

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

function resourceIdsForIntent(intent: SupportedLocalIntent, state: AgentState) {
  const resourceIds = [...resourceIdsByIntent[intent]];
  if (intent === "python-ai" && state.answers["python-scope"] === "同时准备 Node.js") {
    resourceIds.splice(3, 0, "node-lts");
  }
  if (intent === "fullstack-ai" && state.answers["fullstack-scope"] === "只准备全栈工具链") {
    return resourceIds.filter((resourceId) => resourceId !== "sample-project");
  }
  if (intent === "base-development" && state.answers["base-editor"] === "仅 Git 命令行") {
    return ["git"];
  }
  return resourceIds;
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

    const resourceIds = resourceIdsForIntent(intent, state);
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
