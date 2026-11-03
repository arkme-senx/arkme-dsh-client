# Arkme

3.0 正式桌面外壳对外显示「即我」并使用 Flutter 2.0 图标；正式应用 ID 改为 `cc.jiwo.arkme`，协议及数据目录保持不变。每版长期 PKG+ZIP、Windows EXE 和发布验收见 [即我 3.0 迁移发布说明](docs/jiwo-3-migration-release.md)。

Arkme 是一个面向 macOS、Windows 和 Linux 桌面客户端。它会在本机启动 DeepSeek Harness 服务，并在安全隔离的桌面窗口中打开 Harness Web UI。

生产应用采用“轻量桌面外壳 + 按需运行环境”的结构：安装包不内置 Harness、Arkme 插件或独立 Node.js 运行时。应用首次启动时会下载并校验与当前平台匹配的运行环境，后续可直接使用已验证的本地副本。

## 主要功能

- 自动启动、监控和重启本机 Harness 服务
- 自动创建默认工作区，并保存最近使用的项目目录
- 按账号与本机会话容器保存最后选中的 DSH 会话，重启后优先恢复
- 管理 Harness 与 Arkme 插件运行环境，支持后台更新、完整性校验和失败回滚
- 检查并下载 Arkme 桌面客户端更新
- 使用系统目录选择器、桌面通知和单实例窗口
- 支持通过 `arkme://` 深链打开扩展分享页面

## 支持平台

| 平台 | 架构 | 正式构建产物 |
| --- | --- | --- |
| macOS | Intel 与 Apple 芯片 | Universal `.app`、PKG、ZIP |
| Windows | x64 | NSIS 安装包、ZIP |
| Linux | x64 glibc | AppImage |

Harness 运行环境覆盖上述全部目标。桌面客户端内置的更新检查与安装包下载当前支持 macOS arm64、Windows x64 和 Linux x64。

## 使用方式

1. 安装并启动适合当前平台的 Arkme 发布包。
2. 首次启动时保持网络连接，等待应用下载并校验 Harness 与 Arkme 插件运行环境。
3. 如果没有已保存的项目目录，Arkme 会在应用数据目录中创建 `workspace/` 作为默认工作区；后续启动会继续使用最近一次有效的目录。
4. 在 Harness Web UI 的 **Settings → Models** 中配置模型和 API Key。

在 macOS 和 Linux 上，可以通过 **文件 → 选择项目…**（`CmdOrCtrl+O`）切换项目，通过 **文件 → 重新启动 Harness**（`CmdOrCtrl+Shift+R`）重启本地服务。启动状态页在需要时也会提供选择项目、重试、重新加载运行环境和打开日志等操作。

## 本地开发

### 环境要求

- Node.js 24 或更高版本
- pnpm 11.19.0
- Electron 使用 `package.json` / lockfile 固定的 **43.2.0（ABI 148）**，不要全局安装、单独升级/降级，或用 `ELECTRON_OVERRIDE_DIST_PATH` 指向其他版本。
- macOS 开发与打包需要 Xcode Command Line Tools，用于构建系统通知权限查询模块
- 已配置 GitHub SSH 访问；生产插件依赖通过 Git SSH 固定到经过审查的 Commit

安装依赖并启动开发客户端：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

开发启动器会按以下顺序选择 Arkme 插件：

1. 使用 `ARKME_PLUGIN_PATH` 显式指定的本地仓库；
2. 使用同级目录中的 `../arkme-dsh-plugin`；
3. 如果前两者都不存在，使用已安装的固定版本依赖。

```bash
ARKME_PLUGIN_PATH=/absolute/path/to/arkme-dsh-plugin pnpm dev
```

当使用本地插件仓库时，每次执行 `pnpm dev` 都会先构建插件，再构建并启动桌面客户端。插件源码变化后需要重启开发客户端才能重新构建并加载。

