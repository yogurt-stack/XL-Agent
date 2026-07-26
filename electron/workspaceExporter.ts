import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  createDefaultWorkspaceTemplateRegistry,
  type WorkspaceTemplateRegistry
} from "../src/features/agent-core/workspaceTemplates";
import type { WorkspaceGuide } from "../src/features/agent-core/domainSkills";
import type { DownloadArtifactRecord } from "./downloadArtifacts";
import type { LocalArtifactRecord } from "./localArtifacts";

export type WorkspaceFileRecord = {
  relativePath: string;
  absolutePath: string;
  bytesWritten: number;
  sha256: string;
};

export type WorkspaceExportOutput = {
  taskId: string;
  revision: number;
  rootPath: string;
  generatedAt: string;
  reusedExisting: boolean;
  files: WorkspaceFileRecord[];
};

export type WorkspaceExportError = {
  code:
    | "WORKSPACE_EXPORT_NOT_READY"
    | "WORKSPACE_EXPORT_INVALID_STATE"
    | "WORKSPACE_EXPORT_ARTIFACT_MISSING"
    | "WORKSPACE_EXPORT_ARTIFACT_INVALID"
    | "WORKSPACE_EXPORT_CONFLICT"
    | "WORKSPACE_EXPORT_WRITE_FAILED";
  message: string;
  retriable: boolean;
};

export type WorkspaceSnapshot = {
  taskId: string;
  task: string;
  phase: string;
  revision: number;
  approvedRevision: number | null;
  route: string | null;
  routeDecision?: unknown;
  systemProfile: unknown;
  taskRequirements: unknown;
  planValidation: unknown;
  resources: Array<{
    id: string;
    name: string;
    version: string;
    publisher?: string;
    source: string;
    purpose?: string;
    recommendation?: string;
    sizeMb: number;
    license: string;
    status: string;
    selected: boolean;
    attempts: number;
    replacedFrom?: string;
    failureReason?: string;
    download?: {
      expectedSha256?: string;
    };
  }>;
  localArtifacts: Array<{
    artifactId: string;
    fileName: string;
    displayPath: string;
    bytesWritten: number;
    sha256: string;
    matchedResourceId: string | null;
    verificationStatus: "local-verified" | "unverified";
    importedAt: string;
  }>;
  agentRun: {
    toolResults: unknown[];
    policyAudit: unknown[];
  };
  workspace: {
    nextAction: string;
  };
};

export type WorkspaceExportOptions = {
  workspaceRoot: string;
  downloadArtifacts?: DownloadArtifactRecord[];
  localArtifacts?: LocalArtifactRecord[];
  templateRegistry?: WorkspaceTemplateRegistry;
  workspaceGuide?: WorkspaceGuide;
  allowTestFixtures?: boolean;
  now?: () => Date;
  beforeCommit?: (stagingRoot: string) => Promise<void> | void;
};

type ManifestArtifact = {
  relativePath: string;
  fileName: string;
  bytesWritten: number;
  sha256: string;
  expectedSha256: string;
  sourceHost: string;
  verificationStatus: DownloadArtifactRecord["verificationStatus"];
  verifiedAt: string;
};

type ResourceWorkspaceManifest = {
  schemaVersion: "xunlei-agent-workspace-2.0";
  taskId: string;
  revision: number;
  task: string;
  route: string | null;
  routeDecision: unknown;
  systemProfile: unknown;
  taskRequirements: unknown;
  planValidation: unknown;
  approvedRevision: number;
  mode: "electron-controlled-export";
  generatedAt: string;
  resources: Array<{
    id: string;
    replacedFrom: string | null;
    name: string;
    version: string;
    publisher: string | null;
    source: string;
    purpose: string | null;
    recommendation: string | null;
    sizeMb: number;
    license: string;
    status: string;
    selected: boolean;
    attempts: number;
    failureReason: string | null;
    artifact: ManifestArtifact | null;
  }>;
  localArtifacts: Array<{
    artifactId: string;
    fileName: string;
    displayPath: string;
    relativePath: string | null;
    bytesWritten: number;
    sha256: string;
    matchedResourceId: string | null;
    verificationStatus: "local-verified" | "unverified";
    importedAt: string;
  }>;
  audit: {
    toolResults: unknown[];
    policyDecisions: unknown[];
  };
  handoff: {
    ready: true;
    files: string[];
    nextAction: string;
    missingItems: string[];
  };
};

