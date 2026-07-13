import type { AgentPlanner, AgentRouter, AgentVerifier } from "./interfaces";
import type { AgentEvent, AgentState, ReplanStrategy } from "./types";

const windowsAiDevelopmentRoute = "windows-ai-development";

export class FixedWindowsRouter implements AgentRouter {
  route(state: AgentState): Extract<AgentEvent, { type: "ROUTE_RESOLVED" }> | null {
    return state.phase === "routing" ? { type: "ROUTE_RESOLVED", route: windowsAiDevelopmentRoute } : null;
  }
}

export class FixedWindowsPlanner implements AgentPlanner {
  createPlan(state: AgentState): Extract<AgentEvent, { type: "PLAN_GENERATED" }> | null {
    return state.phase === "planning" ? { type: "PLAN_GENERATED" } : null;
  }

  createReplan(state: AgentState): Extract<AgentEvent, { type: "REPLAN_GENERATED" }> | null {
    if (state.phase !== "replanning") return null;
    const strategy: ReplanStrategy =
      state.requestedReplanStrategy ??
      (state.answers["mirror-policy"] === "允许备用镜像" ? "trusted-mirror" : "primary-retry");
    return { type: "REPLAN_GENERATED", strategy };
  }
}

export class MockVerifier implements AgentVerifier {
  verify(state: AgentState): Extract<AgentEvent, { type: "VERIFY_RESOURCES" }> | null {
    return state.phase === "verifying" ? { type: "VERIFY_RESOURCES" } : null;
  }
}
