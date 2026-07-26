import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "catalog", "trusted-resources.json");
const schemaPath = path.join(root, "catalog", "trusted-resources.schema.json");
const rendererOutputPath = path.join(
  root,
  "src",
  "features",
  "agent-core",
  "generatedTrustedCatalog.ts"
);
const electronOutputPath = path.join(root, "electron", "generatedTrustedDownloadCatalog.ts");
const checkOnly = process.argv.includes("--check");

const allowedCapabilities = new Set([
  "python-runtime",
  "code-editor",
  "source-control",
  "node-runtime",
  "powershell-runtime",
  "workspace-template"
]);
const allowedSourceTrust = new Set(["official", "trusted-catalog", "trusted-mirror"]);
const allowedChecksumSources = new Set([
  "vendor-manifest",
  "github-release-asset-digest",
  "pinned-repository-snapshot"
]);
const allowedSignatureTypes = new Set(["authenticode", "upstream-release", "none"]);

function fail(message) {
  throw new Error(`Trusted catalog validation failed: ${message}`);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function expectExactKeys(value, allowedKeys, label) {
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  expect(unknownKeys.length === 0, `${label} contains unknown key(s): ${unknownKeys.join(", ")}`);
}

function expectHttpsUrl(value, label) {
  expect(isNonEmptyString(value), `${label} must be a non-empty string`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be a valid URL`);
  }
  expect(parsed.protocol === "https:", `${label} must use HTTPS`);
  expect(!parsed.username && !parsed.password, `${label} must not contain credentials`);
  return parsed;
}

function expectStringArray(value, label, { minItems = 0 } = {}) {
  expect(Array.isArray(value), `${label} must be an array`);
  expect(value.length >= minItems, `${label} must contain at least ${minItems} item(s)`);
  expect(value.every(isNonEmptyString), `${label} must contain non-empty strings`);
  expect(new Set(value).size === value.length, `${label} must not contain duplicates`);
}

function expectPositiveNumber(value, label) {
  expect(typeof value === "number" && Number.isFinite(value) && value > 0, `${label} must be positive`);
}

function validateResourceShape(resource, index) {
  const label = `resources[${index}]`;
  expect(resource && typeof resource === "object" && !Array.isArray(resource), `${label} must be an object`);
  expectExactKeys(
    resource,
    [
      "id",
      "name",
      "version",
      "publisher",
      "source",
      "homepage",
      "releasePage",
      "sizeMb",
      "license",
      "purpose",
      "recommendation",
      "required",
      "dependsOn",
      "provides",
      "requiresCapabilities",
      "supportedOperatingSystems",
      "supportedArchitectures",
      "sourceTrust",
      "catalogStatus",
      "verification",
      "download",
      "fallbackId"
    ],
    label
  );
  expect(
    typeof resource.id === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(resource.id),
    `${label}.id is invalid`
  );

  for (const key of [
    "name",
    "version",
    "publisher",
    "source",
    "license",
    "purpose",
    "recommendation"
  ]) {
    expect(isNonEmptyString(resource[key]), `${label}.${key} must be a non-empty string`);
  }

  expectHttpsUrl(resource.homepage, `${label}.homepage`);
  expectHttpsUrl(resource.releasePage, `${label}.releasePage`);
  expectPositiveNumber(resource.sizeMb, `${label}.sizeMb`);
  expect(typeof resource.required === "boolean", `${label}.required must be boolean`);
  expectStringArray(resource.dependsOn, `${label}.dependsOn`);
  expectStringArray(resource.provides, `${label}.provides`, { minItems: 1 });
  expectStringArray(resource.requiresCapabilities, `${label}.requiresCapabilities`);
  expectStringArray(resource.supportedOperatingSystems, `${label}.supportedOperatingSystems`, {
    minItems: 1
  });
  expectStringArray(resource.supportedArchitectures, `${label}.supportedArchitectures`, {
    minItems: 1
  });
  expect(
    [...resource.provides, ...resource.requiresCapabilities].every((value) =>
      allowedCapabilities.has(value)
    ),
    `${label} contains an unsupported capability`
  );
  expect(
    resource.supportedOperatingSystems.every((value) => value === "Windows 11"),
    `${label} contains an unsupported operating system`
  );
  expect(
    resource.supportedArchitectures.every((value) => value === "x64"),
    `${label} contains an unsupported architecture`
  );
  expect(allowedSourceTrust.has(resource.sourceTrust), `${label}.sourceTrust is invalid`);
  expect(resource.catalogStatus === "active", `${label}.catalogStatus must be active`);

  const verification = resource.verification;
  expect(
    verification && typeof verification === "object" && !Array.isArray(verification),
    `${label}.verification must be an object`
  );
  expectExactKeys(
    verification,
    [
      "checksumAlgorithm",
      "checksumSource",
      "checksumSourceUrl",
      "signatureType",
      "expectedPublisher",
      "signatureEnforcement"
    ],
    `${label}.verification`
  );
  expect(
    verification.checksumAlgorithm === "sha256",
    `${label}.verification.checksumAlgorithm must be sha256`
  );
  expect(
    allowedChecksumSources.has(verification.checksumSource),
    `${label}.verification.checksumSource is invalid`
  );
  expectHttpsUrl(
    verification.checksumSourceUrl,
    `${label}.verification.checksumSourceUrl`
  );
  expect(
    allowedSignatureTypes.has(verification.signatureType),
    `${label}.verification.signatureType is invalid`
  );
  if (verification.signatureType === "none") {
    expect(
      verification.signatureEnforcement === "not-applicable",
      `${label} without a signature must use not-applicable enforcement`
    );
  } else {
    expect(
      verification.signatureEnforcement === "planned",
      `${label} signature enforcement must be explicitly marked planned`
    );
    expect(
      isNonEmptyString(verification.expectedPublisher),
      `${label}.verification.expectedPublisher is required`
    );
  }

  const download = resource.download;
  expect(
    download && typeof download === "object" && !Array.isArray(download),
    `${label}.download must be an object`
  );
  expectExactKeys(
    download,
    ["url", "expectedSha256", "maxSizeMb", "allowedHosts"],
    `${label}.download`
  );
  const downloadUrl = expectHttpsUrl(download.url, `${label}.download.url`);
  expect(
    typeof download.expectedSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(download.expectedSha256),
    `${label}.download.expectedSha256 must be lowercase SHA256`
  );
  expectPositiveNumber(download.maxSizeMb, `${label}.download.maxSizeMb`);
  expect(
    download.maxSizeMb >= resource.sizeMb,
    `${label}.download.maxSizeMb must cover the declared resource size`
  );
  expectStringArray(download.allowedHosts, `${label}.download.allowedHosts`, { minItems: 1 });
  expect(
    download.allowedHosts.includes(downloadUrl.host),
    `${label}.download.allowedHosts must include the initial URL host`
  );
  expect(
    download.allowedHosts.every((host) => /^[a-z0-9.-]+$/.test(host)),
    `${label}.download.allowedHosts contains an invalid host`
  );
}

function validateCatalog(catalog) {
  expect(catalog && typeof catalog === "object" && !Array.isArray(catalog), "root must be an object");
  expectExactKeys(
    catalog,
    ["$schema", "schemaVersion", "catalogVersion", "generatedAt", "expiresAt", "resources"],
    "root"
  );
  expect(catalog.$schema === "./trusted-resources.schema.json", "$schema path is invalid");
  expect(catalog.schemaVersion === 1, "schemaVersion must be 1");
  expect(
    typeof catalog.catalogVersion === "string" &&
      /^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$/.test(catalog.catalogVersion),
    "catalogVersion is invalid"
  );
  const generatedAt = Date.parse(catalog.generatedAt);
  const expiresAt = Date.parse(catalog.expiresAt);
  expect(Number.isFinite(generatedAt), "generatedAt must be an ISO timestamp");
  expect(Number.isFinite(expiresAt), "expiresAt must be an ISO timestamp");
  expect(expiresAt > generatedAt, "expiresAt must be later than generatedAt");
  expect(
    expiresAt - generatedAt <= 370 * 24 * 60 * 60 * 1000,
    "catalog validity must not exceed 370 days"
  );
  expect(Array.isArray(catalog.resources) && catalog.resources.length > 0, "resources must not be empty");

  catalog.resources.forEach(validateResourceShape);
  const byId = new Map();
  for (const resource of catalog.resources) {
    expect(!byId.has(resource.id), `duplicate resource ID: ${resource.id}`);
    byId.set(resource.id, resource);
  }

  for (const resource of catalog.resources) {
    for (const dependencyId of resource.dependsOn) {
      expect(dependencyId !== resource.id, `${resource.id} cannot depend on itself`);
      expect(byId.has(dependencyId), `${resource.id} has unknown dependency ${dependencyId}`);
    }
    if (!resource.fallbackId) continue;
    expect(resource.fallbackId !== resource.id, `${resource.id} cannot fall back to itself`);
    const fallback = byId.get(resource.fallbackId);
    expect(fallback, `${resource.id} has unknown fallback ${resource.fallbackId}`);
    expect(
      resource.provides.every((capability) => fallback.provides.includes(capability)),
      `${resource.id} fallback does not preserve capabilities`
    );
  }
}

function generatedHeader(sourceSha256) {
  return `// Generated by scripts/generate-trusted-catalog.mjs from catalog/trusted-resources.json.\n// Source SHA256: ${sourceSha256}. Do not edit by hand.\n`;
}

function renderRendererCatalog(catalog, sourceSha256) {
  const metadata = {
    schemaVersion: catalog.schemaVersion,
    catalogVersion: catalog.catalogVersion,
    generatedAt: catalog.generatedAt,
    expiresAt: catalog.expiresAt,
    sourceSha256
  };
  return `${generatedHeader(sourceSha256)}
import type { TrustedCatalogMetadata, TrustedResource } from "./types";

export const trustedCatalogMetadata: TrustedCatalogMetadata = ${JSON.stringify(metadata, null, 2)};

export const trustedCatalog: TrustedResource[] = ${JSON.stringify(catalog.resources, null, 2)};
`;
}

function renderElectronCatalog(catalog, sourceSha256) {
  const metadata = {
    schemaVersion: catalog.schemaVersion,
    catalogVersion: catalog.catalogVersion,
    generatedAt: catalog.generatedAt,
    expiresAt: catalog.expiresAt,
    sourceSha256
  };
  const downloads = Object.fromEntries(
    catalog.resources.map((resource) => [resource.id, resource.download])
  );
  return `${generatedHeader(sourceSha256)}
export type GeneratedTrustedDownloadMetadata = {
  url: string;
  expectedSha256: string;
  maxSizeMb: number;
  allowedHosts: string[];
};

export const trustedCatalogMetadata = ${JSON.stringify(metadata, null, 2)};

export const trustedDownloads: Record<string, GeneratedTrustedDownloadMetadata> = ${JSON.stringify(downloads, null, 2)};
`;
}

function checkOrWrite(filePath, expected) {
  if (checkOnly) {
    const actual = readFileSync(filePath, "utf8");
    expect(actual === expected, `${path.relative(root, filePath)} is out of date; run npm run generate:catalog`);
    return;
  }
  writeFileSync(filePath, expected);
}

const rawCatalog = readFileSync(catalogPath, "utf8");
JSON.parse(readFileSync(schemaPath, "utf8"));
const catalog = JSON.parse(rawCatalog);
validateCatalog(catalog);
const sourceSha256 = createHash("sha256").update(rawCatalog).digest("hex");

checkOrWrite(rendererOutputPath, renderRendererCatalog(catalog, sourceSha256));
checkOrWrite(electronOutputPath, renderElectronCatalog(catalog, sourceSha256));

console.log(
  `${checkOnly ? "Verified" : "Generated"} trusted catalog ${catalog.catalogVersion} (${catalog.resources.length} resources, SHA256 ${sourceSha256.slice(0, 12)}…).`
);