export class WorkspaceExportRequestError extends Error {
  constructor(readonly detail: WorkspaceExportError) {
    super(detail.message);
    this.name = "WorkspaceExportRequestError";
  }
}

function exportError(
  code: WorkspaceExportError["code"],
  message: string,
  retriable: boolean
) {
  return new WorkspaceExportRequestError({ code, message, retriable });
}

export function toWorkspaceExportError(error: unknown): WorkspaceExportError {
  if (error instanceof WorkspaceExportRequestError) return error.detail;
  return {
    code: "WORKSPACE_EXPORT_WRITE_FAILED",
    message: error instanceof Error ? error.message : "工作区交接包写入失败。",
    retriable: true
  };
}

const documentFiles = [
  "resource-manifest.json",
  "RESOURCE_MANIFEST.md",
  "README.md",
  "AGENTS.md",
  "scripts/bootstrap.ps1",
  "scripts/verify-environment.ps1"
] as const;

function sanitizeSegment(value: string) {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 100);
  return safe || "task";
}

function sanitizeFileName(value: string) {
  const safe = path.basename(value)
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 160);
  return safe || "artifact.download";
}

function safeRelativePath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  return (
    normalized.length > 0 &&
    !path.posix.isAbsolute(normalized) &&
    !normalized.split("/").includes("..")
  );
}

function sha256Of(content: string | Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

async function sha256File(filePath: string) {
  return new Promise<{ bytesWritten: number; sha256: string }>(
    (resolve, reject) => {
      const hash = createHash("sha256");
      let bytesWritten = 0;
      const stream = createReadStream(filePath);
      stream.on("data", (chunk: string | Buffer) => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        bytesWritten += buffer.byteLength;
        hash.update(buffer);
      });
      stream.on("error", reject);
      stream.on("end", () =>
        resolve({ bytesWritten, sha256: hash.digest("hex") })
      );
    }
  );
}

function validateSnapshot(snapshot: WorkspaceSnapshot) {
  if (
    !snapshot.taskId ||
    !snapshot.task.trim() ||
    !Number.isInteger(snapshot.revision) ||
    snapshot.revision <= 0 ||
    snapshot.approvedRevision !== snapshot.revision ||
    !Array.isArray(snapshot.resources) ||
    !snapshot.agentRun ||
    !Array.isArray(snapshot.agentRun.toolResults) ||
    !Array.isArray(snapshot.agentRun.policyAudit)
  ) {
    throw exportError(
      "WORKSPACE_EXPORT_INVALID_STATE",
      "工作区导出请求缺少合法的任务、revision 或审计状态。",
      false
    );
  }
  if (
    snapshot.phase !== "exporting" ||
    snapshot.resources.some(
      (resource) => resource.selected && resource.status !== "verified"
    )
  ) {
    throw exportError(
      "WORKSPACE_EXPORT_NOT_READY",
      "只有全部选中资源验证完成的当前审批 revision 才能导出。",
      false
    );
  }
}

function sanitizeToolAudit(value: unknown) {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  return {
    callId: typeof item.callId === "string" ? item.callId : null,
    tool: typeof item.tool === "string" ? item.tool : null,
    status: typeof item.status === "string" ? item.status : null,
    error:
      typeof item.error === "object" && item.error !== null
        ? {
            code:
              typeof (item.error as Record<string, unknown>).code === "string"
                ? (item.error as Record<string, unknown>).code
                : null,
            message:
              typeof (item.error as Record<string, unknown>).message === "string"
                ? (item.error as Record<string, unknown>).message
                : null
          }
        : null
  };
}

function sanitizePolicyAudit(value: unknown) {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  const decision =
    typeof item.decision === "object" && item.decision !== null
      ? item.decision as Record<string, unknown>
      : {};
  return {
    actionId: typeof item.actionId === "string" ? item.actionId : null,
    outcome: typeof decision.outcome === "string" ? decision.outcome : null,
    risk: typeof decision.risk === "string" ? decision.risk : null,
    reason: typeof decision.reason === "string" ? decision.reason : null
  };
}

