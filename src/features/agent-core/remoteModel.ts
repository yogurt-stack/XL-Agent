import type { ModelRuntime, RemoteModelTransport } from "./interfaces";
import type {
  AgentAssistantTurn,
  AgentTurnContext
} from "./agentLoop";
import { parseModelDecision } from "./agentSchemas";
import { ModelConnectionRequestError } from "./modelConnection";
import {
  githubSearchInputFromState,
  sameGitHubSearchInput
} from "./githubSearch";
import type {
  AgentToolName,
  ModelContext,
  ModelDecision,
  TaskPlanProposal
} from "./types";
import {
  createTaskPlan,
  defaultTaskPlanToolPolicies,
  validateTaskPlan
} from "./taskPlan";

function collectResourceIds(context: ModelContext) {
  const ids = new Set<string>([
    ...context.state.resources.flatMap((resource) => [
      resource.id,
      ...(resource.fallbackId ? [resource.fallbackId] : [])
    ]),
    ...(context.state.routeDecision?.resourceIds ?? [])
  ]);
  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    for (const key of ["id", "resourceId", "fallbackId"]) {
      if (typeof record[key] === "string") ids.add(record[key]);
    }
    Object.values(record).forEach(collect);
  };
  context.toolResults.forEach((result) => collect(result.output));
  return ids;
}

export function parseRemoteDecision(value: unknown): ModelDecision {
  try {
    const decision = parseModelDecision(value);
    return { ...decision, provider: "remote-llm" };
  } catch {
    throw new ModelConnectionRequestError({
      code: "MODEL_INVALID_DECISION",
      message: "远程模型没有返回合法的 ModelDecision。",
      retriable: true
    });
  }
}

/** 通过注入的安全传输调用远程 LLM，并校验其结构化输出。 */
export class RemoteLlmModelRuntime implements ModelRuntime {
  constructor(private readonly transport: RemoteModelTransport) {}

  async generateTurn(
    context: AgentTurnContext<AgentToolName, unknown, TaskPlanProposal>,
    signal: AbortSignal
  ): Promise<AgentAssistantTurn<AgentToolName, unknown, TaskPlanProposal>> {
    if (!this.transport.requestTurn) {
      throw new ModelConnectionRequestError({
        code: "MODEL_INVALID_DECISION",
        message: "当前远程模型传输层尚未实现 Agent Loop turn 协议。",
        retriable: false
      });
    }
    return this.transport.requestTurn(context, signal);
  }

