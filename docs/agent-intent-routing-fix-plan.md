# 修改方案：让 Agent 理解"裸意图"（如只说 `tau` 就能找到 GitHub 项目）

> 适用范围：`src/features/agent-core`
> 目标问题：用户只输入 `tau`（无 "github"、"搜索"、"项目" 等语言锚点）时，路由判定为
> `unsupported`，agent 无法工作；用户必须显式说"在 GitHub 上查找 tau"才正常。
> 本文给出 3 个阶段、可独立上线的修改方案，并附代码骨架、回退策略与测试计划。

---

## 0. 结论先行

- **根因不是"链路太单一"，而是"关键决策点（意图路由）没有接入 LLM，且缺少 候选→验证→收敛 循环"。**
- 你的执行阶段（`agentLoop.generateTurn`）已经接入了 LLM，但**路由阶段（`router.ts` →
  `domainSkills.ts` → `githubSearch.ts`）是纯正则/关键词引擎**。"tau" 对正则引擎是死 token，
  对 LLM 是可以结合上下文消歧的语义信号。
- 本项目**已经具备接 LLM 的基础设施**（`ModelRuntime.decide` + `modelDecisionSchema` zod 校验 +
  `RemoteLlmModelRuntime` + `FallbackModelRuntime`），方案 Phase 2 直接复用它，不需要新基建。

---

## 1. 问题根因（代码证据链）

用户输入 `"tau"` 时的实际执行路径：

```
router.ts ExtensibleAgentRouter.route()
  └─ DomainSkillRegistry.match(goal, state)          // 逐 skill 调 matches()
      └─ GitHubProjectDiscoverySkill.matches()       // domainSkills.ts
          ├─ hasGitHubRepositoryLink = false          // 无链接
          ├─ inferGitHubSearchIntent("tau")          // githubSearch.ts
          │    ├─ explicitFullName() → null           // 需要 owner/repo 格式
          │    ├─ explicitRepositoryName() → null     // 需要 "搜索 X 项目"/"named X" 等语言锚点
          │    └─ 返回 { mode: "discovery" }
          └─ task.includes("github") = false          // "tau" 不含 "github" → matches() 返回 false
  └─ 其余 skill 的 matches() 也不命中
  └─ 返回 status: "unsupported"
```

两个具体缺陷：

1. **路由是词法规则，不是语义理解**（缺陷 A）
   `GitHubProjectDiscoverySkill.matches()` 要求 `task.includes("github")` 或命中
   `explicitRepositoryName` 的语言锚点正则。`"tau"` 这种"语境内自明"的裸词无法触发任何分支。
   而 LLM 完全可以在给定"coding agent 领域"上下文时推断 `tau` → `huggingface/tau`。

2. **discovery 搜索词丢失用户原话**（缺陷 B）
   `githubSearchInputFromState()` 的 discovery 分支只用 `explicitKeywords()` 提取**语言关键词**
   （typescript/python/rust…），"tau" 不是语言关键词 → `keywords` 为空 → 搜索必然失败。
   而 GitHub Repository Search API 本身支持按 repo 名/描述/README 全文匹配：`q=tau` 就能搜到
   `huggingface/tau`。这一步等于把用户原话扔掉了。

---

## 2. 设计原则

1. **规则引擎保留为兜底，LLM 只做增强**：正则 100% 可判定时（URL、`owner/repo`、明确语言锚点）
   不调 LLM；只有落到 `discovery` / 无法判定时才问模型。控制成本与时延。
2. **所有 LLM 输出仍走 zod schema 严格校验**：沿用 `modelDecisionSchema` 的模式
   （`parseXxx` + 失败抛 `ModelConnectionRequestError`），模型输出不可信。
3. **不破坏现有契约**：`TaskPlan` / Manifest / 审批模型 / `AgentEvent` 事件 / `sameGitHubSearchInput`
   一律不变；新增字段全部可选，向后兼容。
4. **可独立上线**：三个阶段各自可单独合并，每阶段都有回退路径，失败不影响现有功能。