async function copyVerifiedArtifacts(
  snapshot: WorkspaceSnapshot,
  artifacts: DownloadArtifactRecord[],
  stagingRoot: string,
  taskRoot: string,
  allowTestFixtures: boolean
) {
  const selectedResources = snapshot.resources.filter(
    (resource) => resource.selected
  );
  const byResourceId = new Map(
    artifacts
      .filter(
        (artifact) =>
          artifact.taskId === snapshot.taskId &&
          artifact.revision === snapshot.revision
      )
      .map((artifact) => [artifact.resourceId, artifact])
  );
  const manifestArtifacts = new Map<string, ManifestArtifact>();
  const fileRecords: WorkspaceFileRecord[] = [];

  for (const resource of selectedResources) {
    const artifact = byResourceId.get(resource.id);
    if (!artifact) {
      throw exportError(
        "WORKSPACE_EXPORT_ARTIFACT_MISSING",
        `SQLite 中缺少资源 ${resource.id} 在 revision r${snapshot.revision} 的已验证下载记录。`,
        false
      );
    }
    if (
      artifact.verificationStatus !== "verified" &&
      artifact.verificationStatus !== "local-verified" &&
      !(allowTestFixtures && artifact.verificationStatus === "test-fixture")
    ) {
      throw exportError(
        "WORKSPACE_EXPORT_ARTIFACT_INVALID",
        `资源 ${resource.id} 的下载记录未通过生产校验。`,
        false
      );
    }
    const sourceInfo = await lstat(artifact.tempFilePath);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw exportError(
        "WORKSPACE_EXPORT_ARTIFACT_INVALID",
        `资源 ${resource.id} 的临时下载物不是普通文件。`,
        false
      );
    }
    const relativePath = path.posix.join(
      "downloads",
      `${sanitizeSegment(resource.id)}-${sanitizeFileName(artifact.fileName)}`
    );
    const stagingPath = path.join(stagingRoot, relativePath);
    await mkdir(path.dirname(stagingPath), { recursive: true });
    await copyFile(artifact.tempFilePath, stagingPath);
    const actual = await sha256File(stagingPath);
    const fixtureMismatch =
      allowTestFixtures && artifact.verificationStatus === "test-fixture";
    if (
      !fixtureMismatch &&
      (actual.sha256.toLowerCase() !== artifact.expectedSha256.toLowerCase() ||
        actual.sha256.toLowerCase() !== artifact.sha256.toLowerCase() ||
        actual.bytesWritten !== artifact.bytesWritten)
    ) {
      throw exportError(
        "WORKSPACE_EXPORT_ARTIFACT_INVALID",
        `资源 ${resource.id} 在工作区写入前的大小或 SHA256 复核失败。`,
        false
      );
    }
    const manifestArtifact: ManifestArtifact = {
      relativePath,
      fileName: artifact.fileName,
      bytesWritten: actual.bytesWritten,
      sha256: actual.sha256,
      expectedSha256: artifact.expectedSha256.toLowerCase(),
      sourceHost: artifact.sourceHost,
      verificationStatus: artifact.verificationStatus,
      verifiedAt: artifact.verifiedAt
    };
    manifestArtifacts.set(resource.id, manifestArtifact);
    fileRecords.push({
      relativePath,
      absolutePath: path.join(taskRoot, relativePath),
      bytesWritten: actual.bytesWritten,
      sha256: actual.sha256
    });
  }

  return { manifestArtifacts, fileRecords };
}

