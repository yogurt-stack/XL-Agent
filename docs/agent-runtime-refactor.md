# Agent Runtime 当前架构说明

## 目标

当前实现遵循计划书中的安全边界：Renderer 只负责展示状态和发送用户操作，
Electron Main 是 Agent Orchestrator 的唯一宿主。模型、路由、状态机、Policy、Tool、
SQLite、真实下载、校验与工作区导出均在 Main 内闭环。

本文描述当前架构。早期“Renderer 内存 Runtime”阶段的历史实现记录见
`minimal-agent-six-step-report.md`，不再代表现行边界。

## 进程职责

### Renderer

- 通过 preload 白名单获取 `AgentRuntimeSnapshot`。
- 订阅 Main 发布的 Runtime 快照。
- 派发受支持的 `AgentUserEvent`。
- 查询只读任务历史和工作区文本预览。
- 不创建 Runtime，不直接访问 Node、网络、文件系统或 SQLite。

### Preload

- 使用 `contextBridge` 暴露有限、具名的 IPC 方法。
- 不暴露通用 `ipcRenderer`、任意频道或任意文件路径。

### Electron Main

`electron/agentRuntimeHost.ts` 承担唯一 Orchestrator：

- 创建并驱动 `AgentRuntime` 与纯状态机。
- 执行三态路由、模型循环、Policy 和 Tool。
- 对 Renderer 用户事件与模型动作执行 Zod 校验。
- 执行可信目录下载、SHA256 校验与 SQLite 持久化。
- 从已验证下载制品原子生成 Agent Ready Workspace。
- 广播不可变的 Runtime 快照。

## 路由与扩展注册表

`ExtensibleAgentRouter` 返回以下三种结果：

| 状态 | 含义 | 后续动作 |
| --- | --- | --- |
| `supported` | 已匹配安装的 Domain Skill | 澄清需求并规划 |
| `needs_links` | 未匹配 Skill，但用户 HTTPS 链接均可由可信 Source Provider 精确解析 | 仅规划解析出的可信资源 |
| `unsupported` | 既无匹配 Skill，也无可验证可信链接 | 明确停止，不调用模型猜测 |

扩展点均通过注册表添加，不修改状态机主流程：

- `DomainSkillRegistry`：任务匹配、澄清、能力需求和工作区指南。
- `SourceProviderRegistry`：可信资源查询与用户链接解析。
- `WorkspaceTemplateRegistry`：Manifest 派生的交接文件模板。
- `AgentToolRegistry`：受控工具名、输入 Schema 和执行器。

当前首个 Domain Skill 是 `ai-development-environment`，首个 Source Provider 是
`trusted-catalog`。

路由完成且澄清结束后，Runtime 会调用当前 Skill 的 `buildRequirements()` 写入能力约束；
本地或远程模型只能在该约束下查询 Provider 并创建计划。工作区导出时，Main 再调用同一
Skill 的 `generateGuide()`，把领域说明交给匹配的 Workspace Template 渲染。因此新增
Skill 不是只增加一个路由标签，而能贯穿规划、验证和交接。

## 模型协议

远程模型使用 OpenAI Chat Completions 兼容 HTTP 协议，并要求原生
`tools/tool_calls`：

- Host 每轮声明允许的 function tools。
- `tool_choice: "required"` 且 `parallel_tool_calls: false`。
- 响应必须且只能包含一个 `tool_call`。
- action 与 runtime tool 共用同一工具调用通道。
- tool 名和 `arguments` 使用严格 Zod Schema 校验，未知字段、未知工具、多工具调用或
  content-only JSON 均拒绝。
- Host Policy 与状态机仍会再次验证动作，模型不能绕过审批或可信目录。

本地规则模型与远程模型实现同一 `ModelRuntime` 契约；远程失败后可安全回退本地模型。

## 状态机与审批

`machine.ts` 保持纯函数 `transition(state, event)`。自动流程由 Main 中的 Runtime 编排：

```text
intake
  -> routing
  -> unsupported
  -> clarifying
  -> planning
  -> waiting_approval
  -> downloading
  -> awaiting_failure_action / replanning
  -> verifying
  -> exporting
  -> handoff
```

取消必需资源、下载失败和版本不匹配都会触发重规划。任何新计划都会增加 revision，并
重新进入 `waiting_approval`；旧 revision 的批准不能授权新计划。旧版 SQLite 快照在恢复
时会将 `windows-ai-development` 固定路由无损映射到当前 Domain Skill 路由。

## SQLite 与下载制品

SQLite schema v2 包含：

- `task_snapshots`
- `approval_records`
- `download_artifacts`
- `workspace_exports`
- `schema_migrations`

受控下载成功后，Main 会先记录资源 ID、文件名、临时文件路径、实际 SHA256、字节数和
验证时间。工作区导出时不信任 Renderer 或状态文本，而是：

1. 按 task/revision/resource 从 SQLite 读取已验证制品。
2. 再次计算源文件 SHA256 和大小。
3. 原子复制到工作区 `downloads/`。
4. 生成 `xunlei-agent-workspace-2.0` JSON Manifest。
5. 由该 Manifest 派生 Markdown、AGENTS 和人工执行脚本。

最终工作区含真实下载文件，但不会自动运行安装包或脚本。

## 验证入口

```bash
npm run typecheck
npm run test:run
npm run verify:model-client
npm run verify:download-client
npm run verify:persistence
npm run verify:agent-core
npm run verify:production-build
npm run verify:electron-renderer
npm run test:e2e
```

覆盖重点包括严格模型工具调用、路由注册表扩展、revision 审批、旧快照迁移、SQLite
schema v2、下载制品重哈希、Manifest 派生、原子回滚、重启恢复和完整 Electron 交接流程。
