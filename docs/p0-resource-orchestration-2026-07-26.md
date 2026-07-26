# P0 本地资源与下载资源编排实现说明

日期：2026-07-26

## 1. 目标与结果

P0 把产品从“能演示受控下载与 Agent B 交接状态”推进为“能接收本地资源、编排下载资源、持续生成可检查工作区，并由第二个只读 Agent 给出真实检查结果”的 Electron MVP。

本次交付覆盖五项：

1. 持久化下载任务与流式控制。
2. 本地文件/目录接入和工作区目录选择。
3. 生产链路真实制品校验。
4. 持续 Manifest snapshot。
5. Agent B 主循环、工具注册、权限、检查和运行持久化。

## 2. 下载任务

`LocalXunleiAdapter` 是 Runtime 与下载后端之间的稳定边界。当前实现复用 Electron Main 的受控下载器；未来接入迅雷 SDK 时，Agent Core、状态机和 Renderer 不需要改变。

每个任务以 `(task_id, revision, resource_id)` 写入 `download_tasks`，记录：

- `queued/downloading/paused/completed/failed/cancelled/interrupted`
- 进度、已写字节、总字节
- 瞬时速度和 ETA
- 临时文件路径、错误码和错误信息
- 创建和更新时间

下载响应体使用 `ReadableStream` 分块写入文件，同时增量计算 SHA256。暂停通过流读取背压实现，不关闭任务；恢复释放等待门；取消通过 `AbortController` 终止。应用重启会把仍为 `downloading/paused` 的记录原子标记为 `interrupted` 并保留最后进度，防止 UI 误报。

当前恢复边界是“可审计地中断并在重新审批后重新执行”，不是跨进程 HTTP Range 字节续传。

## 3. 本地资源与工作区根目录

Renderer 只能调用白名单 IPC 打开系统选择器。实际扫描在 Electron Main 完成：

- 只接受绝对路径下的普通文件和目录。
- 递归目录，拒绝符号链接。
- 单次最多 500 个文件，总大小最多 4 GiB。
- 流式计算文件 SHA256。
- 与可信目录 SHA256 精确匹配时标记 `local-verified`，并作为对应资源的已下载制品。
- 未匹配文件作为附加本地资源进入 `local-resources/`，不会伪装成可信必需资源。
- 私有绝对来源路径只保存在 SQLite，不进入 Manifest 或 Renderer 状态。

计划页在审批前直接提供“接入本地文件或目录”和“选择工作区目录”。工作区完成后不会用目录选择按钮暗示已经导出的包可以原地迁移。

## 4. 真实验证器

生产 `AgentRuntimeHost` 使用 `ElectronArtifactVerifier`，不再使用 `MockVerifier`。验证步骤会：

1. 从 SQLite 读取当前 task/revision 的制品记录。
2. 使用 `lstat` 确认目标是普通文件且不是符号链接。
3. 重新读取文件并计算字节数和 SHA256。
4. 同时核对 SQLite 记录、可信资源计划和允许来源 Host。
5. 成功后把 `downloaded` 更新为 `verified`；失败返回结构化错误进入现有恢复流程。

E2E fixture 例外只在 `NODE_ENV=test` 且显式开启测试开关时生效。

## 5. 持续 Manifest

`resource_manifest_snapshots` 使用独立于 plan revision 的 `manifest_revision`。每次 Main 中的 Runtime 状态持久化后，会生成下一版 Manifest 并原子替换：

```text
<workspace-root>/<task-id>/current/
  resource-manifest.json
  RESOURCE_MANIFEST.md
  README.md
  AGENTS.md
  downloads/
  local-resources/
```

整体状态为：

- `preparing`：仍在准备且没有确定失败。
- `ready`：最终工作区已验证并导出。
- `partially_ready`：至少有一项已准备，但仍有必需项缺失或失败。
- `failed`：任务不能继续且没有可用已准备项。

Manifest 包含 plan/manifest revision、资源来源、进度、制品哈希、本地资源摘要、缺失项、允许动作和禁止动作。最终不可变导出包继续使用 `xunlei-agent-workspace-2.0`；持续工作快照使用 `xunlei-agent-manifest-3.0`，两者用途不同。

## 6. Agent B

Agent B 在 `AgentDefinitionRegistry` 中注册为：

```text
id: workspace-inspector
mode: read-only
allowedTools: [inspect_workspace]
maxSteps: 3
```

它拥有真实有限步主循环：第一步生成并授权 `inspect_workspace` 调用，第二步基于工具 observation 返回结构化最终答案；超过注册的最大步数会失败关闭。

权限 grant 绑定：

- Agent ID
- task ID
- plan revision
- grant ID
- 允许工具列表
- 签发时间与五分钟过期时间

`inspect_workspace` 只读取当前 revision 最新的已落盘 Manifest，比较 SQLite 与 JSON 内容，并重新校验 Manifest 引用的每个文件哈希。回答必须包含 Manifest revision、工作区状态、已准备必需资源、缺失/失败资源、允许动作、禁止动作和完整性结论。

每次运行写入 `agent_b_runs`，包含 grant、状态、工具结果、最终回答或错误。用户可以从失败处置按钮自动运行，也可以在工作区页主动运行。

## 7. 权限边界

基础资源权限均可通过产品 UI 直接使用，但仍要求明确用户动作：

- 本地文件/目录：用户点击系统选择器授权。
- 工作区目录：用户点击系统选择器授权。
- 下载：用户审批当前 plan revision 后授权。
- Agent B：用户点击失败交接或“运行 Agent B”授权一次只读检查。

Agent B 没有 `controlled_download`、`export_workspace`、Shell、安装或写文件权限。产品也不会自动执行下载物。

## 8. 验收

`npm run verify:p0-resource-orchestration` 独立验证：

- 下载进度持久化。
- 暂停、恢复和取消。
- 重启后 `interrupted` 恢复语义。
- 本地目录递归扫描与限制。
- 真实校验成功和篡改失败。
- 跨 plan revision 保留本地资源。
- 部分完成 Manifest、说明文件和原子 current 更新。
- Agent B 注册、有限步主循环、工具调用、正常 grant、过期 grant、篡改检测和运行持久化。

此外，Vitest 覆盖状态机和注册表；Electron Playwright E2E 覆盖失败交接自动 Agent B 与就绪工作区主动 Agent B。

## 9. P0 之外

以下功能明确不属于本次交付：

- 自动安装、解压或执行下载资源。
- Windows Authenticode / `WinVerifyTrust` 强制校验。
- 跨应用重启的 HTTP Range 字节续传。
- 真实迅雷 SDK/服务接入；当前由 `LocalXunleiAdapter` 保留替换边界。
- 允许 Agent B 写文件、创建下载或执行命令。
