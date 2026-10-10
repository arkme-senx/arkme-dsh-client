# 即我长期 PKG 安装与新身份实施计划

本文件落实用户已批准的完整方案，取代旧方案中的保留旧 appId、DMG 分发和一次性迁移限制。官网不改，下载包上架和链接由用户处理。不得提交、推送或发布，也不操作本机正式应用和用户数据。

## Global Constraints

- 正式名称即我，图标复用 Flutter 2.0，appId/AUMID `cc.jiwo.arkme`，PKG ID `cc.jiwo.arkme.installer`，目标 `/Applications/即我.app`。
- 保留内部 arkme/arkme.exe、Arkme Harness 数据目录、凭据命名、arkme://、NSIS GUID `14ace15a-7c69-5467-bedd-7df6c628d51a`。测试及本地测试身份不变。
- 每版正式 macOS 同时构建同一签名、公证应用的 PKG+ZIP，停止生成 DMG。Windows 继续迁移 NSIS EXE。macOS12+/Universal、Windows10/11 x64。
- Flutter 数据原位保留不转换、不合并、不删除；已有 Arkme 继续读取原数据。不得导出凭据或调用旧卸载器/退出登录清理。权限与凭据需要用户授权时沿用现有流程，不承诺无感继承。
- 初始 3.0.0，构建号发布前核对两套已发布最高值+1。自动更新标记 `installation=jiwo-v3-cc-jiwo-arkme`；只新标记可获 macOS ZIP feed。新旧更新目录隔离。
- 安装可重跑，固定最小恢复记录；未提交先恢复再安装，已提交只清理；ZIP 后换 inode 不阻塞可信新版；未知对象停止；不支持成功后的降级。

## Task 1: macOS 幂等安装与恢复

Ownership: build/macos-migration/*.swift, tests/fixtures/migration-macos/**, tests/migration-macos.test.ts only.

保留旧 Flutter `com.senqisi.Jotmo`/`com.senqisi.jotmo` 与 Arkme `com.senx.arkme.harness` 来源，新增并使用目标 `cc.jiwo.arkme`。更新发现/进程/完整性判断。独立目标身份与来源白名单。
采用固定简单恢复记录保存 app 身份版本、暂存/备份归属、提交状态。修改旧程序前持久化。旧记录未安全收尾不得覆盖。恢复与清理可重复，清理备份前验证全部可验证现场防止部分未知导致数据误删。未提交恢复不覆盖外部更高有效安装；已提交后可信同/更高 ZIP 更新允许清理旧备份，验证新签名/ID/版本而非只匹配 inode。同步失败立即恢复，中断由下次重跑恢复。未知记录/对象安全中止，成功后清理失败仅警告。
最低系统从生成 ReleaseMetadata.minimumSystemVersion 读取（root 会给 String 值例如 12.0），version/build/teamID 保持现有生成接口；新增 ReleaseMetadata.appID = cc.jiwo.arkme。如选择保留现有配置常量，请向 root 沟通以统一构建接口。
TDD: 真实 Swift 临时目录 fixtures 覆盖新旧身份、同版多次运行、低版本拒绝、复制/备份/替换/提交/清理中断、恢复再次中断、不同新 PKG 重跑、提交后 ZIP 再安装、未知替换不覆盖、数据权限哈希保留。可用测试层故障系统，不引入仅为测试的生产状态机。不真实安装应用，不签发证书。

## Task 2: 正式身份、成套打包和客户端更新

Ownership: root handles package.json, src/app-identity.ts, src/macos-signature.ts, src/app-update.ts, scripts/build-macos-migration.mjs, new paired-artifact orchestration, production Windows identity guards, related tests and docs. Do not edit Task 1 Swift files concurrently.

修改正式目标身份、派生 helper、保留 Windows GUID及测试身份。生产 dist 一次产生 PKG+ZIP并验证一致，PKG使用固定ID、动态版本/最低系统、标题即我安装和无migration后缀名称。应用先签名公证装订再衍生包；PKG也签名公证装订。ZIP元数据只引用ZIP；缺PKG、错版、错内容失败。新身份 feed 隔离并与后端匹配。使用真实临时zip/pkg fixture验证包装/一致性，正式签名构建条件不足必须如实报告。

## Task 3: 后端发布合同与更新分流

Ownership: jotmo-backend internal/arkme release validators, gin/api/arkme.go + tests, backend release docs if applicable. Do not edit other repos.

macOS正式>=3.0.0必须PKG+ZIP、signed-notarized、同平台架构/版本路径、size和SHA512有效。download_url必须对应同release的PKG（使用现有固定CDN URL构造，不只扩展名），update_feed_url独立ZIP目录。历史旧release DMG合同可读审计，Windows/Linux/plugin合同不改变。
检查直链快速返回分支和创建/编辑/校验/发布各路径，避免填写downloadURL绕过artifacts与清单校验；3.x更新目录不能复用历史旧ID feed。保留 API字段与清单结构，kind增加pkg，必要规则明确定义并记录，不引入无关发布架构。
macOS只有新installation标记返回updateFeedUrl，旧jiwo-v3也拒绝；Cache-Control no-store。Windows原样。
TDD验证完整合同、缺件/重复/DMG替代/错签名/URL错配/直链绕过/篡改/历史兼容/新旧标记/Windows。执行独立Go包测试；gin包若Mongo初始化阻塞，保留测试并编译，报告限制而不连接生产或改全局测试初始化。

## Task 4: 文档、集成验证和独立审查

更新release docs和README：PKG是永久正式安装器，官网不改，用户上架；更新旧实施文档冲突说明。报告版本/构建号/hash/验收状态，不将未签名结构包当正式产物。
跑定向测试、完整Vitest一次、typecheck/build、Go相关包、Swift dual arch编译、PKG BOM与Windows宏编译可用则执行。真实签名/公证/Windows安装/系统权限/PKG→ZIP真机链路作为不能伪造的发布门禁。
各任务结束独立只读review；不提交，review依据工作区diff与新增文件。最后全局review修复确认问题，记录所有验证与残留限制。
