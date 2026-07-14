# 迅雷 AI Task Agent 项目交接文档

## 1. 交接快照

- 交接日期：2026-07-14
- 本地目录：`/Users/zhuweiyu/xunlei-ai-task-agent`
- GitHub：`https://github.com/yogurt-stack/XL-Agent`
- 当前分支：`main`
- P0 前基准提交：`6c879a1 feat: add model-driven agent recovery flow`
- 交接前仓库状态：本地 `main` 与 `origin/main` 同步
- 技术栈：Electron、React、TypeScript、Vite、lucide-react、原生 CSS

本文件是在上述基准提交之后新增，并与后续 P0 稳定性修复一同纳入版本管理。

## 2. 产品定位

产品当前定位不是通用 Codex 替代品，也不是直接安装软件的脚本生成器，而是：

> 一个由模型负责理解与规划、由受控工具负责执行、由可信目录和审批策略保障安全的开发环境资源准备 Agent。

核心价值链路：

```text
自然语言目标
  -> 资源需求理解
  -> 可信资源 BOM
  -> 来源、版本、授权和依赖检查
  -> 用户审批
  -> 受控获取
  -> 完整性验证
  -> 失败恢复或重规划
  -> Manifest 与工作区交接
```

安装软件、修改系统环境、编写项目代码等高风险动作，后续可以交给独立执行 Agent。当前的 Agent B 仍是交接数据模拟，不是真实第二个 Agent。

## 3. 当前完成情况

### 3.1 Electron 与工程基础

已经完成：

- Electron 主进程、preload 和 React renderer 分层。
- `contextIsolation: true`。
- `nodeIntegration: false`。
- Electron sandbox 已启用。
- `getAppInfo` IPC 示例。
- 模型决策 IPC。
- `npm run dev`、`npm run build`、`npm run typecheck`、`npm run verify:agent-core`。
- Vite production build 使用相对资源路径，可由 Electron `loadFile` 正确加载。
- `npm run verify:production-build` 会验证构建产物中的相对资源路径及文件存在性。
- `.env` 已加入 Git 忽略规则，`.env.example` 可以安全提交。

### 3.2 Agent 状态机

同一份 `AgentState` 驱动首页、澄清、计划、执行和工作区页面。

当前阶段：

```text
intake
routing
clarifying
planning
waiting_approval
downloading
awaiting_failure_action
verifying
replanning
handoff
cancelled
```

已经实现：

- 任务输入后进入模型路由。
- 一次只询问一个关键问题。
- 模型生成可信目录资源计划。
- 每个计划具有 revision。
- 用户确认后才进入下载阶段。
- 下载失败、版本不匹配和取消必需资源可以触发恢复或重规划。
- 任何替代计划都必须生成新 revision，并回到 `waiting_approval`。
- Manifest 由当前状态计算生成，不是固定字符串。

### 3.3 最小模型运行时

已经定义：

- `ModelRuntime`
- `ModelContext`
- `ModelDecision`
- `AgentAction`
- `AgentToolCall`
- `ToolResult`
- `PolicyDecision`

当前模型动作：

```text
ask_clarification
create_plan
create_replan
call_tool
finish
```

模型协议不再包含未被 Runtime 消费的 `request_approval` 动作；计划审批由 `create_plan` 和 `create_replan` 进入 `waiting_approval` 统一保证。

Runtime 当前在以下阶段调用模型：

```text
routing
planning
replanning
```

每轮最多执行 6 个模型步骤；用户批准新的 revision 后重新计数。下载和验证不要求模型逐个轮询，以避免无意义的高频模型调用。

### 3.4 自然语言任务支持

本地规则模型当前识别：

- Python AI 开发环境。
- React / Node.js 全栈 AI 环境。
- Git / VS Code 基础开发工具环境。
- 信息不足的模糊开发环境任务。

不同意图会生成不同澄清问题和资源组合，但可信资源仍来自固定内存目录。

### 3.5 远程 LLM

已经完成：

