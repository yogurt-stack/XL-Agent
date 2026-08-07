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
import type {
  AgentState,
  WorkspaceOverallStatus
} from "../src/features/agent-core/types";
import type { DownloadArtifactRecord } from "./downloadArtifacts";
import type { LocalArtifactRecord } from "./localArtifacts";
import { trustedCatalogMetadata } from "./trustedDownloadCatalog";

export type ResourceManifestSnapshot = {
  schemaVersion: "xunlei-agent-manifest-3.0";
  taskId: string;
  manifestRevision: number;
  planRevision: number;
  generatedAt: string;
  status: WorkspaceOverallStatus;
  phase: AgentState["phase"];
  task: string;
  route: string | null;
  approvedRevision: number | null;
  catalog: {
    version: string;
    sourceSha256: string;
  };
  resources: Array<{
    id: string;
    name: string;
    version: string;
    required: boolean;
    selected: boolean;
    status: string;
    progress: number;
    source: string;
    sourceUrl: string;
    github: AgentState["resources"][number]["github"] | null;
    npm: AgentState["resources"][number]["npm"] | null;
    failureReason: string | null;
    artifact: null | {
      relativePath: string;
      bytesWritten: number;
      sha256: string;
      expectedSha256: string;
      verificationStatus: DownloadArtifactRecord["verificationStatus"];
      signatureStatus: DownloadArtifactRecord["signatureStatus"];
      expectedPublisher: string | null;
      actualPublisher: string | null;
      certificateThumbprint: string | null;
      signatureCheckedAt: string | null;
    };
  }>;
  localArtifacts: Array<{
    artifactId: string;
    fileName: string;
    displayPath: string;
    relativePath: string | null;
    bytesWritten: number;
    sha256: string;
    matchedResourceId: string | null;
    verificationStatus: LocalArtifactRecord["verificationStatus"];
  }>;
  localRepository: AgentState["localRepository"];
  githubPublish?: AgentState["githubPublish"];
  missing: string[];
  nextActions: string[];
  allowedActions: string[];
  forbiddenActions: string[];
};

export type ManifestSnapshotRecord = {
  taskId: string;
  manifestRevision: number;
  planRevision: number;
  status: WorkspaceOverallStatus;
  manifest: ResourceManifestSnapshot;
  rootPath: string | null;
  generatedAt: string;
};

function sanitizeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 100) || "task";
}

function sanitizeFileName(value: string) {
  return (
    path
      .basename(value)
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-")
      .replace(/^\.+/, "")
      .slice(0, 160) || "artifact.download"
  );
}

function downloadRelativePath(
  artifact: DownloadArtifactRecord,
  kind: "download" | "source" | "npm" = "download"
) {
  return path.posix.join(
    kind === "source"
      ? "sources"
      : kind === "npm"
        ? "dependencies/npm"
        : "downloads",
    `${sanitizeSegment(artifact.resourceId)}-${sanitizeFileName(artifact.fileName)}`
  );
}

function localRelativePath(artifact: LocalArtifactRecord) {
  return path.posix.join(
    "local-resources",
    `${sanitizeSegment(artifact.artifactId)}-${sanitizeFileName(artifact.fileName)}`
  );
}

export function deriveWorkspaceStatus(
  state: AgentState
): WorkspaceOverallStatus {
  if (state.workspace.ready) return "ready";
  const selected = state.resources.filter((resource) => resource.selected);
  const prepared = selected.filter(
    (resource) =>
      resource.status === "downloaded" || resource.status === "verified"
  );
  const missing = selected.filter(
    (resource) =>
      resource.status === "failed" ||
      resource.status === "skipped" ||
      !resource.selected
  );
  if (
    state.phase === "unsupported" ||
    state.phase === "cancelled" ||
    (state.phase === "handoff" && prepared.length === 0)
  ) {
    return "failed";
  }
  if (
    missing.length > 0 ||
    (state.phase === "handoff" && !state.workspace.ready)
  ) {
    return prepared.length > 0 ? "partially_ready" : "failed";
  }
  return "preparing";
}

