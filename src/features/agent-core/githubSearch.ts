import type {
  AgentState,
  GitHubRepositorySearchInput,
  GitHubRepositorySearchOutput,
  GitHubRepositorySort,
  ToolResult
} from "./types";

export type GitHubSearchIntent =
  | { mode: "discovery" }
  | { mode: "name"; query: string }
  | { mode: "exact"; fullName: string };

type GitHubSearchGoal = {
  text: string;
  links?: string[];
};

const languageKeywords = [
  "typescript",
  "javascript",
  "python",
  "rust",
  "golang",
  "go",
  "java",
  "kotlin",
  "swift",
  "c++",
  "c#",
  "php",
  "ruby",
  "dart",
  "vue",
  "react"
];

const genericRepositoryNames = new Set([
  "api",
  "find",
  "git",
  "github",
  "latest",
  "locate",
  "npm",
  "popular",
  "project",
  "projects",
  "repo",
  "repository",
  "search",
  "top",
  "trending"
]);

const ambiguousBareTechnologyNames = new Set([
  ...languageKeywords,
  "cmake",
  "cuda",
  "node",
  "nodejs",
  "numpy",
  "occt",
  "opencv",
  "pandas",
  "pip",
  "pytorch",
  "qt",
  "tensorflow",
  "torch"
]);

const sortByAnswer: Record<string, GitHubRepositorySort> = {
  "按 Star 数": "stars",
  "按最近更新": "updated",
  "按 Fork 数": "forks"
};

const daysByAnswer: Record<string, 7 | 30 | 90> = {
  "最近 7 天新建": 7,
  "最近 30 天新建": 30,
  "最近 90 天新建": 90
};

const githubReservedPaths = new Set([
  "about",
  "apps",
  "collections",
  "customer-stories",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "security",
  "settings",
  "sponsors",
  "topics",
  "trending",
  "users"
]);

function validRepositoryPart(value: string) {
  return /^[A-Za-z0-9_.-]{1,100}$/u.test(value);
}

export function githubFullNameFromUrl(value: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username ||
      url.password
    ) {
      return null;
    }
    const [owner, repository] = url.pathname
      .split("/")
      .filter(Boolean)
      .slice(0, 2);
    if (
      !owner ||
      !repository ||
      githubReservedPaths.has(owner.toLowerCase()) ||
      !validRepositoryPart(owner) ||
      !validRepositoryPart(repository)
    ) {
      return null;
    }
    return `${owner}/${repository.replace(/\.git$/iu, "")}`;
  } catch {
    return null;
  }
}

