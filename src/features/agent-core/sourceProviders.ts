import { trustedCatalog } from "./catalog";
import type {
  ResourceCapability,
  TrustedResource
} from "./types";

export type SourceRequirement = {
  capability?: ResourceCapability;
  resourceIds?: string[];
  query?: string;
};

export type ResourceMetadata = Pick<
  TrustedResource,
  | "id"
  | "name"
  | "version"
  | "publisher"
  | "source"
  | "license"
  | "verification"
  | "download"
>;

export interface SourceProvider {
  id: string;
  search(requirement: SourceRequirement): TrustedResource[];
  inspect(resource: TrustedResource): ResourceMetadata;
  resolveUserLinks(links: string[]): TrustedResource[];
}

export class SourceProviderRegistry {
  private readonly providers = new Map<string, SourceProvider>();

  constructor(providers: SourceProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: SourceProvider) {
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(provider.id)) {
      throw new Error(`Source Provider ID 非法：${provider.id}`);
    }
    if (this.providers.has(provider.id)) {
      throw new Error(`Source Provider 已注册：${provider.id}`);
    }
    this.providers.set(provider.id, provider);
    return this;
  }

  get(providerId: string) {
    return this.providers.get(providerId) ?? null;
  }

  list() {
    return [...this.providers.values()];
  }
}

function normalizedUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export class TrustedCatalogSourceProvider implements SourceProvider {
  readonly id = "trusted-catalog";

  search(requirement: SourceRequirement) {
    const requestedIds = new Set(requirement.resourceIds ?? []);
    const query = requirement.query?.normalize("NFKC").toLowerCase().trim();
    return trustedCatalog
      .filter((resource) => resource.catalogStatus === "active")
      .filter((resource) => {
        if (requestedIds.size > 0) return requestedIds.has(resource.id);
        if (requirement.capability) {
          return resource.provides.includes(requirement.capability);
        }
        if (!query) return false;
        return [
          resource.id,
          resource.name,
          resource.purpose,
          resource.recommendation
        ]
          .join(" ")
          .normalize("NFKC")
          .toLowerCase()
          .includes(query);
      })
      .map((resource) => structuredClone(resource));
  }

  inspect(resource: TrustedResource): ResourceMetadata {
    return {
      id: resource.id,
      name: resource.name,
      version: resource.version,
      publisher: resource.publisher,
      source: resource.source,
      license: resource.license,
      verification: structuredClone(resource.verification),
      download: structuredClone(resource.download)
    };
  }

  resolveUserLinks(links: string[]) {
    const normalizedLinks = links.map(normalizedUrl);
    if (
      normalizedLinks.some((link) => link === null) ||
      new Set(normalizedLinks).size !== links.length
    ) {
      return [];
    }
    const resourcesByUrl = new Map(
      trustedCatalog
        .filter((resource) => resource.catalogStatus === "active")
        .map((resource) => [normalizedUrl(resource.download.url), resource])
    );
    const resolved = normalizedLinks.flatMap((link) => {
      const resource = link ? resourcesByUrl.get(link) : undefined;
      return resource ? [structuredClone(resource)] : [];
    });
    return resolved.length === links.length ? resolved : [];
  }
}

export function createDefaultSourceProviderRegistry() {
  return new SourceProviderRegistry([
    new TrustedCatalogSourceProvider()
  ]);
}