---

## 3. 方案总览

| 阶段 | 内容 | 解决缺陷 | 改动文件 | 工作量 |
|---|---|---|---|---|
| Phase 1 | discovery 搜索直接使用用户原话 | B | `githubSearch.ts` | 小（半天） |
| Phase 2 | 路由阶段接入 LLM 意图分类（zod 校验 + 正则兜底） | A | 新增 `intentClassifier.ts`、`intentSchemas.ts`；改 `router.ts`、`interfaces.ts`、`mockServices.ts` | 中（1-2 天） |
| Phase 3 | 检索后"候选→验证→收敛"：LLM 从 top N 中挑选最匹配项 | A（体验升级） | 改 `githubSearch.ts`（新增推荐字段）、`agentServices.ts`（搜索桥后处理） | 中（1 天） |

---

## 4. Phase 1 — discovery 搜索直接用用户原话（最小修复）

### 4.1 修改点

`src/features/agent-core/githubSearch.ts`：

- 新增 `buildDiscoveryQuery(task: string): string`：去停用词、NFKC 归一化后**把用户原话作为搜索词**，
  语言关键词只作为附加词（用 `OR` 语义或追加空格分隔均可，取决于桥接实现）。
- 修改 `githubSearchInputFromState()` 的 discovery 分支：`keywords` 优先使用 `buildDiscoveryQuery`。

### 4.2 代码骨架

```typescript
// githubSearch.ts —— 新增

// 与 explicitRepositoryName 保持同源，但不再要求语言锚点
const discoveryStopWords = new Set([
  "帮我", "找", "查找", "搜索", "一个", "一下", "项目", "仓库", "开源",
  "github", "repo", "repository", "请", "下", "的", "在", "上", "里"
]);

export function buildDiscoveryQuery(task: string): string {
  const normalized = task.normalize("NFKC").trim().toLowerCase();
  const tokens = normalized
    .split(/[^\p{L}\p{N}_.-]+/u)
    .filter((token) => token.length > 0 && !discoveryStopWords.has(token));
  const originalTokens = tokens.filter(
    (token) => !languageKeywords.includes(token)
  );
  // 原话 token 优先；语言关键词只作为附加条件（不丢弃）
  const base = originalTokens.length > 0 ? originalTokens.join(" ") : tokens.join(" ");
  return base;
}
```

```typescript
// githubSearch.ts —— 修改 githubSearchInputFromState 的 discovery 分支

return {
  mode: "discovery",
  keywords: buildDiscoveryQuery(state.task),   // 原来是 explicitKeywords(state.task)
  createdWithinDays:
    daysByAnswer[state.answers["github-created-window"] as string] ?? 30,
  sort: sortByAnswer[state.answers["github-sort"] as string] ?? "stars",
  limit: 10,
};
```

> 注意：`sameGitHubSearchInput` 的比较逻辑不变，只要 `buildDiscoveryQuery` 是纯函数，
> 重试/恢复时输入可复现。

### 4.3 验证

- 输入 `tau` → `keywords === "tau"` → GitHub API `q=tau` 应返回 `huggingface/tau`。
- 输入 `帮我找一个python的机器学习项目` → `keywords` 含 "python 机器学习"（"帮我/找/一个/项目" 被去停用词）。
- 原有 `explicitRepositoryName` / `explicitFullName` 分支全部不动。

---

## 5. Phase 2 — LLM 意图路由（核心）

### 5.1 思路

在 `ExtensibleAgentRouter.route()` 判定为 `unsupported` **之前**，先尝试一次 LLM 意图分类：

```
route(state)
  ├─ 1) 确定性分支（现有正则，100% 可判定）→ 直接返回，不调 LLM
  ├─ 2) 正则落空（discovery / 无法判定）→ 调 IntentClassifier：
  │     { task, links, systemProfile, skills: [{id, displayName, description}] }
  │     → LLM 返回 { skillId: "github-project-discovery" | null, query?: string, reason }
  │     → zod 校验通过 → 按 LLM 结果路由
  │     → 校验失败 / 超时 / 无模型 → 回退现有 behavior（unsupported）
```

