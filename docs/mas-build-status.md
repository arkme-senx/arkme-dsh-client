# MAS 独立构建实施记录

更新时间：2026-10-15。状态：准备阶段已实施，开发样包尚未生成；本文件不是沙箱通过报告。

## 已实施

- `build/mas/channel.json` 独立维护商店渠道、生产服务、身份和版本 `3.0.10 / 288`；官网版本未调整。
- `pnpm run prepare:mas --build-id 3.0.10-288` 使用现有生产兼容接口、清单验证器、下载器和解包校验器准备组合。
- 可加 `--resolve-only` 只冻结清单。第一次成功解析后，重试读取同目录 `frozen.json`，不再次跟随远端最新版本。
- 换组合须指定新的 `--build-id`；`--resolve-new` 遇到已有冻结记录会拒绝覆盖。
- 双架构检查组件版本、Version Code、兼容规则修订号及解包后 Harness buildId。架构各自的 release ID 不要求相同，因为现有协议把架构和制品摘要纳入 ID。
- 冻结记录保存完整接口清单、渠道配置、组合摘要和解析时间；下载制品沿用原有大小、SHA-256、布局和安装完整性校验。
- 编译、下载、解包、冻结记录和报告均位于 `.mas-build/<build-id>/`。未执行原官网 build、runtime prepare、签名、公证或发布命令。
- `pnpm run test:mas` 验证冻结重试、双架构错配、部分失败、配置变更及篡改。

并发准备由每个 build-id 的 `.lock` 排他锁阻止。正常成功和失败都会释放锁；强制中断留下锁时，须确认无准备进程后手动删除该构建目录的 `.lock`。不要删除 frozen.json 来更换组合。

## 实测阻断

### 生产组合未配置

以 `shell_version=3.0.10`、`shell_version_code=288`、`electron_major=43`、`modules_abi=148` 查询：

- darwin/arm64：HTTP 503，“此客户端 Code 尚未配置兼容范围。”
- darwin/x64：HTTP 503，同上。
- 正式准备命令重试 request ID：`f088e50e6f33c4cea6c3dc9ce1a0b35f`。
- 报告：`.mas-build/3.0.10-288/preparation-report.json`。

历史阻断已按用户要求改用 287 的兼容规则解析，商店客户端构建号仍为 288；见文末。

### 签名材料不匹配

通过 `security find-identity -v -p basic` 检查身份，并使用 `security cms -D` 解码 Xcode 的本地描述文件，仅记录非敏感元数据：

- 更正：读取证书 Subject 的 OU 后确认，两张有效 Apple Development 均属于 T6NSNA8LDZ。名称中的 6Q3VB9R2RR 不是团队 ID，开发证书无需重建。
- 目标团队现有 Developer ID Application / Installer 是官网签名身份。
- 所检查的 16 份描述文件均为 iOS / xrOS / visionOS，没有 macOS 描述文件。
- 存在目标团队 Apple Distribution 证书，但未出现在可用签名身份列表，私钥可用性未确认；未发现 Mac Installer Distribution 身份。

开发样包当前缺少 macOS 开发描述文件，现有有效 Apple Development 身份可用于后续匹配。TestFlight 阶段另需商店分发身份及 macOS 商店描述文件。未尝试导出私钥，未替换现有证书。

## 尚未完成（不得据此发布）

1. MAS electron-builder 配置及真正的 pack:mas:dev / dist:mas / verify:mas 命令。
2. MAS 签名渠道标记、嵌入式运行时来源与沙箱目录接入。
3. 在代码调用层禁用客户端更新、插件更新及可执行扩展安装；不能只隐藏按钮。现有 runtimeManaged 关闭插件更新不等于关闭扩展安装。
4. 用户选目录及安全范围书签、原生依赖的 MAS 处理和处理后摘要。
5. UI 入口低保真确认与调整（尚未做 UI 改动）。
6. 已签名样包的子进程、localhost、桥接、离线启动、业务与权限验收。
7. 沙箱验证通过后的 TestFlight PKG、上传前检查。不会自动上传。

