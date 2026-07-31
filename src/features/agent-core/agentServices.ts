import { getTrustedCatalogStatus } from "./catalog";
import { parseAgentToolCall } from "./agentSchemas";
import {
  githubSearchInputFromState,
  sameGitHubSearchInput
} from "./githubSearch";
import type { AgentPolicy, AgentToolExecutor } from "./interfaces";
import { createSystemProfileToolOutput } from "./systemProfile";
import { resourceIdsForTask } from "./taskRequirements";
import {
  TrustedCatalogSourceProvider,
  type SourceProvider
} from "./sourceProviders";
import type {
  AgentAction,
  AgentState,
  AgentToolCall,
  ControlledDownloadOutput,
  ControlledDownloadResult,
  GitHubRepositorySearchInput,
  GitHubRepositorySearchResult,
  PolicyDecision,
  SimulatedDownloadOutput,
  SystemProfileToolOutput,
  ToolResult,
  WorkspaceExportOutput,
  WorkspaceExportResult
} from "./types";

export type SystemProfileReader = () => Promise<SystemProfileToolOutput> | SystemProfileToolOutput;
export type ControlledDownloadRunner = (request: {
  resourceId: string;
  taskId: string;
  revision: number;
}) => Promise<ControlledDownloadResult>;
export type WorkspaceExportRunner = (request: {
  taskId: string;
  revision: number;
}) => Promise<WorkspaceExportResult>;
export type GitHubRepositorySearchRunner = (
  input: GitHubRepositorySearchInput
) => Promise<GitHubRepositorySearchResult>;

const simulatedWorkspaceFiles = [
  "README.md",
  "RESOURCE_MANIFEST.md",
  "AGENTS.md",
  "resource-manifest.json",
  "scripts/bootstrap.ps1",
  "scripts/verify-environment.ps1"
];

export const simulatedWorkspaceExport: WorkspaceExportRunner = async ({
  taskId,
  revision
}) => ({
  ok: true,
  output: {
    taskId,
    revision,
    rootPath: `/virtual/xunlei-agent/${taskId}/revision-${revision}`,
    generatedAt: `mock-session-revision-${revision}`,
    reusedExisting: false,
    files: simulatedWorkspaceFiles.map((relativePath) => ({
      relativePath,
      absolutePath: `/virtual/xunlei-agent/${taskId}/revision-${revision}/${relativePath}`,
      bytesWritten: 1,
      sha256: "0".repeat(64)
    }))
  }
});

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
    typeof output.fileName === "string" &&
    output.fileName.length > 0 &&
    pathSafeFileName(output.fileName) &&
    typeof output.urlHost === "string" &&
    resource.download.allowedHosts.includes(output.urlHost) &&
    typeof output.bytesWritten === "number" &&
    Number.isFinite(output.bytesWritten) &&
    output.bytesWritten >= 0 &&
    output.bytesWritten <= resource.download.maxSizeMb * 1024 * 1024 &&
    typeof output.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(output.sha256) &&
    (resource.download.expectedSha256 === null
      ? resource.download.digestPolicy === "record-after-download" ||
        resource.download.digestPolicy === "lockfile-integrity"
      : output.sha256.toLowerCase() ===
        resource.download.expectedSha256.toLowerCase()) &&
    typeof output.tempFilePath === "string" &&
    output.tempFilePath.length > 0 &&
    typeof output.elapsedMs === "number" &&
    Number.isFinite(output.elapsedMs) &&
    output.elapsedMs >= 0
  );
}

function pathSafeFileName(fileName: string) {
  return (
    fileName === fileName.replace(/\\/g, "/").split("/").pop() &&
    fileName !== "." &&
    fileName !== ".."
  );
}

function isValidWorkspaceExportOutput(
  value: unknown,
  taskId: string,
  revision: number
): value is WorkspaceExportOutput {
  if (typeof value !== "object" || value === null) return false;
  const output = value as Record<string, unknown>;
  if (
    output.taskId !== taskId ||
    output.revision !== revision ||
    typeof output.rootPath !== "string" ||
    typeof output.generatedAt !== "string" ||
    typeof output.reusedExisting !== "boolean" ||
    !Array.isArray(output.files)
  ) {
    return false;
  }
  return output.files.every((file) => {
    if (typeof file !== "object" || file === null) return false;
    const record = file as Record<string, unknown>;
    return (
      typeof record.relativePath === "string" &&
      typeof record.absolutePath === "string" &&
      typeof record.bytesWritten === "number" &&
      typeof record.sha256 === "string"
    );
  });
}