### 5.2 新增 Schema（`src/features/agent-core/intentSchemas.ts`）

沿用 `agentSchemas.ts` 的风格（`identifierSchema` / `descriptionSchema` 可直接复用）：

```typescript
import { z } from "zod";

const skillIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]{0,79}$/i);

export const routeIntentDecisionSchema = z
  .object({
    decisionId: z.string().trim().min(1).max(160),
    provider: z.enum(["remote-llm"]),
    model: z.string().trim().min(1).max(160),
    skillId: skillIdSchema.nullable(),          // null = 不属于任何已注册 skill
    query: z.string().trim().max(200).optional(), // LLM 建议的 GitHub 搜索词（仅 skillId=github-project-discovery 时有用）
    reason: z.string().trim().min(1).max(4000),
  })
  .strict();

export type RouteIntentDecision = z.infer<typeof routeIntentDecisionSchema>;

export function parseRouteIntentDecision(value: unknown): RouteIntentDecision {
  return routeIntentDecisionSchema.parse(value);
}
```

### 5.3 分类器接口（`src/features/agent-core/intentClassifier.ts`）

```typescript
import type { SystemProfile } from "./types";

export interface IntentClassifierContext {
  task: string;
  links: string[];
  profile: SystemProfile;
  skills: Array<{
    id: string;
    displayName: string;
    description: string; // 给模型的 skill 说明，见 DomainSkill 新增的可选字段
  }>;
}

export interface IntentClassifier {
  classify(
    context: IntentClassifierContext,
    signal?: AbortSignal
  ): Promise<RouteIntentDecision>;
}
```

复用现有模型运行时实现一个 `LlmIntentClassifier`：

```typescript
export class LlmIntentClassifier implements IntentClassifier {
  constructor(
    private readonly runtime: ModelRuntime,          // RemoteLlmModelRuntime / FallbackModelRuntime
    private readonly options: {
      timeoutMs?: number;
      maxRetries?: number;
    } = {}
  ) {}

  async classify(context: IntentClassifierContext, signal?: AbortSignal): Promise<RouteIntentDecision> {
    // 1) 构造只读 ModelContext：task + skills 清单 + 明确的输出约束
    const modelContext = buildIntentModelContext(context);
    // 2) 调用 decide()（现有协议，无需新增 transport 方法）
    const raw = await withTimeout(
      () => this.runtime.decide(modelContext, signal),
      this.options.timeoutMs ?? 8000
    );
    // 3) zod 校验，失败即抛错，由调用方回退
    return parseRouteIntentDecision(raw);
  }
}
```

> 关键：**复用 `ModelRuntime.decide`，不需要给 `RemoteModelTransport` 加方法**。
> 如果你的 transport 的 `requestDecision` 返回的是 `ModelDecision`（含 `action`），
> 有两种接法：
> - 方案 A（推荐）：给 `ModelDecision.action` 的 union 增加一个 `{ type: "CLASSIFY_INTENT", skillId, query?, reason }` 变体（`agentSchemas.ts` 的 `agentActionSchema`），扩展 `parseModelDecision`，路由层从中取字段；
> - 方案 B：为 intent 单独加 `requestIntentClassification` transport 方法（侵入更大，不推荐）。

### 5.4 修改 `ExtensibleAgentRouter`（`router.ts`）

