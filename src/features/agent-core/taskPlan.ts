import { z } from "zod";
import type {
  TaskPlan,
  TaskPlanInputBinding,
  TaskPlanProposal,
  TaskPlanStep,
  TaskPlanStepKind,
  TaskPlanStepProposal,
  TaskPlanStepResult,
  TaskPlanToolPolicy,
  TaskPlanValidationIssue,
  TaskPlanValidationIssueCode,
  TaskPlanValidationResult
} from "./types";

const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const toolNamePattern = /^[a-z0-9][a-z0-9._:-]{0,119}$/i;
const identifierSchema = z.string().trim().regex(identifierPattern);
const textSchema = z.string().trim().min(1).max(4000);
const timestampSchema = z.string().datetime();
const nullableTimestampSchema = timestampSchema.nullable();

const inputBindingSchema = z.object({
  sourceStepId: identifierSchema,
  outputPath: z.string()
    .trim()
    .regex(
      /^\$?[A-Za-z_][A-Za-z0-9_-]*(?:(?:\.[A-Za-z_][A-Za-z0-9_-]*)|(?:\[\d+\]))*$/
    )
    .max(300),
  required: z.boolean()
}).strict();

const stepBaseShape = {
  id: identifierSchema,
  title: z.string().trim().min(1).max(200),
  description: textSchema,
  kind: z.enum([
    "read_tool",
    "user_decision",
    "resource_plan",
    "write_tool",
    "verification",
    "handoff"
  ]),
  tool: z.string().trim().regex(toolNamePattern).nullable(),
  dependsOn: z.array(identifierSchema).max(50),
  staticInput: z.record(z.string().trim().min(1).max(120), z.json()),
  inputBindings: z.record(
    z.string().trim().min(1).max(120),
    inputBindingSchema
  ),
  expectedOutput: textSchema,
  risk: z.enum([
    "read_only",
    "local_write",
    "external_write",
    "code_execution"
  ])
};

export const taskPlanStepProposalSchema = z.object({
  ...stepBaseShape,
  approval: z.object({
    required: z.boolean(),
    reason: textSchema.nullable()
  }).strict()
}).strict();

export const taskPlanProposalSchema = z.object({
  objective: textSchema,
  deliverables: z.array(textSchema).min(1).max(50),
  assumptions: z.array(textSchema).max(50),
  constraints: z.array(textSchema).max(50),
  steps: z.array(taskPlanStepProposalSchema).min(1).max(100),
  confirmation: z.object({
    required: z.boolean(),
    reason: textSchema.nullable()
  }).strict()
}).strict();

const taskPlanStepSchema = z.object({
  ...stepBaseShape,
  approval: z.object({
    required: z.boolean(),
    reason: textSchema.nullable(),
    status: z.enum(["not_required", "pending", "approved"]),
    approvedAt: nullableTimestampSchema,
    approvedRevision: z.number().int().positive().nullable()
  }).strict(),
  status: z.enum([
    "pending",
    "running",
    "waiting_user_input",
    "waiting_approval",
    "completed",
    "failed",
    "skipped",
    "blocked"
  ]),
  result: z.object({
    reference: z.string().trim().min(1).max(500),
    summary: textSchema,
    output: z.json().optional()
  }).strict().nullable(),
  error: textSchema.nullable(),
  startedAt: nullableTimestampSchema,
  completedAt: nullableTimestampSchema
}).strict();

