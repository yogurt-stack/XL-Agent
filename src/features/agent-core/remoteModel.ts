import type { ModelRuntime, RemoteModelTransport } from "./interfaces";
import { ModelConnectionRequestError } from "./modelConnection";
import type { AgentAction, ModelContext, ModelDecision } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAgentAction(value: unknown): value is AgentAction {
  if (!isRecord(value) || typeof value.actionId !== "string" || typeof value.type !== "string") return false;

  if (value.type === "ask_clarification") {
    return (
      typeof value.questionId === "string" &&
      typeof value.question === "string" &&
      typeof value.reason === "string" &&
      typeof value.required === "boolean" &&
      isStringArray(value.options)
    );
  }
  if (value.type === "create_plan") {
    return isStringArray(value.resourceIds) && typeof value.explanation === "string";
  }
  if (value.type === "create_replan") {
    return (
      (value.strategy === "trusted-mirror" || value.strategy === "primary-retry") &&
      typeof value.explanation === "string"
    );
  }
  if (value.type === "call_tool") {
    if (
      typeof value.purpose !== "string" ||
      !isRecord(value.call) ||
      typeof value.call.callId !== "string" ||
      !isRecord(value.call.input)
    ) {
      return false;
    }
    if (value.call.name === "read_system_profile") return true;
    if (value.call.name === "search_trusted_catalog") {
      return (
        typeof value.call.input.query === "string" &&
        (value.call.input.resourceIds === undefined || isStringArray(value.call.input.resourceIds))
      );
    }
    return (
      (value.call.name === "simulate_download" || value.call.name === "controlled_download") &&
      typeof value.call.input.resourceId === "string"
    );
  }
  return value.type === "finish" && typeof value.summary === "string";
}

export function parseRemoteDecision(value: unknown): ModelDecision {
  if (
    !isRecord(value) ||
    typeof value.decisionId !== "string" ||
    typeof value.model !== "string" ||
    typeof value.explanation !== "string" ||
    !isAgentAction(value.action)
  ) {
    throw new ModelConnectionRequestError({
      code: "MODEL_INVALID_DECISION",
      message: "远程模型没有返回合法的 ModelDecision。",
      retriable: true
    });
  }

  return {
    decisionId: value.decisionId,
    provider: "remote-llm",
    model: value.model,
    explanation: value.explanation,
    action: value.action
  };
}

/** 通过注入的安全传输调用远程 LLM，并校验其结构化输出。 */
export class RemoteLlmModelRuntime implements ModelRuntime {
  constructor(private readonly transport: RemoteModelTransport) {}

  async decide(context: ModelContext): Promise<ModelDecision> {
    return parseRemoteDecision(await this.transport.requestDecision(context));
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
