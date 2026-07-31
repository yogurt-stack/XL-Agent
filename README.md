# 迅雷 AI Task Agent

一个基于 Electron + React + TypeScript + Vite 的桌面端资源编排 Agent MVP。

它实现“用户用自然语言描述目标，Agent 路由并澄清需求，生成可信资源计划，经用户确认后受控下载、验证、重规划并生成可交接工作区”的流程，也支持把只读信息检索任务路由到受控 API Tool，以及把用户明确选择的本地 Git 仓库导入只读 Agent。Electron 主进程负责只读采集脱敏主机画像、本地 Git 检查、GitHub 公开仓库查询、可信资源下载、工作区原子导出和 SQLite 任务持久化；renderer 不能直接访问 Node、文件系统或数据库。GitHub 写入是单独配置、单独计划和单独审批的可选能力，不会继承只读搜索权限。

## 技术栈

- Electron 主进程 + preload
- React + TypeScript + Vite renderer
- lucide-react 图标
- 原生 CSS 样式
- 白名单 IPC：Runtime 快照/用户事件、模型连接测试、历史查询和工作区只读访问
- `nodeIntegration: false`
- Electron Main 托管的纯 TypeScript Agent Core 状态机
- 每轮最多 6 步的异步模型决策循环（用户批准新 revision 后重新计数）
- 本地规则模型与支持原生 `tools/tool_calls` 的 OpenAI Chat Completions 兼容模型自动回退
- 应用级模型连接状态、测试连接、结构化错误和失败熔断
- 受控工具、权限策略和内存审计轨迹
- Electron 主进程只读采集脱敏主机画像，不暴露用户名、主机名、Home 路径、环境变量或完整 shell 路径
- ToolResult 按工具聚合、错误自动展开和键盘可达的执行日志
- 基于任务能力、依赖、目标系统、来源、授权和 revision 的严格计划验证
- 基于 SQLite 的任务快照、目录/计划指纹审批记录和工作区导出记录
- 只读历史任务列表与详情查阅，不影响当前 Agent 状态机
- `LocalXunleiAdapter` 下载边界、流式写盘、实时速度/ETA、暂停、恢复和取消
- 本地文件/目录递归接入、SHA256 匹配和用户自选工作区目录
- Electron Main 真实制品重哈希验证，不在生产链路使用 `MockVerifier`
- 独立递增的 Manifest snapshot revision，以及 `preparing`、`ready`、`partially_ready`、`failed` 状态
- 已注册的只读 Agent B：有限步主循环、`inspect_workspace` 工具、task/revision/TTL 权限和 SQLite 运行审计
- 目录条目 `active/deprecated/revoked` 生命周期、审批目录版本固定和 P1 供应链操作审计
- Windows Authenticode、预期发布者与 SHA256 三层制品校验，以及可失败关闭的平台边界
- HTTP Range / If-Range 断点恢复；服务端忽略 Range 时安全重下，区间不一致时拒绝写入
- 已安装的科研数据第二 Domain Skill、专属工作区模板与 Main 动态能力清单
- GitHub 项目获取 Domain Skill：搜索最多 10 个明确开源仓库，固定默认分支 commit，经独立审批后下载源码归档；Agent B 检查后可再审批 package-lock 离线依赖
- 本地 Git 仓库只读导入：固定 HEAD、分支、dirty 状态、文件清单和生态分析；绝对源路径只在 Main 当前会话内保存
- 审批后 GitHub 发布：独立写 Token、计划 SHA256、十分钟审批窗口、clean HEAD 复核和 create-only/no-force 策略
- OpenAI-compatible Endpoint/Base URL 双配置模式和未知 Provider 失败关闭
- SQLite v5 两步 Demo 重置、维护审计与 Windows x64 NSIS/ZIP 打包链路

## P0 资源编排

本轮 P0 已完成五个基础闭环：

