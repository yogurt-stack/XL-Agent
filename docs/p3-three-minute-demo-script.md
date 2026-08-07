# P3 固定三分钟演示脚本

## 演示前

1. 使用 Windows x64 CI 产物启动应用。
2. 打开“设置”确认版本、两个 Domain Skill、可信目录和 SQLite 状态。
3. 点击“重置 Demo 数据”，再点击“确认永久清除”。
4. 打开“历史”，确认显示“还没有历史任务”。

## 0:00–0:35：自然语言与 Skill

输入：

```text
准备一个科研数据分析工作区
```

说明系统由 Main 注册表路由到 `research-data-environment`，不是 Renderer 关键词演示。

选择：

```text
只准备科研基础工具
```

## 0:35–1:10：可信计划与人工控制

打开资源计划，展示 Python、VS Code 和 Git：

- 来源、版本、大小、授权、用途。
- 目录版本和源码哈希固定。
- 可取消资源，但必需能力缺失会阻止审批。

确认计划 r1。

## 1:10–2:05：真实下载任务与失败恢复

切换到预置的 Python AI Demo 流程，展示：

- 流式进度、速度、ETA。
- 暂停/恢复。
- 示例项目首次 SHA256 失败。
- 重试主来源、可信替代或 Agent B 只读检查。

选择“使用可信替代来源”，确认新的 revision。

## 2:05–2:45：Agent Ready Workspace

展示：

- `resource-manifest.json`
- `RESOURCE_MANIFEST.md`
- `README.md`
- `AGENTS.md`
- `downloads/`

强调资源状态来自 SQLite/下载适配器，Markdown 由 Manifest 派生；“资源已准备”不等于“软件已安装”。

运行 Agent B，确认答案包含 Manifest revision、已准备项、缺失项、允许动作和禁止动作。

## 2:45–3:00：恢复与分发证据

打开“历史”展示审批、签名、断点与操作审计。最后展示 CI 中：

- Quality。
- Electron E2E。
- Windows x64 package and smoke。

明确说明当前是 unsigned 内部 Demo；公开发布仍需 Windows 签名证书和 Windows 11 实体机验收。
