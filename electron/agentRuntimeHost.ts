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
  FixedWindowsPlanner,
  MockVerifier
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
import type { RemoteModelClient } from "./modelClient";
import {
  toModelConnectionError as toMainModelConnectionError
} from "./modelClient";
import type { TaskStore } from "./taskStore";
import {
  getTrustedCatalogStatus,
  getTrustedDownloadMetadata,
  type TrustedDownloadMetadata
} from "./trustedDownloadCatalog";
import {
  exportWorkspace,
  toWorkspaceExportError
} from "./workspaceExporter";
import { readHostSystemProfile } from "./systemProfile";

export type AgentRuntimeHostOptions = {
  store: TaskStore;
  modelClient: RemoteModelClient;
  workspaceRoot: string;
  performDownload: (
    resourceId: string,
    metadata: TrustedDownloadMetadata
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
  private disposed = false;

  private constructor(private readonly options: AgentRuntimeHostOptions) {
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
      verifier: new MockVerifier(),
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

  dispatch(value: unknown): AgentRuntimeSnapshot {
    const event = parseAgentUserEvent(value);
    this.runtime.dispatch(event);
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

  async flushPersistence() {
    await this.persistenceQueue.catch(() => undefined);
    await this.options.store.flush();
  }

  stop() {
    this.disposed = true;
    this.runtime.stop();
  }

  private handleRuntimeState(state: AgentState) {
    this.emitSnapshot();
    if (state.phase === "intake" || state.taskId === "unassigned" || !state.task) return;

    const operation = this.persistenceQueue
      .catch(() => undefined)
      .then(() => this.options.store.saveSnapshot(state))
      .then(
        ({ savedAt }) => {
          this.persistence = {
            ...this.persistence,
            status: "ready",
            lastSavedAt: savedAt,
            error: null
          };
          this.emitSnapshot();
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
    await this.persistenceQueue;
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

    const metadata = getTrustedDownloadMetadata(request.resourceId);
    if (!metadata) {
      return controlledDownloadError(
        "RESOURCE_NOT_TRUSTED",
        "请求的资源不在 Electron 主进程可信下载目录中。",
        false
      );
    }

    const approval = await this.options.store.hasValidApproval(
      request.taskId,
      request.revision
    );
    if (!approval.valid) {
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

    const result = await this.options.performDownload(
      request.resourceId,
      metadata
    );
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
        verificationStatus: testFixture ? "test-fixture" : "verified",
        verifiedAt: new Date().toISOString()
      });
    }
    return result;
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
        workspaceRoot: this.options.workspaceRoot,
        downloadArtifacts,
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
