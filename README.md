# 迅雷 AI Task Agent

一个基于 Electron + React + TypeScript + Vite 的桌面端高保真交互 Demo。

它实现“用户用自然语言描述目标，Agent 路由并澄清需求，生成可信资源计划，经用户确认后受控下载、验证、重规划并生成可交接工作区”的流程。Electron 主进程负责只读采集脱敏主机画像、可信资源下载、工作区原子导出和 SQLite 任务持久化；renderer 不能直接访问 Node、文件系统或数据库。默认本地模型不发起网络请求；只有显式配置可选远程 LLM 时才会由 Electron 主进程访问指定 HTTPS 端点。

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
- 基于 SQLite 的任务快照、审批记录和工作区导出记录
- 只读历史任务列表与详情查阅，不影响当前 Agent 状态机

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

当前正式测试按职责覆盖严格计划验证、状态机 revision 审批、Policy/Tool 边界、系统画像契约、Runtime 下载失败恢复、历史任务返回值校验以及成功或未完成的 Manifest 交接。每类规则使用独立测试文件，便于直接定位回归所在层级。

Electron 端到端测试使用 production renderer、真实 preload、本地规则模型和临时 SQLite，覆盖首页到交接、三个失败处置按钮、重启恢复、审批过期和历史任务查阅：

```bash
npm run test:e2e
```

E2E 固定单 worker 运行，显式禁用远程模型配置，并向真实 Electron renderer 注入 axe-core 扫描关键页面的 serious/critical 无障碍问题。测试还会验证 ToolResult 聚合详情的展开状态，并在与 CI 一致的 Linux 环境比较首页、失败处置、可信替代计划、就绪工作区和 Agent B 未完成交接五个视觉基线。macOS 本地继续运行完整功能与无障碍断言，但不比较 Linux 字体渲染基线。失败时会在 `test-results/` 中保留页面截图、视觉差异图和 Playwright trace，HTML 报告写入 `playwright-report/`。

## 持续集成

GitHub Actions 会在推送到 `main`、针对 `main` 的 Pull Request 以及手动触发时运行两个独立 Job：

- `quality`：类型检查、Vitest 覆盖率、Agent Core、模型客户端和 production build。
- `electron-e2e`：在 Linux Xvfb 环境中运行 Electron 状态机、恢复、历史查阅、无障碍扫描和五个视觉基线比较。

本地可以运行与快速质量门禁相同的命令：

```bash
npm run verify:ci
```

Electron E2E 失败时，CI 会保留 `playwright-report/`、`test-results/`、截图和 trace，便于复现失败路径。工作流只申请仓库内容读取权限，不需要远程模型密钥。

## Agent Core 验证

```bash
npm run verify:agent-core
```

该场景覆盖未知/重复资源、任务能力和依赖闭包、系统/来源/授权策略、revision 审批绑定、必需资源取消、下载失败暂停、主来源重试、可信替代来源、Agent B 未完成交接和最终 Manifest。

## 可选远程 LLM

默认不需要任何配置，应用使用 `LocalRuleModelRuntime` 离线运行。若要连接兼容 Chat Completions 请求格式的 HTTPS 模型端点，在项目根目录 `.env` 中填写：

```dotenv
XL_AGENT_LLM_ENDPOINT=https://your-model-host.example/v1/chat/completions
XL_AGENT_LLM_MODEL=your-model-id
XL_AGENT_LLM_API_KEY=your-secret
```

可参考 `.env.example`。保存后需要重新运行 `npm run dev`，因为 Electron 主进程只在启动时加载 `.env`。这些变量只由 Electron 主进程读取，不使用 `VITE_` 前缀，也不会进入 renderer bundle。远程请求失败、未配置或返回结构不合法时，`FallbackModelRuntime` 会自动使用本地规则模型继续演示。

应用顶部和“设置”页面会显示当前 provider、脱敏端点主机、模型 ID 和回退原因。“测试连接”会通过 Electron 主进程验证 HTTPS、鉴权、Chat Completions 响应和原生 `tool_call` 结构，API Key 不会返回 renderer。远程失败后当前任务会使用本地规则模型，避免每个模型步骤重复等待失败端点；重新测试成功后恢复远程优先。

模型连接和 Electron renderer 验证：

```bash
npm run verify:model-client
npm run verify:electron-renderer
```

## 系统画像边界

`read_system_profile` 已经不再只是回传固定状态。Electron Main 会读取平台、架构、系统版本、CPU 数、内存 GB 和默认 shell 文件名，将脱敏结果写入 `ToolResult` 和 Runtime 快照供设置页审计，但不会暴露用户名、主机名、Home 路径、环境变量或完整 shell 路径。