1. 下载任务进入 SQLite `download_tasks`，响应体按流写入临时文件；执行页显示字节数、速度和 ETA，并提供暂停、恢复、取消。
2. 计划页可直接选择本地文件或目录，也可在审批前选择工作区根目录。本地文件在 Main 进程递归扫描、限制数量/总大小、拒绝符号链接并计算 SHA256。
3. `ElectronArtifactVerifier` 会重新读取普通文件，核对字节数、SHA256、可信计划与来源 Host；锁文件 npm tarball 还会复核 SHA512，再把 `downloaded` 提升为 `verified`。
4. 每次持久化状态转换都会生成独立 Manifest revision，并原子更新 `<workspace>/<task>/current` 下的 JSON、Markdown、README 和 AGENTS 说明。
5. Agent B 以 `workspace-inspector` 注册，只允许调用 `inspect_workspace`；用户可在失败交接或就绪工作区主动运行。权限绑定 task ID、plan revision、grant ID 和五分钟 TTL，结果写入 `agent_b_runs`。

应用重启时，仍在下载或暂停的任务会保留最后进度并转为 `interrupted`，同时撤销旧执行审批。重新审批后，如果受控断点文件仍是普通文件、服务端接受匹配的 `Range/If-Range` 且最终完整 SHA256 一致，下载会从已写字节继续；服务端返回 `200` 时会清空旧断点并安全重下，错误 `Content-Range` 会失败关闭。

完整设计、权限边界和验收矩阵见 [`docs/p0-resource-orchestration-2026-07-26.md`](docs/p0-resource-orchestration-2026-07-26.md)。

## P1 供应链安全与恢复

P1 在保持“只准备资源、不自动安装或执行”的前提下完成四个增量闭环：

1. 可信目录支持 `active`、`deprecated`、`revoked`；非 active 条目和替代项不能进入新计划。
2. 每次 plan revision 审批会固定 `catalogVersion + sourceSha256` 和不可变计划指纹；目录、目标路径或资源元数据变化时，Main 进程拒绝执行并要求重新审批。
3. Windows 目标的 Authenticode 资源必须同时通过文件重哈希、Windows 系统签名状态和预期发布者匹配，结果写入 SQLite、Manifest 与历史审计。
4. 下载断点保存路径、字节数、ETag/Last-Modified 和 Range 能力；跨重启恢复仍沿用 revision 审批、Host allowlist、大小上限和最终 SHA256。

签名检查是 Electron Main 内部的固定用途系统检查：它只调用固定编码的 `Get-AuthenticodeSignature` 读取系统信任结果，文件绝对路径通过子进程环境变量传递，不接受模型、用户或资源内容提供的命令文本，也不注册 Shell/PowerShell Tool。非 Windows 主机对 `required` Authenticode 返回 `unavailable` 并失败关闭；测试只能通过显式注入的验证器替身覆盖该平台边界。

完整实现与验收矩阵见 [`docs/p1-supply-chain-resilience-2026-07-26.md`](docs/p1-supply-chain-resilience-2026-07-26.md)。

## P2 平台扩展

P2 将原计划中的“第二领域 Skill 不修改 Core”从单元测试骨架提升为默认产品能力：

1. `research-data-environment` 拥有独立匹配、澄清、能力需求、指南和 `research-data-workspace` 模板。
2. 离线模型对所有 Domain Skill 统一按能力集合选择 active 可信资源，不再把新领域重新解释成旧 AI 开发意图。
3. Main 进程通过 Runtime snapshot 发布 Skill、Source Provider 和 Workspace Template 清单；首页和设置页不再硬编码已安装能力。
4. 远程模型支持完整 Endpoint 或 Base URL 二选一；当前只注册 `openai-compatible`，配置冲突和未知 Provider 都会失败关闭。

完整说明见 [`docs/p2-platform-extensibility-2026-07-29.md`](docs/p2-platform-extensibility-2026-07-29.md)。

## P3 Demo 与 Windows 分发

P3 完成原计划阶段 5 的 Demo 重置、固定演示脚本与 Windows 打包：

