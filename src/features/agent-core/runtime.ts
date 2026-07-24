import type {
  AgentPlanner,
  AgentPolicy,
  AgentRouter,
  AgentRuntimePort,
  AgentScheduler,
  AgentStateListener,
  AgentToolExecutor,
  ModelRuntime,
  AgentVerifier
} from "./interfaces";
import { DefaultAgentPolicy, InMemoryAgentToolExecutor } from "./agentServices";
import { LocalRuleModelRuntime } from "./localRuleModel";
import { createInitialAgentState, transition } from "./machine";
import { MockVerifier, FixedWindowsPlanner, FixedWindowsRouter } from "./mockServices";
import type {
  AgentAction,
  AgentEvent,
  AgentState,
  AgentToolCall,
  AgentToolName,
  ControlledDownloadOutput,
  SimulatedDownloadOutput,
  WorkspaceExportOutput
} from "./types";

export type RuntimeDownloadTool = Extract<
  AgentToolName,
  "simulate_download" | "controlled_download"
>;

export type AgentRuntimeDependencies = {
  router: AgentRouter;
  planner: AgentPlanner;
  verifier: AgentVerifier;
  scheduler: AgentScheduler;
  model?: ModelRuntime;
  tools: AgentToolExecutor;
  policy: AgentPolicy;
  initialState?: AgentState;
  stepDelayMs?: number;
  downloadTool?: RuntimeDownloadTool;
  createTaskId?: () => string;
};

export class AgentRuntime implements AgentRuntimePort {
  private state: AgentState;
  private readonly listeners = new Set<AgentStateListener>();
  private cancelScheduledStep: (() => void) | null = null;
  private started = false;
  private workVersion = 0;
  private modelStepRunning = false;
  private toolStepRunning = false;
  private readonly stepDelayMs: number;
  private readonly downloadTool: RuntimeDownloadTool;
  private readonly createTaskId: () => string;

