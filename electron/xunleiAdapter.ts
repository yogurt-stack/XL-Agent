import type {
  ControlledDownloadResult
} from "../src/features/agent-core/types";
import {
  downloadTrustedResource,
  toControlledDownloadError,
  type ControlledDownloadOptions,
  type ControlledDownloadProgress
} from "./downloadClient";
import type {
  DownloadTaskProgress,
  DownloadTaskRecord
} from "./downloadTasks";
import type { TaskStore } from "./taskStore";
import type { TrustedDownloadMetadata } from "./trustedDownloadCatalog";

type ActiveDownloadControl = {
  taskId: string;
  revision: number;
  resourceId: string;
  abortController: AbortController;
  paused: boolean;
  resumeWaiters: Array<() => void>;
};

export type XunleiAdapterOptions = {
  store: TaskStore;
  onProgress?: (progress: DownloadTaskProgress) => void;
  now?: () => Date;
  performDownload?: (
    resourceId: string,
    metadata: TrustedDownloadMetadata,
    options: ControlledDownloadOptions
  ) => Promise<ControlledDownloadResult>;
};

/**
 * 下载执行适配器。
 *
 * 这个实现使用 Electron Main 的受控流式下载作为本地后端，同时把任务状态
 * 固化为可替换的 XunleiAdapter 边界；后续接入迅雷 SDK 时不需要修改 Agent Core。
 */
export class LocalXunleiAdapter {
  private readonly active = new Map<string, ActiveDownloadControl>();
  private readonly now: () => Date;

