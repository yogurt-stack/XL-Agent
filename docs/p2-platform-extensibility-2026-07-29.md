# P2 平台扩展与模型配置产品化

日期：2026-07-29

## 1. P2 定义

最初 v1.1 产品计划没有使用 P0/P1/P2 标签。P2 延续 P0 的资源编排和 P1 的供应链安全，完成原计划“新增领域 Skill 不修改 Agent Core、下载适配器或 IPC”以及远程模型配置产品化：

1. 第二个真实 Domain Skill。
2. Skill 自有澄清、能力需求和工作区模板。
3. Main 进程动态能力清单。
4. OpenAI-compatible Provider 与 Endpoint/Base URL 双配置模式。

P2 不增加任意模型 Provider、模型生成 URL、自动安装或 Agent B 写权限。

## 2. 第二领域 Skill

默认注册表现在包含：

- `ai-development-environment`
- `research-data-environment`

科研数据 Skill 匹配科研、论文复现、数据分析、Jupyter/Notebook 等明确资源准备目标。它会询问是否需要示例工作区，再确定以下能力：

```text
python-runtime
code-editor
source-control
workspace-template（用户选择时）
```

离线模型不再针对新增 Skill 重新推断旧的 AI 开发意图，而是统一将 Skill 的能力集合映射到 active 可信目录资源。这使新增 Skill 不需要修改 Router、状态机、下载适配器和 IPC。

`research-data-workspace` 生成科研领域的 README/AGENTS 指南，并持续声明“资源已准备不等于环境已安装”。

## 3. 动态能力清单

`AgentRuntimeSnapshot.capabilities` 由 Electron Main 注册表生成：

```text
domainSkills[]
sourceProviders[]
workspaceTemplates[]
```

首页和设置页只展示该清单，不再在 Renderer 硬编码“已安装 Skill”。以后注册新 Skill 或模板时，IPC 结构无需继续变化。

## 4. 模型 Provider 与 Base URL

主进程配置支持：

```dotenv
XL_AGENT_LLM_PROVIDER=openai-compatible

# 二选一
XL_AGENT_LLM_ENDPOINT=https://models.example.com/v1/chat/completions
# XL_AGENT_LLM_BASE_URL=https://models.example.com/v1

XL_AGENT_LLM_MODEL=model-id
XL_AGENT_LLM_API_KEY=secret
```

规则：

- 当前只注册 `openai-compatible`，未知 Provider 失败关闭。
- Endpoint 和 Base URL 同时存在时拒绝启动远程配置。
- Base URL 只能是无凭据、无 fragment/query 的 HTTPS URL。
- Main 将 Base URL 规范化并追加 `/chat/completions`。
- Renderer 只接收 Provider ID、端点模式、主机和模型 ID，不接收完整 URL 或 API Key。
- 远程协议继续强制单一、非并行、严格 JSON Schema 的原生 tool call。

## 5. 验收证据

```bash
npm run typecheck
npm run test:run
npm run verify:model-client
npm run verify:p2-platform-extensibility
```

专项验证覆盖 Base URL 规范化、配置冲突、未知 Provider 拒绝、第二 Skill 路由、独立能力需求、可信资源映射和专属模板。

Electron E2E 会从自然语言目标进入科研 Skill，完成它自己的澄清并生成不包含示例包的严格计划。

## 6. P2 后续边界

- 当前没有 Anthropic、Gemini、Azure OpenAI 或 Responses API 适配器。
- 配置仍由 Main 进程环境变量读取，尚未接入 OS Keychain 配置编辑。
- 科研 Skill 当前准备基础工具，不下载数据集、不安装 Python 包，也不宣称科研环境已部署。
