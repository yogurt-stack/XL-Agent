import type { AgentPhase, AgentState, PlannedResource } from "./types";

export function selectedResources(state: AgentState) {
  return state.resources.filter((resource) => resource.selected);
}

export function totalDownloadSizeMb(state: AgentState) {
  return selectedResources(state).reduce((total, resource) => total + resource.sizeMb, 0);
}

export function overallProgress(state: AgentState) {
  const resources = selectedResources(state);
  if (resources.length === 0) return 0;
  return Math.round(resources.reduce((total, resource) => total + resource.progress, 0) / resources.length);
}

export function estimatedMinutes(state: AgentState) {
  const remainingMb = selectedResources(state).reduce(
    (total, resource) => total + resource.sizeMb * ((100 - resource.progress) / 100),
    0
  );
  return Math.max(1, Math.ceil(remainingMb / 12.4 / 60));
}

export function requiredMissingResources(state: AgentState): PlannedResource[] {
  return state.resources.filter(
    (resource) => resource.required && (!resource.selected || resource.status !== "verified")
  );
}

export function phaseLabel(phase: AgentPhase) {
  const labels: Record<AgentPhase, string> = {
    intake: "等待任务",
    routing: "路由判断",
    clarifying: "澄清需求",
    planning: "生成资源计划",
    waiting_approval: "等待用户确认",
    downloading: "模拟下载",
    awaiting_failure_action: "等待失败处置",
    verifying: "验证资源",
    replanning: "重规划",
    handoff: "工作区交接",
    cancelled: "任务已取消"
  };
  return labels[phase];
}
