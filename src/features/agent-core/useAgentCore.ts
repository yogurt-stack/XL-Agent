import { useCallback, useEffect, useRef, useState } from "react";
import { createInitialAgentState } from "./machine";
import type { ModelConnectionState } from "./modelConnection";
import type {
  AgentRuntimeSnapshot,
  PlatformCapabilitySummary
} from "./runtimeBridge";
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
    stateRef.current = snapshot.state;
    setState(snapshot.state);
    setModelConnectionState(snapshot.modelConnection);
    setPersistenceState(snapshot.persistence);
    setCapabilities(snapshot.capabilities);
  }, []);

  const dispatch = useCallback(
    async (event: AgentUserEvent) => {
      if (!bridge) return stateRef.current;
      const result = await bridge.dispatchAgentEvent(event);
      if (result.ok) {
        applySnapshot(result.snapshot);
      } else {
        setPersistenceState((current) => ({
          ...current,
          status: "error",
          error: `${result.error.code}: ${result.error.message}`
        }));
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

    void bridge.getAgentRuntimeSnapshot().then((result) => {
      if (disposed) return;
      if (result.ok) {
        applySnapshot(result.snapshot);
      } else {
        setPersistenceState((current) => ({
          ...current,
          status: "error",
          error: `${result.error.code}: ${result.error.message}`
        }));
      }
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [applySnapshot, bridge]);

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
    selectWorkspaceRoot
  };
}
