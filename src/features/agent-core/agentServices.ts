import { getTrustedCatalogStatus } from "./catalog";
import { parseAgentToolCall } from "./agentSchemas";
import {
  githubSearchInputFromState,
  sameGitHubSearchInput
} from "./githubSearch";
import { isLocalDevelopmentEnvironmentOutput } from "./developmentEnvironment";
import {
  isGitHubRepositoryFileOutput,
  isGitHubRepositoryTreeOutput,
  isLocalRepositoryFileOutput,
  isLocalRepositoryTreeOutput,
  isProjectRequirementsOutput
} from "./projectRequirements";
import type {
  AgentPolicy,
  AgentToolExecutionOptions,
  AgentToolExecutor
} from "./interfaces";
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
  GitHubRepositoryFileOutput,
  GitHubRepositoryTreeOutput,
  LocalDevelopmentEnvironmentOutput,
  LocalRepositoryFileOutput,
  LocalRepositoryTreeOutput,
  PolicyDecision,
  ProjectRequirementsOutput,
  SimulatedDownloadOutput,
  SystemProfileToolOutput,
  ToolResult,
  WorkspaceExportOutput,
  WorkspaceExportResult
} from "./types";

export type SystemProfileReader = (
  options?: AgentToolExecutionOptions
) => Promise<SystemProfileToolOutput> | SystemProfileToolOutput;
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
  input: GitHubRepositorySearchInput,
  options?: AgentToolExecutionOptions
) => Promise<GitHubRepositorySearchResult>;
export type LocalDevelopmentEnvironmentInspector = (
  options?: AgentToolExecutionOptions
) =>
  | Promise<LocalDevelopmentEnvironmentOutput>
  | LocalDevelopmentEnvironmentOutput;
export type LocalRepositoryTreeReader = (
  input: Extract<AgentToolCall, { name: "list_local_repository_tree" }>["input"],
  options?: AgentToolExecutionOptions
) => Promise<LocalRepositoryTreeOutput> | LocalRepositoryTreeOutput;
export type LocalRepositoryFileReader = (
  input: Extract<AgentToolCall, { name: "read_local_repository_file" }>["input"],
  options?: AgentToolExecutionOptions
) => Promise<LocalRepositoryFileOutput> | LocalRepositoryFileOutput;
export type ProjectRequirementsInspector = (
  input: Extract<AgentToolCall, { name: "inspect_project_requirements" }>["input"],
  options?: AgentToolExecutionOptions
) => Promise<ProjectRequirementsOutput> | ProjectRequirementsOutput;

export type LocalRepositoryAgentToolRunners = {
  listTree: LocalRepositoryTreeReader;
  readFile: LocalRepositoryFileReader;
  inspectRequirements: ProjectRequirementsInspector;
};

export type GitHubRepositoryTreeReader = (
  input: Extract<AgentToolCall, { name: "list_github_repository_tree" }>["input"],
  options?: AgentToolExecutionOptions
) => Promise<GitHubRepositoryTreeOutput> | GitHubRepositoryTreeOutput;
export type GitHubRepositoryFileReader = (
  input: Extract<AgentToolCall, { name: "read_github_repository_file" }>["input"],
  options?: AgentToolExecutionOptions
) => Promise<GitHubRepositoryFileOutput> | GitHubRepositoryFileOutput;
export type GitHubProjectRequirementsInspector = (
  input: Extract<AgentToolCall, { name: "inspect_github_project_requirements" }>["input"],
  options?: AgentToolExecutionOptions
) => Promise<ProjectRequirementsOutput> | ProjectRequirementsOutput;

export type GitHubRepositoryAgentToolRunners = {
  listTree: GitHubRepositoryTreeReader;
  readFile: GitHubRepositoryFileReader;
  inspectRequirements: GitHubProjectRequirementsInspector;
};

