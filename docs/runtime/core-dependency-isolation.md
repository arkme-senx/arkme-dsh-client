# Release Set 核心依赖隔离与升级恢复

## 根因与排查证据

用户诊断包 Arkme升级排查-20261027-123106.zip 的 Profile 安装 dsh-llm-codex@0.1.2；其发布依赖将 dsh-llm 和 dsh-settings 固定到 0.1.0-rc.6。harness.log 第 19541–19565 行显示 Harness 0.2.1-rc.2 加载旧核心后将其禁用，agent-loop 缺少 llm，候选退出并进入 deferred。第 19649–19660 行显示回退后原可选扩展隔离成功，但该隔离只移除 Bundle，保留依赖，所以没有解决核心解析归属。

调查流程：对应同一次启动的 Profile、state 和 supervisor 日志；核验第三方发布依赖；检查核心路由、兼容预检、隔离事务和 deferred 门禁；使用发布版 app-boot 与 Electron 43 构造顶层及私有旧包残留回归。

## 实现

- harness-core-dependencies.ts：从当前 Harness 实际安装的 DSH/Cordis/Schemastery 核心包建立归属表；通过 unpacked --import 的 load-only hook 在内存适配支持的 app-boot，不改写已发布产物。ESM、CommonJS、Bundle 和 PluginPackages 元数据使用一致归属。
- profile-core-compatibility.ts：检查已启用第三方 Bundle 的普通依赖、peer、optional 及 engines；原包和普通私有依赖保持不变。无法兼容新核心的扩展在执行前隔离。
- harness-supervisor.ts / optional-extension-recovery.ts：复用 pending/active/restored 事务、原 Profile 文本备份与一次启动恢复；支持同时隔离多个冲突 Bundle。重启计划回滚后重放本次 pending 隔离，防止重新激活。
- runtime/manager.ts / state.ts：只为已知核心冲突的 deferred 候选，按策略及 Profile 指纹开放一次重试；记录跨进程持久保存，失败历史和其他错误门禁保留。

## 已有用户与回滚

不删除或重装用户 node_modules，不改写锁文件、会话、登录或业务数据。已有 Profile 和私有旧核心副本通过新的运行时解析策略失去覆盖权；不兼容扩展仍可在修复后沿用现有重新启用流程。候选失败或进程中断沿用现有数据/Profile 回滚和隔离恢复。0.1.x 已验证回退保留原行为；未知新解析器布局明确失败，不静默放行旧核心。

修复随客户端代码发布，必须使用包含本改动的新客户端；无需重新覆盖同版本 Harness 产物。客户端版本配置为 3.0.22（300）。

## 验证（2026-10-27）

基线 origin/master c6605f2；分支 zp-codex/runtime-core-isolation-20261027。

- 完整 Vitest（--maxWorkers=2）：135 个文件通过、3 个文件跳过；1165 个用例通过、17 个用例跳过。
- TypeScript：tsconfig.json --noEmit、tsconfig.build.json 均通过；copy-static 与版本元数据检查通过。
- 发布版 app-boot 0.2.1-rc.2 + Electron 43.2.0 / Node 24.18.0：ESM、CommonJS 和兼容元数据均选择新核心；插件私有普通依赖保持；不存在的核心 subpath 不回退旧副本；被验证产物文件内容不变。
- 覆盖 Codex 普通依赖冲突、peer/optional/engines、多个扩展隔离、精确恢复 Profile、pending/active 重放、已失败候选同指纹限次、进程重启、插件原地升级及磁盘/readiness 排除。
- git diff --check 通过。

Windows 11 / Node 24.14.0：5 个核心回归文件、118 个用例通过。构建并签名 3.0.22（300）x64 EXE 和 ZIP；安装程序、主程序、辅助程序与内嵌卸载程序的公司证书签名及时间戳验证通过。打包预检通过；七个关键编译模块逐字节核对，安装包 53 个文件及 ZIP 52 个文件哈希验证通过。构建记录保存在忽略目录 release/windows-x64-vc300/。

Windows 验证同时修正两处测试适配：POSIX 0600 权限断言仅在 Unix 检查；preload 冒烟补齐 branding-snapshot 与 device-lock available 同步 IPC 应答，避免测试页面挂起。

未执行完整动态 Release Set 启动或受影响用户机器上的真实安装升级验收；上述不表述为已验证。未合并或生产发布。

## 复审补充

本轮发现并修复的核心解析绕过、多扩展事务、注册失败恢复、传递依赖及实际试启动计数问题，详见 core-dependency-isolation-review.md。新增可选 receipt 字段与原插件读取器兼容。