1. 设置页两步确认后，由 Main 在 SQLite v5 事务中清除任务运行数据；独立维护事件保留重置时间和数量。
2. 文件清理只覆盖应用管理的临时下载与默认工作区，显式配置或用户自选目录不会被递归删除。
3. `electron-builder` 生成 Windows x64 NSIS、ZIP 与 unpacked 应用；ASAR 验证明确拒绝 `.env`。
4. CI 在全新 Windows runner 上构建、验包并启动打包后的 exe，再上传 14 天内部 Demo 产物。

当前产物未配置项目签名证书，只是内部 unsigned Demo；公开发布前仍需签名和 Windows 11 实体机验收。完整说明见 [`docs/p3-demo-distribution-2026-07-29.md`](docs/p3-demo-distribution-2026-07-29.md)，固定演示流程见 [`docs/p3-three-minute-demo-script.md`](docs/p3-three-minute-demo-script.md)。

## 启动

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
```

构建会依次执行 renderer 类型检查、Electron 主进程编译和 Vite production build。

验证 Electron `loadFile` 使用的 production renderer 资源路径：

```bash
npm run verify:production-build
```

## 正式测试

项目使用 Vitest 运行 Agent Core 的正式测试。测试运行在 Node 环境中，不依赖 Electron 窗口或远程模型配置。

```bash
# 交互式监听
npm test

# 单次运行，适用于 CI
npm run test:run

# 单次运行并生成 text、HTML 和 LCOV 覆盖率报告
npm run test:coverage
```

覆盖率产物写入 `coverage/`，不会进入版本管理。现有 `verify:*` 脚本在正式测试迁移完成前继续作为综合回归基线。

当前正式测试按职责覆盖严格计划验证、状态机 revision 审批、下载进度与暂停/恢复、Agent 注册、Policy/Tool 边界、系统画像契约、Runtime 下载失败恢复、历史任务返回值校验以及成功或未完成的 Manifest 交接。每类规则使用独立测试文件，便于直接定位回归所在层级。

Electron 端到端测试使用 production renderer、真实 preload、本地规则模型和临时 SQLite，覆盖首页到交接、三个失败处置按钮、重启恢复、审批过期和历史任务查阅：

```bash
npm run test:e2e
```

E2E 固定单 worker 运行，显式禁用远程模型配置，并向真实 Electron renderer 注入 axe-core 扫描关键页面的 serious/critical 无障碍问题。测试还会验证 ToolResult 聚合详情、主动和失败路径 Agent B 检查，并在与 CI 一致的 Linux 环境比较首页、失败处置、可信替代计划和就绪工作区视觉基线。macOS 本地继续运行完整功能与无障碍断言，但不比较 Linux 字体渲染基线。失败时会在 `test-results/` 中保留页面截图、视觉差异图和 Playwright trace，HTML 报告写入 `playwright-report/`。

## 持续集成

GitHub Actions 会在推送到 `main`、针对 `main` 的 Pull Request 以及手动触发时运行三个独立 Job：

- `quality`：类型检查、Vitest 覆盖率、Agent Core、模型客户端、下载客户端、SQLite、P0/P1/P2/P3 专项验证、Windows 打包配置和 production build。
- `electron-e2e`：在 Linux Xvfb 环境中运行 Electron 状态机、恢复、Agent B、历史查阅、无障碍扫描和视觉基线比较。
- `windows-package`：在 Windows x64 runner 构建 NSIS/ZIP，检查 ASAR 和密钥排除，并在 packaged exe 内完成失败恢复、工作区落盘和 Agent B 校验后上传 unsigned Demo 产物。

本地可以运行与快速质量门禁相同的命令：

```bash
npm run verify:ci
```

Electron E2E 失败时，CI 会保留 `playwright-report/`、`test-results/`、截图和 trace，便于复现失败路径。工作流只申请仓库内容读取权限，不需要远程模型密钥。

## Agent Core 验证

```bash
npm run verify:agent-core
npm run verify:p0-resource-orchestration
npm run verify:p1-supply-chain-resilience
npm run verify:p2-platform-extensibility
npm run verify:p3-demo-distribution
npm run verify:windows-packaging
```

该场景覆盖未知/重复资源、任务能力和依赖闭包、系统/来源/授权策略、revision 审批绑定、必需资源取消、下载失败暂停、主来源重试、可信替代来源、Agent B 未完成交接和最终 Manifest。

## 可选远程 LLM

默认不需要任何配置，应用使用 `LocalRuleModelRuntime` 离线运行。若要连接兼容 Chat Completions 请求格式的 HTTPS 模型端点，在项目根目录 `.env` 中填写：

```dotenv
XL_AGENT_LLM_PROVIDER=openai-compatible