export const taskPlanSchema = z.object({
  schemaVersion: z.literal(1),
  planId: identifierSchema,
  taskId: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/i),
  revision: z.number().int().positive(),
  previousRevision: z.number().int().positive().nullable(),
  revisionReason: textSchema,
  objective: textSchema,
  deliverables: z.array(textSchema).min(1).max(50),
  assumptions: z.array(textSchema).max(50),
  constraints: z.array(textSchema).max(50),
  steps: z.array(taskPlanStepSchema).min(1).max(100),
  status: z.enum([
    "draft",
    "waiting_confirmation",
    "executing",
    "waiting_user_input",
    "waiting_approval",
    "replanning",
    "completed",
    "failed",
    "cancelled"
  ]),
  confirmation: z.object({
    required: z.boolean(),
    reason: textSchema.nullable(),
    status: z.enum(["not_required", "pending", "confirmed"]),
    confirmedAt: nullableTimestampSchema,
    confirmedRevision: z.number().int().positive().nullable()
  }).strict(),
  createdBy: z.enum(["local-rule", "remote-llm", "user"]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();

export type CreateTaskPlanInput = {
  planId: string;
  taskId: string;
  proposal: TaskPlanProposal;
  createdBy: TaskPlan["createdBy"];
  createdAt: string;
};

export type TaskPlanValidationContext = {
  tools: readonly TaskPlanToolPolicy[];
  maxSteps?: number;
  requireInitialConfirmation?: boolean;
};

export type ConfirmTaskPlanInput = {
  revision: number;
  confirmedAt: string;
};

export type ApproveTaskPlanStepInput = {
  stepId: string;
  revision: number;
  approvedAt: string;
};

export type CompleteTaskPlanStepInput = {
  stepId: string;
  completedAt: string;
  result: TaskPlanStepResult;
};

export type ReviseTaskPlanInput = {
  proposal: TaskPlanProposal;
  reason: string;
  revisedAt: string;
  createdBy: TaskPlan["createdBy"];
  preserveCompletedStepIds?: readonly string[];
};

export type ExtendTaskPlanInput = {
  proposal: TaskPlanProposal;
  reason: string;
  extendedAt: string;
  createdBy: TaskPlan["createdBy"];
};

export type TaskPlanOperationErrorCode =
  | "PLAN_INVALID"
  | "PLAN_STATUS_INVALID"
  | "PLAN_REVISION_MISMATCH"
  | "STEP_NOT_FOUND"
  | "STEP_NOT_READY"
  | "STEP_KIND_INVALID"
  | "STEP_APPROVAL_REQUIRED"
  | "STEP_APPROVAL_NOT_REQUIRED"
  | "STEP_STATUS_INVALID"
  | "STEP_NOT_PRESERVABLE"
  | "STEP_INPUT_NOT_PENDING";

export class TaskPlanOperationError extends Error {
  constructor(
    readonly code: TaskPlanOperationErrorCode,
    message: string,
    readonly validation?: TaskPlanValidationResult
  ) {
    super(message);
    this.name = "TaskPlanOperationError";
  }
}

export const defaultTaskPlanToolPolicies: readonly TaskPlanToolPolicy[] = [
  {
    name: "read_system_profile",
    allowedStepKinds: ["read_tool"],
    risk: "read_only",
    approvalRequired: false
  },
  {
    name: "search_trusted_catalog",
    allowedStepKinds: ["read_tool"],
    risk: "read_only",
    approvalRequired: false
  },
  {
    name: "search_github_repositories",
    allowedStepKinds: ["read_tool"],
    risk: "read_only",
    approvalRequired: false
  },
  {
    name: "simulate_download",
    allowedStepKinds: ["read_tool", "verification"],
    risk: "read_only",
    approvalRequired: false
  },
  {
    name: "controlled_download",
    allowedStepKinds: ["write_tool"],
    risk: "local_write",
    approvalRequired: true
  },
  {
    name: "export_workspace",
    allowedStepKinds: ["write_tool"],
    risk: "local_write",
    approvalRequired: true
  }
];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function initializeStep(
  proposal: TaskPlanStepProposal,
  revision: number
): TaskPlanStep {
  return {
    ...clone(proposal),
    approval: {
      ...proposal.approval,
      status: proposal.approval.required ? "pending" : "not_required",
      approvedAt: null,
      approvedRevision: proposal.approval.required ? null : revision
    },
    status: "pending",
    result: null,
    error: null,
    startedAt: null,
    completedAt: null
  };
}

export function parseTaskPlanProposal(value: unknown): TaskPlanProposal {
  return taskPlanProposalSchema.parse(value) as TaskPlanProposal;
}

export function parseTaskPlan(value: unknown): TaskPlan {
  return taskPlanSchema.parse(value) as TaskPlan;
}

export function createTaskPlan(input: CreateTaskPlanInput): TaskPlan {
  const proposal = parseTaskPlanProposal(input.proposal);
  const createdAt = timestampSchema.parse(input.createdAt);
  return taskPlanSchema.parse({
    schemaVersion: 1,
    planId: input.planId,
    taskId: input.taskId,
    revision: 1,
    previousRevision: null,
    revisionReason: "initial",
    objective: proposal.objective,
    deliverables: proposal.deliverables,
    assumptions: proposal.assumptions,
    constraints: proposal.constraints,
    steps: proposal.steps.map((step) => initializeStep(step, 1)),
    status: "draft",
    confirmation: {
      ...proposal.confirmation,
      status: proposal.confirmation.required ? "pending" : "not_required",
      confirmedAt: null,
      confirmedRevision: proposal.confirmation.required ? null : 1
    },
    createdBy: input.createdBy,
    createdAt,
    updatedAt: createdAt
  }) as TaskPlan;
}

function validationIssue(
  code: TaskPlanValidationIssueCode,
  message: string,
  detail: Pick<
    TaskPlanValidationIssue,
    "stepId" | "dependencyId" | "tool"
  > = {}
): TaskPlanValidationIssue {
  return { code, message, ...detail };
}

function uniqueSteps(plan: TaskPlan) {
  const steps = new Map<string, TaskPlanStep>();
  for (const step of plan.steps) {
    if (!steps.has(step.id)) steps.set(step.id, step);
  }
  return steps;
}

function topologicalOrder(
  plan: TaskPlan,
  issues: TaskPlanValidationIssue[]
) {
  const steps = uniqueSteps(plan);
  const indegree = new Map([...steps.keys()].map((id) => [id, 0]));
  const dependants = new Map<string, string[]>();
  for (const step of steps.values()) {
    for (const dependencyId of new Set(step.dependsOn)) {
      if (!steps.has(dependencyId) || dependencyId === step.id) continue;
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      dependants.set(dependencyId, [
        ...(dependants.get(dependencyId) ?? []),
        step.id
      ]);
    }
  }
  const queue = plan.steps
    .map((step) => step.id)
    .filter(
      (id, index, ids) =>
        ids.indexOf(id) === index && (indegree.get(id) ?? 0) === 0
    );
  const ordered: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    ordered.push(id);
    for (const dependantId of dependants.get(id) ?? []) {
      const next = (indegree.get(dependantId) ?? 0) - 1;
      indegree.set(dependantId, next);
      if (next === 0) queue.push(dependantId);
    }
  }
  if (ordered.length !== steps.size) {
    issues.push(
      validationIssue(
        "CYCLIC_DEPENDENCY",
        "任务计划步骤依赖包含循环，无法确定安全执行顺序。"
      )
    );
  }
  return ordered;
}

function dependsOnStep(
  step: TaskPlanStep,
  sourceStepId: string,
  steps: Map<string, TaskPlanStep>,
  visited = new Set<string>()
): boolean {
  for (const dependencyId of step.dependsOn) {
    if (dependencyId === sourceStepId) return true;
    if (visited.has(dependencyId)) continue;
    visited.add(dependencyId);
    const dependency = steps.get(dependencyId);
    if (
      dependency &&
      dependsOnStep(dependency, sourceStepId, steps, visited)
    ) {
      return true;
    }
  }
  return false;
}

function validatePlanStatus(
  plan: TaskPlan,
  issues: TaskPlanValidationIssue[]
) {
  const active = plan.steps.filter((step) =>
    [
      "running",
      "waiting_user_input",
      "waiting_approval"
    ].includes(step.status)
  );
  if (active.length > 1) {
    issues.push(
      validationIssue(
        "INVALID_STEP_STATUS",
        "当前执行器一次只允许一个步骤处于运行或等待状态。"
      )
    );
  }
  if (
    plan.confirmation.required &&
    [
      "executing",
      "waiting_user_input",
      "waiting_approval",
      "completed"
    ].includes(plan.status) &&
    (
      plan.confirmation.status !== "confirmed" ||
      plan.confirmation.confirmedRevision !== plan.revision
    )
  ) {
    issues.push(
      validationIssue(
        "INVALID_PLAN_STATUS",
        `任务计划 r${plan.revision} 尚未获得当前 revision 的确认。`
      )
    );
  }
  if (
    plan.status === "waiting_confirmation" &&
    plan.confirmation.status !== "pending"
  ) {
    issues.push(
      validationIssue(
        "INVALID_PLAN_STATUS",
        "等待确认的任务计划必须保留 pending 确认状态。"
      )
    );
  }
  if (
    plan.status === "waiting_user_input" &&
    !plan.steps.some((step) => step.status === "waiting_user_input")
  ) {
    issues.push(
      validationIssue(
        "INVALID_PLAN_STATUS",
        "任务计划标记为等待用户输入，但没有对应步骤。"
      )
    );
  }
  if (
    plan.status === "waiting_approval" &&
    !plan.steps.some((step) => step.status === "waiting_approval")
  ) {
    issues.push(
      validationIssue(
        "INVALID_PLAN_STATUS",
        "任务计划标记为等待审批，但没有对应步骤。"
      )
    );
  }
  if (
    plan.status === "completed" &&
    plan.steps.some(
      (step) => step.status !== "completed" && step.status !== "skipped"
    )
  ) {
    issues.push(
      validationIssue(
        "INVALID_PLAN_STATUS",
        "任务计划仍有未完成步骤，不能标记为 completed。"
      )
    );
  }
}

export function validateTaskPlan(
  plan: TaskPlan,
  context: TaskPlanValidationContext
): TaskPlanValidationResult {
  const issues: TaskPlanValidationIssue[] = [];
  const maxSteps = context.maxSteps ?? 30;
  const requireConfirmation = context.requireInitialConfirmation ?? true;
  const tools = new Map(context.tools.map((tool) => [tool.name, tool]));
  const stepById = uniqueSteps(plan);
  const seen = new Set<string>();

  if (
    plan.revision < 1 ||
    (plan.previousRevision !== null &&
      plan.previousRevision !== plan.revision - 1)
  ) {
    issues.push(
      validationIssue(
        "INVALID_REVISION",
        "任务计划 revision 必须从 1 开始并连续递增。"
      )
    );
  }
  if (requireConfirmation && !plan.confirmation.required) {
    issues.push(
      validationIssue(
        "INITIAL_CONFIRMATION_REQUIRED",
        "当前产品策略要求首轮 Task Plan 必须由用户确认。"
      )
    );
  }
  if (plan.steps.length === 0) {
    issues.push(validationIssue("EMPTY_PLAN", "任务计划至少需要一个步骤。"));
  }
  if (plan.steps.length > maxSteps) {
    issues.push(
      validationIssue(
        "TOO_MANY_STEPS",
        `任务计划包含 ${plan.steps.length} 个步骤，超过上限 ${maxSteps}。`
      )
    );
  }

  for (const step of plan.steps) {
    if (seen.has(step.id)) {
      issues.push(
        validationIssue(
          "DUPLICATE_STEP",
          `任务计划步骤 ${step.id} 重复。`,
          { stepId: step.id }
        )
      );
    }
    seen.add(step.id);
    for (const dependencyId of step.dependsOn) {
      if (dependencyId === step.id) {
        issues.push(
          validationIssue(
            "SELF_DEPENDENCY",
            `步骤 ${step.id} 不能依赖自身。`,
            { stepId: step.id, dependencyId }
          )
        );
      } else if (!stepById.has(dependencyId)) {
        issues.push(
          validationIssue(
            "UNKNOWN_DEPENDENCY",
            `步骤 ${step.id} 依赖不存在的步骤 ${dependencyId}。`,
            { stepId: step.id, dependencyId }
          )
        );
      }
    }

    for (const binding of Object.values(
      step.inputBindings
    ) as TaskPlanInputBinding[]) {
      if (!stepById.has(binding.sourceStepId)) {
        issues.push(
          validationIssue(
            "UNKNOWN_BINDING_SOURCE",
            `步骤 ${step.id} 引用了不存在的输出步骤 ${binding.sourceStepId}。`,
            { stepId: step.id, dependencyId: binding.sourceStepId }
          )
        );
      } else if (
        !dependsOnStep(step, binding.sourceStepId, stepById)
      ) {
        issues.push(
          validationIssue(
            "BINDING_DEPENDENCY_MISSING",
            `步骤 ${step.id} 使用了 ${binding.sourceStepId} 的输出，但没有依赖该步骤。`,
            { stepId: step.id, dependencyId: binding.sourceStepId }
          )
        );
      }
    }

    if (step.kind === "user_decision") {
      const questionId = step.staticInput.questionId;
      const interaction = step.staticInput.interaction;
      if (
        !(typeof questionId === "string" && questionId.trim()) &&
        interaction !== "repository_selection"
      ) {
        issues.push(
          validationIssue(
            "USER_DECISION_PROTOCOL_INVALID",
            `步骤 ${step.id} 没有绑定可展示的澄清问题或仓库选择交互。`,
            { stepId: step.id }
          )
        );
      }
    }

    const toolRequired =
      step.kind === "read_tool" || step.kind === "write_tool";
    if (toolRequired && !step.tool) {
      issues.push(
        validationIssue(
          "TOOL_REQUIRED",
          `步骤 ${step.id} 的类型 ${step.kind} 必须绑定已注册工具。`,
          { stepId: step.id }
        )
      );
    }
    if (step.tool) {
      const policy = tools.get(step.tool);
      if (!policy) {
        issues.push(
          validationIssue(
            "TOOL_NOT_ALLOWED",
            `步骤 ${step.id} 使用了未注册工具 ${step.tool}。`,
            { stepId: step.id, tool: step.tool }
          )
        );
      } else {
        if (!policy.allowedStepKinds.includes(step.kind)) {
          issues.push(
            validationIssue(
              "TOOL_KIND_MISMATCH",
              `工具 ${step.tool} 不能用于 ${step.kind} 步骤。`,
              { stepId: step.id, tool: step.tool }
            )
          );
        }
        if (policy.risk !== step.risk) {
          issues.push(
            validationIssue(
              "TOOL_RISK_MISMATCH",
              `步骤 ${step.id} 声明的风险与工具 ${step.tool} 的注册策略不一致。`,
              { stepId: step.id, tool: step.tool }
            )
          );
        }
        if (policy.approvalRequired && !step.approval.required) {
          issues.push(
            validationIssue(
              "APPROVAL_REQUIRED",
              `工具 ${step.tool} 执行前必须取得独立审批。`,
              { stepId: step.id, tool: step.tool }
            )
          );
        }
      }
    }
    if (step.risk !== "read_only" && !step.approval.required) {
      issues.push(
        validationIssue(
          "APPROVAL_REQUIRED",
          `步骤 ${step.id} 具有 ${step.risk} 副作用，必须声明审批。`,
          { stepId: step.id, tool: step.tool ?? undefined }
        )
      );
    }
    if (step.approval.required && !step.approval.reason) {
      issues.push(
        validationIssue(
          "APPROVAL_REASON_REQUIRED",
          `步骤 ${step.id} 要求审批时必须说明原因。`,
          { stepId: step.id }
        )
      );
    }
    if (
      step.approval.required &&
      step.approval.status === "not_required"
    ) {
      issues.push(
        validationIssue(
          "INVALID_STEP_STATUS",
          `步骤 ${step.id} 要求审批，但审批状态被标记为 not_required。`,
          { stepId: step.id }
        )
      );
    }
    if (
      !step.approval.required &&
      step.approval.status !== "not_required"
    ) {
      issues.push(
        validationIssue(
          "INVALID_STEP_STATUS",
          `步骤 ${step.id} 不要求审批，不应持有审批状态。`,
          { stepId: step.id }
        )
      );
    }
    if (
      step.approval.required &&
      step.approval.status === "approved" &&
      step.status !== "completed" &&
      step.status !== "skipped" &&
      step.approval.approvedRevision !== plan.revision
    ) {
      issues.push(
        validationIssue(
          "APPROVAL_REVISION_MISMATCH",
          `步骤 ${step.id} 的审批不属于当前 Task Plan revision r${plan.revision}。`,
          { stepId: step.id }
        )
      );
    }
  }

  const order = topologicalOrder(plan, issues);
  validatePlanStatus(plan, issues);
  return {
    valid: issues.length === 0,
    checkedRevision: plan.revision,
    issues,
    topologicalOrder: order
  };
}

function updatePlanStep(
  plan: TaskPlan,
  stepId: string,
  update: (step: TaskPlanStep) => TaskPlanStep
) {
  let found = false;
  const steps = plan.steps.map((step) => {
    if (step.id !== stepId) return clone(step);
    found = true;
    return update(clone(step));
  });
  if (!found) {
    throw new TaskPlanOperationError(
      "STEP_NOT_FOUND",
      `任务计划中不存在步骤 ${stepId}。`
    );
  }
  return steps;
}

function readyStep(plan: TaskPlan, stepId: string) {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    throw new TaskPlanOperationError(
      "STEP_NOT_FOUND",
      `任务计划中不存在步骤 ${stepId}。`
    );
  }
  if (step.status !== "pending") {
    throw new TaskPlanOperationError(
      "STEP_STATUS_INVALID",
      `步骤 ${stepId} 当前状态为 ${step.status}，不能开始。`
    );
  }
  const dependenciesReady = step.dependsOn.every((dependencyId) => {
    const dependency = plan.steps.find(
      (candidate) => candidate.id === dependencyId
    );
    return (
      dependency?.status === "completed" ||
      dependency?.status === "skipped"
    );
  });
  if (!dependenciesReady) {
    throw new TaskPlanOperationError(
      "STEP_NOT_READY",
      `步骤 ${stepId} 的依赖尚未完成。`
    );
  }
  return step;
}

