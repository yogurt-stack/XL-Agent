import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import type { AgentVerifier } from "../src/features/agent-core/interfaces";
import type { AgentEvent, AgentState } from "../src/features/agent-core/types";
import type { DownloadArtifactRecord } from "./downloadArtifacts";
import type { TaskStore } from "./taskStore";

async function hashFile(filePath: string) {
  return new Promise<{ sha256: string; bytesWritten: number }>(
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
        resolve({ sha256: hash.digest("hex"), bytesWritten })
      );
    }
  );
}

function failure(
  resourceId: string,
  code: string,
  reason: string,
  retriable: boolean
): Extract<AgentEvent, { type: "VERIFY_RESOURCES" }> {
  return {
    type: "VERIFY_RESOURCES",
    failure: { resourceId, code, reason, retriable }
  };
}

export class ElectronArtifactVerifier implements AgentVerifier {
  constructor(
    private readonly store: TaskStore,
    private readonly allowTestFixtures = false
  ) {}

  async verify(
    state: AgentState
  ): Promise<Extract<AgentEvent, { type: "VERIFY_RESOURCES" }> | null> {
    if (state.phase !== "verifying") return null;
    const artifacts = await this.store.listDownloadArtifacts(
      state.taskId,
      state.revision
    );
    const byResourceId = new Map(
      artifacts.map((artifact) => [artifact.resourceId, artifact])
    );

    for (const resource of state.resources.filter(
      (candidate) => candidate.selected
    )) {
      const artifact = byResourceId.get(resource.id);
      if (!artifact) {
        return failure(
          resource.id,
          "ARTIFACT_MISSING",
          "SQLite 中没有该资源的下载制品记录。",
          true
        );
      }
      const validation = await this.validateArtifact(resource, artifact);
      if (validation) return validation;
      if (artifact.verificationStatus === "downloaded") {
        await this.store.updateDownloadArtifactVerification(
          state.taskId,
          state.revision,
          resource.id,
          "verified",
          new Date().toISOString()
        );
      }
    }

    return { type: "VERIFY_RESOURCES" };
  }

  private async validateArtifact(
    resource: AgentState["resources"][number],
    artifact: DownloadArtifactRecord
  ) {
    if (
      artifact.verificationStatus === "test-fixture" &&
      this.allowTestFixtures
    ) {
      return null;
    }
    if (
      artifact.verificationStatus !== "downloaded" &&
      artifact.verificationStatus !== "verified" &&
      artifact.verificationStatus !== "local-verified"
    ) {
      return failure(
        resource.id,
        "ARTIFACT_STATUS_INVALID",
        "下载制品尚未进入可验证状态。",
        false
      );
    }
    try {
      const info = await lstat(artifact.tempFilePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        return failure(
          resource.id,
          "ARTIFACT_NOT_REGULAR_FILE",
          "制品不是普通文件或已经被符号链接替换。",
          false
        );
      }
      const actual = await hashFile(artifact.tempFilePath);
      const expected = resource.download.expectedSha256.toLowerCase();
      if (
        actual.bytesWritten !== artifact.bytesWritten ||
        actual.sha256.toLowerCase() !== artifact.sha256.toLowerCase() ||
        actual.sha256.toLowerCase() !== expected
      ) {
        return failure(
          resource.id,
          "ARTIFACT_INTEGRITY_MISMATCH",
          "文件大小或 SHA256 与可信资源计划不一致。",
          true
        );
      }
      if (
        artifact.sourceHost !== "local-user" &&
        !resource.download.allowedHosts.includes(artifact.sourceHost)
      ) {
        return failure(
          resource.id,
          "ARTIFACT_SOURCE_MISMATCH",
          "制品来源主机不属于当前资源允许列表。",
          false
        );
      }
      return null;
    } catch (error) {
      return failure(
        resource.id,
        "ARTIFACT_READ_FAILED",
        error instanceof Error ? error.message : "制品读取失败。",
        true
      );
    }
  }
}
