# 即我桌面端长期 PKG 安装与 ZIP 更新

## 产品与数据合同

正式版外壳为「即我」和 Flutter 2.0 正式图标，应用 ID/AUMID 为 `cc.jiwo.arkme`。macOS 目标 `/Applications/即我.app`，PKG 标识固定为 `cc.jiwo.arkme.installer`，安装 helper 签名标识为 `cc.jiwo.arkme.installer.helper`。Electron Helper 从主应用 ID 派生。测试和本地测试继续使用原独立名称、图标、ID、协议和 Windows GUID。

内部程序仍为 `arkme`/`arkme.exe`，npm 包名仍为 `arkme`，数据目录仍为 `Arkme Harness`，协议仍为 `arkme://`，内部页面品牌不改。Windows NSIS GUID 固定为 `14ace15a-7c69-5467-bedd-7df6c628d51a`，以保留原有安装目录、作用域和卸载记录。

macOS 图标来自 `jotmo_frontend/macos/Runner/Assets.xcassets/AppIcon.appiconset`；Windows ICO来自 `jotmo_frontend/windows/runner/resources/app_icon.ico`。测试图标使用保留的旧 Arkme 资源。

Flutter 数据库、录音、附件、草稿、设置、缓存和凭据原位保留，不搬迁、不转换、不合并、不删除。Flutter 用户重新登录加载云端内容，未同步内容仍在旧目录。已有 Arkme 继续使用原数据和业务凭据命名（`com.senqisi.dsh-arkme` 前缀及用途/环境后缀）。安装器不读取/导出密钥、不改系统权限数据库，不运行旧卸载器或旧客户端退出登录清理。

应用 ID 变更后按实际状态重新检测系统权限；凭据可读取时沿用，否则由用户授权或使用现有登录流程，不承诺无感继承全部权限。升级前先完成同步、结束录音并正常退出旧程序。

支持 macOS 12+ Intel/Apple Silicon、Windows 10/11 x64。商店版、测试版、Linux和移动端不进入正式迁移。安装失败可恢复程序；成功升级后不提供正式降级工具，也不恢复云端历史状态或保证 2.x 可读取 3.x 数据。

## 每版制品与用户路径

| 使用者 | macOS | Windows |
|---|---|---|
| 新用户、Flutter 2.x、旧 Arkme、两者共存 | 最新 PKG | 带迁移能力的签名 NSIS EXE |
| 同版重装、手动更新 | 最新 PKG | 同一 EXE |
| 新身份客户端应用内更新 | ZIP + latest-mac.yml + blockmap | EXE + latest.yml + blockmap |

每版保留旧版迁移能力，用户可跳过3.0直接安装未来最新PKG（系统必须满足目标版本要求）。正式 macOS 不再生成DMG；ZIP不作为用户手动安装入口。官网完全不修改，页面、按钮、文案、下载链接和包上架均由用户自行处理。本仓库不包含网站交付或网站低保真任务。

当前候选 `3.0.0` / `versionCode 277`。2026-09-16只读核对生产公开接口：Flutter平台1/2/3/4为70/276/270/270；Arkme macOS/Windows均为0.3.1/code11，故最高已发布276+1=277。正式出包前仍需重新核对；若已有>=277记录，应同时更新package versionCode及mac.bundleVersion并重新构建全部制品。

## macOS 成套构建与校验

发布机必须提供同团队 Developer ID Application/Installer 证书、公证配置和正常的网络运行环境。凭据只从安全环境配置读取，不写入仓库。

```sh
# 发布机安全配置：CSC_NAME、JIWO_INSTALLER_IDENTITY、JIWO_NOTARY_PROFILE
# APPLE_KEYCHAIN_PROFILE供electron-builder给应用公证，和PKG公证使用同一团队。
pnpm run typecheck
pnpm run dist
```

`dist`执行 `scripts/build-macos-artifacts.mjs`，先取得构建锁并使旧报告失效，再编译应用：electron-builder以`--publish never`构建Universal ZIP，校验主应用与Helper签名/身份、公证票据、架构，然后从同一份已签名应用生成并公证PKG，展开PKG和ZIP比较每个目录、文件字节、权限及符号链接目标，验证ZIP元数据和现有运行时smoke。`latest-mac.yml`只能引用这份已验证ZIP，文件名、大小、SHA-512均绑定。全部通过才原子写入 `release/jiwo-release-verification.json`。失败留下的中间文件不能作为成套发布产物。

正式输出 `即我-<version>-vc<versionCode>-universal.pkg`、同名ZIP、`latest-mac.yml`及blockmap；报告记录应用身份、版本、构建号、内容摘要和每个制品的大小及SHA-512。缺件、错版、内容不同或任一校验失败均终止完整构建。PKG和ZIP应用必须来自同一签名结果。

