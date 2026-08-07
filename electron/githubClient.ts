import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  GitHubRepositorySearchInput,
  GitHubRepositorySearchOutput,
  GitHubRepositorySearchResult,
  GitHubRepositorySummary,
  PlannedResource
} from "../src/features/agent-core/types";
import { analyzeProjectPaths } from "../src/features/agent-core/projectAnalysis";

const githubSearchEndpoint =
  "https://api.github.com/search/repositories";
const githubApiVersion = "2022-11-28";

const discoverySearchInputSchema = z.object({
  mode: z.literal("discovery"),
  keywords: z.string().trim().max(200),
  createdWithinDays: z.union([
    z.literal(7),
    z.literal(30),
    z.literal(90)
  ]),
  sort: z.enum(["stars", "updated", "forks"]),
  limit: z.number().int().min(1).max(10)
}).strict();
const searchInputSchema = z.union([
  discoverySearchInputSchema,
  z.object({
    mode: z.literal("name"),
    query: z.string().trim().min(1).max(100),
    limit: z.number().int().min(1).max(10)
  }).strict(),
  z.object({
    mode: z.literal("exact"),
    fullName: z.string().regex(
      /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
    ),
    limit: z.literal(1)
  }).strict()
]);

const githubRepositorySchema = z.object({
  id: z.number().int().nonnegative(),
  full_name: z.string().trim().min(3).max(300),
  html_url: z.string().url(),
  description: z.string().nullable(),
  stargazers_count: z.number().int().nonnegative(),
  forks_count: z.number().int().nonnegative(),
  open_issues_count: z.number().int().nonnegative(),
  language: z.string().nullable(),
  topics: z.array(z.string()).optional().default([]),
  license: z.object({
    key: z.string(),
    name: z.string(),
    spdx_id: z.string().nullable()
  }).nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  pushed_at: z.string().datetime(),
  private: z.boolean(),
  fork: z.boolean(),
  archived: z.boolean()
}).passthrough();

const githubSearchResponseSchema = z.object({
  total_count: z.number().int().nonnegative(),
  incomplete_results: z.boolean(),
  items: z.array(githubRepositorySchema)
}).passthrough();

const githubRepositoryDetailSchema = z.object({
  full_name: z.string(),
  html_url: z.string().url(),
  description: z.string().nullable(),
  default_branch: z.string().min(1),
  size: z.number().int().nonnegative(),
  private: z.boolean(),
  fork: z.boolean(),
  archived: z.boolean(),
  license: z.object({
    name: z.string(),
    spdx_id: z.string().nullable()
  }).nullable()
}).passthrough();

const githubCommitSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i),
  commit: z.object({
    tree: z.object({
      sha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i)
    }).passthrough()
  }).passthrough()
}).passthrough();

const githubTreeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({
    path: z.string(),
    type: z.enum(["blob", "tree", "commit"]),
    sha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i),
    size: z.number().int().nonnegative().optional()
  }).passthrough())
}).passthrough();

const githubBlobSchema = z.object({
  encoding: z.literal("base64"),
  content: z.string(),
  size: z.number().int().nonnegative()
}).passthrough();

export type GitHubRepositoryInspectionResult =
  | {
      ok: true;
      resource: PlannedResource;
      dependencyResources: PlannedResource[];
    }
  | {
      ok: false;
      error: { code: string; message: string; retriable: boolean };
    };

export type GitHubClientEnvironment = {
  XL_AGENT_GITHUB_TOKEN?: string;
};

export type GitHubFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

function sanitizeKeywords(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s._+#-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

function repositoryName(fullName: string) {
  return fullName.split("/").at(-1)?.toLocaleLowerCase("en-US") ?? "";
}

function rankNameMatches(
  repositories: GitHubRepositorySummary[],
  query: string
) {
  const normalizedQuery = query.toLocaleLowerCase("en-US");
  const matchRank = (repository: GitHubRepositorySummary) => {
    const name = repositoryName(repository.fullName);
    if (name === normalizedQuery) return 0;
    if (name.startsWith(normalizedQuery)) return 1;
    if (name.includes(normalizedQuery)) return 2;
    return 3;
  };
  return [...repositories].sort((left, right) => {
    const rank = matchRank(left) - matchRank(right);
    return rank === 0 ? right.stars - left.stars : rank;
  });
}

function dateDaysAgo(now: Date, days: number) {
  const value = new Date(now.getTime());
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function validRepositoryUrl(value: string) {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password &&
      segments.length === 2
    );
  } catch {
    return false;
  }
}

