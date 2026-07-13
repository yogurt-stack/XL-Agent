# Agent Runtime、重规划与失败恢复改动说明

## 1. 改动目标

本次改动将项目从由 React 定时器推进的固定流程 Demo，演进为由独立 TypeScript Agent Core 驱动的最小 Agent MVP，并补齐以下核心闭环：

```text
自然语言任务
  -> 模型路由与澄清
  -> 查询固定系统画像和可信资源目录
  -> 生成资源计划
  -> 用户审批 revision
  -> Policy 检查
  -> Agent Tool 模拟下载
  -> 结构化失败
  -> 用户选择恢复方式
  -> 模型重规划
  -> 新 revision 再次审批
  -> 验证与工作区交接
```

项目仍然遵循纯前端内存模拟约束，不会真实下载、安装、写文件或调用第二个 Agent。

## 2. Agent Core 协议

`src/features/agent-core/types.ts` 定义了统一协议：

- `AgentPhase`：任务输入、路由、澄清、规划、审批、下载、失败待处理、验证、重规划、交接和取消。
- `AgentState`：所有页面共享的唯一状态，包括任务、资源、revision、模型轨迹、工具结果和策略审计。
- `AgentAction`：澄清、创建计划、创建重规划、调用工具、请求审批和结束任务。
- `AgentToolCall` / `ToolResult`：受控工具的结构化输入与输出。
- `PolicyDecision`：`allow`、`require_approval` 和 `deny` 三类安全判定。
- `AgentEvent`：用户、模型、工具和 Runtime 可以派发的状态机事件。

`src/features/agent-core/interfaces.ts` 定义模型、工具、策略、调度器、规划器、验证器和 Runtime 的可替换接口，使 React 不依赖具体 Mock 实现。

## 3. Agent Runtime

`src/features/agent-core/runtime.ts` 实现异步 Agent Loop：

- 在 `routing`、`planning` 和 `replanning` 阶段调用 `ModelRuntime`。
- 每轮最多执行 6 个模型决策步骤，用户批准新 revision 后重新计数。
- 每个模型动作执行前都经过 `AgentPolicy`。
- 工具调用通过 `AgentToolExecutor`，结果写回同一份 `AgentState`。
- 使用 work version 防止取消任务后过期异步结果继续修改状态。
- 下载阶段统一使用 `Policy -> simulate_download -> ToolResult`，不再经过旧的 `MockDownloadExecutor`。

`src/features/agent-core/mockRunner.ts` 已删除，其职责被 Runtime、受控 Tool 和独立 Mock 服务替代。

## 4. 模型运行时

`src/features/agent-core/localRuleModel.ts` 提供离线确定性模型，支持：

- Python AI、全栈 AI、基础开发工具和模糊任务识别。
- 一次一个关键澄清问题。
- 读取系统画像和查询可信目录两个只读工具动作。
- 根据任务范围创建不同资源计划。
- 根据用户选择创建 `primary-retry` 或 `trusted-mirror` 重规划动作。

`src/features/agent-core/remoteModel.ts` 提供远程 LLM 适配和结构校验。远程模型不可用、网络失败或返回非法结构时，`FallbackModelRuntime` 会回退本地规则模型。

Electron 主进程在 `electron/main.ts` 中读取以下配置并执行 HTTPS 请求：

```dotenv
XL_AGENT_LLM_ENDPOINT=
XL_AGENT_LLM_MODEL=
XL_AGENT_LLM_API_KEY=
```

密钥不会通过 Vite 注入 renderer。`electron/preload.ts` 只暴露最小模型决策 IPC，且 Electron 保持 `contextIsolation: true`、`nodeIntegration: false` 和 sandbox。

## 5. Tool 与 Policy 链路

`src/features/agent-core/agentServices.ts` 当前注册三个内存 Tool：

| Tool | 当前行为 |
| --- | --- |
| `read_system_profile` | 返回固定 Windows 11 x64 目标画像 |
| `search_trusted_catalog` | 查询内存中的可信资源目录 |
| `simulate_download` | 返回模拟进度，示例项目在 56% 固定产生一次校验失败 |

`DefaultAgentPolicy` 负责：

- 自动允许只读工具。
- 禁止下载未审批或非当前活动资源。
- 要求初始计划和每个替代计划重新审批。
- 拒绝与用户失败处置选择不一致的模型重规划策略。

示例项目失败会返回结构化结果：

```json
{
  "code": "CHECKSUM_MISMATCH",
  "message": "示例项目代码包校验失败：模拟 SHA256 与可信目录不一致",
  "retriable": true
}
```

## 6. 失败人工处置

下载失败后状态机进入 `awaiting_failure_action`，暂停所有自动重规划。执行页提供三项操作：

### 重试原来源

- 写入 `requestedReplanStrategy: "primary-retry"`。
- 模型必须生成主来源重试计划。
- 原资源保留并重置执行状态。
- revision 增加后回到 `waiting_approval`。

### 使用可信替代来源

- 仅当失败资源存在 `fallbackId` 时可用。
- 写入 `requestedReplanStrategy: "trusted-mirror"`。
- 模型生成可信替代来源计划。
- 状态机从可信目录加载替代资源，并等待再次审批。

### 交给 Agent B

- 当前任务进入未完成 `handoff`。
- 保留目标、revision、失败原因、资源状态、缺失项和下一步动作。
- `workspace.ready` 保持 `false`，避免把未完成交接误报为可使用工作区。
- 当前仅模拟交接数据，没有启动真实第二个 Agent。

## 7. React UI

React 现在只订阅 `AgentState` 并派发 `AgentEvent`：

- 首页展示任务输入、最近任务、Skill 和下载摘要。
- 澄清页一次显示一个模型问题及原因。
- 计划页展示资源来源、版本、授权、大小、依赖和 revision 审批。
- 执行页展示资源进度、模型决策、工具结果、Policy 审计和失败人工处置。
- 工作区页展示 Manifest、Markdown 文件预览和 Agent B 未完成交接状态。

失败面板和重规划状态带已增加响应式约束，窗口缩小时按钮、错误信息和元数据不会互相覆盖。

## 8. 自动验证

`scripts/verify-agent-core.mjs` 覆盖：

- 多类自然语言任务和模糊任务澄清。
- 本地模型工具调用与远程失败回退。
- 必需资源取消后重新审批。
- 下载全部经过 Agent Tool 和 Policy。
- 下载失败后暂停，模型不能提前重规划。
- 主来源重试、可信替代来源和 Agent B 三条分支。
- 模型策略必须与用户选择一致。
- 版本不匹配后再次重规划。
- 最终 Manifest revision 与状态一致。
- 每轮模型步骤上限。

本次提交通过以下检查：

```bash
npm run verify:agent-core
npm run typecheck
npm run build
git diff --check
```

## 9. 当前边界与后续工作

当前仍未实现：

- 模型连接状态、测试连接和回退原因展示。
- 必需项、依赖闭包、版本、来源和授权的完整计划验证器。
- 真实下载、SHA256、数字签名和断点续传。
- 真实系统画像读取、文件写入和本地工作区打开。
- SQLite、任务恢复、MCP、插件和真实 Agent B。
- 正式单元测试框架、UI 冒烟测试和 Electron 安装包。

下一优先级是增加模型连接状态与回退原因，然后实现严格计划验证器。
