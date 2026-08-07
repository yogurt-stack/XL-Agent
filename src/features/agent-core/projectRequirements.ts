import type {
  GitHubRepositoryFileOutput,
  GitHubRepositoryTreeOutput,
  LocalRepositoryFileOutput,
  LocalRepositoryTreeOutput,
  ProjectRequirement,
  ProjectRequirementKind,
  ProjectRequirementsOutput
} from "./types";

export type ProjectEvidenceFile = {
  relativePath: string;
  objectId: string;
  content: string;
  bytesRead: number;
  truncated: boolean;
};

const exactEvidenceNames = new Set([
  "package.json",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "pipfile",
  "environment.yml",
  "environment.yaml",
  "cargo.toml",
  "rust-toolchain",
  "rust-toolchain.toml",
  "go.mod",
  "cmakelists.txt",
  "cmakepresets.json",
  "vcpkg.json",
  "conanfile.txt",
  "conanfile.py",
  "meson.build"
]);

const evidenceNamePattern = /^(readme|install|installation|build|building|requirements)(?:[._-].*)?\.(?:md|markdown|rst|txt|toml|ya?ml)$/iu;
const requirementsNamePattern = /^requirements(?:[._-].*)?\.txt$/iu;
const qmakeProjectPattern = /\.(?:pro|pri)$/iu;
const secretLikePathPattern = /(^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|[^/]*\.(?:pem|key|p12|pfx))(?:\/|$)/iu;

function normalizedRelativePath(value: string) {
  return value.replace(/\\/gu, "/").normalize("NFC");
}

export function isSafeRepositoryRelativePath(value: string) {
  const normalized = normalizedRelativePath(value);
  return (
    normalized.length > 0 &&
    normalized.length <= 1_024 &&
    !normalized.startsWith("/") &&
    !normalized.split("/").some((part) => part === "" || part === "." || part === "..") &&
    !normalized.split("/").includes(".git") &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
  );
}

export function isProjectEvidencePath(value: string) {
  if (!isSafeRepositoryRelativePath(value)) return false;
  const normalized = normalizedRelativePath(value);
  if (secretLikePathPattern.test(normalized)) return false;
  const baseName = normalized.split("/").pop()?.toLowerCase() ?? "";
  return exactEvidenceNames.has(baseName) ||
    evidenceNamePattern.test(baseName) ||
    requirementsNamePattern.test(baseName) ||
    qmakeProjectPattern.test(baseName);
}

export function projectEvidencePriority(value: string) {
  const normalized = normalizedRelativePath(value);
  const depth = normalized.split("/").length - 1;
  const baseName = normalized.split("/").pop()?.toLowerCase() ?? "";
  const rank = baseName === "package.json" ||
      baseName === "pyproject.toml" ||
      baseName === "cmakelists.txt" ||
      baseName === "go.mod" ||
      baseName === "cargo.toml"
    ? 0
    : requirementsNamePattern.test(baseName)
      ? 1
      : /^(readme|install|installation|build|building)/iu.test(baseName)
        ? 2
        : 3;
  return rank * 100 + Math.min(depth, 99);
}

function compactEvidence(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}

function requirementId(
  kind: ProjectRequirementKind,
  name: string,
  constraint: string | null,
  sourcePath: string
) {
  const value = `${kind}\0${name.toLowerCase()}\0${constraint ?? ""}\0${sourcePath}`;
  // Stable browser-safe 96-bit identifier; this is an identity key, not a
  // cryptographic integrity digest.
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  let c = 0x85ebca6b;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x27d4eb2d);
    c = Math.imul(c ^ code, 0x165667b1);
  }
  return [a, b, c]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

function createRequirement(input: Omit<ProjectRequirement, "id">): ProjectRequirement {
  const name = compactEvidence(input.name).slice(0, 120);
  const constraint = input.constraint
    ? compactEvidence(input.constraint).slice(0, 160)
    : null;
  return {
    ...input,
    id: requirementId(input.kind, name, constraint, input.sourcePath),
    name,
    constraint,
    evidence: compactEvidence(input.evidence)
  };
}

function pushRequirement(
  output: ProjectRequirement[],
  input: Omit<ProjectRequirement, "id">
) {
  if (!input.name.trim() || !input.evidence.trim() || output.length >= 60) return;
  const candidate = createRequirement(input);
  if (!output.some((item) => item.id === candidate.id)) output.push(candidate);
}

