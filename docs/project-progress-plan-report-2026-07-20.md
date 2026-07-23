# 迅雷 AI Task Agent 项目进度、计划与功能完成情况报告

## 1. 报告快照

- 报告日期：2026-07-20；最近更新：2026-07-23
- 本地目录：`/Users/zhuweiyu/xunlei-ai-task-agent`
- GitHub 仓库：`https://github.com/yogurt-stack/XL-Agent`
- 当前主分支最新已合并提交：以 GitHub `main` 最新提交为准
- 当前产品阶段：比赛可演示的最小垂直 Agent MVP
- 当前工程边界：真实只读系统画像已接入；远程模型 JSON-only prompt 已合并；真实下载客户端已具备 URL、Host、大小、SHA256 和临时文件写入边界，但尚未接入 renderer 主流程
- 尚未接入：安装执行、最终工作区真实写入、SQLite、MCP、插件和真实 Agent B

本报告用于替代口头进度说明，帮助后续开发按“受控资源准备 Agent”方向继续推进。

## 2. 产品定位

当前产品不是通用编码 Agent，也不是自动安装脚本工具，而是：

> 一个由模型负责理解与规划、由受控工具负责执行、由可信目录和审批策略保障安全的开发环境资源准备 Agent。

核心链路为：

```text
自然语言目标
  -> 任务意图识别
  -> 关键问题澄清
  -> 可信资源计划
  -> 严格计划验证
  -> 用户审批
  -> 受控工具执行
  -> 失败恢复或重规划
  -> Manifest 与工作区交接
```

## 3. 当前已实现功能

### 3.1 桌面应用与安全基础

- Electron 主进程、preload、React renderer 已分层。
- `contextIsolation: true`。
- `nodeIntegration: false`。
- Electron sandbox 已启用。
- API Key 只保留在 Electron 主进程，不进入 Vite renderer bundle。
- Vite production build 使用相对资源路径，可由 Electron `loadFile` 正确加载。
- `.env` 已加入 Git 忽略规则，`.env.example` 可安全提交。

### 3.2 Agent Core 状态机

当前状态包括：

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

- 用户提交任务后进入模型路由。
- 一次只询问一个关键澄清问题。
- 模型生成可信资源计划。
- 每个计划都有 `revision`。
- 审批必须绑定当前 `revision`。
- 下载失败、版本不匹配、取消必需资源可触发恢复或重规划。
- 替代计划必须生成新 `revision` 并重新回到 `waiting_approval`。
- Manifest 由当前 `AgentState` 计算生成，不是固定字符串。

### 3.3 模型能力

- 已实现本地规则模型，可离线运行。
- 已支持可选远程 LLM。
- 远程 LLM 通过 Electron 主进程 HTTPS 调用。
- 远程返回值会经过 `ModelDecision` 结构校验。
- 远程失败或输出非法时自动回退本地规则模型。
- 应用级 `ModelConnectionController` 维护连接状态。
- 设置页支持测试连接、展示脱敏端点主机、模型 ID 和结构化错误。

当前限制：

- `.env` 中 `XL_AGENT_LLM_ENDPOINT` 仍要求填写完整 Chat Completions 请求地址。
- 自动测试没有调用真实远程模型。
- 本地已有中文 JSON-only prompt 调整，但尚未提交合并。

### 3.4 受控 Tool 与 Policy

当前 Tool：

| Tool | 当前状态 | 说明 |
| --- | --- | --- |
| `read_system_profile` | 已接入真实只读采集 | Electron 主进程采集脱敏主机画像，计划目标仍锁定 Windows 11 x64 |
| `search_trusted_catalog` | 已实现内存查询 | 查询固定可信资源目录 |
| `simulate_download` | 已实现模拟执行 | 返回模拟下载进度和固定失败 |
| `controlled_download` | 已定义受控真实下载契约 | Electron 主进程客户端已实现，renderer 主流程暂未调用 |

Policy 当前可以：

- 自动允许只读工具。
- 要求初始计划审批。
- 要求替代计划重新审批。
- 拒绝未审批下载。
- 拒绝非当前活动资源下载。
- 拒绝与用户失败处置选择不一致的模型重规划策略。
- 下载前检查 `approvedRevision === revision`。

### 3.5 系统画像边界

第六阶段已完成最小真实系统画像读取：

- 采集平台、架构、系统版本、CPU 数、内存 GB、默认 shell 文件名。
- 不采集用户名、主机名、Home 路径、环境变量或完整 shell 路径。
- renderer 只接收脱敏后的摘要。
- ToolResult 明确包含主机画像和锁定的 Windows 目标画像边界。
- 设置页展示“主机画像”和“计划目标”的区别。