- Electron 主进程从 `.env` 读取模型配置。
- API Key 不进入 Vite renderer bundle。
- 通过 HTTPS 请求兼容 Chat Completions 格式的端点。
- 远程返回值经过 `ModelDecision` 结构校验。
- 远程调用失败或输出非法时回退本地规则模型。
- 独立 `ModelConnectionController` 维护应用级连接状态和实际 provider。
- Electron 提供脱敏配置摘要和“测试连接” IPC。
- 401、超时、网络、HTTP、响应格式和非法 JSON 使用结构化错误码。
- 回退原因会显示在顶部、设置页和执行页；失败后停止逐步骤重复请求远程端点。

环境变量：

```dotenv
XL_AGENT_LLM_ENDPOINT=https://host.example/v1/chat/completions
XL_AGENT_LLM_MODEL=model-id
XL_AGENT_LLM_API_KEY=secret
```

当前缺口：

- 自动测试没有调用真实远程模型。
- 当前配置项是完整请求端点，不是单纯 Base URL。

### 3.6 Agent Tool

当前只有三个 Tool：

| Tool | 当前作用 | 是否真实执行 |
| --- | --- | --- |
| `read_system_profile` | 返回固定 Windows 11 x64 目标画像 | 否 |
| `search_trusted_catalog` | 查询内存可信资源目录 | 否 |
| `simulate_download` | 返回模拟下载进度和固定失败 | 否 |

下载现在统一经过：

```text
Runtime 创建受控 ToolCall
  -> Policy 检查
  -> AgentToolExecutor
  -> ToolResult
  -> 状态机事件
```

旧的 `MockDownloadExecutor` 已删除，下载不会绕过 Agent Tool 接口。

### 3.7 Policy 与审批

当前策略可以：

- 自动允许只读工具。
- 拒绝下载未审批资源。
- 拒绝下载非当前活动资源。
- 要求初始计划审批。
- 要求替代计划重新审批。
- 拒绝与用户失败处置选择不一致的模型重规划策略。

当前 Policy 仍是程序内硬编码规则，没有用户级授权存储、企业策略、审批有效期或字段级权限。

### 3.8 失败恢复

示例项目在 56% 固定返回：

```text
CHECKSUM_MISMATCH
retriable: true
```

失败后进入 `awaiting_failure_action`，不会自动让模型抢先重规划。

用户可以选择：

1. 重试原来源。
2. 使用可信替代来源。
3. 交给 Agent B。

重试和替代来源都会让模型生成新计划，再回到审批。Agent B 分支会生成未完成交接，保持 `workspace.ready = false`。当失败资源本身没有 `fallbackId` 时，即使用户允许备用镜像，也会安全回退到主来源重试策略。

### 3.9 UI

已经完成：

- 首页任务输入。
- 最近任务静态展示。
- 支持 Skill 静态展示。
- 澄清页和询问原因。
- 资源计划详情、勾选、授权、依赖、大小和预计时间。
- 执行进度、模型决策、ToolResult、Policy 审计和操作日志。
- 下载失败人工处置面板。
- 重规划状态和新 revision 确认入口。
- 工作区文件树和 Manifest 预览。
- README、RESOURCE_MANIFEST、AGENTS 预览。
- Agent B 未完成交接提示。
- 响应式窗口布局和资源计划滚动。

仍然缺少：

- ToolResult 聚合与展开详情；当前高频下载结果偏调试器风格。
- 真实最近任务和持久化。
- 真实打开工作目录。
- 完整无障碍与端到端视觉回归测试。

## 4. 当前完整演示流程

```text
输入自然语言任务
  -> 本地规则模型或远程 LLM
  -> read_system_profile
  -> 识别任务意图
  -> 提出一个澄清问题
  -> search_trusted_catalog
  -> create_plan
  -> waiting_approval r1
  -> 用户确认
  -> Policy 检查每个 simulate_download
  -> 模拟下载
  -> 示例项目 56% 校验失败
  -> awaiting_failure_action
       -> 重试原来源
       -> 使用可信替代来源
       -> 交给 Agent B
  -> 前两项进入模型 create_replan
  -> waiting_approval r2
  -> 用户再次确认
  -> 下载完成
  -> 验证
  -> handoff
  -> resource-manifest.json
```

## 5. 完成度评估