function parsePackageJson(file: ProjectEvidenceFile, output: ProjectRequirement[], warnings: string[]) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content) as unknown;
  } catch {
    warnings.push(`${file.relativePath}: JSON 无法解析。`);
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
  const manifest = parsed as Record<string, unknown>;
  if (typeof manifest.engines === "object" && manifest.engines !== null) {
    for (const [name, constraint] of Object.entries(manifest.engines as Record<string, unknown>)) {
      if (typeof constraint !== "string") continue;
      pushRequirement(output, {
        kind: name.toLowerCase() === "node" ? "runtime" : "tool",
        name,
        constraint,
        sourcePath: file.relativePath,
        evidence: `engines.${name}: ${constraint}`,
        confidence: "explicit"
      });
    }
  }
  if (typeof manifest.packageManager === "string") {
    const [name, ...version] = manifest.packageManager.split("@");
    pushRequirement(output, {
      kind: "package-manager",
      name,
      constraint: version.join("@") || null,
      sourcePath: file.relativePath,
      evidence: `packageManager: ${manifest.packageManager}`,
      confidence: "explicit"
    });
  }
}

function parsePythonRequirements(file: ProjectEvidenceFile, output: ProjectRequirement[]) {
  for (const rawLine of file.content.split(/\r?\n/u).slice(0, 2_000)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || /^-(?:r|e|f|i)\b/iu.test(line) || /:\/\//u.test(line)) continue;
    const withoutMarker = line.split(";")[0].trim();
    const match = withoutMarker.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?\s*(.*)$/u);
    if (!match) continue;
    pushRequirement(output, {
      kind: "framework",
      name: match[1],
      constraint: match[2].trim() || null,
      sourcePath: file.relativePath,
      evidence: line,
      confidence: "explicit"
    });
  }
}

function parsePyproject(file: ProjectEvidenceFile, output: ProjectRequirement[]) {
  const python = file.content.match(/(?:requires-python|python)\s*=\s*["']([^"']+)["']/iu);
  if (python) {
    pushRequirement(output, {
      kind: "runtime",
      name: "Python",
      constraint: python[1],
      sourcePath: file.relativePath,
      evidence: python[0],
      confidence: "explicit"
    });
  }
  const dependencyBlocks = [...file.content.matchAll(/dependencies\s*=\s*\[([\s\S]*?)\]/giu)];
  for (const block of dependencyBlocks.slice(0, 4)) {
    for (const quoted of block[1].matchAll(/["']([^"']+)["']/gu)) {
      const dependency = quoted[1].split(";")[0].trim();
      const match = dependency.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?\s*(.*)$/u);
      if (!match) continue;
      pushRequirement(output, {
        kind: "framework",
        name: match[1],
        constraint: match[2].trim() || null,
        sourcePath: file.relativePath,
        evidence: dependency,
        confidence: "explicit"
      });
    }
  }
}

function parseCmake(file: ProjectEvidenceFile, output: ProjectRequirement[]) {
  const cmake = file.content.match(/cmake_minimum_required\s*\(\s*VERSION\s+([^\s\)]+)/iu);
  if (cmake) {
    pushRequirement(output, {
      kind: "tool",
      name: "CMake",
      constraint: `>=${cmake[1]}`,
      sourcePath: file.relativePath,
      evidence: cmake[0],
      confidence: "explicit"
    });
  }
  for (const match of file.content.matchAll(/find_package\s*\(\s*([A-Za-z0-9_+.-]+)(?:\s+([0-9][^\s\)]*))?([^\)]*)\)/giu)) {
    const packageName = match[1];
    const packageLower = packageName.toLowerCase();
    pushRequirement(output, {
      kind: /^(qt|qt5|qt6)$/u.test(packageLower)
        ? "framework"
        : /^(opencascade|occt)$/u.test(packageLower)
          ? "library"
          : packageLower === "cuda" || packageLower === "cudatoolkit"
            ? "tool"
            : "library",
      name: packageName,
      constraint: match[2] ?? null,
      sourcePath: file.relativePath,
      evidence: match[0],
      confidence: /\bREQUIRED\b/iu.test(match[3]) ? "explicit" : "inferred"
    });
  }
}

function parseGoMod(file: ProjectEvidenceFile, output: ProjectRequirement[]) {
  const match = file.content.match(/^go\s+([^\s]+)$/imu);
  if (!match) return;
  pushRequirement(output, {
    kind: "runtime",
    name: "Go",
    constraint: `>=${match[1]}`,
    sourcePath: file.relativePath,
    evidence: match[0],
    confidence: "explicit"
  });
}