当前可信目录仍只覆盖 Windows 11 x64 目标资源，因此真实主机画像不直接决定资源计划。

### 3.6 严格计划验证

已经实现的验证项：

- 空计划。
- 未知资源。
- 重复资源。
- 必需资源未选择。
- 必需能力缺失。
- 依赖能力缺失。
- 系统和架构不兼容。
- 来源不可信。
- 授权许可不允许。
- fallback 非法。
- 资源元数据与可信目录不一致。
- 审批 revision 与当前计划不一致。

验证失败时，模型计划不能进入审批，也不能获得新的 revision。

### 3.7 失败恢复

当前演示中 `sample-project` 会在 56% 模拟返回：

```text
CHECKSUM_MISMATCH
```

用户可以选择：

- 重试原来源。
- 使用可信替代来源。
- 交给 Agent B。

重试和替代来源都会让模型生成新计划，并要求用户重新审批。Agent B 分支会保留失败上下文，生成未完成交接，`workspace.ready = false`。

### 3.8 UI 功能

已经实现：

- 首页任务入口。
- 最近任务静态展示。
- Skill 静态展示。
- 澄清页。
- 资源计划页。
- 计划验证状态展示。
- 执行监控页。
- ToolResult 按工具聚合。
- 失败组自动展开，详情可通过鼠标或键盘访问。
- 下载失败人工处置面板。
- 替代计划确认入口。
- 工作区交接页。
- Manifest、README、RESOURCE_MANIFEST、AGENTS 预览。
- 设置页展示远程模型连接状态和系统画像边界。
- 响应式布局和关键页面滚动稳定性修复。

### 3.9 测试与 CI

已经完成：

- Vitest：7 个测试文件，25 个 Agent Core 测试。
- Playwright Electron E2E：3 条真实 Electron 恢复链路。
- axe-core：关键页面 serious/critical 无障碍扫描。
- Linux CI 视觉回归：5 个关键页面基线。
- GitHub Actions：typecheck、Vitest coverage、Agent Core 验证、模型客户端验证、production build、Electron E2E。

## 4. 计划对照

| 原计划项 | 当前状态 | 结论 |
| --- | --- | --- |
| 模型参与 planning / replanning | 已完成 | 本地规则模型和可选远程 LLM 都走 `ModelDecision` |
| 模拟下载统一经过 Agent Tool | 已完成 | 下载链路已统一为 Policy -> Tool -> ToolResult |
| 失败后的重试、替代来源和 Agent B 决策 | 已完成 | 三条恢复路径均有 E2E 覆盖 |
| 模型连接状态、测试连接和回退原因 | 已完成 | 顶部、设置页和执行页都有可见状态 |
| 严格计划验证器 | 已完成 | 计划生成和审批均受验证器约束 |
| 正式测试体系和 CI | 已完成 | PR #2 已合并，CI 持续运行 |
| 第五阶段稳定性收口 | 已完成 | 视觉基线、无障碍扫描、ToolResult 聚合已完成 |
| 第六阶段系统画像 | 已完成 | 真实只读脱敏采集已合并 PR #4 |
| 远程模型 JSON 输出稳定性 | 已完成 | 中文 JSON-only prompt 和连接测试 prompt 已合并并通过 CI |
| 真实下载器 | 部分完成 | Electron 主进程受控下载客户端已实现，尚未接入 UI 主流程 |
| SHA256 / 数字签名真实校验 | 部分完成 | SHA256 已在下载客户端中校验；数字签名未开始 |
| 临时目录与原子文件写入 | 部分完成 | 下载客户端使用受控临时目录和不覆盖写入；最终工作区原子导出未开始 |
| Manifest / README / 交接包真实导出 | 未开始 | 当前仍是预览 |
| SQLite 任务恢复 | 未开始 | 等真实执行链路稳定后再做 |
| MCP、插件和真实 Agent B | 未开始 | 保持低优先级 |

## 5. 完成度评估

以下百分比是相对于完整生产目标的工程估算，不是测试覆盖率：

| 方向 | 当前完成度 | 说明 |
| --- | ---: | --- |
| 高保真比赛 Demo | 90% | 核心流程、失败恢复、交接、测试和视觉稳定性已成型 |
| Agent Core 协议与状态机 | 88% | 状态、动作、Tool、Policy、验证和审计主链路完整 |
| 最小模型驱动闭环 | 78% | 本地模型稳定，远程模型仍需提升结构化输出稳定性 |
| UI 产品流程 | 82% | 主流程完整，真实历史、配置编辑和真实目录操作缺失 |
| 远程 LLM 产品化 | 78% | 连接状态和回退完整，真实端点自动测试与 provider 适配仍缺 |
| 受控工具执行 | 52% | 只读系统画像已真实化；下载客户端边界已实现，但主流程仍使用模拟下载 |
| 工作区真实交付 | 30% | 预览完整，但没有真实文件和目录 |
| 生产可用性 | 22% | 缺少持久化、真实执行、权限审计和发布体系 |