```typescript
export class ExtensibleAgentRouter implements AgentRouter {
  constructor(
    private readonly skills: DomainSkillRegistry = createDefaultDomainSkillRegistry(),
    private readonly providers: SourceProviderRegistry = createDefaultSourceProviderRegistry(),
    private readonly classifier?: IntentClassifier,   // 可选注入，不注入则保持现状
  ) {}

  async route(state: AgentState) {                   // 注意：可能变为 async
    if (state.phase !== "routing") return null;
    const goal = goalFromState(state);

    // 1) 确定性分支（现有逻辑，先跑，命中直接返回）
    const deterministic = this.routeDeterministic(state, goal);
    if (deterministic) return deterministic;

    // 2) 确定性分支落空（unsupported / needs_links）才尝试 LLM 意图分类
    if (!this.classifier) return deterministic;      // 无分类器 → 保持现状

    try {
      const decision = await this.classifier.classify({
        task: goal.text,
        links: goal.links,
        profile: state.systemProfile,
        skills: this.skills.list().map((s) => ({
          id: s.id,
          displayName: s.displayName,
          description: s.describeForModel?.() ?? s.displayName,
        })),
      }, state.signal);

      if (decision.skillId === "github-project-discovery") {
        // 用 LLM 判定的 skillId 直接路由（走与现有 skill 命中相同的决策构造）
        return this.buildSkillDecision(this.skills.get(decision.skillId)!, goal, state, decision.query);
      }
      // 其他 skill 或 null → 维持 unsupported（并可在 reason 里附上模型解释）
      return {
        type: "ROUTE_RESOLVED" as const,
        decision: {
          ...deterministic.decision,
          reason: `${deterministic.decision.reason}（模型意图分类：${decision.reason}）`,
        },
      };
    } catch {
      // 超时 / 校验失败 / 模型不可用 → 回退现状
      return deterministic;
    }
  }
}
```

配套小改：

- `DomainSkill` 接口新增可选 `describeForModel?(): string`（给模型的 skill 一句话说明）；
  `GitHubProjectDiscoverySkill` 实现为：
  `"用户想从 GitHub 找开源项目（可按名称、热度、时间窗口检索并固定 commit 下载）"`。
- 路由阶段原来在 `machine.ts` / services 里同步调用 `route()` 的地方改为 `await`；
  事件类型与 `RouteDecision` 结构不变。
- 关键：**仅当正则落空才调 LLM**。`"帮我找一个tau的项目"` 这种能被 `explicitRepositoryName`
  命中的输入，仍走确定性分支，零成本。

### 5.5 Prompt 骨架（供 `buildIntentModelContext` 参考）

```text
你是任务路由分类器。根据用户任务，从可用能力中选择最匹配的一项，或返回 null。

可用能力：
- github-project-discovery：从 GitHub 检索/定位开源项目，可按名称、热度、时间窗口排序，并可固定 commit 下载源码。
- local-development-environment-inspection：只读盘点本机开发工具版本。
- ai-development-environment / research-data-environment：准备受控目录中的开发/科研资源。
- ...（其余 skill 的 describeForModel）

用户任务：{task}
用户提供的链接：{links}
本机环境概况：{profile}

要求：
1. 优先根据语境推断意图，例如只说 "tau" 且上下文是编程/开源软件，应归类到 github-project-discovery。
2. 若任务与本机只读探测相关（关键词：查看/检查/是否安装/版本/兼容性），不要误判为 github 检索。
3. 仅当 skillId 为 github-project-discovery 时，可给出建议搜索词 query（直接给用户原话中的关键 token）。
4. 输出严格 JSON，schema 见系统约定。无法确定时 skillId 返回 null。
```

### 5.6 风险控制

- **成本**：只有正则 100% 落空的输入才调 LLM（这类输入占比小，且多为低价值重复场景）。
- **时延**：`timeoutMs` 默认 8s，超时抛错 → 回退正则结果。
- **幻觉**：zod `.strict()` 校验 + 只允许枚举 skillId + `decisionId` 唯一性，非法输出直接丢弃。
- **循环**：分类结果与确定性结果冲突时，**以确定性结果为准**（LLM 只做"补位"，不做"覆盖"）。

---

## 6. Phase 3 — 候选→验证→收敛（检索后精排）

### 6.1 思路