function ensureExecuting(plan: TaskPlan) {
  if (plan.status !== "executing") {
    throw new TaskPlanOperationError(
      "PLAN_STATUS_INVALID",
      `任务计划当前状态为 ${plan.status}，不能执行新步骤。`
    );
  }
  if (
    plan.steps.some((step) =>
      ["running", "waiting_user_input", "waiting_approval"].includes(
        step.status
      )
    )
  ) {
    throw new TaskPlanOperationError(
      "STEP_NOT_READY",
      "当前已有步骤正在运行或等待处理。"
    );
  }
}

export function prepareTaskPlanForConfirmation(
  plan: TaskPlan,
  context: TaskPlanValidationContext,
  updatedAt: string
): TaskPlan {
  const validation = validateTaskPlan(plan, context);
  if (!validation.valid) {
    throw new TaskPlanOperationError(
      "PLAN_INVALID",
      "Task Plan 未通过结构与权限校验。",
      validation
    );
  }
  if (plan.status !== "draft" && plan.status !== "replanning") {
    throw new TaskPlanOperationError(
      "PLAN_STATUS_INVALID",
      `状态为 ${plan.status} 的 Task Plan 不能提交确认。`
    );
  }
  return {
    ...clone(plan),
    status: plan.confirmation.required
      ? "waiting_confirmation"
      : "executing",
    updatedAt: timestampSchema.parse(updatedAt)
  };
}

