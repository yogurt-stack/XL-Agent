# 最小 Agent 六步实现汇报

## 1. 改造目标

本次改造将原来的固定状态机 Demo 扩展为一个最小、可运行、可审计的垂直 Agent：

- 模型负责理解任务并提出结构化动作。
- Runtime 最多执行 6 个模型决策步骤。
- 工具执行器只开放系统画像读取、可信目录查询和模拟下载。
- 权限策略在动作执行前决定允许、要求审批或拒绝。
- 状态机是唯一状态修改入口。
- 远程 LLM 不可用时自动回退本地规则模型。
- UI 展示模型决策、工具结果、审批策略和最终执行日志。

下载、文件写入和工作区仍为前端内存模拟，没有接入真实下载器、SQLite、MCP 或插件系统。

## 2. 六步完成情况

### 第一步：定义 Agent 协议

完成位置：`src/features/agent-core/types.ts`、`interfaces.ts`。

- `AgentAction`（`types.ts:124`）：模型允许提出的五类结构化动作。
- `AgentToolCall`（`types.ts:102`）：三个工具及其参数协议。
- `ToolResult`（`types.ts:158`）：工具执行结果、错误和时间信息。
- `ModelContext`（`types.ts:172`）：模型每一步可读取的状态与工具历史。
- `ModelDecision`（`types.ts:180`）：模型来源、说明和结构化动作。
- `PolicyDecision`（`types.ts:190`）：`allow`、`require_approval`、`deny` 三种结果。
- `AgentRunState`（`types.ts:213`）：步骤数、运行状态、决策、工具和策略审计。
- `ModelRuntime.decide()`（`interfaces.ts:17`）：本地模型与远程模型的统一入口。
- `AgentToolExecutor.execute()`（`interfaces.ts:25`）：受控工具统一执行入口。
- `AgentPolicy.evaluate()`（`interfaces.ts:29`）：动作执行前的权限判断入口。

### 第二步：最多 6 步的异步 Agent Loop

完成位置：`src/features/agent-core/runtime.ts`。

`AgentRuntime` 在 `routing` 和 `planning` 阶段调用模型，每次只接收一个 `ModelDecision`。每个动作先经过策略检查，再执行工具或转换为状态机事件。

`AgentState.agentRun.step` 达到 `maxSteps = 6` 时，Runtime 派发 `MODEL_STEP_LIMIT_REACHED`，状态机停止任务，避免无限循环。

Runtime 使用 `workVersion` 使过期的异步结果失效。用户重新提交、取消或回答问题时，会取消待执行步骤，旧模型响应不能覆盖新状态。

### 第三步：本地确定性模型

完成位置：`src/features/agent-core/localRuleModel.ts`。

本地模型支持四种识别结果：

| 意图 | 典型输入 | 默认资源 |
| --- | --- | --- |
| `python-ai` | Python、机器学习、大模型 | Python、VS Code、Git、示例项目 |
| `fullstack-ai` | React、Node.js、全栈 | Python、VS Code、Git、Node.js、示例项目 |
| `base-development` | Git、VS Code、基础工具 | VS Code、Git |
| `ambiguous` | “帮我准备开发环境” | 先询问主要工作负载 |

三个明确意图分别询问不同的范围问题。澄清答案会进一步改变资源组合，例如 Python 任务可以加入 Node.js，基础任务可以只保留 Git。

### 第四步：远程 LLM 与自动回退

完成位置：`src/features/agent-core/remoteModel.ts`、`electron/main.ts`、`electron/preload.ts`、`useAgentCore.ts`。

远程模型通过 Electron IPC 调用兼容 Chat Completions 格式的 HTTPS 端点。以下配置仅在 Electron 主进程读取：

```text
XL_AGENT_LLM_ENDPOINT
XL_AGENT_LLM_API_KEY
XL_AGENT_LLM_MODEL
```

Electron 主进程启动时通过 `dotenv` 从根目录 `.env` 加载这些配置。这些配置不使用 `VITE_` 前缀，API Key 不会被 Vite 写入 renderer bundle；`.env` 已加入 `.gitignore`，仓库只保留空值模板 `.env.example`。远程模型返回值必须通过 `ModelDecision` 运行时校验，否则 `FallbackModelRuntime` 使用本地模型继续。

### 第五步：动态澄清和动态资源计划

完成位置：`localRuleModel.ts`、`machine.ts`。