# 下面二选一
XL_AGENT_LLM_ENDPOINT=https://your-model-host.example/v1/chat/completions
# XL_AGENT_LLM_BASE_URL=https://your-model-host.example/v1

XL_AGENT_LLM_MODEL=your-model-id
XL_AGENT_LLM_API_KEY=your-secret
```

可参考 `.env.example`。保存后需要重新运行 `npm run dev`，因为 Electron 主进程只在启动时加载 `.env`。这些变量只由 Electron 主进程读取，不使用 `VITE_` 前缀，也不会进入 renderer bundle。远程请求失败、未配置或返回结构不合法时，`FallbackModelRuntime` 会自动使用本地规则模型继续演示。

Endpoint 与 Base URL 只能配置一个；Base URL 会由 Main 规范化并追加 `/chat/completions`。应用顶部和“设置”页面会显示当前 provider、端点模式、脱敏主机、模型 ID 和回退原因。“测试连接”会通过 Electron 主进程验证 HTTPS、鉴权、Chat Completions 响应和原生 `tool_call` 结构，API Key 不会返回 renderer。远程失败后当前任务会使用本地规则模型，避免每个模型步骤重复等待失败端点；重新测试成功后恢复远程优先。

为兼容 DeepSeek 等标准 Chat Completions 实现，请求不会发送 Provider 专属的
`strict` 或 `parallel_tool_calls` 参数。单次 Tool Call、非空字段、数量上限和额外字段拒绝仍由
Main 内部的 Zod 协议解析、状态机和 Policy 强制执行；HTTP 错误只显示经过长度限制与密钥脱敏的
Provider 错误摘要。连接 `api.deepseek.com` 时，Main 会显式关闭 DeepSeek 思考模式，因为当前
受控 Agent 每一步都要求返回原生 Tool Call；该字段不会发送给其他 OpenAI-compatible Host。
DeepSeek 返回的 Tool Call 外层可能包含 `index` 等 Provider 元数据；Main 仅忽略这些外层元数据，
仍严格校验 `id`、`type`、函数名、JSON 参数、单调用数量和当前 Tool 白名单。

模型连接和 Electron renderer 验证：

```bash
npm run verify:model-client
npm run verify:electron-renderer
```

## GitHub API Tool

输入“帮我查找 GitHub 最新最热门的 10 个开源项目”会优先路由到
`github-project-discovery`，而不是被开发环境 Skill 的 `git` 关键词误判。Agent 会先确认项目
新建时间窗口和排序指标，再由 Electron Main 调用固定的
`https://api.github.com/search/repositories`：

- 只执行 `GET` 公开仓库搜索，不注册写入、Release 下载或任意 URL Tool。
- 固定过滤私有仓库、Fork、归档项目和没有明确 SPDX 许可证的结果，最多展示 10 项。
- 模型侧 GitHub 路由只获得 `search_github_repositories` 与 `finish`；用户必须在结果页明确点击某个仓库，Main 才读取详情并生成动态资源计划。
- 不配置 Token 也能查询公开数据；如需更高限流额度，可在 `.env` 中设置
  `XL_AGENT_GITHUB_TOKEN`。该值只由 Main 读取，不进入 renderer、Runtime 快照或模型上下文。
- 结果页展示仓库、Star、Fork、语言、许可证、更新时间和 API 剩余额度；外链只允许打开
  `https://github.com/{owner}/{repo}`。
