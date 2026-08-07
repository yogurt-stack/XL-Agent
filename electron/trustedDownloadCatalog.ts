import {
  trustedCatalogMetadata,
  trustedResources
} from "./generatedTrustedDownloadCatalog";

export type TrustedDownloadMetadata = {
  url: string;
  expectedSha256: string | null;
  digestPolicy?:
    | "preverified"
    | "record-after-download"
    | "lockfile-integrity";
  expectedIntegrity?: {
    algorithm: "sha512";
    digestBase64: string;
  };
  maxSizeMb: number;
  allowedHosts: string[];
};

export type TrustedCatalogStatus = "active" | "not-yet-valid" | "expired" | "invalid";

export { trustedCatalogMetadata };

export type TrustedSignatureMetadata = {
  signatureType: "authenticode" | "upstream-release" | "none";
  expectedPublisher?: string;
  signatureEnforcement: "required" | "checksum-only" | "not-applicable";
};

export type TrustedResourceMetadata = {
  catalogStatus: "active" | "deprecated" | "revoked";
  statusReason?: string;
  replacedBy?: string;
  verification: TrustedSignatureMetadata;
  download: TrustedDownloadMetadata;
};

export function getTrustedCatalogStatus(now = new Date()): TrustedCatalogStatus {
  const generatedAt = Date.parse(trustedCatalogMetadata.generatedAt);
  const expiresAt = Date.parse(trustedCatalogMetadata.expiresAt);
  const current = now.getTime();
  if (!Number.isFinite(current) || !Number.isFinite(generatedAt) || !Number.isFinite(expiresAt)) {
    return "invalid";
  }
  if (current < generatedAt) return "not-yet-valid";
  if (current >= expiresAt) return "expired";
  return "active";
}

export function getTrustedDownloadMetadata(
  resourceId: string,
  now = new Date()
): TrustedDownloadMetadata | null {
  return getTrustedResourceMetadata(resourceId, now)?.download ?? null;
}

export function getTrustedResourceMetadata(
  resourceId: string,
  now = new Date()
): TrustedResourceMetadata | null {
  if (getTrustedCatalogStatus(now) !== "active") return null;
  const metadata = trustedResources[resourceId];
  if (!metadata || metadata.catalogStatus !== "active") return null;
  return {
    ...metadata,
    verification: { ...metadata.verification },
    download: {
      ...metadata.download,
      allowedHosts: [...metadata.download.allowedHosts]
    }
  };
}