模型的 `ask_clarification` 动作转换成 `MODEL_CLARIFICATION_REQUESTED`，状态机只展示当前一个问题。用户回答后回到 `planning`，Runtime 继续下一步。

模型的 `create_plan` 动作转换成 `MODEL_PLAN_PROPOSED`。`createModelPlan()` 只接受可信目录中存在的 ID，未知 ID 被过滤。合法计划进入 `waiting_approval` 并增加 revision，模型不能绕过用户确认。

### 第六步：执行页审计 UI

完成位置：`src/components/AgentViews.tsx`、`src/styles/global.css`。

执行页现在展示：

- 当前模型步骤与 6 步上限。
- 当前使用本地规则模型还是远程 LLM。
- 每一步模型动作及简短说明。
- 工具名称、成功或失败结果。
- 策略风险等级和审批结果。
- 下载任务、失败原因和原有操作日志。

资源计划页同时显示模型生成计划的理由。澄清完成后提供明确的“查看资源计划”入口。

## 3. 文件职责

| 文件 | 整体作用 |
| --- | --- |
| `src/features/agent-core/types.ts` | 定义 Agent 状态、事件、动作、工具、模型和策略数据协议。 |
| `src/features/agent-core/interfaces.ts` | 定义模型、工具、策略、调度器和 Runtime 的行为接口。 |
| `src/features/agent-core/machine.ts` | 唯一状态转换内核；记录模型、工具、策略审计并生成可信计划。 |
| `src/features/agent-core/runtime.ts` | 编排每轮最多 6 步的模型循环，并统一执行 Policy、Agent Tool 和 ToolResult 链路。 |
| `src/features/agent-core/localRuleModel.ts` | 离线识别任务、生成动态问题、资源计划和失败后的重规划决策。 |
| `src/features/agent-core/agentServices.ts` | 实现内存工具执行器和默认权限策略。 |
| `src/features/agent-core/remoteModel.ts` | 校验远程输出，并提供远程失败后的本地回退。 |
| `src/features/agent-core/mockServices.ts` | 保留无模型兼容路径中的固定路由、规划和验证服务。 |
| `src/features/agent-core/useAgentCore.ts` | React 与 Runtime 的适配层；选择远程加回退或纯本地模型。 |
| `electron/main.ts` | 保存远程模型配置、发起 HTTPS 请求并提供 IPC。 |
| `electron/preload.ts` | 通过最小 contextBridge 暴露模型决策 IPC。 |
| `.env.example` | 定义可提交的远程模型配置模板；真实 `.env` 被 Git 忽略。 |
| `src/types/electron.d.ts` | 为 renderer 中的 preload API 提供类型。 |
| `src/components/AgentViews.tsx` | 渲染动态澄清、模型计划和 Agent 审计轨迹。 |
| `src/styles/global.css` | 提供计划理由、四项执行摘要和审计轨迹响应式样式。 |
| `scripts/verify-agent-core.mjs` | 编译并执行固定状态机、模型 Loop、动态任务和回退场景。 |

## 4. 函数与行号

### 4.1 状态机 `machine.ts`

| 函数 | 行号 | 作用 |
| --- | ---: | --- |
| `createLog()` | 31 | 创建顺序编号的 Agent 日志。 |
| `withLog()` | 43 | 返回追加日志后的状态副本。 |
| `toPlannedResource()` | 53 | 将可信目录资源转成待确认计划资源。 |
| `createInitialPlan()` | 68 | 为旧版固定流程生成初始计划。 |
| `createModelPlan()` | 86 | 过滤未知 ID，并把模型建议转换为可信计划。 |
| `setNextDownload()` | 98 | 选择下一项排队资源并标记为下载中。 |
| `prepareDownloads()` | 122 | 用户确认后初始化下载队列。 |
| `replacementFor()` | 140 | 根据策略生成主来源重试或可信替代资源。 |
| `buildReplacementPlan()` | 176 | 替换失败资源并保留其他执行结果。 |
| `enterReplanning()` | 203 | 标记失败并进入重规划。 |
| `hasRequiredSelection()` | 233 | 检查必需资源是否仍被选择。 |
| `createInitialAgentState()` | 241 | 创建包含 6 步运行记录的初始状态。 |
| `getActiveClarification()` | 277 | 返回当前唯一要展示的澄清问题。 |
| `transition()` | 287 | 根据事件计算下一状态，是唯一状态写入口。 |

`transition()` 中与最小 Agent 直接相关的事件分支：

