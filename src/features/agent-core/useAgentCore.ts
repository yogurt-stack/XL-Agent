import { useCallback, useEffect, useRef, useState } from "react";
import { InMemoryAgentToolExecutor } from "./agentServices";
import { LocalRuleModelRuntime } from "./localRuleModel";
import {
  ModelConnectionController,
  ModelConnectionRequestError,
  toModelConnectionError
} from "./modelConnection";
import { FallbackModelRuntime, parseRemoteDecision, RemoteLlmModelRuntime } from "./remoteModel";
import { createMockAgentRuntime } from "./runtime";
import { createSystemProfileToolOutput, isHostSystemProfile } from "./systemProfile";
import type { AgentEvent } from "./types";

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
    return { runtime: createMockAgentRuntime(localModel), modelConnection };
  }

  const tools = new InMemoryAgentToolExecutor(
    async () => {
      const result = await electronBridge.readSystemProfile();
      if (!result.ok) throw new Error(result.error.message);
      if (!isHostSystemProfile(result.profile)) {
        throw new Error("Electron 返回了非法系统画像。");
      }
      return createSystemProfileToolOutput(result.profile);
    },
    (resourceId) => electronBridge.controlledDownload(resourceId)
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
  return {
    runtime: createMockAgentRuntime(fallbackModel, tools, "controlled_download"),
    modelConnection
  };
}

export function useAgentCore() {
  const servicesRef = useRef<ReturnType<typeof createRendererAgentServices>>();
  if (!servicesRef.current) servicesRef.current = createRendererAgentServices();
  const { runtime, modelConnection } = servicesRef.current;
  const [state, setState] = useState(() => runtime.getState());
  const [modelConnectionState, setModelConnectionState] = useState(() => modelConnection.getState());

  const dispatch = useCallback((event: AgentEvent) => {
    return runtime.dispatch(event);
  }, [runtime]);

  const testModelConnection = useCallback(() => modelConnection.testConnection(), [modelConnection]);

  useEffect(() => {
    const unsubscribe = runtime.subscribe(setState);
    const unsubscribeModelConnection = modelConnection.subscribe(setModelConnectionState);
    void modelConnection.initialize();
    runtime.start();
    return () => {
      unsubscribe();
      unsubscribeModelConnection();
      runtime.stop();
    };
  }, [modelConnection, runtime]);

  return { state, dispatch, modelConnectionState, testModelConnection };
}
