import {
  DefaultAgentPolicy,
  InMemoryAgentToolExecutor,
  type GitHubRepositorySearchRunner
} from "../src/features/agent-core/agentServices";
import { parseAgentUserEvent } from "../src/features/agent-core/agentSchemas";
import {
  isGitHubRepositorySearchOutput,
  latestGitHubRepositorySearchResult
} from "../src/features/agent-core/githubSearch";
import { LocalRuleModelRuntime } from "../src/features/agent-core/localRuleModel";
import {
  ModelConnectionController,
  ModelConnectionRequestError
} from "../src/features/agent-core/modelConnection";
import {
  FallbackModelRuntime,
  parseRemoteDecision,
  RemoteLlmModelRuntime
} from "../src/features/agent-core/remoteModel";
import { normalizeRestorableAgentState } from "../src/features/agent-core/persistence";
import {
  AgentRuntime,
  createTimeoutScheduler
} from "../src/features/agent-core/runtime";
import type {
  AgentRuntimeSnapshot,
  PlatformCapabilitySummary,
  RuntimePersistenceState
} from "../src/features/agent-core/runtimeBridge";
import { createSystemProfileToolOutput } from "../src/features/agent-core/systemProfile";
import {
  FixedWindowsPlanner
} from "../src/features/agent-core/mockServices";
import { createDefaultDomainSkillRegistry } from "../src/features/agent-core/domainSkills";
import {
  createDefaultSourceProviderRegistry
} from "../src/features/agent-core/sourceProviders";
import { ExtensibleAgentRouter } from "../src/features/agent-core/router";
import { createDefaultWorkspaceTemplateRegistry } from "../src/features/agent-core/workspaceTemplates";
import type {
  AgentState,
  ControlledDownloadResult,
  WorkspaceExportResult
} from "../src/features/agent-core/types";
import type { ControlledDownloadOptions } from "./downloadClient";
import type { DownloadTaskProgress } from "./downloadTasks";
import type { RemoteModelClient } from "./modelClient";
import type {
  GitHubRepositoryAnalysisInspection,
  GitHubRepositoryAnalysisInspectionResult,
  GitHubRepositoryInspectionResult
} from "./githubClient";
import {
  toModelConnectionError as toMainModelConnectionError
} from "./modelClient";
import type { TaskStore } from "./taskStore";
import {
  getTrustedCatalogStatus,
  getTrustedResourceMetadata,
  trustedCatalogMetadata,
  type TrustedDownloadMetadata
} from "./trustedDownloadCatalog";
import {
  exportWorkspace,
  toWorkspaceExportError
} from "./workspaceExporter";
import { readHostSystemProfile } from "./systemProfile";
import { inspectLocalDevelopmentEnvironment } from "./localDevelopmentEnvironment";
import { LocalXunleiAdapter } from "./xunleiAdapter";
import type { LocalArtifactRecord } from "./localArtifacts";
import type { LocalRepositoryInspection } from "./localRepository";
import { createLocalRepositoryAgentTools } from "./localRepositoryAgentTools";
import { createGitHubRepositoryAgentTools } from "./githubRepositoryAgentTools";
import {
  GitHubPublisher,
  githubPublishPlanSha256
} from "./githubPublisher";
import { SingleFlightGate } from "./singleFlightGate";
import { ElectronArtifactVerifier } from "./artifactVerifier";
import { writeCurrentManifestSnapshot } from "./manifestSnapshots";
import { WorkspaceInspectorAgent } from "./agentB";

export type AgentRuntimeHostOptions = {
  store: TaskStore;
  modelClient: RemoteModelClient;
  githubRepositorySearch: GitHubRepositorySearchRunner;
  inspectGitHubRepository: (
    fullName: string
  ) => Promise<GitHubRepositoryInspectionResult>;
  inspectGitHubRepositoryForAnalysis: (
    fullName: string
  ) => Promise<GitHubRepositoryAnalysisInspectionResult>;
  githubPublisher?: GitHubPublisher;
  workspaceRoot: string;
  performDownload: (
    resourceId: string,
    metadata: TrustedDownloadMetadata,
    options: ControlledDownloadOptions
  ) => Promise<ControlledDownloadResult> | ControlledDownloadResult;
  onSnapshot?: (snapshot: AgentRuntimeSnapshot) => void;
  stepDelayMs?: number;
  createTaskId?: () => string;
  cleanupManagedDemoFiles?: () => Promise<void>;
};

function controlledDownloadError(
  code: string,
  message: string,
  retriable: boolean
): ControlledDownloadResult {
  return { ok: false, error: { code, message, retriable } };
}

function workspaceExportError(
  code: string,
  message: string,
  retriable: boolean
): WorkspaceExportResult {
  return { ok: false, error: { code, message, retriable } };
}

/**
 * Electron Main 中唯一的 Agent Orchestrator 宿主。
 *
 * Renderer 只能读取快照、订阅快照和派发经过 Zod 校验的用户事件；
 * 模型、状态机、Policy、Tool、SQLite、下载与工作区导出都在主进程内闭环。
 */
