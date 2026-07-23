import { trustedCatalog } from "./catalog";
import type { AgentPolicy, AgentToolExecutor } from "./interfaces";
import { createSystemProfileToolOutput } from "./systemProfile";
import type {
  AgentAction,
  AgentState,
  AgentToolCall,
  ControlledDownloadOutput,
  ControlledDownloadResult,
  PolicyDecision,
  SimulatedDownloadOutput,
  SystemProfileToolOutput,
  ToolResult
} from "./types";

export type SystemProfileReader = () => Promise<SystemProfileToolOutput> | SystemProfileToolOutput;
export type ControlledDownloadRunner = (resourceId: string) => Promise<ControlledDownloadResult>;

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

function downloadHostAllowed(url: string, allowedHosts: string[]) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && allowedHosts.includes(parsed.host);
  } catch {
    return false;
  }
}

function isApprovedActiveResource(call: AgentToolCall, state: AgentState) {
  if (call.name !== "simulate_download" && call.name !== "controlled_download") return null;
  const resource = state.resources.find((item) => item.id === call.input.resourceId);
  return resource?.selected &&
    state.phase === "downloading" &&
    state.activeResourceId === resource.id &&
    state.approvedRevision === state.revision
    ? resource
    : null;
}

function isValidControlledDownloadOutput(
  value: unknown,
  resource: AgentState["resources"][number]
): value is ControlledDownloadOutput {
  if (typeof value !== "object" || value === null) return false;
  const output = value as Record<string, unknown>;
  return (
    output.resourceId === resource.id &&
    typeof output.urlHost === "string" &&
    resource.download.allowedHosts.includes(output.urlHost) &&
    typeof output.bytesWritten === "number" &&
    Number.isFinite(output.bytesWritten) &&
    output.bytesWritten >= 0 &&
    output.bytesWritten <= resource.download.maxSizeMb * 1024 * 1024 &&
    typeof output.sha256 === "string" &&
    output.sha256.toLowerCase() === resource.download.expectedSha256.toLowerCase() &&
    typeof output.tempFilePath === "string" &&
    output.tempFilePath.length > 0 &&
    typeof output.elapsedMs === "number" &&
    Number.isFinite(output.elapsedMs) &&
    output.elapsedMs >= 0
  );
}

/** 执行只读系统画像、可信目录查询和下载相关受控工具。 */
export class InMemoryAgentToolExecutor implements AgentToolExecutor {
  constructor(
    private readonly readSystemProfile: SystemProfileReader = createSystemProfileToolOutput,
    private readonly controlledDownload?: ControlledDownloadRunner
  ) {}

  async execute(call: AgentToolCall, state: AgentState): Promise<ToolResult> {
    if (call.name === "read_system_profile") {
      try {
        return successResult(call, state, await this.readSystemProfile());
      } catch (error) {
        return errorResult(
          call,
          state,
          "SYSTEM_PROFILE_UNAVAILABLE",
          error instanceof Error ? error.message : "系统画像读取失败。",
          true
        );
      }
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

    if (call.name === "controlled_download") {
      const resource = isApprovedActiveResource(call, state);
      if (!resource) {
        return errorResult(
          call,
          state,
          "RESOURCE_NOT_APPROVED",
          "只能下载当前 revision 中已审批且处于活动状态的资源。",
          false
        );
      }
      if (!downloadHostAllowed(resource.download.url, resource.download.allowedHosts)) {
        return errorResult(
          call,
          state,
          "URL_NOT_ALLOWED",
          "真实下载 URL 不在可信资源目录允许的 HTTPS 主机内。",
          false
        );
      }
      if (!this.controlledDownload) {
        return errorResult(
          call,
          state,
          "CONTROLLED_DOWNLOAD_UNAVAILABLE",
          "当前运行环境没有提供 Electron 受控下载桥接。",
          false
        );
      }

      try {
        const result = await this.controlledDownload(resource.id);
        if (result.ok === false) {
          return errorResult(
            call,
            state,
            result.error.code,
            result.error.message,
            result.error.retriable
          );
        }
        if (!isValidControlledDownloadOutput(result.output, resource)) {
          return errorResult(
            call,
            state,
            "CONTROLLED_DOWNLOAD_INVALID_RESPONSE",
            "Electron 受控下载桥接返回了与可信目录不一致的结果。",
            true
          );
        }
        return successResult(call, state, result.output);
      } catch (error) {
        return errorResult(
          call,
          state,
          "CONTROLLED_DOWNLOAD_BRIDGE_ERROR",
          error instanceof Error ? error.message : "Electron 受控下载桥接调用失败。",
          true
        );
      }
    }

    const resource = isApprovedActiveResource(call, state);
    if (!resource) {
      return errorResult(
        call,
        state,
        "RESOURCE_NOT_APPROVED",
        "只能下载当前 revision 中已审批且处于活动状态的资源。",
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
      if (call.name === "read_system_profile" || call.name === "search_trusted_catalog") {
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
          reason: "资源计划尚未确认或审批 revision 已失效，禁止执行下载工具。"
        };
      }
      if (call.name === "controlled_download") {
        if (!downloadHostAllowed(resource.download.url, resource.download.allowedHosts)) {
          return {
            outcome: "deny",
            risk: "high",
            reason: "真实下载 URL 不在可信资源目录允许的 HTTPS 主机内。"
          };
        }
        return {
          outcome: "allow",
          risk: "medium",
          reason: "该资源已经通过当前 revision 审批，且下载 URL 来自可信目录允许主机。"
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
