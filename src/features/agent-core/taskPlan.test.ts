import { describe, expect, it } from "vitest";
import {
  TaskPlanOperationError,
  approveTaskPlanStep,
  beginTaskPlanReplanning,
  cancelTaskPlan,
  completeTaskPlanStep,
  confirmTaskPlan,
  createTaskPlan,
  defaultTaskPlanToolPolicies,
  extendCompletedTaskPlan,
  getReadyTaskPlanSteps,
  failTaskPlanStep,
  parseTaskPlan,
  parseTaskPlanProposal,
  prepareTaskPlanForConfirmation,
  requestTaskPlanStepApproval,
  requestTaskPlanStepInput,
  resumeTaskPlanStepAfterInput,
  reviseTaskPlan,
  startTaskPlanStep,
  suspendTaskPlanStepForInput,
  validateTaskPlan
} from "./taskPlan";
import type {
  TaskPlan,
  TaskPlanProposal,
  TaskPlanStepProposal
} from "./types";

const timestamps = {
  created: "2026-07-31T08:00:00.000Z",
  confirmed: "2026-07-31T08:01:00.000Z",
  searchStarted: "2026-07-31T08:02:00.000Z",
  searchCompleted: "2026-07-31T08:03:00.000Z",
  inputRequested: "2026-07-31T08:04:00.000Z",
  inputCompleted: "2026-07-31T08:05:00.000Z",
  planStarted: "2026-07-31T08:06:00.000Z",
  planCompleted: "2026-07-31T08:07:00.000Z",
  approvalRequested: "2026-07-31T08:08:00.000Z",
  approved: "2026-07-31T08:09:00.000Z",
  downloadStarted: "2026-07-31T08:10:00.000Z",
  downloadCompleted: "2026-07-31T08:11:00.000Z",
  replanning: "2026-07-31T08:12:00.000Z",
  revised: "2026-07-31T08:13:00.000Z"
};

function step(
  overrides: Partial<TaskPlanStepProposal> & Pick<TaskPlanStepProposal, "id">
): TaskPlanStepProposal {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? `执行 ${overrides.id}`,
    kind: overrides.kind ?? "read_tool",
    tool: overrides.tool === undefined
      ? "search_github_repositories"
      : overrides.tool,
    dependsOn: overrides.dependsOn ?? [],
    staticInput: overrides.staticInput ?? {},
    inputBindings: overrides.inputBindings ?? {},
    expectedOutput: overrides.expectedOutput ?? `${overrides.id} 的结构化结果`,
    risk: overrides.risk ?? "read_only",
    execution: overrides.execution,
    approval: overrides.approval ?? {
      required: false,
      reason: null
    }
  };
}

function tauProposal(): TaskPlanProposal {
  return {
    objective: "查找名为 tau 的 GitHub 仓库并在用户确认后准备到本地。",
    deliverables: ["固定 commit 的仓库资源计划", "可审计的下载结果"],
    assumptions: ["tau 指仓库名称，而不是热门主题。"],
    constraints: [
      "搜索阶段只读。",
      "本地写入必须单独审批。"
    ],
    steps: [
      step({
        id: "search-tau",
        staticInput: {
          mode: "name",
          query: "tau",
          limit: 10
        },
        expectedOutput: "带许可证信息的 tau 仓库候选列表"
      }),
      step({
        id: "select-repository",
        kind: "user_decision",
        tool: null,
        dependsOn: ["search-tau"],
        staticInput: { interaction: "repository_selection" },
        inputBindings: {
          repositories: {
            sourceStepId: "search-tau",
            outputPath: "repositories",
            required: true
          }
        },
        expectedOutput: "用户选择的 owner/repo"
      }),
      step({
        id: "create-resource-plan",
        kind: "resource_plan",
        tool: null,
        dependsOn: ["select-repository"],
        inputBindings: {
          fullName: {
            sourceStepId: "select-repository",
            outputPath: "selection.fullName",
            required: true
          }
        },
        expectedOutput: "固定 commit SHA 的资源计划"
      }),
      step({
        id: "download-repository",
        kind: "write_tool",
        tool: "controlled_download",
        dependsOn: ["create-resource-plan"],
        inputBindings: {
          resourceId: {
            sourceStepId: "create-resource-plan",
            outputPath: "resource.id",
            required: true
          }
        },
        expectedOutput: "经过 SHA256 校验的本地仓库归档",
        risk: "local_write",
        approval: {
          required: true,
          reason: "该步骤会下载文件并写入用户选择的本地目录。"
        }
      })
    ],
    confirmation: {
      required: true,
      reason: "执行 GitHub 查询前先让用户确认完整处理流程。"
    }
  };
}

