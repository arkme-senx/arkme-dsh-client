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

macOS、Windows 每个 matrix job 在检出源码后发送开始通知，仅在构建失败或取消时
发送构建结束通知。成功通知统一放到 publish job：全部产物上传 OSS，后端产物与
兼容校验通过且确认批次 published 后，分别发送两端“发布成功”。上传/发布失败或
取消时分别通知两端发布失败/取消，不发送成功消息。成功消息耗时自批次预留起算。
开始消息早于版本文件下载，因此不包含版本。

网络错误、408/429/5xx 最多重试三次，单次超时 10 秒；同一运行尝试、平台、阶段
使用固定去重 ID。凭据缺失或发送失败只产生脱敏 warning，不影响发布。
最终通知覆盖常规失败和取消；源码检出失败、runner 失联、强制终止可能无法发送，
应以 Actions 页面为准。脚本不输出凭据、请求体、响应正文或原始网络错误。

本地协议测试：`pnpm exec vitest run tests/ci-notify.test.mjs`。真实发送需配置上述 Secret，
未配置时不向 Hook 发送请求。

### 首次构建前失败的重跑

reserve 失败或恢复步骤自身失败、此前从未开始产物生成的同一 run，可重试首次构建。
恢复脚本检查全部历史 attempt 的对应平台 job：只有跳过的 job，或恢复步骤未成功且
后续产物生成步骤全部跳过，才允许继续。记录缺失、API 查询失败、已有过期 artifact、
已提交清单或不同 run 均拒绝重建；已有产物仍优先按摘要恢复。
更新工作流代码后，旧 run 重跑仍使用旧提交，应从修复合入后的 master 触发新发布。

### 版本来源

新 Action 仅按源提交的 package.json 将 SemVer patch 和 versionCode 各加一（3.0.25 / 303 → 3.0.26 / 304），以 target_version 提交后端。后端验证并记录，不参考历史失败预留来抬高版本；同 SHA 重试复用原批次，目标不一致返回冲突。已发布版本不低于目标时拒绝发布，需要显式提高源码版本，不自动改号。

先部署支持 target_version 的后端，再合入新 Action。旧 Action 不带该字段时保留旧分配规则；新 Action 校验返回版本，不接受旧后端静默升版。构建成功后继续回写源码。新提交若仍使用同一源码版本会算出相同目标；已上传 OSS 对象禁止不同内容覆盖，此时需要显式提高 package.json 版本或恢复原批次。

Windows CI 只生成并上传签名 NSIS EXE、EXE blockmap、latest.yml 和发布清单，不再生成或上传 ZIP。macOS ZIP 仍用于应用内更新。后端需先部署允许 Windows 无 ZIP 的校验变更，再合入客户端工作流；历史 ZIP 不删除，旧清单仍兼容。

### 正式发布后同步 dev

后端确认 master 批次已发布后，sync-dev 用普通 merge PR 将该批次的版本回写提交合回 dev；pre-release 不参与。同步不会覆盖 dev 在构建期间新增的提交，也不会带入 master 上尚未发布的后续改动。仓库须允许 Actions 创建 PR、使用 merge commit。遇到冲突或保护规则时查看同步 PR，保留双方历史解决后用 merge commit 合并，勿 squash。可重跑原工作流，已包含该发布提交则跳过。