function parseIntegerHeader(value: string | null) {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function rateLimitFrom(response: Response) {
  const remaining = parseIntegerHeader(
    response.headers.get("x-ratelimit-remaining")
  );
  const resetEpoch = parseIntegerHeader(
    response.headers.get("x-ratelimit-reset")
  );
  return {
    remaining,
    resetAt:
      resetEpoch === null
        ? null
        : new Date(resetEpoch * 1000).toISOString()
  };
}

function toRepository(
  value: z.infer<typeof githubRepositorySchema>
): GitHubRepositorySummary | null {
  const spdxId = value.license?.spdx_id?.trim();
  if (
    value.private ||
    value.fork ||
    value.archived ||
    !value.license ||
    !spdxId ||
    spdxId.toUpperCase() === "NOASSERTION" ||
    !validRepositoryUrl(value.html_url)
  ) {
    return null;
  }
  return {
    id: value.id,
    fullName: value.full_name,
    url: value.html_url,
    description: value.description,
    stars: value.stargazers_count,
    forks: value.forks_count,
    openIssues: value.open_issues_count,
    language: value.language,
    topics: value.topics.slice(0, 12),
    license: {
      spdxId,
      name: value.license.name
    },
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    pushedAt: value.pushed_at
  };
}

async function safeGitHubMessage(response: Response, token: string | null) {
  try {
    const payload = await response.json() as { message?: unknown };
    if (typeof payload.message !== "string") return null;
    let message = payload.message
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (token) message = message.split(token).join("[redacted]");
    return message ? message.slice(0, 300) : null;
  } catch {
    return null;
  }
}

function failure(
  code: string,
  message: string,
  retriable: boolean
): GitHubRepositorySearchResult {
  return { ok: false, error: { code, message, retriable } };
}

type ParsedNpmDependency = {
  packageName: string;
  version: string;
  resolvedUrl: string;
  integrity: string;
  digestBase64: string;
  license: string;
  dependencyKind: "production" | "development" | "optional";
};

function packageNameFromLockPath(lockPath: string) {
  const marker = "/node_modules/";
  const normalized = lockPath.replace(/\\/g, "/");
  const value = normalized.startsWith("node_modules/")
    ? normalized.slice("node_modules/".length)
    : normalized.includes(marker)
      ? normalized.slice(normalized.lastIndexOf(marker) + marker.length)
      : "";
  const segments = value.split("/").filter(Boolean);
  if (segments[0]?.startsWith("@")) return segments.slice(0, 2).join("/");
  return segments[0] ?? "";
}

function parseSha512Integrity(value: unknown) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^sha512-([A-Za-z0-9+/]{86}==)$/);
  if (!match) return null;
  const digest = Buffer.from(match[1], "base64");
  return digest.byteLength === 64 && digest.toString("base64") === match[1]
    ? match[1]
    : null;
}

function explicitPackageLicense(value: unknown) {
  if (typeof value !== "string") return null;
  const license = value.trim().slice(0, 200);
  if (
    !license ||
    ["UNLICENSED", "UNKNOWN", "NOASSERTION"].includes(license.toUpperCase())
  ) {
    return null;
  }
  return license;
}

function fixedNpmTarballUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "registry.npmjs.org" ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.includes("/-/")
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function parsePackageLock(
  content: string,
  repositoryFullName: string,
  commitSha: string,
  lockfilePath: string
) {
  const blockers: string[] = [];
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    return {
      dependencies: [] as ParsedNpmDependency[],
      blockers: ["package-lock.json 不是合法 JSON。"]
    };
  }
  if (typeof payload !== "object" || payload === null) {
    return {
      dependencies: [] as ParsedNpmDependency[],
      blockers: ["package-lock.json 顶层结构无效。"]
    };
  }
  const lock = payload as Record<string, unknown>;
  if (
    (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) ||
    typeof lock.packages !== "object" ||
    lock.packages === null ||
    Array.isArray(lock.packages)
  ) {
    return {
      dependencies: [] as ParsedNpmDependency[],
      blockers: ["仅支持包含 packages 映射的 package-lock v2/v3。"]
    };
  }

  const dependencies = new Map<string, ParsedNpmDependency>();
  const entries = Object.entries(lock.packages as Record<string, unknown>);
  for (const [packagePath, rawEntry] of entries) {
    if (!packagePath.includes("node_modules/") && !packagePath.startsWith("node_modules/")) {
      continue;
    }
    if (typeof rawEntry !== "object" || rawEntry === null) {
      blockers.push(`${packagePath} 的锁文件条目无效。`);
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    if (entry.link === true || entry.inBundle === true || entry.bundled === true) {
      continue;
    }
    const packageName =
      typeof entry.name === "string" && entry.name.trim()
        ? entry.name.trim()
        : packageNameFromLockPath(packagePath);
    const version =
      typeof entry.version === "string" ? entry.version.trim() : "";
    const resolvedUrl = fixedNpmTarballUrl(entry.resolved);
    const digestBase64 = parseSha512Integrity(entry.integrity);
    const license = explicitPackageLicense(entry.license);
    if (!packageName || !version || !resolvedUrl || !digestBase64 || !license) {
      blockers.push(
        `${packagePath} 缺少固定 registry.npmjs.org 地址、SHA512、版本或明确许可证。`
      );
      continue;
    }
    const integrity = `sha512-${digestBase64}`;
    dependencies.set(`${resolvedUrl}\n${integrity}`, {
      packageName,
      version,
      resolvedUrl,
      integrity,
      digestBase64,
      license,
      dependencyKind:
        entry.optional === true
          ? "optional"
          : entry.dev === true
            ? "development"
            : "production"
    });
  }
  if (dependencies.size > 250) {
    blockers.push(
      `锁文件包含 ${dependencies.size} 个独立 tarball，超过单次离线计划 250 项上限。`
    );
  }
  return {
    dependencies:
      blockers.length === 0 && dependencies.size <= 250
        ? [...dependencies.values()]
        : [],
    blockers: blockers.slice(0, 30),
    repositoryFullName,
    commitSha,
    lockfilePath
  };
}

function npmDependencyResource(
  dependency: ParsedNpmDependency,
  repositoryFullName: string,
  commitSha: string,
  lockfilePath: string
): PlannedResource {
  const suffix = createHash("sha256")
    .update(`${dependency.resolvedUrl}\n${dependency.integrity}`)
    .digest("hex")
    .slice(0, 16);
  const safeName = dependency.packageName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .slice(0, 40);
  return {
    id: `npm-${safeName}-${suffix}`.slice(0, 80),
    name: `${dependency.packageName}（npm 离线包）`,
    version: dependency.version,
    publisher: "npm registry / package-lock",
    source: `${lockfilePath} @ ${commitSha.slice(0, 12)}`,
    homepage: `https://www.npmjs.com/package/${encodeURIComponent(dependency.packageName)}`,
    releasePage: `https://www.npmjs.com/package/${encodeURIComponent(dependency.packageName)}/v/${encodeURIComponent(dependency.version)}`,
    sizeMb: 1,
    license: dependency.license,
    purpose: `Node ${dependency.dependencyKind === "development" ? "开发" : dependency.dependencyKind === "optional" ? "可选" : "生产"}依赖的离线 tarball。`,
    recommendation:
      "仅下载 package-lock 固定的 tarball 并验证 SHA512；不会执行 npm install 或生命周期脚本。",
    required: false,
    dependsOn: [],
    provides: ["offline-node-package"],
    requiresCapabilities: ["project-source"],
    supportedOperatingSystems: ["Windows 11"],
    supportedArchitectures: ["x64"],
    sourceTrust: "npm-lockfile",
    catalogStatus: "active",
    verification: {
      checksumAlgorithm: "sha512",
      checksumSource: "npm-lockfile-integrity",
      checksumSourceUrl: `https://github.com/${repositoryFullName}/blob/${commitSha}/${lockfilePath}`,
      signatureType: "none",
      signatureEnforcement: "checksum-only"
    },
    download: {
      url: dependency.resolvedUrl,
      expectedSha256: null,
      digestPolicy: "lockfile-integrity",
      expectedIntegrity: {
        algorithm: "sha512",
        digestBase64: dependency.digestBase64
      },
      maxSizeMb: 100,
      allowedHosts: ["registry.npmjs.org"]
    },
    npm: {
      packageName: dependency.packageName,
      version: dependency.version,
      resolvedUrl: dependency.resolvedUrl,
      integrity: dependency.integrity,
      license: dependency.license,
      dependencyKind: dependency.dependencyKind,
      lockfilePath,
      repositoryFullName,
      repositoryCommitSha: commitSha
    },
    selected: false,
    status: "pending",
    progress: 0,
    attempts: 0
  };
}

