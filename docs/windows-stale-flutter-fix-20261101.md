# Windows 旧版登记残留导致安装失败：修复与验证

日期：2026-11-01（北京时间）。基线：通过 HTTPS fetch 的 master `de98812b4d29a25871c0d3c1e9cd8158e535e58b`；独立分支 `zp-codex/windows-stale-flutter-20261101`。未修改原 v219 checkout。

## 根因与调查路径

从截图提取 Prepare、临时脚本目录 nsd2F8A.tmp、错误文件 nst30D3.tmp、进程 11672 和 UTC 日志文件时间 03:34:36；按此时间窗查询 SLS `jotmo/jotmo-telemetry` 的 desktop-installer topic。匹配事件 `f7b06b8d6e764b3494c5f356ad945999`，本地时间 11:34:36，Windows 22621，安装器 3.0.23 / vc301。匿名报告不提供可信用户或部署环境身份；仅以多个故障锚点关联截图。

日志中的旧版登记指向用户 Downloads 下的 `jotmo-2.60.20+215-windows-setup/jotmo`。沿 Get-LegacyInstall → Select-MigrationLegacy → Assert-Legacy 定位到旧脚本第 252 行：flutter_windows.dll 或 data/flutter_assets 不满足存在性/类型要求即抛 Unknown Flutter program layout。错误发生在本次安装退役旧程序之前。

根因是安装器把存在旧版登记等同于必须完整迁移的旧安装，缺少旧程序已丢失/不完整的兼容路径。用户反馈旧版此前消失与此一致，但日志不能证明是哪一个文件缺失，也不能证明由清理工具、移动、卸载或其他行为造成。不能据此判定业务数据丢失。

## 修复边界

新增 Resolve-MigrationLegacy，完整旧版仍走原迁移。已通过注册表身份识别的旧版缺少启动程序、卸载程序、DLL 或资源目录时，在独立目标目录安装，并将旧文件及旧登记完全排除出安装事务。不执行旧卸载程序，不清理残留，不访问业务数据库。

继续验证固定磁盘可用性、安全路径、文件类型、scope、目录分离、退役标记、已有启动程序发布者及 Flutter 身份、已有卸载程序身份和版本防降级。可疑或有恢复冲突的状态仍拒绝。日志明确列出缺失项。

快捷方式仅对本轮已验证的不完整旧版目录允许资源缺失；现存目标程序仍验证签名、产品身份和版本。只将快捷方式本身纳入现有事务并保留原始字节用于回滚，其他未知目标继续拒绝。后续原生更新也识别同一残留登记，避免新版安装成功后再次被残留阻断。共享旧版与当前用户安装的原有共存规则保持不变。

此修复复用既有独立安装、兼容快捷方式及 schema 2 事务恢复合同，无 journal schema、跨仓接口或 UI 修改。

## 验证

- 默认最小集：`node node_modules/vitest/vitest.mjs run tests/windows-migration tests/installer-diagnostics.test.ts`：17 passed / 13 skipped（Windows/PowerShell 平台门禁）。
- macOS ARM64 PowerShell 7.6.9 直接执行 recovery.ps1：48 个顶层用例通过。新增矩阵覆盖 5 种缺失状态 × 成功/回滚 × 首次安装/已有安装，共 20 个组合；检查旧登记和全部剩余旧文件不变、旧目录不进入事务、快捷方式原样恢复，以及新安装的成功/回滚结果。
- 新增拒绝用例：目录重叠、退役标记、文件类型异常、登记版本超前、启动程序不可信；完整旧版保持原迁移选择。
- 带 ARKME_TEST_PWSH 扩大运行：19 passed / 3 failed / 8 skipped。3 个失败分别为 transaction.ps1 缺少 SystemRoot、shortcuts.ps1 无 C: 盘、native-update.ps1 拒绝 macOS 路径。用未修改基线隔离复制后逐项复跑，均产生相同失败，属于现有 Windows 夹具的可移植性限制。
- `git diff --check` 通过。

## 2026-11-01 Windows 真机复现与验证

后续使用用户提供的 192.168.1.238 / develop 账号登录。Windows build 26300、PowerShell 5.1.26100.9711，非管理员。开始前检查标准 HKCU/HKLM 32/64 位 Flutter/Arkme 登记及进程均不存在。专用测试目录为 `C:\Users\develop\Downloads\arkme-stale-validation-20261101`。