export type AgentToolHandler = (
  call: AgentToolCall,
  state: AgentState
) => Promise<ToolResult>;

export class AgentToolRegistry implements AgentToolExecutor {
  private readonly handlers = new Map<AgentToolCall["name"], AgentToolHandler>();

  register(name: AgentToolCall["name"], handler: AgentToolHandler) {
    if (this.handlers.has(name)) {
      throw new Error(`Agent Tool 已注册：${name}`);
    }
    this.handlers.set(name, handler);
    return this;
  }

  list() {
    return [...this.handlers.keys()];
  }

  async execute(call: AgentToolCall, state: AgentState) {
    const validatedCall = parseAgentToolCall(call);
    const handler = this.handlers.get(validatedCall.name);
    if (!handler) throw new Error(`Agent Tool 未注册：${validatedCall.name}`);
    return handler(validatedCall, state);
  }
}

/** 执行只读系统画像、可信目录查询和下载相关受控工具。 */
export class InMemoryAgentToolExecutor implements AgentToolExecutor {
  private readonly registry = new AgentToolRegistry();

  constructor(
    private readonly readSystemProfile: SystemProfileReader = createSystemProfileToolOutput,
    private readonly controlledDownload?: ControlledDownloadRunner,
    private readonly workspaceExport: WorkspaceExportRunner | undefined =
      controlledDownload ? undefined : simulatedWorkspaceExport,
    private readonly sourceProvider: SourceProvider =
      new TrustedCatalogSourceProvider(),
    private readonly githubRepositorySearch?: GitHubRepositorySearchRunner
  ) {
    for (const name of [
      "read_system_profile",
      "search_trusted_catalog",
      "search_github_repositories",
      "simulate_download",
      "controlled_download",
      "export_workspace"
    ] as const) {
      this.registry.register(name, (call, state) =>
        this.executeRegistered(call, state)
      );
    }
  }

  execute(call: AgentToolCall, state: AgentState): Promise<ToolResult> {
    return this.registry.execute(call, state);
  }

  private async executeRegistered(
    call: AgentToolCall,
    state: AgentState
  ): Promise<ToolResult> {
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
      const catalogStatus = getTrustedCatalogStatus();
      if (catalogStatus !== "active") {
        return errorResult(
          call,
          state,
          catalogStatus === "expired"
            ? "TRUSTED_CATALOG_EXPIRED"
            : "TRUSTED_CATALOG_INVALID",
          catalogStatus === "expired"
            ? "可信资源目录已过期，必须更新并重新校验后才能生成资源计划。"
            : "可信资源目录当前无效，不能生成资源计划。",
          false
        );
      }
      const requestedIds = call.input.resourceIds ?? [];
      const plannedIds = resourceIdsForTask(state);
      const resourceIds = requestedIds.length > 0 ? requestedIds : plannedIds;
      const resources = (
        resourceIds.length > 0
          ? this.sourceProvider.search({ resourceIds })
          : this.sourceProvider.search({ query: call.input.query })
      ).filter((resource) => resource.sourceTrust !== "trusted-mirror");
      return successResult(call, state, resources);
    }

