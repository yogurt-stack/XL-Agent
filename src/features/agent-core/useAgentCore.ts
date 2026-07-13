import { useCallback, useEffect, useRef, useState } from "react";
import { LocalRuleModelRuntime } from "./localRuleModel";
import { FallbackModelRuntime, RemoteLlmModelRuntime } from "./remoteModel";
import { createMockAgentRuntime } from "./runtime";
import type { AgentEvent } from "./types";

function createRendererAgentRuntime() {
  const localModel = new LocalRuleModelRuntime();
  const requestModelDecision = window.xunleiAgent?.requestModelDecision;
  if (!requestModelDecision) return createMockAgentRuntime(localModel);

  const remoteModel = new RemoteLlmModelRuntime({
    async requestDecision(context) {
      const result = await requestModelDecision(context);
      if (!result.ok) throw new Error(result.error);
      return result.decision;
    }
  });
  return createMockAgentRuntime(new FallbackModelRuntime(remoteModel, localModel));
}

export function useAgentCore() {
  const runtimeRef = useRef<ReturnType<typeof createRendererAgentRuntime>>();
  if (!runtimeRef.current) runtimeRef.current = createRendererAgentRuntime();
  const runtime = runtimeRef.current;
  const [state, setState] = useState(() => runtime.getState());

  const dispatch = useCallback((event: AgentEvent) => {
    runtime.dispatch(event);
  }, [runtime]);

  useEffect(() => {
    const unsubscribe = runtime.subscribe(setState);
    runtime.start();
    return () => {
      unsubscribe();
      runtime.stop();
    };
  }, [runtime]);

  return { state, dispatch };
}