- “准备到本地”会由 Main 把默认分支解析为不可变 commit SHA，源码只允许从
  `https://codeload.github.com/{owner}/{repo}/zip/{SHA}` 下载。GitHub 不提供该动态 ZIP 的预置
  SHA256，因此下载完成后由 Main 计算并复核，再写入 `sources/` 和 Manifest。
- Main 会读取固定 commit 的 Git tree，报告 package、lockfile 和运行时提示。只有仓库根目录
  `package-lock.json` v2/v3 中所有外部包都具备固定 `registry.npmjs.org` 地址、SHA512 和明确
  许可证，且不超过 250 个独立 tarball，才会开放 npm 离线依赖准备。
- npm 依赖是第二个 plan revision：必须先完成源码下载、工作区导出和 Agent B 只读检查，再由
  用户单独审批。下载物写入 `dependencies/npm/`；产品不会运行 `npm install`、生命周期脚本、
  仓库代码或任意终端命令。

## 本地仓库导入与审批后发布

首页“选择本地 Git 仓库”会创建 `local-repository-import` 任务。Main 只调用固定参数、`shell: false`
的 Git 读取命令，检查仓库顶层目录、HEAD、分支、porcelain 状态、HEAD tree 和可见文件清单；
不向模型注册 Shell Tool，也不执行 Git hooks、仓库脚本或依赖安装。当前版本要求 `.git` 是仓库
目录中的真实目录，暂不接收 worktree、子模块工作区或符号链接入口。

Renderer、SQLite 状态和 Manifest 只得到仓库名称、随机会话句柄、提交 SHA、无路径指纹、dirty
计数、文件数量和项目结构。绝对源路径保留在 Electron Main 的内存会话映射中；应用重启后必须
重新选择仓库。导入完成后会生成真实 Manifest，Agent B 可通过原有 `inspect_workspace` 只读
grant 检查本地项目准备度。

发布是另一条权限链。要启用它，需要在 `.env` 单独配置：

```dotenv
XL_AGENT_GITHUB_PUBLISH_TOKEN=your-write-token
```

`XL_AGENT_GITHUB_TOKEN` 仍只用于搜索限流，不会回退成发布凭证。发布 Token 必须对应当前用户且
具备创建目标仓库和写入内容的权限；它只在 Main 进程请求 GitHub API 时使用，不进入 renderer、
Runtime 快照、Manifest、日志或模型上下文。

发布分两次显式点击：

1. “生成发布计划”读取当前 GitHub 用户、确认目标仓库不存在，并固定目标、可见性、分支、提交
   说明、文件数、总字节数、源 HEAD/指纹、到期时间和计划 SHA256；此时不发生 GitHub 写入。
2. “批准并创建 GitHub 仓库”先持久化独立审批审计，再重新检查相同 clean HEAD 和文件范围，最后
   通过 GitHub Git Data API 创建仓库、blob、tree、root commit 和分支引用。

首版只创建当前 Token 用户名下的新仓库，不覆盖已有仓库、不追加、不强推、不自动重试写入。
它把固定 HEAD 的文件内容发布为一个新的 root commit，不复制本地仓库原有提交历史。
仓库必须是 clean 状态，且不能包含子模块、符号链接、疑似密钥文件；范围限制为最多 2,000 个
文件、单文件 5 MiB、总量 50 MiB。若仓库已创建但后续上传失败，应用会保留目标链接并停止，
不会自动删除远程仓库。

## 系统画像边界

`read_system_profile` 已经不再只是回传固定状态。Electron Main 会读取平台、架构、系统版本、CPU 数、内存 GB 和默认 shell 文件名，将脱敏结果写入 `ToolResult` 和 Runtime 快照供设置页审计，但不会暴露用户名、主机名、Home 路径、环境变量或完整 shell 路径。

当前可信目录仍只覆盖 Windows 11 x64 目标资源，因此计划校验继续使用锁定的 Windows 目标画像。真实主机画像用于证明只读采集和脱敏边界，不会把当前 macOS/Linux 运行机直接变成资源计划目标。

## 可信资源目录

