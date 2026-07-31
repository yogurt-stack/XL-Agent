import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import type { AgentVerifier } from "../src/features/agent-core/interfaces";
import type { AgentEvent, AgentState } from "../src/features/agent-core/types";
import type { DownloadArtifactRecord } from "./downloadArtifacts";
import type { TaskStore } from "./taskStore";
import {
  publisherMatches,
  WindowsAuthenticodeVerifier,
  type AuthenticodeVerifier,
  type AuthenticodeVerificationResult
} from "./authenticodeVerifier";

async function hashFile(filePath: string) {
  return new Promise<{
    sha256: string;
    sha512Base64: string;
    bytesWritten: number;
  }>(
    (resolve, reject) => {
      const sha256 = createHash("sha256");
      const sha512 = createHash("sha512");
      let bytesWritten = 0;
      const stream = createReadStream(filePath);
      stream.on("data", (chunk: string | Buffer) => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        bytesWritten += buffer.byteLength;
        sha256.update(buffer);
        sha512.update(buffer);
      });
      stream.on("error", reject);
      stream.on("end", () =>
        resolve({
          sha256: sha256.digest("hex"),
          sha512Base64: sha512.digest("base64"),
          bytesWritten
        })
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
    private readonly allowTestFixtures = false,
    private readonly signatureVerifier: AuthenticodeVerifier =
      new WindowsAuthenticodeVerifier()
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
      const signatureValidation = await this.validateSignature(
        resource,
        artifact
      );
      if (signatureValidation) return signatureValidation;
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

  private async validateSignature(
    resource: AgentState["resources"][number],
    artifact: DownloadArtifactRecord
  ) {
    if (
      artifact.verificationStatus === "test-fixture" &&
      this.allowTestFixtures
    ) {
      return null;
    }
    const policy = resource.verification;
    if (policy.signatureEnforcement !== "required") {
      await this.store.updateDownloadArtifactSignature(
        artifact.taskId,
        artifact.revision,
        artifact.resourceId,
        {
          status: "not-applicable",
          expectedPublisher: policy.expectedPublisher ?? null,
          actualPublisher: null,
          certificateThumbprint: null,
          message:
            policy.signatureEnforcement === "checksum-only"
              ? "该制品使用上游固定 SHA256 校验，不声明嵌入式 Authenticode。"
              : "该制品不适用嵌入式签名校验。",
          checkedAt: new Date().toISOString()
        }
      );
      return null;
    }

    const result = await this.signatureVerifier.verify(
      artifact.tempFilePath
    );
    await this.persistSignatureResult(artifact, policy.expectedPublisher, result);
    if (result.status !== "valid") {
      return failure(
        resource.id,
        result.status === "unavailable"
          ? "SIGNATURE_VERIFIER_UNAVAILABLE"
          : result.status === "unsigned"
            ? "ARTIFACT_UNSIGNED"
            : "ARTIFACT_SIGNATURE_INVALID",
        result.statusMessage,
        result.status === "unavailable"
      );
    }
    if (
      !policy.expectedPublisher ||
      !publisherMatches(result.publisher, policy.expectedPublisher)
    ) {
      return failure(
        resource.id,
        "ARTIFACT_PUBLISHER_MISMATCH",
        `签名发布者与可信目录不一致：期望 ${policy.expectedPublisher ?? "未声明"}，实际 ${result.publisher ?? "未知"}。`,
        false
      );
    }
    return null;
  }

  private persistSignatureResult(
    artifact: DownloadArtifactRecord,
    expectedPublisher: string | undefined,
    result: AuthenticodeVerificationResult
  ) {
    return this.store.updateDownloadArtifactSignature(
      artifact.taskId,
      artifact.revision,
      artifact.resourceId,
      {
        status: result.status,
        expectedPublisher: expectedPublisher ?? null,
        actualPublisher: result.publisher,
        certificateThumbprint: result.certificateThumbprint,
        message: result.statusMessage,
        checkedAt: result.checkedAt
      }
    );
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
      const expected = resource.download.expectedSha256?.toLowerCase() ?? null;
      if (
        actual.bytesWritten !== artifact.bytesWritten ||
        actual.sha256.toLowerCase() !== artifact.sha256.toLowerCase() ||
        (expected !== null && actual.sha256.toLowerCase() !== expected) ||
        (resource.download.digestPolicy === "lockfile-integrity" &&
          actual.sha512Base64 !==
            resource.download.expectedIntegrity?.digestBase64)
      ) {
        return failure(
          resource.id,
          "ARTIFACT_INTEGRITY_MISMATCH",
          "文件大小、SHA256 或锁文件 SHA512 与可信资源计划不一致。",
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
