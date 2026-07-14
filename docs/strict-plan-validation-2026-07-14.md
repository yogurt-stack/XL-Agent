# 严格计划验证与 revision 审批绑定改动说明

## 1. 改动目标

本轮将资源计划从“过滤未知 ID 后直接等待审批”升级为“先推导任务能力需求，再对可信资源、依赖、系统、来源、授权和 revision 做结构化验证”。

真实下载、文件写入、SQLite、MCP 和插件仍未接入。

## 2. 任务能力与资源能力

新增任务能力：

- `python-runtime`
- `code-editor`
- `source-control`
- `node-runtime`
- `workspace-template`

`taskRequirements.ts` 根据任务文本和澄清答案生成确定性的 `TaskRequirements`。模型可以从可信目录中选择不同资源，但不能省略任务要求的能力。

可信资源目录新增：

- `provides`：资源提供的能力。
- `requiresCapabilities`：资源运行所需能力。
- `supportedOperatingSystems` 和 `supportedArchitectures`。
- `sourceTrust`：官方、可信目录、可信镜像或未验证来源。

依赖校验以能力为主。例如 `sample-project` 需要 Python 和源码管理能力，因此 `python-312` 切换为 `miniforge-py312` 后依赖仍然闭合。

## 3. 严格验证器

`planValidation.ts` 是无 UI、无网络、无状态写入的纯验证模块，覆盖：

- 空计划。
- 尚未澄清、无法形成能力需求的任务。
- 未知资源 ID。
- 重复资源 ID。
- 必需资源未选择。
- 任务必需能力缺失。
- 资源依赖能力缺失。
- 操作系统或架构不兼容。
- 来源信任级别不满足策略。
- License 不在允许列表。
- fallback 不存在或不能提供等价能力。
- 计划元数据与可信目录不一致。
- 审批 revision 与当前计划不一致。

模型提出未知或不完整计划时，不再静默过滤后进入审批，而是留在 `planning`，记录结构化验证问题，且不会获得新的 revision。

## 4. 状态机与 Policy

`AgentState` 新增：

- `taskRequirements`
- `planValidation`
- `approvedRevision`

计划链路变为：

```text
模型 create_plan
  -> 推导 TaskRequirements
  -> 严格验证资源 ID 与能力闭包
  -> 验证通过后生成 revision
  -> waiting_approval
  -> APPROVE_PLAN(revision)
  -> 再次验证完整计划和 revision
  -> approvedRevision = revision
  -> downloading
```

重规划生成的替代计划同样必须重新验证。`DefaultAgentPolicy` 和 `InMemoryAgentToolExecutor` 都会检查 `approvedRevision === revision`，避免仅依赖 UI 阶段推断审批有效性。

Manifest 现在包含任务需求、计划验证结果和已审批 revision。

## 5. UI

资源计划页新增严格验证卡片：

- 展示当前任务的必需能力。
- 展示结构化阻断原因。
- 只有验证结果属于当前 revision 且 `valid = true` 时才启用确认按钮。
- 确认按钮只有在状态机实际进入 `downloading` 后才导航到执行页。

## 6. 点击路径审计

本轮按共享状态写入顺序检查了任务提交、澄清、资源勾选、计划确认和失败处置按钮。

发现并修复：下载或验证期间，状态机会拒绝新任务，但首页原先仍无条件跳转到澄清页。现在首页会禁用任务入口，并且导航只发生在 `SUBMIT_TASK` 真正进入 `routing` 后。

同时收紧：

- 计划确认只在 revision 审批成功后导航。
- Agent B 按钮只在状态真正进入 delegated handoff 后导航。

没有发现资源勾选、重试原来源、可信替代来源或澄清按钮存在后续状态写入撤销前一步结果的问题。

## 7. 自动验证

`verify:agent-core` 新增：

- 完整 Python 计划通过。
- 未知和重复资源拒绝。
- 缺少任务能力拒绝。
- 缺少依赖能力拒绝。
- 系统、来源、授权和 fallback 策略拒绝。
- 可信目录元数据篡改拒绝。
- 非法模型计划不能进入审批。
- 过期 revision 审批拒绝。
- 当前 revision 审批绑定成功。
- 无审批 revision 的下载被 Policy 拒绝。
- 能力等价 fallback 仍保持计划有效。

Electron renderer 冒烟测试新增完整点击路径：

```text
首页提交 Python 任务
  -> 回答澄清
  -> 生成计划
  -> 查看严格验证结果
  -> 确认当前 revision
  -> 进入执行页
```

脚本同时修复了 Electron 断言失败可能被 `app.quit()` 吞掉退出码的问题。

## 8. 下一步

建议下一阶段引入正式测试体系和 CI：

1. Vitest：拆分状态机、验证器、Policy 和 Tool 单元测试。
2. Playwright 或 Electron E2E：覆盖三个失败处置按钮和首页到交接流程。
3. GitHub Actions：自动运行 typecheck、Agent Core、模型客户端和 production build 验证。

完成测试体系后，再进入真实系统画像、下载器、SHA256、原子文件写入和工作区导出。