function parseCargo(file: ProjectEvidenceFile, output: ProjectRequirement[]) {
  const match = file.content.match(/^rust-version\s*=\s*["']([^"']+)["']/imu);
  if (!match) return;
  pushRequirement(output, {
    kind: "runtime",
    name: "Rust",
    constraint: `>=${match[1]}`,
    sourcePath: file.relativePath,
    evidence: match[0],
    confidence: "explicit"
  });
}

function parseVcpkg(file: ProjectEvidenceFile, output: ProjectRequirement[], warnings: string[]) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content) as unknown;
  } catch {
    warnings.push(`${file.relativePath}: JSON 无法解析。`);
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
  const dependencies = (parsed as Record<string, unknown>).dependencies;
  if (!Array.isArray(dependencies)) return;
  for (const dependency of dependencies.slice(0, 200)) {
    const name = typeof dependency === "string"
      ? dependency
      : typeof dependency === "object" && dependency !== null &&
          typeof (dependency as Record<string, unknown>).name === "string"
        ? String((dependency as Record<string, unknown>).name)
        : "";
    if (!name) continue;
    const version = typeof dependency === "object" && dependency !== null &&
        typeof (dependency as Record<string, unknown>)["version>="] === "string"
      ? `>=${String((dependency as Record<string, unknown>)["version>="])}`
      : null;
    pushRequirement(output, {
      kind: "library",
      name,
      constraint: version,
      sourcePath: file.relativePath,
      evidence: version ? `${name} ${version}` : name,
      confidence: "explicit"
    });
  }
}

