import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import {
  createDefaultAgentDefinitionRegistry,
  type AgentDefinition,
  type AgentDefinitionRegistry
} from "../src/features/agent-core/agentRegistry";
import type {
  AgentBInspectionAnswer,
  WorkspaceOverallStatus
} from "../src/features/agent-core/types";
import {
  readManifestFile,
  type ManifestSnapshotRecord,
  type ResourceManifestSnapshot
} from "./manifestSnapshots";
import type { TaskStore } from "./taskStore";

export type WorkspaceReadGrant = {
  grantId: string;
  agentId: "workspace-inspector";
  taskId: string;
  planRevision: number;
  allowedTools: ["inspect_workspace"];
  issuedAt: string;
  expiresAt: string;
};

export type InspectWorkspaceCall = {
  callId: string;
  name: "inspect_workspace";
  input: {
    taskId: string;
    planRevision: number;
    grantId: string;
  };
};

export type WorkspaceInspection = AgentBInspectionAnswer & {
  taskId: string;
  toolCallId: string;
};

type InspectWorkspaceHandler = (
  call: InspectWorkspaceCall,
  grant: WorkspaceReadGrant
) => Promise<WorkspaceInspection>;

class AgentBToolRegistry {
  private readonly handlers = new Map<
    InspectWorkspaceCall["name"],
    InspectWorkspaceHandler
  >();

  register(
    name: InspectWorkspaceCall["name"],
    handler: InspectWorkspaceHandler
  ) {
    if (this.handlers.has(name)) throw new Error(`Agent B Tool 已注册：${name}`);
    this.handlers.set(name, handler);
    return this;
  }

  list() {
    return [...this.handlers.keys()];
  }

  async execute(call: InspectWorkspaceCall, grant: WorkspaceReadGrant) {
    const handler = this.handlers.get(call.name);
    if (!handler) throw new Error(`Agent B Tool 未注册：${call.name}`);
    return handler(call, grant);
  }
}

class AgentBReadOnlyPolicy {
  authorize(
    definition: AgentDefinition,
    call: InspectWorkspaceCall,
    grant: WorkspaceReadGrant,
    now: Date
  ) {
    if (
      definition.mode !== "read-only" ||
      !definition.allowedTools.includes(call.name) ||
      !grant.allowedTools.includes(call.name) ||
      grant.agentId !== definition.id ||
      call.input.grantId !== grant.grantId ||
      call.input.taskId !== grant.taskId ||
      call.input.planRevision !== grant.planRevision ||
      Date.parse(grant.expiresAt) <= now.getTime()
    ) {
      throw new Error("Agent B 的工作区只读权限无效或已过期。");
    }
  }
}

async function hashFile(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) =>
      hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    );
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function safeRelativePath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  return (
    normalized.length > 0 &&
    !path.posix.isAbsolute(normalized) &&
    !normalized.split("/").includes("..")
  );
}

function answerFromManifest(
  manifest: ResourceManifestSnapshot,
  integrity: "valid" | "invalid"
): AgentBInspectionAnswer {
  const preparedRequiredResources = manifest.resources
    .filter(
      (resource) =>
        resource.required &&
        resource.selected &&
        resource.status === "verified"
    )
    .map((resource) => resource.name);
  const missingOrFailedResources = manifest.resources
    .filter(
      (resource) =>
        resource.required &&
        resource.selected &&
        resource.status !== "verified"
    )
    .map((resource) => resource.name);
  return {
    manifestRevision: manifest.manifestRevision,
    planRevision: manifest.planRevision,
    workspaceStatus: manifest.status,
    preparedRequiredResources,
    missingOrFailedResources,
    allowedActions: manifest.allowedActions,
    forbiddenActions: manifest.forbiddenActions,
    integrity,
    summary:
      integrity === "invalid"
        ? `Manifest r${manifest.manifestRevision} 完整性校验失败，不能宣称工作区已就绪。`
        : `Agent B 已读取 Manifest r${manifest.manifestRevision}：${preparedRequiredResources.length} 个必需资源已准备，${missingOrFailedResources.length} 个仍缺失或失败。`
  };
}

export type WorkspaceInspectorAgentOptions = {
  store: TaskStore;
  definitions?: AgentDefinitionRegistry;
  now?: () => Date;
  createId?: () => string;
  allowTestFixtures?: boolean;
};

export class WorkspaceInspectorAgent {
  private readonly definitions: AgentDefinitionRegistry;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly policy = new AgentBReadOnlyPolicy();
  private readonly tools = new AgentBToolRegistry();

  constructor(private readonly options: WorkspaceInspectorAgentOptions) {
    this.definitions =
      options.definitions ?? createDefaultAgentDefinitionRegistry();
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.tools.register("inspect_workspace", (call, grant) =>
      this.inspectWorkspace(call, grant)
    );
  }

