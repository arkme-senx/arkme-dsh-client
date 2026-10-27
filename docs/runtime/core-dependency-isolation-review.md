# 升级隔离改动复审（2026-10-27）

范围：基线 c6605f2 上当前任务全部源码、未跟踪新模块和测试；重点复核旧 Profile、多插件启动、运行时/Profile 事务、首次及后续失败重试。未改变用户业务数据或已有安装。

## 已发现并修复

1. **核心解析仍可被显式 paths 绕过（P1）**。发布版 app-boot 的 CommonJS 包装器直接放行 options.paths，早于 routePath，插件可用 require.resolve(core, {paths:[私有目录]}) 加载旧副本。真实 Electron 43 回归先得到 old-core（期望 new-core），复现后修正该分支；普通依赖保留原生 paths 行为。同时修正核心字典的原型属性命中，防止 constructor 等普通包名被误作核心。
2. **预检隔离消耗运行时恢复机会（P1）**。原 recoverOptionalExtensionLaunch 遇到已有 pending 即恢复并抛错，导致预检移除 Codex 后另一个坏扩展仍拖垮升级。现合并到同一隔离事务、保留第一次备份，再允许一次 loader 重试；先持久保存已用重试标记，进程中断后不能重复获得机会。
3. **注册阶段失败留下半迁移 Profile（P1）**。原恢复仅位于 launch 异常分支，launch 成功后的 workspace 注册失败会留下 pending 及修改过的 Profile。现统一在非中断失败清理中先停止写进程，再恢复 pending Profile；取消/进程中断仍保留可恢复日志。
4. **传递依赖与损坏元数据遗漏（P1）**。先前只检查插件自身声明、只对顶层已安装 manifest 计算指纹，嵌套适配器引入旧核心或被修复均可能漏检。现只读遍历依赖闭包、处理循环及 npm alias，指纹覆盖实际传递依赖。坏 JSON/缺失文件形成稳定指纹和可隔离事实；休眠 Profile 的坏 JSON不阻断所有账号重试。资源/权限异常不授权停用有效扩展。
5. **首次重试计数及最终失败分类不准确（P2）**。先前只为历史 deferred 的重新暂存保存 key，首次新策略试启动失败可额外自动再试一次，暂存后配置变化也会记录错误 key。现每次实际试启动前记录真实 key。失败修复依据最终试启动的可选 importer 分类；保留的首次 loader 错误不能掩盖最终超时。新 Profile 扩展错误可在配置修复后重试，磁盘/readiness/损坏产物继续保留原门禁。

## 审查与验证路径

逐段跟踪启动预检 → launch → 可选扩展恢复 → 工作区注册 → Profile/数据提交与失败回滚，再检查 stageLatest/prepareForLaunch 的真实状态落盘时机。对照插件仓 receipt 读取器，确认新增可选字段兼容，并限制多扩展摘要长度。使用发布版 app-boot + Electron 43 做真实模块解析验证，再以 supervisor、Profile 事务和 runtime manager 的隔离 fixture 验证恢复边界。

新增/扩展回归覆盖：显式 paths 与普通私有库、constructor 普通包名、嵌套核心冲突及原地修复、alias、循环依赖、坏 JSON、预检后第二扩展失败、二次失败恢复、注册失败恢复、合并事务中断后的限次、首次试启动 key、暂存和试启动间配置变化、最终超时分类及环境错误保留。

验证结果见同目录 core-dependency-isolation.md。后续已完成 Windows 3.0.22（300）签名构建及打包预检；完整动态 Release Set 启动与 Windows 用户机器上的实际安装升级仍待验收。
