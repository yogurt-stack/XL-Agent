export type DownloadArtifactVerificationStatus =
  | "verified"
  | "test-fixture";

export type DownloadArtifactRecord = {
  taskId: string;
  revision: number;
  resourceId: string;
  fileName: string;
  sourceHost: string;
  tempFilePath: string;
  bytesWritten: number;
  sha256: string;
  expectedSha256: string;
  verificationStatus: DownloadArtifactVerificationStatus;
  verifiedAt: string;
};
