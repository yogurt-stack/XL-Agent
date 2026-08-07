import type { ModelRuntime } from "./interfaces";
import type {
  AgentAssistantTurn,
  AgentLoopToolResultMessage,
  AgentTurnContext
} from "./agentLoop";
import {
  githubSearchPurpose,
  githubSearchInputFromState,
  isGitHubRepositorySearchOutput,
  latestGitHubRepositorySearchResult
} from "./githubSearch";
import {
  isLocalDevelopmentEnvironmentOutput,
  latestLocalDevelopmentEnvironmentResult
} from "./developmentEnvironment";
import {
  isGitHubRepositoryTreeOutput,
  isLocalRepositoryTreeOutput,
  isProjectRequirementsOutput
} from "./projectRequirements";
import { buildProjectCompatibilityAssessment } from "./projectCompatibility";
import type {
  AgentAction,
  AgentState,
  AgentToolName,
  ModelContext,
  ModelDecision,
  ToolResult
} from "./types";
import type { TaskPlanProposal } from "./types";

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
  async generateTurn(
    context: AgentTurnContext<AgentToolName, unknown, TaskPlanProposal>,
    signal: AbortSignal
  ): Promise<AgentAssistantTurn<AgentToolName, unknown, TaskPlanProposal>> {
    if (signal.aborted) throw new DOMException("Agent Loop 已取消。", "AbortError");
    const turnId = `local-loop-${context.runId}-${context.turn}`
      .replace(/[^a-z0-9._-]/giu, "-")
      .slice(0, 160);
    if (
      context.availableTools.some((tool) =>
        tool.name === "inspect_project_requirements" ||
        tool.name === "inspect_github_project_requirements"
      )
    ) {
      return this.generateProjectCompatibilityTurn(
        context,
        turnId
      );
    }
    const observation = [...context.transcript].reverse().find(
      (message): message is AgentLoopToolResultMessage<AgentToolName> =>
        message.role === "toolResult" &&
        message.tool === "inspect_local_development_environment"
    );
    if (!observation) {
      return {
        turnId,
        rationaleSummary:
          "兼容性评估尚无本机证据，先调用已授权的固定白名单环境探测工具。",
        action: {
          type: "tool_calls",
          calls: [{
            callId: `${turnId}-inspect`.slice(0, 160),
            name: "inspect_local_development_environment",
            input: {},
            risk: "read_only"
          }]
        }
      };
    }
    if (
      observation.status !== "success" ||
      !isLocalDevelopmentEnvironmentOutput(observation.output)
    ) {
      return {
        turnId,
        rationaleSummary:
          "只读探测没有返回可用证据，当前只能交付无法确认的结论，不能转为下载任务。",
        action: {
          type: "complete_step",
          summary: `本机环境兼容性无法确认：${observation.error?.message ?? "环境探测未成功"}。`,
          output: {
            overallCompatibility: "unresolved",
            observedTools: [],
            unresolved: ["本机开发环境探测未成功"],
            conflicts: [],
            proposedNextActions: []
          },
          evidence: [{
            source: observation.tool,
            reference: observation.callId,
            summary: observation.error?.message ?? "环境探测未成功"
          }]
        }
      };
    }
    const availableCount = observation.output.tools.filter(
      (tool) => tool.status === "available"
    ).length;
    const missingCount = observation.output.tools.filter(
      (tool) => tool.status === "not_found"
    ).length;
    const observedTools = observation.output.tools.map((tool) => ({
      toolId: tool.id,
      status: tool.status,
      observedVersion: tool.version,
      observedDetail: tool.detail
    }));
    const unresolved = [
      ...observation.output.tools
        .filter(
          (tool) =>
            tool.status === "not_applicable" || tool.status === "error"
        )
        .map(
          (tool) =>
            `${tool.name}: ${tool.detail ?? "当前固定探测未能确认状态"}`
        ),
      "目标框架 Python 包版本与可导入状态未被当前只读工具覆盖",
      "项目级依赖、GPU 架构与框架构建版本兼容性尚未确认"
    ];
    return {
      turnId,
      rationaleSummary:
        "已读取本机探测结果；可用命令可判定为已具备，未找到项列为缺少，工具范围外条件保持无法确认。",
      action: {
        type: "complete_step",
        summary:
          `兼容性初步评估完成：已确认 ${availableCount} 项可用，` +
          `${missingCount} 项未找到，另有 ${unresolved.length} 类目标条件无法由当前工具确认。`,
        output: {
          overallCompatibility: "unresolved",
          observedTools,
          unresolved,
          conflicts: [],
          proposedNextActions: [
            "如需补全缺失项，先创建新的 Task Plan revision 并单独审批。"
          ]
        },
        evidence: [{
          source: observation.tool,
          reference: observation.callId,
          summary: `读取了 ${observation.output.tools.length} 个固定命令入口的状态。`
        }]
      }
    };
  }

  private generateProjectCompatibilityTurn(
    context: AgentTurnContext<AgentToolName, unknown, TaskPlanProposal>,
    turnId: string
  ): AgentAssistantTurn<AgentToolName, unknown, TaskPlanProposal> {
    const userContext = context.transcript
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n");
    const githubMode = context.availableTools.some(
      (tool) => tool.name === "inspect_github_project_requirements"
    );
    const repositoryHandleId = userContext.match(
      githubMode
        ? /github-repo-[a-z0-9-]{1,120}/iu
        : /local-repo-[a-z0-9-]{1,120}/iu
    )?.[0];
    const treeTool = githubMode
      ? "list_github_repository_tree" as const
      : "list_local_repository_tree" as const;
    const requirementsTool = githubMode
      ? "inspect_github_project_requirements" as const
      : "inspect_project_requirements" as const;
    if (!repositoryHandleId) {
      return {
        turnId,
        rationaleSummary: githubMode
          ? "当前分析步骤缺少可绑定的 GitHub 固定仓库句柄，需要从查询结果重新选择。"
          : "当前分析步骤缺少可绑定的本地仓库句柄，需要用户重新导入仓库。",
        action: {
          type: "ask_clarification",
          questionId: githubMode
            ? "reattach-github-repository"
            : "reimport-local-repository",
          question: githubMode
            ? "请返回 GitHub 查询结果，重新选择需要分析的仓库。"
            : "请重新导入需要分析的本地 Git 仓库，然后再次提交项目环境分析任务。",
          reason: "只读工具必须绑定当前应用会话中的固定仓库句柄。",
          required: true
        }
      };
    }
    const observations = context.transcript.filter(
      (message): message is AgentLoopToolResultMessage<AgentToolName> =>
        message.role === "toolResult"
    );
    const tree = [...observations].reverse().find(
      (message) => message.tool === treeTool
    );
    if (!tree) {
      return {
        turnId,
        rationaleSummary: "先确认固定 HEAD 中有哪些已跟踪项目文件，再决定读取哪些依赖证据。",
        action: {
          type: "tool_calls",
          calls: [{
            callId: `${turnId}-tree`.slice(0, 160),
            name: treeTool,
            input: { repositoryHandleId, maxEntries: 500 },
            risk: "read_only"
          }]
        }
      };
    }
    const validTree = githubMode
      ? isGitHubRepositoryTreeOutput(tree.output)
      : isLocalRepositoryTreeOutput(tree.output);
    if (tree.status !== "success" || !validTree) {
      return {
        turnId,
        rationaleSummary: "固定仓库树读取失败，当前会话无法安全继续项目分析。",
        action: {
          type: "ask_clarification",
          questionId: githubMode
            ? "reattach-github-repository"
            : "reimport-local-repository",
          question: githubMode
            ? "GitHub 固定仓库会话已失效，请从查询结果重新选择仓库后重试。"
            : "固定仓库会话已失效，请重新导入本地 Git 仓库后重试。",
          reason: tree.error?.message ?? "仓库树没有返回合法结果。",
          required: true
        }
      };
    }
    const project = [...observations].reverse().find(
      (message) => message.tool === requirementsTool
    );
    if (!project) {
      return {
        turnId,
        rationaleSummary: "已确认固定仓库树，下一步从白名单项目文件中确定性提取环境与依赖要求。",
        action: {
          type: "tool_calls",
          calls: [{
            callId: `${turnId}-requirements`.slice(0, 160),
            name: requirementsTool,
            input: { repositoryHandleId },
            risk: "read_only"
          }]
        }
      };
    }
    if (
      project.status !== "success" ||
      !isProjectRequirementsOutput(project.output)
    ) {
      return {
        turnId,
        rationaleSummary: "项目要求提取失败，不能凭 README 印象编造兼容性结论。",
        action: {
          type: "ask_clarification",
          questionId: "project-requirements-unavailable",
          question: githubMode
            ? "当前固定 GitHub commit 中的项目要求无法安全读取；请重新选择仓库后重试。"
            : "当前固定仓库中的项目要求无法安全读取；请检查仓库文件编码或重新导入后重试。",
          reason: project.error?.message ?? "项目要求工具没有返回合法结果。",
          required: true
        }
      };
    }
    const environment = [...observations].reverse().find(
      (message) =>
        message.tool === "inspect_local_development_environment"
    );
    if (!environment) {
      return {
        turnId,
        rationaleSummary: "仓库要求已经固定，继续使用固定命令白名单采集本机对应工具状态。",
        action: {
          type: "tool_calls",
          calls: [{
            callId: `${turnId}-environment`.slice(0, 160),
            name: "inspect_local_development_environment",
            input: {},
            risk: "read_only"
          }]
        }
      };
    }
    if (
      environment.status !== "success" ||
      !isLocalDevelopmentEnvironmentOutput(environment.output)
    ) {
      return {
        turnId,
        rationaleSummary: "本机环境探测失败，不能把未知状态判断为满足或缺失。",
        action: {
          type: "ask_clarification",
          questionId: "local-environment-unavailable",
          question: "本机固定环境探测未完成；请检查应用权限后重试。",
          reason: environment.error?.message ?? "环境工具没有返回合法结果。",
          required: true
        }
      };
    }
    const assessment = buildProjectCompatibilityAssessment(
      project.output,
      environment.output
    );
    return {
      turnId,
      rationaleSummary:
        "已取得固定仓库树、结构化项目要求和本机固定命令观测；按保守版本比较规则形成差距报告。",
      action: {
        type: "complete_step",
        summary: "项目要求与本机环境的只读对比已完成。",
        output: assessment,
        evidence: [
          {
            source: tree.tool,
            reference: tree.callId,
            summary: `${githubMode ? "固定 GitHub Tree" : "固定 HEAD"} 共匹配 ${(tree.output as { totalMatchingEntries: number }).totalMatchingEntries} 个文件。`
          },
          {
            source: project.tool,
            reference: project.callId,
            summary: `从 ${project.output.inspectedFiles.length} 个白名单文件提取 ${project.output.requirements.length} 项要求。`
          },
          {
            source: environment.tool,
            reference: environment.callId,
            summary: `读取 ${environment.output.tools.length} 个固定本机工具状态。`
          }
        ]
      }
    };
  }

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

    if (
      [
        "local-development-environment-inspection",
        "local-environment-compatibility-assessment"
      ].includes(state.routeDecision?.skillId ?? "")
    ) {
      const compatibilityAssessment =
        state.routeDecision?.skillId ===
        "local-environment-compatibility-assessment";
      const result = latestLocalDevelopmentEnvironmentResult(state);
      if (!result) {
        return createDecision(
          context,
          {
            actionId: createActionId(context, "development-environment-inspection"),
            type: "call_tool",
            purpose: compatibilityAssessment
              ? "只读调查本机开发环境，为目标技术兼容性评估收集证据。"
              : "只读盘点本机开发工具版本。",
            call: {
              callId: `local-call-${context.step}-development-environment-inspection`,
              name: "inspect_local_development_environment",
              input: {}
            }
          },
          compatibilityAssessment
            ? "兼容性结论必须基于本机证据，因此先调用固定白名单的只读探测工具。"
            : "当前任务只要求查询本机版本，因此只调用固定白名单的只读探测工具。"
        );
      }
      const inspectedTools =
        result.status === "success" &&
        isLocalDevelopmentEnvironmentOutput(result.output)
          ? result.output.tools
          : [];
      const availableTools = inspectedTools.filter(
        (tool) => tool.status === "available"
      );
      const unavailableTools = inspectedTools.filter(
        (tool) => tool.status !== "available"
      );
      const compatibilitySummary =
        `本机环境兼容性初步评估完成：已确认 ${availableTools.length} 项可用` +
        `（${availableTools.map((tool) => tool.name).join("、") || "无"}）` +
        `；${unavailableTools.length} 项缺少、不适用或探测失败` +
        `（${unavailableTools.map((tool) => tool.name).join("、") || "无"}）。` +
        "目标框架自身、Python 包及项目级依赖尚未由当前工具覆盖的部分标记为无法确认；未执行下载或安装。";
      return createDecision(
        context,
        {
          actionId: createActionId(context, "development-environment-finish"),
          type: "finish",
          summary: result.status === "success"
            ? compatibilityAssessment
              ? compatibilitySummary
              : `本机开发环境盘点完成，共检测到 ${availableTools.length} 个可用命令入口。`
            : `本机开发环境盘点未完成：${result.error?.message ?? "未知错误"}`
        },
        compatibilityAssessment
          ? "模型已读取工具观察结果并区分已具备、缺少与无法确认项；当前步骤可以完成。"
          : "只读版本清单已经生成，任务不进入资源计划或下载阶段。"
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
