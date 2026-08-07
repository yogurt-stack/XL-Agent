export type DownloadArtifactVerificationStatus =
  | "downloaded"
  | "verified"
  | "local-verified"
  | "test-fixture";

export type DownloadArtifactSignatureStatus =
  | "pending"
  | "valid"
  | "invalid"
  | "unsigned"
  | "unavailable"
  | "not-applicable";

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
  signatureStatus: DownloadArtifactSignatureStatus;
  expectedPublisher: string | null;
  actualPublisher: string | null;
  certificateThumbprint: string | null;
  signatureMessage: string | null;
  signatureCheckedAt: string | null;
};
