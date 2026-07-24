import type { AgentPhase, AgentState, PlannedResource, ToolResult } from "./types";

export type ToolResultGroup = {
  tool: ToolResult["tool"];
  results: ToolResult[];
  successCount: number;
  errorCount: number;
  cancelledCount: number;
  latestStatus: ToolResult["status"];
};

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

export function groupedToolResults(state: AgentState): ToolResultGroup[] {
  const groups = new Map<ToolResult["tool"], ToolResultGroup>();

  for (const result of state.agentRun.toolResults) {
    const group = groups.get(result.tool) ?? {
      tool: result.tool,
      results: [],
      successCount: 0,
      errorCount: 0,
      cancelledCount: 0,
      latestStatus: result.status
    };
    group.results.push(result);
    group.latestStatus = result.status;
    if (result.status === "success") group.successCount += 1;
    if (result.status === "error") group.errorCount += 1;
    if (result.status === "cancelled") group.cancelledCount += 1;
    groups.set(result.tool, group);
  }

  return [...groups.values()];
}

export function phaseLabel(phase: AgentPhase) {
  const labels: Record<AgentPhase, string> = {
    intake: "等待任务",
    routing: "路由判断",
    clarifying: "澄清需求",
    planning: "生成资源计划",
    waiting_approval: "等待用户确认",
    downloading: "受控下载",
    awaiting_failure_action: "等待失败处置",
    verifying: "验证资源",
    exporting: "导出工作区",
    awaiting_export_retry: "等待导出重试",
    replanning: "重规划",
    handoff: "工作区交接",
    cancelled: "任务已取消"
  };
  return labels[phase];
}