`pnpm dev` 和 `pnpm build` 会检查依赖声明、已安装包及实际 Electron 二进制的版本，并在客户端编译后用真实 Electron 验证 Harness 主线程和 ESM Worker 的内部模块加载。开发模式由客户端预加载适配器处理当前 Harness 原生加载器不支持 Electron 43.2.0 指纹的问题，不修改 DSH 源文件，也不需要临时退回 Electron 43.0.0。正式包仍沿用其已准备好的运行环境。

遇到版本不一致，先执行 `pnpm install --frozen-lockfile`，再执行 `pnpm verify:electron` 和 `pnpm build`；不要复制另一 worktree 的 Electron 二进制。升级 Electron 时必须同步校验运行环境合同、ABI、原生依赖及 Harness 兼容性。构建检查失败不会自动更换版本或修改已安装的正式应用。

## 测试与构建

提交改动前建议执行：

```bash
pnpm test
pnpm run typecheck
pnpm run build
```

### 正式构建

| 平台 | 命令 | 主要输出 |
| --- | --- | --- |
| macOS 可运行目录 | `pnpm run pack` | `release/mac-universal/即我.app` |
| macOS 分发包 | `pnpm run dist` | `release/` 下同源 PKG、ZIP、`latest-mac.yml`、blockmap 与成套校验报告 |
| macOS 单独重建 PKG | `pnpm run dist:migration:mac`（需已有签名、公证应用） | 底层构建工具；不能代替 `dist` 的成套发布校验 |
| Windows | `pnpm run dist:win` | `release/` 下的 NSIS、ZIP、`latest.yml` 与 blockmap |
| Linux | `pnpm run dist:linux` | `release/` 下的 AppImage |

macOS 和 Windows 正式构建需要可用的代码签名环境。Linux 构建生成 AppImage，不使用同一套代码签名流程。

`electron-builder.cjs` 的 `afterPack` 钩子会在签名前生成 `Contents/Resources/app-update.yml`（Windows 为 `resources/app-update.yml`），包括更新器缓存目录及 Windows 发布者信息。即使使用 `--dir` 构建，也不能省略此文件：传入动态更新目录并不能免除下载器对包内配置的依赖。后续 `--prepackaged` 只允许使用已经包含该文件并完成签名的应用；禁止往已签名/公证的包里直接补文件。

`packaged-smoke.mjs` 已强制验证包内更新配置，并使用安装包中真实的 `electron-updater` 初始化隔离下载缓存。也可以先单独运行 `pnpm run verify:packaged-update /绝对路径/即我.app/Contents/Resources/app.asar`（Windows 传入对应 `resources/app.asar`），在公证和上传前尽早拒绝缺配置的包。该检查不下载安装更新，也不改变当前安装应用或用户数据。

发布前运行 `node scripts/verify-app-update-metadata.mjs --platform darwin --release-dir <产物目录> --update-feed-url <HTTPS更新目录>`（Windows 使用 `--platform win32`），校验更新 YAML 的版本、实际更新包的 `vc{versionCode}` 文件名、文件大小和 SHA-512。也可通过 `ARKME_UPDATE_FEED_URL` 指定更新目录；仅本地校验相对路径 YAML 时可省略目录参数。必须先把 YAML、安装包和 blockmap 一起上传到不可变目录，再把该目录（以 `/` 结尾）写入发布记录的 `update_feed_url` 并发布 stable。

新 macOS 正式版的 `download_url` 必须指向同一发布记录中的 PKG；客户端不读取该字段，官网入口固定打开 `https://jiwo.cc`。APP 内更新只从 `update_feed_url` 的 YAML 选择平台安装包（macOS ZIP / Windows NSIS EXE），校验目录边界、版本身份、Version Code、大小、SHA-512，并由 updater 验证下载内容和平台签名。旧的 `--download-url` / `ARKME_UPDATE_DOWNLOAD_URL` 发布校验参数已移除，流水线应改用更新目录参数。检查失败后的重试应重新检查，不能直接下载覆盖最初的错误。

所有正式应用包都只包含 Electron 外壳。打包冒烟测试会验证应用资源中没有内置 Harness、Arkme 插件或独立 Node.js 运行时，并使用全新的应用数据目录验证动态运行环境安装与启动流程。

### 测试环境构建

