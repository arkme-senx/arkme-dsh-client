# Arkme signed client CI

`pre-release` → GitHub environment `test`，`master` → `prod`。工作流替换旧 `build-pre-release.yml`；集成到 pre-release 时保留本文件版本，避免并行启动旧无签名构建。

每环境配置：

| 类型 | 名称 |
| --- | --- |
| Secrets | ARKME_CI_SECRET、ARKME_MANIFEST_PRIVATE_KEY（PEM Ed25519）、SIMPLYSIGN_ACCOUNT |
| Variables | ARKME_CI_BACKEND、ARKME_CDN_BASE、ARKME_RUNTIME_SERVICE_BASE_URL |
| Variables | SIMPLYSIGN_CERTIFICATE_SHA1、SIMPLYSIGN_PUBLISHER、SIMPLYSIGN_INSTALLER_SHA256 |
| 现有 Apple secrets | MAC_CSC_LINK、MAC_CSC_KEY_PASSWORD、MAC_INSTALLER_LINK、MAC_INSTALLER_PASSWORD、APPLE_TEAM_ID、APPLE_ID、APPLE_APP_SPECIFIC_PASSWORD |

CI 公钥仅配置于后端 `arkme-client-ci.manifest-public-key`；不旋转既有插件签名 key。CI 无 OSS 长期密钥。生产与测试凭据必须不同，后端 `cdn-host` 应与既有 release 下载 CDN 一致。

SimplySign Desktop 固定9.4.4.92 Windows x64 MSI；下载摘要和 Authenticode 发布者均验证。登录窗口通过原生 Win32 控件句柄定位并校验所属进程，才请求 token；找不到窗口直接失败，不调用未知 CLI 协议，不改用自托管 runner。托管验证 run 41580563251 已通过自动取码登录、真实签名和时间戳校验。

恢复优先重跑原 GitHub run：版本预留、平台 artifacts 和 publication manifest 复用，源分支前进则禁止回写/发布。Artifact 保留30天；重跑时 GitHub artifacts 若不可见，使用后端已验证清单摘要从 OSS 恢复原字节和发布清单。恢复失败时禁止重建该预留版本，须新源提交/版本，不能覆盖。安装包/辅助文件 → YAML → manifest；后端最后统一切换指针。

manifest 包含 source/writeback SHA、run/attempt、Electron/ABI、平台签名证据和最终字节摘要。Apple 签名/公证及 Windows Authenticode/时间戳验证先于最终 manifest。Test Windows 不执行 production migration installer hooks。

验收还包括：托管 Windows SimplySign 登录与真实签名、macOS 公证、三个目标下载安装重启、运行时兼容、取消/超时/网络丢包恢复。未完成真实验收前不能宣布全链路可用。

发布接口以 `async: true` 提交持久化校验任务，Action 查询状态直到 `published`。HTTP 请求断开不会终止任务；后端进程重启后，状态查询会恢复已过期的任务租约。`failed` 保留原清单，修复原因后重跑原批次；不重建或覆盖已上传文件。


macOS CI 发布 PKG + ZIP。prod PKG 调用已有 buildMigrationPackage，包含正式旧版迁移助手、preinstall/postinstall、签名校验及事务恢复；test PKG 仅安装 /Applications/arkme Test.app，使用 cc.jiwo.arkme.test.installer，不发现或迁移正式安装。两种包均以 Developer ID Installer 签名、公证并 stapler/spctl 验证；PKG/ZIP 解包后逐文件、权限及符号链接比对。latest-mac.yml 仅引用 ZIP。

MAC_INSTALLER_LINK 是同团队 Developer ID Installer 的 Base64 PKCS#12，MAC_INSTALLER_PASSWORD 是其密码。仅放对应 GitHub Environment Secret；CI 使用临时钥匙串，结束后恢复原搜索列表并删除临时钥匙串。

### 平台构建通知

GitHub Actions 的 `test` / `prod` Environment（或仓库级 Actions Secrets）配置
`ARKME_BUILD_WEBHOOK_TOKEN`，工作流会将其映射为同名环境变量。不要放到普通 Variables。
默认使用已指定的 jotmo Bot Hook；可通过 Actions Variable `ARKME_BUILD_WEBHOOK_URL`
覆盖 HTTPS 地址。协议为 POST JSON `{token, message, external_message_id}`。

macOS、Windows 每个 matrix job 在检出源码后发送开始通知，在构建、签名校验和
GitHub Artifact 保存结束后通过 `always()` 分别发送最终结果，包含环境、分支、
可用的预留版本、耗时与本次运行链接。复用产物会明确标注；构建成功不等于 OSS
发布成功，通知对此明确说明。开始消息早于版本文件下载，因此不包含版本。

网络错误、408/429/5xx 最多重试三次，单次超时 10 秒；同一运行尝试、平台、阶段
使用固定去重 ID。凭据缺失或发送失败只产生脱敏 warning，不影响发布。
最终通知覆盖常规失败和取消；源码检出失败、runner 失联、强制终止可能无法发送，
应以 Actions 页面为准。脚本不输出凭据、请求体、响应正文或原始网络错误。

本地协议测试：`node --test tests/ci-notify.test.mjs`。真实发送需配置上述 Secret，
未配置时不向 Hook 发送请求。