`dist:migration:mac`保留为单独重建PKG的底层工具（消费已签名且已公证的 `release/mac-universal/即我.app`），与完整构建共用锁，并使旧报告及发布请求失效，不代表成套发布已验证，不能代替 `dist`。同版本PKG重新构建通过后原子替换旧制品。没有证书或公证配置时直接失败，不产生未签名正式PKG。构建进程被强制终止后，如留下`release/.jiwo-release-build.lock`，先根据其中`owner.json`确认原构建进程已退出，再删除该锁重跑。

PKG标题「即我安装」，最低系统来自`build.mac.minimumSystemVersion`并同步到Swift helper。PKG只暂存私有payload，不在BOM中拥有`/Library`或`/Library/Application Support`父目录，不以root启动客户端。

## 可重跑安装

固定简单恢复记录放在`/Library/Application Support/cc.jiwo.installer`，保存本次编号、来源/目标应用身份版本、暂存/备份路径与归属、提交标记。修改程序前持久化；同一时间只有一个安装实例。旧记录未安全收尾不能覆盖。暂存程序始终完整校验后才替换旧程序。

可信来源为同团队Developer ID签名的Flutter `com.senqisi.Jotmo`/`com.senqisi.jotmo` 2.x、旧Arkme `com.senx.arkme.harness`、新身份 `cc.jiwo.arkme`。发现来源使用历史路径、LaunchServices及Spotlight；商店收据、测试ID、未知同名应用、无效签名、更高版本和不安全路径拒绝处理。正式发布必须验证自定义路径、Spotlight关闭和多用户Installer上下文。

- 暂存未完成：只清理本次拥有的暂存内容，然后重跑。
- 旧程序已备份但未提交：验证全体现场，恢复旧程序后再安装。恢复再次中断也可重跑。
- 已提交但清理未完成：只清理本次备份，不回滚成功安装；逐份备份持久化已验证的清理授权后才开始递归删除，因此删除内部文件时断电仍可按归属继续清理。
- 提交后已ZIP更新：验证当前可信同版/更高版本，允许清理旧备份，不能仅因inode变化永久阻塞。
- 未知替换、记录损坏、恢复位置被占用：保留现场并停止，不覆盖未知或更高版本程序。

实际应用版本优先于PKG收据。同版允许重装，旧PKG不能降级更高版本。同步失败立即尝试恢复，中断由下次运行恢复；已成功提交后的清理失败只记录警告。恢复记录格式首次正式发布后固定复用，无通用事务版本升级框架。

安装器不为未启用自启的用户新增自启。当前两套客户端源码未发现macOS应用自有的自启设置；用户在系统中手动添加的Login Items不由LaunchServices注册命令迁移。本实现不直接重写这些用户偏好，其启用意图是否由系统在同路径替换、旧路径移除后正确保留，仍须通过下述真机门禁，不能把`lsregister`成功视为自启迁移完成。失效Dock/任务栏固定图标需要用户移除并重新固定。必须验证PKG落盘权限能通过更新器正常授权机制完成ZIP替换。

## 后端与发布顺序

新macOS版本>=3.0.0要求同release的PKG+ZIP、有效大小/SHA-512、签名公证状态；`download_url`指向同release的PKG，`update_feed_url`指向ZIP更新目录。直链入口同样不能绕过制品与清单校验。历史DMG发布记录可读审计，但不能代替新版本PKG。Windows/Linux/plugin原合同不变。

新macOS请求带`installation=jiwo-v3-cc-jiwo-arkme`，后端仅向该标记返回`updateFeedUrl`；旧`jiwo-v3`、缺失和未知标记只保留手动下载信息，旧客户端使用已有官网入口。该标记是兼容声明，不是安装凭证或安全认证。响应`Cache-Control: no-store`，上线检查CDN是否另行强制缓存。

新身份ZIP更新目录必须与旧Arkme目录隔离，不能改写旧目录YAML让旧客户端获取新IDZIP。Flutter原更新接口不投放3.x制品。APP发布槽继续使用`darwin/arm64`名称但发布Universal应用，Intel客户端APP请求映射该槽，运行时内核仍选真实x64。

新目录固定为`arkme-releases/app/<version>/darwin/arm64/cc.jiwo.arkme/installers/`和`updates/`。后端配置`arkme-plugin-ci.cdn-host`作为固定CDN基址，空值沿用`https://d.jiwo.cc`；`arkme-trusted-public-key`配置发布清单Ed25519公钥的原始32字节标准Base64。该密钥用于现有ManifestV1签名，独立于Apple证书；私钥仅在发布机安全文件中使用。后端验证签名及实际下载制品的大小和SHA-512，Apple签名、公证和Universal架构由已签名发布流水线证明。

完成成套构建后，本地准备发布信息（无上传、无API写入）。`RELEASE_COMMIT`须为与构建源码一致的40位提交SHA：

