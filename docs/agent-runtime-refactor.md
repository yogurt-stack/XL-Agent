# Agent Runtime 改造说明

## 背景

本次改造将原先放在 React Hook 中的自动计时和 Mock 事件推进逻辑迁移到独立的 TypeScript Agent Runtime。目标是让 React 只负责渲染 `AgentState` 与派发用户操作，而状态流转、自动步骤和 Mock 执行策略保持在可测试、可替换的 Agent Core 中。

本文记录的是第一阶段 Runtime 拆分。当时仍是纯前端内存模拟；后续最小 Agent 阶段已增加本地模型和可选远程 LLM，详见 `minimal-agent-six-step-report.md`。真实下载、SQLite 和文件写入仍未接入。

## 改造前后

改造前，`useAgentCore.ts` 同时负责：

- 保存 React 状态。
- 调用状态机 `transition`。
- 使用 `setTimeout` 推进路由、计划、下载、重规划和验证。
- 调用单一的 `getNextMockEvent` 生成所有自动事件。

改造后，职责划分如下：

- React Hook 订阅 `AgentRuntime`，并将用户操作转发为 `AgentEvent`。
- `AgentRuntime` 负责状态、订阅、自动事件调度以及生命周期。
- 路由、规划、下载和验证分别由独立接口及 Mock 实现提供。
- `machine.ts` 继续作为纯状态机，不依赖 React、定时器或 Electron API。

## 新增模块

| 文件 | 作用 |
| --- | --- |
| `src/features/agent-core/interfaces.ts` | 定义 Runtime、调度器及路由、规划、下载、验证服务的边界。 |
| `src/features/agent-core/runtime.ts` | 实现 `AgentRuntime`，负责订阅、事件分发、自动步骤与取消待执行步骤。 |
| `src/features/agent-core/mockServices.ts` | 提供无模型兼容路径中的固定路由、资源计划和验证服务。 |
| `src/features/agent-core/useAgentCore.ts` | React 适配层，只订阅 Runtime 状态并派发事件。 |
| `src/features/agent-core/machine.ts` | 根据事件执行纯状态转换；现在接收路由结果和重规划策略。 |
| `scripts/verify-agent-core.mjs` | 使用手动调度器验证完整运行时流程，避免依赖真实等待时间。 |

旧的 `mockRunner.ts` 已删除。路由、无模型计划和验证由 `FixedWindowsRouter`、`FixedWindowsPlanner`、`MockVerifier` 提供，模拟下载统一通过 `AgentToolExecutor` 执行。

## 接口职责

### `AgentRuntimePort`

前端使用 Agent Core 的统一入口：

- `getState()`：读取当前 `AgentState`。
- `dispatch(event)`：派发用户或系统事件，并触发状态转换。
- `subscribe(listener)`：订阅状态变化，供 React 更新界面。
- `start()`：启动自动步骤循环。
- `stop()`：停止循环，并取消尚未执行的自动步骤。

### `AgentScheduler`

抽象自动步骤的延迟调度：

- Demo 使用 `createTimeoutScheduler()`，底层为 `setTimeout`。
- 核心验证使用手动调度器，不需要真实等待。
- 后续可以替换为 Electron 主进程队列、任务队列或受控测试时钟，而不用修改状态机和 UI。

### `AgentRouter`

负责 `routing` 阶段的路由判断，返回 `ROUTE_RESOLVED` 事件。当前固定路由到 `windows-ai-development`，并使用 Windows 11 x64 系统画像。

### `AgentPlanner`

负责计划阶段的自动事件：

- `createPlan()`：在 `planning` 阶段生成 `PLAN_GENERATED`。
- `createReplan()`：在 `replanning` 阶段生成带策略的 `REPLAN_GENERATED`。

规划器不直接修改状态。它只提供事件，最终状态仍由 `transition()` 统一处理。

### `AgentToolExecutor`

负责执行经过策略检查的受控工具。`downloading` 阶段由 Runtime 构造 `simulate_download` 调用，工具返回进度或结构化失败；当前实现会固定让 `sample-project` 在 56% 后返回 SHA256 校验错误。

### `AgentVerifier`

负责 `verifying` 阶段的验证事件。当前 Mock 默认生成通过事件；UI 或测试可以显式派发包含 `versionMismatchResourceId` 的事件，以模拟版本不匹配并进入重规划。

## 状态流与控制规则

核心流程保持为：

```text
任务输入
  -> 路由判断
  -> 需求澄清
  -> 资源计划
  -> 等待确认
  -> 模拟下载
  -> 下载失败时等待人工处置
  -> 验证
  -> 工作区交接
```

以下情况会进入 `replanning`：

- 用户取消必需资源。
- 验证发现版本不匹配。
- 下载任务失败后，用户选择“重试原来源”或“可信替代来源”。

下载失败会先进入 `awaiting_failure_action`，不会立即触发模型。用户也可以选择“交给 Agent B”，生成保留失败上下文的未完成交接。无论采用哪种重规划策略，新计划都必须回到 `waiting_approval`，产生新的 `revision`，等待用户重新确认后才能继续下载。

## 备用镜像策略

澄清问题“是否允许在可信目录内使用备用镜像？”现在已连接到重规划逻辑：

- 选择“允许备用镜像”：规划器发出 `strategy: "trusted-mirror"`，状态机会采用资源目录中的 `fallbackId`，例如将 `Python 3.12` 替换为 `Miniforge Python Runtime`。
- 选择“仅使用主来源”或跳过：规划器发出 `strategy: "primary-retry"`，状态机会保留原资源并生成主来源重试计划。

两种策略都会创建新的计划 revision，并再次进入 `waiting_approval`。

## React 边界

`useAgentCore()` 不再包含 `setTimeout`、`transition()` 调用或 Mock 业务判断。它仅执行以下工作：

1. 创建一次 `AgentRuntime`。
2. 订阅 Runtime 的状态更新。
3. 在组件挂载时启动 Runtime，在卸载时停止 Runtime。
4. 将组件操作转发给 `runtime.dispatch()`。

因此首页、澄清页、资源计划页、执行页和工作区页仍由同一份 `AgentState` 驱动，但不会直接掌握流程推进规则。

## 验证

已执行并通过：

```bash
npm run verify:agent-core
npm run typecheck
npm run build
```

核心场景验证覆盖：

- 初始计划生成并等待确认。
- 取消必需资源后进入重规划。
- 允许备用镜像时，Python 替换为可信 Miniforge 运行时。
- 示例项目代码包在下载中途失败，生成新的待确认计划。
- 版本不匹配后再次重规划。
- 选择仅主来源时保留原资源进行重试。
- 最终交接状态与 `resource-manifest.json` 的 revision 一致。

## 后续替换方向

接入真实能力时，应替换 `mockServices.ts` 中对应的实现，而不是让 React 直接调用后端或下载器：

- 用真实意图识别或规则引擎替换 `AgentRouter`。
- 用资源目录服务替换 `AgentPlanner`。
- 用 Electron 主进程 IPC 实现真实 `AgentToolExecutor` 下载工具。
- 用安装包哈希、版本探测或环境检测替换 `AgentVerifier`。

状态机、UI 的事件契约与 Manifest 计算可以保持不变。
