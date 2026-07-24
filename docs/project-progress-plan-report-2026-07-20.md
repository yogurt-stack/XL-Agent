# 迅雷 AI Task Agent 项目进度、计划与功能完成情况报告

## 1. 报告快照

- 报告日期：2026-07-20；最近更新：2026-07-24
- 本地目录：`/Users/zhuweiyu/xunlei-ai-task-agent`
- GitHub 仓库：`https://github.com/yogurt-stack/XL-Agent`
- 当前主分支最新已合并提交：以 GitHub `main` 最新提交为准
- 当前产品阶段：具备真实受控下载、工作区导出和任务恢复能力的垂直 Agent MVP
- 当前工程边界：Electron 模式已贯通 Runtime、Policy、Tool、IPC、SHA256 校验、原子工作区导出、SQLite 审计和未完成任务恢复
- 尚未接入：安装执行、数字签名校验、MCP、插件和真实 Agent B；可信资源目录仍使用演示下载域名

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
exporting
awaiting_export_retry
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
- 工作区只能在全部选中资源验证完成且审批仍有效时进入 `exporting`。
- 导出失败进入 `awaiting_export_retry`，不能误标记为已交接。
- SQLite 恢复通过 `TASK_STATE_RESTORED` 事件回到状态机；终态任务不会自动恢复。
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
- 当前仅实现 OpenAI-compatible Chat Completions 适配器，尚未实现 Anthropic、Gemini 或 Responses API 适配器。

### 3.4 受控 Tool 与 Policy

当前 Tool：

| Tool | 当前状态 | 说明 |
| --- | --- | --- |
| `read_system_profile` | 已接入真实只读采集 | Electron 主进程采集脱敏主机画像，计划目标仍锁定 Windows 11 x64 |
| `search_trusted_catalog` | 已实现内存查询 | 查询固定可信资源目录 |
| `simulate_download` | 已实现模拟执行 | 返回模拟下载进度和固定失败 |
| `controlled_download` | 已接入 Electron 主流程 | Runtime 经 Policy 审批后只向主进程传资源 ID；主进程从可信目录解析并下载 |
| `export_workspace` | 已接入 Electron 主流程 | 仅对当前已审批 revision 原子导出固定交接文件，不执行安装或任意 Shell |

Policy 当前可以：

- 自动允许只读工具。
- 要求初始计划审批。
- 要求替代计划重新审批。
- 拒绝未审批下载。
- 拒绝非当前活动资源下载。
- 拒绝与用户失败处置选择不一致的模型重规划策略。
- 下载前检查 `approvedRevision === revision`。
- Electron 主进程在下载和导出前再次查询 SQLite 审批记录，过期、撤销或缺失时拒绝执行。
- 普通状态保存不会延长审批有效期；只有用户显式重新确认才会生成新审批。
- 导出前检查全部选中资源均为 `verified`，且状态机处于 `exporting`。
- Electron 主进程拒绝未知资源 ID，renderer 无法通过 IPC 提交任意 URL、主机、大小或 SHA256。

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

浏览器 fallback 演示中 `sample-project` 会在 56% 模拟返回；Electron E2E fixture 则通过真实 `controlled_download` IPC 返回同一结构化错误：

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
- 真实原子导出 README、RESOURCE_MANIFEST、AGENTS、JSON Manifest 和两份只读 PowerShell 交接脚本。
- 工作区页读取真实文件，展示绝对目录、字节数和 SHA256，并可请求系统打开已记录目录。
- 设置页展示远程模型连接状态和系统画像边界。
- 设置页展示 SQLite 持久化、最近保存和最近恢复状态。
- 响应式布局和关键页面滚动稳定性修复。

### 3.9 测试与 CI

已经完成：

- Vitest：8 个测试文件，36 个 Agent Core 测试。
- Playwright Electron E2E：5 条真实 Electron 链路，覆盖三种失败处置、真实文件落盘、应用重启恢复和审批过期。
- 独立持久化验证：覆盖 SQLite 文件、审批期限、不续期、审计恢复、原子目录提交、冲突拒绝和失败回滚。
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
| 真实下载器 | 已完成最小主流程接入 | Electron Runtime 经 Policy、Tool 和 IPC 调用主进程受控下载器 |
| SHA256 / 数字签名真实校验 | 部分完成 | SHA256 与失败恢复已接入主流程；数字签名未开始 |
| 临时目录与原子文件写入 | 已完成 | 下载使用受控临时目录；交接包使用 staging 目录和原子 rename，不覆盖冲突目录 |
| Manifest / README / 交接包真实导出 | 已完成 | 固定 6 个文件真实落盘，界面读取文件并展示路径、大小和 SHA256 |
| SQLite 任务恢复 | 已完成 | 保存任务、revision、ToolResult、Policy、恢复上下文和审批；重启恢复未完成任务 |
| MCP、插件和真实 Agent B | 未开始 | 保持低优先级 |

## 5. 完成度评估

以下百分比是相对于完整生产目标的工程估算，不是测试覆盖率：

| 方向 | 当前完成度 | 说明 |
| --- | ---: | --- |
| 高保真比赛 Demo | 96% | 下载、恢复、真实交接、重启恢复、测试和视觉稳定性已成型 |
| Agent Core 协议与状态机 | 94% | 状态、动作、Tool、Policy、导出、持久化和恢复主链路完整 |
| 最小模型驱动闭环 | 78% | 本地模型稳定，远程模型仍需提升结构化输出稳定性 |
| UI 产品流程 | 90% | 主流程、真实文件状态和目录打开已完成；历史任务浏览和配置编辑仍缺 |
| 远程 LLM 产品化 | 78% | 连接状态和回退完整，真实端点自动测试与 provider 适配仍缺 |
| 受控工具执行 | 82% | Electron 已接入受控下载和原子导出；安装与脚本执行仍保持禁用 |
| 工作区真实交付 | 88% | 固定交接包真实落盘并可验证；尚未将下载产物安装或解包为可运行环境 |
| 生产可用性 | 45% | 已有 SQLite 恢复和审批审计；仍缺真实资源目录、签名验证、发布与升级体系 |