Phase 1 让 `q=tau` 能搜到候选，但可能返回一堆同名仓库。Phase 3 在搜索桥拿到 top N 后，
把候选摘要回注 LLM，让它结合**原始意图**挑选最匹配的 1-3 个并说明理由——这就是
"提出候选 → 工具验证 → 收敛答案"的完整闭环（也是我（pi）这次帮你找 tau 时实际做的事）。

### 6.2 修改点

- `githubSearch.ts`：`GitHubRepositorySearchOutput` 新增**可选**字段
  `recommendation?: { selectedFullNames: string[]; reason: string }`（向后兼容，不破坏现有校验）。
- `agentServices.ts`：`search_github_repositories` 桥接调用成功后，若输出为 discovery/name 模式
  且候选数 > 1，调用分类器（复用 Phase 2 的 `IntentClassifier` 或新增 `CandidateSelector`）精排。

### 6.3 代码骨架

```typescript
// intentClassifier.ts —— 新增 CandidateSelector（可与 IntentClassifier 同一实现类）

export interface CandidateSelector {
  select(input: {
    task: string;
    candidates: Array<{
      fullName: string;
      description: string | null;
      stars: number;
      language: string | null;
      topics: string[];
    }>;
  }, signal?: AbortSignal): Promise<{ selectedFullNames: string[]; reason: string }>;
}

export const candidateSelectionSchema = z.object({
  decisionId: z.string().trim().min(1).max(160),
  provider: z.enum(["remote-llm"]),
  model: z.string().trim().min(1).max(160),
  selectedFullNames: z.array(z.string().trim().min(1).max(200)).min(1).max(3),
  reason: z.string().trim().min(1).max(2000),
}).strict();
```

```typescript
// agentServices.ts —— search_github_repositories 成功后（紧接 successResult 之前）

if (
  (call.input.mode === "discovery" || call.input.mode === "name") &&
  result.output.repositories.length > 1 &&
  this.candidateSelector
) {
  try {
    const selection = await this.candidateSelector.select({
      task: state.task,
      candidates: result.output.repositories.map((r) => ({
        fullName: r.fullName,
        description: r.description,
        stars: r.stars,
        language: r.language,
        topics: r.topics,
      })),
    }, options?.signal);
    result.output = { ...result.output, recommendation: selection };
  } catch {
    // 精排失败不影响主结果，原样返回
  }
}
```

### 6.4 验证

- 输入 `tau` → 返回列表含多个 `tau` 同名仓库时，`recommendation.selectedFullNames`
  应包含 `huggingface/tau`（描述含 "coding agent"），且 `reason` 可解释。
- 校验失败/超时 → `recommendation` 缺失，结果照常可用（现有 UI 与审批流程不感知新字段）。

---

## 7. 兼容性与回退策略

| 场景 | 行为 |
|---|---|
| 无分类器注入（`classifier` 未配置） | 完全保持现状（`route` 同步、纯正则） |
| LLM 超时 / 无网络 / API 错误 | 抛错 → 回退正则结果 |
| zod 校验失败（模型输出非法） | 抛错 → 回退正则结果 |
| 分类结果与确定性结果冲突 | 以确定性结果为准 |
| 精排失败 | 返回未精排的原始搜索结果 |
| 恢复/重试（`sameGitHubSearchInput`） | Phase 1 的 `buildDiscoveryQuery` 为纯函数，输入可复现，契约不变 |
| 会话持久化 / TaskPlan / Manifest / 审批 | 全部不动 |

---

## 8. 测试计划

### 8.1 单元测试（新增）

| 文件 | 用例 |
|---|---|
| `githubSearch.test.ts`（扩展现有） | `buildDiscoveryQuery("tau") === "tau"`；去停用词；纯函数幂等；`githubSearchInputFromState` discovery 分支 keywords 不再为空 |
| `intentClassifier.test.ts`（新增） | mock `ModelRuntime`：合法决策通过、非法输出抛错、超时抛错、`skillId` 枚举校验 |
| `intentSchemas.test.ts`（新增） | `routeIntentDecisionSchema` / `candidateSelectionSchema` 的合法/非法样本 |
| `router.test.ts`（扩展） | 注入 fake classifier：正则落空时按 LLM 结果路由；LLM 失败时回退 `unsupported`；确定性分支不触发 LLM（用 spy 断言未调用） |
| `agentServices.test.ts`（扩展） | 搜索桥返回多候选时精排字段注入；精排失败不影响主结果 |

