# Windows 安装器短路径误拒绝：修复与验证

日期：2026-10-26（北京时间）。基线：最新远端 master `978f8f0`；通过 HTTPS fetch 核对，无基线差异。修复分支：`zp-codex/windows-installer-short-path-20261026`。

## 现象与调查流程

1. 从用户截图提取 Apply、错误文件 `nsj11EF.tmp`、暂存目录 `nsfD5AE.tmp`、进程号 `6672` 和 PowerShell 调用栈。
2. 查询 15:00–15:30 的 SLS `jotmo / jotmo-telemetry` 安装报告，以及带 `deploy_env:prod` 的安装报告接口 access 日志。
3. 15:13:32 的 `3.0.19 / vc297` 报告与截图上述锚点一致，事件 ID 为 `88f28d26055d4ec09bbdba97c2d2c25d`。SLS 保存了错误正文，接口返回 202，报告的 recovery 为 completed。匿名报告本身没有 deploy_env，未将其当成环境或用户身份凭据。
4. 对照源码，定位到 Assert-Payload 对暂存 arkme.exe 进行发布者检查前的路径校验。旧 Assert-LocalPath 将含 `~数字` 的 Windows 8.3 路径一律拒绝。
5. 通过 SSH 在 Windows 测试机的 PowerShell 5.1 上创建真实长名称临时目录，由 Windows 返回 `JIWOSH~1` 短名称；使用真实签名文件构造暂存 payload。
6. 旧脚本稳定复现 `Unsupported install path.`，调用栈精确命中 Assert-LocalPath:84 → Assert-Publisher:99 → Assert-Payload:389。相同用例在修复后通过。

用户原始故障来自 Windows 10 19045；本轮实机是 Windows 11 26200、Windows PowerShell 5.1。截图出现 ADMINI~1，但上报已脱敏用户名，无法从远端还原用户机器的原始 Stage 字符串。实机已验证短路径会触发完全相同的失败机制。

## 修复

- 对真实 8.3 别名调用 Windows GetLongPathNameW 展开为长路径。
- 目标目录尚未创建时，展开已存在的最深祖先，再拼接待创建的目录。
- 在规范化前后保持路径语法检查；未解析的短名称、路径穿越、ADS、UNC、盘符根目录、尾随点或空格继续拒绝。
- 对规范化路径逐级检查 reparse point；junction 不得绕过检查。
- Assert-Publisher 使用规范化后的文件路径进行原有 Authenticode 和发布者验证。清单哈希验证保持不变。

## 验证结果

| 范围 | 结果 |
| --- | --- |
| 新增 short-path.ps1：真实短路径下签名与清单校验、未创建目录、错误发布者、哈希篡改、危险路径、junction | 通过 |
| transaction.ps1 | 通过 |
| recovery.ps1（45 个恢复场景） | 通过 |
| native-update.ps1 | 通过 |
| diagnostics.ps1 | 通过；首次上传漏带 path-redaction.json，补齐夹具后单独复验通过 |
| protected-journal.ps1 | 通过 |
| shortcuts.ps1 | 通过 |
| shortcut-compatibility.ps1 | 通过 |
| 本地 Vitest：policy、integration、installer-diagnostics | 17 passed / 11 skipped（平台限定） |
| git diff --check | 通过 |

新增实机回归已接入 integration.test.mjs，仅在 Windows 上运行；8.3 名称不可用时明确失败，防止静默失去此项覆盖。实机测试仅使用隔离夹具，未运行整包安装或替换现有应用。

## 交付边界

本报告覆盖源码修复和回归测试，未运行发布，也未生成新的签名安装包。已发布的 vc297 安装包不会自动获得脚本修复；用户侧生效需要后续重建、签名并分发安装器。尚未验证 Windows 10 整包安装流程。