async function copyAdditionalLocalArtifacts(
  artifacts: LocalArtifactRecord[],
  stagingRoot: string,
  taskRoot: string
) {
  const manifestArtifacts: ResourceWorkspaceManifest["localArtifacts"] = [];
  const fileRecords: WorkspaceFileRecord[] = [];
  for (const artifact of artifacts) {
    if (artifact.matchedResourceId) {
      manifestArtifacts.push({
        artifactId: artifact.artifactId,
        fileName: artifact.fileName,
        displayPath: artifact.displayPath,
        relativePath: null,
        bytesWritten: artifact.bytesWritten,
        sha256: artifact.sha256,
        matchedResourceId: artifact.matchedResourceId,
        verificationStatus: artifact.verificationStatus,
        importedAt: artifact.importedAt
      });
      continue;
    }
    const sourceInfo = await lstat(artifact.sourcePath);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw exportError(
        "WORKSPACE_EXPORT_ARTIFACT_INVALID",
        `本地资源 ${artifact.displayPath} 不再是普通文件。`,
        false
      );
    }
    const relativePath = path.posix.join(
      "local-resources",
      `${sanitizeSegment(artifact.artifactId)}-${sanitizeFileName(artifact.fileName)}`
    );
    const stagingPath = path.join(stagingRoot, relativePath);
    await mkdir(path.dirname(stagingPath), { recursive: true });
    await copyFile(artifact.sourcePath, stagingPath);
    const actual = await sha256File(stagingPath);
    if (
      actual.sha256.toLowerCase() !== artifact.sha256.toLowerCase() ||
      actual.bytesWritten !== artifact.bytesWritten
    ) {
      throw exportError(
        "WORKSPACE_EXPORT_ARTIFACT_INVALID",
        `本地资源 ${artifact.displayPath} 在导出前发生变化。`,
        false
      );
    }
    manifestArtifacts.push({
      artifactId: artifact.artifactId,
      fileName: artifact.fileName,
      displayPath: artifact.displayPath,
      relativePath,
      bytesWritten: actual.bytesWritten,
      sha256: actual.sha256,
      matchedResourceId: null,
      verificationStatus: artifact.verificationStatus,
      importedAt: artifact.importedAt
    });
    fileRecords.push({
      relativePath,
      absolutePath: path.join(taskRoot, relativePath),
      ...actual
    });
  }
  return { manifestArtifacts, fileRecords };
}

function createManifest(
  snapshot: WorkspaceSnapshot,
  generatedAt: string,
  manifestArtifacts: Map<string, ManifestArtifact>,
  localArtifacts: ResourceWorkspaceManifest["localArtifacts"]
): ResourceWorkspaceManifest {
  const resources = snapshot.resources.map((resource) => ({
    id: resource.id,
    replacedFrom: resource.replacedFrom ?? null,
    name: resource.name,
    version: resource.version,
    publisher: resource.publisher ?? null,
    source: resource.source,
    purpose: resource.purpose ?? null,
    recommendation: resource.recommendation ?? null,
    sizeMb: resource.sizeMb,
    license: resource.license,
    status: resource.status,
    selected: resource.selected,
    attempts: resource.attempts,
    failureReason: resource.failureReason ?? null,
    artifact: manifestArtifacts.get(resource.id) ?? null
  }));
  const downloadFiles = [...manifestArtifacts.values()].map(
    (artifact) => artifact.relativePath
  );
  return {
    schemaVersion: "xunlei-agent-workspace-2.0",
    taskId: snapshot.taskId,
    revision: snapshot.revision,
    task: snapshot.task,
    route: snapshot.route,
    routeDecision: snapshot.routeDecision ?? null,
    systemProfile: snapshot.systemProfile,
    taskRequirements: snapshot.taskRequirements,
    planValidation: snapshot.planValidation,
    approvedRevision: snapshot.revision,
    mode: "electron-controlled-export",
    generatedAt,
    resources,
    localArtifacts,
    audit: {
      toolResults: snapshot.agentRun.toolResults.map(sanitizeToolAudit),
      policyDecisions: snapshot.agentRun.policyAudit.map(sanitizePolicyAudit)
    },
    handoff: {
      ready: true,
      files: [
        ...documentFiles,
        ...downloadFiles,
        ...localArtifacts.flatMap((artifact) =>
          artifact.relativePath ? [artifact.relativePath] : []
        )
      ],
      nextAction: "先核对 Manifest revision 与 downloads/ 校验信息，再按 README.md 人工处理资源。",
      missingItems: []
    }
  };
}