以下百分比是相对于完整生产目标的工程估算，不是测试覆盖率：

| 方向 | 当前完成度 | 说明 |
| --- | ---: | --- |
| 高保真比赛 Demo | 85% | 核心流程、失败恢复和交接可演示 |
| Agent Core 协议与状态机 | 80% | 主要状态、动作、Tool 和 Policy 已建立 |
| 最小模型驱动闭环 | 75% | 模型参与理解、规划和重规划 |
| UI 产品流程 | 80% | 主要页面完整，配置和真实历史缺失 |
| 远程 LLM 产品化 | 75% | 已有状态、测试连接、错误可见性和本地回退，仍缺配置编辑与真实端点自动测试 |
| 受控工具执行 | 35% | 接口和策略存在，但工具全部为内存模拟 |
| 工作区真实交付 | 30% | 预览完整，但没有真实文件和目录 |
| 生产可用性 | 20% | 缺少持久化、真实执行、权限审计和发布体系 |

当前阶段结论：

> 项目处于“比赛可演示的最小垂直 Agent MVP”阶段，已经超过固定流程 UI Demo，但尚未进入真实资源执行和生产化阶段。

## 6. 已完成的优先级

原优先级：

1. 让模型参与 replanning，并让模拟下载统一经过 Agent Tool。
2. 补齐失败后的重试、替代来源和 Agent B 人工决策。
3. 增加模型连接状态、测试连接和回退原因。
4. 增加严格计划验证器。
5. 增加 Agent Core 单元测试和 UI 冒烟测试。
6. 最后考虑真实下载、文件、SQLite、MCP 和插件。

完成状态：

- 第 1 项：完成。
- 第 2 项：完成。
- 第 3 项：完成。
- 第 4 项：未开始，是下一目标。
- 第 5 项：部分完成，已有综合场景、模型客户端和 Electron renderer 冒烟脚本，但没有正式测试框架。
- 第 6 项：未开始，并且仍应保持低优先级。

## 7. 本轮完成：模型连接可观测性

已经完成：

1. 独立应用级 `ModelConnectionController`，不会随任务重置。
2. 未配置、已配置、检测中、远程可用、回退本地和连接失败状态。
3. Electron 脱敏配置摘要、测试连接和结构化错误 IPC。
4. 顶部 provider 状态、设置页、安全配置摘要和执行页回退原因。
5. 远程失败熔断；重新测试成功后恢复远程优先。
6. 未配置、非 HTTPS、401、超时、非法响应、非法 JSON、成功和回退测试。
7. 隐藏 Electron production renderer 冒烟测试，覆盖设置导航和测试连接状态切换。

## 8. 后续目标

### 严格计划验证器

至少校验：

- 必需资源是否齐全。
- 依赖是否闭合。
- 资源 ID 是否来自可信目录。
- 版本和目标系统是否兼容。
- 来源和授权是否符合策略。
- 用户审批是否绑定正确 revision。
- 模型是否尝试遗漏基础资源或绕过审批。

### 测试体系

建议引入 Vitest 和 Playwright，分别覆盖：

- 状态机纯函数单元测试。
- Policy 允许、拒绝和审批分支。
- Tool 输入输出校验。
- 远程模型结构验证和回退。
- 首页到交接的 UI 冒烟流程。
- 三个失败处置按钮的点击路径。

### 真实能力

严格计划验证器和测试完成后，再逐步引入：

- 真实目标系统画像读取。
- 真实下载器。
- SHA256 和数字签名验证。
- 临时目录和原子文件写入。
- Manifest、README 和交接包真实导出。
- SQLite 任务恢复。
- MCP、插件和受控脚本执行。

## 9. 必须保持的架构约束

- React 只能渲染状态和派发事件，不能放 Agent 规则。
- 所有状态转移必须经过 `machine.ts`。
- 模型只能提出结构化动作，不能直接操作系统。
- 所有执行动作必须经过 Policy 和 Agent Tool。
- Tool 只能执行预注册能力，禁止 `eval` 和任意 Shell。
- 替代计划必须进入新的 revision 并重新审批。
- 用户选择的恢复策略必须约束模型重规划结果。
- API Key 只能保留在 Electron 主进程。
- 不得使用 `VITE_` 前缀暴露密钥。
- 当前阶段继续保持无真实下载、无文件写入、无 SQLite。
- 不要把项目扩展成通用编码 Agent；优先强化可信资源准备、审计和交接。

