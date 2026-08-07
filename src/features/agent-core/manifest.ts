import type { AgentState } from "./types";

export function createResourceManifest(state: AgentState) {
  return {
    schemaVersion: "xunlei-agent-workspace-2.0",
    taskId: state.taskId,
    revision: state.revision,
    task: state.task,
    route: state.route,
    routeDecision: state.routeDecision,
    systemProfile: state.systemProfile,
    taskRequirements: state.taskRequirements,
    planValidation: state.planValidation,
    approvedRevision: state.approvedRevision,
    mode:
      state.workspace.ready && state.workspace.rootPath?.startsWith("/virtual/")
        ? "frontend-memory-simulation"
        : state.workspace.ready
          ? "electron-controlled-export"
          : "handoff-preview",
    generatedAt: state.workspace.generatedAt ?? null,
    manifestRevision: state.workspace.manifestRevision,
    status: state.workspace.overallStatus,
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
      github: resource.github ?? null,
      npm: resource.npm ?? null,
      failureReason: resource.failureReason ?? null
    })),
    localArtifacts: state.localArtifacts,
    localRepository: state.localRepository,
    githubPublish: state.githubPublish,
    agentB: state.agentB,
    handoff: {
      ready: state.workspace.ready,
      files: state.workspace.files,
      fileRecords: state.workspace.fileRecords,
      rootPath: state.workspace.rootPath ?? null,
      exportStatus: state.workspace.exportStatus,
      exportError: state.workspace.exportError ?? null,
      nextAction: state.workspace.nextAction,
      missingItems: state.resources
        .filter((resource) => resource.required && resource.status !== "verified")
        .map((resource) => resource.name)
    }
  };
}