## 6. 当前主要差距

1. 真实执行能力仍未完整接入主流程。
   当前下载客户端已经具备受控边界和 SHA256 校验，但 renderer 执行链路仍使用模拟下载，工作区和 Agent B 仍是模拟数据。

2. 远程模型协议仍需 provider 适配增强。
   JSON-only prompt 已合并，但不同模型供应商的字段兼容性、base URL 自动拼接和真实端点自动测试仍未完成。

3. 配置体验不够友好。
   `XL_AGENT_LLM_ENDPOINT` 必须填写完整请求地址，而不是 Base URL。后续可以支持 `XL_AGENT_LLM_BASE_URL` 自动拼接 `/chat/completions`。

4. 可信资源目录仍是固定 Windows 目标。
   虽然已经能读取真实主机画像，但跨平台资源目录尚未建立。

5. 工作区交付仍是预览。
   当前没有真实写入 Manifest、README、AGENTS 或脚本文件。

## 7. 下一阶段计划

### 7.1 已完成：远程模型 JSON 输出稳定性

目标：

- 将 `electron/modelClient.ts` 中文 JSON-only prompt 合并到 `main`。
- 保持 `response_format: { type: "json_object" }`。
- 如果模型仍返回非法结构，再增加一次轻量级修复策略或更明确的 provider 适配。

验收：

- `npm run typecheck` 通过。
- `npm run verify:model-client` 通过。
- 设置页“测试连接”对模型输出的 JSON-only 约束更明确，降低 `MODEL_INVALID_DECISION` 风险。

### 7.2 第七阶段：真实下载器最小受控边界

当前状态：已完成最小客户端边界，暂未接入 renderer 主流程。

已完成：

- 只接入可信目录中声明的 URL。
- 下载前由 Policy 校验资源、revision、来源、授权和用户审批。
- 下载到受控临时目录。
- 不覆盖用户文件。
- ToolResult 记录下载 URL 主机、大小、状态、错误码和耗时。
- 独立验证脚本覆盖 URL、Host、HTTP、大小、SHA256 和临时文件写入。

暂不做：

- 安装软件。
- 执行下载后的脚本。
- 写入最终工作区目录。
- SQLite。
- MCP 或插件。

### 7.3 第八阶段：真实校验与交接包导出

目标：

- 对下载文件执行 SHA256 校验。（下载客户端已完成）
- 支持校验失败恢复路径。（基础错误码已完成，UI 主流程接入待做）
- 原子写入 Manifest、README、RESOURCE_MANIFEST 和 AGENTS。
- 工作区页面从预览升级为真实文件状态。

### 7.4 第九阶段：任务恢复与执行审计

目标：

- SQLite 保存任务、revision、ToolResult、Policy 审计和恢复上下文。
- 应用重启后恢复未完成任务。
- 增加用户级授权记录和审批有效期。

### 7.5 后置阶段：MCP、插件和真实 Agent B

只有在真实下载、校验、写入和恢复稳定后，再考虑：

- MCP 工具接入。
- 插件化资源来源。
- 真实 Agent B 执行器。
- 受控脚本运行。

## 8. 必须继续保持的架构约束

- React 只渲染状态和派发事件，不能放 Agent 规则。
- 所有状态转移必须经过 `machine.ts`。
- 模型只能提出结构化动作，不能直接操作系统。
- 所有执行动作必须经过 Policy 和 Agent Tool。
- Tool 只能执行预注册能力，禁止 `eval` 和任意 Shell。
- 替代计划必须进入新的 revision 并重新审批。
- 所有计划和替代计划必须通过 `planValidation.ts`。
- 下载 Policy 必须同时满足 `approvedRevision === revision`。
- API Key 只能保留在 Electron 主进程。
- 真实下载接入 renderer 主流程和最终工作区导出前，继续保持无安装执行、无最终工作区真实写入、无 SQLite、无 MCP、无插件。

## 9. 结论

项目目前已经超过纯 UI Demo，具备可演示 Agent MVP 的关键要素：模型决策、状态机、受控 Tool、Policy、严格计划验证、失败恢复、交接预览、测试体系和 CI。

下一步不应扩展成通用编码 Agent，也不应一次性接入多个真实执行能力。建议按顺序推进：

1. 合并远程模型 JSON-only prompt 修复。
2. 设计并实现真实下载器最小受控边界。
3. 接入 SHA256 校验和失败恢复。
4. 再进入真实工作区文件导出。
5. 最后考虑持久化、MCP、插件和真实 Agent B。