`catalog/trusted-resources.json` 是资源目录的唯一事实源，Schema 位于
`catalog/trusted-resources.schema.json`。第一批固定版本资源覆盖 Python、VS Code、Git for
Windows、Node.js LTS、PowerShell、Miniforge 及项目固定提交快照；每项都声明 HTTPS 下载地址、
允许的重定向主机、SHA256、大小上限、来源、授权、能力和回退关系。

普通环境准备任务只能查询并选择目录中的资源 ID。Renderer 不提交任意 URL；Electron 主进程会
再次通过同一目录生成物解析 ID，并在下载前后校验 HTTPS Host、大小和 SHA256。GitHub 项目获取
是受限的动态例外：Main 根据搜索结果固定 commit 和 codeload URL；npm 包只能来自同一 commit
锁文件固定的 registry URL，并校验 SHA512。目录过期或生成物与 JSON 不一致时会失败关闭。

```bash
# 修改 JSON 后重新生成 renderer 和 Electron 目录
npm run generate:catalog

# 只校验 Schema、不变量、目录有效期和生成物一致性
npm run verify:catalog
```

目录条目具有 `active/deprecated/revoked` 生命周期；新计划、fallback 和替换目标只接受
`active`。审批记录固定目录版本和源码 SHA256。`signatureEnforcement: required` 的
Windows 制品在固定版本、HTTPS Host allowlist、大小上限和 SHA256 之外，还必须通过
Windows Authenticode 与预期发布者匹配；`checksum-only` 只声明上游固定 SHA256，
不会伪装成嵌入式签名已验证。

## SQLite 与历史任务

Electron 主进程使用 `sql.js` 将任务数据写入 `agent-tasks.sqlite`。默认位置是 Electron `userData` 目录，也可通过 `XL_AGENT_TASK_STORE_PATH` 指定绝对路径。当前 schema v5 包含：

- `task_snapshots`：每个 task ID 最近一次完整状态快照。
- `approval_records`：按 task ID 和 revision 保存本地用户审批、目录版本与目录源码哈希。
- `download_artifacts`：保存下载校验状态、签名状态、预期/实际发布者、证书指纹和检查时间。
- `download_tasks`：保存流式下载状态、断点路径、ETag/Last-Modified、速度、ETA、错误和重启中断信息。
- `local_artifacts`：保存用户显式接入的本地文件哈希、展示路径和可信资源匹配结果；绝对来源路径不写入 Manifest。
- `resource_manifest_snapshots`：保存独立 Manifest revision、plan revision、整体状态和落盘目录。
- `agent_b_runs`：保存 Agent B grant、工具结果、结构化答案与失败原因。
- `operation_events`：保存目录固定/拒绝、断点创建/恢复与签名通过/拒绝事件。
- `maintenance_events`：独立保存 Demo 重置时间、操作者和清理数量，不会被重置操作自身删除。
- `workspace_exports`：按 task ID 和 revision 保存的工作区导出结果。
- `schema_migrations`：数据库迁移版本和执行记录。

侧边栏“历史”页面会按最近保存时间倒序读取任务，显示最新阶段、资源进度、审批、工作区导出、模型/工具审计和运行日志。该页面只有查询权限，不会恢复旧快照、切换当前任务、删除数据或触发模型与工具。

历史任务在当前版本中表示“每个任务的最新快照”，不是每次状态转换的完整事件流。实现与后续边界见 [`docs/task-history-implementation-plan-2026-07-25.md`](docs/task-history-implementation-plan-2026-07-25.md)。

## Windows 打包

```bash
# 生成可启动的 win-unpacked，适合验包
npm run package:win:dir

# 生成 NSIS 安装器、ZIP 和 win-unpacked
npm run package:win

npm run verify:windows-packaging -- release/win-unpacked
npm run test:packaged:win
```

`release/` 不进入版本管理。CI 产物当前未签名；不能将其描述为正式公开发行版。生产依赖审计命令为 `npm audit --omit=dev`，构建工具链的完整审计边界见 P3 文档。

## Agent Runtime 接口

