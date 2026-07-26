import {
  trustedCatalogMetadata,
  trustedDownloads
} from "./generatedTrustedDownloadCatalog";

export type TrustedDownloadMetadata = {
  url: string;
  expectedSha256: string;
  maxSizeMb: number;
  allowedHosts: string[];
};

export type TrustedCatalogStatus = "active" | "not-yet-valid" | "expired" | "invalid";

export { trustedCatalogMetadata };

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
  if (getTrustedCatalogStatus(now) !== "active") return null;
  const metadata = trustedDownloads[resourceId];
  if (!metadata) return null;
  return { ...metadata, allowedHosts: [...metadata.allowedHosts] };
}
