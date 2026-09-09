# Repository Intelligence 下一步优化计划

日期：2026-09-03  
状态：提案  
前置能力：已完成受控本地/GitHub 固定仓库 Tree 读取与结构概览

## 1. 决策摘要

下一阶段不应继续扩大为“任意文件读取”或“任意命令执行”。优先建设 **项目一键体检（Project Health Check）**：将当前已有的固定仓库 Tree、白名单项目证据、项目要求提取和本机环境观测，汇总为用户可直接理解的结论：

> 这个项目是什么、如何启动、本机还缺什么、下一步应该做什么？

安全能力继续作为硬性边界和结论证据，而不是占据用户界面的主要输出。

## 2. 当前基础与产品缺口

### 已具备的能力

- 固定本地 HEAD 与固定 GitHub commit/tree 的受控目录枚举。
- 本地/GitHub 的白名单项目证据读取，拒绝 `.env`、凭证、私钥和任意路径。
- Node、Python、C/C++、Rust、Go 等生态的项目要求提取。
- 本机 Node、npm、Python、pip、Git、CMake、CUDA、Qt、OCCT 等固定白名单环境探测。
- 项目要求与本机环境的保守兼容性对照。

### 当前缺口

- 结果仍以工具调用和技术性证据为主，用户无法直接获得“项目怎么跑”。
- 没有统一的入口、脚本、推荐命令、环境变量名称和风险结论。
- GitHub 操作入口仍偏向“分析环境”，本地导入后也偏向工作区交接，缺少明确的 Repository Intelligence 任务选择。

## 3. 目标与非目标

### 目标

- 生成可持久化、可审计、带证据的 `ProjectHealthReport`。
- 提供技术栈、入口、建议启动/构建/测试命令、环境差距、变量名称和风险项。
- 输出三类静态结论：`ready_to_run`、`repairable`、`needs_manual_review`。
- 每项结论绑定相对路径、对象身份、固定 commit、置信度和“未执行”状态。

### 非目标

- 不执行项目代码、Shell、Docker、安装依赖或修改文件。
- 不读取真实 `.env`、Token、凭证、私钥或任意未白名单文件。
- 不以 LLM 的自由文本作为命令、风险或安全结论的唯一来源。
- 首版不联网查询 CVE、包评分或漏洞数据库。

## 4. 优先级与实施顺序

### P0：可发现性与任务选择

在本地导入或 GitHub 固定 commit 后，提供明确的只读任务入口：

```text
项目体检 ｜ 结构概览 ｜ 环境兼容性
```

每个入口对应独立的 Domain Skill 和 Task Plan，不复用或扩大其他任务的权限。GitHub 的操作文案从单一“分析环境”调整为先固定 commit、再选择分析目标。

验收标准：用户无需理解内部工具，就能选择“项目体检”并知道其不会执行项目。

### P1：确定性 Project Health Core（下一 PR）

新增纯函数模块 `src/features/agent-core/projectHealthCheck.ts`。它只接收受控输入，不访问文件系统、网络或 LLM：

```text
固定 Tree + 白名单证据文件 + 项目要求 + 本机环境
  → ProjectHealthReport
```

首个垂直切片只支持 Node.js：

- 从 `package.json` 提取 `scripts`、`main`、`bin`、`engines`、`packageManager`。
- 结合 `package-lock.json`、`pnpm-lock.yaml`、`yarn.lock` 判断包管理器与冲突风险。
- 将 `start`、`dev`、`build`、`test` 脚本转化为不可执行的建议命令。
- 结合既有环境对照，生成“静态可尝试运行 / 可修复 / 需要人工确认”的结论。

验收标准：对一个 Node 项目，不读取任意源码、不执行命令，即可回答入口、建议操作和缺失运行时。

### P2：命令与证据安全模型

命令不能由 LLM 编造，也不能将 README 任意代码块直接提升为可执行建议。

