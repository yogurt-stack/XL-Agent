import { useCallback, useEffect, useRef, useState } from "react";
import { InMemoryAgentToolExecutor } from "./agentServices";
import { LocalRuleModelRuntime } from "./localRuleModel";
import {
  ModelConnectionController,
  ModelConnectionRequestError,
  toModelConnectionError
} from "./modelConnection";
import { FallbackModelRuntime, parseRemoteDecision, RemoteLlmModelRuntime } from "./remoteModel";
import { isRestorableAgentState } from "./persistence";
import { createMockAgentRuntime } from "./runtime";
import { createSystemProfileToolOutput, isHostSystemProfile } from "./systemProfile";
import type { AgentEvent, AgentState } from "./types";

export type PersistenceViewState = {
  status: "browser_only" | "loading" | "ready" | "error";
  restoredAt: string | null;
  lastSavedAt: string | null;
  error: string | null;
};

function createRendererAgentServices() {
  const localModel = new LocalRuleModelRuntime();
  const electronBridge = window.xunleiAgent;
  const modelConnection = new ModelConnectionController(
    electronBridge
      ? {
          async getConnectionInfo() {
            const result = await electronBridge.getModelConnectionInfo();
            if (!result.ok) throw new ModelConnectionRequestError(result.error);
            return result.info;
          },
          async testConnection() {
            const result = await electronBridge.testModelConnection();
            if (!result.ok) return result;
            try {
              parseRemoteDecision(result.decision);
              return { ok: true };
            } catch (error) {
              return { ok: false, error: toModelConnectionError(error) };
            }
          }
        }
      : undefined
  );

  if (!electronBridge) {
    return {
      runtime: createMockAgentRuntime(localModel),
      modelConnection,
      persistState: async (_state: AgentState) => null,
      restoreRuntime: async () => null,
      flushPersistence: async () => undefined,
      readWorkspaceFile: async () => ({
        ok: false as const,
        error: {
          code: "ELECTRON_BRIDGE_UNAVAILABLE",
          message: "浏览器模式没有真实工作区文件。",
          retriable: false
        }
      }),
      openWorkspace: async () => ({
        ok: false as const,
        error: "浏览器模式没有真实工作区目录。"
      })
    };
  }

  let persistenceQueue: Promise<unknown> = Promise.resolve();
  const waitForPersistence = () => persistenceQueue;
  const persistState = (state: AgentState) => {
    if (state.phase === "intake" || state.taskId === "unassigned" || !state.task) {
      return Promise.resolve(null);
    }
    const operation = persistenceQueue
      .catch(() => undefined)
      .then(async () => {
        const result = await electronBridge.saveTaskState(state);
        if (!result.ok) throw new Error(result.error.message);
        return result.savedAt;
      });
    persistenceQueue = operation;
    return operation;
  };

  const tools = new InMemoryAgentToolExecutor(
    async () => {
      const result = await electronBridge.readSystemProfile();
      if (!result.ok) throw new Error(result.error.message);
      if (!isHostSystemProfile(result.profile)) {
        throw new Error("Electron 返回了非法系统画像。");
      }
      return createSystemProfileToolOutput(result.profile);
    },
    async (request) => {
      await waitForPersistence();
      return electronBridge.controlledDownload(request);
    },
    async (request) => {
      await waitForPersistence();
      return electronBridge.exportWorkspace(request);
    }
  );

  const remoteModel = new RemoteLlmModelRuntime({
    async requestDecision(context) {
      const result = await electronBridge.requestModelDecision(context);
      if (!result.ok) throw new ModelConnectionRequestError(result.error);
      return result.decision;
    }
  });
  const fallbackModel = new FallbackModelRuntime(remoteModel, localModel, {
    shouldAttemptPrimary: () => modelConnection.shouldAttemptRemote(),
    onPrimarySuccess: (decision) => modelConnection.recordRemoteSuccess(decision),
    onPrimaryFailure: (error) => modelConnection.recordFallback(error)
  });
  const runtime = createMockAgentRuntime(
    fallbackModel,
    tools,
    "controlled_download"
  );
  return {
    runtime,
    modelConnection,
    persistState,
    async restoreRuntime() {
      const result = await electronBridge.loadTaskState();
      if (!result.ok) throw new Error(result.error.message);
      if (!result.restored) return null;
      if (!isRestorableAgentState(result.restored.state)) {
        throw new Error("SQLite 返回了不兼容或损坏的 AgentState。");
      }
      runtime.dispatch({
        type: "TASK_STATE_RESTORED",
        state: result.restored.state,
        approvalValid: result.restored.approval.valid
      });
      return result.restored.savedAt;
    },
    async flushPersistence() {
      await waitForPersistence().catch(() => undefined);
      await electronBridge.flushTaskPersistence();
    },
    readWorkspaceFile: (relativePath: string) =>
      electronBridge.readWorkspaceFile({
        taskId: runtime.getState().taskId,
        revision: runtime.getState().revision,
        relativePath
      }),
    openWorkspace: () =>
      electronBridge.openWorkspace({
        taskId: runtime.getState().taskId,
        revision: runtime.getState().revision
      })
  };
}

export function useAgentCore() {
  const servicesRef = useRef<ReturnType<typeof createRendererAgentServices>>();
  if (!servicesRef.current) servicesRef.current = createRendererAgentServices();
  const services = servicesRef.current;
  const { runtime, modelConnection } = services;
  const [state, setState] = useState(() => runtime.getState());
  const [modelConnectionState, setModelConnectionState] = useState(() => modelConnection.getState());
  const [persistenceState, setPersistenceState] = useState<PersistenceViewState>(() => ({
    status: window.xunleiAgent ? "loading" : "browser_only",
    restoredAt: null,
    lastSavedAt: null,
    error: null
  }));

  const dispatch = useCallback((event: AgentEvent) => {
    return runtime.dispatch(event);
  }, [runtime]);

  const testModelConnection = useCallback(() => modelConnection.testConnection(), [modelConnection]);

  useEffect(() => {
    let disposed = false;
    const unsubscribe = runtime.subscribe((nextState) => {
      setState(nextState);
      void services.persistState(nextState).then(
        (savedAt) => {
          if (!disposed && savedAt) {
            setPersistenceState((current) => ({
              ...current,
              status: "ready",
              lastSavedAt: savedAt,
              error: null
            }));
          }
        },
        (error) => {
          if (!disposed) {
            setPersistenceState((current) => ({
              ...current,
              status: "error",
              error: error instanceof Error ? error.message : "SQLite 写入失败。"
            }));
          }
        }
      );
    });
    const unsubscribeModelConnection = modelConnection.subscribe(setModelConnectionState);
    void modelConnection.initialize();
    void services.restoreRuntime().then(
      (restoredAt) => {
        if (disposed) return;
        setState(runtime.getState());
        setPersistenceState((current) => ({
          ...current,
          status: window.xunleiAgent ? "ready" : "browser_only",
          restoredAt,
          error: null
        }));
        runtime.start();
      },
      (error) => {
        if (disposed) return;
        setPersistenceState((current) => ({
          ...current,
          status: "error",
          error: error instanceof Error ? error.message : "SQLite 恢复失败。"
        }));
        runtime.start();
      }
    );
    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeModelConnection();
      runtime.stop();
    };
  }, [modelConnection, runtime, services]);

  return {
    state,
    dispatch,
    modelConnectionState,
    persistenceState,
    testModelConnection,
    flushPersistence: services.flushPersistence,
    readWorkspaceFile: services.readWorkspaceFile,
    openWorkspace: services.openWorkspace
  };
}