当前可信目录仍只覆盖 Windows 11 x64 目标资源，因此计划校验继续使用锁定的 Windows 目标画像。真实主机画像用于证明只读采集和脱敏边界，不会把当前 macOS/Linux 运行机直接变成资源计划目标。

## 可信资源目录

`catalog/trusted-resources.json` 是资源目录的唯一事实源，Schema 位于
`catalog/trusted-resources.schema.json`。第一批固定版本资源覆盖 Python、VS Code、Git for
Windows、Node.js LTS、PowerShell、Miniforge 及项目固定提交快照；每项都声明 HTTPS 下载地址、
允许的重定向主机、SHA256、大小上限、来源、授权、能力和回退关系。

Agent 只能查询并选择目录中的资源 ID。Renderer 不提交任意 URL；Electron 主进程会再次通过
同一目录生成物解析 ID，并在下载前后校验 HTTPS Host、大小和 SHA256。目录过期或生成物与
JSON 不一致时会失败关闭。

```bash
# 修改 JSON 后重新生成 renderer 和 Electron 目录
npm run generate:catalog

# 只校验 Schema、不变量、目录有效期和生成物一致性
npm run verify:catalog
```

目录目前记录 Authenticode/上游签名预期，但签名执行仍标记为 `planned`；当前强制执行的是
固定版本、HTTPS Host allowlist、大小上限与 SHA256。正式安装阶段接入前还需在 Windows
主进程侧加入 `WinVerifyTrust`。

## SQLite 与历史任务

Electron 主进程使用 `sql.js` 将任务数据写入 `agent-tasks.sqlite`。默认位置是 Electron `userData` 目录，也可通过 `XL_AGENT_TASK_STORE_PATH` 指定绝对路径。当前 schema v2 包含：

- `task_snapshots`：每个 task ID 最近一次完整状态快照。
- `approval_records`：按 task ID 和 revision 保存的本地用户审批。
- `download_artifacts`：按 task ID、revision 和资源 ID 保存已下载且已校验文件的受控元数据。
- `workspace_exports`：按 task ID 和 revision 保存的工作区导出结果。
- `schema_migrations`：数据库迁移版本和执行记录。

侧边栏“历史”页面会按最近保存时间倒序读取任务，显示最新阶段、资源进度、审批、工作区导出、模型/工具审计和运行日志。该页面只有查询权限，不会恢复旧快照、切换当前任务、删除数据或触发模型与工具。

历史任务在当前版本中表示“每个任务的最新快照”，不是每次状态转换的完整事件流。实现与后续边界见 [`docs/task-history-implementation-plan-2026-07-25.md`](docs/task-history-implementation-plan-2026-07-25.md)。

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
- `AgentVerifier`：在 `verifying` 阶段生成验证结果。当前默认验证通过；UI/测试可显式派发版本不匹配事件以进入重规划。
- `AgentToolExecutor`：通过工具注册表执行脱敏系统画像、可信目录查询、受控下载和工作区导出。
- `AgentPolicy`：在执行动作前返回允许、需要审批或拒绝的策略结果。
- `TaskRequirements`：把自然语言意图和澄清答案转换为确定性的必需能力集合。
- `PlanValidationResult`：在计划生成和审批时记录结构化验证问题；只有当前 revision 验证通过并完成审批后才能执行下载工具。

状态转换仍全部保留在 `machine.ts` 中的纯 `transition` 函数；`runtime.ts` 只编排自动事件、延迟和订阅。因此将来替换真实路由、下载或验证实现时，不需要把业务逻辑移回 React。

## 目录结构

```text
xunlei-ai-task-agent/
  catalog/
    trusted-resources.json
    trusted-resources.schema.json
  electron/
    main.ts
    preload.ts
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
3. 生成可信资源计划 r1，并验证任务能力、依赖、系统、来源和授权；取消必需资源或版本不匹配会进入重规划。
4. 下载失败后暂停在人工决策点，可选择重试原来源、可信替代来源或交给 Agent B。
5. 重试和替代来源由模型生成新计划，严格验证后进入 `waiting_approval`；审批事件必须绑定当前 revision，Agent B 分支生成未完成交接。
6. 验证通过后，Main 从 SQLite 的已校验制品记录复制真实文件到 `downloads/`，重新计算 SHA256，并以 Manifest v2 为单一事实源生成交接文档。