- 清单字段中的脚本可作为 `source: manifest` 的建议命令。
- README 只能作为运行时、安装前置条件或变量说明证据。
- 约定推断必须显式标记 `source: convention` 与较低置信度。
- 所有命令固定为 `executionStatus: not_executed`；界面只提供复制，不提供运行按钮。

验收标准：恶意 README、提示注入文本或任意代码块都不能生成可执行权限或改变建议命令。

### P3：静态风险与结论规则

由确定性规则生成风险，LLM 仅负责依据结构化报告组织解释：

- 仓库 Tree 截断。
- 未识别生态或关键清单无法解析。
- 多锁文件、多个包管理器或缺少锁文件。
- 找不到可信入口或启动脚本。
- 证据文件截断。
- 可能需要环境变量但没有模板或明确说明。
- 动态安装脚本、来源冲突或关键要求无法比较。

`ready_to_run` 只代表静态前提满足，界面文案应为“静态检查通过，可尝试运行”，不能声称项目已经运行成功。

### P4：Tool 接入、历史与结果页

在 P1 的纯函数稳定后，再接入受控 Main 工具、SQLite 和 Renderer：

- 使用受限组合工具编排有限次 Tree、白名单文件和本机环境读取。
- 报告绑定本地 HEAD 或 GitHub 固定 commit，并拒绝过期仓库句柄。
- 持久化结构化报告与摘要，不保存绝对路径、文件全文或环境变量值。
- 新增结果页：结论卡、项目概览、推荐操作、环境差距、变量、风险和证据抽屉。
- 支持导出 Markdown/JSON Runbook，不增加执行权限。

验收标准：用户在 30 秒内能理解“项目是什么、怎么启动、缺什么、下一步做什么”。

## 5. 建议的数据模型

```ts
type ProjectHealthStatus =
  | "ready_to_run"
  | "repairable"
  | "needs_manual_review";

type RecommendedProjectCommand = {
  kind: "install" | "start" | "build" | "test";
  command: string;
  source: "manifest" | "convention";
  executionStatus: "not_executed";
  evidence: ProjectHealthEvidence[];
};

type ProjectHealthReport = {
  reportId: string;
  analyzedAt: string;
  provenance: { kind: "local" | "github"; commitSha: string; treeTruncated: boolean };
  ecosystems: GitHubProjectEcosystem[];
  entrypoints: ProjectEntrypoint[];
  commands: RecommendedProjectCommand[];
  requirements: ProjectRequirementsOutput;
  compatibility: ProjectCompatibilityAssessment;
  environmentVariables: ProjectEnvironmentVariable[];
  risks: ProjectHealthRisk[];
  status: ProjectHealthStatus;
  summary: string;
};
```

`ProjectHealthEvidence` 只能包含相对路径、对象身份、已裁剪摘要、置信度和截断状态；不能包含绝对路径、真实 `.env` 内容或任何凭证。

## 6. 下一 PR 的建议范围

建议提交标题：

```text
feat: add deterministic Node project health check core
```

包含：

1. 新增报告类型、schema 和纯函数 `projectHealthCheck.ts`。
2. 支持 Node `package.json` 脚本、入口、运行时和锁文件规则。
3. 静态风险和三类结论判定。
4. 纯函数 fixture 测试：可运行、Node 版本不足、锁文件冲突、无入口、Tree 截断、恶意 README。

不包含：Main IPC、SQLite 迁移、结果页面、Python/CMake 多生态扩展、通用全文检索或任何执行权限。

## 7. 后续扩展边界

完成项目体检首版后，再依次评估：

1. Python、CMake、Rust、Go 和容器配置适配器。
2. 受控代码检索和分块阅读，用于用户明确提出的源码问答。
3. 隔离环境中的安装、构建和测试验证；每一步需独立审批、日志和可回滚边界。
4. 离线 SBOM、许可证和可选 CVE 数据源。

在上述能力完成前，不应引入通用 Shell、任意文件读取或自动修复项目的权限。
