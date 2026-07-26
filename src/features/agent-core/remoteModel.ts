import type { ModelRuntime, RemoteModelTransport } from "./interfaces";
import { parseModelDecision } from "./agentSchemas";
import { ModelConnectionRequestError } from "./modelConnection";
import type { ModelContext, ModelDecision } from "./types";

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

  async decide(context: ModelContext): Promise<ModelDecision> {
    const decision = parseRemoteDecision(
      await this.transport.requestDecision(context)
    );
    const action = decision.action;
    const availableResourceIds = collectResourceIds(context);
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
        action.call.name === "search_trusted_catalog")
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
}
