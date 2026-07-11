import type { AgentEvent, AgentState } from "./types";

export function getNextMockEvent(state: AgentState): AgentEvent | null {
  if (state.phase === "routing") return { type: "ROUTE_RESOLVED" };
  if (state.phase === "planning") return { type: "PLAN_GENERATED" };
  if (state.phase === "replanning") return { type: "REPLAN_GENERATED" };
  if (state.phase === "verifying") return { type: "VERIFY_RESOURCES" };
  if (state.phase !== "downloading" || !state.activeResourceId) return null;

  const resource = state.resources.find((item) => item.id === state.activeResourceId);
  if (!resource) return null;

  const sampleFailureAlreadyInjected = state.logs.some((entry) =>
    entry.message.includes("示例项目代码包校验失败")
  );

  if (resource.id === "sample-project" && !sampleFailureAlreadyInjected) {
    if (resource.progress >= 56) {
      return {
        type: "DOWNLOAD_FAILED",
        resourceId: resource.id,
        reason: "示例项目代码包校验失败：模拟 SHA256 与可信目录不一致"
      };
    }
    return {
      type: "DOWNLOAD_PROGRESS",
      resourceId: resource.id,
      progress: Math.min(56, resource.progress + 18)
    };
  }

  return {
    type: "DOWNLOAD_PROGRESS",
    resourceId: resource.id,
    progress: Math.min(100, resource.progress + 25)
  };
}