### 8.2 集成测试

- 机器状态机：`SUBMIT_TASK("tau")` → 路由 → （Phase 2 后）`ROUTE_RESOLVED` status 为 `supported`，
  skillId 为 `github-project-discovery`，随后进入 clarification（时间窗口/排序）→ planning → 搜索。

### 8.3 回归

- 现有 65 个测试文件全部保持绿（重点：`githubSearch.test.ts`、`router`/`mockServices` 相关、
  `agentSession*` 系列，确保 `sameGitHubSearchInput` 与事件流不受影响）。

---

## 9. 风险与边界

1. **LLM 误分类**：例如把"本地查版本"误判成 github 检索。缓解：确定性分支优先 + `describeForModel`
   写清边界 + 分类 prompt 里的反例说明。
2. **成本膨胀**：若某轮对话反复触发分类（每次 1 次 LLM 调用）。缓解：仅正则落空才调；
   可再加"同一 task 的 `routeIntentDecision` 按 `decisionId` 缓存"。
3. **时延敏感**：路由阶段新增一次网络往返。缓解：8s 超时 + 并行化（分类与确定性分支可并行，
   确定性命中则丢弃分类结果）。
4. **搜索词质量**：`buildDiscoveryQuery` 去停用词可能误删有意义的词（如 "repo" 本身是搜索目标）。
   缓解：停用词表保守，且语言关键词追加为附加词不丢弃。

---

## 10. 实施顺序与验收标准

| 顺序 | 里程碑 | 验收标准 |
|---|---|---|
| 1 | Phase 1 合并 | `SUBMIT_TASK("帮我找一个tau的项目")` 与 `SUBMIT_TASK("tau")` 都能命中 `github-project-discovery` 并返回含 `huggingface/tau` 的候选；现有测试全绿 |
| 2 | Phase 2 合并 | 裸词 `tau` 不再走 `unsupported`；无模型/离线环境行为与 Phase 1 前完全一致；`mockServices` 注入 fake classifier 的集成测试通过 |
| 3 | Phase 3 合并 | discovery 结果带 `recommendation`；同名仓库歧义场景由 LLM 收敛；精排失败不影响主流程 |

---

## 附录：涉及文件清单

```
修改：
  src/features/agent-core/githubSearch.ts          # Phase 1 + Phase 3 输出类型
  src/features/agent-core/router.ts                # Phase 2：route() 支持 LLM 补位
  src/features/agent-core/interfaces.ts            # Phase 2：AgentRouter.route 可 async
  src/features/agent-core/domainSkills.ts          # Phase 2：DomainSkill.describeForModel 可选字段
  src/features/agent-core/mockServices.ts          # Phase 2：注入 LlmIntentClassifier
  src/features/agent-core/agentServices.ts         # Phase 3：搜索桥后处理精排
  src/features/agent-core/agentSchemas.ts          # Phase 2/3：action union 扩展（若走方案 A）
  src/features/agent-core/types.ts                 # Phase 3：GitHubRepositorySearchOutput.recommendation（可选）

新增：
  src/features/agent-core/intentSchemas.ts         # routeIntentDecisionSchema / candidateSelectionSchema
  src/features/agent-core/intentClassifier.ts      # IntentClassifier / CandidateSelector / LlmIntentClassifier

不改：
  src/features/agent-core/agentLoop.ts             # 执行循环不动
  src/features/agent-core/machine.ts               # 状态机事件与转移不动（仅 route 调用点 await）
  src/features/agent-core/taskPlan*.ts             # 计划/审批模型不动
  src/features/agent-core/persistence.ts           # 持久化不动
```