```bash
pnpm run dist:test:mac
pnpm run dist:test:win
pnpm run dist:test:linux
```

测试环境构建使用独立的应用名称、协议和数据目录，输出到 `release-test-dynamic/`，不会覆盖正式应用身份。

#### GitHub Actions 测试构建

工作流 `构建 Arkme 测试客户端` 在改动推送到 `pre-release` 时运行，包括合并和直接推送；当工作流文件已存在于默认分支 `master` 时，也可以通过 `workflow_dispatch` 手动运行。首次启用时，确保 `pre-release` 分支已包含该工作流文件。

`macos-15-intel` 构建 Universal DMG 和 ZIP，`windows-2022` 构建 x64 NSIS EXE 和 ZIP。产物作为 GitHub Actions artifact 保留 7 天，命名为 `arkme-test-<platform>-<arch>-<run_number>-<run_attempt>`，可在仓库的 Actions → 对应运行记录 → Artifacts 下载。这些构建沿用现有的 Arkme Test 应用身份和 `https://jotmo.senguo.me` 测试服务；CI 中公开插件依赖使用 HTTPS 传输，同时保留固定 Commit 和锁文件。

macOS 使用 `electron-builder.ci-mac-test-config.cjs` 构建：以 Developer ID Application 证书签名，开启 Hardened Runtime，提交应用公证并附加票据，然后生成 ZIP 和签名 DMG。DMG 还会单独公证和附加票据，之后重新生成 blockmap 与更新哈希，避免票据改变文件内容后 `latest-mac.yml` 失效。上传前校验应用和 ZIP 中应用的签名、测试 Bundle ID、开发团队、权限、Universal 原生模块架构、公证票据及 Gatekeeper 状态，同时校验 DMG 和更新文件。Apple 处理公证的时间计入任务的 60 分钟超时。

Windows 继续使用无签名配置，不调用 SimplySign。两平台仍并行执行，macOS 凭据缺失、签名或公证失败不会取消 Windows 任务。工作流不发布 Release、不上传后端，也不构建运行环境或插件制品，不运行依赖远端 Runtime 下载的启动冒烟测试。

CI 使用 `pnpm install --frozen-lockfile --ignore-scripts` 安装依赖，再显式执行客户端的 `postinstall`，完成 Electron 安装和客户端原生模块重建。这样首次安装也不会隐式执行 Git 插件的 `prepare` 构建；需要构建插件或 Harness 运行环境时，应使用各自的构建流程。

##### macOS 签名与公证 Secrets

在客户端仓库 **Settings → Secrets and variables → Actions → New repository secret** 中配置以下值。证书和私钥以 Base64 文本保存到 Actions Secrets，不作为文件提交到 Git 仓库。签名证书应从原构建 Mac 的“钥匙串访问”导出为包含私钥的 `.p12`，选择 **Developer ID Application**，不是 Apple Development 或 App Store 证书。

| Secret | 内容 |
| --- | --- |
| `MAC_CSC_LINK` | `.p12` 文件的 Base64 文本 |
| `MAC_CSC_KEY_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_TEAM_ID` | 签名证书对应的 10 位开发团队 ID，用于公证和校验证书归属 |
| `APPLE_ID` | 已有公证账号的 Apple ID 邮箱，账号需有对应开发团队的公证权限 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 该 Apple ID 的 App 专用密码，不是 Apple ID 登录密码 |

当前使用 **Apple ID + App 专用密码 + Team ID** 公证，配置上面 5 个 Secrets 即可，无需生成 `.p8` 或申请团队 API 密钥。

以后如需切换为 App Store Connect **团队 API 密钥**，保留前 3 个签名相关 Secrets，删除 `APPLE_ID` 和 `APPLE_APP_SPECIFIC_PASSWORD`，再配置下列 3 个 Secrets。两套公证凭据不能同时配置；当前 Apple ID 方式下应不配置下列值：

| Secret | 内容 |
| --- | --- |
| `APPLE_API_KEY_BASE64` | `.p8` 私钥文件的 Base64 文本 |
| `APPLE_API_KEY_ID` | API Key ID |
| `APPLE_API_ISSUER` | API Issuer ID |

