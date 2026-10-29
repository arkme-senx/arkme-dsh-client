# Windows 安装器 ACL 身份转 SID：复现、根因与修复

日期：2026-10-26（北京时间）。基线：最新远端 master `75d74fab13b98ff8c97a63088fd7b062f961dc2f`。修复分支：`zp-codex/windows-installer-acl-sid-20261026`。

## 根因

旧 `Assert-ProtectedObject` 从 `$acl.Access` 取得规则，IdentityReference 可能已经被格式化为本地化的 NTAccount 名称；随后再次执行 `Translate(SecurityIdentifier)`。远程 Windows 11 测试机上，系统默认应用包账号的名称无法反向解析，导致只读规则也抛出 IdentityNotMapped 异常，中止 Apply。

实机只读检查 `C:\Program Files`，观察到以下身份：

| ACL 显示名称 | ACL 中保存的 SID | 权限 | 旧名称反向转换 |
| --- | --- | --- | --- |
| APPLICATION PACKAGE AUTHORITY\ALL APPLICATION PACKAGES | S-1-15-2-1 | ReadAndExecute, Synchronize | 抛出 Translate 异常 |
| APPLICATION PACKAGE AUTHORITY\所有受限制的应用程序包 | S-1-15-2-2 | ReadAndExecute, Synchronize | 抛出 Translate 异常 |

通过 `GetAccessRules(true, true, SecurityIdentifier)` 可直接读到这两个 SID，无需名称解析。Owner 检查本来已经使用 SID，不是此次故障来源。

根因是 ACL 身份在“SID → 显示名称 → SID”往返中的映射失败，不是这两个内置组获授危险权限，也无需通过删除 ACL 或放宽受保护目录权限来解决。该机真实规则复现了与 SLS 相同的失败机制；未读取另外六条历史报告所在机器的原始 ACL，不能断言它们失败于同一个具体 ACE。

## 复现与调查流程

1. 拉取最新 master，保留上一构建 worktree 的版本改动，在独立 worktree 开发。
2. SSH 到 192.168.3.231。环境为 Windows 11 10.0.26200.0、Windows PowerShell 5.1.26100.9711。
3. 仅只读枚举系统路径 ACL，逐条检查 IdentityReference 类型及 Translate 结果，定位到上述应用包账号。
4. 使用旧脚本 Library 模式调用 `Assert-ProtectedObject 'C:\Program Files' $true`，稳定出现：

   ```text
   使用“1”个参数调用“Translate”时发生异常:“未能转换部分或所有标识引用。”
   Assert-ProtectedObject / windows-migration-before.ps1:809
   ```

5. 在随机测试目录构造真实 Windows DACL，包含 Administrators/SYSTEM 完全控制，以及两个应用包 SID 的只读规则。旧脚本同样失败，修复后通过。
6. 使用真实签名的 Windows 文件作为测试 payload，进入生产 `Get-OverlayEntries → Assert-ProtectedObject` 机器级规划链路，确认其通过；不改写注册表、快捷方式或已安装应用。
7. 回归危险授权和所有者拦截，并执行既有受保护日志、恢复、文件事务和短路径测试。

## 修复

`Assert-ProtectedObject` 直接使用：

```powershell
$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
```

然后读取 `IdentityReference.Value`。显式和继承规则均保留。

未新增异常吞掉、跳过未知 SID、信任应用包组或权限放宽分支。所有者白名单、Allow/Deny 判断、危险权限位掩码、Ancestor 和 InheritOnly 语义保持不变。

## 验证

| 验证 | 结果 |
| --- | --- |
| 旧脚本 + 系统真实 Program Files ACL | 复现 Translate 异常 |
| 旧脚本 + 隔离真实 DACL 夹具 | 复现相同异常 |
| 修复脚本 + 系统真实 Program Files ACL | 通过，只读检查 |
| 修复脚本 + 显式/继承应用包只读规则 | 通过 |
| 机器级 Get-OverlayEntries + 真实签名 payload | 通过 |
| 两个应用包 SID、无法映射的 SID、当前用户 SID × 五种危险授权 | 20 组全部拒绝 |
| Ancestor 的删除/修改 ACL/接管权限拒绝、Write 差异 | 保持原行为 |
| Deny、InheritOnly、子目录实际继承写权限、不可信 Owner | 保持原行为 |
| Windows Vitest 专项入口 | 1 passed；其余 21 项由名称筛选跳过 |
| protected-journal.ps1 | 通过 |
| recovery.ps1 | 45 个恢复场景通过 |
| transaction.ps1 | 通过 |
| short-path.ps1 | 通过 |
| 本地 policy / integration / installer-diagnostics | 17 passed / 12 skipped（平台或权限限定） |
| git diff --check | 通过 |

新增 `acl-sid.ps1` 仅修改自身临时夹具 ACL，并在 finally 清理。Vitest 入口在具备提升后管理员令牌的 Windows 环境执行该专项，其他环境明确跳过，避免要求普通开发者为全套本地测试提升权限。远端入口初次缺少依赖的 policy 源文件，补齐后重跑通过。

## 交付边界

本报告覆盖源码修复与 Windows 实机回归，未构建或发布新安装包。之前已交付的 3.0.20 / 298 签名包未修改，不含本次 ACL 修复；用户安装侧生效需要后续重建并签名。

未修改系统目录 ACL、现有应用、业务数据，也未触及此前记录的标准用户 WMI 权限或启动页面等待问题。本轮未执行新的完整 EXE 安装验收。
