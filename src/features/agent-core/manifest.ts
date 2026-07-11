import type { AgentState } from "./types";

export function createResourceManifest(state: AgentState) {
  return {
    schemaVersion: "agent-core-demo-1.0",
    revision: state.revision,
    task: state.task,
    route: state.route,
    systemProfile: state.systemProfile,
    mode: "frontend-memory-simulation",
    generatedAt: state.workspace.generatedAt ?? null,
    resources: state.resources.map((resource) => ({
      id: resource.id,
      replacedFrom: resource.replacedFrom ?? null,
      name: resource.name,
      version: resource.version,
      source: resource.source,
      sizeMb: resource.sizeMb,
      license: resource.license,
      status: resource.status,
      selected: resource.selected,
      attempts: resource.attempts,
      failureReason: resource.failureReason ?? null
    })),
    handoff: {
      ready: state.workspace.ready,
      files: state.workspace.files,
      nextAction: state.workspace.nextAction,
      missingItems: state.resources
        .filter((resource) => resource.required && resource.status !== "verified")
        .map((resource) => resource.name)
    }
  };
}