在持有凭据文件的 Mac 上，可用 GitHub CLI 直接写入 Secrets，文件内容不需要粘贴到聊天或写入仓库：

```bash
base64 -i /绝对路径/DeveloperIDApplication.p12 | gh secret set MAC_CSC_LINK --repo arkme-senx/arkme-dsh-client
gh secret set MAC_CSC_KEY_PASSWORD --repo arkme-senx/arkme-dsh-client
gh secret set APPLE_TEAM_ID --repo arkme-senx/arkme-dsh-client
gh secret set APPLE_ID --repo arkme-senx/arkme-dsh-client
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo arkme-senx/arkme-dsh-client
```

不带输入管道的命令按提示输入对应值。工作流会在安装依赖前检查凭据完整性；证书导入、认证和公证必须实际成功才能上传 macOS 产物，不会自动退回无签名构建。证书由 electron-builder 导入临时钥匙串；证书、钥匙串和 `.p8` 均限制在本次构建专属的 runner 临时目录，成功、失败及证书导入中断的路径均会执行清理，runner 销毁时也不会保留。凭据仅注入 macOS 凭据检查及签名步骤，不进入依赖缓存或 Artifact。

构建子进程的标准输出、标准错误及失败信息在写入日志前统一脱敏，覆盖上述 Secrets 的原值、JSON 转义形式及 API 私钥正文；长时间构建按完整行处理流式输出，避免凭据跨输出分块时漏遮盖。工作流在 Node 启动前清空 `DEBUG`、`NODE_DEBUG` 和 `NODE_DEBUG_NATIVE`，脚本也拒绝在这些调试变量非空的父进程中执行签名命令，避免 Node 自身打印包含凭据的子进程环境。日志可保留构建进度、公证提交 ID 和错误原因，凭据值显示为 `[REDACTED]`，并由 GitHub Actions 的 Secret 遮盖机制再次处理。

