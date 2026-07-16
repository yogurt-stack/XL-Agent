# 迅雷 AI Task Agent

一个基于 Electron + React + TypeScript + Vite 的桌面端高保真交互 Demo。

它模拟“用户用自然语言描述目标，Agent 路由并澄清需求，生成可信资源计划，经用户确认后模拟下载、验证、重规划并生成可交接工作区”的流程。所有资源、下载进度、失败重试和 Manifest 都在前端内存中模拟，不会真实下载文件。默认本地模型不发起网络请求；只有显式配置可选远程 LLM 时才会由 Electron 主进程访问指定 HTTPS 端点。

## 技术栈

- Electron 主进程 + preload
- React + TypeScript + Vite renderer
- lucide-react 图标
- 原生 CSS 样式
- IPC 示例：`getAppInfo`
- `nodeIntegration: false`
- 纯 TypeScript Agent Core 状态机
- 每轮最多 6 步的异步模型决策循环（用户批准新 revision 后重新计数）
- 本地规则模型与可选远程 LLM 自动回退
- 应用级模型连接状态、测试连接、结构化错误和失败熔断
- 受控工具、权限策略和内存审计轨迹
- ToolResult 按工具聚合、错误自动展开和键盘可达的执行日志
- 基于任务能力、依赖、目标系统、来源、授权和 revision 的严格计划验证

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

当前正式测试按职责覆盖严格计划验证、状态机 revision 审批、Policy/Tool 边界、Runtime 下载失败恢复以及成功或未完成的 Manifest 交接。每类规则使用独立测试文件，便于直接定位回归所在层级。

Electron 端到端测试使用 production renderer、真实 preload 和本地规则模型，覆盖首页到交接以及三个失败处置按钮：

```bash
npm run test:e2e
```

E2E 固定单 worker 运行，显式禁用远程模型配置，并向真实 Electron renderer 注入 axe-core 扫描关键页面的 serious/critical 无障碍问题。失败时会在 `test-results/` 中保留页面截图和 Playwright trace，HTML 报告写入 `playwright-report/`。

## 持续集成

GitHub Actions 会在推送到 `main`、针对 `main` 的 Pull Request 以及手动触发时运行两个独立 Job：

- `quality`：类型检查、Vitest 覆盖率、Agent Core、模型客户端和 production build。
- `electron-e2e`：在 Linux Xvfb 环境中运行三个 Electron 失败恢复场景。

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

应用顶部和“设置”页面会显示当前 provider、脱敏端点主机、模型 ID 和回退原因。“测试连接”会通过 Electron 主进程验证 HTTPS、鉴权、Chat Completions 响应和 `ModelDecision` 结构，API Key 不会返回 renderer。远程失败后当前任务会使用本地规则模型，避免每个模型步骤重复等待失败端点；重新测试成功后恢复远程优先。

模型连接和 Electron renderer 验证：

```bash
npm run verify:model-client
npm run verify:electron-renderer
```

## Agent Runtime 接口

React 不再自行维护计时器或自动状态流转；它只订阅 `AgentRuntime` 的状态并派发用户事件。运行时接口位于 `src/features/agent-core/interfaces.ts`，固定 Mock 实现位于 `mockServices.ts`。

- `AgentRuntimePort`：Agent Core 的唯一使用入口。提供读取状态、派发事件、订阅状态变化、启动和停止循环的能力。
- `AgentScheduler`：控制自动步骤何时执行。Demo 使用 `setTimeout`；测试可注入手动调度器，未来可替换成队列或 Electron 调度服务。
- `AgentRouter`：在 `routing` 阶段选择 Skill/路由，并返回 `ROUTE_RESOLVED` 事件。当前固定选择 Windows AI 开发环境。
- `AgentPlanner`：只在未配置模型的兼容路径中生成固定计划和替代计划。
- `ModelRuntime`：在 `routing`、`planning` 和 `replanning` 阶段生成结构化决策；下载失败后先等待用户选择，模型只能按用户选择生成新 revision。
- `AgentVerifier`：在 `verifying` 阶段生成验证结果。当前默认验证通过；UI/测试可显式派发版本不匹配事件以进入重规划。
- `ModelRuntime`：根据当前状态、工具历史和剩余步数生成一项结构化 `ModelDecision`。
- `AgentToolExecutor`：执行协议允许的系统画像读取、可信目录查询和模拟下载工具；全部下载进度与失败都由 `simulate_download` ToolResult 驱动。
- `AgentPolicy`：在执行动作前返回允许、需要审批或拒绝的策略结果。
- `TaskRequirements`：把自然语言意图和澄清答案转换为确定性的必需能力集合。
- `PlanValidationResult`：在计划生成和审批时记录结构化验证问题；只有当前 revision 验证通过并完成审批后才能执行下载工具。

状态转换仍全部保留在 `machine.ts` 中的纯 `transition` 函数；`runtime.ts` 只编排自动事件、延迟和订阅。因此将来替换真实路由、下载或验证实现时，不需要把业务逻辑移回 React。

## 目录结构

```text
xunlei-ai-task-agent/
  electron/
    main.ts
    preload.ts
    tsconfig.json
  scripts/
    dev.mjs
  src/
    components/
    features/agent-core/
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
2. Agent 固定路由到 Windows AI 开发环境 Skill，并一次询问一个澄清问题。
3. 生成可信资源计划 r1，并验证任务能力、依赖、系统、来源和授权；取消必需资源或版本不匹配会进入重规划。
4. 下载失败后暂停在人工决策点，可选择重试原来源、可信替代来源或交给 Agent B。
5. 重试和替代来源由模型生成新计划，严格验证后进入 `waiting_approval`；审批事件必须绑定当前 revision，Agent B 分支生成未完成交接。
6. 验证通过后生成含 `revision` 字段的 `resource-manifest.json` 和工作区交接预览。
