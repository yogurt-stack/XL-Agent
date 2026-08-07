import type {
  AgentAction,
  AgentEvent,
  AgentState,
  AgentToolCall,
  ModelContext,
  ModelDecision,
  PolicyDecision,
  TaskRequirements,
  ToolResult
} from "./types";
import type {
  AgentAssistantTurn,
  AgentTurnContext
} from "./agentLoop";
import type { AgentToolName, TaskPlanProposal } from "./types";

/**
 * 将当前 Agent 上下文交给模型适配器，并返回一项结构化决策。
 * 具体实现可以是本地规则模型或后续接入的远程 LLM。
 */
export interface ModelRuntime {
  decide(context: ModelContext): Promise<ModelDecision>;
  generateTurn?(
    context: AgentTurnContext<AgentToolName, unknown, TaskPlanProposal>,
    signal: AbortSignal
  ): Promise<AgentAssistantTurn<AgentToolName, unknown, TaskPlanProposal>>;
}

export interface RemoteModelTransport {
  requestDecision(context: ModelContext): Promise<unknown>;
  requestTurn?(
    context: AgentTurnContext<AgentToolName, unknown, TaskPlanProposal>,
    signal: AbortSignal
  ): Promise<AgentAssistantTurn<AgentToolName, unknown, TaskPlanProposal>>;
}

export type AgentToolExecutionOptions = {
  /** Cancels the underlying operation when the Task Plan authorization expires. */
  signal?: AbortSignal;
  /** Absolute wall-clock deadline inherited from the bounded Agent Loop. */
  deadlineAt?: number;
};

export interface AgentToolExecutor {
  execute(
    call: AgentToolCall,
    state: AgentState,
    options?: AgentToolExecutionOptions
  ): Promise<ToolResult>;
}

export interface AgentPolicy {
  evaluate(action: AgentAction, state: AgentState): PolicyDecision;
}

export interface AgentScheduler {
  schedule(task: () => void | Promise<void>, delayMs: number): () => void;
}

export interface AgentRouter {
  route(state: AgentState): Extract<AgentEvent, { type: "ROUTE_RESOLVED" }> | null;
  resolveRequirements?(state: AgentState): TaskRequirements | null;
}

export interface AgentPlanner {
  createPlan(state: AgentState): Extract<AgentEvent, { type: "PLAN_GENERATED" }> | null;
  createReplan(state: AgentState): Extract<AgentEvent, { type: "REPLAN_GENERATED" }> | null;
}

export interface AgentVerifier {
  verify(
    state: AgentState
  ):
    | Extract<AgentEvent, { type: "VERIFY_RESOURCES" }>
    | null
    | Promise<Extract<AgentEvent, { type: "VERIFY_RESOURCES" }> | null>;
}

export type AgentStateListener = (state: AgentState) => void;

export interface AgentRuntimePort {
  getState(): AgentState;
  dispatch(event: AgentEvent): AgentState;
  subscribe(listener: AgentStateListener): () => void;
  start(): void;
  stop(): void;
}