对应当前锁定的 electron-builder 26，Apple ID 公证方式直接使用上述 3 个 `APPLE_*` 环境变量；如切换为 API 密钥，公证步骤使用 `.p8` 临时文件路径作为 `APPLE_API_KEY`。可参考 [macOS 签名文档](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/) 和 [公证文档](https://www.electron.build/v26/docs/features/code-signing/notarization/)。

在 macOS 上，还可以构建直接使用本地插件仓库的未签名测试应用：

```bash
# 默认使用同级目录中的插件仓库
pnpm run pack:test

# 显式指定本地插件仓库
ARKME_PLUGIN_PATH=/absolute/path/to/arkme-dsh-plugin pnpm run pack:test
```

输出为 `release-test/mac-arm64/arkme Local Test.app`。该应用使用独立 Bundle ID 和协议，并直接引用当前机器上的插件仓库，因此不能作为分发包使用。

### 构建 Harness 运行环境

运行环境制品需要在各目标平台分别构建，并使用相同的构建标识：

```bash
ARKME_RUNTIME_BUILD_ID=example-build-1 pnpm run build:runtime:electron-harness
```

默认输出目录为 `artifacts/electron-harness/<buildId>/`。构建脚本会重新构建原生依赖，并验证 Electron 版本、Node Modules ABI、平台与架构信息后再生成压缩制品。

## 更新与安全机制

Arkme 包含两条相互独立的更新链路：

- **桌面客户端更新**：每次启动检查最新 Version Code；发现新版本后先校验并复用下载缓存，无有效缓存时自动在后台下载，下载完成后由用户点击「重启并安装」。仅检测到新版本时显示顶部提示，关闭后不保留悬浮入口，可从设置页重新打开。Linux 或无法自动更新时通过「下载最新版本」打开官网 `https://jiwo.cc`。
- **运行环境更新**：同时管理 Harness 和必需的 Arkme 插件。更新会先下载到暂存目录，通过清单、平台、版本、文件大小、SHA-256 和关键路径校验后，才会在下次启动时启用。

新的运行环境会经过启动、工作区注册和插件健康检查。验证失败时，应用会回退到上一份可用环境；确定损坏或身份不一致的制品会被隔离，避免重复启动。稳定环境损坏时，应用会尝试从本地副本恢复或重新下载。

桌面窗口启用了上下文隔离和渲染进程沙箱，并关闭 Node.js 集成。Harness 页面只能从本机回环地址加载；外部 HTTPS 链接会在系统浏览器中打开。

## 本地数据

正式环境的默认数据目录：

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/Arkme Harness/` |
| Windows | `%APPDATA%\Arkme Harness\` |
| Linux | `~/.config/Arkme Harness/` |

测试应用使用独立的 `Arkme Harness Test` 目录。开发或自动化测试也可以通过绝对路径环境变量 `ARKME_APP_DATA_PATH` 覆盖应用数据根目录。

主要内容包括：

- `workspace/`：没有已保存项目时自动创建的默认工作区
- `settings.json`：最近一次有效的项目目录
- `dsh-account-scopes.json`：当前账号与本机会话容器的不透明归属索引
- `dsh-containers/<container-ref>/dsh/`：按游客或 Arkme 账号隔离的 Harness 设置、Profile、会话及扩展数据
- `dsh-containers/<container-ref>/session-selection.json`：该账号容器最后选中的会话 ID、格式版本和更新时间；不包含消息内容
- `logs/desktop-startup.log`：桌面客户端启动与运行时诊断日志
- `logs/harness.log`：Harness 服务的标准输出和标准错误日志
- `runtime-manager/electron-v1/`：当前、候选、历史、暂存和下载的运行环境数据

这些文件属于本机用户数据，不应提交到源码仓库。仓库的 `.gitignore` 已排除根目录 `settings.json`、环境变量文件、常见凭据文件、数据库和构建产物。

从旧版本首次升级时，已有的 `dsh/` 会在 Harness 停止后的下一次启动中原子迁移：已登录时整体归入当前 Arkme 账号，未登录时归入游客空间。退出登录会切换到全新的游客容器；重新登录账号时只启动该账号拥有的容器，不会展示其他账号的会话。同一账号存在多个本机会话容器时，可通过应用菜单中的“会话空间”切换。

### 恢复上次选中的 DSH 会话

需要同时使用支持会话选择保存的桌面壳与 Arkme 插件。插件在内嵌 Harness 中订阅公开的 `sessions.list`，只保存就绪且有效的 `current`；切换到其他页面、退出登录和重连产生的临时空值不会清除记录。主进程根据当前账号容器决定文件路径，按顺序原子写入，并在正常退出前等待已接收的写入完成。页面只持有本次文档的保存凭证，账号切换后旧凭证失效。

启动时先读取账号文件，再加载页面。preload 在 Harness 脚本之前把选择写入官方 `dsh.sessions.current` 启动存储键，因此随机端口变化不再导致选择丢失。内嵌页面在所有启动脚本之前安装一个只针对该键的 `localStorage.getItem` 读取适配，从父页面 preload 缓存读取，避免外层 runtime 的临时空状态覆盖启动选择；其他键、写操作和 sessionStorage 均沿用浏览器行为。localStorage 仅作为当前启动的传递入口；本地账号文件才是持久化来源。没有记录时清除该键，避免复用端口时读到其他账号的旧选择。升级验证窗口可以恢复，但不能保存选择。子会话另保存官方 `currentAddress` 的父子 ID 与模式，恢复时作为 `subagentAddress` 传入。

Harness 自身负责在会话列表成功加载后校验与恢复；原会话不存在时才走原有默认流程。临时列表错误不会触发默认创建。首次启用不会扫描旧端口的浏览器存储，第一次有效选择后开始保存；不额外恢复草稿或滚动位置。

回归检查：账号 A 选择有历史消息的会话后重启，确认会话 ID 不变且列表数量不增加；快速切换后退出应恢复最后选择；切到账号 B 后验证独立保存，再登录 A 验证恢复；删除保存的会话后验证默认流程。自动化覆盖位于桌面壳 `tests/session-selection.test.ts`、`tests/preload-bridge.test.ts` 和插件 `tests/harness-session-selection*.test.ts`。

`pnpm run test:session-selection:electron` 使用真实 Electron 的隔离 preload、同源 iframe 和临时账号目录验证跨端口恢复、启动读写竞争和账号隔离，不读取真实用户数据。默认读取同级 `arkme-dsh-plugin` 工作区中的启动适配脚本；其他布局可设置 `ARKME_PLUGIN_PATH` 指向插件源码目录。

## 参与贡献

1. Fork 仓库并创建功能分支。
2. 使用固定锁文件安装依赖：`pnpm install --frozen-lockfile`。
3. 完成改动后运行测试、类型检查和构建。
4. 提交 Pull Request，并说明变更目的、验证结果以及涉及的平台。

涉及依赖、打包、运行环境或安全边界的改动，应同时更新相关测试并在目标平台完成验证。

## 开源许可

本项目采用 [MIT License](LICENSE) 开源。

### 远控连接与系统恢复

桌面通过现有受认证的 Host bridge 提供 `lifecycle.get`，返回进程内 `resumeGeneration` 与 `suspended`。它只服务当前 Harness session；旧 session 请求被拒绝。系统唤醒不重启正在执行任务的 Harness，远控插件自行使过期连接失效并恢复。

Harness 输出按 5MiB 轮转，最多保留当前日志及两个历史文件；输出写入积压超过 256KiB 时丢弃额外诊断输出，仍保留内存中的有限故障 tail。插件断线不触发整个 Harness 重启。

## Arkme CI 自动发布（新链路）

`.github/workflows/build-pre-release.yml` 将 `pre-release` 固定映射为 `test`，`master` 固定映射为 `prod`。两个环境使用独立后端和凭据；必须先完成测试验收再配置生产。当前功能分支的 `simplysign-probe.yml`、`macos-signing-probe.yml` 只进行测试环境签名可行性验证，不发布 release。

每个 GitHub Environment 配置以下内容：

- Variables：`ARKME_CI_BACKEND`、`ARKME_RUNTIME_SERVICE_BASE_URL`、`ARKME_CDN_BASE`、`SIMPLYSIGN_CERTIFICATE_SHA1`、`SIMPLYSIGN_PUBLISHER`、`SIMPLYSIGN_INSTALLER_SHA256`。
- Secrets：`ARKME_CI_SECRET`（publisher 专用）、`ARKME_MANIFEST_PRIVATE_KEY`（Ed25519 PEM）、`SIMPLYSIGN_ACCOUNT`。
- 沿用 Apple Secrets：`MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。

Action 向后端预留版本，两平台构建与签名验证完成后才回写版本。分支已有新提交时停止旧批次，不强推。机器人提交包含 `Arkme-CI-Batch:`，不递归构建。失败时在**原 run**上重跑，恢复同一版本、原始平台产物和签名清单；不要对机器人提交新建发布。

新链路使用 `app/arkme/{test|prod}/{windows|macos}/{version}-vc{versionCode}/`，文件名保持 electron-builder 输出。macOS 为 Universal DMG/ZIP，Windows 为 x64 NSIS/ZIP；这是独立 CI 批次合同，旧手工发布的 PKG 和历史 `arkme-releases/app/` 路径继续保留。先完成签名、公证及最终文件校验，再上传包/blockmap、更新 YAML、清单。STS 限定单个对象，不保存长期 OSS 密钥；同路径不同内容禁止覆盖。

SimplySign Desktop 登录窗准备好后才向后端申请手机 token。Action 临时 RSA 私钥仅在进程内存在；本机服务通过 Codex Skill 读取固定 Android SimplySign 账号、等待临期验证码换新、加密回传。任何签名或证书校验失败都停止，不生成无签名发布。

后端校验签名清单、CDN内容、更新元数据、兼容快照和 Electron/ABI 后，原子切换 macOS arm64/Intel 与 Windows 三个目标。首次 Intel 按已确认方案复制 arm64 兼容配置快照，后续独立继承。发布异常通过后端管理员批次回滚接口恢复旧指针，保留历史产物与兼容记录。