export function confirmTaskPlan(
  plan: TaskPlan,
  input: ConfirmTaskPlanInput
): TaskPlan {
  if (plan.status !== "waiting_confirmation") {
    throw new TaskPlanOperationError(
      "PLAN_STATUS_INVALID",
      "只有等待确认的 Task Plan 才能被确认。"
    );
  }
  if (input.revision !== plan.revision) {
    throw new TaskPlanOperationError(
      "PLAN_REVISION_MISMATCH",
      `确认 revision r${input.revision} 与当前 Task Plan r${plan.revision} 不一致。`
    );
  }
  const confirmedAt = timestampSchema.parse(input.confirmedAt);
  return {
    ...clone(plan),
    status: "executing",
    confirmation: {
      ...plan.confirmation,
      status: "confirmed",
      confirmedAt,
      confirmedRevision: plan.revision
    },
    updatedAt: confirmedAt
  };
}

export function getReadyTaskPlanSteps(plan: TaskPlan): TaskPlanStep[] {
  if (plan.status !== "executing") return [];
  if (
    plan.steps.some((step) =>
      ["running", "waiting_user_input", "waiting_approval"].includes(
        step.status
      )
    )
  ) {
    return [];
  }
  return plan.steps
    .filter(
      (step) =>
        step.status === "pending" &&
        step.dependsOn.every((dependencyId) => {
          const dependency = plan.steps.find(
            (candidate) => candidate.id === dependencyId
          );
          return (
            dependency?.status === "completed" ||
            dependency?.status === "skipped"
          );
        })
    )
    .map((step) => clone(step));
}