```sh
node scripts/prepare-macos-release.mjs \
  --cdn-base https://d.jiwo.cc \
  --release-notes-file /secure/release-notes.txt \
  --build-commit "$RELEASE_COMMIT" \
  --signing-key-file /secure/app-manifest-ed25519.pem
```

输出`release/publication/release-request.json`（原接口请求与签名清单）、`upload-map.json`（本地文件到远端object key、公钥、大小及校验值）、专用`latest-mac.yml`和从已验证ZIP重新生成的blockmap。对象存储键沿用ASCII限制，远端文件名使用`jiwo-<version>-vc<code>-universal`，本地交付PKG仍使用要求的「即我」文件名，制品字节不变。应使用publication目录内的YAML与blockmap，按upload-map上传，不能直接上传引用中文本地文件名的构建YAML。

准备工具与打包共用锁，重新检查制品哈希，失败会清除旧发布请求；已签名请求最后生成。保留不可变版本目录，禁止在验证发布后覆盖同一object key。后端先完成配置和部署，再执行原有创建/校验/发布接口，完整PKG＋ZIP和签名清单缺一不可。协议细节见后端`docs/arkme-permanent-macos-release.md`。

先部署后端兼容和保护，再上传已验收的成套制品，最后切换release记录；本次不执行部署、上传、发布或官网操作。官网包上架与链接由用户负责。

## 验证与发布门禁

```sh
pnpm exec vitest run --maxWorkers=2
pnpm run typecheck
pnpm run build
```

持续保留历史正式样本及故障注入测试。每次发版覆盖：仅Flutter、仅Arkme、两者共存、新装、同版多次重装、自定义路径、防降级、复制/备份/替换/提交/清理中断、恢复再中断、同/新版PKG重跑，以及PKG→多次ZIP→最新PKG→ZIP。数据清单、哈希和权限应在旧程序正常退出后记录，在安装结束而新程序首次启动前比较。

签名制品必须在隔离用户/VM验收macOS双架构和Windows10/11，覆盖PKG收据落后、锁定进程、磁盘/权限不足、未知对象、通知/定位/深链接、自启、凭据授权与重新登录。Windows详细范围见[Windows安装](windows-3-migration.md)。

macOS自启单独作为未关闭门禁：在macOS12和13+，分别为同路径Flutter、旧路径和自定义路径Arkme手动设置系统Login Items（启用/未启用），迁移后注销登录，确认只有新应用按原意图启动且无失效/重复入口。若系统未自动保持，需要补充限定到已验证旧应用、在用户会话中执行且可恢复的登录项迁移，不能直接对所有用户偏好做替换。

本机无有效签名身份时，只能验证源码、原生fixture及未签名包结构，不能交付正式PKG/ZIP。Windows真实UAC/注册表/Authenticode与macOS权限及实际ZIP更新不能用模拟测试代替。后端gin路由测试依赖既有包级支付、消息队列和Mongo初始化，需在具备测试配置的CI执行，不连接生产环境绕过限制。本次隔离空配置运行被既有Alipay初始化阻断；gin测试已编译，更新分流的独立领域测试通过。

## 测试接口迁移包

仅用于迁移验收时，在上述正式 PKG／NSIS 构建入口同时设置：

```sh
export ARKME_RUNTIME_SERVICE_BASE_URL=https://jotmo.senguo.me
export ARKME_MIGRATION_TEST=1
```

此标记写入签名包内的配置，使运行时沿用 `cc.jiwo.arkme`、即我及 `arkme://`，与正式安装器身份一致。服务、凭据环境和数据目录仍隔离到测试环境（`Arkme Harness Test`）。不设置标记的普通测试版继续使用独立测试身份；正式接口拒绝迁移测试标记。测试迁移包会替换正式客户端程序，必须在迁移测试设备上使用，不能作为正式环境制品发布。打正式包时清除这两个环境变量。

## 插件与客户端组合版本展示（同分支上线）

`zp/v161` 的即我迁移客户端与 Arkme 插件一起交付。插件左上角沿用 Arkme 标识，版本显示为 `v<插件版本>+<当前安装客户端 versionCode>`，例如 `v0.1.55+277`，无括号。

客户端启动时读取实际安装应用 package.json 的 versionCode，经受现有页面来源校验保护的 `arkme-app-update:app-version-code` IPC 暴露到只读 `window.arkmeDesktop.appVersionCode`。这里展示的是安装客户端构建号，不是 Harness 或远端候选版本。插件兼容旧客户端：缺失或非法值只展示插件版本。

发布时必须同时包含客户端 main/preload 更新与插件 product navigation 更新。动态 Release Set 必须引用含本改动的插件制品；仅构建客户端不会自动发布本地插件源代码。插件和客户端的既有升级、签名、制品校验门禁继续执行。