  issueGrant(taskId: string, planRevision: number): WorkspaceReadGrant {
    const issuedAt = this.now();
    return {
      grantId: `grant-${this.createId().replace(/[^a-z0-9]/gi, "")}`,
      agentId: "workspace-inspector",
      taskId,
      planRevision,
      allowedTools: ["inspect_workspace"],
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 5 * 60 * 1000).toISOString()
    };
  }

  createRunId() {
    return `agent-b-${this.createId().replace(/[^a-z0-9]/gi, "")}`;
  }

  getRegistration() {
    const definition = this.definitions.get("workspace-inspector");
    if (!definition) throw new Error("Agent B 未注册。");
    return {
      definition,
      registeredTools: this.tools.list()
    };
  }

  async run(grant: WorkspaceReadGrant, requestedRunId?: string) {
    const definition = this.definitions.get(grant.agentId);
    if (!definition) throw new Error("Agent B 未注册。");
    const runId = requestedRunId ?? this.createRunId();
    await this.options.store.startAgentBRun({
      runId,
      taskId: grant.taskId,
      planRevision: grant.planRevision,
      grantId: grant.grantId,
      startedAt: this.now().toISOString()
    });
    try {
      let observation: WorkspaceInspection | null = null;
      for (let step = 0; step < definition.maxSteps; step += 1) {
        if (!observation) {
          const call: InspectWorkspaceCall = {
            callId: `${runId}-step-${step + 1}-inspect`,
            name: "inspect_workspace",
            input: {
              taskId: grant.taskId,
              planRevision: grant.planRevision,
              grantId: grant.grantId
            }
          };
          this.policy.authorize(definition, call, grant, this.now());
          observation = await this.tools.execute(call, grant);
          continue;
        }

        await this.options.store.completeAgentBRun({
          runId,
          manifestRevision: observation.manifestRevision,
          toolResult: observation,
          answer: observation,
          completedAt: this.now().toISOString()
        });
        return { runId, answer: observation };
      }
      throw new Error(
        `Agent B 在 ${definition.maxSteps} 个步骤内没有生成最终检查结论。`
      );
    } catch (error) {
      await this.options.store.failAgentBRun({
        runId,
        errorMessage:
          error instanceof Error ? error.message : "Agent B 检查失败。",
        completedAt: this.now().toISOString()
      });
      throw Object.assign(
        error instanceof Error ? error : new Error("Agent B 检查失败。"),
        { runId }
      );
    }
  }

  private async inspectWorkspace(
    call: InspectWorkspaceCall,
    _grant: WorkspaceReadGrant
  ): Promise<WorkspaceInspection> {
    const record = await this.options.store.getLatestManifestSnapshot(
      call.input.taskId,
      call.input.planRevision
    );
    if (!record?.rootPath) {
      throw new Error("没有找到已落盘的 Manifest snapshot。");
    }
    const fileManifest = await readManifestFile(record.rootPath);
    if (
      fileManifest.taskId !== record.taskId ||
      fileManifest.planRevision !== record.planRevision ||
      fileManifest.manifestRevision !== record.manifestRevision ||
      JSON.stringify(fileManifest) !== JSON.stringify(record.manifest)
    ) {
      const answer = answerFromManifest(record.manifest, "invalid");
      return { ...answer, taskId: record.taskId, toolCallId: call.callId };
    }
    const integrity = await this.verifyManifestFiles(record);
    const answer = answerFromManifest(fileManifest, integrity);
    return { ...answer, taskId: record.taskId, toolCallId: call.callId };
  }

  private async verifyManifestFiles(
    record: ManifestSnapshotRecord
  ): Promise<"valid" | "invalid"> {
    if (!record.rootPath) return "invalid";
    const artifacts = [
      ...record.manifest.resources.flatMap((resource) =>
        resource.artifact
          ? [
              {
                relativePath: resource.artifact.relativePath,
                sha256: resource.artifact.sha256,
                fixture:
                  resource.artifact.verificationStatus === "test-fixture"
              }
            ]
          : []
      ),
      ...record.manifest.localArtifacts.flatMap((artifact) =>
        artifact.relativePath
          ? [
              {
                relativePath: artifact.relativePath,
                sha256: artifact.sha256,
                fixture: false
              }
            ]
          : []
      )
    ];
    for (const artifact of artifacts) {
      if (!safeRelativePath(artifact.relativePath)) return "invalid";
      try {
        const actual = await hashFile(
          path.join(record.rootPath, artifact.relativePath)
        );
        if (
          actual.toLowerCase() !== artifact.sha256.toLowerCase() &&
          !(artifact.fixture && this.options.allowTestFixtures)
        ) {
          return "invalid";
        }
      } catch {
        return "invalid";
      }
    }
    return "valid";
  }
}

export function isWorkspaceStatus(
  value: unknown
): value is WorkspaceOverallStatus {
  return (
    value === "preparing" ||
    value === "ready" ||
    value === "partially_ready" ||
    value === "failed"
  );
}