export function createManifestSnapshot(input: {
  state: AgentState;
  manifestRevision: number;
  generatedAt: string;
  downloadArtifacts: DownloadArtifactRecord[];
  localArtifacts: LocalArtifactRecord[];
}): ResourceManifestSnapshot {
  const artifactByResource = new Map(
    input.downloadArtifacts.map((artifact) => [
      artifact.resourceId,
      artifact
    ])
  );
  const resources = input.state.resources.map((resource) => {
    const artifact = artifactByResource.get(resource.id);
    return {
      id: resource.id,
      name: resource.name,
      version: resource.version,
      required: resource.required,
      selected: resource.selected,
      status: resource.status,
      progress: resource.progress,
      source: resource.source,
      sourceUrl: resource.download.url,
      github: resource.github ?? null,
      npm: resource.npm ?? null,
      failureReason: resource.failureReason ?? null,
      artifact: artifact
        ? {
            relativePath: downloadRelativePath(
              artifact,
              resource.github ? "source" : resource.npm ? "npm" : "download"
            ),
            bytesWritten: artifact.bytesWritten,
            sha256: artifact.sha256,
            expectedSha256: artifact.expectedSha256,
            verificationStatus: artifact.verificationStatus,
            signatureStatus: artifact.signatureStatus,
            expectedPublisher: artifact.expectedPublisher,
            actualPublisher: artifact.actualPublisher,
            certificateThumbprint: artifact.certificateThumbprint,
            signatureCheckedAt: artifact.signatureCheckedAt
          }
        : null
    };
  });
  const localArtifacts = input.localArtifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    fileName: artifact.fileName,
    displayPath: artifact.displayPath,
    relativePath: artifact.matchedResourceId
      ? null
      : localRelativePath(artifact),
    bytesWritten: artifact.bytesWritten,
    sha256: artifact.sha256,
    matchedResourceId: artifact.matchedResourceId,
    verificationStatus: artifact.verificationStatus
  }));
  const missing = resources
    .filter(
      (resource) =>
        resource.required &&
        resource.selected &&
        resource.status !== "verified"
    )
    .map((resource) => resource.name);
  const status = deriveWorkspaceStatus(input.state);
  return {
    schemaVersion: "xunlei-agent-manifest-3.0",
    taskId: input.state.taskId,
    manifestRevision: input.manifestRevision,
    planRevision: input.state.revision,
    generatedAt: input.generatedAt,
    status,
    phase: input.state.phase,
    task: input.state.task,
    route: input.state.route,
    approvedRevision: input.state.approvedRevision,
    catalog: {
      version: trustedCatalogMetadata.catalogVersion,
      sourceSha256: trustedCatalogMetadata.sourceSha256
    },
    resources,
    localArtifacts,
    localRepository: input.state.localRepository,
    githubPublish: input.state.githubPublish,
    missing,
    nextActions: [input.state.workspace.nextAction],
    allowedActions:
      input.state.localRepository
        ? ["读取仓库元数据", "核对 Git 状态", "生成独立的 GitHub 发布计划"]
        : status === "ready"
          ? ["核对校验信息", "人工处理已下载资源"]
        : ["读取当前 Manifest", "处理失败资源", "重新审批替代计划"],
    forbiddenActions: [
      "自动运行安装包",
      "自动执行 Shell 或 PowerShell",
      "把资源已下载描述为软件已安装",
      ...(input.state.localRepository
        ? [
            "修改本地仓库",
            "执行仓库脚本或 Git hooks",
            "未经独立审批发布到 GitHub"
          ]
        : [])
    ]
  };
}

