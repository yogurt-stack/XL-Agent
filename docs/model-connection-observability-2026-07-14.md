# 模型连接可观测性与 P0 稳定性改动说明

## 1. 改动目标

本次改动在现有模型驱动 Agent 闭环之上完成两类工作：

1. 修复 Electron production renderer 与重规划协议中的确定性问题。
2. 将远程模型从“失败后静默回退”升级为连接状态明确、错误可见、可以主动测试且不会泄露密钥的应用级能力。

真实下载、文件写入、SQLite、MCP、插件和真实 Agent B 仍未接入。

## 2. P0 稳定性修复

### Electron production 资源路径

Vite `base` 调整为 `./`，使 Electron 通过 `loadFile(dist/index.html)` 启动时正确解析 `dist/assets` 下的 JS 和 CSS，避免 production 窗口加载空白页面。

新增 `scripts/verify-production-build.mjs`，自动检查：

- `dist/index.html` 存在。
- production HTML 引用了构建资源。
- JS 和 CSS 使用 `./assets/...` 相对路径。
- HTML 引用的资源文件真实存在。

### 无备用源资源的重规划

自动重规划现在同时检查用户是否允许备用镜像以及失败资源是否真的存在 `fallbackId`。若备用资源本身再次失败，不再错误生成 `trusted-mirror` 策略，而是回到 `primary-retry`。

### 移除无效模型动作

`request_approval` 原先存在于 `AgentAction`、远程 prompt 和 Policy 中，但 Runtime 没有消费该动作。现在已从模型协议中完整移除。

初始计划和替代计划仍通过以下链路强制审批：

```text
create_plan / create_replan
  -> Policy require_approval
  -> waiting_approval
  -> 用户确认 revision
  -> 执行
```

## 3. 模型连接状态

新增独立的 `ModelConnectionController`。连接状态属于应用级状态，不写入会随任务提交重置的 `AgentState`。

支持状态：

```text
unconfigured
configured
checking
remote_available
fallback_local
connection_failed
```

状态同时记录：

- 当前实际 provider：本地规则模型或远程 LLM。
- 脱敏端点主机。
- 模型 ID。
- 最近检测时间。
- 结构化错误码、用户可读摘要和是否可重试。

React 只订阅连接控制器并渲染，不自行根据最后一条模型日志推断 provider。

## 4. Electron 模型客户端与 IPC

远程配置和 HTTPS 调用从 `electron/main.ts` 抽离到可测试的 `electron/modelClient.ts`。

新增 IPC：

| IPC | 作用 |
| --- | --- |
| `agent:modelConnectionInfo` | 返回是否配置、端点主机、模型 ID 和配置错误 |
| `agent:testModelConnection` | 使用真实 Chat Completions 请求路径验证连接和 JSON 输出 |
| `agent:modelDecision` | 返回正常模型决策或结构化失败 |

结构化错误覆盖：

- `MODEL_UNCONFIGURED`
- `MODEL_ENDPOINT_INVALID`
- `MODEL_AUTH_FAILED`
- `MODEL_TIMEOUT`
- `MODEL_NETWORK_ERROR`
- `MODEL_HTTP_ERROR`
- `MODEL_INVALID_RESPONSE`
- `MODEL_INVALID_JSON`
- `MODEL_INVALID_DECISION`
- `MODEL_UNKNOWN_ERROR`

## 5. 回退与恢复

`FallbackModelRuntime` 增加观察接口：

- 远程成功时记录 `remote_available` 和实际远程模型。
- 远程失败时记录失败原因并切换为 `fallback_local`。
- 回退后暂停后续步骤的重复远程请求，避免每一步都等待同一个失败端点。
- 用户在设置页重新测试成功后，恢复远程模型优先。

本地规则模型仍保证远程不可用时 Demo 流程可以继续。

## 6. UI 改动

新增“设置”导航和远程模型设置页：

- 顶部栏显示本地模式、远程已配置、检测中、远程可用、已回退本地或连接失败。
- 设置页展示脱敏端点主机、模型 ID、实际 provider 和最近检测时间。
- 提供“测试连接”操作。
- 执行页在远程失败后显示回退原因和设置入口。
- 普通浏览器模式明确显示 Electron bridge 不可用并使用本地模型。

## 7. 安全边界

- API Key 只由 Electron 主进程读取。
- API Key 不使用 `VITE_` 前缀，不进入 renderer bundle。
- preload 不提供读取密钥的方法。
- IPC 只返回端点主机，不返回完整请求地址或 Authorization header。
- 错误结果不返回远程原始响应体。
- 自动测试验证成功和失败 IPC 数据中均不包含 API Key。

## 8. 自动验证

新增或扩展的验证：

| 命令 | 覆盖范围 |
| --- | --- |
| `npm run verify:agent-core` | P0 重规划、协议动作、连接控制器、回退原因和失败熔断 |
| `npm run verify:model-client` | 未配置、非法端点、401、超时、非法响应、非法 JSON、成功和密钥防泄漏 |
| `npm run verify:production-build` | Electron production 相对资源路径和文件存在性 |
| `npm run verify:electron-renderer` | 真实 production renderer、设置导航、安全摘要和连接状态切换 |
| `npm run typecheck` | renderer、Vite 配置和 Electron 主进程 TypeScript |

本次验证结果：

```text
Agent Core scenario passed: revision=4, phase=handoff
Remote model client passed: configuration, auth, timeout, response and success cases verified
Production renderer build passed: 2 relative assets verified
Electron renderer passed: settings, safe metadata and connection test UI verified
```

自动验证使用受控 Mock transport，没有调用 `.env` 中配置的真实远程模型。

## 9. 关键文件

| 文件 | 作用 |
| --- | --- |
| `src/features/agent-core/modelConnection.ts` | 应用级连接状态、测试和回退熔断 |
| `src/features/agent-core/remoteModel.ts` | 远程决策校验与可观测回退 |
| `src/features/agent-core/useAgentCore.ts` | 组装模型连接控制器、IPC transport 和 Agent Runtime |
| `electron/modelClient.ts` | 远程配置、HTTPS 请求与结构化错误 |
| `electron/main.ts` | 注册窗口和模型 IPC |
| `electron/preload.ts` | 暴露最小安全模型桥接接口 |
| `src/components/AgentViews.tsx` | 顶部连接状态、设置页和回退提示 |
| `scripts/verify-model-client.mjs` | 主进程模型客户端测试 |
| `scripts/verify-electron-renderer.cjs` | production Electron renderer 冒烟测试 |
| `scripts/verify-production-build.mjs` | production 资源路径回归测试 |

## 10. 后续工作

下一优先级是严格计划验证器：先补充任务能力需求、资源提供能力、替代能力和平台兼容数据，再校验必需能力、依赖闭包、来源、授权以及审批 revision 绑定。
