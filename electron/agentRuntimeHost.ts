import {
  DefaultAgentPolicy,
  InMemoryAgentToolExecutor
} from "../src/features/agent-core/agentServices";
import { parseAgentUserEvent } from "../src/features/agent-core/agentSchemas";
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
import { LocalXunleiAdapter } from "./xunleiAdapter";
import type { LocalArtifactRecord } from "./localArtifacts";
import { ElectronArtifactVerifier } from "./artifactVerifier";
import { writeCurrentManifestSnapshot } from "./manifestSnapshots";
import { WorkspaceInspectorAgent } from "./agentB";

export type AgentRuntimeHostOptions = {
  store: TaskStore;
  modelClient: RemoteModelClient;
  workspaceRoot: string;
  performDownload: (
    resourceId: string,
    metadata: TrustedDownloadMetadata,
    options: ControlledDownloadOptions
  ) => Promise<ControlledDownloadResult> | ControlledDownloadResult;
  onSnapshot?: (snapshot: AgentRuntimeSnapshot) => void;
  stepDelayMs?: number;
  createTaskId?: () => string;
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
    error: null
  };
  private persistenceQueue: Promise<unknown> = Promise.resolve();
  private readonly modelConnection: ModelConnectionController;
  private readonly workspaceTemplates =
    createDefaultWorkspaceTemplateRegistry();
  private readonly domainSkills = createDefaultDomainSkillRegistry();
  private readonly downloadAdapter: LocalXunleiAdapter;
  private readonly agentB: WorkspaceInspectorAgent;
  private suppressNextManifestGeneration = false;
  private disposed = false;

  private constructor(private readonly options: AgentRuntimeHostOptions) {
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

    const localModel = new LocalRuleModelRuntime();
    const sourceProviders = createDefaultSourceProviderRegistry();
    const remoteModel = new RemoteLlmModelRuntime({
      requestDecision: (context) => this.options.modelClient.requestDecision(context)
    });
    const fallbackModel = new FallbackModelRuntime(remoteModel, localModel, {
      shouldAttemptPrimary: () => this.modelConnection.shouldAttemptRemote(),
      onPrimarySuccess: (decision) => this.modelConnection.recordRemoteSuccess(decision),
      onPrimaryFailure: (error) => {
        const detail = toMainModelConnectionError(error);
        this.modelConnection.recordFallback(new ModelConnectionRequestError(detail));
      }
    });

    const tools = new InMemoryAgentToolExecutor(
      () => createSystemProfileToolOutput(readHostSystemProfile()),
      (request) => this.runControlledDownload(request),
      (request) => this.runWorkspaceExport(request),
      sourceProviders.get("trusted-catalog") ?? undefined
    );

    this.runtime = new AgentRuntime({
      router: new ExtensibleAgentRouter(this.domainSkills, sourceProviders),
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
      persistence: { ...this.persistence }
    };
  }

  async dispatch(value: unknown): Promise<AgentRuntimeSnapshot> {
    const event = parseAgentUserEvent(value);
    const state = this.runtime.getState();
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
    this.runtime.dispatch(event);
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
    const task = this.runtime.getState().task.trim();
    this.modelConnection.useLocalModel(
      "远程规划未在安全步数内生成计划，本次重试已切换本地规则模型。"
    );
    this.runtime.dispatch({ type: "RESET" });
    if (task) this.runtime.dispatch({ type: "SUBMIT_TASK", task });
    return this.getSnapshot();
  }

  async testModelConnection() {
    await this.modelConnection.testConnection();
    return this.getSnapshot();
  }

  async addLocalArtifacts(records: LocalArtifactRecord[]) {
    if (!records.length) return this.getSnapshot();
    const state = this.runtime.getState();
    if (
      state.taskId === "unassigned" ||
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

  selectWorkspaceRoot(rootPath: string) {
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
    const shouldGenerateManifest = !this.suppressNextManifestGeneration;
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
    const catalogStatus = getTrustedCatalogStatus();
    if (catalogStatus !== "active") {
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

    const trustedResource = getTrustedResourceMetadata(request.resourceId);
    if (!trustedResource) {
      return controlledDownloadError(
        "RESOURCE_NOT_TRUSTED",
        "请求的资源不在 Electron 主进程可信下载目录中。",
        false
      );
    }
    const metadata = trustedResource.download;

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
        expectedSha256: metadata.expectedSha256,
        verificationStatus: testFixture ? "test-fixture" : "downloaded",
        verifiedAt: new Date().toISOString(),
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
            : "APPROVAL_NOT_FOUND",
          approval.status === "expired"
            ? "当前工作区导出审批已过期，请重新确认资源计划。"
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