  constructor(private readonly dependencies: AgentRuntimeDependencies) {
    this.state = dependencies.initialState ?? createInitialAgentState();
    this.stepDelayMs = dependencies.stepDelayMs ?? 420;
    this.downloadTool = dependencies.downloadTool ?? "simulate_download";
    this.createTaskId =
      dependencies.createTaskId ??
      (() => `task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  }

  getState() {
    return this.state;
  }

  dispatch(event: AgentEvent) {
    this.invalidatePendingWork();
    this.applyEvent(
      event.type === "SUBMIT_TASK" && !event.taskId
        ? { ...event, taskId: this.createTaskId() }
        : event
    );
    this.drive();
    return this.state;
  }

  private applyEvent(event: AgentEvent) {
    const nextState = transition(this.state, event);
    if (nextState === this.state) return;
    this.state = nextState;
    this.listeners.forEach((listener) => listener(this.state));
  }

  subscribe(listener: AgentStateListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.drive();
  }

  stop() {
    this.started = false;
    this.invalidatePendingWork();
  }

  private drive() {
    if (!this.started || this.cancelScheduledStep || this.modelStepRunning || this.toolStepRunning) return;

    if (
      this.dependencies.model &&
      (this.state.phase === "routing" || this.state.phase === "planning" || this.state.phase === "replanning")
    ) {
      if (this.state.agentRun.step >= this.state.agentRun.maxSteps) {
        this.applyEvent({ type: "MODEL_STEP_LIMIT_REACHED" });
        return;
      }

      const version = this.workVersion;
      this.cancelScheduledStep = this.dependencies.scheduler.schedule(async () => {
        this.cancelScheduledStep = null;
        if (!this.started || version !== this.workVersion) return;
        await this.runModelStep(version);
      }, this.stepDelayMs);
      return;
    }

    if (this.state.phase === "downloading" && this.state.activeResourceId) {
      const version = this.workVersion;
      this.cancelScheduledStep = this.dependencies.scheduler.schedule(async () => {
        this.cancelScheduledStep = null;
        if (!this.started || version !== this.workVersion) return;
        await this.runDownloadToolStep(version);
      }, this.stepDelayMs);
      return;
    }

    if (this.state.phase === "exporting" && this.state.workspace.exportStatus === "pending") {
      const version = this.workVersion;
      this.cancelScheduledStep = this.dependencies.scheduler.schedule(async () => {
        this.cancelScheduledStep = null;
        if (!this.started || version !== this.workVersion) return;
        await this.runWorkspaceExportToolStep(version);
      }, this.stepDelayMs);
      return;
    }

    const event = this.nextAutomaticEvent();
    if (!event) return;

    const version = this.workVersion;
    this.cancelScheduledStep = this.dependencies.scheduler.schedule(() => {
      this.cancelScheduledStep = null;
      if (!this.started || version !== this.workVersion) return;
      this.applyEvent(event);
      this.drive();
    }, this.stepDelayMs);
  }

  private async runModelStep(version: number) {
    const model = this.dependencies.model;
    const tools = this.dependencies.tools;
    const policy = this.dependencies.policy;
    if (!model) return;

    this.modelStepRunning = true;
    try {
      const decision = await model.decide({
        state: this.state,
        step: this.state.agentRun.step,
        maxSteps: this.state.agentRun.maxSteps,
        availableTools: [
          "read_system_profile",
          "search_trusted_catalog",
          this.downloadTool,
          "export_workspace"
        ],
        toolResults: this.state.agentRun.toolResults
      });
      if (!this.isCurrentWork(version)) return;

      this.applyEvent({ type: "MODEL_DECISION_RECORDED", decision });
      const policyDecision = policy.evaluate(decision.action, this.state);
      this.applyEvent({
        type: "MODEL_POLICY_RECORDED",
        actionId: decision.action.actionId,
        decision: policyDecision
      });

      if (policyDecision.outcome === "deny") {
        this.applyEvent({ type: "MODEL_RUNTIME_FAILED", reason: policyDecision.reason });
        return;
      }

      const action = decision.action;
      if (action.type === "call_tool") {
        const result = await tools.execute(action.call, this.state);
        if (!this.isCurrentWork(version)) return;
        this.applyEvent({ type: "MODEL_TOOL_COMPLETED", result });
      } else if (action.type === "ask_clarification") {
        this.applyEvent({
          type: "MODEL_CLARIFICATION_REQUESTED",
          question: {
            id: action.questionId,
            prompt: action.question,
            reason: action.reason,
            required: action.required,
            options: action.options
          }
        });
      } else if (action.type === "create_plan") {
        this.applyEvent({
          type: "MODEL_PLAN_PROPOSED",
          resourceIds: action.resourceIds,
          explanation: action.explanation
        });
      } else if (action.type === "create_replan") {
        this.applyEvent({
          type: "MODEL_REPLAN_PROPOSED",
          strategy: action.strategy,
          explanation: action.explanation
        });
      } else if (action.type === "finish") {
        this.applyEvent({ type: "MODEL_FINISHED", summary: action.summary });
      }
    } catch (error) {
      if (this.isCurrentWork(version)) {
        this.applyEvent({
          type: "MODEL_RUNTIME_FAILED",
          reason: error instanceof Error ? error.message : "未知模型错误"
        });
      }
    } finally {
      this.modelStepRunning = false;
      if (this.isCurrentWork(version)) this.drive();
    }
  }

  private async runDownloadToolStep(version: number) {
    const resource = this.state.resources.find((item) => item.id === this.state.activeResourceId);
    if (!resource) return;

    const callId = `download-r${this.state.revision}-${resource.id}-a${resource.attempts}-p${resource.progress}`;
    const call: AgentToolCall =
      this.downloadTool === "controlled_download"
        ? {
            callId,
            name: "controlled_download",
            input: { resourceId: resource.id }
          }
        : {
            callId,
            name: "simulate_download",
            input: { resourceId: resource.id }
          };
    const action: Extract<AgentAction, { type: "call_tool" }> = {
      actionId: `runtime-${callId}`,
      type: "call_tool",
      purpose:
        this.downloadTool === "controlled_download"
          ? "通过 Electron 主进程执行用户已确认的受控下载任务。"
          : "执行用户已确认的模拟下载任务。",
      call
    };

    this.toolStepRunning = true;
    try {
      const policyDecision = this.dependencies.policy.evaluate(action, this.state);
      this.applyEvent({
        type: "MODEL_POLICY_RECORDED",
        actionId: action.actionId,
        decision: policyDecision
      });
      if (policyDecision.outcome !== "allow") {
        this.applyEvent({ type: "MODEL_RUNTIME_FAILED", reason: policyDecision.reason });
        return;
      }

      const result = await this.dependencies.tools.execute(action.call, this.state);
      if (!this.isCurrentWork(version)) return;
      this.applyEvent({ type: "MODEL_TOOL_COMPLETED", result });

      if (result.status === "error") {
        if (
          result.error?.code === "APPROVAL_EXPIRED" ||
          result.error?.code === "APPROVAL_NOT_FOUND"
        ) {
          this.applyEvent({
            type: "DOWNLOAD_APPROVAL_EXPIRED",
            reason: result.error.message
          });
          return;
        }
        if (result.error?.retriable) {
          this.applyEvent({
            type: "DOWNLOAD_FAILED",
            resourceId: resource.id,
            reason: result.error.message
          });
        } else {
          this.applyEvent({
            type: "MODEL_RUNTIME_FAILED",
            reason: result.error?.message ?? "下载工具执行失败。"
          });
        }
        return;
      }

      if (this.downloadTool === "controlled_download") {
        if (!isControlledDownloadOutput(result.output) || result.output.resourceId !== resource.id) {
          this.applyEvent({ type: "MODEL_RUNTIME_FAILED", reason: "受控下载工具返回了非法结果。" });
          return;
        }
        this.applyEvent({
          type: "DOWNLOAD_PROGRESS",
          resourceId: result.output.resourceId,
          progress: 100
        });
      } else {
        if (!isSimulatedDownloadOutput(result.output) || result.output.resourceId !== resource.id) {
          this.applyEvent({ type: "MODEL_RUNTIME_FAILED", reason: "模拟下载工具返回了非法结果。" });
          return;
        }
        this.applyEvent({
          type: "DOWNLOAD_PROGRESS",
          resourceId: result.output.resourceId,
          progress: result.output.progress
        });
      }
    } finally {
      this.toolStepRunning = false;
      if (this.isCurrentWork(version)) this.drive();
    }
  }

  private async runWorkspaceExportToolStep(version: number) {
    const callId = `workspace-export-${this.state.taskId}-r${this.state.revision}`;
    const action: Extract<AgentAction, { type: "call_tool" }> = {
      actionId: `runtime-${callId}`,
      type: "call_tool",
      purpose: "原子写入用户已审批并完成校验的工作区交接包。",
      call: {
        callId,
        name: "export_workspace",
        input: {
          taskId: this.state.taskId,
          revision: this.state.revision
        }
      }
    };

    this.toolStepRunning = true;
    try {
      const policyDecision = this.dependencies.policy.evaluate(action, this.state);
      this.applyEvent({
        type: "MODEL_POLICY_RECORDED",
        actionId: action.actionId,
        decision: policyDecision
      });
      if (policyDecision.outcome !== "allow") {
        this.applyEvent({ type: "WORKSPACE_EXPORT_FAILED", reason: policyDecision.reason });
        return;
      }

      this.applyEvent({ type: "WORKSPACE_EXPORT_STARTED" });
      const result = await this.dependencies.tools.execute(action.call, this.state);
      if (!this.isCurrentWork(version)) return;
      this.applyEvent({ type: "MODEL_TOOL_COMPLETED", result });
      if (result.status === "error") {
        if (
          result.error?.code === "APPROVAL_EXPIRED" ||
          result.error?.code === "APPROVAL_NOT_FOUND"
        ) {
          this.applyEvent({
            type: "DOWNLOAD_APPROVAL_EXPIRED",
            reason: result.error.message
          });
          return;
        }
        this.applyEvent({
          type: "WORKSPACE_EXPORT_FAILED",
          reason: result.error?.message ?? "工作区导出工具执行失败。"
        });
        return;
      }
      if (
        !isWorkspaceExportOutput(result.output) ||
        result.output.taskId !== this.state.taskId ||
        result.output.revision !== this.state.revision
      ) {
        this.applyEvent({
          type: "WORKSPACE_EXPORT_FAILED",
          reason: "工作区导出工具返回了非法结果。"
        });
        return;
      }
      this.applyEvent({ type: "WORKSPACE_EXPORT_COMPLETED", output: result.output });
    } finally {
      this.toolStepRunning = false;
      if (this.isCurrentWork(version)) this.drive();
    }
  }

  private isCurrentWork(version: number) {
    return this.started && version === this.workVersion;
  }

  private nextAutomaticEvent(): AgentEvent | null {
    const { phase } = this.state;
    if (phase === "routing") return this.dependencies.router.route(this.state);
    if (phase === "planning") return this.dependencies.planner.createPlan(this.state);
    if (phase === "replanning") return this.dependencies.planner.createReplan(this.state);
    if (phase === "verifying") return this.dependencies.verifier.verify(this.state);
    return null;
  }

  private invalidatePendingWork() {
    this.workVersion += 1;
    this.cancelScheduledStep?.();
    this.cancelScheduledStep = null;
  }
}

export function createTimeoutScheduler(): AgentScheduler {
  return {
    schedule(task, delayMs) {
      const timer = globalThis.setTimeout(() => {
        void task();
      }, delayMs);
      return () => globalThis.clearTimeout(timer);
    }
  };
}

function isSimulatedDownloadOutput(value: unknown): value is SimulatedDownloadOutput {
  if (typeof value !== "object" || value === null) return false;
  const output = value as Record<string, unknown>;
  return typeof output.resourceId === "string" && typeof output.progress === "number";
}

function isControlledDownloadOutput(value: unknown): value is ControlledDownloadOutput {
  if (typeof value !== "object" || value === null) return false;
  const output = value as Record<string, unknown>;
  return (
    typeof output.resourceId === "string" &&
    typeof output.urlHost === "string" &&
    typeof output.bytesWritten === "number" &&
    typeof output.sha256 === "string" &&
    typeof output.tempFilePath === "string" &&
    typeof output.elapsedMs === "number"
  );
}

function isWorkspaceExportOutput(value: unknown): value is WorkspaceExportOutput {
  if (typeof value !== "object" || value === null) return false;
  const output = value as Record<string, unknown>;
  return (
    typeof output.taskId === "string" &&
    typeof output.revision === "number" &&
    typeof output.rootPath === "string" &&
    typeof output.generatedAt === "string" &&
    typeof output.reusedExisting === "boolean" &&
    Array.isArray(output.files)
  );
}

export function createMockAgentRuntime(
  model: ModelRuntime = new LocalRuleModelRuntime(),
  tools: AgentToolExecutor = new InMemoryAgentToolExecutor(),
  downloadTool: RuntimeDownloadTool = "simulate_download"
) {
  return new AgentRuntime({
    router: new FixedWindowsRouter(),
    planner: new FixedWindowsPlanner(),
    verifier: new MockVerifier(),
    scheduler: createTimeoutScheduler(),
    model,
    tools,
    policy: new DefaultAgentPolicy(),
    downloadTool
  });
}
