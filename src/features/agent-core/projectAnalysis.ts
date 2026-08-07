import type {
  GitHubProjectAnalysis,
  GitHubProjectEcosystem
} from "./types";

const manifestNames = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "cargo.toml",
  "go.mod",
  "cmakelists.txt",
  "cmakepresets.json",
  "vcpkg.json",
  "conanfile.txt",
  "conanfile.py",
  "meson.build"
]);

const lockfileNames = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "uv.lock",
  "poetry.lock",
  "cargo.lock",
  "go.sum"
]);

/**
 * 对 GitHub Tree API 或本地 Git 文件清单执行同一套确定性项目分析。
 * 该函数只读取相对路径，不读取或执行仓库内容。
 */
export function analyzeProjectPaths(
  paths: string[],
  treeTruncated: boolean
): GitHubProjectAnalysis {
  const normalizedPaths = paths
    .map((value) => value.replace(/\\/g, "/"))
    .filter(
      (value) =>
        value.length > 0 &&
        !value.startsWith("/") &&
        !value.split("/").includes("..")
    );
  const manifests = normalizedPaths
    .filter((value) =>
      manifestNames.has(value.split("/").pop()?.toLowerCase() ?? "")
    )
    .slice(0, 200);
  const lockfiles = normalizedPaths
    .filter((value) =>
      lockfileNames.has(value.split("/").pop()?.toLowerCase() ?? "")
    )
    .slice(0, 200);
  const names = new Set(
    [...manifests, ...lockfiles].map(
      (value) => value.split("/").pop()?.toLowerCase() ?? ""
    )
  );
  const ecosystems: GitHubProjectEcosystem[] = [
    ...(names.has("package.json") ? ["node" as const] : []),
    ...(names.has("pyproject.toml") || names.has("requirements.txt")
      ? ["python" as const]
      : []),
    ...(names.has("cargo.toml") ? ["rust" as const] : []),
    ...(names.has("go.mod") ? ["go" as const] : []),
    ...(
      names.has("cmakelists.txt") ||
      names.has("cmakepresets.json") ||
      names.has("vcpkg.json") ||
      names.has("conanfile.txt") ||
      names.has("conanfile.py") ||
      names.has("meson.build")
        ? ["cpp" as const]
        : []
    )
  ];
  if (ecosystems.length === 0) ecosystems.push("unknown");

  return {
    ecosystems,
    manifests,
    lockfiles,
    runtimeHints: ecosystems.flatMap(
      (ecosystem) =>
        ({
          node: ["Node.js（具体版本需读取 package.json engines）"],
          python: ["Python（具体版本需读取 pyproject.toml）"],
          rust: ["Rust toolchain"],
          go: ["Go toolchain"],
          cpp: ["C/C++ toolchain（具体编译器、CMake、Qt 与库版本需读取项目文件）"],
          unknown: ["未识别到受支持的结构化项目清单"]
        })[ecosystem]
    ),
    nodeOfflinePreparation:
      names.has("package-lock.json") || names.has("npm-shrinkwrap.json")
        ? "package-lock-supported"
        : ecosystems.includes("node")
          ? "lockfile-unsupported"
          : "not-node",
    nodeOfflinePackageCount: 0,
    nodeOfflineBlockers: [],
    treeTruncated
  };
}
