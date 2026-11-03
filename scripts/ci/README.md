# Arkme signed client CI

`pre-release` → GitHub environment `test`，`master` → `prod`。工作流替换旧 `build-pre-release.yml`；集成到 pre-release 时保留本文件版本，避免并行启动旧无签名构建。

每环境配置：

| 类型 | 名称 |
| --- | --- |
| Secrets | ARKME_CI_SECRET、ARKME_MANIFEST_PRIVATE_KEY（PEM Ed25519）、SIMPLYSIGN_ACCOUNT |
| Variables | ARKME_CI_BACKEND、ARKME_CDN_BASE、ARKME_RUNTIME_SERVICE_BASE_URL |
| Variables | SIMPLYSIGN_CERTIFICATE_SHA1、SIMPLYSIGN_PUBLISHER、SIMPLYSIGN_INSTALLER_SHA256 |
| 现有 Apple secrets | MAC_CSC_LINK、MAC_CSC_KEY_PASSWORD、APPLE_TEAM_ID、APPLE_ID、APPLE_APP_SPECIFIC_PASSWORD |

CI 公钥仅配置于后端 `arkme-client-ci.manifest-public-key`；不旋转既有插件签名 key。CI 无 OSS 长期密钥。生产与测试凭据必须不同，后端 `cdn-host` 应与既有 release 下载 CDN 一致。

SimplySign Desktop 固定9.4.4.92 Windows x64 MSI；下载摘要和 Authenticode 发布者均验证。登录窗口通过原生 Win32 控件句柄定位并校验所属进程，才请求 token；找不到窗口直接失败，不调用未知 CLI 协议，不改用自托管 runner。托管验证 run 41580563251 已通过自动取码登录、真实签名和时间戳校验。

恢复优先重跑原 GitHub run：版本预留、平台 artifacts 和 publication manifest 复用，源分支前进则禁止回写/发布。Artifact 保留30天；原文件丢失且 OSS 已有不同内容时必须新提交预留新版本，不能覆盖。安装包/辅助文件 → YAML → manifest；后端最后统一切换指针。

manifest 包含 source/writeback SHA、run/attempt、Electron/ABI、平台签名证据和最终字节摘要。Apple 签名/公证及 Windows Authenticode/时间戳验证先于最终 manifest。Test Windows 不执行 production migration installer hooks。

验收还包括：托管 Windows SimplySign 登录与真实签名、macOS 公证、三个目标下载安装重启、运行时兼容、取消/超时/网络丢包恢复。未完成真实验收前不能宣布全链路可用。

发布接口以 `async: true` 提交持久化校验任务，Action 查询状态直到 `published`。HTTP 请求断开不会终止任务；后端进程重启后，状态查询会恢复已过期的任务租约。`failed` 保留原清单，修复原因后重跑原批次；不重建或覆盖已上传文件。
