# 即我长期安装与更新：实施及验证记录

日期：2026-09-16。候选版本：`3.0.0`，构建号 `277`。本记录说明源码实施和本地自动化结果，不代表正式签名制品已通过真实安装验收。

## 修改范围

| 仓库 | 本次结果 |
|---|---|
| arkme-dsh-client | 正式版名称/图标、`cc.jiwo.arkme` 身份和 Helper 校验；永久 macOS PKG 迁移/恢复；同源 PKG＋ZIP 成套构建和发布准备；新身份更新标记；Windows 固定 GUID、迁移及中断恢复 |
| jotmo-backend | PKG＋ZIP 发布合同、实际制品大小/摘要校验、签名清单校验、版本/构建号绑定、旧客户端 ZIP 分流保护 |
| arkme-dsh-plugin | 未修改 |
| jotmo_frontend | 仅读取正式图标；已有的两个内核文件改动未动 |
| 官网 | 未修改 |

应用可执行文件、业务凭据命名、`Arkme Harness` 数据目录、`arkme://` 和页面内部品牌保持原有约定。Flutter 本地内容不导入、不转换、不清理。测试版及本地测试版身份保持隔离。

## 已完成验证

| 检查 | 结果与边界 |
|---|---|
| 客户端全量 Vitest | **94 个文件通过，3 个跳过；821 项通过，4 项跳过**。跳过项属于 Windows 原生插件修复和需要显式启用的真实 Harness 集成测试。已启用 PowerShell/NSIS 环境，Windows 迁移测试没有被跳过 |
| TypeScript 与应用构建 | `pnpm run typecheck`、`pnpm run build` 通过 |
| macOS 原生迁移 | 44 个真实临时文件系统场景通过，包括数据保留、防降级、故障恢复、再次中断、清理残留、已提交后的更高版本 ZIP；arm64 和 x86_64 的 macOS 12 目标类型检查通过 |
| Windows 迁移专项 | 11 项通过；包含生产 PowerShell 事务/恢复/快捷方式夹具（恢复脚本内 23 个场景）及真实 NSIS 宏编译。没有运行安装器、修改真实注册表或应用 |
| PKG/ZIP 及发布准备 | 使用临时应用夹具验证真实 ZIP/PKG 内容、文件权限、元数据、同版本重建、锁和失败后旧证据失效；签名请求、独立更新目录、blockmap 生成及错误拒绝通过 |
| 后端领域测试 | `go test ./internal/arkme/... -count=1` 通过；覆盖完整/缺失/错配制品、下载直链绕过、真实 TLS 摘要校验及旧客户端分流 |
| Node → Go 合同 | 实际本地发布准备脚本生成的测试签名清单被 Go 解析、验签并接受；篡改 API 构建号被拒绝；含 CDN 路径前缀的场景通过 |
| gin API | 测试编译通过；隔离空配置下执行被既有 Alipay 全局初始化阻断，未通过连接生产服务绕过 |
| 包结构 | 未签名 arm64 结构夹具的主应用及 4 个 Helper ID、版本/构建号、名称、可执行文件和最低系统检查通过。这不是 Universal 正式制品 |
| 差异检查 | 客户端和后端 `git diff --check` 通过 |

本地最终日志：`/private/tmp/jiwo-permanent-final-fulltests.log`、`/private/tmp/jiwo-windows-shortcut-green.log`、`/private/tmp/jiwo-backend-final-tests.log`。临时目录日志可能被系统清理，本表保留此次结果。

## 审查中修正的问题

Mac 恢复逻辑增加了部分备份清理中断后的可重跑处理、路径大小写/符号链接归属校验及 Flutter 构建号防回退。发布构建增加共享锁、过期交付证据失效和元数据对实际 ZIP 的绑定。

后端原有 Manifest V1 不含构建号，仅验证目录和扩展名会允许 API 构建号与已签名制品错配。现要求签名 object key 中的文件名严格包含该发布的版本及构建号。使用实际 Node 生成结果复现错误接受，再以 Go 回归测试验证拒绝。

Windows 修正了 PowerShell 空备份参数、恢复前全现场校验、终态清理重跑及后续 EXE 按旧记录恢复。另追踪实际 electron-builder 模板发现：旧 Arkme 快捷方式重命名与 Flutter 即我快捷方式冲突时，后续 AUMID 写入仍会改变 Flutter 链接，导致中断恢复无法识别。现在仅重命名成功后才写链接属性，失败时由具备恢复记录的步骤统一处理。检查流程为模板追踪、隔离复现、补丁断言、真实宏编译及专项/全量回归。

私有准备目录中记录过的未完成 `payload-N` 暂存文件可在重跑时丢弃；完整有效载荷、旧备份和实际程序仍按内容归属验证。此边界详见 Windows 文档。

## 仍需完成的发布验收

**macOS 手动系统登录项的自动迁移尚未实现。** 当前可访问的两套客户端源码没有应用自有的自启设置；用户可自行在系统添加登录项。`lsregister` 不能证明换路径/换 ID 后仍保留这些登录项。需要在隔离用户或 VM 检查 macOS 12 和 13+ 的启用/未启用、同路径 Flutter、旧路径/自定义路径 Arkme。若系统未自动保持，必须补充仅针对已验证来源的用户会话迁移，不能宣称这一验收已满足。

真实签名制品还需验证 macOS 双架构 PKG → 多次 ZIP → 最新 PKG → ZIP，Windows 10/11 x64 的 PowerShell 5.1、UAC、ACL、注册表和 Authenticode，以及进程退出、低空间/权限错误、安装中断、数据清单/哈希/权限、凭据、通知、深链接和系统固定图标。自动化夹具不能代替这些检查。

正式签名环境按用户现有流程处理，本次未生成正式成套 PKG/ZIP，因此不提供虚构的正式包校验值；出包成功后由 `release/jiwo-release-verification.json` 和 `release/publication/upload-map.json` 提供实际版本、大小及 SHA-512。未执行 git 提交、推送、部署、上传、发布或真实应用安装。

构建、后端配置与发布顺序见 [发布操作说明](jiwo-3-migration-release.md)，Windows 细节见 [Windows 迁移说明](windows-3-migration.md)。
