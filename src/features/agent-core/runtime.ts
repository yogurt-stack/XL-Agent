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
import { parseAgentToolCall, parseModelDecision } from "./agentSchemas";
import {
  githubSearchInputFromState,
  sameGitHubSearchInput
} from "./githubSearch";
import { LocalRuleModelRuntime } from "./localRuleModel";
import { createInitialAgentState, transition } from "./machine";
import { MockVerifier, FixedWindowsPlanner, FixedWindowsRouter } from "./mockServices";
import {
  createTaskPlan,
  defaultTaskPlanToolPolicies,
  prepareTaskPlanForConfirmation,
  validateTaskPlan
} from "./taskPlan";
import {
  activeTaskPlanStep,
  nextTaskPlanExecutorCommand,
  type TaskPlanExecutorCommand
} from "./taskPlanExecutor";
import { createLocalTaskPlanProposal } from "./taskPlanTemplates";
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
  private verifierStepRunning = false;
  private readonly stepDelayMs: number;
  private readonly downloadTool: RuntimeDownloadTool;
  private readonly createTaskId: () => string;
  private readonly taskPlanFallbackModel = new LocalRuleModelRuntime();

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
    const normalizedEvent: AgentEvent =
      event.type === "SUBMIT_TASK" && !event.taskId
        ? { ...event, taskId: this.createTaskId() }
        : event.type === "CONFIRM_TASK_PLAN"
          ? {
              type: "TASK_PLAN_CONFIRMED",
              revision: event.revision,
              confirmedAt: new Date().toISOString()
            }
          : event.type === "ANSWER_CLARIFICATION" && !event.answeredAt
            ? { ...event, answeredAt: new Date().toISOString() }
          : event.type === "SKIP_CLARIFICATION" && !event.skippedAt
            ? { ...event, skippedAt: new Date().toISOString() }
          : event.type === "APPROVE_PLAN" && !event.approvedAt
            ? { ...event, approvedAt: new Date().toISOString() }
          : event.type === "RESOLVE_DOWNLOAD_FAILURE" && !event.resolvedAt
            ? { ...event, resolvedAt: new Date().toISOString() }
          : event.type === "CANCEL_TASK" && !event.cancelledAt
            ? { ...event, cancelledAt: new Date().toISOString() }
          : event;
    const nextState = transition(this.state, normalizedEvent);
    if (nextState === this.state) {
      this.drive();
      return this.state;
    }
    this.invalidatePendingWork();
    this.state = nextState;
    this.listeners.forEach((listener) => listener(this.state));
    this.drive();
    return this.state;
  }

  /**
   * 接收由 Main 侧长任务产生的进度事件，不取消当前 Tool Promise。
   */
  reportExternalEvent(event: AgentEvent) {
    this.applyEvent(event);
    if (event.type === "GITHUB_ACQUISITION_PREPARED") {
      this.completeGitHubAcquisitionSteps(event);
    }
    this.drive();
    return this.state;
  }

  private completeGitHubAcquisitionSteps(
    event: Extract<AgentEvent, { type: "GITHUB_ACQUISITION_PREPARED" }>
  ) {
    const plan = this.state.taskPlan;
    const selectedRepository = event.resources.find(
      (resource) => resource.github
    );
    if (!plan || !selectedRepository?.github) return;
    const selectedStep = plan.steps.find(
      (step) =>
        step.status === "waiting_user_input" &&
        step.kind === "user_decision"
    );
    if (!selectedStep) return;
    const now = new Date().toISOString();
    this.applyEvent({
      type: "TASK_PLAN_STEP_COMPLETED",
      stepId: selectedStep.id,
      completedAt: now,
      result: {
        reference: `github:${selectedRepository.github.fullName}`,
        summary: `用户已选择 ${selectedRepository.github.fullName}。`,
        output: { fullName: selectedRepository.github.fullName }
      }
    });
    const pinStep = this.state.taskPlan?.steps.find(
      (step) => step.status === "pending" && step.kind === "resource_plan"
    );
    if (!pinStep) return;
    this.applyEvent({
      type: "TASK_PLAN_STEP_STARTED",
      stepId: pinStep.id,
      startedAt: now
    });
    this.applyEvent({
      type: "TASK_PLAN_STEP_COMPLETED",
      stepId: pinStep.id,
      completedAt: now,
      result: {
        reference: `resource-plan:r${this.state.revision}`,
        summary: `${selectedRepository.github.fullName} 已固定到不可变 commit。`,
        output: {
          revision: this.state.revision,
          fullName: selectedRepository.github.fullName,
          commitSha: selectedRepository.github.commitSha,
          resourceIds: event.resources.map((resource) => resource.id)
        }
      }
    });
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
    if (
      !this.started ||
      this.cancelScheduledStep ||
      this.modelStepRunning ||
      this.toolStepRunning ||
      this.verifierStepRunning
    ) return;

    if (this.state.phase === "routing") {
      const event = this.dependencies.router.route(this.state);
      if (!event) return;
      const version = this.workVersion;
      this.cancelScheduledStep = this.dependencies.scheduler.schedule(() => {
        this.cancelScheduledStep = null;
        if (!this.started || version !== this.workVersion) return;
        this.applyEvent(event);
        this.drive();
      }, this.stepDelayMs);
      return;
    }

    if (this.state.phase === "task_planning") {
      if (this.state.agentRun.step >= this.state.agentRun.maxSteps) {
        this.applyEvent({ type: "MODEL_STEP_LIMIT_REACHED" });
        return;
      }

      const version = this.workVersion;
      this.cancelScheduledStep = this.dependencies.scheduler.schedule(async () => {
        this.cancelScheduledStep = null;
        if (!this.started || version !== this.workVersion) return;
        await this.runModelStep(
          version,
          this.dependencies.model ?? this.taskPlanFallbackModel
        );
      }, this.stepDelayMs);
      return;
    }

    if (
      this.state.taskPlan &&
      this.state.taskPlan.confirmation.status === "confirmed" &&
      this.state.taskPlan.status !== "replanning" &&
      this.state.taskPlan.status !== "failed" &&
      this.state.taskPlan.status !== "cancelled" &&
      this.state.taskPlan.status !== "completed"
    ) {
      const command = nextTaskPlanExecutorCommand(this.state);
      if (command) this.scheduleTaskPlanCommand(command);
      return;
    }

    if (
      this.dependencies.model &&
      (this.state.phase === "planning" || this.state.phase === "replanning")
    ) {
      if (this.state.agentRun.step >= this.state.agentRun.maxSteps) {
        this.applyEvent({ type: "MODEL_STEP_LIMIT_REACHED" });
        return;
      }
      const version = this.workVersion;
      this.cancelScheduledStep = this.dependencies.scheduler.schedule(async () => {
        this.cancelScheduledStep = null;
        if (!this.started || version !== this.workVersion) return;
        await this.runModelStep(version, this.dependencies.model);
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

    if (this.state.phase === "verifying") {
      const version = this.workVersion;
      this.cancelScheduledStep = this.dependencies.scheduler.schedule(async () => {
        this.cancelScheduledStep = null;
        if (!this.started || version !== this.workVersion) return;
        await this.runVerifierStep(version);
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

  private scheduleTaskPlanCommand(command: TaskPlanExecutorCommand) {
    const version = this.workVersion;
    this.cancelScheduledStep = this.dependencies.scheduler.schedule(async () => {
      this.cancelScheduledStep = null;
      if (!this.started || version !== this.workVersion) return;
      await this.runTaskPlanCommand(command, version);
    }, this.stepDelayMs);
  }

  private async runTaskPlanCommand(
    command: TaskPlanExecutorCommand,
    version: number
  ) {
    const now = new Date().toISOString();
    if (command.type === "request_input") {
      this.applyEvent({
        type: "TASK_PLAN_STEP_INPUT_REQUESTED",
        stepId: command.stepId,
        requestedAt: now
      });
      this.drive();
      return;
    }
    if (command.type === "request_approval") {
      this.applyEvent({
        type: "TASK_PLAN_STEP_APPROVAL_REQUESTED",
        stepId: command.stepId,
        requestedAt: now
      });
      this.drive();
      return;
    }
    if (command.type === "auto_approve") {
      this.applyEvent({
        type: "TASK_PLAN_STEP_AUTO_APPROVED",
        stepId: command.stepId,
        revision: this.state.taskPlan?.revision ?? 0,
        approvedAt: now
      });
      this.drive();
      return;
    }
    if (command.type === "start_step") {
      this.applyEvent({
        type: "TASK_PLAN_STEP_STARTED",
        stepId: command.stepId,
        startedAt: now
      });
      this.drive();
      return;
    }
    if (command.type === "complete_passive") {
      this.applyEvent({
        type: "TASK_PLAN_STEP_COMPLETED",
        stepId: command.stepId,
        completedAt: now,
        result: {
          reference: `state:${this.state.phase}`,
          summary: command.terminalPhase === "result"
            ? "GitHub 查询结果已交付，等待用户选择是否继续准备到本地。"
            : command.terminalPhase === "handoff"
              ? "Task Plan 的交接目标已经达成。"
              : "计划步骤已由受控状态机完成。",
          output: {
            phase: command.terminalPhase ?? this.state.phase,
            revision: this.state.revision
          }
        },
        terminalPhase: command.terminalPhase
      });
      this.drive();
      return;
    }
    if (command.type === "execute_tool") {
      await this.runTaskPlanReadTool(command, version);
      return;
    }
    if (command.type === "generate_resource_plan") {
      if (
        this.state.taskRequirements === null &&
        this.dependencies.router.resolveRequirements
      ) {
        const requirements =
          this.dependencies.router.resolveRequirements(this.state);
        if (requirements) {
          this.applyEvent({
            type: "TASK_REQUIREMENTS_RESOLVED",
            requirements
          });
        }
      }
      if (this.dependencies.model) {
        await this.runModelStep(version, this.dependencies.model);
        return;
      }
      const event = this.state.phase === "replanning"
        ? this.dependencies.planner.createReplan(this.state)
        : this.dependencies.planner.createPlan(this.state);
      if (!event) {
        this.failRunningTaskPlanStep(
          command.stepId,
          "资源规划器没有生成可执行计划。"
        );
        return;
      }
      this.applyEvent(event);
      this.completeRunningTaskPlanStep(
        command.stepId,
        "资源计划已生成并通过严格验证。",
        {
          revision: this.state.revision,
          resourceIds: this.state.resources.map((resource) => resource.id)
        }
      );
      this.drive();
      return;
    }
    if (command.type === "execute_download_batch") {
      if (this.state.phase === "verifying") {
        this.completeRunningTaskPlanStep(
          command.stepId,
          "全部已审批资源下载完成。",
          {
            resourceIds: this.state.resources
              .filter((resource) => resource.selected)
              .map((resource) => resource.id)
          }
        );
        this.drive();
        return;
      }
      if (this.state.phase === "downloading" && this.state.activeResourceId) {
        await this.runDownloadToolStep(version);
      }
      return;
    }
    if (command.type === "verify_resources") {
      if (this.state.phase === "exporting" || this.state.phase === "handoff") {
        this.completeRunningTaskPlanStep(
          command.stepId,
          "选中资源已通过来源与完整性验证。",
          {
            verifiedResourceIds: this.state.resources
              .filter((resource) => resource.selected && resource.status === "verified")
              .map((resource) => resource.id)
          }
        );
        this.drive();
        return;
      }
      if (this.state.phase === "verifying") {
        await this.runVerifierStep(version);
      }
      return;
    }
    if (command.type === "export_workspace") {
      if (this.state.phase === "handoff") {
        this.completeRunningTaskPlanStep(
          command.stepId,
          "工作区与 Manifest 已原子导出。",
          {
            rootPath: this.state.workspace.rootPath,
            files: this.state.workspace.fileRecords
          }
        );
        this.drive();
        return;
      }
      if (
        this.state.phase === "exporting" &&
        this.state.workspace.exportStatus === "pending"
      ) {
        await this.runWorkspaceExportToolStep(version);
      }
    }
  }

  private async runTaskPlanReadTool(
    command: Extract<TaskPlanExecutorCommand, { type: "execute_tool" }>,
    version: number
  ) {
    const step = this.state.taskPlan?.steps.find(
      (candidate) => candidate.id === command.stepId
    );
    if (!step) return;
    const action: Extract<AgentAction, { type: "call_tool" }> = {
      actionId: `executor-${command.call.callId}`,
      type: "call_tool",
      purpose: step.description,
      call: command.call
    };
    this.toolStepRunning = true;
    try {
      const policyDecision = this.dependencies.policy.evaluate(
        action,
        this.state
      );
      this.applyEvent({
        type: "MODEL_POLICY_RECORDED",
        actionId: action.actionId,
        decision: policyDecision
      });
      if (policyDecision.outcome !== "allow") {
        this.failRunningTaskPlanStep(command.stepId, policyDecision.reason);
        this.applyEvent({
          type: "MODEL_RUNTIME_FAILED",
          reason: policyDecision.reason
        });
        return;
      }
      const result = await this.dependencies.tools.execute(
        command.call,
        this.state
      );
      if (!this.isCurrentWork(version)) return;
      this.applyEvent({ type: "MODEL_TOOL_COMPLETED", result });
      if (result.status !== "success") {
        const reason = result.error?.message ?? `工具 ${result.tool} 执行失败。`;
        this.failRunningTaskPlanStep(command.stepId, reason);
        this.applyEvent({ type: "MODEL_RUNTIME_FAILED", reason });
        return;
      }
      this.completeRunningTaskPlanStep(
        command.stepId,
        `工具 ${result.tool} 已返回可审计结果。`,
        result.output
      );
    } finally {
      this.toolStepRunning = false;
      if (this.isCurrentWork(version)) this.drive();
    }
  }

  private completeRunningTaskPlanStep(
    stepId: string,
    summary: string,
    output?: unknown
  ) {
    this.applyEvent({
      type: "TASK_PLAN_STEP_COMPLETED",
      stepId,
      completedAt: new Date().toISOString(),
      result: {
        reference: `task-plan-step:${stepId}`,
        summary,
        ...(output === undefined
          ? {}
          : { output: taskPlanJsonOutput(output) })
      }
    });
  }

  private failRunningTaskPlanStep(
    stepId: string,
    reason: string,
    replanning = false
  ) {
    this.applyEvent({
      type: "TASK_PLAN_STEP_FAILED",
      stepId,
      failedAt: new Date().toISOString(),
      reason,
      replanning
    });
  }

  private async runModelStep(
    version: number,
    selectedModel: ModelRuntime | undefined
  ) {
    const model = selectedModel;
    const tools = this.dependencies.tools;
    const policy = this.dependencies.policy;
    if (!model) return;

    this.modelStepRunning = true;
    try {
      const availableTools = this.availableToolsForCurrentState();
      const decision = parseModelDecision(await model.decide({
        state: this.state,
        step: this.state.agentRun.step,
        maxSteps: this.state.agentRun.maxSteps,
        availableTools,
        toolResults: this.state.agentRun.toolResults
      }));
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
      if (action.type === "propose_task_plan") {
        this.receiveTaskPlanProposal(action, decision.provider, availableTools);
      } else if (action.type === "call_tool") {
        const result = await tools.execute(action.call, this.state);
        if (!this.isCurrentWork(version)) return;
        this.applyEvent({ type: "MODEL_TOOL_COMPLETED", result });
      } else if (action.type === "ask_clarification") {
        const runningStep = activeTaskPlanStep(this.state.taskPlan);
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
        if (
          runningStep?.status === "running" &&
          runningStep.kind === "resource_plan"
        ) {
          this.applyEvent({
            type: "TASK_PLAN_STEP_INPUT_REQUESTED",
            stepId: runningStep.id,
            requestedAt: new Date().toISOString()
          });
        }
      } else if (action.type === "create_plan") {
        const runningStep = activeTaskPlanStep(this.state.taskPlan);
        this.applyEvent({
          type: "MODEL_PLAN_PROPOSED",
          resourceIds: action.resourceIds,
          explanation: action.explanation
        });
        if (
          runningStep?.status === "running" &&
          runningStep.kind === "resource_plan" &&
          this.state.phase === "waiting_approval"
        ) {
          this.completeRunningTaskPlanStep(
            runningStep.id,
            "模型资源计划已生成并通过严格验证。",
            {
              revision: this.state.revision,
              resourceIds: this.state.resources.map((resource) => resource.id)
            }
          );
        }
      } else if (action.type === "create_replan") {
        const runningStep = activeTaskPlanStep(this.state.taskPlan);
        this.applyEvent({
          type: "MODEL_REPLAN_PROPOSED",
          strategy: action.strategy,
          explanation: action.explanation
        });
        if (
          runningStep?.status === "running" &&
          runningStep.kind === "resource_plan" &&
          this.state.phase === "waiting_approval"
        ) {
          this.completeRunningTaskPlanStep(
            runningStep.id,
            "替代资源计划已生成并通过严格验证。",
            {
              revision: this.state.revision,
              strategy: action.strategy,
              resourceIds: this.state.resources.map((resource) => resource.id)
            }
          );
        }
      } else if (action.type === "finish") {
        const runningStep = activeTaskPlanStep(this.state.taskPlan);
        if (runningStep?.status === "running") {
          const reason =
            `模型在 Task Plan 步骤 ${runningStep.id} 完成前提前结束。`;
          this.failRunningTaskPlanStep(runningStep.id, reason);
          this.applyEvent({ type: "MODEL_RUNTIME_FAILED", reason });
        } else {
          this.applyEvent({ type: "MODEL_FINISHED", summary: action.summary });
        }
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

  private availableToolsForCurrentState(): AgentToolName[] {
    if (this.state.routeDecision?.skillId === "github-project-discovery") {
      return this.state.phase === "task_planning"
        ? ["search_github_repositories", this.downloadTool, "export_workspace"]
        : ["search_github_repositories"];
    }
    return [
      "read_system_profile",
      "search_trusted_catalog",
      this.downloadTool,
      "export_workspace"
    ];
  }

  private receiveTaskPlanProposal(
    action: Extract<AgentAction, { type: "propose_task_plan" }>,
    provider: "local-rule" | "remote-llm",
    availableTools: AgentToolName[]
  ) {
    if (this.state.phase !== "task_planning") {
      throw new Error("当前阶段不接受新的 Task Plan。");
    }
    const createdAt = new Date().toISOString();
    const planId = `task-plan-${this.state.taskId}`
      .replace(/[^a-z0-9._-]/giu, "-")
      .slice(0, 80);
    const validationContext = {
      tools: defaultTaskPlanToolPolicies.filter((policy) =>
        availableTools.includes(policy.name as AgentToolName)
      ),
      requireInitialConfirmation: true
    };
    const buildPlan = (
      proposal: typeof action.proposal,
      createdBy: "local-rule" | "remote-llm"
    ) => {
      const draft = createTaskPlan({
        planId,
        taskId: this.state.taskId,
        proposal,
        createdBy,
        createdAt
      });
      const validation = validateTaskPlan(draft, validationContext);
      return {
        validation,
        plan: prepareTaskPlanForConfirmation(
          draft,
          validationContext,
          createdAt
        )
      };
    };

    let prepared;
    try {
      if (!this.taskPlanDecisionProtocolMatchesState(action.proposal)) {
        throw new Error("Task Plan 包含宿主无法安全展示的用户决策或 GitHub 查询参数。");
      }
      prepared = buildPlan(action.proposal, provider);
    } catch (error) {
      if (provider !== "remote-llm") throw error;
      const localProposal = createLocalTaskPlanProposal({
        state: this.state,
        step: this.state.agentRun.step,
        maxSteps: this.state.agentRun.maxSteps,
        availableTools,
        toolResults: this.state.agentRun.toolResults
      });
      prepared = buildPlan(localProposal, "local-rule");
    }
    const { plan, validation } = prepared;
    this.applyEvent({ type: "TASK_PLAN_PROPOSED", plan, validation });
  }

  private taskPlanDecisionProtocolMatchesState(
    proposal: Extract<AgentAction, { type: "propose_task_plan" }>["proposal"]
  ) {
    const clarificationIds = new Set(
      this.state.routeDecision?.clarifications.map((question) => question.id) ?? []
    );
    const decisionsValid = proposal.steps
      .filter((step) => step.kind === "user_decision")
      .every((step) => {
        const questionId = step.staticInput.questionId;
        if (typeof questionId === "string") {
          return clarificationIds.has(questionId);
        }
        return this.state.routeDecision?.skillId === "github-project-discovery" &&
          step.staticInput.interaction === "repository_selection";
      });
    if (!decisionsValid) return false;
    if (this.state.routeDecision?.skillId !== "github-project-discovery") {
      return true;
    }

    const searchSteps = proposal.steps.filter(
      (step) => step.tool === "search_github_repositories"
    );
    if (searchSteps.length !== 1) return false;
    try {
      const call = parseAgentToolCall({
        callId: "task-plan-github-search-validation",
        name: "search_github_repositories",
        input: searchSteps[0].staticInput
      });
      return call.name === "search_github_repositories" &&
        sameGitHubSearchInput(
          call.input,
          githubSearchInputFromState(this.state)
        );
    } catch {
      return false;
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
          result.error?.code === "APPROVAL_NOT_FOUND" ||
          result.error?.code === "CATALOG_APPROVAL_MISMATCH" ||
          result.error?.code === "PLAN_APPROVAL_MISMATCH"
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
      if (this.state.phase === "verifying") {
        const runningStep = activeTaskPlanStep(this.state.taskPlan);
        if (
          runningStep?.status === "running" &&
          (runningStep.tool === "controlled_download" ||
            runningStep.tool === "simulate_download")
        ) {
          this.completeRunningTaskPlanStep(
            runningStep.id,
            "全部已审批资源下载完成。",
            {
              resourceIds: this.state.resources
                .filter((item) => item.selected)
                .map((item) => item.id)
            }
          );
        }
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
          result.error?.code === "APPROVAL_NOT_FOUND" ||
          result.error?.code === "CATALOG_APPROVAL_MISMATCH" ||
          result.error?.code === "PLAN_APPROVAL_MISMATCH"
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
      if (this.state.phase === "handoff") {
        const runningStep = activeTaskPlanStep(this.state.taskPlan);
        if (
          runningStep?.status === "running" &&
          runningStep.tool === "export_workspace"
        ) {
          this.completeRunningTaskPlanStep(
            runningStep.id,
            "工作区与 Manifest 已原子导出。",
            result.output
          );
        }
      }
    } finally {
      this.toolStepRunning = false;
      if (this.isCurrentWork(version)) this.drive();
    }
  }

  private async runVerifierStep(version: number) {
    this.verifierStepRunning = true;
    try {
      const event = await this.dependencies.verifier.verify(this.state);
      if (!event || !this.isCurrentWork(version)) return;
      this.applyEvent(event);
      if (this.state.phase === "exporting") {
        const runningStep = activeTaskPlanStep(this.state.taskPlan);
        if (
          runningStep?.status === "running" &&
          runningStep.kind === "verification"
        ) {
          this.completeRunningTaskPlanStep(
            runningStep.id,
            "选中资源已通过来源与完整性验证。",
            {
              verifiedResourceIds: this.state.resources
                .filter((resource) =>
                  resource.selected && resource.status === "verified"
                )
                .map((resource) => resource.id)
            }
          );
        }
      }
    } catch (error) {
      if (this.isCurrentWork(version)) {
        const resourceId =
          this.state.resources.find(
            (resource) =>
              resource.selected && resource.status === "downloaded"
          )?.id ?? this.state.resources.find((resource) => resource.selected)?.id;
        if (resourceId) {
          this.applyEvent({
            type: "VERIFY_RESOURCES",
            failure: {
              resourceId,
              code: "VERIFIER_RUNTIME_FAILED",
              reason:
                error instanceof Error ? error.message : "资源验证器失败。",
              retriable: true
            }
          });
        } else {
          this.applyEvent({
            type: "MODEL_RUNTIME_FAILED",
            reason: "资源验证器没有找到可验证资源。"
          });
        }
      }
    } finally {
      this.verifierStepRunning = false;
      if (this.isCurrentWork(version)) this.drive();
    }
  }

  private isCurrentWork(version: number) {
    return this.started && version === this.workVersion;
  }

  private nextAutomaticEvent(): AgentEvent | null {
    const { phase } = this.state;
    if (phase === "planning") return this.dependencies.planner.createPlan(this.state);
    if (phase === "replanning") return this.dependencies.planner.createReplan(this.state);
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
    typeof output.fileName === "string" &&
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

function taskPlanJsonOutput(value: unknown): unknown {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : JSON.parse(encoded) as unknown;
  } catch {
    return { unavailable: true };
  }
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