## 6. 当前主要差距

1. 真实执行仍限制在下载与交接导出。
   Electron renderer 已经通过受控 Tool 接入下载、SHA256 校验和工作区原子导出，但可信目录仍使用演示域名，安装、解包、脚本执行和 Agent B 仍未真实化。

2. 远程模型协议仍需 provider 适配增强。
   JSON-only prompt 已合并，但不同模型供应商的字段兼容性、base URL 自动拼接和真实端点自动测试仍未完成。

3. 配置体验不够友好。
   `XL_AGENT_LLM_ENDPOINT` 必须填写完整请求地址，而不是 Base URL。后续可以支持 `XL_AGENT_LLM_BASE_URL` 自动拼接 `/chat/completions`。

4. 可信资源目录仍是固定 Windows 目标。
   虽然已经能读取真实主机画像，但跨平台资源目录尚未建立。

5. 持久化还没有历史任务管理界面。
   SQLite 已保存和恢复最新未完成任务，但用户尚不能浏览、归档或删除历史任务；当前也没有数据库迁移版本管理。

6. Electron 依赖需要单独升级。
   当前 `npm audit` 对 Electron 30 报告 1 个 high 级依赖项，自动修复要求升级到 Electron 43，属于需要单独回归验证的主版本迁移，不在本轮 P4/P5 中直接变更。

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

### 7.2 已完成：真实下载器最小受控边界与主流程接入

当前状态：Electron Runtime、Policy、Tool、preload IPC 和主进程下载客户端已经连通。

已完成：

- 只接入可信目录中声明的 URL。
- 下载前由 Policy 校验资源、revision、来源、授权和用户审批。
- 下载到受控临时目录。
- 不覆盖用户文件。
- ToolResult 记录下载 URL 主机、大小、状态、错误码和耗时。
- 独立验证脚本覆盖 URL、Host、HTTP、大小、SHA256 和临时文件写入。
- Renderer 只传 `resourceId`，下载元数据由 Electron 主进程可信目录解析。
- 浏览器模式保留模拟下载；Electron 模式默认选择 `controlled_download`。
- Electron E2E 使用显式测试 fixture 验证真实 IPC、恢复决策和重新审批链路，不访问外网。

暂不做：

- 安装软件。
- 执行下载后的脚本。
- MCP 或插件。

### 7.3 已完成：第八阶段真实校验与交接包导出

已完成：

- 下载文件 SHA256 校验和校验失败恢复。
- 仅允许全部选中资源已验证、当前 revision 已审批的任务导出。
- 在同级 staging 目录写入 6 个固定文件，完成后原子 rename。
- 已存在的完整同任务 revision 可安全复用；冲突或不完整目录拒绝覆盖。
- 写入失败删除 staging 目录，不修改既有目标。
- 工作区页读取真实文件并展示路径、大小和 SHA256。
- Electron E2E 验证真实目录和文件存在，JSON Manifest 与界面内容一致。

### 7.4 已完成：第九阶段任务恢复与执行审计

已完成：

- `sql.js` SQLite 保存任务、revision、AgentState、ToolResult、Policy 审计、恢复上下文和工作区导出元数据。
- 每次状态转换串行写入，数据库文件通过临时文件加 rename 持久化。
- 应用启动后只恢复最新未完成任务；`handoff`、`cancelled` 和空闲状态不恢复。
- 恢复动作仍通过状态机事件处理，不由 React 直接修改状态。
- 用户审批绑定 task/revision，默认 30 分钟有效；普通状态保存不会续期。
- 主进程在真实下载和导出前再次校验审批，过期后要求用户重新确认。
- Electron E2E 已验证关闭应用后恢复人工失败决策，以及审批过期后拒绝下载。

### 7.5 下一阶段：真实资源与生产化边界

建议按以下顺序推进：

1. 将演示下载域名替换为可维护、可版本化的真实可信目录，并补充数字签名验证。
2. 增加 SQLite schema 版本和迁移机制，以及历史任务浏览/归档。
3. 增加远程模型 provider 适配和 Base URL 自动拼接。
4. 设计安装、解包或脚本执行的最小白名单能力；仍需独立审批和沙箱。
5. 上述边界稳定后，再评估 MCP、插件化来源和真实 Agent B。

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
- 真实下载、工作区导出和 SQLite 已接入主流程；继续保持无自动安装、无任意脚本执行、无 MCP、无插件。

## 9. 结论

项目目前已经超过纯 UI Demo，具备可演示并可恢复的垂直 Agent MVP 关键要素：模型决策、状态机、受控 Tool、Policy、严格计划验证、失败恢复、真实工作区交接、SQLite 审计、重启恢复、测试体系和 CI。

本轮 P4/P5 已完成本地实现和集成测试。下一步不应直接扩展成通用编码 Agent，也不应一次性接入多个高风险执行能力。建议按顺序推进：

1. 远程模型 JSON-only prompt 修复。（已完成）
2. 真实下载器最小受控边界和主流程接入。（已完成）
3. SHA256 校验和失败恢复。（已完成）
4. 真实工作区原子导出。（已完成）
5. SQLite 任务恢复、审计和审批有效期。（已完成）
6. 下一步进入真实可信目录、数字签名和持久化 schema 迁移。