React 不再创建或持有 Runtime；Renderer 只通过 preload 白名单桥接读取 Electron Main 发布的快照，并派发经过 Zod 校验的用户事件。`AgentRuntimeHost` 是模型、路由、状态机、Policy、Tool、SQLite、下载与工作区导出的唯一编排宿主。

- `AgentRuntimeHost`：Electron Main 中的 Orchestrator，负责 Runtime 生命周期、持久化与受控副作用。
- `AgentRuntimePort`：Main 内部 Agent Core 的统一入口。提供读取状态、派发事件、订阅状态变化、启动和停止循环的能力。
- `AgentScheduler`：控制自动步骤何时执行。Demo 使用 `setTimeout`；测试可注入手动调度器，未来可替换成队列或 Electron 调度服务。
- `AgentRouter`：通过注册表返回 `supported`、`needs_links` 或 `unsupported` 三态路由；核心流程不硬编码单一路由。
- `DomainSkillRegistry`：注册可匹配任务、澄清需求和生成工作区指南的领域 Skill。
- `SourceProviderRegistry`：注册可信资源来源，并负责精确解析用户提供的 HTTPS 链接。
- `WorkspaceTemplateRegistry`：按路由选择 Manifest 派生的工作区模板。
- `AgentPlanner`：只在未配置模型的兼容路径中生成固定计划和替代计划。
- `ModelRuntime`：在 `planning` 和 `replanning` 阶段生成结构化决策；远程模型必须返回且只返回一个原生 `tool_call`，参数由严格 Zod Schema 校验。
- `AgentVerifier`：在 `verifying` 阶段由 Electron Main 重新读取制品并核对普通文件属性、字节数、SHA256、可信计划和来源 Host；锁文件依赖额外核对 SHA512。
- `AgentToolExecutor`：通过工具注册表执行脱敏系统画像、可信目录查询、受控下载和工作区导出。
- `AgentPolicy`：在执行动作前返回允许、需要审批或拒绝的策略结果。
- `TaskRequirements`：把自然语言意图和澄清答案转换为确定性的必需能力集合。
- `PlanValidationResult`：在计划生成和审批时记录结构化验证问题；只有当前 revision 验证通过并完成审批后才能执行下载工具。

状态转换仍全部保留在 `machine.ts` 中的纯 `transition` 函数；`runtime.ts` 只编排自动事件、延迟和订阅。因此将来替换真实路由、下载或验证实现时，不需要把业务逻辑移回 React。

## 目录结构

```text
xunlei-ai-task-agent/
  electron-builder.config.cjs
  catalog/
    trusted-resources.json
    trusted-resources.schema.json
  electron/
    agentB.ts
    agentRuntimeHost.ts
    authenticodeVerifier.ts
    artifactVerifier.ts
    downloadClient.ts
    localArtifacts.ts
    main.ts
    manifestSnapshots.ts
    preload.ts
    taskStore.ts
    xunleiAdapter.ts
    tsconfig.json
  scripts/
    dev.mjs
  src/
    components/
    features/agent-core/
    features/task-history/
    styles/
    types/
    App.tsx
    main.tsx
  index.html
  package.json
  tsconfig.app.json
  tsconfig.node.json
  vite.config.mts
```

## Demo 流程

1. 输入任务，例如“帮我准备一个 Windows 下的 AI 开发环境”。
2. Agent 通过 Domain Skill/Source Provider 注册表做三态路由，并一次询问一个澄清问题；不支持的任务会明确停止。
3. 生成可信资源计划 r1，并验证任务能力、依赖、系统、来源和授权；此时可接入本地文件/目录并选择工作区根目录。
4. 审批绑定当前 revision 后，Main 通过流式下载任务执行；用户可以暂停、恢复或取消。
5. 下载失败后停在人工决策点，可选择重试原来源、可信替代来源或运行只读 Agent B 检查当前部分工作区。
6. 真实验证器重哈希制品；每次状态转换持续更新 Manifest v3 snapshot，最终再以 Manifest v2 导出不可变交接包。
7. 工作区页可主动运行 Agent B；结构化答案明确引用 Manifest revision、已准备项、缺失项、允许动作和禁止动作。