官网命令和构建配置、Windows、生产后端和插件源码均未因本阶段修改。运行时当前仍是原官网行为。本阶段没有可安装 MAS 制品，不能用官网包或未签名样包代替沙箱验收。

## 用户确认后的解析调整

用户授权使用 287 查询 release-set。releaseSetShellVersionCode=287 与商店 versionCode=288 分开保存，冻结清单按 287 校验。新目录 .mas-build/3.0.10-288-from-287/ 已成功冻结双架构组合，摘要 4c3f38aed2cf7c1abbad364a0937dbe6b34f0034e969067c918a060328700e5d。尚未完成下载、签名和沙箱验证。

## macOS 开发描述文件复核与探针构建

2026-10-15 用户提供 `/Users/zhou/Documents/30profile.provisionprofile`：
- 名称：周鹏的即我3.0开发profile；UUID：cac21651-1256-46b5-ab02-4fbb3e3c2e86。
- Platform=OSX；Team=T6NSNA8LDZ；application-identifier=T6NSNA8LDZ.com.senqisi.Jotmo。
- 包含本机 Provisioning UDID；两张 DeveloperCertificates 指纹均匹配本地有效开发签名身份。
- 到期时间：2027-10-15 08:07:17 UTC。

已成功完成双架构原始组合下载、解包、完整性校验和 Harness buildId 配对。
Harness 0.1.5-rc.2 / Code 3；插件 3.0.9 / Code 70；buildId=local-015rc2-20260914-1617。

新增独立无界面架构探针（不是完整即我客户端，不能用于上架）：

```
node scripts/mas/build-probe.mjs 3.0.10-288-from-287 /Users/zhou/Documents/30profile.provisionprofile
```

使用 MAS Electron 43.2.0、开发签名、应用沙箱及 helper 继承权限。资源在 Universal 合并后、签名前复制，避免双份运行时被重复合并。运行逻辑严格限于现有 process.execPath + ELECTRON_RUN_AS_NODE 模型执行 Harness --help，不启动业务插件、不安装到 /Applications、不读取官网数据。用户已明确允许本次探针在当前账号运行。

代码：build/mas/probe-main.cjs、build/mas/entitlements.*.plist、scripts/mas/build-probe.mjs、scripts/mas/verify-probe.mjs。
探针仅用于判断该子进程模型是否有沙箱架构阻断；通过也不代表业务、原生模块和商店审核通过。

## 首轮探针结果

开发签名 Universal 探针已完成，严格深度签名检查通过。两张同名证书导致的 ambiguous 错误通过 MAS 专用签名指纹 73ED76D4647DC9A567C382CE60156F085C71F51B 修复。
arm64 原生和 x64/Rosetta 的 Harness --help 均在 MAS 沙箱下返回 0。
详细报告：`release-mas/3.0.10-288-from-287/MAS-validation-report.md`。

这不是完整客户端样包。冻结插件的扩展安装入口仍可进入下载／安装代码，ARKME_RUNTIME_MANAGED 只关闭自身更新；还需补齐 MAS 只读代码策略、调用层测试及后续兼容组合。未用本地插件替换远端组合，未改写其代码来掩盖缺失能力。全量客户端运行时接入、UI 确认、安全范围书签和业务验收仍待完成。

## 完整开发样包实施（2026-10-15）

本轮新增 `pack:mas:dev <build-id> <mac-development-profile>` 与 `verify:mas <app> <report.json>`。
命令先复用/生成冻结 release-set，按现有 release-set 兼容规则验证组合，再原样复制到 `.mas-build/<id>/processed` 供嵌套签名使用；原始 embedded 目录保留。
官网构建命令、输出路径、发布合同及 Windows 配置不参与此流程。

