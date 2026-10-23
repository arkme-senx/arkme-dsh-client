# 升级后旧容器的安全迁移

## 问题与修复

Harness 的 Release Set 已在账号 A 完成试运行后，游客、账号 B 或其他会话空间仍可能绑定旧 Harness。原启动代码仅在 `release.probation` 为真时授权 Harness identity 切换，因此这些容器在后续冷启动或账号切换时会报 `an explicit harness transition is required`。

修复基于客户端 `origin/master` 的 `362f98de18201d499509e5f948a863952c748333`，实现位于客户端的 `runtime-upgrade.ts` 和所有容器共用的 `launchHarnessRuntime()`。新增显式升级入口 `beginRuntimeUpgrade()`：向运行环境管理器已选择和校验的目标发起容器事务，与该 Release Set 是否仍在试运行无关。底层 `RuntimeDataTransactionStore.begin()` 的默认拒绝隐式 Harness 切换行为保持不变。

按容器首次使用时迁移，不遍历或批量改写其他账号的数据。未变化的容器直接复用现有身份，不重复创建快照。

## 数据保护

迁移复用现有事务和生命周期，未另建第二套备份或恢复 owner：

1. 在旧 Harness 写入进程停止后，检查路径与剩余空间，快照完整 `dshHome`、账号归属索引和当前空间设置；快照失败时不进入新 Harness 的启动。
2. 存在容器事务时继续阻挡页面导航，等待 Harness、工作区、必需插件和页面验证完成。
3. 验证后先持久化提交决定，再提交 Profile、必要的 Release Set 状态和当前容器身份。已有 active release 不再重复 `completeCandidate()`。
4. 决定提交前失败，先确认写入进程退出，再恢复 Profile 和数据快照；试运行中的目录及变动过的索引/设置保留在事务的 `failed-current/` 中。
5. 提交决定后中断，重启按日志继续完成同一提交，不用旧快照覆盖已提交的新数据。
6. 已生效运行环境下的单容器迁移失败不会回滚全局运行环境，也不会标记其他容器为已迁移。

修改没有删除快照、清空容器、覆盖绑定登记来绕过验证，也没有更改 Harness 本身的数据格式转换。

## 范围

| 能力面 | 本次范围 |
| --- | --- |
| Client/Harness | 账号和游客共用的启动、快照、提交与恢复链 |
| UI | 沿用原有启动/失败页面、导航等待及就绪验证 |
| Tools / SDK / Host 业务能力 | N/A：没有新增业务能力、Host 接口或公开协议 |
| 插件与运行环境发布 | 无修改；用现有不可变运行环境验证消费 |

## 验证（2026-10-23）

修改前相关基线：4 个测试文件，83 项通过。修改后相关范围：4 个文件，86 项通过。

新增运行环境管理器集成测试覆盖：候选在账号 A 生效后，游客、账号 B 和账号 B 的另一空间分别迁移；每个容器的原历史文件、二进制附件和账号归属索引完整；未打开的旧容器保持旧绑定；再次打开无重复快照；提交前恢复和重试；提交决定后的重启继续提交；全局 active release 保持不变。

最终全量入口：

```sh
./node_modules/.bin/vitest run
./node_modules/.bin/tsc -p tsconfig.json --noEmit
node scripts/validate-app-version-code.mjs
node scripts/build-device-auth.mjs
./node_modules/.bin/tsc -p tsconfig.build.json
node scripts/copy-static.mjs
```

全量 133 个文件通过，3 个文件跳过；1121 项通过，14 项跳过，无失败。类型检查与构建通过。首次全量运行发现固定开发插件缺少 `lib/index.js`，原依赖副本同样缺失；从 lockfile 锁定的插件提交 `9497ad8f963ca18af9ce8a39664e8fe1faa20a0b` 重建并仅回填本 worktree 的依赖目录后，复跑全部通过。未修改依赖版本或 lockfile。

在 macOS arm64 构建独立未签名 `.app`，以隔离 App Data 和独立复制的运行环境验证实际 packaged 启动链：Harness `0.2.1-rc.2`、插件 `3.0.25`，Release Set 已 active、`probation=false`。给游客及两个账号的合成容器登记旧 Harness 身份，逐个冷启动，再次启动游客。四次均完成容器提交并出现 `render-ready`，每步检查所有容器中预置历史文件和二进制附件的 SHA-256 一致；游客暖启动仍只有一次容器迁移事务。

另在全新的隔离目录中注入不可解析的 Cordis Profile patch，使真实 packaged Harness 启动失败。确认原文件 SHA-256 全部恢复、容器继续保留旧 Harness 身份、失败现场目录保留、全局 active runtime 不变；不是通过修改用户数据或降低健康标准制造通过。

本地包和隔离证据保存在忽略目录 `.runtime/container-migration-validation/`，成功报告为 `report.json`，故障恢复报告为 `failure-report.json`。这些是合成数据的迁移、文件保全与启动验证，不替代真实账号登录场景或所有历史 DSH 数据格式的转换验收。

正式安装的应用与用户数据未被替换或迁移；未发布客户端或运行环境。Windows、Linux 和 macOS Intel 尚未执行目标系统验收。