| 分支 | 行号 | 作用 |
| --- | ---: | --- |
| `MODEL_DECISION_RECORDED` | 358 | 增加步骤并记录模型决策。 |
| `MODEL_POLICY_RECORDED` | 370 | 记录风险与审批判定。 |
| `MODEL_TOOL_COMPLETED` | 380 | 记录工具结果并追加日志。 |
| `MODEL_CLARIFICATION_REQUESTED` | 394 | 显示模型动态问题。 |
| `MODEL_PLAN_PROPOSED` | 408 | 生成可信计划并进入等待确认。 |
| `MODEL_FINISHED` | 427 | 标记模型流程完成。 |
| `MODEL_STEP_LIMIT_REACHED` | 438 | 达到 6 步上限后停止任务。 |
| `MODEL_RUNTIME_FAILED` | 450 | 记录不可恢复的模型或策略错误。 |

### 4.2 异步循环 `runtime.ts`

| 函数/方法 | 行号 | 作用 |
| --- | ---: | --- |
| `AgentRuntime.constructor()` | 41 | 注入模型、工具、策略、调度器和执行服务。 |
| `getState()` | 46 | 读取当前统一状态。 |
| `dispatch()` | 50 | 接收用户事件、使旧异步任务失效并继续循环。 |
| `applyEvent()` | 56 | 调用纯状态机并通知订阅者。 |
| `subscribe()` | 63 | 注册 React 状态监听器。 |
| `start()` | 68 | 启动自动循环。 |
| `stop()` | 74 | 停止循环并取消待执行步骤。 |
| `drive()` | 79 | 根据阶段选择模型步骤或固定执行事件。 |
| `runModelStep()` | 109 | 完成“模型决策 -> 策略检查 -> 工具/事件”的单步闭环。 |
| `isCurrentWork()` | 177 | 防止过期异步响应写回状态。 |
| `nextAutomaticEvent()` | 181 | 继续下载、验证和重规划等确定性流程。 |
| `invalidatePendingWork()` | 191 | 递增版本并取消调度任务。 |
| `createTimeoutScheduler()` | 198 | 创建浏览器兼容的延迟调度器。 |
| `createMockAgentRuntime()` | 209 | 组装本地模型、工具、策略和 Mock 执行服务。 |

### 4.3 本地模型 `localRuleModel.ts`

| 函数/方法 | 行号 | 作用 |
| --- | ---: | --- |
| `includesAny()` | 51 | 执行简单关键词匹配。 |
| `inferLocalTaskIntent()` | 61 | 将自然语言归类为三种意图或模糊任务。 |
| `hasSuccessfulResult()` | 83 | 判断某个工具是否已有成功结果。 |
| `createActionId()` | 87 | 为动作生成可审计 ID。 |
| `createDecision()` | 91 | 包装本地模型决策元数据。 |
| `workloadAnswerFrom()` | 101 | 读取主要工作负载答案。 |
| `resourceIdsForIntent()` | 106 | 根据意图和澄清答案计算资源 ID。 |
| `LocalRuleModelRuntime.decide()` | 124 | 决定澄清、工具调用、计划、审批或完成动作。 |

### 4.4 工具与策略 `agentServices.ts`

| 函数/方法 | 行号 | 作用 |
| --- | ---: | --- |
| `mockTimestamp()` | 5 | 生成确定性的模拟审计时间。 |
| `successResult()` | 9 | 统一创建成功工具结果。 |
| `InMemoryAgentToolExecutor.execute()` | 22 | 执行三个白名单内存工具。 |
| `DefaultAgentPolicy.evaluate()` | 64 | 允许只读动作、审批计划、拒绝未授权下载。 |

### 4.5 远程模型 `remoteModel.ts` 与 Electron