function renderResourceManifest(manifest: ResourceWorkspaceManifest) {
  const resourceRows = manifest.resources
    .filter((resource) => resource.selected)
    .map(
      (resource) =>
        `| ${resource.name} | ${resource.version} | ${resource.source} | ${resource.status} | ${resource.artifact?.relativePath ?? "缺失"} | ${resource.artifact?.sha256 ?? "缺失"} |`
    )
    .join("\n");
  return `# Resource Manifest r${manifest.revision}\n\n生成时间：${manifest.generatedAt}\n\n| 资源 | 版本 | 来源 | 状态 | 工作区文件 | SHA256 |\n| --- | --- | --- | --- | --- | --- |\n${resourceRows}\n`;
}

function createArtifacts(
  manifest: ResourceWorkspaceManifest,
  templateRegistry: WorkspaceTemplateRegistry,
  workspaceGuide?: WorkspaceGuide
) {
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const skillId =
    manifest.route === "user-provided-links"
      ? "user-provided-links"
      : manifest.route ?? "ai-development-environment";
  const template =
    templateRegistry.resolve(skillId) ??
    templateRegistry.resolve("ai-development-environment");
  if (!template) {
    throw exportError(
      "WORKSPACE_EXPORT_INVALID_STATE",
      `没有支持 ${skillId} 的 Workspace Template。`,
      false
    );
  }
  const context = {
    skillId,
    manifestJson,
    title:
      workspaceGuide?.title ??
      `${manifest.taskRequirements && typeof manifest.taskRequirements === "object" && "label" in manifest.taskRequirements ? String((manifest.taskRequirements as { label: unknown }).label) : "资源准备"}工作区`,
    summary:
      workspaceGuide?.summary ??
      `任务“${manifest.task}”的资源已按 Manifest r${manifest.revision} 写入 downloads/。当前状态只代表资源已准备，不代表软件已安装。`,
    nextActions:
      workspaceGuide?.nextActions ?? [
        "核对 resource-manifest.json 中每个 artifact 的相对路径与 SHA256。",
        "按实际需要人工运行安装程序或导入资源。",
        "如需更换来源，返回 Agent 创建并审批新的 plan revision。"
      ]
  };
  return new Map<string, string>([
    ["resource-manifest.json", template.renderManifest(context)],
    ["RESOURCE_MANIFEST.md", renderResourceManifest(manifest)],
    ["README.md", template.renderReadme(context)],
    [
      "AGENTS.md",
      template.renderAgents?.(context) ??
        "先读取 resource-manifest.json，再判断资源状态。\n"
    ],
    [
      "scripts/bootstrap.ps1",
      `Set-StrictMode -Version Latest\n$ErrorActionPreference = "Stop"\nWrite-Host "Workspace handoff r${manifest.revision} is ready."\nWrite-Host "No software will be installed automatically. Review resource-manifest.json first."\n`
    ],
    [
      "scripts/verify-environment.ps1",
      `Set-StrictMode -Version Latest\n$ErrorActionPreference = "Stop"\n$Root = Split-Path -Parent $PSScriptRoot\n$Manifest = Get-Content -LiteralPath (Join-Path $Root "resource-manifest.json") -Raw | ConvertFrom-Json\nif ($Manifest.revision -ne ${manifest.revision}) { throw "Manifest revision mismatch." }\nforeach ($Resource in $Manifest.resources | Where-Object { $_.selected }) {\n  $Target = Join-Path $Root $Resource.artifact.relativePath\n  if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { throw "Missing artifact: $Target" }\n  $Actual = (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant()\n  if ($Actual -ne $Resource.artifact.sha256) { throw "SHA256 mismatch: $Target" }\n}\nWrite-Host "Workspace artifacts verified for revision r${manifest.revision}."\n`
    ]
  ]);
}