const fallbackDevelopmentEnvironmentInspection: LocalDevelopmentEnvironmentInspector = () => ({
  host: { platform: "unknown", architecture: "other" },
  tools: [],
  collectedAt: "in-memory-fallback-static",
  source: "in-memory-fallback",
  boundary: "read-only-fixed-command-allowlist"
});

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
  state: AgentState,
  options?: AgentToolExecutionOptions
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

  async execute(
    call: AgentToolCall,
    state: AgentState,
    options?: AgentToolExecutionOptions
  ) {
    const validatedCall = parseAgentToolCall(call);
    const handler = this.handlers.get(validatedCall.name);
    if (!handler) throw new Error(`Agent Tool 未注册：${validatedCall.name}`);
    return handler(validatedCall, state, options);
  }
}

/** 执行只读系统画像、可信目录查询和下载相关受控工具。 */
export class InMemoryAgentToolExecutor implements AgentToolExecutor {
  private readonly registry = new AgentToolRegistry();

  constructor(
    private readonly readSystemProfile: SystemProfileReader = () =>
      createSystemProfileToolOutput(),
    private readonly controlledDownload?: ControlledDownloadRunner,
    private readonly workspaceExport: WorkspaceExportRunner | undefined =
      controlledDownload ? undefined : simulatedWorkspaceExport,
    private readonly sourceProvider: SourceProvider =
      new TrustedCatalogSourceProvider(),
    private readonly githubRepositorySearch?: GitHubRepositorySearchRunner,
    private readonly inspectDevelopmentEnvironment: LocalDevelopmentEnvironmentInspector =
      fallbackDevelopmentEnvironmentInspection,
    private readonly localRepositoryTools?: LocalRepositoryAgentToolRunners,
    private readonly githubRepositoryTools?: GitHubRepositoryAgentToolRunners
  ) {
    for (const name of [
      "read_system_profile",
      "inspect_local_development_environment",
      "list_local_repository_tree",
      "read_local_repository_file",
      "inspect_project_requirements",
      "list_github_repository_tree",
      "read_github_repository_file",
      "inspect_github_project_requirements",
      "search_trusted_catalog",
      "search_github_repositories",
      "simulate_download",
      "controlled_download",
      "export_workspace"
    ] as const) {
      this.registry.register(name, (call, state, options) =>
        this.executeRegistered(call, state, options)
      );
    }
  }

  execute(
    call: AgentToolCall,
    state: AgentState,
    options?: AgentToolExecutionOptions
  ): Promise<ToolResult> {
    return this.registry.execute(call, state, options);
  }