| 函数/方法 | 行号 | 作用 |
| --- | ---: | --- |
| `isRecord()` | `remoteModel.ts:4` | 检查未知输出是否为对象。 |
| `isStringArray()` | `remoteModel.ts:8` | 校验字符串数组。 |
| `isAgentAction()` | `remoteModel.ts:12` | 校验五类动作及工具参数。 |
| `parseRemoteDecision()` | `remoteModel.ts:51` | 把未知远程输出转换为安全的 `ModelDecision`。 |
| `RemoteLlmModelRuntime.decide()` | `remoteModel.ts:75` | 调用安全传输并校验返回值。 |
| `FallbackModelRuntime.decide()` | `remoteModel.ts:87` | 捕获远程失败并调用本地模型。 |
| `getLlmConfig()` | `electron/main.ts:16` | 从主进程环境变量读取并验证 HTTPS 配置。 |
| `requestRemoteModelDecision()` | `electron/main.ts:31` | 调用远程模型并解析 JSON 内容。 |
| `getDevServerUrl()` | `electron/main.ts:66` | 只允许 Electron 加载本机开发地址。 |
| `createMainWindow()` | `electron/main.ts:86` | 创建禁用 Node Integration 的安全窗口。 |
| `agent:modelDecision` IPC | `electron/main.ts:118` | 将 renderer 请求交给主进程远程适配器。 |
| `requestModelDecision` bridge | `electron/preload.ts:17` | 最小化暴露模型决策 IPC，并返回显式成功/失败结果。 |

### 4.6 React 与 UI

| 函数 | 行号 | 作用 |
| --- | ---: | --- |
| `createRendererAgentRuntime()` | `useAgentCore.ts:7` | 选择远程加回退或纯本地模型。 |
| `useAgentCore()` | `useAgentCore.ts:22` | 订阅 Runtime，React 只渲染和派发事件。 |
| `AgentTopBar()` | `AgentViews.tsx:62` | 展示阶段和当前模型来源。 |
| `AgentHomeView()` | `AgentViews.tsx:86` | 接收自然语言任务。 |
| `ClarificationView()` | `AgentViews.tsx:138` | 展示模型当前提出的单个问题。 |
| `ResourcePlanView()` | `AgentViews.tsx:172` | 展示动态计划、模型理由和确认入口。 |
| `ExecutionView()` | `AgentViews.tsx:197` | 展示步骤、决策、工具、策略、下载与日志。 |
| `WorkspaceView()` | `AgentViews.tsx:230` | 展示最终 Manifest 与交接信息。 |

关键样式位于 `global.css:1765`（模型建议）、`global.css:1790`（四项摘要）、`global.css:1867`（日志布局）和 `global.css:1871`（决策轨迹）。

## 5. 整体链路

```text
React 首页提交自然语言任务
  -> runtime.dispatch(SUBMIT_TASK)
  -> machine.transition() 进入 routing
  -> AgentRuntime.drive()
  -> ModelRuntime.decide(ModelContext)
       -> 可选 RemoteLlmModelRuntime
       -> 失败时 FallbackModelRuntime
       -> LocalRuleModelRuntime
  -> MODEL_DECISION_RECORDED
  -> AgentPolicy.evaluate()
  -> MODEL_POLICY_RECORDED
  -> 根据 AgentAction 分支
       -> call_tool
            -> AgentToolExecutor.execute()
            -> MODEL_TOOL_COMPLETED
            -> 回到下一模型步骤
       -> ask_clarification
            -> MODEL_CLARIFICATION_REQUESTED
            -> 等待用户回答
            -> 回到 planning
       -> create_plan
            -> createModelPlan() 过滤可信目录
            -> MODEL_PLAN_PROPOSED
            -> waiting_approval
  -> 用户确认 APPROVE_PLAN
  -> Policy 审批校验 -> AgentToolExecutor 执行 simulate_download
  -> 失败时 awaiting_failure_action
       -> 重试原来源或可信替代来源 -> 模型 replanning -> waiting_approval
       -> Agent B -> 未完成工作区交接
  -> MockVerifier 验证
  -> handoff
  -> resource-manifest.json 与工作区交接
```

安全边界始终是：模型只能提出动作，策略决定动作是否允许，工具执行器只执行白名单工具，状态机决定最终状态。

## 6. 验证结果

已通过：

```bash
npm run verify:agent-core
npm run typecheck
npm run build
git diff --check
```

`scripts/verify-agent-core.mjs` 覆盖：

- 三种自然语言意图识别。
- 三种领域问题及不同资源组合。
- 模糊任务连续两次澄清，并在 5 步内生成计划。
- 达到第 6 步安全上限后停止任务。
- 系统画像和可信目录工具结果记录。
- 每项模型动作的策略审计。
- 远程模型失败后回退本地模型。
- 用户确认、模拟下载失败、重规划、再次确认和最终交接。
- Manifest revision 与最终工作区状态一致。

远程 HTTPS 模型没有在本次验证中实际调用，因为当前环境没有提供端点和 API Key；已验证远程失败自动回退路径。renderer 开发服务已在 `http://127.0.0.1:5174/` 返回 HTTP 200。
