# P1 供应链安全与跨重启恢复实现说明

日期：2026-07-26

## 1. P1 定义

最初产品计划没有直接使用 P0/P1 标签。本项目依据原计划的实施阶段、P0 明确排除项和已有后续优先级，将 P1 定义为下载资源编排的可靠性与供应链安全层：

1. 可信目录条目生命周期和审批版本固定。
2. Windows Authenticode、预期发布者与 SHA256 的组合验证。
3. HTTP Range / If-Range 跨应用重启续传。
4. SQLite v4、操作事件、Manifest 和历史 UI 审计。

P1 不增加自动安装、自动解压、任意 Shell/PowerShell、环境变量写入或 Agent B 写权限。这些能力仍在原计划禁止边界之外。

## 2. 可信目录生命周期

`catalog/trusted-resources.json` 仍是唯一目录事实源，目录版本为 `2026.07.26.2`。条目现在可声明：

- `active`：可进入新计划、fallback 和替换关系。
- `deprecated`：保留历史解释，但不进入新计划。
- `revoked`：来源或制品不再可信，不进入任何新计划。

非 active 条目必须提供 `statusReason`；可选 `replacedBy` 必须指向仍为 active、且保持所需能力的条目。生成器会同时拒绝指向非 active 条目的 fallback。

Renderer 的 `SourceProvider` 和严格计划验证器分别执行过滤与最终拒绝，避免单层漏检。Electron Main 只为 active ID 返回下载与签名元数据。

## 3. 审批绑定目录版本

SQLite `approval_records` 新增：

```text
catalog_version
catalog_source_sha256
```

用户批准 plan revision 时，Main 将当前生成目录的 `catalogVersion` 和完整源 JSON SHA256 一起写入审批。下载和工作区导出读取审批时会再次检查目录固定值：

```text
task ID + plan revision + TTL + catalog version + catalog source SHA256
```

任一条件不匹配都不能执行。v3 升级时无法证明目录版本的旧 active 审批会被标记为 `revoked`，不能沿用。

## 4. Authenticode 与发布者校验

目录签名策略分为：

- `required`：Windows Authenticode 必须有效，且签名发布者必须匹配 `expectedPublisher`。
- `checksum-only`：该格式不声明嵌入式 Authenticode，只执行可信上游固定 SHA256。
- `not-applicable`：资源类型不适用嵌入式签名。

`ElectronArtifactVerifier` 的提升条件为：

```text
普通文件、非符号链接
  + SQLite 字节数与 SHA256
  + 当前计划 expectedSha256
  + 来源 Host allowlist
  + required 时 Windows Authenticode = Valid
  + expectedPublisher 匹配
  -> verified
```

Windows 检查由 `WindowsAuthenticodeVerifier` 完成。它使用系统自带、固定编码的 `Get-AuthenticodeSignature` 检查系统信任结果；文件路径只通过环境变量传入。模型、用户输入和下载内容都不能提供脚本或参数，且该能力没有注册为 Agent Tool。非 Windows 主机返回 `unavailable`，required 策略失败关闭。

SQLite `download_artifacts` 保存：

```text
signature_status
expected_publisher
actual_publisher
certificate_thumbprint
signature_message
signature_checked_at
```

持续 Manifest 和最终不可变工作区 Manifest 同步包含签名结论。最终导出会再次拒绝 required 但不是 `valid` 的制品。

参考的系统语义：

- Microsoft `WinVerifyTrust`：<https://learn.microsoft.com/windows/win32/api/wintrust/nf-wintrust-winverifytrust>
- Microsoft `Get-AuthenticodeSignature`：<https://learn.microsoft.com/powershell/module/microsoft.powershell.security/get-authenticodesignature>

## 5. HTTP Range 跨重启恢复

`download_tasks` 新增：

```text
resume_etag
resume_last_modified
resume_capable
resumed_from_bytes
```

首次传输在读取响应体前就保存受控临时文件位置；进度批次保存实际字节数和服务端验证器。应用重启时：

1. `downloading/paused` 转为 `interrupted`。
2. 旧执行审批被撤销，用户必须重新确认当前 revision。
3. 适配器只恢复 SQLite 标记可续传、路径仍位于受控临时根目录的普通文件。
4. 客户端按实际文件长度发送 `Range: bytes=<offset>-`。
5. 有 ETag 或 Last-Modified 时同时发送 `If-Range`。
6. `206` 必须提供起点完全一致的合法 `Content-Range`。
7. 服务端返回 `200` 表示不接受当前断点，客户端删除旧部分并从零安全重下。
8. 错误区间、越界文件、符号链接或受控目录外路径会失败关闭。
9. 最终对“旧字节 + 新字节”重新计算完整 SHA256；不匹配时删除制品。

网络中断和可恢复写入错误会保留断点；用户显式取消、大小越界和最终 SHA256 不匹配会清理受控制品。

`LocalXunleiAdapter` 仍是后端替换边界。P1 完成的是本地后端的真实续传语义，不宣称已经接入迅雷 SDK。

## 6. SQLite v4 与操作审计

v4 migration 名为：

```text
p1-supply-chain-resilience
```

迁移以事务执行，兼容存在部分新列但 `user_version` 滞后的数据库，并继续拒绝高于当前版本的数据库降级打开。

新增 `operation_events`：

- `catalog-approval-pinned`
- `catalog-pin-rejected`
- `download-checkpointed`
- `download-resumed`
- `signature-verified`
- `signature-rejected`

历史任务页显示审批固定的目录版本/哈希、制品签名状态、发布者和供应链操作事件。该页面仍为只读查询，不会恢复任务或触发工具。

## 7. 验收

`npm run verify:p1-supply-chain-resilience` 独立验证：

- deprecated/revoked 目录条目不会进入新计划。
- Range 与 If-Range 使用持久化字节偏移和 ETag。
- 合法 `206 Content-Range` 追加成功并复核完整 SHA256。
- 错误 Content-Range 不修改断点。
- 服务端忽略 Range 返回 `200` 时安全重下。
- SQLite 中断记录经关闭/重开后由 `LocalXunleiAdapter` 真正恢复。
- 固定用途 Windows 签名检查和非 Windows unavailable 边界。
- 有效签名与发布者匹配后才能提升为 verified。
- 有效签名但发布者不符仍被拒绝。
- 签名与续传结论写入 operation audit。
- v3 数据库升级到 v4，并撤销未固定目录的旧审批。

全量门禁：

```bash
npm run typecheck
npm run test:coverage
npm run verify:ci
npm run test:e2e
git diff --check
```

## 8. P1 之后仍未完成

- 真实迅雷 SDK/服务接入。
- Windows 安装包的实体机 Authenticode 兼容矩阵与发布签名。
- 自动安装、解压或执行下载物；这些仍不属于当前产品授权范围。
- Agent B 写文件、创建下载或执行命令。
- 多设备目录更新服务、在线撤销推送与企业策略中心。