export function requestTaskPlanStepApproval(
  plan: TaskPlan,
  stepId: string,
  updatedAt: string
): TaskPlan {
  ensureExecuting(plan);
  const step = readyStep(plan, stepId);
  if (!step.approval.required) {
    throw new TaskPlanOperationError(
      "STEP_APPROVAL_NOT_REQUIRED",
      `步骤 ${stepId} 不需要审批。`
    );
  }
  if (step.approval.status === "approved") {
    throw new TaskPlanOperationError(
      "STEP_STATUS_INVALID",
      `步骤 ${stepId} 已经取得审批。`
    );
  }
  const at = timestampSchema.parse(updatedAt);
  return {
    ...clone(plan),
    status: "waiting_approval",
    steps: updatePlanStep(plan, stepId, (candidate) => ({
      ...candidate,
      status: "waiting_approval"
    })),
    updatedAt: at
  };
}

export function approveTaskPlanStep(
  plan: TaskPlan,
  input: ApproveTaskPlanStepInput
): TaskPlan {
  if (plan.status !== "waiting_approval") {
    throw new TaskPlanOperationError(
      "PLAN_STATUS_INVALID",
      "Task Plan 当前没有等待中的步骤审批。"
    );
  }
  if (input.revision !== plan.revision) {
    throw new TaskPlanOperationError(
      "PLAN_REVISION_MISMATCH",
      `步骤审批 revision r${input.revision} 与当前 Task Plan r${plan.revision} 不一致。`
    );
  }
  const step = plan.steps.find((candidate) => candidate.id === input.stepId);
  if (!step) {
    throw new TaskPlanOperationError(
      "STEP_NOT_FOUND",
      `任务计划中不存在步骤 ${input.stepId}。`
    );
  }
  if (
    step.status !== "waiting_approval" ||
    !step.approval.required
  ) {
    throw new TaskPlanOperationError(
      "STEP_STATUS_INVALID",
      `步骤 ${input.stepId} 当前没有等待审批。`
    );
  }
  const approvedAt = timestampSchema.parse(input.approvedAt);
  return {
    ...clone(plan),
    status: "executing",
    steps: updatePlanStep(plan, input.stepId, (candidate) => ({
      ...candidate,
      status: "pending",
      approval: {
        ...candidate.approval,
        status: "approved",
        approvedAt,
        approvedRevision: plan.revision
      }
    })),
    updatedAt: approvedAt
  };
}