    if (call.name === "search_github_repositories") {
      if (
        state.phase !== "planning" ||
        state.routeDecision?.skillId !== "github-project-discovery"
      ) {
        return errorResult(
          call,
          state,
          "GITHUB_SEARCH_NOT_AUTHORIZED",
          "GitHub 仓库搜索只能在 GitHub 项目检索任务的 planning 阶段执行。",
          false
        );
      }
      if (!this.githubRepositorySearch) {
        return errorResult(
          call,
          state,
          "GITHUB_SEARCH_UNAVAILABLE",
          "当前运行环境没有提供 GitHub Repository Search 桥接。",
          false
        );
      }
      try {
        const result = await this.githubRepositorySearch(call.input);
        if (result.ok === false) {
          return errorResult(
            call,
            state,
            result.error.code,
            result.error.message,
            result.error.retriable
          );
        }
        return successResult(call, state, result.output);
      } catch {
        return errorResult(
          call,
          state,
          "GITHUB_SEARCH_BRIDGE_ERROR",
          "GitHub Repository Search 桥接调用失败。",
          true
        );
      }
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
        const result = await this.controlledDownload({
          resourceId: resource.id,
          taskId: state.taskId,
          revision: state.revision
        });
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

    if (call.name === "export_workspace") {
      if (
        state.phase !== "exporting" ||
        state.workspace.exportStatus !== "exporting" ||
        call.input.taskId !== state.taskId ||
        call.input.revision !== state.revision ||
        state.approvedRevision !== state.revision ||
        state.resources.some(
          (resource) => resource.selected && resource.status !== "verified"
        )
      ) {
        return errorResult(
          call,
          state,
          "WORKSPACE_EXPORT_NOT_AUTHORIZED",
          "只有当前已审批 revision 的全部选中资源通过验证后才能导出工作区。",
          false
        );
      }
      if (!this.workspaceExport) {
        return errorResult(
          call,
          state,
          "WORKSPACE_EXPORT_UNAVAILABLE",
          "当前运行环境没有提供 Electron 工作区导出桥接。",
          false
        );
      }
      try {
        const result = await this.workspaceExport(call.input);
        if (result.ok === false) {
          return errorResult(
            call,
            state,
            result.error.code,
            result.error.message,
            result.error.retriable
          );
        }
        if (
          !isValidWorkspaceExportOutput(
            result.output,
            state.taskId,
            state.revision
          )
        ) {
          return errorResult(
            call,
            state,
            "WORKSPACE_EXPORT_INVALID_RESPONSE",
            "Electron 工作区导出桥接返回了非法结果。",
            true
          );
        }
        return successResult(call, state, result.output);
      } catch (error) {
        return errorResult(
          call,
          state,
          "WORKSPACE_EXPORT_BRIDGE_ERROR",
          error instanceof Error ? error.message : "Electron 工作区导出桥接调用失败。",
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
    if (action.type === "propose_task_plan") {
      if (state.phase !== "task_planning" || state.taskPlan !== null) {
        return {
          outcome: "deny",
          risk: "medium",
          reason: "首轮 Task Plan 只能在路由完成后的 task_planning 阶段提出一次。"
        };
      }
      return {
        outcome: "require_approval",
        risk: "medium",
        reason: "Task Plan 会决定后续流程顺序，必须先由用户确认；该确认不授予工具写权限。",
        approvalId: "task-plan-r1"
      };
    }

    if (action.type === "create_plan") {
      if (state.routeDecision?.skillId === "github-project-discovery") {
        return {
          outcome: "deny",
          risk: "high",
          reason: "GitHub 项目检索是只读结果任务，禁止创建下载资源计划。"
        };
      }
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

      if (call.name === "search_github_repositories") {
        const alreadyCalled = state.agentRun.toolResults.some(
          (result) => result.tool === "search_github_repositories"
        );
        const expectedInput = githubSearchInputFromState(state);
        if (
          state.phase !== "planning" ||
          state.routeDecision?.skillId !== "github-project-discovery" ||
          alreadyCalled ||
          !sameGitHubSearchInput(call.input, expectedInput)
        ) {
          return {
            outcome: "deny",
            risk: "high",
            reason: "GitHub 只读搜索仅允许在对应检索任务中执行一次。"
          };
        }
        return {
          outcome: "allow",
          risk: "low",
          reason: "GitHub Repository Search 是固定主机上的只读公开数据查询。"
        };
      }

      if (call.name === "export_workspace") {
        const selectedResourcesVerified = state.resources.every(
          (resource) => !resource.selected || resource.status === "verified"
        );
        if (
          state.phase !== "exporting" ||
          state.workspace.exportStatus !== "pending" ||
          call.input.taskId !== state.taskId ||
          call.input.revision !== state.revision ||
          state.approvedRevision !== state.revision ||
          !selectedResourcesVerified
        ) {
          return {
            outcome: "deny",
            risk: "high",
            reason: "工作区导出要求当前 revision 已审批且全部选中资源已验证。"
          };
        }
        return {
          outcome: "allow",
          risk: "medium",
          reason: "工作区导出仅写入受控目录，并使用原子目录替换。"
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

    if (
      action.type === "finish" &&
      state.routeDecision?.skillId === "github-project-discovery" &&
      !state.agentRun.toolResults.some(
        (result) => result.tool === "search_github_repositories"
      )
    ) {
      return {
        outcome: "deny",
        risk: "medium",
        reason: "GitHub 项目检索尚未执行 API Tool，不能提前结束。"
      };
    }

    return {
      outcome: "allow",
      risk: "low",
      reason: "该动作不会修改外部环境。"
    };
  }
}