async function inspectExistingWorkspace(
  targetRoot: string,
  taskId: string,
  revision: number
): Promise<WorkspaceExportOutput | null> {
  try {
    const manifestPath = path.join(targetRoot, "resource-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      taskId?: string;
      revision?: number;
      generatedAt?: string;
      handoff?: { files?: unknown };
    };
    if (
      manifest.taskId !== taskId ||
      manifest.revision !== revision ||
      typeof manifest.generatedAt !== "string" ||
      !Array.isArray(manifest.handoff?.files) ||
      !manifest.handoff.files.every(
        (file): file is string =>
          typeof file === "string" && safeRelativePath(file)
      )
    ) {
      throw exportError(
        "WORKSPACE_EXPORT_CONFLICT",
        "目标工作区已存在，但不属于当前任务 revision 或 Manifest 文件列表无效。",
        false
      );
    }
    const files: WorkspaceFileRecord[] = [];
    for (const relativePath of manifest.handoff.files) {
      const absolutePath = path.join(targetRoot, relativePath);
      const contentInfo = await sha256File(absolutePath);
      files.push({
        relativePath,
        absolutePath,
        ...contentInfo
      });
    }
    return {
      taskId,
      revision,
      rootPath: targetRoot,
      generatedAt: manifest.generatedAt,
      reusedExisting: true,
      files
    };
  } catch (error) {
    if (error instanceof WorkspaceExportRequestError) throw error;
    try {
      await stat(targetRoot);
    } catch {
      return null;
    }
    throw exportError(
      "WORKSPACE_EXPORT_CONFLICT",
      "目标工作区存在但交接文件不完整，未覆盖任何已有文件。",
      false
    );
  }
}

export async function exportWorkspace(
  snapshot: WorkspaceSnapshot,
  options: WorkspaceExportOptions
): Promise<WorkspaceExportOutput> {
  validateSnapshot(snapshot);
  if (!path.isAbsolute(options.workspaceRoot)) {
    throw exportError(
      "WORKSPACE_EXPORT_INVALID_STATE",
      "工作区根目录必须是绝对路径。",
      false
    );
  }

  const taskRoot = path.join(
    options.workspaceRoot,
    sanitizeSegment(snapshot.taskId),
    `revision-${snapshot.revision}`
  );
  const existing = await inspectExistingWorkspace(
    taskRoot,
    snapshot.taskId,
    snapshot.revision
  );
  if (existing) return existing;

  const parentRoot = path.dirname(taskRoot);
  await mkdir(parentRoot, { recursive: true });
  const stagingRoot = await mkdtemp(
    path.join(parentRoot, `.revision-${snapshot.revision}-staging-`)
  );

  try {
    const generatedAt = (options.now?.() ?? new Date()).toISOString();
    const copied = await copyVerifiedArtifacts(
      snapshot,
      options.downloadArtifacts ?? [],
      stagingRoot,
      taskRoot,
      options.allowTestFixtures === true
    );
    const copiedLocal = await copyAdditionalLocalArtifacts(
      options.localArtifacts ?? [],
      stagingRoot,
      taskRoot
    );
    const manifest = createManifest(
      snapshot,
      generatedAt,
      copied.manifestArtifacts,
      copiedLocal.manifestArtifacts
    );
    const artifacts = createArtifacts(
      manifest,
      options.templateRegistry ?? createDefaultWorkspaceTemplateRegistry(),
      options.workspaceGuide
    );
    const documentRecords: WorkspaceFileRecord[] = [];
    for (const relativePath of documentFiles) {
      const content = artifacts.get(relativePath);
      if (content === undefined) {
        throw exportError(
          "WORKSPACE_EXPORT_INVALID_STATE",
          `工作区生成器缺少 ${relativePath}。`,
          false
        );
      }
      const absolutePath = path.join(stagingRoot, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, { encoding: "utf8", flag: "wx" });
      documentRecords.push({
        relativePath,
        absolutePath: path.join(taskRoot, relativePath),
        bytesWritten: Buffer.byteLength(content),
        sha256: sha256Of(content)
      });
    }
    await options.beforeCommit?.(stagingRoot);
    await rename(stagingRoot, taskRoot);
    return {
      taskId: snapshot.taskId,
      revision: snapshot.revision,
      rootPath: taskRoot,
      generatedAt,
      reusedExisting: false,
      files: [
        ...documentRecords,
        ...copied.fileRecords,
        ...copiedLocal.fileRecords
      ]
    };
  } catch (error) {
    await rm(stagingRoot, { force: true, recursive: true });
    if (error instanceof WorkspaceExportRequestError) throw error;
    throw exportError(
      "WORKSPACE_EXPORT_WRITE_FAILED",
      error instanceof Error ? error.message : "工作区交接包写入失败。",
      true
    );
  }
}
