import { trustedCatalog } from "./catalog";
import type { AgentPolicy, AgentToolExecutor } from "./interfaces";
import type {
  AgentAction,
  AgentState,
  AgentToolCall,
  PolicyDecision,
  SimulatedDownloadOutput,
  ToolResult
} from "./types";

function mockTimestamp(state: AgentState, suffix: string) {
  return `mock-step-${state.agentRun.step}-${suffix}`;
}

function successResult(call: AgentToolCall, state: AgentState, output: unknown): ToolResult {
  return {
    callId: call.callId,
    tool: call.name,
    status: "success",
    output,
    startedAt: mockTimestamp(state, "start"),
    finishedAt: mockTimestamp(state, "finish")
  };
}

function errorResult(
  call: AgentToolCall,
  state: AgentState,
  code: string,
  message: string,
  retriable: boolean
): ToolResult {
  return {
    callId: call.callId,
    tool: call.name,
    status: "error",
    error: { code, message, retriable },
    startedAt: mockTimestamp(state, "start"),
    finishedAt: mockTimestamp(state, "finish")
  };
}

/** 执行只读系统画像、可信目录查询和前端模拟下载三个受控工具。 */
export class InMemoryAgentToolExecutor implements AgentToolExecutor {
  async execute(call: AgentToolCall, state: AgentState): Promise<ToolResult> {
    if (call.name === "read_system_profile") {
      return successResult(call, state, state.systemProfile);
    }

    if (call.name === "search_trusted_catalog") {
      const requestedIds = new Set(call.input.resourceIds ?? []);
      const query = call.input.query.toLowerCase();
      const resources = trustedCatalog.filter((resource) =>
        requestedIds.size > 0
          ? requestedIds.has(resource.id)
          : `${resource.name} ${resource.purpose} ${resource.recommendation}`.toLowerCase().includes(query)
      );
      return successResult(call, state, resources);
    }

    const resource = state.resources.find((item) => item.id === call.input.resourceId);
    if (
      !resource ||
      !resource.selected ||
      state.phase !== "downloading" ||
      state.activeResourceId !== resource.id ||
      state.approvedRevision !== state.revision
    ) {
      return errorResult(
        call,
        state,
        "RESOURCE_NOT_APPROVED",
        "只能模拟下载当前 revision 中已审批且处于活动状态的资源。",
        false
      );
    }

    const sampleFailureAlreadyInjected = state.logs.some((entry) =>
      entry.message.includes("示例项目代码包校验失败")
    );
    if (resource.id === "sample-project" && resource.progress >= 56 && !sampleFailureAlreadyInjected) {
      return errorResult(
        call,
        state,
        "CHECKSUM_MISMATCH",
        "示例项目代码包校验失败：模拟 SHA256 与可信目录不一致",
        true
      );
    }

    const increment = resource.id === "sample-project" && !sampleFailureAlreadyInjected ? 18 : 25;
    const output: SimulatedDownloadOutput = {
      resourceId: resource.id,
      progress: Math.min(resource.id === "sample-project" && !sampleFailureAlreadyInjected ? 56 : 100, resource.progress + increment)
    };
    return successResult(call, state, output);
  }
}

/** 根据动作风险决定直接允许、要求用户审批或拒绝。 */
export class DefaultAgentPolicy implements AgentPolicy {
  evaluate(action: AgentAction, state: AgentState): PolicyDecision {
    if (action.type === "create_plan") {
      return {
        outcome: "require_approval",
        risk: "medium",
        reason: "资源计划会触发后续执行，必须由用户确认。",
        approvalId: `plan-r${state.revision + 1}`
      };
    }

    if (action.type === "create_replan") {
      if (
        state.phase !== "replanning" ||
        !state.requestedReplanStrategy ||
        action.strategy !== state.requestedReplanStrategy
      ) {
        return {
          outcome: "deny",
          risk: "high",
          reason: "模型重规划策略与用户选择不一致。"
        };
      }
      return {
        outcome: "require_approval",
        risk: "medium",
        reason: "替代计划会改变已审批的资源 revision，必须由用户重新确认。",
        approvalId: `plan-r${state.revision + 1}`
      };
    }

    if (action.type === "call_tool") {
      const call = action.call;
      if (call.name !== "simulate_download") {
        return {
          outcome: "allow",
          risk: "low",
          reason: "只读工具可以自动执行。"
        };
      }

      const resource = state.resources.find((item) => item.id === call.input.resourceId);
      if (
        state.phase !== "downloading" ||
        state.activeResourceId !== call.input.resourceId ||
        !resource?.selected ||
        state.approvedRevision !== state.revision
      ) {
        return {
          outcome: "deny",
          risk: "high",
          reason: "资源计划尚未确认或审批 revision 已失效，禁止执行模拟下载。"
        };
      }
      return {
        outcome: "allow",
        risk: "low",
        reason: "该资源已经通过当前 revision 的用户审批。"
      };
    }

    return {
      outcome: "allow",
      risk: "low",
      reason: "该动作不会修改外部环境。"
    };
  }
}