export function requestTaskPlanStepInput(
  plan: TaskPlan,
  stepId: string,
  updatedAt: string
): TaskPlan {
  ensureExecuting(plan);
  const step = readyStep(plan, stepId);
  if (step.kind !== "user_decision") {
    throw new TaskPlanOperationError(
      "STEP_KIND_INVALID",
      `步骤 ${stepId} 不是用户决策步骤。`
    );
  }
  const at = timestampSchema.parse(updatedAt);
  return {
    ...clone(plan),
    status: "waiting_user_input",
    steps: updatePlanStep(plan, stepId, (candidate) => ({
      ...candidate,
      status: "waiting_user_input",
      startedAt: at
    })),
    updatedAt: at
  };
}

/** 暂停正在运行的资源规划步骤，以接收模型发现的补充输入。 */
export function suspendTaskPlanStepForInput(
  plan: TaskPlan,
  stepId: string,
  updatedAt: string
): TaskPlan {
  if (plan.status !== "executing") {
    throw new TaskPlanOperationError(
      "PLAN_STATUS_INVALID",
      "只有执行中的 Task Plan 才能暂停等待补充输入。"
    );
  }
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    throw new TaskPlanOperationError(
      "STEP_NOT_FOUND",
      `任务计划中不存在步骤 ${stepId}。`
    );
  }
  if (step.status !== "running" || step.kind !== "resource_plan") {
    throw new TaskPlanOperationError(
      "STEP_STATUS_INVALID",
      `步骤 ${stepId} 当前不能暂停等待补充输入。`
    );
  }
  const at = timestampSchema.parse(updatedAt);
  return {
    ...clone(plan),
    status: "waiting_user_input",
    steps: updatePlanStep(plan, stepId, (candidate) => ({
      ...candidate,
      status: "waiting_user_input"
    })),
    updatedAt: at
  };
}