## 10. 已知注意事项

- 直接在普通浏览器打开 Vite 页面时没有 Electron preload，会使用本地规则模型。
- 修改 `.env` 后必须重启 Electron 主进程。
- 当前 `XL_AGENT_LLM_ENDPOINT` 必须填写完整 Chat Completions 请求地址。
- 远程失败会展示结构化原因并回退本地；需要在设置页重新测试才能恢复远程优先。
- `read_system_profile` 当前返回固定 Windows 11 x64，而且系统画像已经存在于 AgentState，因此它主要用于演示 Tool 协议。
- 当前所有下载、时间戳、校验、工作区和 Agent B 都是模拟数据。
- 当前 ToolResult 会记录每次进度调用，最终产品应默认聚合、失败突出、详情可展开。
- 当前 GitHub CLI 令牌曾显示失效，但 Git HTTPS push 在提交 `6c879a1` 时成功；如后续 `gh` 操作失败，需要重新执行 `gh auth login`。

## 11. 关键文件

| 文件 | 作用 |
| --- | --- |
| `src/features/agent-core/types.ts` | Agent 状态、事件、动作、工具和策略协议 |
| `src/features/agent-core/machine.ts` | 唯一纯状态转换内核 |
| `src/features/agent-core/runtime.ts` | 模型循环、调度、Policy 和 Tool 编排 |
| `src/features/agent-core/interfaces.ts` | 模型、工具、策略和 Runtime 接口 |
| `src/features/agent-core/localRuleModel.ts` | 本地确定性模型 |
| `src/features/agent-core/remoteModel.ts` | 远程模型校验与本地回退 |
| `src/features/agent-core/modelConnection.ts` | 应用级模型连接状态、测试和回退熔断 |
| `src/features/agent-core/agentServices.ts` | 三个内存 Tool 和默认 Policy |
| `src/features/agent-core/mockServices.ts` | 无模型兼容路径和模拟验证 |
| `src/features/agent-core/catalog.ts` | 固定 Windows 画像和可信资源目录 |
| `src/features/agent-core/manifest.ts` | 根据 AgentState 计算 Manifest |
| `src/features/agent-core/useAgentCore.ts` | React 与 Runtime 适配 |
| `src/components/AgentViews.tsx` | 六个主要业务页面与模型设置 |
| `electron/main.ts` | Electron 窗口、环境变量和模型 IPC |
| `electron/modelClient.ts` | 可测试的远程模型配置、HTTPS 客户端与结构化错误 |
| `electron/preload.ts` | 最小 contextBridge |
| `scripts/verify-agent-core.mjs` | 综合 Agent 场景验证 |
| `docs/agent-runtime-replanning-and-recovery.md` | 本次 Runtime 和失败恢复详细说明 |

## 12. 启动与验证

```bash
npm install
npm run dev
```

验证：

```bash
npm run verify:agent-core
npm run verify:model-client
npm run verify:electron-renderer
npm run typecheck
npm run build
npm run verify:production-build
git diff --check
```

最近一次完整验证结果：

```text
Agent Core scenario passed: revision=4, phase=handoff
Remote model client passed
Electron renderer connection settings smoke passed
TypeScript typecheck passed
Vite production build passed
Production renderer build passed: 2 relative assets verified
Electron production preview loaded dist/index.html successfully
```

## 13. 新对话建议开场

可以在新对话中直接发送：

```text
请先阅读 docs/project-handoff-2026-07-14.md 和当前 Agent Core 代码。
保持现有架构约束，继续完成优先级第 4 项：严格计划验证器。
先核对 catalog.ts、types.ts、machine.ts、agentServices.ts 和现有资源替代关系，
先设计任务需求、能力依赖和计划校验结果，再接入状态机与 Policy，并补充自动测试。
不要接入真实下载、文件写入、SQLite、MCP 或插件。
```
