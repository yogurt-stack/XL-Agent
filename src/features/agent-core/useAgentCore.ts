import { useCallback, useEffect, useRef, useState } from "react";
import { createInitialAgentState } from "./machine";
import type { ModelConnectionState } from "./modelConnection";
import type {
  AgentRuntimeSnapshot,
  AgentRuntimeSnapshotCursor,
  PlatformCapabilitySummary
} from "./runtimeBridge";
import { classifyAgentRuntimeSnapshot } from "./runtimeBridge";
import type { AgentState, AgentUserEvent } from "./types";

export type PersistenceViewState = {
  status: "browser_only" | "loading" | "ready" | "error";
  restoredAt: string | null;
  lastSavedAt: string | null;
  lastResetAt: string | null;
  lastResetRemovedRecords: number;
  error: string | null;
};

const browserCapabilities: PlatformCapabilitySummary = {
  domainSkills: [],
  sourceProviders: [],
  workspaceTemplates: []
};

function createInitialModelConnectionState(
  bridgeAvailable: boolean
): ModelConnectionState {
  return bridgeAvailable
    ? {
        status: "checking",
        activeProvider: "local-rule",
        configured: false,
        endpointHost: null,
        model: null,
        providerId: null,
        endpointMode: null,
        lastCheckedAt: null
      }
    : {
        status: "unconfigured",
        activeProvider: "local-rule",
        configured: false,
        endpointHost: null,
        model: null,
        providerId: null,
        endpointMode: null,
        lastCheckedAt: null,
        error: {
          code: "MODEL_BRIDGE_UNAVAILABLE",
          message: "当前页面没有 Electron Main Agent Runtime 桥接。",
          retriable: false
        }
      };
}

/**
 * Renderer 的 Agent 视图适配器。
 *
 * 这里不再创建模型、状态机、Policy 或 Tool。所有状态转换都通过
 * contextBridge 派发到 Electron Main，并以 Main 广播的快照为唯一事实源。
 */
