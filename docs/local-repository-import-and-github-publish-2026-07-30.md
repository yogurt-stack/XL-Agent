# 本地仓库导入与 GitHub 发布边界

日期：2026-07-30

## 已实现闭环

### 本地仓库导入 Agent

1. Renderer 只能调用 `selectLocalRepository` 白名单 IPC。
2. Main 使用系统目录选择器取得用户明确选择的单个目录。
3. `inspectLocalRepository` 要求标准 `.git` 目录，并以 `execFile`、`shell: false` 和固定 Git
   参数读取顶层目录、HEAD、分支、porcelain v2 状态、HEAD tree 与文件清单。
4. Main 为源路径分配随机 `repositoryHandleId`。绝对路径只保留在当前进程内存，不进入 Agent
   状态、SQLite、Manifest、Renderer 或 Agent B。
5. 状态机创建 `local-repository-import` handoff r1，Manifest 原子落盘；Agent B 继续使用原有
   task/revision/grant/TTL 只读权限检查项目准备度。

### 审批后发布到 GitHub

1. 只读取 `XL_AGENT_GITHUB_PUBLISH_TOKEN`；不复用 `XL_AGENT_GITHUB_TOKEN`。
2. 计划阶段仅执行 GitHub 用户与目标存在性查询，固定 create-only/no-force 计划及 SHA256。
3. 执行阶段要求精确匹配 `publishId + planSha256`，Main 单航班闸门阻止重复审批。
4. 审批审计在任何 GitHub 写请求前写入 SQLite。
5. 发布前重新运行本地检查；源必须仍是同一 clean HEAD 和文件指纹。
6. 文件内容从固定 HEAD 的 Git blob 读取，不从可能变化的工作树读取。
7. GitHub API 依次创建新仓库、blob、tree、root commit 与分支；不覆盖已有仓库、不强推。
8. 仓库创建后的部分失败不会触发自动删除或重试，结果保留远程链接供用户人工处理。

该发布结果是固定 HEAD 文件内容的新 root commit，不包含本地仓库的原提交历史。
等待审批、发布中、已发布或失败状态会进入后续 Manifest revision；其中不包含 Token 或本地绝对路径。

## 失败关闭规则

- 拒绝非仓库顶层目录、Git worktree、符号链接入口和缺少 HEAD 的仓库。
- 拒绝 dirty/conflicted 仓库、子模块、符号链接、疑似密钥文件。
- 拒绝超过 2,000 个文件、单文件 5 MiB 或总计 50 MiB。
- 拒绝已存在或无法确认不存在的目标仓库。
- 拒绝过期、变更、重复或与当前本地仓库句柄不匹配的审批。
- GitHub 返回的 owner、仓库名、可见性或 URL 与计划不一致时停止上传。

## 验证

- `electron/localRepository.test.ts`：脱敏摘要、dirty 状态、固定 Git blob、非仓库拒绝。
- `electron/githubPublisher.test.ts`：独立 Token、固定计划、敏感文件拒绝、Git Data API 顺序、
  审批后源变化失败关闭。
- `electron/singleFlightGate.test.ts`：重复审批并发互斥。
- `src/features/agent-core/localRepositoryFlow.test.ts`：导入、发布计划、执行与句柄隔离状态。
- `npm run typecheck`
- `npm run test:run`
- `npm run verify:electron-renderer`
