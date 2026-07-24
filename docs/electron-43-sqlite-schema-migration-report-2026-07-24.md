# Electron 43 与 SQLite Schema 版本改动报告

## 1. 当前状态

- 日期：2026-07-24
- 基线提交：`2bfbfe0`
- 发布状态：已获用户确认，完成验证后直接提交并推送 `main`；最终 commit 与 CI 结果以交付说明为准
- 改动目标：
  1. 将 Electron 30 升级到当前 npm registry 可安装的 Electron 43
  2. 为 SQLite 任务数据库建立可持续升级的 schema 版本和 migration 机制

## 2. Electron 升级

### 2.1 版本变化

| 项目 | 升级前 | 升级后 |
| --- | --- | --- |
| Electron 依赖 | `^30.0.1` | `^43.1.0` |
| 本地实际二进制 | Electron 30 | Electron `43.1.0` |
| `npm audit` | 1 个 high | 0 个漏洞 |

Electron 官方已经发布 43.2.0，但本机配置的 npm registry 在执行时尚未同步该版本，安装返回 `ETARGET`。因此本次使用 registry 可安装的最新版本 43.1.0。`package-lock.json` 将本次安装解析结果固定下来，后续 `npm ci` 不会自动漂移到其他版本。

### 2.2 兼容性审计

当前项目使用的 Electron 能力包括：

- `BrowserWindow`
- `app.whenReady`
- `ipcMain.handle` / `ipcRenderer.invoke`
- `contextBridge`
- `shell.openPath`
- sandboxed preload

这些 API 在 Electron 43 中仍然可用。项目没有使用本次升级范围中相关的已移除或行为变化 API，例如 frameless window、Dialog 默认目录、`nativeImage.toBitmap()` 或 renderer clipboard。

现有安全设置保持不变：

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- preload 只暴露逐项参数校验后的 IPC 方法
- API Key 仍只存在于 Electron 主进程

### 2.3 新增版本回归保护

`scripts/verify-electron-renderer.cjs` 现在会读取 `package.json` 中声明的 Electron 主版本，并与实际运行时 `process.versions.electron` 对比。这样可以发现以下问题：

- lockfile 已升级但本机仍在运行旧二进制
- Electron 二进制下载不完整
- CI 使用了与依赖声明不一致的运行时

## 3. SQLite Schema 版本

### 3.1 版本策略

数据库现在使用：

```sql
PRAGMA user_version;
```

当前支持版本：

```text
TASK_STORE_SCHEMA_VERSION = 1
```

v1 对应目前已经存在的任务持久化结构：

- `task_snapshots`
- `approval_records`
- `workspace_exports`
- 新增 `schema_migrations`

### 3.2 Migration 记录

新增表：

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
```

当前 migration：

| 版本 | 名称 | 内容 |
| --- | --- | --- |
| v1 | `initial-task-persistence` | 建立任务、审批、工作区导出和 migration 记录表 |

`TaskStore.getSchemaInfo()` 可以读取：

- 当前数据库版本
- 当前程序支持的最高版本
- 已应用 migration 的版本、名称和时间

### 3.3 升级行为

应用打开数据库时执行：

```text
读取 PRAGMA user_version
→ 检查数据库是否比程序更新
→ 按版本顺序执行尚未运行的 migration
→ migration 与 user_version 更新放在同一事务
→ 全部成功后原子写回数据库文件
```

具体保证：

- 新数据库自动创建并升级到 v1。
- 现有项目生成的未标版本数据库按 v0 处理。
- v0→v1 不删除已有任务、审批或工作区导出数据。
- migration 失败会回滚事务。
- 数据库版本高于程序支持版本时拒绝打开，不尝试降级或覆盖。
- 原有数据库文件仍通过临时文件加 rename 原子持久化。

### 3.4 后续增加 migration 的方式

以后修改表结构时，需要：

1. 将 `TASK_STORE_SCHEMA_VERSION` 增加 1。
2. 在 `schemaMigrations` 中追加连续的新版本。
3. 只在新 migration 中执行 `ALTER TABLE`、建表或数据转换。
4. 增加“旧版本数据升级后仍可读取”的验证场景。
5. 不修改已经发布 migration 的语义。

## 4. 测试结果

当前已通过：

- `npm audit --json`：0 个漏洞
- `npm run typecheck`
- `npm run test:run`：8 个文件、36 个测试
- `npm run verify:persistence`
  - 新数据库升级到当前版本
  - migration 记录存在
  - v0 数据升级后保留
  - 高于支持版本的数据库被拒绝
  - 原有审批有效期、恢复、审计和原子导出继续通过
- `npm run verify:electron-renderer`
- `npm run test:e2e`：5 条 Electron E2E 全部通过

## 5. 远端验证计划

改动推送 `main` 后，通过 GitHub Actions 继续验证以下项目：

- Ubuntu/Xvfb 下 Electron 43 的 5 条 E2E
- Chromium 150 对 Linux 视觉基线的影响
- GitHub `npm ci` 对 Electron 43 二进制的下载情况

本地 macOS 功能测试已通过，但 Electron 主版本升级可能造成 Linux 字体或 Chromium 渲染像素变化。如果远端仅出现视觉快照差异，应先检查实际图片，再决定是否更新基线，不能直接放宽全局视觉阈值。

## 6. 本地改动文件

- `package.json`
- `package-lock.json`
- `electron/taskStore.ts`
- `scripts/verify-persistence.mjs`
- `scripts/verify-electron-renderer.cjs`
- `docs/electron-43-sqlite-schema-migration-report-2026-07-24.md`

## 7. 结论

本次改动已经达到本地可审查状态：

- Electron 已跨越原审计风险范围，`npm audit` 清零。
- Electron 43 的 renderer、IPC、SQLite 和端到端主流程均能运行。
- SQLite 已从“仅创建表”升级为有版本、可迁移、可审计、可拒绝未来版本的持久化结构。
- 改动已获确认，将在本地验证通过后直接提交并推送 `main`，并等待远端 CI 完成。