export class GitHubRepositorySearchClient {
  constructor(
    private readonly environment: GitHubClientEnvironment = process.env,
    private readonly fetchRequest: GitHubFetch = fetch,
    private readonly now: () => Date = () => new Date()
  ) {}

  async search(
    input: GitHubRepositorySearchInput
  ): Promise<GitHubRepositorySearchResult> {
    const parsedInput = searchInputSchema.safeParse(input);
    if (!parsedInput.success) {
      return failure(
        "GITHUB_QUERY_INVALID",
        "GitHub 仓库搜索参数不符合只读工具协议。",
        false
      );
    }

    const token = this.environment.XL_AGENT_GITHUB_TOKEN?.trim() || null;
    const mode = parsedInput.data.mode;
    const url = new URL(githubSearchEndpoint);
    let criteria: GitHubRepositorySearchOutput["criteria"];
    if (mode === "name" && parsedInput.data.mode === "name") {
      const query = sanitizeKeywords(parsedInput.data.query);
      if (!query) {
        return failure(
          "GITHUB_QUERY_INVALID",
          "GitHub 仓库名称不能为空。",
          false
        );
      }
      url.searchParams.set(
        "q",
        `${query} in:name is:public archived:false fork:false`
      );
      criteria = {
        mode: "name",
        query,
        match: "repository-name",
        order: "best-match",
        licenseRequired: true
      };
    } else if (mode === "exact" && parsedInput.data.mode === "exact") {
      url.searchParams.set(
        "q",
        `repo:${parsedInput.data.fullName} is:public archived:false fork:false`
      );
      criteria = {
        mode: "exact",
        fullName: parsedInput.data.fullName,
        match: "exact",
        licenseRequired: true
      };
    } else {
      const discoveryInput = parsedInput.data;
      if (!("keywords" in discoveryInput)) {
        return failure(
          "GITHUB_QUERY_INVALID",
          "GitHub 热门发现参数不完整。",
          false
        );
      }
      const keywords = sanitizeKeywords(discoveryInput.keywords);
      const createdAfter = dateDaysAgo(
        this.now(),
        discoveryInput.createdWithinDays
      );
      url.searchParams.set(
        "q",
        [
          keywords,
          `created:>=${createdAfter}`,
          "is:public",
          "archived:false",
          "fork:false"
        ].filter(Boolean).join(" ")
      );
      url.searchParams.set("sort", discoveryInput.sort);
      url.searchParams.set("order", "desc");
      criteria = {
        mode: "discovery",
        keywords,
        createdWithinDays: discoveryInput.createdWithinDays,
        createdAfter,
        sort: discoveryInput.sort,
        order: "desc",
        licenseRequired: true
      };
    }
    url.searchParams.set("per_page", "100");

    let response: Response;
    try {
      response = await this.fetchRequest(url, {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": githubApiVersion,
          "user-agent": "xunlei-ai-task-agent",
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        signal: AbortSignal.timeout(15000)
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        return failure(
          "GITHUB_TIMEOUT",
          "GitHub API 请求超时，请检查网络后重试。",
          true
        );
      }
      return failure(
        "GITHUB_NETWORK_ERROR",
        "无法连接 GitHub API，请检查网络、代理或 DNS 设置。",
        true
      );
    }

    if (!response.ok) {
      const message = await safeGitHubMessage(response, token);
      if (response.status === 401) {
        return failure(
          "GITHUB_AUTH_FAILED",
          "GitHub Token 无效或已过期；移除 XL_AGENT_GITHUB_TOKEN 仍可查询公开仓库。",
          false
        );
      }
      const rateLimit = rateLimitFrom(response);
      if (
        response.status === 429 ||
        (response.status === 403 && rateLimit.remaining === 0)
      ) {
        return failure(
          "GITHUB_RATE_LIMITED",
          `GitHub 搜索频率已达上限${
            rateLimit.resetAt ? `，预计 ${rateLimit.resetAt} 后恢复` : ""
          }。`,
          true
        );
      }
      return failure(
        "GITHUB_HTTP_ERROR",
        message
          ? `GitHub API 请求失败：HTTP ${response.status}，${message}`
          : `GitHub API 请求失败：HTTP ${response.status}。`,
        response.status === 408 || response.status >= 500
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return failure(
        "GITHUB_INVALID_RESPONSE",
        "GitHub API 返回了无法解析的响应。",
        true
      );
    }
    const parsedResponse = githubSearchResponseSchema.safeParse(payload);
    if (!parsedResponse.success) {
      return failure(
        "GITHUB_INVALID_RESPONSE",
        "GitHub API 响应不符合预期协议。",
        true
      );
    }

    let repositories = parsedResponse.data.items
      .map(toRepository)
      .filter((item): item is GitHubRepositorySummary => item !== null);
    if (mode === "name" && parsedInput.data.mode === "name") {
      repositories = rankNameMatches(
        repositories,
        sanitizeKeywords(parsedInput.data.query)
      );
    } else if (mode === "exact" && parsedInput.data.mode === "exact") {
      const expectedFullName =
        parsedInput.data.fullName.toLocaleLowerCase("en-US");
      repositories = repositories.filter(
        (repository) =>
          repository.fullName.toLocaleLowerCase("en-US") ===
          expectedFullName
      );
    }
    repositories = repositories.slice(0, parsedInput.data.limit);
    const output: GitHubRepositorySearchOutput = {
      criteria,
      repositories,
      totalCount: parsedResponse.data.total_count,
      incompleteResults: parsedResponse.data.incomplete_results,
      fetchedAt: this.now().toISOString(),
      authenticated: token !== null,
      rateLimit: rateLimitFrom(response)
    };
    return { ok: true, output };
  }

  async inspectRepository(
    fullName: string
  ): Promise<GitHubRepositoryInspectionResult> {
    if (
      !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(fullName)
    ) {
      return {
        ok: false,
        error: {
          code: "GITHUB_REPOSITORY_INVALID",
          message: "GitHub 仓库标识不合法。",
          retriable: false
        }
      };
    }
    const [owner, repository] = fullName.split("/");
    const token = this.environment.XL_AGENT_GITHUB_TOKEN?.trim() || null;
    const headers = {
      accept: "application/vnd.github+json",
      "x-github-api-version": githubApiVersion,
      "user-agent": "xunlei-ai-task-agent",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    };
    const request = async (url: URL) => {
      try {
        return await this.fetchRequest(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(15000)
        });
      } catch {
        return null;
      }
    };
    const repositoryUrl = new URL(
      `/repos/${owner}/${repository}`,
      "https://api.github.com"
    );
    const repositoryResponse = await request(repositoryUrl);
    if (!repositoryResponse) {
      return {
        ok: false,
        error: {
          code: "GITHUB_NETWORK_ERROR",
          message: "无法读取 GitHub 仓库详情，请检查网络后重试。",
          retriable: true
        }
      };
    }
    if (!repositoryResponse.ok) {
      return {
        ok: false,
        error: {
          code: "GITHUB_REPOSITORY_UNAVAILABLE",
          message:
            await safeGitHubMessage(repositoryResponse, token) ??
            `GitHub 仓库详情请求失败：HTTP ${repositoryResponse.status}。`,
          retriable: repositoryResponse.status >= 500
        }
      };
    }
    let repositoryPayload: unknown;
    try {
      repositoryPayload = await repositoryResponse.json();
    } catch {
      repositoryPayload = null;
    }
    const detail = githubRepositoryDetailSchema.safeParse(repositoryPayload);
    if (
      !detail.success ||
      detail.data.full_name.toLowerCase() !== fullName.toLowerCase() ||
      detail.data.private ||
      detail.data.fork ||
      detail.data.archived ||
      !detail.data.license?.spdx_id ||
      detail.data.license.spdx_id.toUpperCase() === "NOASSERTION"
    ) {
      return {
        ok: false,
        error: {
          code: "GITHUB_REPOSITORY_NOT_ELIGIBLE",
          message: "仓库必须是公开、非 Fork、非归档且具有明确 SPDX 许可证。",
          retriable: false
        }
      };
    }
    const commitUrl = new URL(
      `/repos/${owner}/${repository}/commits/${encodeURIComponent(
        detail.data.default_branch
      )}`,
      "https://api.github.com"
    );
    const commitResponse = await request(commitUrl);
    if (!commitResponse?.ok) {
      return {
        ok: false,
        error: {
          code: "GITHUB_COMMIT_UNAVAILABLE",
          message: "无法把仓库默认分支解析为固定 commit SHA。",
          retriable: true
        }
      };
    }
    let commitPayload: unknown;
    try {
      commitPayload = await commitResponse.json();
    } catch {
      commitPayload = null;
    }
    const commit = githubCommitSchema.safeParse(commitPayload);
    if (!commit.success) {
      return {
        ok: false,
        error: {
          code: "GITHUB_INVALID_RESPONSE",
          message: "GitHub Commit API 响应不符合预期协议。",
          retriable: true
        }
      };
    }
    const treeUrl = new URL(
      `/repos/${owner}/${repository}/git/trees/${commit.data.commit.tree.sha}`,
      "https://api.github.com"
    );
    treeUrl.searchParams.set("recursive", "1");
    const treeResponse = await request(treeUrl);
    let treePayload: unknown = null;
    if (treeResponse?.ok) {
      try {
        treePayload = await treeResponse.json();
      } catch {
        treePayload = null;
      }
    }
    const tree = treeResponse?.ok
      ? githubTreeSchema.safeParse(treePayload)
      : null;
    let analysis = tree?.success
      ? analyzeProjectPaths(
          tree.data.tree
            .filter((entry) => entry.type === "blob")
            .map((entry) => entry.path),
          tree.data.truncated
        )
      : analyzeProjectPaths([], true);
    const commitSha = commit.data.sha.toLowerCase();
    let dependencyResources: PlannedResource[] = [];
    const rootPackageLock = tree?.success
      ? tree.data.tree.find(
          (entry) => entry.type === "blob" && entry.path === "package-lock.json"
        )
      : null;
    if (
      !rootPackageLock &&
      analysis.nodeOfflinePreparation === "package-lock-supported"
    ) {
      analysis = {
        ...analysis,
        nodeOfflinePreparation: "lockfile-unsupported",
        nodeOfflineBlockers: [
          "当前仅支持仓库根目录的 package-lock.json；嵌套锁文件和 npm-shrinkwrap.json 暂不进入离线下载。"
        ]
      };
    }
    if (rootPackageLock) {
      if ((rootPackageLock.size ?? 0) > 5 * 1024 * 1024) {
        analysis = {
          ...analysis,
          nodeOfflinePreparation: "lockfile-unsupported",
          nodeOfflineBlockers: [
            "根 package-lock.json 超过 5 MiB 的安全解析上限。"
          ]
        };
      } else {
        const blobUrl = new URL(
          `/repos/${owner}/${repository}/git/blobs/${rootPackageLock.sha}`,
          "https://api.github.com"
        );
        const blobResponse = await request(blobUrl);
        let blobPayload: unknown = null;
        if (blobResponse?.ok) {
          try {
            blobPayload = await blobResponse.json();
          } catch {
            blobPayload = null;
          }
        }
        const blob = githubBlobSchema.safeParse(blobPayload);
        if (
          !blob.success ||
          blob.data.size > 5 * 1024 * 1024 ||
          Buffer.byteLength(blob.data.content, "base64") !== blob.data.size
        ) {
          analysis = {
            ...analysis,
            nodeOfflinePreparation: "lockfile-unsupported",
            nodeOfflineBlockers: [
              "无法从固定 commit 安全读取根 package-lock.json。"
            ]
          };
        } else {
          const parsedLock = parsePackageLock(
            Buffer.from(blob.data.content, "base64").toString("utf8"),
            detail.data.full_name,
            commitSha,
            rootPackageLock.path
          );
          dependencyResources = parsedLock.dependencies.map((dependency) =>
            npmDependencyResource(
              dependency,
              detail.data.full_name,
              commitSha,
              rootPackageLock.path
            )
          );
          analysis = {
            ...analysis,
            nodeOfflinePreparation:
              parsedLock.blockers.length === 0 &&
              dependencyResources.length > 0
                ? "package-lock-supported"
                : "lockfile-unsupported",
            nodeOfflinePackageCount: dependencyResources.length,
            nodeOfflineBlockers:
              parsedLock.blockers.length > 0
                ? parsedLock.blockers
                : dependencyResources.length === 0
                  ? ["package-lock.json 未声明可下载的外部 npm tarball。"]
                  : []
          };
        }
      }
    }
    const inspectedAt = this.now().toISOString();
    const resourceId = `github-${owner}-${repository}-${commitSha.slice(0, 12)}`
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")
      .slice(0, 80);
    const maxSizeMb = Math.min(
      1024,
      Math.max(10, Math.ceil(detail.data.size / 1024 * 1.5))
    );
    return {
      ok: true,
      resource: {
        id: resourceId,
        name: detail.data.full_name,
        version: commitSha.slice(0, 12),
        publisher: owner,
        source: "GitHub Repository API",
        homepage: detail.data.html_url,
        releasePage: `${detail.data.html_url}/releases`,
        sizeMb: Math.max(1, Math.ceil(detail.data.size / 1024)),
        license: detail.data.license.spdx_id,
        purpose: "固定 commit 的开源项目源码快照。",
        recommendation:
          "下载后只生成项目准备度报告，不自动执行仓库代码或安装依赖。",
        required: true,
        dependsOn: [],
        provides: ["project-source"],
        requiresCapabilities: [],
        supportedOperatingSystems: ["Windows 11"],
        supportedArchitectures: ["x64"],
        sourceTrust: "github-api",
        catalogStatus: "active",
        verification: {
          checksumAlgorithm: "sha256",
          checksumSource: "computed-on-download",
          checksumSourceUrl: `${detail.data.html_url}/commit/${commitSha}`,
          signatureType: "none",
          signatureEnforcement: "not-applicable"
        },
        download: {
          url: `https://codeload.github.com/${owner}/${repository}/zip/${commitSha}`,
          expectedSha256: null,
          digestPolicy: "record-after-download",
          maxSizeMb,
          allowedHosts: ["codeload.github.com"]
        },
        github: {
          fullName: detail.data.full_name,
          owner,
          repository,
          defaultBranch: detail.data.default_branch,
          commitSha,
          treeSha: commit.data.commit.tree.sha.toLowerCase(),
          archiveFormat: "zip",
          inspectedAt,
          analysis
        },
        selected: true,
        status: "pending",
        progress: 0,
        attempts: 0
      },
      dependencyResources
    };
  }
}
