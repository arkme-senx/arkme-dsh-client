# Windows 安装器进程路径与所属者查询失败修复

日期：2026-10-26；实机：192.168.3.231，Windows 11 / Windows PowerShell 5.1。
分支：`zp-codex/windows-installer-acl-sid-20261026`，最新 master 基线 `75d74fa`。
前序 ACL 修复已保存到 `a2a02c3`；本次改动是在该提交之后继续开发的独立工作区改动。

## 问题与根因

近期 SLS 的三条路径缺失事件（3.0.19/297）包含 `Cannot identify a running app/kernel. Exit it before installing.`；其中事件 `c5d3e88119e84203bafc5fb18a6ddee5` 在 10 月 25 日 10:38:37。所属者查询事件 `2326d6aafb3c4f24a309a6dcc0dcc387` 在 10 月 19 日 18:52:37，3.0.16，`Invoke-CimMethod GetOwnerSid` 报“找不到”。时间均为北京时间。

旧扫描先枚举 `Win32_Process`，之后单独查询 `GetOwnerSid`。枚举不是进程存活保证：进程在两次操作之间退出，第二次 WMI 调用就会找不到实例，异常直接终止安装。旧代码也直接信任 WMI 的 ExecutablePath 是否有值，未尝试读取仍在运行的进程真实路径。

远程实机已复现枚举后退出导致的真实 WMI“找不到”异常；路径为空通过清空真实 CIM 快照的 ExecutablePath 字段注入复现。后者验证了安装器处理空元数据的缺陷，并未证明历史三台客户机器为什么返回空路径；权限不足等原因不能仅凭 SLS 文本排除。

## 排查步骤与工作流

1. 从前一轮 SLS 七天审计定位路径缺失和 GetOwnerSid 两类事件，追到 `Get-MigrationProcesses`。
2. 保存前序 ACL 修复，保持最新基线上的任务分支，无 master 开发或无关改动清理。
3. 将提交后的旧脚本复制到远端 `C:\arkme-process-fix-20261026\windows-migration-before.ps1`。
4. 在随机独立临时目录复制系统 ping.exe 为 arkme.exe，启动无害测试进程；扫描测试只返回该进程的真实 CIM 快照，不接触现有应用。
5. 分别注入空路径，以及在快照返回前终止测试进程。旧脚本前者抛无法识别，后者在 GetOwnerSid 抛“找不到”。只有本测试创建的进程会被测试清理代码终止。
6. 修改扫描实现，远程运行真实进程与令牌回归，再运行正常退出、短路径和 ACL 既有回归。
7. 本地运行 policy、integration、installer-diagnostics，执行 diff 检查，并保留复现 JSON / 实机回归日志。

## 修复

新增独立的进程查询 native helper，不加载退出提示窗口相关程序集。以 `PROCESS_QUERY_LIMITED_INFORMATION` 打开句柄，通过 QueryFullProcessImageName 获取路径、GetProcessTimes 获取创建/退出时间，通过 OpenProcessToken / GetTokenInformation(TokenUser) 直接读取所属者 SID。

路径和所属者读取使用同一个句柄，避免中途 PID 重用使两次查询指向不同进程；另比对 CIM 创建时间（允许其微秒精度的截断）。创建时间缺失或不匹配继续阻断并要求重试，避免将新进程误当成已退出放行。

只有确认进程已退出，或 OpenProcess 明确返回无效 PID，才忽略该记录。存活但访问被拒、所属者读取失败、其他用户进程、安装目录之外的内核继续阻断。外部普通应用和无关 Node 继续排除。保留原有正常退出提示、签名检查和退出动作；生产扫描不添加强制终止逻辑。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| 旧脚本：真实快照注入空路径 | 复现原报错 |
| 旧脚本：枚举后测试进程真实退出 | 复现 WMI GetOwnerSid“找不到” |
| 新脚本：当前用户真实进程 | 路径、PID、令牌 SID 正确 |
| 新脚本：空 CIM 路径 | 从真实句柄恢复，正常纳入退出检查 |
| 新脚本：枚举后真实退出 | 安全忽略，不再调用 GetOwnerSid |
| 已持有句柄的进程退出 | GetProcessTimes 正确识别退出 |
| 创建时间不匹配 / PID 重用元数据夹具 | 继续阻断 |
| 活着但不可查询的 PID 4 | 继续阻断，不当作退出 |
| 外部普通应用 / 外部 Node | 保持排除 |
| 安装根目录内的真实 Node / Jotmo-Kernel | 正常识别 |
| 安装根目录外的 Jotmo-Kernel | 继续阻断 |
| 真实 SYSTEM 令牌 | 继续拒绝其他用户所属者 |
| Windows Vitest：process inspection、exit consent、ACL、short path | 4 passed / 19 按名称筛选跳过 |
| 本地 policy / integration / installer-diagnostics | 17 passed / 13 平台或权限跳过 |
| git diff --check | 通过 |

SYSTEM 所属者测试只读取现有进程，将其枚举名称注入为待检查候选，PID、创建时间、路径和 SID 均为真实值；不发送退出操作、不修改该进程。该用例在有令牌读取权限时执行，本机输出 `Foreign token boundary checked: True`；无权限的开发机明确输出 False，不冒充通过。

本地未跟踪证据目录：`release/process-inspection-verification/`，包含 `baseline-reproduction.json` 和 `windows-regression.log`。测试脚本使用 finally 清理自建临时文件及进程。

## 交付边界

本次完成源码修复与远程原生回归，没有修改系统 ACL、安装现有应用、推送代码或发布版本。先前的 3.0.20 / 298 签名包没有重新构建，仍不含 ACL 和本次进程查询修复。本轮没有声称完整安装包或应用启动验收通过；客户历史空路径的底层权限/系统原因仍需客户机器原始证据确认。