/** 用户补充输入后恢复先前暂停的资源规划步骤。 */
export function resumeTaskPlanStepAfterInput(
  plan: TaskPlan,
  stepId: string,
  updatedAt: string
): TaskPlan {
  if (plan.status !== "waiting_user_input") {
    throw new TaskPlanOperationError(
      "PLAN_STATUS_INVALID",
      "Task Plan 当前没有等待中的补充输入。"
    );
  }
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    throw new TaskPlanOperationError(
      "STEP_NOT_FOUND",
      `任务计划中不存在步骤 ${stepId}。`
    );
  }
  if (step.status !== "waiting_user_input" || step.kind !== "resource_plan") {
    throw new TaskPlanOperationError(
      "STEP_INPUT_NOT_PENDING",
      `步骤 ${stepId} 当前没有等待模型补充输入。`
    );
  }
  const at = timestampSchema.parse(updatedAt);
  return {
    ...clone(plan),
    status: "executing",
    steps: updatePlanStep(plan, stepId, (candidate) => ({
      ...candidate,
      status: "running"
    })),
    updatedAt: at
  };
}

export function startTaskPlanStep(
  plan: TaskPlan,
  stepId: string,
  startedAt: string
): TaskPlan {
  ensureExecuting(plan);
  const step = readyStep(plan, stepId);
  if (step.kind === "user_decision") {
    throw new TaskPlanOperationError(
      "STEP_KIND_INVALID",
      `步骤 ${stepId} 必须通过用户输入流程推进。`
    );
  }
  if (
    step.approval.required &&
    (
      step.approval.status !== "approved" ||
      step.approval.approvedRevision !== plan.revision
    )
  ) {
    throw new TaskPlanOperationError(
      "STEP_APPROVAL_REQUIRED",
      `步骤 ${stepId} 尚未取得当前 Task Plan revision 的审批。`
    );
  }
  const at = timestampSchema.parse(startedAt);
  return {
    ...clone(plan),
    steps: updatePlanStep(plan, stepId, (candidate) => ({
      ...candidate,
      status: "running",
      startedAt: at
    })),
    updatedAt: at
  };
}

function planStatusAfterCompletion(steps: TaskPlanStep[]) {
  return steps.every(
    (step) => step.status === "completed" || step.status === "skipped"
  )
    ? "completed" as const
    : "executing" as const;
}

export function completeTaskPlanStep(
  plan: TaskPlan,
  input: CompleteTaskPlanStepInput
): TaskPlan {
  const step = plan.steps.find((candidate) => candidate.id === input.stepId);
  if (!step) {
    throw new TaskPlanOperationError(
      "STEP_NOT_FOUND",
      `任务计划中不存在步骤 ${input.stepId}。`
    );
  }
  if (
    step.status !== "running" &&
    step.status !== "waiting_user_input"
  ) {
    throw new TaskPlanOperationError(
      "STEP_STATUS_INVALID",
      `步骤 ${input.stepId} 当前状态为 ${step.status}，不能标记完成。`
    );
  }
  const completedAt = timestampSchema.parse(input.completedAt);
  const result = z.object({
    reference: z.string().trim().min(1).max(500),
    summary: textSchema,
    output: z.json().optional()
  }).strict().parse(input.result) as TaskPlanStepResult;
  const steps = updatePlanStep(plan, input.stepId, (candidate) => ({
    ...candidate,
    status: "completed",
    result,
    error: null,
    completedAt
  }));
  return {
    ...clone(plan),
    status: planStatusAfterCompletion(steps),
    steps,
    updatedAt: completedAt
  };
}

export function failTaskPlanStep(
  plan: TaskPlan,
  stepId: string,
  reason: string,
  failedAt: string
): TaskPlan {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    throw new TaskPlanOperationError(
      "STEP_NOT_FOUND",
      `任务计划中不存在步骤 ${stepId}。`
    );
  }
  if (
    !["running", "waiting_user_input", "waiting_approval"].includes(
      step.status
    )
  ) {
    throw new TaskPlanOperationError(
      "STEP_STATUS_INVALID",
      `步骤 ${stepId} 当前状态为 ${step.status}，不能标记失败。`
    );
  }
  const at = timestampSchema.parse(failedAt);
  const message = textSchema.parse(reason);
  return {
    ...clone(plan),
    status: "failed",
    steps: updatePlanStep(plan, stepId, (candidate) => ({
      ...candidate,
      status: "failed",
      error: message,
      completedAt: at
    })),
    updatedAt: at
  };
}

