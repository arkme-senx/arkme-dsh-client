# 公共快捷方式删除权限导致所有用户安装失败

## 根因和调查步骤

2026-11-02，SLS `jotmo/jotmo-telemetry`、`desktop-installer` 主题中，3.0.24 / 302 的事件 `925566d0fcb34c6499919a3039f44192` 在 Apply 的 `Begin-Overlay` 第 1042 行调用 `Assert-ProtectedObject` 后报 `Untrusted write, deletion, or ACL-control permission on elevated recovery path.`。3.0.22、3.0.23 也有同栈失败。这一调用检查的是已有公共快捷方式，不是恢复目录本身；错误文案掩盖了实际对象类型。日志未记录失败 ACE，不能断言每个线上事件都具有相同 ACL。

使用用户指定的 Windows 11 26200 测试机 192.168.3.156，通过 SSH 管理员会话验证。先只读检查安装登记、公共桌面/公共开始菜单 ACL；机器有多个既有版本，因此不运行会覆盖真实登记的完整 NSIS 安装。

1. 在公共桌面、公共开始菜单各创建唯一命名的真实 COM `.lnk`，指向隔离的测试目标；不修改任何现有快捷方式或父目录权限。
2. 两处新链接自然继承本地用户 SID 的 `Delete` / `DeleteSubdirectoriesAndFiles` 权限（SDDL `DTSD`）；所有者仍是 Administrators。
3. 用 master `47689d8` 的未修改迁移脚本调用生产 `Begin-Overlay`。两处均在快捷方式检查复现同样异常，且尚未建立 journal、未落地 payload。
4. 同一测试夹具运行修复脚本，验证 Apply、受保护备份、文件哈希及回滚。

根因：将恢复元数据/可执行程序的不可删除 ACL 要求直接套用到公共 shell 快捷方式，拒绝了测试机实际继承的删除权限。这里的已知快捷方式是受路径、目标、参数与哈希约束的事务数据；其字节副本保存在受保护 journal 中，并不会作为提权命令执行。

## 修改

仅公共已知快捷方式调用启用 `AllowShortcutDeletion`：只允许 `.lnk` 普通文件的删除类授权，仍拒绝非受信所有者、写入、修改 ACL、取得所有权。程序 payload、恢复目录、备份文件及祖先 ACL 校验保持原逻辑。现有目标/参数识别、重解析路径拒绝、保护备份、未知变化保留等恢复检查继续生效。不改用户系统 ACL，不修改 UI、journal schema 或跨仓合同。

基于最新 master 建立独立分支 `zp-codex/windows-shortcut-acl-20261102`，未修改原任务 checkout。此次修复不涵盖腾讯安卓快捷方式身份不兼容、Electron 程序丢失或用户取消安装。

## 复现与测试

`tests/windows-migration/shortcut-acl.ps1` 需要管理员 Windows PowerShell 5.1。可传入旧脚本和 `-ExpectBaselineFailure` 在本次测试机验证旧版；其他机器若未继承删除权限，旧版模式会明确失败而非伪造复现。

夹具仅将 registry key 名和快捷方式位置重定向到唯一测试命名，使用签名有效的系统 PowerShell 文件作为 payload，并相应设置夹具发布者。真实运行生产 Authenticode、payload 清单、ACL、COM、journal、原子文件替换和回滚逻辑。未执行系统 PowerShell payload。测试文件在 finally 中清理，既有应用及登记不变。

- 未修改基线：公共桌面、公共开始菜单均复现，退出 0 表示预期失败被断言。
- 修复脚本：两种位置均完成 Apply 和 payload 校验，journal 为 active 且权限检查通过；回滚删除新 payload，快捷方式内容 SHA-256 和 SDDL 恢复一致。
- 删除类 ACE 可接受；写入、修改权限、取得所有权及非受信所有者仍被拒绝；同一文件使用原严格检查仍拒绝删除授权。
- 安装后插入未知目标/参数时，回滚拒绝并保留该文件；恢复原始测试快捷方式后可正常回滚。安装前未知参数仍被拒绝。
- 本地 Vitest：17 passed、14 skipped（Windows/工具平台门禁）；Windows PowerShell 5.1 上 shortcut-acl、acl-sid、recovery、shortcut-compatibility、shortcuts、native-update、transaction、protected-journal 八组全部退出 0 并输出通过标记。

原始测试日志保留在本地 `release/evidence/shortcut-acl/`（不入库）。没有重新构建、签名或发布安装包；未验证完整 NSIS 交互安装及 UAC。本次验证的是实际故障所在的生产 Apply/恢复事务，不能替代签名安装包发布验收。