export class AgentRuntimeHost {
  private runtime!: AgentRuntime;
  private persistence: RuntimePersistenceState = {
    status: "loading",
    restoredAt: null,
    lastSavedAt: null,
    lastResetAt: null,
    lastResetRemovedRecords: 0,
    error: null
  };
  private persistenceQueue: Promise<unknown> = Promise.resolve();
  private readonly modelConnection: ModelConnectionController;
  private readonly workspaceTemplates =
    createDefaultWorkspaceTemplateRegistry();
  private readonly domainSkills = createDefaultDomainSkillRegistry();
  private readonly sourceProviders =
    createDefaultSourceProviderRegistry();
  private readonly downloadAdapter: LocalXunleiAdapter;
  private readonly agentB: WorkspaceInspectorAgent;
  private readonly localRepositorySessions = new Map<
    string,
    LocalRepositoryInspection
  >();
  private readonly githubRepositorySessions = new Map<
    string,
    GitHubRepositoryAnalysisInspection
  >();
  private readonly githubPublisher: GitHubPublisher;
  private readonly githubPublishApprovalGate = new SingleFlightGate();
  private suppressNextManifestGeneration = false;
  private disposed = false;

  private constructor(private readonly options: AgentRuntimeHostOptions) {
    this.githubPublisher = options.githubPublisher ?? new GitHubPublisher();
    this.downloadAdapter = new LocalXunleiAdapter({
      store: options.store,
      performDownload: async (resourceId, metadata, downloadOptions) =>
        options.performDownload(resourceId, metadata, downloadOptions),
      onProgress: (progress) => this.handleDownloadProgress(progress)
    });
    this.agentB = new WorkspaceInspectorAgent({
      store: options.store,
      allowTestFixtures:
        process.env.NODE_ENV === "test" &&
        process.env.XL_AGENT_E2E_DOWNLOAD_FIXTURE === "1"
    });
    this.modelConnection = new ModelConnectionController({
      getConnectionInfo: async () => options.modelClient.getSafeConnectionInfo(),
      testConnection: async () => {
        try {
          parseRemoteDecision(await options.modelClient.testConnection());
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: toMainModelConnectionError(error)
          };
        }
      }
    });
  }

  static async create(options: AgentRuntimeHostOptions) {
    const host = new AgentRuntimeHost(options);
    await host.initialize();
    return host;
  }

  private async initialize() {
    await this.modelConnection.initialize();
    const lastMaintenanceEvent =
      await this.options.store.getLatestMaintenanceEvent();
    if (lastMaintenanceEvent?.eventType === "demo-reset") {
      const detail =
        typeof lastMaintenanceEvent.detail === "object" &&
        lastMaintenanceEvent.detail !== null
          ? lastMaintenanceEvent.detail as Record<string, unknown>
          : {};
      this.persistence.lastResetAt = lastMaintenanceEvent.createdAt;
      this.persistence.lastResetRemovedRecords =
        typeof detail.removedRecords === "number"
          ? detail.removedRecords
          : 0;
    }

    const localModel = new LocalRuleModelRuntime();
    const remoteModel = new RemoteLlmModelRuntime({
      requestDecision: (context) => this.options.modelClient.requestDecision(context),
      requestTurn: (context, signal) =>
        this.options.modelClient.requestTurn(context, signal)
    });
    const fallbackModel = new FallbackModelRuntime(remoteModel, localModel, {
      shouldAttemptPrimary: () => this.modelConnection.shouldAttemptRemote(),
      onPrimarySuccess: (decision) => this.modelConnection.recordRemoteSuccess(decision),
      onPrimaryFailure: (error) => {
        const detail = toMainModelConnectionError(error);
        this.modelConnection.recordFallback(new ModelConnectionRequestError(detail));
      }
    });

    const localRepositoryTools = createLocalRepositoryAgentTools(
      (repositoryHandleId) =>
        this.localRepositorySessions.get(repositoryHandleId) ?? null
    );
    const githubRepositoryTools = createGitHubRepositoryAgentTools(
      (repositoryHandleId) =>
        this.githubRepositorySessions.get(repositoryHandleId) ?? null
    );

    const tools = new InMemoryAgentToolExecutor(
      () => createSystemProfileToolOutput(readHostSystemProfile()),
      (request) => this.runControlledDownload(request),
      (request) => this.runWorkspaceExport(request),
      this.sourceProviders.get("trusted-catalog") ?? undefined,
      this.options.githubRepositorySearch,
      (executionOptions) => inspectLocalDevelopmentEnvironment({
        signal: executionOptions?.signal
      }),
      localRepositoryTools,
      githubRepositoryTools
    );

    this.runtime = new AgentRuntime({
      router: new ExtensibleAgentRouter(
        this.domainSkills,
        this.sourceProviders
      ),
      planner: new FixedWindowsPlanner(),
      verifier: new ElectronArtifactVerifier(
        this.options.store,
        process.env.NODE_ENV === "test" &&
          process.env.XL_AGENT_E2E_DOWNLOAD_FIXTURE === "1"
      ),
      scheduler: createTimeoutScheduler(),
      model: fallbackModel,
      tools,
      policy: new DefaultAgentPolicy(),
      downloadTool: "controlled_download",
      stepDelayMs: this.options.stepDelayMs,
      createTaskId: this.options.createTaskId
    });

    const restored = await this.options.store.loadLatestUnfinished();
    if (restored) {
      const restoredState = normalizeRestorableAgentState(restored.state);
      if (restoredState) {
        this.runtime.dispatch({
          type: "TASK_STATE_RESTORED",
          state: restoredState,
          approvalValid: restored.approval.valid
        });
        this.persistence.restoredAt = restored.savedAt;
      } else {
        this.persistence = {
          ...this.persistence,
          status: "error",
          error: "SQLite 中最新的未完成任务与当前 AgentState 协议不兼容。"
        };
      }
    }
    if (this.persistence.status === "loading") this.persistence.status = "ready";

    this.runtime.subscribe((state) => this.handleRuntimeState(state));
    this.modelConnection.subscribe(() => this.emitSnapshot());
    this.runtime.start();
    this.emitSnapshot();
  }

  getSnapshot(): AgentRuntimeSnapshot {
    return {
      state: this.runtime.getState(),
      modelConnection: this.modelConnection.getState(),
      persistence: { ...this.persistence },
      capabilities: this.getPlatformCapabilities()
    };
  }

  private getPlatformCapabilities(): PlatformCapabilitySummary {
    return {
      domainSkills: this.domainSkills.list().map((skill) => ({
        id: skill.id,
        displayName: skill.displayName
      })),
      sourceProviders: [
        ...this.sourceProviders.list().map((provider) => ({
          id: provider.id
        })),
        { id: "github-api" }
      ],
      workspaceTemplates: this.workspaceTemplates.list().map((template) => ({
        id: template.id
      })),
      githubPublish: {
        configured: Boolean(
          process.env.XL_AGENT_GITHUB_PUBLISH_TOKEN?.trim()
        ),
        credentialBoundary: "separate-write-token",
        existingRepositoryPolicy: "create-only"
      }
    };
  }

  async dispatch(value: unknown): Promise<AgentRuntimeSnapshot> {
    const event = parseAgentUserEvent(value);
    const state = this.runtime.getState();
    if (
      state.githubPublish.status === "publishing" ||
      this.githubPublishApprovalGate.isLocked()
    ) {
      throw new Error(
        "GitHub 发布正在执行；完成或失败前不能派发其他任务事件。"
      );
    }
    if (event.type === "PAUSE_DOWNLOAD") {
      if (
        await this.downloadAdapter.pause(
          state.taskId,
          state.revision,
          event.resourceId
        )
      ) {
        this.runtime.reportExternalEvent({
          type: "DOWNLOAD_PAUSED",
          resourceId: event.resourceId
        });
      }
      return this.getSnapshot();
    }
    if (event.type === "RESUME_DOWNLOAD") {
      if (
        await this.downloadAdapter.resume(
          state.taskId,
          state.revision,
          event.resourceId
        )
      ) {
        this.runtime.reportExternalEvent({
          type: "DOWNLOAD_RESUMED",
          resourceId: event.resourceId
        });
      }
      return this.getSnapshot();
    }
    if (event.type === "CANCEL_TASK") {
      await this.downloadAdapter.cancelTask(state.taskId);
    }
    if (event.type === "PREPARE_GITHUB_REPOSITORY") {
      const searchResult = latestGitHubRepositorySearchResult(state);
      const output =
        searchResult?.status === "success" &&
        isGitHubRepositorySearchOutput(searchResult.output)
          ? searchResult.output
          : null;
      const selected = output?.repositories.find(
        (repository) =>
          repository.fullName.toLowerCase() === event.fullName.toLowerCase()
      );
      if (
        state.phase !== "result" ||
        state.routeDecision?.skillId !== "github-project-discovery" ||
        !selected
      ) {
        throw new Error("只能准备当前 GitHub 查询结果中明确选择的仓库。");
      }
      const sourceTaskId = state.taskId;
      const inspection = await this.options.inspectGitHubRepository(
        selected.fullName
      );
      if (inspection.ok === false) {
        throw new Error(
          `${inspection.error.code}: ${inspection.error.message}`
        );
      }
      const currentState = this.runtime.getState();
      const currentResult = latestGitHubRepositorySearchResult(currentState);
      const currentOutput =
        currentResult?.status === "success" &&
        isGitHubRepositorySearchOutput(currentResult.output)
          ? currentResult.output
          : null;
      const stillSelected = currentOutput?.repositories.some(
        (repository) =>
          repository.fullName.toLowerCase() === selected.fullName.toLowerCase()
      );
      if (
        currentState.taskId !== sourceTaskId ||
        currentState.phase !== "result" ||
        currentState.routeDecision?.skillId !== "github-project-discovery" ||
        !stillSelected
      ) {
        throw new Error("固定 GitHub commit 期间任务上下文已变化，请重新选择仓库。");
      }
      this.runtime.reportExternalEvent({
        type: "GITHUB_ACQUISITION_PREPARED",
        resources: [
          inspection.resource,
          ...inspection.dependencyResources
        ],
        explanation:
          `已将 ${inspection.resource.github?.fullName ?? selected.fullName}` +
          ` 固定到 commit ${inspection.resource.github?.commitSha.slice(0, 12)}。` +
          (inspection.dependencyResources.length
            ? ` 同时识别出 ${inspection.dependencyResources.length} 个可选 npm 离线包，默认不下载。`
            : "")
      });
      return this.getSnapshot();
    }
    if (event.type === "ANALYZE_GITHUB_REPOSITORY") {
      const searchResult = latestGitHubRepositorySearchResult(state);
      const output =
        searchResult?.status === "success" &&
        isGitHubRepositorySearchOutput(searchResult.output)
          ? searchResult.output
          : null;
      const selected = output?.repositories.find(
        (repository) =>
          repository.fullName.toLowerCase() === event.fullName.toLowerCase()
      );
      if (
        state.phase !== "result" ||
        state.routeDecision?.skillId !== "github-project-discovery" ||
        !selected
      ) {
        throw new Error("只能分析当前 GitHub 查询结果中明确选择的仓库。");
      }
      const sourceTaskId = state.taskId;
      const inspectionResult =
        await this.options.inspectGitHubRepositoryForAnalysis(selected.fullName);
      if (!inspectionResult.ok) {
        throw new Error(
          `${inspectionResult.error.code}: ${inspectionResult.error.message}`
        );
      }
      const currentState = this.runtime.getState();
      const currentResult = latestGitHubRepositorySearchResult(currentState);
      const currentOutput =
        currentResult?.status === "success" &&
        isGitHubRepositorySearchOutput(currentResult.output)
          ? currentResult.output
          : null;
      const stillSelected = currentOutput?.repositories.some(
        (repository) =>
          repository.fullName.toLowerCase() === selected.fullName.toLowerCase()
      );
      if (
        currentState.taskId !== sourceTaskId ||
        currentState.phase !== "result" ||
        currentState.routeDecision?.skillId !== "github-project-discovery" ||
        !stillSelected
      ) {
        throw new Error("固定 GitHub commit 期间任务上下文已变化，请重新选择仓库。");
      }
      this.githubRepositorySessions.clear();
      this.localRepositorySessions.clear();
      this.githubRepositorySessions.set(
        inspectionResult.inspection.summary.repositoryHandleId,
        inspectionResult.inspection
      );
      this.runtime.reportExternalEvent({
        type: "GITHUB_REPOSITORY_ANALYSIS_ATTACHED",
        taskId:
          this.options.createTaskId?.() ??
          `github-analysis-task-${Date.now()}-${inspectionResult.inspection.summary.commitSha.slice(0, 8)}`,
        repository: inspectionResult.inspection.summary
      });
      return this.getSnapshot();
    }
    this.runtime.dispatch(event);
    if (
      event.type === "RESET" &&
      this.runtime.getState().taskId === "unassigned"
    ) {
      this.localRepositorySessions.clear();
      this.githubRepositorySessions.clear();
    }
    if (
      event.type === "RUN_AGENT_B" &&
      !this.canRunAgentB(this.runtime.getState())
    ) {
      throw new Error("当前任务尚无可供 Agent B 检查的 Manifest。");
    }
    if (
      (event.type === "RUN_AGENT_B" ||
        (event.type === "RESOLVE_DOWNLOAD_FAILURE" &&
          event.action === "delegate-agent-b")) &&
      this.canRunAgentB(this.runtime.getState())
    ) {
      await this.runAgentBInspection();
    }
    return this.getSnapshot();
  }

  retryTaskLocally(): AgentRuntimeSnapshot {
    if (
      this.runtime.getState().githubPublish.status === "publishing" ||
      this.githubPublishApprovalGate.isLocked()
    ) {
      throw new Error("GitHub 发布正在执行，不能重置模型任务。");
    }
    const currentState = this.runtime.getState();
    const task = currentState.task.trim();
    const attachedRepository = currentState.localRepository &&
        this.localRepositorySessions.has(
          currentState.localRepository.repositoryHandleId
        )
      ? currentState.localRepository
      : null;
    const attachedGitHubRepository = currentState.githubRepository &&
        this.githubRepositorySessions.has(
          currentState.githubRepository.repositoryHandleId
        )
      ? currentState.githubRepository
      : null;
    this.modelConnection.useLocalModel(
      "远程规划未在安全步数内生成计划，本次重试已切换本地规则模型。"
    );
    this.runtime.dispatch({ type: "RESET" });
    if (attachedRepository) {
      this.runtime.reportExternalEvent({
        type: "LOCAL_REPOSITORY_IMPORTED",
        taskId: `local-repo-retry-${Date.now()}`,
        repository: attachedRepository
      });
    }
    if (attachedGitHubRepository) {
      this.runtime.reportExternalEvent({
        type: "GITHUB_REPOSITORY_ANALYSIS_ATTACHED",
        taskId: `github-repo-retry-${Date.now()}`,
        repository: attachedGitHubRepository
      });
    }
    if (task) this.runtime.dispatch({ type: "SUBMIT_TASK", task });
    return this.getSnapshot();
  }

  async testModelConnection() {
    await this.modelConnection.testConnection();
    return this.getSnapshot();
  }

  async resetDemoData() {
    const state = this.runtime.getState();
    if (
      state.phase === "downloading" ||
      state.phase === "verifying" ||
      state.phase === "exporting" ||
      state.agentB.status === "running" ||
      state.githubPublish.status === "publishing" ||
      this.githubPublishApprovalGate.isLocked()
    ) {
      throw new Error(
        "当前存在运行中的下载、验证、导出、Agent B 检查或 GitHub 发布，不能重置 Demo 数据。"
      );
    }
    this.runtime.stop();
    let result;
    try {
      await this.waitForPersistence();
      result = await this.options.store.resetDemoData();
      this.runtime.dispatch({ type: "RESET" });
    } catch (error) {
      this.runtime.start();
      throw error;
    }
    let cleanupWarning: string | null = null;
    try {
      await this.options.cleanupManagedDemoFiles?.();
    } catch (error) {
      cleanupWarning =
        error instanceof Error
          ? error.message
          : "受控 Demo 文件清理失败。";
    }
    this.persistence = {
      ...this.persistence,
      status: cleanupWarning ? "error" : "ready",
      restoredAt: null,
      lastSavedAt: null,
      lastResetAt: result.resetAt,
      lastResetRemovedRecords: result.removedRecords,
      error: cleanupWarning
    };
    this.emitSnapshot();
    this.runtime.start();
    return {
      snapshot: this.getSnapshot(),
      reset: {
        resetAt: result.resetAt,
        removedRecords: result.removedRecords,
        cleanupWarning
      }
    };
  }

  async addLocalArtifacts(records: LocalArtifactRecord[]) {
    if (!records.length) return this.getSnapshot();
    const state = this.runtime.getState();
    if (
      state.taskId === "unassigned" ||
      state.githubPublish.status === "publishing" ||
      this.githubPublishApprovalGate.isLocked() ||
      records.some(
        (record) =>
          record.taskId !== state.taskId ||
          record.planRevision <= 0
      )
    ) {
      throw new Error("本地资源必须绑定当前有效任务和计划 revision。");
    }
    await this.options.store.recordLocalArtifacts(records);
    for (const record of records) {
      if (!record.matchedResourceId) continue;
      const trustedResource = getTrustedResourceMetadata(
        record.matchedResourceId
      );
      if (!trustedResource) {
        throw new Error("本地资源匹配项已不在当前 active 可信目录中。");
      }
      await this.options.store.recordDownloadArtifact({
        taskId: state.taskId,
        revision: record.planRevision,
        resourceId: record.matchedResourceId,
        fileName: record.fileName,
        sourceHost: "local-user",
        tempFilePath: record.sourcePath,
        bytesWritten: record.bytesWritten,
        sha256: record.sha256,
        expectedSha256: record.sha256,
        verificationStatus: "local-verified",
        verifiedAt: record.importedAt,
        signatureStatus:
          trustedResource.verification.signatureEnforcement === "required"
            ? "pending"
            : "not-applicable",
        expectedPublisher:
          trustedResource.verification.expectedPublisher ?? null,
        actualPublisher: null,
        certificateThumbprint: null,
        signatureMessage: null,
        signatureCheckedAt: null
      });
    }
    this.runtime.reportExternalEvent({
      type: "LOCAL_ARTIFACTS_ADDED",
      artifacts: records.map(
        ({ taskId: _taskId, planRevision: _planRevision, sourcePath: _sourcePath, ...summary }) =>
          summary
      )
    });
    return this.getSnapshot();
  }

  importLocalRepository(inspection: LocalRepositoryInspection) {
    const state = this.runtime.getState();
    if (
      state.phase === "downloading" ||
      state.phase === "verifying" ||
      state.phase === "exporting" ||
      state.agentB.status === "running" ||
      state.githubPublish.status === "publishing" ||
      this.githubPublishApprovalGate.isLocked()
    ) {
      throw new Error("当前存在运行中的写入或检查任务，不能导入本地仓库。");
    }
    this.localRepositorySessions.clear();
    this.githubRepositorySessions.clear();
    this.localRepositorySessions.set(
      inspection.summary.repositoryHandleId,
      inspection
    );
    this.runtime.reportExternalEvent({
      type: "LOCAL_REPOSITORY_IMPORTED",
      taskId:
        this.options.createTaskId?.() ??
        `local-repo-task-${Date.now()}-${inspection.summary.fingerprint.slice(0, 8)}`,
      repository: inspection.summary
    });
    return this.getSnapshot();
  }

  async prepareGitHubPublish(input: unknown) {
    const state = this.runtime.getState();
    const repository = state.localRepository;
    const inspection = repository
      ? this.localRepositorySessions.get(repository.repositoryHandleId)
      : null;
    if (
      state.phase !== "handoff" ||
      state.route !== "local-repository-import" ||
      !repository ||
      !inspection ||
      this.githubPublishApprovalGate.isLocked() ||
      state.githubPublish.status === "publishing" ||
      state.githubPublish.status === "published"
    ) {
      return {
        ok: false as const,
        error: {
          code: "GITHUB_PUBLISH_LOCAL_SESSION_REQUIRED",
          message:
            "请在当前应用会话中重新导入本地仓库，再创建 GitHub 发布计划。",
          retriable: false
        }
      };
    }
    const prepared = await this.githubPublisher.prepare(inspection, input);
    if (!prepared.ok) return prepared;
    const currentState = this.runtime.getState();
    if (
      currentState.taskId !== state.taskId ||
      currentState.phase !== "handoff" ||
      currentState.localRepository?.repositoryHandleId !==
        repository.repositoryHandleId ||
      this.githubPublishApprovalGate.isLocked()
    ) {
      return {
        ok: false as const,
        error: {
          code: "GITHUB_PUBLISH_CONTEXT_CHANGED",
          message:
            "检查 GitHub 目标期间当前任务或本地仓库发生变化，请重新生成发布计划。",
          retriable: false
        }
      };
    }
    this.runtime.reportExternalEvent({
      type: "GITHUB_PUBLISH_PLAN_PREPARED",
      plan: prepared.plan
    });
    await this.options.store.recordOperationEvent({
      taskId: state.taskId,
      revision: state.revision,
      resourceId: null,
      eventType: "github-publish-plan-created",
      outcome: "success",
      detail: {
        publishId: prepared.plan.publishId,
        planSha256: prepared.plan.planSha256,
        target: `${prepared.plan.targetOwner}/${prepared.plan.targetRepository}`,
        visibility: prepared.plan.targetVisibility,
        fileCount: prepared.plan.fileCount,
        totalBytes: prepared.plan.totalBytes,
        force: false
      },
      createdAt: prepared.plan.createdAt
    });
    return {
      ok: true as const,
      snapshot: this.getSnapshot()
    };
  }

  async approveGitHubPublish(input: unknown) {
    const request =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : null;
    const publishId =
      request && typeof request.publishId === "string"
        ? request.publishId
        : "";
    const planSha256 =
      request && typeof request.planSha256 === "string"
        ? request.planSha256
        : "";
    const state = this.runtime.getState();
    const plan = state.githubPublish.plan;
    const inspection = state.localRepository
      ? this.localRepositorySessions.get(
          state.localRepository.repositoryHandleId
        )
      : null;
    if (
      state.githubPublish.status !== "waiting_approval" ||
      !plan ||
      !inspection ||
      publishId !== plan.publishId ||
      planSha256 !== plan.planSha256 ||
      githubPublishPlanSha256(plan) !== plan.planSha256
    ) {
      return {
        ok: false as const,
        error: {
          code: "GITHUB_PUBLISH_APPROVAL_INVALID",
          message:
            "发布审批与当前固定计划不一致，或本地仓库会话已经失效。",
          retriable: false
        }
      };
    }
    const releaseApproval = this.githubPublishApprovalGate.tryAcquire();
    if (!releaseApproval) {
      return {
        ok: false as const,
        error: {
          code: "GITHUB_PUBLISH_APPROVAL_INVALID",
          message: "同一 GitHub 发布计划已经在审批或执行中。",
          retriable: false
        }
      };
    }
    try {
      const approvedAt = new Date().toISOString();
      await this.options.store.recordOperationEvent({
        taskId: state.taskId,
        revision: state.revision,
        resourceId: null,
        eventType: "github-publish-approval-pinned",
        outcome: "success",
        detail: {
          publishId: plan.publishId,
          planSha256: plan.planSha256,
          target: `${plan.targetOwner}/${plan.targetRepository}`,
          sourceFingerprint: plan.sourceFingerprint
        },
        createdAt: approvedAt
      });
      this.runtime.reportExternalEvent({
        type: "GITHUB_PUBLISH_STARTED",
        publishId: plan.publishId,
        approvedAt
      });
      const executed = await this.githubPublisher.execute(plan, inspection);
      if (executed.ok) {
        this.runtime.reportExternalEvent({
          type: "GITHUB_PUBLISH_COMPLETED",
          result: executed.output
        });
        await this.options.store.recordOperationEvent({
          taskId: state.taskId,
          revision: state.revision,
          resourceId: null,
          eventType: "github-publish-completed",
          outcome: "success",
          detail: executed.output,
          createdAt: executed.output.publishedAt
        });
      } else {
        this.runtime.reportExternalEvent({
          type: "GITHUB_PUBLISH_FAILED",
          publishId: plan.publishId,
          partialRepositoryUrl:
            executed.error.partialRepositoryUrl,
          reason: `${executed.error.code}: ${executed.error.message}`
        });
        await this.options.store.recordOperationEvent({
          taskId: state.taskId,
          revision: state.revision,
          resourceId: null,
          eventType: "github-publish-failed",
          outcome: "error",
          detail: {
            publishId: plan.publishId,
            planSha256: plan.planSha256,
            code: executed.error.code,
            message: executed.error.message,
            partialRepositoryUrl:
              executed.error.partialRepositoryUrl ?? null
          },
          createdAt: new Date().toISOString()
        });
      }
      return {
        ok: true as const,
        snapshot: this.getSnapshot()
      };
    } finally {
      releaseApproval();
    }
  }

  selectWorkspaceRoot(rootPath: string) {
    if (this.runtime.getState().phase !== "waiting_approval") {
      throw new Error("只能在当前计划等待审批时修改工作区目录。");
    }
    this.runtime.reportExternalEvent({
      type: "WORKSPACE_ROOT_SELECTED",
      rootPath
    });
    return this.getSnapshot();
  }

  async flushPersistence() {
    await this.waitForPersistence().catch(() => undefined);
    await this.options.store.flush();
  }

  stop() {
    this.disposed = true;
    this.runtime.stop();
  }

  private handleRuntimeState(state: AgentState) {
    this.emitSnapshot();
    if (state.phase === "intake" || state.taskId === "unassigned" || !state.task) return;
    const shouldGenerateManifest =
      !this.suppressNextManifestGeneration &&
      ![
        "local-development-environment-inspection",
        "local-environment-compatibility-assessment"
      ].includes(state.routeDecision?.skillId ?? "") &&
      (state.routeDecision?.skillId !== "github-project-discovery" ||
        state.phase === "handoff");
    this.suppressNextManifestGeneration = false;

    const operation = this.persistenceQueue
      .catch(() => undefined)
      .then(() => this.options.store.saveSnapshot(state))
      .then(async ({ savedAt }) => {
        if (!shouldGenerateManifest) return { savedAt, manifest: null };
        const manifest = await this.options.store.createManifestSnapshotRecord(
          state
        );
        const [downloadArtifacts, localArtifacts] = await Promise.all([
          this.options.store.listDownloadArtifacts(
            state.taskId,
            state.revision
          ),
          this.options.store.listLocalArtifacts(
            state.taskId
          )
        ]);
        const rootPath = await writeCurrentManifestSnapshot({
          workspaceRoot:
            state.workspace.targetRootPath ?? this.options.workspaceRoot,
          record: manifest,
          downloadArtifacts,
          localArtifacts,
          allowTestFixtures:
            process.env.NODE_ENV === "test" &&
            process.env.XL_AGENT_E2E_DOWNLOAD_FIXTURE === "1"
        });
        await this.options.store.setManifestSnapshotRoot(
          state.taskId,
          manifest.manifestRevision,
          rootPath
        );
        return {
          savedAt,
          manifest: { ...manifest, rootPath }
        };
      })
      .then(
        ({ savedAt, manifest }) => {
          this.persistence = {
            ...this.persistence,
            status: "ready",
            lastSavedAt: savedAt,
            error: null
          };
          this.emitSnapshot();
          if (manifest) {
            this.suppressNextManifestGeneration = true;
            this.runtime.reportExternalEvent({
              type: "MANIFEST_SNAPSHOT_WRITTEN",
              manifestRevision: manifest.manifestRevision,
              rootPath: manifest.rootPath,
              status: manifest.status
            });
          }
          return savedAt;
        },
        (error) => {
          this.persistence = {
            ...this.persistence,
            status: "error",
            error: error instanceof Error ? error.message : "SQLite 写入失败。"
          };
          this.emitSnapshot();
          throw error;
        }
      );
    this.persistenceQueue = operation;
  }

  private emitSnapshot() {
    if (!this.disposed) this.options.onSnapshot?.(this.getSnapshot());
  }

  private async waitForPersistence() {
    while (true) {
      const pending = this.persistenceQueue;
      await pending;
      if (pending === this.persistenceQueue) return;
    }
  }

  private async runAgentBInspection() {
    await this.waitForPersistence();
    const state = this.runtime.getState();
    if (!this.canRunAgentB(state)) {
      throw new Error("当前任务尚无可供 Agent B 检查的 Manifest。");
    }
    const grant = this.agentB.issueGrant(state.taskId, state.revision);
    const runId = this.agentB.createRunId();
    this.runtime.reportExternalEvent({
      type: "AGENT_B_STARTED",
      runId,
      grantId: grant.grantId
    });
    await this.waitForPersistence();
    try {
      const result = await this.agentB.run(grant, runId);
      this.runtime.reportExternalEvent({
        type: "AGENT_B_COMPLETED",
        runId,
        answer: result.answer
      });
    } catch (error) {
      this.runtime.reportExternalEvent({
        type: "AGENT_B_FAILED",
        runId,
        reason:
          error instanceof Error ? error.message : "Agent B 检查失败。"
      });
    }
  }

  private canRunAgentB(state: AgentState) {
    return (
      state.taskId !== "unassigned" &&
      state.revision > 0 &&
      state.workspace.manifestRevision > 0 &&
      state.agentB.status !== "running"
    );
  }

  private async runControlledDownload(request: {
    resourceId: string;
    taskId: string;
    revision: number;
  }): Promise<ControlledDownloadResult> {
    await this.waitForPersistence();
    const state = this.runtime.getState();
    const plannedResource = state.resources.find(
      (resource) => resource.id === request.resourceId
    );
    const dynamicResource =
      (plannedResource?.sourceTrust === "github-api" &&
        plannedResource.github &&
        plannedResource.download.digestPolicy === "record-after-download") ||
      (plannedResource?.sourceTrust === "npm-lockfile" &&
        plannedResource.npm &&
        plannedResource.download.digestPolicy === "lockfile-integrity")
        ? plannedResource
        : null;
    const catalogStatus = getTrustedCatalogStatus();
    if (!dynamicResource && catalogStatus !== "active") {
      return controlledDownloadError(
        catalogStatus === "expired"
          ? "TRUSTED_CATALOG_EXPIRED"
          : "TRUSTED_CATALOG_INVALID",
        catalogStatus === "expired"
          ? "Electron 主进程拒绝使用已过期的可信资源目录。"
          : "Electron 主进程检测到可信资源目录无效。",
        false
      );
    }

    const trustedResource = dynamicResource
      ? null
      : getTrustedResourceMetadata(request.resourceId);
    if (!dynamicResource && !trustedResource) {
      return controlledDownloadError(
        "RESOURCE_NOT_TRUSTED",
        "请求的资源不在 Electron 主进程可信下载目录或已检查的 GitHub 计划中。",
        false
      );
    }
    const metadata = dynamicResource?.download ?? trustedResource!.download;

    const approval = await this.options.store.hasValidApproval(
      request.taskId,
      request.revision
    );
    if (!approval.valid) {
      if (approval.status === "catalog-mismatch") {
        await this.options.store.recordOperationEvent({
          taskId: request.taskId,
          revision: request.revision,
          resourceId: request.resourceId,
          eventType: "catalog-pin-rejected",
          outcome: "denied",
          detail: {
            approvedCatalogVersion: approval.catalogVersion,
            activeCatalogVersion: trustedCatalogMetadata.catalogVersion
          },
          createdAt: new Date().toISOString()
        });
        return controlledDownloadError(
          "CATALOG_APPROVAL_MISMATCH",
          "当前审批绑定的可信目录版本与执行目录不一致，请重新生成并确认资源计划。",
          false
        );
      }
      if (approval.status === "plan-mismatch") {
        await this.options.store.recordOperationEvent({
          taskId: request.taskId,
          revision: request.revision,
          resourceId: request.resourceId,
          eventType: "plan-pin-rejected",
          outcome: "denied",
          detail: {
            reason: "approved-plan-fingerprint-mismatch"
          },
          createdAt: new Date().toISOString()
        });
        return controlledDownloadError(
          "PLAN_APPROVAL_MISMATCH",
          "当前资源计划与用户审批时的计划指纹不一致，请重新生成并确认 revision。",
          false
        );
      }
      return controlledDownloadError(
        approval.status === "expired"
          ? "APPROVAL_EXPIRED"
          : "APPROVAL_NOT_FOUND",
        approval.status === "expired"
          ? "当前下载审批已过期，请重新确认资源计划。"
          : "Electron 主进程未找到当前 revision 的有效用户审批。",
        false
      );
    }
    const result = await this.downloadAdapter.createDownloadTask({
      ...request,
      metadata
    });
    if (result.ok) {
      const testFixture =
        process.env.NODE_ENV === "test" &&
        process.env.XL_AGENT_E2E_DOWNLOAD_FIXTURE === "1";
      await this.options.store.recordDownloadArtifact({
        taskId: request.taskId,
        revision: request.revision,
        resourceId: request.resourceId,
        fileName: result.output.fileName,
        sourceHost: result.output.urlHost,
        tempFilePath: result.output.tempFilePath,
        bytesWritten: result.output.bytesWritten,
        sha256: result.output.sha256,
        expectedSha256: metadata.expectedSha256 ?? result.output.sha256,
        verificationStatus: testFixture ? "test-fixture" : "downloaded",
        verifiedAt: new Date().toISOString(),
        signatureStatus:
          trustedResource?.verification.signatureEnforcement === "required"
            ? "pending"
            : "not-applicable",
        expectedPublisher:
          trustedResource?.verification.expectedPublisher ?? null,
        actualPublisher: null,
        certificateThumbprint: null,
        signatureMessage: null,
        signatureCheckedAt: null
      });
    }
    return result;
  }

  private handleDownloadProgress(progress: DownloadTaskProgress) {
    const state = this.runtime?.getState();
    if (
      !state ||
      state.taskId !== progress.taskId ||
      state.revision !== progress.revision ||
      state.activeResourceId !== progress.resourceId
    ) {
      return;
    }
    this.runtime.reportExternalEvent({
      type: "DOWNLOAD_PROGRESS",
      resourceId: progress.resourceId,
      progress: Math.min(99, progress.progress),
      bytesWritten: progress.bytesWritten,
      totalBytes: progress.totalBytes ?? undefined,
      speedBytesPerSecond: progress.speedBytesPerSecond,
      etaSeconds: progress.etaSeconds ?? undefined
    });
  }

  private async runWorkspaceExport(request: {
    taskId: string;
    revision: number;
  }): Promise<WorkspaceExportResult> {
    try {
      await this.waitForPersistence();
      const approval = await this.options.store.hasValidApproval(
        request.taskId,
        request.revision
      );
      if (!approval.valid) {
        return workspaceExportError(
          approval.status === "expired"
            ? "APPROVAL_EXPIRED"
            : approval.status === "catalog-mismatch"
              ? "CATALOG_APPROVAL_MISMATCH"
              : approval.status === "plan-mismatch"
                ? "PLAN_APPROVAL_MISMATCH"
                : "APPROVAL_NOT_FOUND",
          approval.status === "expired"
            ? "当前工作区导出审批已过期，请重新确认资源计划。"
            : approval.status === "catalog-mismatch"
              ? "当前目录版本与审批时不一致，请重新确认资源计划。"
              : approval.status === "plan-mismatch"
                ? "当前计划指纹与审批时不一致，请重新确认资源计划。"
                : "Electron 主进程未找到当前 revision 的有效工作区导出审批。",
          false
        );
      }
      const state = await this.options.store.getTaskState(request.taskId);
      if (!state || state.revision !== request.revision) {
        return workspaceExportError(
          "WORKSPACE_EXPORT_INVALID_STATE",
          "SQLite 中没有与导出请求匹配的任务快照。",
          false
        );
      }
      const runtimeState = normalizeRestorableAgentState(state);
      if (!runtimeState) {
        return workspaceExportError(
          "WORKSPACE_EXPORT_INVALID_STATE",
          "SQLite 中的任务快照未通过当前 AgentState 协议校验。",
          false
        );
      }
      const downloadArtifacts =
        await this.options.store.listDownloadArtifacts(
          request.taskId,
          request.revision
        );
      const localArtifacts = await this.options.store.listLocalArtifacts(
        request.taskId
      );
      const skill = runtimeState.route
        ? this.domainSkills.get(runtimeState.route)
        : null;
      const workspaceGuide =
        skill && runtimeState.taskRequirements
          ? skill.generateGuide({
              goal: {
                text: runtimeState.task,
                links: runtimeState.routeDecision?.userLinks ?? []
              },
              requirements: runtimeState.taskRequirements
            })
          : undefined;
      const output = await exportWorkspace(runtimeState, {
        workspaceRoot:
          runtimeState.workspace.targetRootPath ??
          this.options.workspaceRoot,
        downloadArtifacts,
        localArtifacts,
        templateRegistry: this.workspaceTemplates,
        workspaceGuide,
        allowTestFixtures:
          process.env.NODE_ENV === "test" &&
          process.env.XL_AGENT_E2E_DOWNLOAD_FIXTURE === "1"
      });
      await this.options.store.recordWorkspaceExport(output);
      return { ok: true, output };
    } catch (error) {
      return { ok: false, error: toWorkspaceExportError(error) };
    }
  }
}