function createTauPlan() {
  return createTaskPlan({
    planId: "task-plan-tau",
    taskId: "task-tau",
    proposal: tauProposal(),
    createdBy: "remote-llm",
    createdAt: timestamps.created
  });
}

function validation(plan: TaskPlan) {
  return validateTaskPlan(plan, {
    tools: defaultTaskPlanToolPolicies,
    requireInitialConfirmation: true
  });
}

function confirmedTauPlan() {
  return confirmTaskPlan(
    prepareTaskPlanForConfirmation(
      createTauPlan(),
      {
        tools: defaultTaskPlanToolPolicies,
        requireInitialConfirmation: true
      },
      timestamps.created
    ),
    {
      revision: 1,
      confirmedAt: timestamps.confirmed
    }
  );
}

function completeSearch(plan: TaskPlan) {
  return completeTaskPlanStep(
    startTaskPlanStep(plan, "search-tau", timestamps.searchStarted),
    {
      stepId: "search-tau",
      completedAt: timestamps.searchCompleted,
      result: {
        reference: "tool-result:github-search",
        summary: "找到了 10 个候选仓库。"
      }
    }
  );
}

describe("TaskPlan domain core", () => {
  it("creates and validates a user-confirmed DAG independently from the resource plan", () => {
    const plan = createTauPlan();
    const result = validation(plan);

    expect(plan).toMatchObject({
      schemaVersion: 2,
      planId: "task-plan-tau",
      taskId: "task-tau",
      revision: 1,
      previousRevision: null,
      status: "draft",
      confirmation: {
        required: true,
        status: "pending",
        confirmedRevision: null
      }
    });
    expect(plan.steps.every((candidate) => candidate.status === "pending"))
      .toBe(true);
    expect(
      plan.steps.every(
        (candidate) => candidate.execution.mode === "deterministic"
      )
    ).toBe(true);
    expect(result).toEqual({
      valid: true,
      checkedRevision: 1,
      issues: [],
      topologicalOrder: [
        "search-tau",
        "select-repository",
        "create-resource-plan",
        "download-repository"
      ]
    });
    expect(parseTaskPlan(plan)).toEqual(plan);
  });

  it("migrates persisted TaskPlan v1 steps to deterministic v2 execution", () => {
    const current = createTauPlan();
    const legacy = {
      ...structuredClone(current),
      schemaVersion: 1,
      steps: current.steps.map(({ execution: _execution, ...candidate }) =>
        structuredClone(candidate)
      )
    };

    const migrated = parseTaskPlan(legacy);

    expect(migrated).toMatchObject({
      schemaVersion: 2,
      planId: current.planId,
      revision: current.revision
    });
    expect(
      migrated.steps.map((candidate) => candidate.execution)
    ).toEqual(
      current.steps.map(() => ({ mode: "deterministic" }))
    );
    expect(validation(migrated).valid).toBe(true);
  });

  it("accepts a read-only analysis step with a bounded agent loop", () => {
    const proposal: TaskPlanProposal = {
      objective: "评估本机开发环境与 PyTorch 的兼容性。",
      deliverables: ["已具备、缺失和待确认条件的兼容性结论"],
      assumptions: [],
      constraints: ["仅允许读取本机环境，不安装或下载任何资源。"],
      steps: [
        step({
          id: "assess-local-environment",
          kind: "analysis",
          tool: null,
          expectedOutput: "带证据的本机环境兼容性结论",
          execution: {
            mode: "agent_loop",
            allowedTools: ["inspect_local_development_environment"],
            maxRisk: "read_only",
            allowParallelReads: false,
            maxTurns: 6,
            maxToolCalls: 8,
            maxRepeatedCalls: 2,
            maxWallTimeMs: 120_000,
            completionCriteria: [
              "至少调用一次本机开发环境检查工具。",
              "明确列出已具备、缺失和待确认的条件。"
            ]
          }
        })
      ],
      confirmation: {
        required: true,
        reason: "执行只读环境检查前确认分析范围。"
      }
    };

    const plan = createTaskPlan({
      planId: "task-plan-local-compatibility",
      taskId: "task-local-compatibility",
      proposal,
      createdBy: "remote-llm",
      createdAt: timestamps.created
    });

    expect(validation(plan)).toEqual({
      valid: true,
      checkedRevision: 1,
      issues: [],
      topologicalOrder: ["assess-local-environment"]
    });
    expect(plan.steps[0]).toMatchObject({
      kind: "analysis",
      tool: null,
      execution: {
        mode: "agent_loop",
        allowedTools: ["inspect_local_development_environment"],
        maxRisk: "read_only"
      }
    });
  });

  it("rejects agent loops outside analysis steps or with write capabilities", () => {
    const invalidKindProposal = tauProposal();
    invalidKindProposal.steps = [
      step({
        id: "read-with-agent-loop",
        execution: {
          mode: "agent_loop",
          allowedTools: ["inspect_local_development_environment"],
          maxRisk: "read_only",
          allowParallelReads: false,
          maxTurns: 4,
          maxToolCalls: 4,
          maxRepeatedCalls: 2,
          maxWallTimeMs: 60_000,
          completionCriteria: ["返回本机环境信息。"]
        }
      })
    ];
    const invalidKind = validation(createTaskPlan({
      planId: "task-plan-invalid-agent-loop-kind",
      taskId: "task-invalid-agent-loop-kind",
      proposal: invalidKindProposal,
      createdBy: "remote-llm",
      createdAt: timestamps.created
    }));

    const unsafeCapabilityProposal = tauProposal();
    unsafeCapabilityProposal.steps = [
      step({
        id: "unsafe-analysis",
        kind: "analysis",
        tool: null,
        execution: {
          mode: "agent_loop",
          allowedTools: ["controlled_download"],
          maxRisk: "read_only",
          allowParallelReads: false,
          maxTurns: 4,
          maxToolCalls: 4,
          maxRepeatedCalls: 2,
          maxWallTimeMs: 60_000,
          completionCriteria: ["完成兼容性分析。"]
        }
      })
    ];
    const unsafeCapability = validation(createTaskPlan({
      planId: "task-plan-unsafe-agent-loop-tool",
      taskId: "task-unsafe-agent-loop-tool",
      proposal: unsafeCapabilityProposal,
      createdBy: "remote-llm",
      createdAt: timestamps.created
    }));

    expect(invalidKind.issues).toContainEqual(
      expect.objectContaining({
        code: "AGENT_LOOP_STEP_KIND_INVALID",
        stepId: "read-with-agent-loop"
      })
    );
    expect(unsafeCapability.issues).toContainEqual(
      expect.objectContaining({
        code: "AGENT_LOOP_TOOL_RISK_INVALID",
        stepId: "unsafe-analysis",
        tool: "controlled_download"
      })
    );
  });

  it("rejects duplicate tools in an agent loop capability envelope", () => {
    const proposal = tauProposal();
    proposal.steps = [
      step({
        id: "duplicate-loop-tool",
        kind: "analysis",
        tool: null,
        execution: {
          mode: "agent_loop",
          allowedTools: [
            "inspect_local_development_environment",
            "inspect_local_development_environment"
          ],
          maxRisk: "read_only",
          allowParallelReads: false,
          maxTurns: 4,
          maxToolCalls: 4,
          maxRepeatedCalls: 1,
          maxWallTimeMs: 60_000,
          completionCriteria: ["返回本机环境信息。"]
        }
      })
    ];

    const result = validation(createTaskPlan({
      planId: "task-plan-duplicate-loop-tool",
      taskId: "task-duplicate-loop-tool",
      proposal,
      createdBy: "remote-llm",
      createdAt: timestamps.created
    }));

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "AGENT_LOOP_TOOL_DUPLICATE",
      stepId: "duplicate-loop-tool"
    }));
  });

  it("rejects user decisions that the host cannot render", () => {
    const plan = createTauPlan();
    const selection = plan.steps.find(
      (candidate) => candidate.id === "select-repository"
    );
    expect(selection).toBeDefined();
    selection!.staticInput = {};

    expect(validation(plan).issues).toContainEqual(
      expect.objectContaining({
        code: "USER_DECISION_PROTOCOL_INVALID",
        stepId: "select-repository"
      })
    );
  });

  it("rejects invalid dependencies, unregistered tools and hidden side effects", () => {
    const proposal = tauProposal();
    proposal.steps = [
      step({
        id: "unsafe",
        kind: "write_tool",
        tool: "unknown_shell",
        dependsOn: ["missing"],
        risk: "code_execution",
        approval: { required: false, reason: null }
      }),
      step({
        id: "self-dependent",
        dependsOn: ["self-dependent"]
      }),
      step({
        id: "cycle-a",
        dependsOn: ["cycle-b"]
      }),
      step({
        id: "cycle-b",
        dependsOn: ["cycle-a"]
      }),
      step({
        id: "bad-binding",
        dependsOn: [],
        inputBindings: {
          result: {
            sourceStepId: "unsafe",
            outputPath: "output",
            required: true
          }
        }
      })
    ];
    const result = validation(createTaskPlan({
      planId: "task-plan-invalid",
      taskId: "task-invalid",
      proposal,
      createdBy: "remote-llm",
      createdAt: timestamps.created
    }));

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "UNKNOWN_DEPENDENCY",
        "SELF_DEPENDENCY",
        "CYCLIC_DEPENDENCY",
        "TOOL_NOT_ALLOWED",
        "APPROVAL_REQUIRED",
        "BINDING_DEPENDENCY_MISSING"
      ])
    );
    expect(() =>
      prepareTaskPlanForConfirmation(
        createTaskPlan({
          planId: "task-plan-invalid-prepare",
          taskId: "task-invalid-prepare",
          proposal,
          createdBy: "remote-llm",
          createdAt: timestamps.created
        }),
        {
          tools: defaultTaskPlanToolPolicies,
          requireInitialConfirmation: true
        },
        timestamps.created
      )
    ).toThrowError(
      expect.objectContaining({
        code: "PLAN_INVALID"
      })
    );
  });

  it("requires the current TaskPlan revision to be confirmed before execution", () => {
    const waiting = prepareTaskPlanForConfirmation(
      createTauPlan(),
      {
        tools: defaultTaskPlanToolPolicies,
        requireInitialConfirmation: true
      },
      timestamps.created
    );

    expect(waiting.status).toBe("waiting_confirmation");
    expect(() =>
      confirmTaskPlan(waiting, {
        revision: 2,
        confirmedAt: timestamps.confirmed
      })
    ).toThrowError(
      expect.objectContaining({
        code: "PLAN_REVISION_MISMATCH"
      })
    );

    const confirmed = confirmTaskPlan(waiting, {
      revision: 1,
      confirmedAt: timestamps.confirmed
    });
    expect(confirmed).toMatchObject({
      status: "executing",
      confirmation: {
        status: "confirmed",
        confirmedRevision: 1,
        confirmedAt: timestamps.confirmed
      }
    });
    expect(getReadyTaskPlanSteps(confirmed).map((candidate) => candidate.id))
      .toEqual(["search-tau"]);
  });

  it("does not accept a step approval bound to another TaskPlan revision", () => {
    const plan = createTauPlan();
    const download = plan.steps.find(
      (candidate) => candidate.id === "download-repository"
    )!;
    download.approval.status = "approved";
    download.approval.approvedAt = timestamps.approved;
    download.approval.approvedRevision = 2;

    const result = validation(plan);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "APPROVAL_REVISION_MISMATCH",
        stepId: "download-repository"
      })
    );
  });

  it("advances read, user-decision, resource-plan and approved write steps", () => {
    let plan = completeSearch(confirmedTauPlan());
    expect(getReadyTaskPlanSteps(plan).map((candidate) => candidate.id))
      .toEqual(["select-repository"]);

    plan = requestTaskPlanStepInput(
      plan,
      "select-repository",
      timestamps.inputRequested
    );
    expect(plan.status).toBe("waiting_user_input");
    plan = completeTaskPlanStep(plan, {
      stepId: "select-repository",
      completedAt: timestamps.inputCompleted,
      result: {
        reference: "user-selection:owner/tau",
        summary: "用户选择 owner/tau。"
      }
    });

    plan = completeTaskPlanStep(
      startTaskPlanStep(
        plan,
        "create-resource-plan",
        timestamps.planStarted
      ),
      {
        stepId: "create-resource-plan",
        completedAt: timestamps.planCompleted,
        result: {
          reference: "resource-plan:r1",
          summary: "已固定 commit 并生成资源计划。"
        }
      }
    );
    expect(() =>
      startTaskPlanStep(
        plan,
        "download-repository",
        timestamps.downloadStarted
      )
    ).toThrowError(
      expect.objectContaining({
        code: "STEP_APPROVAL_REQUIRED"
      })
    );

    plan = requestTaskPlanStepApproval(
      plan,
      "download-repository",
      timestamps.approvalRequested
    );
    expect(plan.status).toBe("waiting_approval");
    plan = approveTaskPlanStep(plan, {
      stepId: "download-repository",
      revision: 1,
      approvedAt: timestamps.approved
    });
    plan = completeTaskPlanStep(
      startTaskPlanStep(
        plan,
        "download-repository",
        timestamps.downloadStarted
      ),
      {
        stepId: "download-repository",
        completedAt: timestamps.downloadCompleted,
        result: {
          reference: "download-artifact:owner-tau",
          summary: "仓库归档已下载并完成 SHA256 校验。"
        }
      }
    );

    expect(plan.status).toBe("completed");
    expect(plan.steps[plan.steps.length - 1]).toMatchObject({
      status: "completed",
      approval: {
        status: "approved",
        approvedRevision: 1
      }
    });
    expect(validation(plan).valid).toBe(true);
  });

  it("suspends and resumes a running resource-plan step for model clarification", () => {
    let plan = completeSearch(confirmedTauPlan());
    plan = requestTaskPlanStepInput(
      plan,
      "select-repository",
      timestamps.inputRequested
    );
    plan = completeTaskPlanStep(plan, {
      stepId: "select-repository",
      completedAt: timestamps.inputCompleted,
      result: {
        reference: "user-selection:owner/tau",
        summary: "用户选择 owner/tau。",
        output: { fullName: "owner/tau" }
      }
    });
    plan = startTaskPlanStep(
      plan,
      "create-resource-plan",
      timestamps.planStarted
    );

    const waiting = suspendTaskPlanStepForInput(
      plan,
      "create-resource-plan",
      timestamps.planCompleted
    );
    expect(waiting).toMatchObject({
      status: "waiting_user_input",
      steps: expect.arrayContaining([
        expect.objectContaining({
          id: "create-resource-plan",
          status: "waiting_user_input"
        })
      ])
    });
    expect(
      resumeTaskPlanStepAfterInput(
        waiting,
        "create-resource-plan",
        timestamps.approvalRequested
      )
    ).toMatchObject({
      status: "executing",
      steps: expect.arrayContaining([
        expect.objectContaining({
          id: "create-resource-plan",
          status: "running"
        })
      ])
    });
  });

  it("creates a new revision, resets confirmation and only preserves unchanged completed steps", () => {
    const searched = completeSearch(confirmedTauPlan());
    const replanning = beginTaskPlanReplanning(
      searched,
      timestamps.replanning
    );
    const proposal = tauProposal();
    proposal.assumptions = [
      ...proposal.assumptions,
      "精确名称匹配优先于名称包含匹配。"
    ];
    const revised = reviseTaskPlan(replanning, {
      proposal,
      reason: "用户补充了候选仓库排序要求。",
      revisedAt: timestamps.revised,
      createdBy: "remote-llm",
      preserveCompletedStepIds: ["search-tau"]
    });

    expect(revised).toMatchObject({
      revision: 2,
      previousRevision: 1,
      revisionReason: "用户补充了候选仓库排序要求。",
      status: "draft",
      confirmation: {
        status: "pending",
        confirmedRevision: null
      }
    });
    expect(revised.steps[0]).toMatchObject({
      id: "search-tau",
      status: "completed",
      result: {
        reference: "tool-result:github-search"
      }
    });
    expect(revised.steps[1].status).toBe("pending");
    expect(validation(revised).valid).toBe(true);

    const incompatible = tauProposal();
    incompatible.steps[0].staticInput = {
      mode: "name",
      query: "tau-agent",
      limit: 10
    };
    expect(() =>
      reviseTaskPlan(replanning, {
        proposal: incompatible,
        reason: "改变搜索目标。",
        revisedAt: timestamps.revised,
        createdBy: "remote-llm",
        preserveCompletedStepIds: ["search-tau"]
      })
    ).toThrowError(
      expect.objectContaining({
        code: "STEP_NOT_PRESERVABLE"
      })
    );
  });

  it("records step failure and supports explicit cancellation", () => {
    const running = startTaskPlanStep(
      confirmedTauPlan(),
      "search-tau",
      timestamps.searchStarted
    );
    const failed = failTaskPlanStep(
      running,
      "search-tau",
      "GitHub API 暂时不可用。",
      timestamps.searchCompleted
    );
    expect(failed.status).toBe("failed");
    expect(
      failed.steps.find((candidate) => candidate.id === "search-tau")
    ).toMatchObject({
      id: "search-tau",
      status: "failed",
      error: "GitHub API 暂时不可用。"
    });
    expect(
      beginTaskPlanReplanning(failed, timestamps.replanning).status
    ).toBe("replanning");

    const cancelled = cancelTaskPlan(createTauPlan(), timestamps.replanning);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.steps.every((step) => step.status === "skipped")).toBe(true);
  });

  it("adds a separately confirmed revision after a completed plan", () => {
    let completed = confirmedTauPlan();
    for (const step of completed.steps) {
      if (step.status === "pending") {
        step.status = "completed";
        step.result = {
          reference: `test:${step.id}`,
          summary: `${step.title} 已完成。`
        };
        step.startedAt = timestamps.searchStarted;
        step.completedAt = timestamps.downloadCompleted;
      }
    }
    completed.status = "completed";
    const proposal = tauProposal();
    proposal.objective = "追加本地下载范围";
    const extension = extendCompletedTaskPlan(completed, {
      proposal,
      reason: "用户在查询完成后选择准备到本地。",
      extendedAt: timestamps.revised,
      createdBy: "local-rule"
    });

    expect(extension).toMatchObject({
      revision: 2,
      previousRevision: 1,
      status: "draft",
      confirmation: { status: "pending" }
    });
    expect(extension.steps.every((step) => step.status === "pending")).toBe(true);
  });

  it("accepts only strict JSON-safe planner proposals", () => {
    expect(() =>
      parseTaskPlanProposal({
        ...tauProposal(),
        hiddenReasoning: "should not be persisted"
      })
    ).toThrow();
    expect(() =>
      parseTaskPlanProposal({
        ...tauProposal(),
        steps: [
          {
            ...tauProposal().steps[0],
            staticInput: {
              invalid: () => undefined
            }
          }
        ]
      })
    ).toThrow();
  });

  it("returns structured operation errors", () => {
    try {
      startTaskPlanStep(
        createTauPlan(),
        "search-tau",
        timestamps.searchStarted
      );
      throw new Error("Expected TaskPlanOperationError.");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskPlanOperationError);
      expect(error).toMatchObject({
        code: "PLAN_STATUS_INVALID"
      });
    }
  });
});