export function useAgentCore() {
  const bridge = window.xunleiAgent;
  const stateRef = useRef<AgentState>(createInitialAgentState());
  const snapshotCursorRef = useRef<AgentRuntimeSnapshotCursor | null>(null);
  const snapshotRequestRef = useRef<Promise<boolean> | null>(null);
  const [state, setState] = useState(stateRef.current);
  const [modelConnectionState, setModelConnectionState] = useState(
    () => createInitialModelConnectionState(Boolean(bridge))
  );
  const [persistenceState, setPersistenceState] = useState<PersistenceViewState>(
    () => ({
      status: bridge ? "loading" : "browser_only",
      restoredAt: null,
      lastSavedAt: null,
      lastResetAt: null,
      lastResetRemovedRecords: 0,
      error: bridge ? null : "浏览器模式不运行 Agent Runtime。"
    })
  );
  const [capabilities, setCapabilities] =
    useState<PlatformCapabilitySummary>(browserCapabilities);

  const applySnapshot = useCallback((snapshot: AgentRuntimeSnapshot) => {
    const acceptance = classifyAgentRuntimeSnapshot(
      snapshotCursorRef.current,
      snapshot
    );
    if (!acceptance.accepted) {
      if (
        acceptance.reason === "incompatible-protocol" ||
        acceptance.reason === "invalid-envelope"
      ) {
        setPersistenceState((current) => ({
          ...current,
          status: "error",
          error:
            "Renderer 与 Electron Main 的 Agent Runtime 协议不一致，请完全退出并重新启动应用。"
        }));
      }
      return false;
    }
    snapshotCursorRef.current = acceptance.cursor;
    stateRef.current = snapshot.state;
    setState(snapshot.state);
    setModelConnectionState(snapshot.modelConnection);
    setPersistenceState(snapshot.persistence);
    setCapabilities(snapshot.capabilities);
    return true;
  }, []);

  const refreshRuntimeSnapshot = useCallback(async () => {
    if (!bridge) return false;
    if (snapshotRequestRef.current) return snapshotRequestRef.current;

    const request = (async () => {
      try {
        const result = await bridge.getAgentRuntimeSnapshot();
        if (result.ok) return applySnapshot(result.snapshot);
        setPersistenceState((current) => ({
          ...current,
          status: "error",
          error: `${result.error.code}: ${result.error.message}`
        }));
        return false;
      } catch (error) {
        setPersistenceState((current) => ({
          ...current,
          status: "error",
          error:
            error instanceof Error
              ? `Agent Runtime 同步失败：${error.message}`
              : "Agent Runtime 同步失败。"
        }));
        return false;
      } finally {
        snapshotRequestRef.current = null;
      }
    })();
    snapshotRequestRef.current = request;
    return request;
  }, [applySnapshot, bridge]);

  const dispatch = useCallback(
    async (event: AgentUserEvent) => {
      if (!bridge) return stateRef.current;
      const stateBeforeDispatch = stateRef.current;
      const result = await bridge.dispatchAgentEvent(event);
      if (result.ok) {
        applySnapshot(result.snapshot);
      } else {
        setPersistenceState((current) => ({
          ...current,
          status: "error",
          error: `${result.error.code}: ${result.error.message}`
        }));
        // A push snapshot can arrive before the IPC response. Returning that
        // optimistic state here would make callers treat a rejected or
        // non-durable mutation as acknowledged (most importantly CANCEL_TASK).
        return stateBeforeDispatch;
      }
      return stateRef.current;
    },
    [applySnapshot, bridge]
  );

  const testModelConnection = useCallback(async () => {
    if (!bridge) return modelConnectionState;
    const result = await bridge.testModelConnection();
    if (result.ok) applySnapshot(result.snapshot);
    return result.ok ? result.snapshot.modelConnection : modelConnectionState;
  }, [applySnapshot, bridge, modelConnectionState]);

  const retryTaskLocally = useCallback(async () => {
    if (!bridge) return stateRef.current;
    const result = await bridge.retryTaskLocally();
    if (result.ok) applySnapshot(result.snapshot);
    return stateRef.current;
  }, [applySnapshot, bridge]);

  const resetDemoData = useCallback(async () => {
    if (!bridge) {
      return {
        ok: false as const,
        error: {
          code: "ELECTRON_BRIDGE_UNAVAILABLE",
          message: "浏览器模式不能重置 Electron Demo 数据。",
          retriable: false
        }
      };
    }
    const result = await bridge.resetDemoData();
    if (result.ok) applySnapshot(result.snapshot);
    return result;
  }, [applySnapshot, bridge]);

  const flushPersistence = useCallback(async () => {
    if (bridge) await bridge.flushTaskPersistence();
  }, [bridge]);

  const readWorkspaceFile = useCallback(
    async (relativePath: string) => {
      if (!bridge) {
        return {
          ok: false as const,
          error: {
            code: "ELECTRON_BRIDGE_UNAVAILABLE",
            message: "浏览器模式没有真实工作区文件。",
            retriable: false
          }
        };
      }
      return bridge.readWorkspaceFile({
        taskId: stateRef.current.taskId,
        revision: stateRef.current.revision,
        relativePath
      });
    },
    [bridge]
  );

  const openWorkspace = useCallback(async () => {
    if (!bridge) {
      return {
        ok: false as const,
        error: "浏览器模式没有真实工作区目录。"
      };
    }
    return bridge.openWorkspace({
      taskId: stateRef.current.taskId,
      revision: stateRef.current.revision
    });
  }, [bridge]);

  const selectLocalResources = useCallback(async () => {
    if (!bridge) {
      return {
        ok: false as const,
        error: {
          code: "ELECTRON_BRIDGE_UNAVAILABLE",
          message: "浏览器模式不能接入本地资源。",
          retriable: false
        }
      };
    }
    const result = await bridge.selectLocalResources();
    if (result.ok) applySnapshot(result.snapshot);
    return result;
  }, [applySnapshot, bridge]);

  const selectLocalRepository = useCallback(async () => {
    if (!bridge) {
      return {
        ok: false as const,
        error: {
          code: "ELECTRON_BRIDGE_UNAVAILABLE",
          message: "浏览器模式不能导入本地 Git 仓库。",
          retriable: false
        }
      };
    }
    const result = await bridge.selectLocalRepository();
    if (result.ok) applySnapshot(result.snapshot);
    return result;
  }, [applySnapshot, bridge]);

  const prepareGitHubPublish = useCallback(
    async (input: {
      repositoryName: string;
      visibility: "private" | "public";
      branch?: string;
      commitMessage?: string;
    }) => {
      if (!bridge) {
        return {
          ok: false as const,
          error: {
            code: "ELECTRON_BRIDGE_UNAVAILABLE",
            message: "浏览器模式不能创建 GitHub 发布计划。",
            retriable: false
          }
        };
      }
      const result = await bridge.prepareGitHubPublish(input);
      if (result.ok) applySnapshot(result.snapshot);
      return result;
    },
    [applySnapshot, bridge]
  );

  const approveGitHubPublish = useCallback(
    async (input: { publishId: string; planSha256: string }) => {
      if (!bridge) {
        return {
          ok: false as const,
          error: {
            code: "ELECTRON_BRIDGE_UNAVAILABLE",
            message: "浏览器模式不能批准 GitHub 发布。",
            retriable: false
          }
        };
      }
      const result = await bridge.approveGitHubPublish(input);
      if (result.ok) applySnapshot(result.snapshot);
      return result;
    },
    [applySnapshot, bridge]
  );

  const selectWorkspaceRoot = useCallback(async () => {
    if (!bridge) {
      return {
        ok: false as const,
        error: {
          code: "ELECTRON_BRIDGE_UNAVAILABLE",
          message: "浏览器模式不能选择工作区目录。",
          retriable: false
        }
      };
    }
    const result = await bridge.selectWorkspaceRoot();
    if (result.ok) applySnapshot(result.snapshot);
    return result;
  }, [applySnapshot, bridge]);

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    const unsubscribe = bridge.onAgentRuntimeSnapshot((snapshot) => {
      if (!disposed) applySnapshot(snapshot);
    });

    if (!disposed) void refreshRuntimeSnapshot();

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [applySnapshot, bridge, refreshRuntimeSnapshot]);

  useEffect(() => {
    if (!bridge) return;
    const runtimeIsAdvancing =
      [
        "routing",
        "task_planning",
        "planning",
        "replanning",
        "downloading",
        "verifying",
        "exporting"
      ].includes(state.phase) ||
      state.agentB.status === "running" ||
      state.githubPublish.status === "publishing";
    if (!runtimeIsAdvancing) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const intervalMs = state.phase === "routing" ? 1_000 : 2_500;
    const poll = async () => {
      await refreshRuntimeSnapshot();
      if (!disposed) timer = setTimeout(poll, intervalMs);
    };
    timer = setTimeout(poll, intervalMs);

    const refreshWhenVisible = () => {
      if (!disposed && document.visibilityState === "visible") {
        void refreshRuntimeSnapshot();
      }
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [bridge, refreshRuntimeSnapshot, state.agentB.status, state.githubPublish.status, state.phase]);

  return {
    state,
    dispatch,
    modelConnectionState,
    persistenceState,
    capabilities,
    testModelConnection,
    retryTaskLocally,
    resetDemoData,
    flushPersistence,
    readWorkspaceFile,
    openWorkspace,
    selectLocalResources,
    selectLocalRepository,
    prepareGitHubPublish,
    approveGitHubPublish,
    selectWorkspaceRoot
  };
}