使用用户指定的 Flutter `2.61.48+284` 安装包，SHA-256 为 `8DDC1B44F4F95B9443A28E3D1DBF116FB62B243C816ED35A320450EF44ADAC92`。安装包、jotmo.exe、unins000.exe 和 flutter_windows.dll 均通过真实 Authenticode 校验，发布者为 Senqisi (Wuhan) Technology Co., Ltd.。以当前用户模式安装到专用目录，真实 HKCU 登记由 Inno 创建。安装器退出 0，文件与登记成功，但收尾脚本访问 commondesktop 被拒绝并记录 Runtime error，不能把该次安装表述为完整无异常验收。

调查与对比步骤：

1. 在真实文件及真实登记上调用未修改基线的 Get-LegacyInstall / Assert-Legacy，健康旧版通过。
2. 分别临时移走 DLL、flutter_assets、启动程序、卸载程序或整个目录；不删除文件，每轮 finally 恢复原路径。
3. 基线在 DLL、资源和整个目录缺失时均复现 `Unknown Flutter program layout.`；启动程序/卸载程序缺失分别产生相应缺失错误。
4. 同一状态下运行修复脚本的发现、选择与 Resolve-MigrationLegacy，5 种情况全部通过；真实签名与版本校验未 mock，快捷方式兼容分类也通过。
5. 每轮比对真实登记快照不变；全部场景完成后比对旧安装所有文件的 SHA-256 清单完全一致，健康旧版仍能进入原迁移流程。
6. Windows PowerShell 5.1 上通过 recovery（47 个顶层 PASS，含新增 20 个组合）、native-update、shortcut-compatibility、shortcuts、transaction、diagnostics 六组回归。事务测试仍使用既有平台边界夹具，真实包复现用于补齐真实注册表与签名的准入证据。

原始证据：[汇总](evidence/windows-stale-flutter-20261101/summary.json)、[五场景对比](evidence/windows-stale-flutter-20261101/real-package-reproduction.json)、[复现脚本](evidence/windows-stale-flutter-20261101/reproduce.ps1)。原始 Windows 事务及旧包安装日志保留在本地同名证据目录（日志不入库）。复现脚本依赖专用目录中的已验证安装与脚本，不是面向用户机器的通用清理工具。

## 签名安装器与实际启动验收

构建 Windows x64 3.0.24 / versionCode 302，安装包 SHA-256：`73cee4d1bc213479f799ad2588a0780bbd652758c3b3e875405d9ead16e23e4d`。安装器、主程序及辅助程序 Authenticode 均为 Valid，带正式 Certum 时间戳。[签名证据](evidence/windows-stale-flutter-20261101/signed-package-verification.json)。解包最终 NSIS 安装器确认内嵌迁移脚本与修复源码一致、32 个 payload 文件哈希一致、应用版本正确。[内容校验](evidence/windows-stale-flutter-20261101/installer-content-verification.json)。

在 192.168.1.238 当前桌面会话中运行上述未修改的签名安装包，使用 `/S /currentuser` 和独立目标目录：

- 旧 Flutter DLL 缺失但保留真实登记：首次安装退出 0。
- 旧程序目录整个消失但保留真实登记：同目录覆盖安装退出 0。
- 两轮 Check、Prepare、Apply、Finalize 均通过；安装后 32 个文件哈希匹配清单，主程序签名有效。旧登记不变，每轮恢复旧文件并比对全部文件哈希一致。
- 初次尝试被上次解包版启动生成的开始菜单快捷方式阻断：其目标是另一个目录，Apply 拒绝覆盖并完成 Rollback。备份隔离此测试快捷方式后两轮均通过，再按哈希恢复。没有修改安装器或绕过安全校验；这与原始 Prepare 布局错误不同。
- 15:03:38 从实际安装目录启动后记录 `render-ready`，进程持续响应。[安装场景结果](evidence/windows-stale-flutter-20261101/signed-installer-results.json)、[安装后启动证据](evidence/windows-stale-flutter-20261101/installed-launch.json)。

首次动态 Harness 初始化约 4 分 26 秒，主要耗时为解压校验。生产插件 3.0.40 / 105 已激活并进入登录页；未登录通话轮询提示“请先登录 Arkme”，未导致启动失败。

## 未验证与交付边界

SSH 会话的 WMI 访问与管理员所有权 ACL 受限，Windows powershell.exe 签名夹具返回 NotSigned，分别阻断 process-inspection、acl-sid 和 short-path 的既有测试夹具，不能算通过。后续真实安装使用当前桌面会话，系统 WMI 检查正常并已完成完整安装，不存在跳过主脚本入口检查的情况。

尚未验证 NSIS 交互 UI/UAC、HKLM all-users 实际迁移、登录后业务，以及更高版本自动更新。测试移走的旧文件已恢复；独立验证目录保留，未清理其他用户文件。签名包已回传，未发布线上渠道。安装二进制和原始日志留在本地 release/，不提交到源码仓库。
