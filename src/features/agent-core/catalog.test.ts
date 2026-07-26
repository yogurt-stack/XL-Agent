import { describe, expect, it } from "vitest";
import {
  getTrustedCatalogStatus,
  trustedCatalog,
  trustedCatalogMetadata
} from "./catalog";

describe("trusted resource catalog", () => {
  it("contains the first production catalog batch without placeholder download hosts", () => {
    expect(trustedCatalog.map((resource) => resource.id)).toEqual(
      expect.arrayContaining([
        "python-312",
        "vscode",
        "git",
        "node-lts",
        "powershell-7",
        "miniforge-py312"
      ])
    );
    expect(
      trustedCatalog.every(
        (resource) =>
          resource.catalogStatus === "active" &&
          resource.download.url.startsWith("https://") &&
          !resource.download.url.includes("downloads.xunlei.example") &&
          resource.download.allowedHosts.includes(new URL(resource.download.url).host)
      )
    ).toBe(true);
  });

  it("preserves capabilities across every declared fallback", () => {
    const byId = new Map(trustedCatalog.map((resource) => [resource.id, resource]));
    for (const resource of trustedCatalog) {
      if (!resource.fallbackId) continue;
      const fallback = byId.get(resource.fallbackId);
      expect(fallback, `${resource.id} fallback must exist`).toBeDefined();
      expect(
        resource.provides.every((capability) => fallback?.provides.includes(capability))
      ).toBe(true);
    }
  });

  it("fails closed outside the catalog validity window", () => {
    expect(
      getTrustedCatalogStatus(new Date(trustedCatalogMetadata.generatedAt))
    ).toBe("active");
    expect(
      getTrustedCatalogStatus(
        new Date(Date.parse(trustedCatalogMetadata.generatedAt) - 1)
      )
    ).toBe("not-yet-valid");
    expect(
      getTrustedCatalogStatus(new Date(trustedCatalogMetadata.expiresAt))
    ).toBe("expired");
  });
});