  constructor(private readonly options: XunleiAdapterOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private key(taskId: string, revision: number, resourceId: string) {
    return `${taskId}:r${revision}:${resourceId}`;
  }

  async createDownloadTask(input: {
    taskId: string;
    revision: number;
    resourceId: string;
    metadata: TrustedDownloadMetadata;
  }): Promise<ControlledDownloadResult> {
    const key = this.key(input.taskId, input.revision, input.resourceId);
    if (this.active.has(key)) {
      return {
        ok: false,
        error: {
          code: "DOWNLOAD_TASK_ALREADY_ACTIVE",
          message: "该资源的下载任务已经在运行。",
          retriable: false
        }
      };
    }

    const startedAt = this.now().toISOString();
    const control: ActiveDownloadControl = {
      taskId: input.taskId,
      revision: input.revision,
      resourceId: input.resourceId,
      abortController: new AbortController(),
      paused: false,
      resumeWaiters: []
    };
    this.active.set(key, control);
    await this.options.store.recordDownloadTask({
      taskId: input.taskId,
      revision: input.revision,
      resourceId: input.resourceId,
      status: "downloading",
      progress: 0,
      bytesWritten: 0,
      totalBytes: null,
      speedBytesPerSecond: 0,
      etaSeconds: null,
      tempFilePath: null,
      errorCode: null,
      errorMessage: null,
      createdAt: startedAt,
      updatedAt: startedAt
    });

    let lastPersistedProgress = -1;
    let lastPersistedAt = 0;
    const reportProgress = async (progress: ControlledDownloadProgress) => {
      const now = this.now();
      const record: DownloadTaskProgress = {
        taskId: input.taskId,
        revision: input.revision,
        resourceId: input.resourceId,
        status: control.paused ? "paused" : "downloading",
        progress: progress.progress,
        bytesWritten: progress.bytesWritten,
        totalBytes: progress.totalBytes,
        speedBytesPerSecond: progress.speedBytesPerSecond,
        etaSeconds: progress.etaSeconds
      };
      const shouldPersist =
        progress.progress >= lastPersistedProgress + 2 ||
        now.getTime() - lastPersistedAt >= 500;
      if (shouldPersist) {
        lastPersistedProgress = progress.progress;
        lastPersistedAt = now.getTime();
        this.options.onProgress?.(record);
        await this.options.store.updateDownloadTaskProgress({
          ...record,
          updatedAt: now.toISOString()
        });
      }
    };

    try {
      const executionOptions: ControlledDownloadOptions = {
          signal: control.abortController.signal,
          waitIfPaused: () => this.waitIfPaused(control),
          onProgress: reportProgress
      };
      const result = this.options.performDownload
        ? await this.options.performDownload(
            input.resourceId,
            input.metadata,
            executionOptions
          )
        : await downloadTrustedResource(
            { resourceId: input.resourceId, ...input.metadata },
            executionOptions
          ).then(
            (output) => ({ ok: true as const, output }),
            (error) => ({
              ok: false as const,
              error: toControlledDownloadError(error)
            })
          );
      if (!result.ok) {
        await this.options.store.failDownloadTask({
          taskId: input.taskId,
          revision: input.revision,
          resourceId: input.resourceId,
          status:
            result.error.code === "DOWNLOAD_CANCELLED"
              ? "cancelled"
              : "failed",
          errorCode: result.error.code,
          errorMessage: result.error.message,
          updatedAt: this.now().toISOString()
        });
        return result;
      }
      const output = result.output;
      const completedAt = this.now().toISOString();
      await this.options.store.completeDownloadTask({
        taskId: input.taskId,
        revision: input.revision,
        resourceId: input.resourceId,
        tempFilePath: output.tempFilePath,
        bytesWritten: output.bytesWritten,
        updatedAt: completedAt
      });
      this.options.onProgress?.({
        taskId: input.taskId,
        revision: input.revision,
        resourceId: input.resourceId,
        status: "completed",
        progress: 100,
        bytesWritten: output.bytesWritten,
        totalBytes: output.bytesWritten,
        speedBytesPerSecond: 0,
        etaSeconds: 0
      });
      return { ok: true, output };
    } catch (error) {
      const detail = toControlledDownloadError(error);
      await this.options.store.failDownloadTask({
        taskId: input.taskId,
        revision: input.revision,
        resourceId: input.resourceId,
        status:
          detail.code === "DOWNLOAD_CANCELLED" ? "cancelled" : "failed",
        errorCode: detail.code,
        errorMessage: detail.message,
        updatedAt: this.now().toISOString()
      });
      return { ok: false, error: detail };
    } finally {
      this.active.delete(key);
      this.releaseWaiters(control);
    }
  }

  async pause(taskId: string, revision: number, resourceId: string) {
    const control = this.active.get(this.key(taskId, revision, resourceId));
    if (!control || control.paused) return false;
    control.paused = true;
    await this.options.store.setDownloadTaskStatus(
      taskId,
      revision,
      resourceId,
      "paused",
      this.now().toISOString()
    );
    return true;
  }

  async resume(taskId: string, revision: number, resourceId: string) {
    const control = this.active.get(this.key(taskId, revision, resourceId));
    if (!control || !control.paused) return false;
    control.paused = false;
    this.releaseWaiters(control);
    await this.options.store.setDownloadTaskStatus(
      taskId,
      revision,
      resourceId,
      "downloading",
      this.now().toISOString()
    );
    return true;
  }

  async cancel(taskId: string, revision: number, resourceId: string) {
    const control = this.active.get(this.key(taskId, revision, resourceId));
    if (!control) return false;
    control.paused = false;
    this.releaseWaiters(control);
    control.abortController.abort();
    return true;
  }

  async cancelTask(taskId: string) {
    const controls = [...this.active.values()].filter(
      (control) => control.taskId === taskId
    );
    await Promise.all(
      controls.map((control) =>
        this.cancel(control.taskId, control.revision, control.resourceId)
      )
    );
  }

  getActiveTask(
    taskId: string,
    revision: number,
    resourceId: string
  ): DownloadTaskRecord | null {
    const control = this.active.get(this.key(taskId, revision, resourceId));
    if (!control) return null;
    const now = this.now().toISOString();
    return {
      taskId,
      revision,
      resourceId,
      status: control.paused ? "paused" : "downloading",
      progress: 0,
      bytesWritten: 0,
      totalBytes: null,
      speedBytesPerSecond: 0,
      etaSeconds: null,
      tempFilePath: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now
    };
  }

  private waitIfPaused(control: ActiveDownloadControl) {
    if (!control.paused) return Promise.resolve();
    return new Promise<void>((resolve) => {
      control.resumeWaiters.push(resolve);
    });
  }

  private releaseWaiters(control: ActiveDownloadControl) {
    const waiters = control.resumeWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }
}