async function hashFile(filePath: string) {
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

async function copyChecked(
  sourcePath: string,
  targetPath: string,
  expectedSha256: string,
  expectedBytes: number,
  allowFixtureMismatch: boolean
) {
  const info = await lstat(sourcePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Manifest snapshot artifact is not a regular file.");
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
  const actual = await hashFile(targetPath);
  if (
    !allowFixtureMismatch &&
    (actual.sha256.toLowerCase() !== expectedSha256.toLowerCase() ||
      actual.bytesWritten !== expectedBytes)
  ) {
    throw new Error("Manifest snapshot artifact integrity check failed.");
  }
}

function renderMarkdown(manifest: ResourceManifestSnapshot) {
  const rows = manifest.resources
    .filter((resource) => resource.selected)
    .map(
      (resource) =>
        `| ${resource.name} | ${resource.status} | ${resource.artifact?.relativePath ?? "缺失"} |`
    )
    .join("\n");
  const repository = manifest.localRepository;
  const repositorySummary = repository
    ? `\n\n## 本地仓库（只读）\n\n- 名称：${repository.displayName}\n- HEAD：${repository.commitSha}\n- 分支：${repository.branch ?? "detached HEAD"}\n- 工作区：${repository.clean ? "clean" : "存在未提交变更"}\n- 文件：${repository.trackedFileCount} 个已跟踪 / ${repository.fileCount} 个可见\n`
    : "";
  const publish = manifest.githubPublish;
  const publishSummary =
    publish && publish.status !== "idle"
      ? `\n\n## GitHub 发布\n\n- 状态：${publish.status}\n- 目标：${publish.plan ? `${publish.plan.targetOwner}/${publish.plan.targetRepository}` : "无"}\n- 结果：${publish.result?.repositoryUrl ?? publish.error ?? "等待后续动作"}\n`
      : "";
  return `# Resource Manifest r${manifest.manifestRevision}\n\n状态：${manifest.status}\n\n| 资源 | 状态 | 文件 |\n| --- | --- | --- |\n${rows}\n${repositorySummary}${publishSummary}`;
}

export async function writeCurrentManifestSnapshot(input: {
  workspaceRoot: string;
  record: ManifestSnapshotRecord;
  downloadArtifacts: DownloadArtifactRecord[];
  localArtifacts: LocalArtifactRecord[];
  allowTestFixtures?: boolean;
}) {
  const parent = path.join(
    input.workspaceRoot,
    sanitizeSegment(input.record.taskId)
  );
  await mkdir(parent, { recursive: true });
  const targetRoot = path.join(parent, "current");
  const stagingRoot = await mkdtemp(path.join(parent, ".current-staging-"));
  const backupRoot = path.join(
    parent,
    `.current-backup-${input.record.manifestRevision}`
  );
  try {
    for (const artifact of input.downloadArtifacts) {
      const manifestResource = input.record.manifest.resources.find(
        (resource) => resource.id === artifact.resourceId
      );
      const relativePath = downloadRelativePath(
        artifact,
        manifestResource?.github
          ? "source"
          : manifestResource?.npm
            ? "npm"
            : "download"
      );
      await copyChecked(
        artifact.tempFilePath,
        path.join(stagingRoot, relativePath),
        artifact.sha256,
        artifact.bytesWritten,
        input.allowTestFixtures === true &&
          artifact.verificationStatus === "test-fixture"
      );
    }
    for (const artifact of input.localArtifacts.filter(
      (candidate) => !candidate.matchedResourceId
    )) {
      await copyChecked(
        artifact.sourcePath,
        path.join(stagingRoot, localRelativePath(artifact)),
        artifact.sha256,
        artifact.bytesWritten,
        false
      );
    }
    const manifestJson = `${JSON.stringify(input.record.manifest, null, 2)}\n`;
    await writeFile(
      path.join(stagingRoot, "resource-manifest.json"),
      manifestJson,
      "utf8"
    );
    await writeFile(
      path.join(stagingRoot, "RESOURCE_MANIFEST.md"),
      renderMarkdown(input.record.manifest),
      "utf8"
    );
    await writeFile(
      path.join(stagingRoot, "README.md"),
      `# ${input.record.manifest.task}\n\n当前 Manifest revision：r${input.record.manifestRevision}\n\n状态：${input.record.status}\n\n${input.record.manifest.nextActions.map((item) => `- ${item}`).join("\n")}\n`,
      "utf8"
    );
    await writeFile(
      path.join(stagingRoot, "AGENTS.md"),
      `# Agent 只读交接\n\n必须先读取 resource-manifest.json，并在回答中注明 Manifest r${input.record.manifestRevision}。\n\n禁止自动安装、执行命令或创建新下载任务。\n`,
      "utf8"
    );
    let hadExisting = false;
    try {
      await stat(targetRoot);
      hadExisting = true;
      await rm(backupRoot, { force: true, recursive: true });
      await rename(targetRoot, backupRoot);
    } catch {
      hadExisting = false;
    }
    try {
      await rename(stagingRoot, targetRoot);
      if (hadExisting) {
        await rm(backupRoot, { force: true, recursive: true }).catch(
          () => undefined
        );
      }
    } catch (error) {
      if (hadExisting) {
        await rename(backupRoot, targetRoot).catch(() => undefined);
      }
      throw error;
    }
    return targetRoot;
  } catch (error) {
    await rm(stagingRoot, { force: true, recursive: true });
    throw error;
  }
}

export async function readManifestFile(rootPath: string) {
  return JSON.parse(
    await readFile(path.join(rootPath, "resource-manifest.json"), "utf8")
  ) as ResourceManifestSnapshot;
}