function cleanNameCandidate(value: string | undefined) {
  const candidate = value
    ?.normalize("NFKC")
    .replace(/^[“”"'「」『』]+|[“”"'「」『』]+$/gu, "")
    .trim();
  return candidate && validRepositoryPart(candidate) ? candidate : null;
}

function explicitRepositoryName(task: string) {
  const patterns = [
    /(?:仓库名|项目名|名字|名称|名)\s*(?:是|为|叫做|叫)?\s*[“"'「『]?([A-Za-z0-9][A-Za-z0-9_.-]{0,99})/iu,
    /(?:名叫|名为|叫做?|named|called)\s*[“"'「『]?([A-Za-z0-9][A-Za-z0-9_.-]{0,99})/iu,
    /github\s*(?:上)?(?:的)?\s*[“"'「『]?([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\s*(?:项目|仓库|repo(?:sitory)?)/iu,
    /(?:在\s*)?github\s*(?:上|中|里)?\s*(?:搜索|查找|寻找|检索|搜|找)\s*[“"'「『]?([A-Za-z0-9][A-Za-z0-9_.-]{0,99})/iu,
    /(?:搜索|查找|寻找|检索|搜|找)\s*github\s*(?:上|中|里)?\s*(?:的|for)?\s*[“"'「『]?([A-Za-z0-9][A-Za-z0-9_.-]{0,99})/iu,
    /(?:搜索|查找|寻找|检索|搜|找)\s*(?:一个|一下)?\s*[“"'「『]?([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\s*(?:的)?\s*(?:开源)?(?:项目|仓库|repo(?:sitory)?)/iu,
    /(?:搜索|查找|寻找|检索|搜|找)\s*(?:一个|一下)?\s*[“"'「『]?([A-Za-z0-9][A-Za-z0-9_. -]{0,99})\s*[”"'」』]?\s*[。.!！?？]*$/iu,
    /\b(?:search|find|locate|download|clone|fetch)\s+github\s+(?:for\s+)?[“"']?([A-Za-z0-9][A-Za-z0-9_. -]{0,99})/iu,
    // “下载/克隆 X”与“GitHub 上的 X”：X 可能是多词描述（如 deepseek harness），
    // 取最后一个合法 token 作为仓库名。
    /(?:下载|克隆|拉取|获取|clone|fetch|get)\s*(?:github\s*(?:上|中|里|的)?)?\s*(?:的|for)?\s*(?:这个|那个)?\s*(?:项目|仓库|repo(?:sitory)?)?\s*[“"'「『]?([A-Za-z0-9][A-Za-z0-9_. -]{0,99})/iu,
    /github\s*(?:上|中|里)?\s*(?:的)?\s*(?:这个|那个)?\s*[“"'「『]?([A-Za-z0-9][A-Za-z0-9_. -]{0,99})\s*$/iu
  ];
  for (const pattern of patterns) {
    const matched = task.match(pattern)?.[1];
    const candidate =
      cleanNameCandidate(matched) ?? lastTokenCandidate(matched);
    if (candidate && !genericRepositoryNames.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  const bareCandidate = cleanNameCandidate(task);
  if (
    bareCandidate &&
    !genericRepositoryNames.has(bareCandidate.toLowerCase()) &&
    !ambiguousBareTechnologyNames.has(bareCandidate.toLowerCase())
  ) {
    return bareCandidate;
  }
  return null;
}

/**
 * 多词候选（如 “deepseek harness”）取最后一个合法 token 作为仓库名。
 */
function lastTokenCandidate(raw: string | undefined) {
  if (!raw) return null;
  const tokens = raw.split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const candidate = cleanNameCandidate(tokens[i]);
    if (
      candidate &&
      !genericRepositoryNames.has(candidate.toLowerCase()) &&
      !ambiguousBareTechnologyNames.has(candidate.toLowerCase())
    ) {
      return candidate;
    }
  }
  return null;
}

function explicitFullName(task: string) {
  const withoutUrls = task.replace(/https:\/\/[^\s<>"']+/giu, " ");
  const match = withoutUrls.match(
    /(?:github\s*(?:仓库|项目)?\s*)?[“"'「『]?([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})/iu
  );
  return match?.[1] ?? null;
}

export function inferGitHubSearchIntent(
  goal: GitHubSearchGoal
): GitHubSearchIntent {
  for (const link of goal.links ?? []) {
    const fullName = githubFullNameFromUrl(link);
    if (fullName) return { mode: "exact", fullName };
  }
  const fullName = explicitFullName(goal.text);
  if (fullName) return { mode: "exact", fullName };
  const query = explicitRepositoryName(goal.text);
  if (query) return { mode: "name", query };
  return { mode: "discovery" };
}

const discoveryStopPhrases = [
  "repository",
  "repositories",
  "github",
  "开源项目",
  "开源仓库",
  "帮我",
  "请帮我",
  "查找",
  "寻找",
  "搜索",
  "检索",
  "找一下",
  "搜一下",
  "项目",
  "仓库",
  "一个",
  "一些",
  "开源",
  "repo",
  "请",
  "的"
].sort((left, right) => right.length - left.length);

/**
 * 为 discovery 保留用户真正表达的主题，而不是只提取编程语言。
 *
 * 先做短语级清洗再切 token，避免中文连续文本被当成一个 token，导致
 * `帮我找一个 python 的机器学习项目` 无法保留“机器学习”。
 */
export function buildDiscoveryQuery(task: string) {
  let normalized = task.normalize("NFKC").trim().toLowerCase();
  for (const phrase of discoveryStopPhrases) {
    normalized = normalized.split(phrase).join(" ");
  }
  const tokens = normalized
    .split(/[^\p{L}\p{N}+#_.-]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
  return [...new Set(tokens)].join(" ").slice(0, 200);
}

export function githubSearchInputFromState(
  state: AgentState
): GitHubRepositorySearchInput {
  const intent = inferGitHubSearchIntent({
    text: state.task,
    links: state.routeDecision?.userLinks ?? []
  });
  if (intent.mode === "exact") {
    return { mode: "exact", fullName: intent.fullName, limit: 1 };
  }
  if (intent.mode === "name") {
    return { mode: "name", query: intent.query, limit: 10 };
  }
  const semanticSearch = state.routeDecision?.semanticIntent?.githubSearch;
  if (semanticSearch?.mode === "name") {
    return { mode: "name", query: semanticSearch.query, limit: 10 };
  }
  return {
    mode: "discovery",
    keywords:
      semanticSearch?.mode === "discovery" && semanticSearch.query
        ? semanticSearch.query
        : buildDiscoveryQuery(state.task),
    createdWithinDays:
      daysByAnswer[state.answers["github-created-window"] as string] ?? 30,
    sort: sortByAnswer[state.answers["github-sort"] as string] ?? "stars",
    limit: 10
  };
}

export function sameGitHubSearchInput(
  actual: GitHubRepositorySearchInput,
  expected: GitHubRepositorySearchInput
) {
  const actualMode = actual.mode;
  const expectedMode = expected.mode;
  if (actualMode !== expectedMode || actual.limit !== expected.limit) {
    return false;
  }
  if (actualMode === "name" && expectedMode === "name") {
    return actual.query === expected.query;
  }
  if (actualMode === "exact" && expectedMode === "exact") {
    return actual.fullName === expected.fullName;
  }
  if (
    actualMode === "discovery" &&
    expectedMode === "discovery" &&
    "keywords" in actual &&
    "keywords" in expected
  ) {
    return (
      actual.keywords === expected.keywords &&
      actual.createdWithinDays === expected.createdWithinDays &&
      actual.sort === expected.sort
    );
  }
  return false;
}

export function githubSearchPurpose(input: GitHubRepositorySearchInput) {
  if (input.mode === "name") {
    return `按仓库名称查找 GitHub 上与“${input.query}”匹配的公开开源项目。`;
  }
  if (input.mode === "exact") {
    return `定位 GitHub 仓库 ${input.fullName}，供用户核对并准备到本地。`;
  }
  return "按用户确认的时间窗口和热度指标查询公开开源仓库。";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isGitHubRepositorySearchOutput(
  value: unknown
): value is GitHubRepositorySearchOutput {
  if (!isRecord(value) || !isRecord(value.criteria)) return false;
  if (
    !Array.isArray(value.repositories) ||
    typeof value.totalCount !== "number" ||
    typeof value.incompleteResults !== "boolean" ||
    typeof value.fetchedAt !== "string" ||
    typeof value.authenticated !== "boolean" ||
    !isRecord(value.rateLimit)
  ) {
    return false;
  }
  const repositoriesValid = value.repositories.every((repository) =>
    isRecord(repository) &&
    typeof repository.id === "number" &&
    typeof repository.fullName === "string" &&
    typeof repository.url === "string" &&
    typeof repository.stars === "number" &&
    typeof repository.forks === "number" &&
    typeof repository.openIssues === "number" &&
    Array.isArray(repository.topics) &&
    isRecord(repository.license) &&
    typeof repository.license.spdxId === "string" &&
    typeof repository.license.name === "string"
  );
  if (!repositoriesValid) return false;
  if (value.recommendation === undefined) return true;
  const repositoryNames = new Set(
    value.repositories
      .filter(isRecord)
      .map((repository) => String(repository.fullName))
  );
  return isRecord(value.recommendation) &&
    Array.isArray(value.recommendation.selectedFullNames) &&
    value.recommendation.selectedFullNames.length > 0 &&
    value.recommendation.selectedFullNames.length <= 3 &&
    value.recommendation.selectedFullNames.every(
      (fullName) =>
        typeof fullName === "string" &&
        /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(fullName) &&
        repositoryNames.has(fullName)
    ) &&
    typeof value.recommendation.reason === "string" &&
    value.recommendation.reason.trim().length > 0 &&
    value.recommendation.reason.length <= 2000 &&
    ["remote-llm", "deterministic"].includes(
      String(value.recommendation.source)
    );
}

export function latestGitHubRepositorySearchResult(
  state: AgentState
): ToolResult | null {
  const recordedResult = [...state.agentRun.toolResults]
    .reverse()
    .find((result) => result.tool === "search_github_repositories") ?? null;
  if (recordedResult) return recordedResult;

  // TaskPlan is now the executor's durable source of truth. Older views and
  // Main-side follow-up actions still consume ToolResult, so reconstruct the
  // audit result when a restored snapshot only retained the DAG step output.
  const step = [...(state.taskPlan?.steps ?? [])]
    .reverse()
    .find(
      (candidate) =>
        candidate.tool === "search_github_repositories" &&
        (candidate.result !== null || candidate.error !== null)
    );
  if (!step) return null;

  const startedAt = step.startedAt ?? state.taskPlan?.createdAt ?? "unknown";
  const finishedAt =
    step.completedAt ?? state.taskPlan?.updatedAt ?? startedAt;
  if (
    step.status === "completed" &&
    isGitHubRepositorySearchOutput(step.result?.output)
  ) {
    return {
      callId: `task-plan-r${state.taskPlan?.revision ?? state.revision}-${step.id}`,
      tool: "search_github_repositories",
      status: "success",
      output: step.result.output,
      startedAt,
      finishedAt
    };
  }
  if (step.error) {
    return {
      callId: `task-plan-r${state.taskPlan?.revision ?? state.revision}-${step.id}`,
      tool: "search_github_repositories",
      status: "error",
      error: {
        code: "TASK_PLAN_STEP_FAILED",
        message: step.error,
        retriable: true
      },
      startedAt,
      finishedAt
    };
  }
  return null;
}