  async decide(context: ModelContext): Promise<ModelDecision> {
    const decision = parseRemoteDecision(
      await this.transport.requestDecision(context)
    );
    const action = decision.action;
    if (context.state.phase === "task_planning") {
      if (action.type !== "propose_task_plan") {
        throw new ModelConnectionRequestError({
          code: "MODEL_INVALID_DECISION",
          message: "远程模型在 Task Plan 阶段没有调用 propose_task_plan。",
          retriable: true
        });
      }
      const plan = createTaskPlan({
        planId: "remote-plan-validation",
        taskId: context.state.taskId,
        proposal: action.proposal,
        createdBy: "remote-llm",
        createdAt: "2026-07-31T00:00:00.000Z"
      });
      const validation = validateTaskPlan(plan, {
        tools: defaultTaskPlanToolPolicies.filter((policy) =>
          context.availableTools.includes(policy.name as AgentToolName)
        ),
        requireInitialConfirmation: true
      });
      if (!validation.valid) {
        throw new ModelConnectionRequestError({
          code: "MODEL_INVALID_DECISION",
          message: `远程模型提出的 Task Plan 未通过验证：${validation.issues[0]?.message ?? "未知错误"}`,
          retriable: true
        });
      }
      return decision;
    }
    if (action.type === "propose_task_plan") {
      throw new ModelConnectionRequestError({
        code: "MODEL_INVALID_DECISION",
        message: "远程模型只能在 task_planning 阶段提出首轮 Task Plan。",
        retriable: true
      });
    }
    const availableResourceIds = collectResourceIds(context);
    if (
      context.state.routeDecision?.skillId === "github-project-discovery"
    ) {
      const hasSearchResult = context.toolResults.some(
        (result) => result.tool === "search_github_repositories"
      );
      const allowedGitHubAction =
        (!hasSearchResult &&
          action.type === "call_tool" &&
          action.call.name === "search_github_repositories") ||
        (hasSearchResult && action.type === "finish");
      if (!allowedGitHubAction) {
        throw new ModelConnectionRequestError({
          code: "MODEL_INVALID_DECISION",
          message: "远程模型尝试越过 GitHub 只读检索流程，已切换本地规则模型。",
          retriable: true
        });
      }
    }
    if (
      [
        "local-development-environment-inspection",
        "local-environment-compatibility-assessment"
      ].includes(context.state.routeDecision?.skillId ?? "")
    ) {
      const hasInspectionResult = context.toolResults.some(
        (result) =>
          result.tool === "inspect_local_development_environment"
      );
      const allowedInspectionAction =
        (!hasInspectionResult &&
          action.type === "call_tool" &&
          action.call.name === "inspect_local_development_environment") ||
        (hasInspectionResult && action.type === "finish");
      if (!allowedInspectionAction) {
        throw new ModelConnectionRequestError({
          code: "MODEL_INVALID_DECISION",
          message: "远程模型尝试越过本地环境只读盘点流程，已切换本地规则模型。",
          retriable: true
        });
      }
    }
    const proposedResourceIds =
      action.type === "create_plan"
        ? action.resourceIds
        : action.type === "call_tool" &&
            "resourceId" in action.call.input
          ? [action.call.input.resourceId]
          : action.type === "call_tool" &&
              action.call.name === "search_trusted_catalog"
            ? action.call.input.resourceIds ?? []
            : [];
    const unknownResourceId = proposedResourceIds.find(
      (resourceId) => !availableResourceIds.has(resourceId)
    );
    if (unknownResourceId) {
      throw new ModelConnectionRequestError({
        code: "MODEL_INVALID_DECISION",
        message: `远程模型提出了上下文中不存在的资源 ID：${unknownResourceId}。`,
        retriable: true
      });
    }
    const readOnlyToolName =
      action.type === "call_tool" &&
      (action.call.name === "read_system_profile" ||
        action.call.name === "inspect_local_development_environment" ||
        action.call.name === "search_trusted_catalog" ||
        action.call.name === "search_github_repositories")
        ? action.call.name
        : null;
    const repeatedReadOnlyTool =
      readOnlyToolName !== null &&
      context.toolResults.some(
        (result) =>
          result.tool === readOnlyToolName &&
          result.status === "success"
      );
    if (repeatedReadOnlyTool) {
      throw new ModelConnectionRequestError({
        code: "MODEL_INVALID_DECISION",
        message: `远程模型重复调用已成功的 ${readOnlyToolName}，已切换本地规则模型继续规划。`,
        retriable: true
      });
    }
    if (
      action.type === "call_tool" &&
      action.call.name === "search_github_repositories"
    ) {
      const expected = githubSearchInputFromState(context.state);
      const actual = action.call.input;
      if (!sameGitHubSearchInput(actual, expected)) {
        throw new ModelConnectionRequestError({
          code: "MODEL_INVALID_DECISION",
          message: "远程模型修改了用户确认的 GitHub 搜索条件，已切换本地规则模型。",
          retriable: true
        });
      }
    }
    return decision;
  }
}

/** 主模型不可用或输出非法时，自动使用本地确定性模型继续任务。 */
export type FallbackModelObserver = {
  shouldAttemptPrimary?: () => boolean;
  onPrimarySuccess?: (decision: ModelDecision) => void;
  onPrimaryFailure?: (error: unknown) => void;
};

export class FallbackModelRuntime implements ModelRuntime {
  constructor(
    private readonly primary: ModelRuntime,
    private readonly fallback: ModelRuntime,
    private readonly observer: FallbackModelObserver = {}
  ) {}

  async decide(context: ModelContext): Promise<ModelDecision> {
    if (this.observer.shouldAttemptPrimary && !this.observer.shouldAttemptPrimary()) {
      return this.fallback.decide(context);
    }

    try {
      const decision = await this.primary.decide(context);
      this.observer.onPrimarySuccess?.(decision);
      return decision;
    } catch (error) {
      this.observer.onPrimaryFailure?.(error);
      return this.fallback.decide(context);
    }
  }

  async generateTurn(
    context: AgentTurnContext<AgentToolName, unknown, TaskPlanProposal>,
    signal: AbortSignal
  ): Promise<AgentAssistantTurn<AgentToolName, unknown, TaskPlanProposal>> {
    const fallbackTurn = () => {
      if (!this.fallback.generateTurn) {
        throw new ModelConnectionRequestError({
          code: "MODEL_INVALID_DECISION",
          message: "本地回退模型不支持 Agent Loop turn 协议。",
          retriable: false
        });
      }
      return this.fallback.generateTurn(context, signal);
    };
    if (
      this.observer.shouldAttemptPrimary &&
      !this.observer.shouldAttemptPrimary()
    ) {
      return fallbackTurn();
    }
    if (!this.primary.generateTurn) return fallbackTurn();
    try {
      return await this.primary.generateTurn(context, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      this.observer.onPrimaryFailure?.(error);
      return fallbackTurn();
    }
  }
}