export function beginTaskPlanReplanning(
  plan: TaskPlan,
  updatedAt: string
): TaskPlan {
  if (
    ![
      "executing",
      "waiting_user_input",
      "waiting_approval",
      "failed"
    ].includes(plan.status)
  ) {
    throw new TaskPlanOperationError(
      "PLAN_STATUS_INVALID",
      `状态为 ${plan.status} 的 Task Plan 不能进入重规划。`
    );
  }
  return {
    ...clone(plan),
    status: "replanning",
    updatedAt: timestampSchema.parse(updatedAt)
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

function sameStepDefinition(
  current: TaskPlanStep,
  proposal: TaskPlanStepProposal
) {
  const definition = (step: TaskPlanStep | TaskPlanStepProposal) => ({
    id: step.id,
    kind: step.kind,
    tool: step.tool,
    dependsOn: step.dependsOn,
    staticInput: step.staticInput,
    inputBindings: step.inputBindings,
    expectedOutput: step.expectedOutput,
    risk: step.risk,
    approval: {
      required: step.approval.required,
      reason: step.approval.reason
    }
  });
  return JSON.stringify(stableValue(definition(current))) ===
    JSON.stringify(stableValue(definition(proposal)));
}

export function reviseTaskPlan(
  plan: TaskPlan,
  input: ReviseTaskPlanInput
): TaskPlan {
  if (plan.status !== "replanning" && plan.status !== "failed") {
    throw new TaskPlanOperationError(
      "PLAN_STATUS_INVALID",
      "Task Plan 必须先进入 replanning 或 failed 状态才能创建新 revision。"
    );
  }
  const proposal = parseTaskPlanProposal(input.proposal);
  const revisedAt = timestampSchema.parse(input.revisedAt);
  const reason = textSchema.parse(input.reason);
  const preserveIds = new Set(input.preserveCompletedStepIds ?? []);
  const revision = plan.revision + 1;
  const steps = proposal.steps.map((stepProposal) => {
    if (!preserveIds.has(stepProposal.id)) {
      return initializeStep(stepProposal, revision);
    }
    const current = plan.steps.find((step) => step.id === stepProposal.id);
    if (
      !current ||
      current.status !== "completed" ||
      !sameStepDefinition(current, stepProposal)
    ) {
      throw new TaskPlanOperationError(
        "STEP_NOT_PRESERVABLE",
        `步骤 ${stepProposal.id} 未完成或定义已经变化，不能沿用旧 revision 的结果。`
      );
    }
    return {
      ...initializeStep(stepProposal, revision),
      status: "completed" as const,
      approval: clone(current.approval),
      result: clone(current.result),
      startedAt: current.startedAt,
      completedAt: current.completedAt
    };
  });
  const unknownPreserveId = [...preserveIds].find(
    (id) => !proposal.steps.some((step) => step.id === id)
  );
  if (unknownPreserveId) {
    throw new TaskPlanOperationError(
      "STEP_NOT_PRESERVABLE",
      `新 Task Plan 中不存在要沿用的步骤 ${unknownPreserveId}。`
    );
  }
  return taskPlanSchema.parse({
    schemaVersion: 1,
    planId: plan.planId,
    taskId: plan.taskId,
    revision,
    previousRevision: plan.revision,
    revisionReason: reason,
    objective: proposal.objective,
    deliverables: proposal.deliverables,
    assumptions: proposal.assumptions,
    constraints: proposal.constraints,
    steps,
    status: "draft",
    confirmation: {
      ...proposal.confirmation,
      status: proposal.confirmation.required ? "pending" : "not_required",
      confirmedAt: null,
      confirmedRevision: proposal.confirmation.required ? null : revision
    },
    createdBy: input.createdBy,
    createdAt: revisedAt,
    updatedAt: revisedAt
  }) as TaskPlan;
}

/** 为已经完成的任务追加一段由用户显式触发的新执行范围。 */
export function extendCompletedTaskPlan(
  plan: TaskPlan,
  input: ExtendTaskPlanInput
): TaskPlan {
  if (plan.status !== "completed") {
    throw new TaskPlanOperationError(
      "PLAN_STATUS_INVALID",
      "只有已完成的 Task Plan 才能追加新的执行范围。"
    );
  }
  const proposal = parseTaskPlanProposal(input.proposal);
  const extendedAt = timestampSchema.parse(input.extendedAt);
  const reason = textSchema.parse(input.reason);
  const revision = plan.revision + 1;
  return taskPlanSchema.parse({
    schemaVersion: 1,
    planId: plan.planId,
    taskId: plan.taskId,
    revision,
    previousRevision: plan.revision,
    revisionReason: reason,
    objective: proposal.objective,
    deliverables: proposal.deliverables,
    assumptions: proposal.assumptions,
    constraints: proposal.constraints,
    steps: proposal.steps.map((step) => initializeStep(step, revision)),
    status: "draft",
    confirmation: {
      ...proposal.confirmation,
      status: proposal.confirmation.required ? "pending" : "not_required",
      confirmedAt: null,
      confirmedRevision: proposal.confirmation.required ? null : revision
    },
    createdBy: input.createdBy,
    createdAt: extendedAt,
    updatedAt: extendedAt
  }) as TaskPlan;
}

export function cancelTaskPlan(
  plan: TaskPlan,
  cancelledAt: string
): TaskPlan {
  if (plan.status === "completed") {
    throw new TaskPlanOperationError(
      "PLAN_STATUS_INVALID",
      "已经完成的 Task Plan 不能取消。"
    );
  }
  return {
    ...clone(plan),
    status: "cancelled",
    steps: plan.steps.map((step) =>
      step.status === "completed" || step.status === "failed"
        ? clone(step)
        : {
            ...clone(step),
            status: "skipped" as const,
            error: null
          }
    ),
    updatedAt: timestampSchema.parse(cancelledAt)
  };
}
