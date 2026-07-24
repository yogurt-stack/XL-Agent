import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

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
  systemProfile: unknown;
  taskRequirements: unknown;
  planValidation: unknown;
  resources: Array<{
    id: string;
    name: string;
    version: string;
    source: string;
    sizeMb: number;
    license: string;
    status: string;
    selected: boolean;
    attempts: number;
    replacedFrom?: string;
    failureReason?: string;
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
  now?: () => Date;
  beforeCommit?: (stagingRoot: string) => Promise<void> | void;
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

const exportFiles = [
  "README.md",
  "RESOURCE_MANIFEST.md",
  "AGENTS.md",
  "resource-manifest.json",
  "scripts/bootstrap.ps1",
  "scripts/verify-environment.ps1"
] as const;

function sanitizeSegment(value: string) {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 100);
  return safe || "task";
}

function sha256Of(content: string | Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
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

function createArtifacts(snapshot: WorkspaceSnapshot, generatedAt: string) {
  const resources = snapshot.resources.map((resource) => ({
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
  }));
  const manifest = {
    schemaVersion: "xunlei-agent-workspace-1.0",
    taskId: snapshot.taskId,
    revision: snapshot.revision,
    task: snapshot.task,
    route: snapshot.route,
    systemProfile: snapshot.systemProfile,
    taskRequirements: snapshot.taskRequirements,
    planValidation: snapshot.planValidation,
    approvedRevision: snapshot.approvedRevision,
    mode: "electron-controlled-export",
    generatedAt,
    resources,
    audit: {
      toolResults: snapshot.agentRun.toolResults,
      policyDecisions: snapshot.agentRun.policyAudit
    },
    handoff: {
      ready: true,
      files: [...exportFiles],
      nextAction: "阅读 README.md，再按需运行受控验证脚本。",
      missingItems: []
    }
  };
  const resourceRows = resources
    .filter((resource) => resource.selected)
    .map(
      (resource) =>
        `| ${resource.name} | ${resource.version} | ${resource.source} | ${resource.status} | ${resource.license} |`
    )
    .join("\n");

  return new Map<string, string>([
    ["resource-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
    [
      "README.md",
      `# AI Dev Workspace\n\n任务：${snapshot.task}\n\n计划修订：r${snapshot.revision}\n\n本目录由迅雷 AI Task Agent 在资源下载和校验完成后原子生成。当前阶段不会自动安装软件，也不会自动执行脚本。\n\n## 文件\n\n- \`resource-manifest.json\`：机器可读资源、审批与审计信息。\n- \`RESOURCE_MANIFEST.md\`：面向人工的资源清单。\n- \`AGENTS.md\`：后续 Agent 的受控操作边界。\n- \`scripts/verify-environment.ps1\`：只读检查交接文件是否完整。\n- \`scripts/bootstrap.ps1\`：显示后续人工步骤，不执行安装。\n`
    ],
    [
      "RESOURCE_MANIFEST.md",
      `# Resource Manifest r${snapshot.revision}\n\n生成时间：${generatedAt}\n\n| 资源 | 版本 | 来源 | 状态 | 授权 |\n| --- | --- | --- | --- | --- |\n${resourceRows}\n`
    ],
    [
      "AGENTS.md",
      `# Agent Instructions\n\n- 先读取 \`resource-manifest.json\` 和 \`RESOURCE_MANIFEST.md\`。\n- 不得绕过 revision r${snapshot.revision} 的审批和 Policy 审计。\n- 不得自动执行安装程序、未知脚本或任意 Shell。\n- 如需更换资源来源，必须回到 Agent 生成新 revision 并重新审批。\n`
    ],
    [
      "scripts/bootstrap.ps1",
      `Set-StrictMode -Version Latest\n$ErrorActionPreference = "Stop"\nWrite-Host "Workspace handoff r${snapshot.revision} is ready."\nWrite-Host "No software will be installed automatically. Review resource-manifest.json first."\n`
    ],
    [
      "scripts/verify-environment.ps1",
      `Set-StrictMode -Version Latest\n$ErrorActionPreference = "Stop"\n$Root = Split-Path -Parent $PSScriptRoot\n$Required = @("README.md", "RESOURCE_MANIFEST.md", "AGENTS.md", "resource-manifest.json")\nforeach ($File in $Required) {\n  $Target = Join-Path $Root $File\n  if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) {\n    throw "Missing handoff file: $File"\n  }\n}\nWrite-Host "Workspace handoff files are present for revision r${snapshot.revision}."\n`
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
    };
    if (
      manifest.taskId !== taskId ||
      manifest.revision !== revision ||
      typeof manifest.generatedAt !== "string"
    ) {
      throw exportError(
        "WORKSPACE_EXPORT_CONFLICT",
        "目标工作区已存在，但不属于当前任务 revision。",
        false
      );
    }
    const files: WorkspaceFileRecord[] = [];
    for (const relativePath of exportFiles) {
      const absolutePath = path.join(targetRoot, relativePath);
      const content = await readFile(absolutePath);
      files.push({
        relativePath,
        absolutePath,
        bytesWritten: content.byteLength,
        sha256: sha256Of(content)
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

  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const artifacts = createArtifacts(snapshot, generatedAt);
  const parentRoot = path.dirname(taskRoot);
  await mkdir(parentRoot, { recursive: true });
  const stagingRoot = await mkdtemp(
    path.join(parentRoot, `.revision-${snapshot.revision}-staging-`)
  );

  try {
    const files: WorkspaceFileRecord[] = [];
    for (const relativePath of exportFiles) {
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
      files.push({
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
      files
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