function parseConanRequirements(file: ProjectEvidenceFile, output: ProjectRequirement[]) {
  const section = file.content.match(/\[requires\]([\s\S]*?)(?:\n\s*\[|$)/iu)?.[1];
  if (!section) return;
  for (const rawLine of section.split(/\r?\n/u).slice(0, 200)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_.+-]+)\/([^@#\s]+)/u);
    if (!match) continue;
    pushRequirement(output, {
      kind: "library",
      name: match[1],
      constraint: `=${match[2]}`,
      sourcePath: file.relativePath,
      evidence: line,
      confidence: "explicit"
    });
  }
}

function parseQmake(file: ProjectEvidenceFile, output: ProjectRequirement[]) {
  for (const match of file.content.matchAll(/^\s*QT\s*\+?=\s*(.+)$/gimu)) {
    const modules = match[1].split(/\s+/u).filter(Boolean).slice(0, 50);
    for (const module of modules) {
      pushRequirement(output, {
        kind: "framework",
        name: `Qt ${module}`,
        constraint: null,
        sourcePath: file.relativePath,
        evidence: match[0],
        confidence: "explicit"
      });
    }
  }
}

const readmeRequirementPatterns: Array<{
  pattern: RegExp;
  kind: ProjectRequirementKind;
  name: string | ((match: RegExpMatchArray) => string);
}> = [
  { pattern: /\bPython\s*(?:version\s*)?([><=~^]*\s*v?\d+(?:\.\d+){0,2}(?:\s*(?:or newer|以上|及以上))?)/giu, kind: "runtime", name: "Python" },
  { pattern: /\bNode(?:\.js|JS)?\s*(?:version\s*)?([><=~^]*\s*v?\d+(?:\.\d+){0,2}(?:\s*(?:or newer|以上|及以上))?)/giu, kind: "runtime", name: "Node.js" },
  { pattern: /\bCMake\s*(?:version\s*)?([><=~^]*\s*v?\d+(?:\.\d+){0,2}(?:\s*(?:or newer|以上|及以上))?)/giu, kind: "tool", name: "CMake" },
  { pattern: /\b(Qt(?:5|6)?)\s*(?:version\s*)?([><=~^]*\s*v?\d+(?:\.\d+){0,2})/giu, kind: "framework", name: (match) => match[1] },
  { pattern: /\b(?:OpenCASCADE|OCCT)\s*(?:version\s*)?([><=~^]*\s*v?\d+(?:\.\d+){0,2})/giu, kind: "library", name: "OCCT" },
  { pattern: /\bCUDA\s*(?:Toolkit\s*)?(?:version\s*)?([><=~^]*\s*v?\d+(?:\.\d+){0,2})/giu, kind: "tool", name: "CUDA" }
];

function parseReadme(file: ProjectEvidenceFile, output: ProjectRequirement[]) {
  for (const definition of readmeRequirementPatterns) {
    definition.pattern.lastIndex = 0;
    for (const match of file.content.matchAll(definition.pattern)) {
      const name = typeof definition.name === "function"
        ? definition.name(match)
        : definition.name;
      const constraint = typeof definition.name === "function" && /^Qt/iu.test(name)
        ? match[2]
        : match[1];
      pushRequirement(output, {
        kind: definition.kind,
        name,
        constraint: constraint?.replace(/\s+/gu, " ").trim() || null,
        sourcePath: file.relativePath,
        evidence: match[0],
        confidence: "explicit"
      });
    }
  }
}

export function analyzeProjectRequirementFiles(input: {
  repository: ProjectRequirementsOutput["repository"];
  files: ProjectEvidenceFile[];
}): ProjectRequirementsOutput {
  const requirements: ProjectRequirement[] = [];
  const warnings: string[] = [];
  for (const file of input.files.slice(0, 32)) {
    const baseName = file.relativePath.split("/").pop()?.toLowerCase() ?? "";
    if (baseName === "package.json") parsePackageJson(file, requirements, warnings);
    if (requirementsNamePattern.test(baseName)) parsePythonRequirements(file, requirements);
    if (baseName === "pyproject.toml") parsePyproject(file, requirements);
    if (baseName === "cmakelists.txt") parseCmake(file, requirements);
    if (baseName === "go.mod") parseGoMod(file, requirements);
    if (baseName === "cargo.toml") parseCargo(file, requirements);
    if (baseName === "vcpkg.json") parseVcpkg(file, requirements, warnings);
    if (baseName === "conanfile.txt") parseConanRequirements(file, requirements);
    if (qmakeProjectPattern.test(baseName)) parseQmake(file, requirements);
    if (/^(readme|install|installation|build|building)/iu.test(baseName)) {
      parseReadme(file, requirements);
    }
    if (file.truncated) warnings.push(`${file.relativePath}: 文件超过单文件读取上限，仅分析前缀。`);
  }
  const result: ProjectRequirementsOutput = {
    repository: input.repository,
    inspectedFiles: input.files.slice(0, 32).map((file) => ({
      relativePath: file.relativePath,
      objectId: file.objectId,
      bytesRead: file.bytesRead,
      truncated: file.truncated
    })),
    requirements,
    unresolved: requirements.length === 0
      ? ["未从当前支持的项目清单或说明文件中提取到明确版本要求。"]
      : [],
    warnings: [...new Set(warnings)].slice(0, 100),
    trust: "untrusted-repository-content",
    boundary: "fixed-head-known-project-files-only"
  };
  let removedRequirements = 0;
  let removedFiles = 0;
  while (
    JSON.stringify(result).length > 20_000 &&
    result.requirements.length > 0
  ) {
    result.requirements.pop();
    removedRequirements += 1;
  }
  while (
    JSON.stringify(result).length > 20_000 &&
    result.inspectedFiles.length > 0
  ) {
    result.inspectedFiles.pop();
    removedFiles += 1;
  }
  if (removedRequirements || removedFiles) {
    result.warnings.push(
      `为保持 Agent 观测完整，输出按 20000 字符上限省略 ${removedRequirements} 项要求和 ${removedFiles} 个文件记录。`
    );
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRepositoryIdentity(
  value: unknown,
  includeDisplayName: boolean,
  source: "local" | "github" | "either" = "either"
) {
  const validHandle = typeof (value as Record<string, unknown> | null)?.repositoryHandleId === "string" &&
    (source === "local"
      ? String((value as Record<string, unknown>).repositoryHandleId).startsWith("local-repo-")
      : source === "github"
        ? String((value as Record<string, unknown>).repositoryHandleId).startsWith("github-repo-")
        : /^(?:local|github)-repo-/u.test(String((value as Record<string, unknown>).repositoryHandleId)));
  return isRecord(value) &&
    validHandle &&
    typeof value.commitSha === "string" &&
    /^[a-f0-9]{40,64}$/iu.test(value.commitSha) &&
    (!includeDisplayName || typeof value.displayName === "string");
}

export function isLocalRepositoryTreeOutput(value: unknown): value is LocalRepositoryTreeOutput {
  return isRecord(value) &&
    validRepositoryIdentity(value.repository, true, "local") &&
    typeof value.pathPrefix === "string" &&
    Array.isArray(value.entries) && value.entries.length <= 500 &&
    value.entries.every((entry) => isRecord(entry) &&
      isSafeRepositoryRelativePath(String(entry.relativePath)) &&
      typeof entry.objectId === "string" && /^[a-f0-9]{40,64}$/iu.test(entry.objectId) &&
      Number.isSafeInteger(entry.bytes) && Number(entry.bytes) >= 0) &&
    Number.isSafeInteger(value.totalMatchingEntries) &&
    Number(value.totalMatchingEntries) >= value.entries.length &&
    typeof value.truncated === "boolean" &&
    value.boundary === "fixed-head-tracked-files-only";
}

export function isLocalRepositoryFileOutput(value: unknown): value is LocalRepositoryFileOutput {
  return isRecord(value) &&
    validRepositoryIdentity(value.repository, false, "local") &&
    typeof value.relativePath === "string" && isProjectEvidencePath(value.relativePath) &&
    typeof value.objectId === "string" && /^[a-f0-9]{40,64}$/iu.test(value.objectId) &&
    typeof value.content === "string" && value.content.length <= 96 * 1024 &&
    Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0 &&
    typeof value.truncated === "boolean" &&
    value.trust === "untrusted-repository-content" &&
    value.boundary === "fixed-head-text-evidence-only";
}

export function isGitHubRepositoryTreeOutput(
  value: unknown
): value is GitHubRepositoryTreeOutput {
  return isRecord(value) &&
    validRepositoryIdentity(value.repository, true, "github") &&
    typeof value.pathPrefix === "string" &&
    Array.isArray(value.entries) && value.entries.length <= 500 &&
    value.entries.every((entry) => isRecord(entry) &&
      isSafeRepositoryRelativePath(String(entry.relativePath)) &&
      typeof entry.objectId === "string" && /^[a-f0-9]{40,64}$/iu.test(entry.objectId) &&
      Number.isSafeInteger(entry.bytes) && Number(entry.bytes) >= 0) &&
    Number.isSafeInteger(value.totalMatchingEntries) &&
    Number(value.totalMatchingEntries) >= value.entries.length &&
    typeof value.truncated === "boolean" &&
    value.boundary === "fixed-commit-github-blobs-only";
}

export function isGitHubRepositoryFileOutput(
  value: unknown
): value is GitHubRepositoryFileOutput {
  return isRecord(value) &&
    validRepositoryIdentity(value.repository, false, "github") &&
    typeof value.relativePath === "string" && isProjectEvidencePath(value.relativePath) &&
    typeof value.objectId === "string" && /^[a-f0-9]{40,64}$/iu.test(value.objectId) &&
    typeof value.content === "string" && value.content.length <= 96 * 1024 &&
    Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0 &&
    typeof value.truncated === "boolean" &&
    value.trust === "untrusted-repository-content" &&
    value.boundary === "fixed-commit-github-text-evidence-only";
}

export function isProjectRequirementsOutput(value: unknown): value is ProjectRequirementsOutput {
  return isRecord(value) &&
    validRepositoryIdentity(value.repository, true) &&
    Array.isArray(value.inspectedFiles) && value.inspectedFiles.length <= 32 &&
    Array.isArray(value.requirements) && value.requirements.length <= 200 &&
    value.requirements.every((requirement) => isRecord(requirement) &&
      typeof requirement.id === "string" && /^[a-f0-9]{24}$/u.test(requirement.id) &&
      ["runtime", "tool", "framework", "library", "package-manager", "operating-system"].includes(String(requirement.kind)) &&
      typeof requirement.name === "string" && requirement.name.length > 0 && requirement.name.length <= 120 &&
      (requirement.constraint === null || typeof requirement.constraint === "string") &&
      typeof requirement.sourcePath === "string" && isProjectEvidencePath(requirement.sourcePath) &&
      typeof requirement.evidence === "string" && requirement.evidence.length > 0 && requirement.evidence.length <= 240 &&
      ["explicit", "inferred"].includes(String(requirement.confidence))) &&
    Array.isArray(value.unresolved) && value.unresolved.length <= 100 && value.unresolved.every((item) => typeof item === "string") &&
    Array.isArray(value.warnings) && value.warnings.length <= 100 && value.warnings.every((item) => typeof item === "string") &&
    value.trust === "untrusted-repository-content" &&
    value.boundary === "fixed-head-known-project-files-only";
}