MAS 客户端要求 `process.mas` 与签名资源内的 `jiwo-mas.json` 同时匹配，缺失/错配即停止，不回退官网运行时。
MAS 与官网复用 `Arkme Harness` 目录名称及账号容器、设置、工作区和日志的内部结构。MAS 仍使用系统提供的沙箱 `appData` 根目录，忽略官网数据路径覆盖参数，并为用户选择的目录保存安全范围书签。不导入官网数据，也不自动搬迁早期样包的 `Jiwo MAS` 目录；旧目录原位保留。内置可执行代码仍从应用资源目录加载，MAS 专用书签文件仍仅保存在沙箱中。
应用内更新控制器不创建。插件通过客户端传入的 ARKME_HOST_POLICY 决定能力：MAS 禁用客户端自行更新、运行时自行更新及可执行扩展安装；官网默认允许，再沿用各功能现有开关。共用凭据流程接收 MAS 独立服务名前缀。
限制位于实际下载、安装、升级、启用及辅助安装入口，不能通过 API 参数覆盖；扩展浏览、图标和预览下载保持原样。
构建不再改写插件、Harness CLI 或 pnpm 代码；记录并校验插件包清单和 JavaScript/JSON 文件复制前后的 SHA-256。MAS 元数据 policy revision 为 2。Agent 命令和外部工具仍需沙箱验收，能力配置不是任意代码执行的安全隔离边界。

客户端沿用 `app.asar` + `app.asar.unpacked` 布局，preload 与进程守护模块路径复用官网逻辑。
由于依赖须独立收集，electron-builder 先生成临时展开目录，afterPack 再封装 ASAR，然后执行签名；交付包不存在展开 `Resources/app`。
内置 Harness/插件保持 Resources/embedded 下的只读代码资源。
通知原生扩展在 MAS 暂存中独立编译为 Universal，不改写官网原生缓存。

开发签名样包不是 TestFlight 包。最终沙箱验证结论以 release-mas 下完整开发样包报告为准，不能用之前的 --help 探针代替。

### 完整样包最新结果

见 `release-mas/3.0.10-288-from-287/MAS-client-validation-report.md`。
arm64 已实际观察到独立登录界面并正常退出；x64/Rosetta 已服务 ready 和页面加载，但有首次冷启动约 60 秒、工作区注册超时的待复测项。
MAS 必须隔离钥匙串服务名，固定前缀为 `com.senqisi.dsh-arkme.mas`，不沿用官网凭据命名空间。
MAS CJS 引导初始化 Electron 后导入原客户端 ESM main；依赖实体化后封装 ASAR。原生模块、preload 和进程守护模块解包。
尚未进行登录后业务、严格断网、实体 Intel 设备和 TestFlight 上传验收。

### 共用账号确认逻辑（2026-10-16）

客户端账号确认与页面加载分离，官网和 MAS 共用 `account-scope-navigation.ts`。插件账号提交确认丢失后的重新核对位于插件仓库 `src/account-session-owner.ts`，不再由 MAS 构建修改下载的插件业务代码。官网构建及发布命令不变。

已有冻结插件 3.0.9 / 70 不包含新的共用插件修复；源码修改不会更新已冻结的制品。后续需通过原有插件发布和 release-set 流程提供包含修复的组合，再显式解析新组合用于 MAS；不得用本地插件或静默改写冻结制品替代。此前已签名登录修复样包保持原样，不代表本次源码状态。

### Host policy v1（2026-10-16）

客户端 src/plugin-host-policy.ts 在启动 Harness 时显式传入 ARKME_HOST_POLICY。插件 src/host-policy.ts 共用解析与检查，不接受浏览器请求的渠道覆盖。字段包含 schemaVersion:1、distribution:website|mas、capabilities:{clientSelfUpdate,runtimeSelfUpdate,executableExtensionInstall}；MAS 另传 credentialServicePrefix:com.senqisi.dsh-arkme.mas。缺失协议兼容旧官网宿主；无效协议拒绝；MAS 不允许开启三项能力。

组合兼容性统一由现有 release-set 规则负责，不再增加插件包字段或额外的协议支持校验。stage-runtime.mjs 只原样暂存已解析组合；verify:mas 保留签名及代码完整性校验。运行时渠道与能力配置的格式检查、执行入口限制继续保留。原 adapt-runtime.mjs 已移除。发布时须在现有兼容配置中选择包含共用修复和能力限制的插件组合；旧冻结记录不会自动切换，新组合需显式解析。
