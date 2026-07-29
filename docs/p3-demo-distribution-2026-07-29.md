# P3 Demo 运营与 Windows 分发

日期：2026-07-29

## 1. P3 定义

P3 对应原始计划阶段 5 中尚未完成的“一键重置 Demo 数据、固定三分钟演示脚本、Windows 可执行程序”。交付范围：

1. SQLite v5 事务化 Demo 重置。
2. 两步人工确认和维护审计。
3. Windows x64 unpacked、NSIS 与 ZIP 打包链路。
4. ASAR 内容、密钥排除和打包应用启动验证。
5. 全新的 Windows CI runner 构建与上传 Demo 产物。

## 2. 安全 Demo 重置

设置页第一次点击只进入确认状态，第二次“确认永久清除”才调用白名单 IPC。Renderer 不能传清理路径，IPC 必须携带固定确认令牌。

Main 会拒绝在以下状态重置：

- 下载中。
- 验证中。
- 工作区导出中。
- Agent B 检查中。

SQLite 事务清理以下运行数据：

```text
task_snapshots
approval_records
workspace_exports
download_artifacts
download_tasks
local_artifacts
resource_manifest_snapshots
agent_b_runs
operation_events
```

`schema_migrations` 和独立的 `maintenance_events` 不清除。每次重置保存 `demo-reset`、时间、操作者、各表清理数量和总数量，应用重启后仍可审计。

文件清理只允许：

- 系统临时目录下固定的 Agent 下载根目录。
- 未配置 `XL_AGENT_WORKSPACE_ROOT` 时的 Electron `userData/workspaces`。
- E2E 模式的固定 fixture 根目录。

显式配置的工作区根和用户通过目录选择器指定的位置不会被递归删除。

## 3. Windows 打包

版本：`0.3.0`

打包器：固定 `electron-builder 26.15.3`

目标：

- Windows x64 NSIS 交互式、per-user 安装器。
- Windows x64 ZIP。
- `win-unpacked` 测试目录。
- ASAR。

```bash
npm run package:win:dir
npm run package:win
```

配置明确只包含 production renderer、Electron Main/preload、`package.json` 和生产依赖，并排除 `.env`、`.env.*` 和 source map。

`verify-windows-packaging` 检查 appId、产品名、版本、x64 target、交互式安装边界、ASAR 中的 Main/preload、SQLite 等运行依赖和密钥排除。`test:packaged:win` 启动 `win-unpacked` 中的真实 exe，在离线 fixture 上完成自然语言任务、澄清、r1 审批、受控失败、r2 重规划、真实工作区导出和 Agent B Manifest 校验；同时检查窗口、preload/Main bridge、应用版本和 `win32` 平台。

## 4. CI 与产物

CI 新增 `Windows x64 package and smoke`：

1. 在全新 `windows-2022` runner 上执行 `npm ci`。
2. 构建 NSIS、ZIP 和 unpacked app。
3. 检查 ASAR。
4. 启动打包后的 Electron 应用并完成带失败恢复、工作区落盘和 Agent B 检查的离线流程。
5. 上传 `windows-x64-demo-unsigned`，保留 14 天。

该 runner 是可重复的干净 Windows 打包/启动证据，但不是 Windows 11 实体机兼容矩阵。

## 5. 签名与依赖审计边界

当前 CI 没有项目代码签名证书，因此产物名明确标记为 `unsigned`，只能用于内部 Demo，不能描述为可公开分发的受信任安装器。公开发布仍必须：

- 配置 Windows 代码签名或 Azure Trusted Signing。
- 对最终安装器执行 Authenticode 验证。
- 在 Windows 11 x64 实体机完成安装/卸载与完整三分钟流程。

`npm audit --omit=dev` 为 0。完整开发依赖审计仍报告来自 `electron-builder` 跨平台打包依赖树的 high 项；P3 使用固定版本、只从锁文件安装、只处理仓库内固定配置、不发布 macOS/Squirrel target。此边界必须持续跟踪，不能用生产依赖为 0 代替构建链审计。

Electron 官方也明确建议发布桌面应用时进行代码签名；因此 P3 不把 unsigned Demo 产物伪装成正式发行版。

参考：

- Electron Distribution Overview：<https://www.electronjs.org/docs/latest/tutorial/distribution-overview>
- electron-builder Windows：<https://www.electron.build/docs/win/>
- electron-builder CLI：<https://www.electron.build/docs/cli/>

## 6. 验收

```bash
npm run verify:p3-demo-distribution
npm run verify:windows-packaging
npm run test:e2e
npm run package:win
npm run test:packaged:win
npm audit --omit=dev
```

固定演示流程见 `docs/p3-three-minute-demo-script.md`。