  private async executeRegistered(
    call: AgentToolCall,
    state: AgentState,
    options?: AgentToolExecutionOptions
  ): Promise<ToolResult> {
    if (call.name === "read_system_profile") {
      try {
        return successResult(call, state, await this.readSystemProfile(options));
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

    if (call.name === "inspect_local_development_environment") {
      if (
        state.phase !== "planning" ||
        ![
          "local-development-environment-inspection",
          "local-environment-compatibility-assessment",
          "local-project-environment-compatibility",
          "github-project-environment-compatibility"
        ].includes(state.routeDecision?.skillId ?? "")
      ) {
        return errorResult(
          call,
          state,
          "DEVELOPMENT_ENVIRONMENT_INSPECTION_NOT_AUTHORIZED",
          "本地开发环境探测只能在对应只读任务的 planning 阶段执行。",
          false
        );
      }
      if (
        state.agentRun.toolResults.some(
          (result) =>
            result.tool === "inspect_local_development_environment"
        )
      ) {
        return errorResult(
          call,
          state,
          "DEVELOPMENT_ENVIRONMENT_INSPECTION_ALREADY_COMPLETED",
          "当前任务已经执行过一次本地开发环境探测。",
          false
        );
      }
      try {
        const output = await this.inspectDevelopmentEnvironment(options);
        if (!isLocalDevelopmentEnvironmentOutput(output)) {
          return errorResult(
            call,
            state,
            "DEVELOPMENT_ENVIRONMENT_INSPECTION_INVALID_OUTPUT",
            "本地开发环境探测返回了不符合协议的结果。",
            false
          );
        }
        return successResult(call, state, output);
      } catch {
        return errorResult(
          call,
          state,
          "DEVELOPMENT_ENVIRONMENT_INSPECTION_FAILED",
          "本地开发环境版本探测失败。",
          true
        );
      }
    }

    if (
      call.name === "list_local_repository_tree" ||
      call.name === "read_local_repository_file" ||
      call.name === "inspect_project_requirements"
    ) {
      const repository = state.localRepository;
      if (
        state.phase !== "planning" ||
        state.routeDecision?.skillId !==
          "local-project-environment-compatibility" ||
        !repository ||
        call.input.repositoryHandleId !== repository.repositoryHandleId ||
        !this.localRepositoryTools
      ) {
        return errorResult(
          call,
          state,
          "LOCAL_REPOSITORY_TOOL_NOT_AUTHORIZED",
          "本地仓库只读工具只能在绑定当前仓库句柄的项目兼容性任务中执行。",
          false
        );
      }
      const existing = state.agentRun.toolResults.filter(
        (result) => result.tool === call.name
      );
      const limit = call.name === "read_local_repository_file" ? 6 : 1;
      if (existing.length >= limit) {
        return errorResult(
          call,
          state,
          "LOCAL_REPOSITORY_TOOL_CALL_LIMIT",
          `${call.name} 已达到当前任务的调用上限。`,
          false
        );
      }
      if (
        call.name === "read_local_repository_file" &&
        existing.some((result) =>
          result.status === "success" &&
          isLocalRepositoryFileOutput(result.output) &&
          result.output.relativePath === call.input.relativePath
        )
      ) {
        return errorResult(
          call,
          state,
          "LOCAL_REPOSITORY_FILE_ALREADY_READ",
          "当前任务已经读取过该仓库证据文件。",
          false
        );
      }
      try {
        const output = call.name === "list_local_repository_tree"
          ? await this.localRepositoryTools.listTree(call.input, options)
          : call.name === "read_local_repository_file"
            ? await this.localRepositoryTools.readFile(call.input, options)
            : await this.localRepositoryTools.inspectRequirements(call.input, options);
        const valid = call.name === "list_local_repository_tree"
          ? isLocalRepositoryTreeOutput(output)
          : call.name === "read_local_repository_file"
            ? isLocalRepositoryFileOutput(output)
            : isProjectRequirementsOutput(output);
        if (!valid) {
          return errorResult(
            call,
            state,
            "LOCAL_REPOSITORY_TOOL_INVALID_OUTPUT",
            "本地仓库只读工具返回了不符合协议的结果。",
            false
          );
        }
        if (
          output.repository.repositoryHandleId !== repository.repositoryHandleId ||
          output.repository.commitSha !== repository.commitSha
        ) {
          return errorResult(
            call,
            state,
            "LOCAL_REPOSITORY_IDENTITY_MISMATCH",
            "本地仓库只读结果与当前固定仓库身份不一致。",
            false
          );
        }
        return successResult(call, state, output);
      } catch (error) {
        return errorResult(
          call,
          state,
          "LOCAL_REPOSITORY_TOOL_FAILED",
          error instanceof DOMException && error.name === "AbortError"
            ? "本地仓库只读检查已取消或超时。"
            : "本地仓库固定 HEAD 的只读检查失败；请确认仓库仍处于当前应用会话。",
          true
        );
      }
    }

    if (
      call.name === "list_github_repository_tree" ||
      call.name === "read_github_repository_file" ||
      call.name === "inspect_github_project_requirements"
    ) {
      const repository = state.githubRepository;
      if (
        state.phase !== "planning" ||
        state.routeDecision?.skillId !==
          "github-project-environment-compatibility" ||
        !repository ||
        call.input.repositoryHandleId !== repository.repositoryHandleId ||
        !this.githubRepositoryTools
      ) {
        return errorResult(
          call,
          state,
          "GITHUB_REPOSITORY_TOOL_NOT_AUTHORIZED",
          "GitHub 仓库只读工具只能在绑定当前固定 commit 的项目兼容性任务中执行。",
          false
        );
      }
      const existing = state.agentRun.toolResults.filter(
        (result) => result.tool === call.name
      );
      const limit = call.name === "read_github_repository_file" ? 6 : 1;
      if (existing.length >= limit) {
        return errorResult(
          call,
          state,
          "GITHUB_REPOSITORY_TOOL_CALL_LIMIT",
          `${call.name} 已达到当前任务的调用上限。`,
          false
        );
      }
      if (
        call.name === "read_github_repository_file" &&
        existing.some((result) =>
          result.status === "success" &&
          isGitHubRepositoryFileOutput(result.output) &&
          result.output.relativePath === call.input.relativePath
        )
      ) {
        return errorResult(
          call,
          state,
          "GITHUB_REPOSITORY_FILE_ALREADY_READ",
          "当前任务已经读取过该 GitHub 仓库证据文件。",
          false
        );
      }
      try {
        const output = call.name === "list_github_repository_tree"
          ? await this.githubRepositoryTools.listTree(call.input, options)
          : call.name === "read_github_repository_file"
            ? await this.githubRepositoryTools.readFile(call.input, options)
            : await this.githubRepositoryTools.inspectRequirements(call.input, options);
        const valid = call.name === "list_github_repository_tree"
          ? isGitHubRepositoryTreeOutput(output)
          : call.name === "read_github_repository_file"
            ? isGitHubRepositoryFileOutput(output)
            : isProjectRequirementsOutput(output);
        if (!valid) {
          return errorResult(
            call,
            state,
            "GITHUB_REPOSITORY_TOOL_INVALID_OUTPUT",
            "GitHub 仓库只读工具返回了不符合协议的结果。",
            false
          );
        }
        if (
          output.repository.repositoryHandleId !== repository.repositoryHandleId ||
          output.repository.commitSha !== repository.commitSha
        ) {
          return errorResult(
            call,
            state,
            "GITHUB_REPOSITORY_IDENTITY_MISMATCH",
            "GitHub 仓库只读结果与当前固定 commit 身份不一致。",
            false
          );
        }
        return successResult(call, state, output);
      } catch (error) {
        return errorResult(
          call,
          state,
          "GITHUB_REPOSITORY_TOOL_FAILED",
          error instanceof DOMException && error.name === "AbortError"
            ? "GitHub 仓库只读检查已取消或超时。"
            : error instanceof Error
              ? error.message
              : "GitHub 固定 commit 的只读检查失败。",
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
        const result = await this.githubRepositorySearch(call.input, options);
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
      if (
        state.routeDecision?.skillId === "github-project-discovery" ||
        [
          "local-development-environment-inspection",
          "local-environment-compatibility-assessment",
          "local-project-environment-compatibility",
          "github-project-environment-compatibility"
        ].includes(state.routeDecision?.skillId ?? "")
      ) {
        return {
          outcome: "deny",
          risk: "high",
          reason: "当前是只读结果任务，禁止创建下载资源计划。"
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

      if (call.name === "inspect_local_development_environment") {
        const alreadyCalled = state.agentRun.toolResults.some(
          (result) =>
            result.tool === "inspect_local_development_environment"
        );
        if (
          state.phase !== "planning" ||
          ![
          "local-development-environment-inspection",
          "local-environment-compatibility-assessment",
          "local-project-environment-compatibility",
          "github-project-environment-compatibility"
          ].includes(state.routeDecision?.skillId ?? "") ||
          alreadyCalled
        ) {
          return {
            outcome: "deny",
            risk: "high",
            reason: "本地开发环境探测只允许在对应只读任务中执行一次。"
          };
        }
        return {
          outcome: "allow",
          risk: "low",
          reason: "该工具只执行固定白名单中的版本查询命令，不接受模型命令、参数或路径。"
        };
      }

      if (
        call.name === "list_local_repository_tree" ||
        call.name === "read_local_repository_file" ||
        call.name === "inspect_project_requirements"
      ) {
        const repository = state.localRepository;
        const sameHandle = repository &&
          call.input.repositoryHandleId === repository.repositoryHandleId;
        const existing = state.agentRun.toolResults.filter(
          (result) => result.tool === call.name
        );
        const callLimit = call.name === "read_local_repository_file" ? 6 : 1;
        if (
          state.phase !== "planning" ||
          state.routeDecision?.skillId !==
            "local-project-environment-compatibility" ||
          !sameHandle ||
          existing.length >= callLimit
        ) {
          return {
            outcome: "deny",
            risk: "high",
            reason: "本地仓库只读工具超出当前项目兼容性任务的句柄、阶段或调用次数边界。"
          };
        }
        return {
          outcome: "allow",
          risk: "low",
          reason: "该工具仅检查用户已导入仓库固定 HEAD 中的已跟踪白名单证据文件。"
        };
      }

      if (
        call.name === "list_github_repository_tree" ||
        call.name === "read_github_repository_file" ||
        call.name === "inspect_github_project_requirements"
      ) {
        const repository = state.githubRepository;
        const sameHandle = repository &&
          call.input.repositoryHandleId === repository.repositoryHandleId;
        const existing = state.agentRun.toolResults.filter(
          (result) => result.tool === call.name
        );
        const callLimit = call.name === "read_github_repository_file" ? 6 : 1;
        if (
          state.phase !== "planning" ||
          state.routeDecision?.skillId !==
            "github-project-environment-compatibility" ||
          !sameHandle ||
          existing.length >= callLimit
        ) {
          return {
            outcome: "deny",
            risk: "high",
            reason: "GitHub 仓库只读工具超出当前固定 commit、阶段或调用次数边界。"
          };
        }
        return {
          outcome: "allow",
          risk: "low",
          reason: "该工具仅通过 GitHub API 读取当前固定 Tree 中的白名单文本证据。"
        };
      }

      if (call.name === "search_github_repositories") {
        const alreadyCalled = state.agentRun.toolResults.some(
          (result) => result.tool === "search_github_repositories"
        );
        const expectedInput = githubSearchInputFromState(state);
        if (state.phase !== "planning") {
          return {
            outcome: "deny",
            risk: "high",
            reason: `GitHub 只读搜索只能在 planning 阶段执行；当前阶段为 ${state.phase}。`
          };
        }
        if (state.routeDecision?.skillId !== "github-project-discovery") {
          return {
            outcome: "deny",
            risk: "high",
            reason: "当前任务没有路由到 GitHub 项目检索能力。"
          };
        }
        if (alreadyCalled) {
          return {
            outcome: "deny",
            risk: "high",
            reason: "GitHub 只读搜索仅允许在对应检索任务中执行一次。"
          };
        }
        if (!sameGitHubSearchInput(call.input, expectedInput)) {
          return {
            outcome: "deny",
            risk: "high",
            reason: "GitHub 搜索参数与用户已确认的检索意图不一致。"
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

    if (
      action.type === "finish" &&
      [
        "local-development-environment-inspection",
        "local-environment-compatibility-assessment",
        "local-project-environment-compatibility",
        "github-project-environment-compatibility"
      ].includes(state.routeDecision?.skillId ?? "") &&
      !state.agentRun.toolResults.some(
        (result) =>
          result.tool === "inspect_local_development_environment"
      )
    ) {
      return {
        outcome: "deny",
        risk: "medium",
        reason: "本地开发环境版本探测尚未执行，不能提前结束。"
      };
    }

    if (
      action.type === "finish" &&
      state.routeDecision?.skillId ===
        "local-project-environment-compatibility"
    ) {
      const requiredTools = [
        "list_local_repository_tree",
        "inspect_project_requirements",
        "inspect_local_development_environment"
      ] as const;
      const missingTool = requiredTools.find((tool) =>
        !state.agentRun.toolResults.some(
          (result) => result.tool === tool && result.status === "success"
        )
      );
      if (missingTool) {
        return {
          outcome: "deny",
          risk: "medium",
          reason: `项目环境兼容性分析尚未取得 ${missingTool} 的成功证据。`
        };
      }
    }

    if (
      action.type === "finish" &&
      state.routeDecision?.skillId ===
        "github-project-environment-compatibility"
    ) {
      const requiredTools = [
        "list_github_repository_tree",
        "inspect_github_project_requirements",
        "inspect_local_development_environment"
      ] as const;
      const missingTool = requiredTools.find((tool) =>
        !state.agentRun.toolResults.some(
          (result) => result.tool === tool && result.status === "success"
        )
      );
      if (missingTool) {
        return {
          outcome: "deny",
          risk: "medium",
          reason: `GitHub 项目环境兼容性分析尚未取得 ${missingTool} 的成功证据。`
        };
      }
    }

    return {
      outcome: "allow",
      risk: "low",
      reason: "该动作不会修改外部环境。"
    };
  }
}
