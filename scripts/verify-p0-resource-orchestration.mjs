import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifyRoot = mkdtempSync(path.join(tmpdir(), "xunlei-p0-verify-"));
const tscBin = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc"
);
const compilation = spawnSync(
  tscBin,
  ["-p", path.join("electron", "tsconfig.json")],
  { cwd: root, stdio: "inherit" }
);
if (compilation.status !== 0) process.exit(compilation.status ?? 1);

const require = createRequire(import.meta.url);
const { TaskStore } = require(
  path.join(root, "dist-electron", "electron", "taskStore.js")
);
const { LocalXunleiAdapter } = require(
  path.join(root, "dist-electron", "electron", "xunleiAdapter.js")
);
const { scanLocalArtifacts } = require(
  path.join(root, "dist-electron", "electron", "localArtifacts.js")
);
const { ElectronArtifactVerifier } = require(
  path.join(root, "dist-electron", "electron", "artifactVerifier.js")
);
const {
  writeCurrentManifestSnapshot
} = require(
  path.join(root, "dist-electron", "electron", "manifestSnapshots.js")
);
const { WorkspaceInspectorAgent } = require(
  path.join(root, "dist-electron", "electron", "agentB.js")
);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const deferred = () => {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const artifactPayload = Buffer.from("P0 verified resource payload");
const artifactSha256 = sha256(artifactPayload);
const artifactPath = path.join(verifyRoot, "resource.bin");
writeFileSync(artifactPath, artifactPayload);

function createResource(id, status, overrides = {}) {
  return {
    id,
    name: id === "required-ready" ? "已准备资源" : "缺失资源",
    version: "1.0.0",
    publisher: "P0 Verification",
    source: "downloads.example.test",
    homepage: "https://downloads.example.test",
    releasePage: "https://downloads.example.test/releases",
    sizeMb: 1,
    license: "Verification-only",
    purpose: "P0 verification",
    recommendation: "Trusted fixture",
    required: true,
    dependsOn: [],
    provides: ["workspace-template"],
    requiresCapabilities: [],
    supportedOperatingSystems: ["Windows 11"],
    supportedArchitectures: ["x64"],
    sourceTrust: "trusted-catalog",
    catalogStatus: "active",
    verification: {
      checksumAlgorithm: "sha256",
      checksumSource: "pinned-repository-snapshot",
      checksumSourceUrl: "https://downloads.example.test/checksums",
      signatureType: "none",
      signatureEnforcement: "not-applicable"
    },
    download: {
      url: `https://downloads.example.test/${id}.bin`,
      expectedSha256: artifactSha256,
      maxSizeMb: 1,
      allowedHosts: ["downloads.example.test"]
    },
    selected: true,
    status,
    progress: status === "verified" ? 100 : 0,
    attempts: 1,
    ...overrides
  };
}

function createState(overrides = {}) {
  const resources = overrides.resources ?? [
    createResource("required-ready", "verified")
  ];
  return {
    taskId: "task-manifest-agent-b",
    phase: "awaiting_failure_action",
    revision: 2,
    task: "验证 P0 本地资源编排",
    route: "ai-development-environment",
    routeDecision: {
      status: "supported",
      reason: "verification",
      skillId: "ai-development-environment",
      sourceProviderId: "trusted-catalog",
      userLinks: [],
      resourceIds: resources.map((resource) => resource.id),
      clarifications: [],
      requirements: {
        intent: "base-development",
        label: "P0 verification",
        requiredCapabilities: ["workspace-template"]
      }
    },
    systemProfile: {
      os: "Windows 11",
      architecture: "x64",
      shell: "PowerShell 7",
      workspaceRoot: "C:\\XunleiAgent\\ai-dev-env-windows"
    },
    hostProfile: null,
    clarifications: [],
    clarificationIndex: 0,
    answers: {},
    resources,
    localArtifacts: [],
    replanReason: null,
    requestedReplanStrategy: null,
    activeResourceId: null,
    logs: [],
    workspace: {
      ready: false,
      files: [
        "resource-manifest.json",
        "RESOURCE_MANIFEST.md",
        "README.md",
        "AGENTS.md"
      ],
      nextAction: "处理失败资源。",
      exportStatus: "not_started",
      manifestRevision: 0,
      overallStatus: "partially_ready",
      fileRecords: []
    },
    planExplanation: "P0 verification",
    taskRequirements: {
      intent: "base-development",
      label: "P0 verification",
      requiredCapabilities: ["workspace-template"]
    },
    planValidation: {
      valid: true,
      checkedRevision: 2,
      issues: []
    },
    approvedRevision: 2,
    agentRun: {
      step: 0,
      maxSteps: 6,
      status: "executing",
      decisions: [],
      toolResults: [],
      policyAudit: []
    },
    agentB: {
      status: "idle",
      runId: null,
      grantId: null,
      manifestRevision: null,
      answer: null,
      error: null
    },
    ...overrides,
    resources
  };
}

const databasePath = path.join(verifyRoot, "agent-tasks.sqlite");
let clockMs = Date.parse("2026-07-26T08:00:00.000Z");
let store;

try {
  store = await TaskStore.open({
    databasePath,
    now: () => clockMs
  });

  const firstProgress = deferred();
  const continuePausedDownload = deferred();
  const enteredPauseGate = deferred();
  const cancelStarted = deferred();
  const progressEvents = [];
  const adapter = new LocalXunleiAdapter({
    store,
    now: () => new Date((clockMs += 1_000)),
    onProgress: (progress) => progressEvents.push(progress),
    performDownload: async (resourceId, metadata, options) => {
      if (resourceId === "cancel-resource") {
        cancelStarted.resolve();
        await new Promise((resolve) =>
          options.signal.addEventListener("abort", resolve, { once: true })
        );
        return {
          ok: false,
          error: {
            code: "DOWNLOAD_CANCELLED",
            message: "cancelled by P0 verification",
            retriable: false
          }
        };
      }
      await options.onProgress({
        resourceId,
        bytesWritten: 25,
        totalBytes: 100,
        progress: 25,
        speedBytesPerSecond: 50,
        etaSeconds: 1.5,
        tempFilePath: artifactPath,
        etag: "\"p0-etag\"",
        lastModified: null,
        resumeCapable: true,
        resumedFromBytes: 0
      });
      firstProgress.resolve();
      await continuePausedDownload.promise;
      enteredPauseGate.resolve();
      await options.waitIfPaused();
      await options.onProgress({
        resourceId,
        bytesWritten: 100,
        totalBytes: 100,
        progress: 100,
        speedBytesPerSecond: 50,
        etaSeconds: 0,
        tempFilePath: artifactPath,
        etag: "\"p0-etag\"",
        lastModified: null,
        resumeCapable: true,
        resumedFromBytes: 0
      });
      return {
        ok: true,
        output: {
          resourceId,
          fileName: `${resourceId}.bin`,
          urlHost: new URL(metadata.url).host,
          bytesWritten: artifactPayload.byteLength,
          sha256: artifactSha256,
          tempFilePath: artifactPath,
          elapsedMs: 2_000,
          resumedFromBytes: 0
        }
      };
    }
  });
  const downloadMetadata = {
    url: "https://downloads.example.test/resource.bin",
    expectedSha256: artifactSha256,
    maxSizeMb: 1,
    allowedHosts: ["downloads.example.test"]
  };

  const activeDownload = adapter.createDownloadTask({
    taskId: "task-download-control",
    revision: 1,
    resourceId: "stream-resource",
    metadata: downloadMetadata
  });
  await firstProgress.promise;
  assert(
    await adapter.pause("task-download-control", 1, "stream-resource"),
    "Active downloads must be pausable"
  );
  assert(
    (await store.listDownloadTasks("task-download-control", 1))[0]?.status ===
      "paused",
    "Paused state must persist in download_tasks"
  );
  continuePausedDownload.resolve();
  await enteredPauseGate.promise;
  assert(
    await adapter.resume("task-download-control", 1, "stream-resource"),
    "Paused downloads must be resumable"
  );
  const completedDownload = await activeDownload;
  assert(completedDownload.ok, "Resumed download must complete");
  const completedRecord = (
    await store.listDownloadTasks("task-download-control", 1)
  )[0];
  assert(
    completedRecord?.status === "completed" &&
      completedRecord.progress === 100 &&
      progressEvents.some((event) => event.status === "completed"),
    "Download completion and progress must persist"
  );

  const cancelledDownload = adapter.createDownloadTask({
    taskId: "task-download-control",
    revision: 1,
    resourceId: "cancel-resource",
    metadata: downloadMetadata
  });
  await cancelStarted.promise;
  assert(
    await adapter.cancel(
      "task-download-control",
      1,
      "cancel-resource"
    ),
    "Active downloads must be cancellable"
  );
  const cancelledResult = await cancelledDownload;
  assert(
    !cancelledResult.ok &&
      cancelledResult.error.code === "DOWNLOAD_CANCELLED" &&
      (await store.listDownloadTasks("task-download-control", 1)).some(
        (record) =>
          record.resourceId === "cancel-resource" &&
          record.status === "cancelled"
      ),
    "Cancelled downloads must persist a terminal reason"
  );

  await store.recordDownloadTask({
    taskId: "task-restart-recovery",
    revision: 1,
    resourceId: "restart-resource",
    status: "downloading",
    progress: 48,
    bytesWritten: 48,
    totalBytes: 100,
    speedBytesPerSecond: 10,
    etaSeconds: 5,
    tempFilePath: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(clockMs).toISOString(),
    updatedAt: new Date(clockMs).toISOString()
  });
  await store.close();
  store = await TaskStore.open({
    databasePath,
    now: () => clockMs
  });
  const interrupted = (
    await store.listDownloadTasks("task-restart-recovery", 1)
  )[0];
  assert(
    interrupted?.status === "interrupted" &&
      interrupted.errorCode === "APPLICATION_RESTARTED" &&
      interrupted.bytesWritten === 48,
    "Restart must preserve progress and mark active downloads interrupted"
  );

  const localRoot = path.join(verifyRoot, "selected-local");
  const nestedRoot = path.join(localRoot, "nested");
  mkdirSync(nestedRoot, { recursive: true });
  writeFileSync(path.join(localRoot, "notes.txt"), "local notes");
  writeFileSync(path.join(nestedRoot, "model.bin"), "local model");
  const localArtifacts = await scanLocalArtifacts([localRoot], {
    taskId: "task-manifest-agent-b",
    planRevision: 1,
    now: () => new Date("2026-07-26T08:10:00.000Z"),
    createId: () => "p0local"
  });
  assert(
    localArtifacts.length === 2 &&
      localArtifacts.every(
        (artifact) =>
          artifact.verificationStatus === "unverified" &&
          artifact.matchedResourceId === null &&
          artifact.displayPath.startsWith("selected-local")
      ),
    "Selected local directories must be recursively hashed without exposing them as trusted matches"
  );
  let localLimitRejected = false;
  try {
    await scanLocalArtifacts([localRoot], {
      taskId: "task-limit",
      planRevision: 1,
      maxFiles: 1
    });
  } catch (error) {
    localLimitRejected = error?.code === "LOCAL_RESOURCE_LIMIT_EXCEEDED";
  }
  assert(localLimitRejected, "Local resource file limits must be enforced");

  const verifierState = createState({
    taskId: "task-real-verifier",
    phase: "verifying",
    revision: 1,
    approvedRevision: 1,
    resources: [
      createResource("required-ready", "downloaded", {
        progress: 100
      })
    ],
    workspace: {
      ready: false,
      files: [],
      nextAction: "verify",
      exportStatus: "not_started",
      manifestRevision: 0,
      overallStatus: "preparing",
      fileRecords: []
    }
  });
  await store.recordDownloadArtifact({
    taskId: verifierState.taskId,
    revision: 1,
    resourceId: "required-ready",
    fileName: "resource.bin",
    sourceHost: "downloads.example.test",
    tempFilePath: artifactPath,
    bytesWritten: artifactPayload.byteLength,
    sha256: artifactSha256,
    expectedSha256: artifactSha256,
    verificationStatus: "downloaded",
    verifiedAt: "2026-07-26T08:11:00.000Z",
    signatureStatus: "not-applicable",
    expectedPublisher: null,
    actualPublisher: null,
    certificateThumbprint: null,
    signatureMessage: null,
    signatureCheckedAt: null
  });
  const verifier = new ElectronArtifactVerifier(store);
  const verifiedEvent = await verifier.verify(verifierState);
  assert(
    verifiedEvent?.type === "VERIFY_RESOURCES" &&
      !verifiedEvent.failure &&
      (
        await store.listDownloadArtifacts(verifierState.taskId, 1)
      )[0]?.verificationStatus === "verified",
    "Production verifier must rehash and promote downloaded artifacts"
  );
  writeFileSync(artifactPath, "tampered payload");
  const tamperedEvent = await verifier.verify(verifierState);
  assert(
    tamperedEvent?.failure?.code === "ARTIFACT_INTEGRITY_MISMATCH",
    "Production verifier must reject file tampering"
  );
  writeFileSync(artifactPath, artifactPayload);

  await store.recordLocalArtifacts(localArtifacts);
  const manifestState = createState({
    resources: [
      createResource("required-ready", "verified"),
      createResource("required-missing", "failed", {
        failureReason: "fixture download failed"
      })
    ]
  });
  await store.saveSnapshot(manifestState);
  await store.recordDownloadArtifact({
    taskId: manifestState.taskId,
    revision: 2,
    resourceId: "required-ready",
    fileName: "resource.bin",
    sourceHost: "downloads.example.test",
    tempFilePath: artifactPath,
    bytesWritten: artifactPayload.byteLength,
    sha256: artifactSha256,
    expectedSha256: artifactSha256,
    verificationStatus: "verified",
    verifiedAt: "2026-07-26T08:12:00.000Z",
    signatureStatus: "not-applicable",
    expectedPublisher: null,
    actualPublisher: null,
    certificateThumbprint: null,
    signatureMessage: null,
    signatureCheckedAt: null
  });
  const manifestRecord = await store.createManifestSnapshotRecord(
    manifestState
  );
  assert(
    manifestRecord.status === "partially_ready" &&
      manifestRecord.manifest.missing.includes("缺失资源") &&
      manifestRecord.manifest.localArtifacts.length === 2,
    "Continuous Manifest must preserve partial status and local artifacts across plan revisions"
  );
  const snapshotRoot = await writeCurrentManifestSnapshot({
    workspaceRoot: path.join(verifyRoot, "workspaces"),
    record: manifestRecord,
    downloadArtifacts: await store.listDownloadArtifacts(
      manifestState.taskId,
      manifestState.revision
    ),
    localArtifacts: await store.listLocalArtifacts(manifestState.taskId)
  });
  await store.setManifestSnapshotRoot(
    manifestState.taskId,
    manifestRecord.manifestRevision,
    snapshotRoot
  );
  const manifestText = readFileSync(
    path.join(snapshotRoot, "resource-manifest.json"),
    "utf8"
  );
  assert(
    existsSync(path.join(snapshotRoot, "RESOURCE_MANIFEST.md")) &&
      existsSync(path.join(snapshotRoot, "README.md")) &&
      existsSync(path.join(snapshotRoot, "AGENTS.md")) &&
      !manifestText.includes(localArtifacts[0].sourcePath),
    "Manifest snapshot must write handoff documents without private source paths"
  );

  let agentClockMs = Date.parse("2026-07-26T08:20:00.000Z");
  let agentId = 0;
  const agentB = new WorkspaceInspectorAgent({
    store,
    now: () => new Date(agentClockMs),
    createId: () => `verify${++agentId}`
  });
  const registration = agentB.getRegistration();
  assert(
    registration.definition.mode === "read-only" &&
      registration.definition.maxSteps === 3 &&
      registration.registeredTools.length === 1 &&
      registration.registeredTools[0] === "inspect_workspace",
    "Agent B must have a bounded read-only loop and an explicit tool registration"
  );
  const firstGrant = agentB.issueGrant(
    manifestState.taskId,
    manifestState.revision
  );
  const firstRun = await agentB.run(firstGrant);
  assert(
    firstRun.answer.integrity === "valid" &&
      firstRun.answer.workspaceStatus === "partially_ready" &&
      firstRun.answer.missingOrFailedResources.includes("缺失资源") &&
      firstRun.answer.forbiddenActions.includes("自动运行安装包"),
    "Agent B must inspect the persisted Manifest through its read-only tool"
  );

  const copiedArtifact = manifestRecord.manifest.resources.find(
    (resource) => resource.id === "required-ready"
  )?.artifact;
  assert(copiedArtifact, "Prepared resource must be present in Manifest");
  writeFileSync(
    path.join(snapshotRoot, copiedArtifact.relativePath),
    "tampered snapshot"
  );
  const tamperRun = await agentB.run(
    agentB.issueGrant(manifestState.taskId, manifestState.revision)
  );
  assert(
    tamperRun.answer.integrity === "invalid",
    "Agent B must detect post-snapshot artifact tampering"
  );

  const expiredGrant = agentB.issueGrant(
    manifestState.taskId,
    manifestState.revision
  );
  agentClockMs += 6 * 60 * 1000;
  let expiredGrantRejected = false;
  try {
    await agentB.run(expiredGrant);
  } catch (error) {
    expiredGrantRejected =
      error instanceof Error && error.message.includes("权限无效或已过期");
  }
  const agentRuns = await store.listAgentBRuns(
    manifestState.taskId,
    manifestState.revision
  );
  assert(
    expiredGrantRejected &&
      agentRuns.filter((record) => record.status === "completed").length === 2 &&
      agentRuns.some((record) => record.status === "failed"),
    "Agent B grants and run outcomes must be bounded and persisted"
  );

  const nextRecord = await store.createManifestSnapshotRecord(manifestState);
  assert(
    nextRecord.manifestRevision === manifestRecord.manifestRevision + 1,
    "Manifest revision must advance independently from plan revision"
  );
  const currentRoot = await writeCurrentManifestSnapshot({
    workspaceRoot: path.join(verifyRoot, "workspaces"),
    record: nextRecord,
    downloadArtifacts: await store.listDownloadArtifacts(
      manifestState.taskId,
      manifestState.revision
    ),
    localArtifacts: await store.listLocalArtifacts(manifestState.taskId)
  });
  assert(
    JSON.parse(
      readFileSync(path.join(currentRoot, "resource-manifest.json"), "utf8")
    ).manifestRevision === nextRecord.manifestRevision &&
      readdirSync(path.dirname(currentRoot)).every(
        (entry) => !entry.includes(".current-staging-")
      ),
    "Current Manifest replacement must be atomic and leave no staging directory"
  );
} finally {
  await store?.close().catch(() => undefined);
  rmSync(verifyRoot, { force: true, recursive: true });
}

console.log(
  "P0 resource orchestration passed: streaming task controls, restart recovery, local intake, real verification, continuous Manifest and Agent B permissions verified"
);
