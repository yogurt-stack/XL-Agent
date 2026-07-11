import { useCallback, useEffect, useState } from "react";
import { getNextMockEvent } from "./mockRunner";
import { createInitialAgentState, transition } from "./machine";
import type { AgentEvent } from "./types";

const mockStepDelayMs = 420;

export function useAgentCore() {
  const [state, setState] = useState(createInitialAgentState);

  const dispatch = useCallback((event: AgentEvent) => {
    setState((current) => transition(current, event));
  }, []);

  useEffect(() => {
    const nextEvent = getNextMockEvent(state);
    if (!nextEvent) return undefined;

    const timer = window.setTimeout(() => dispatch(nextEvent), mockStepDelayMs);
    return () => window.clearTimeout(timer);
  }, [dispatch, state]);

  return { state, dispatch };
}
