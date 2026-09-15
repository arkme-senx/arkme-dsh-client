# Harness 0.1.5-rc.2 缓存代际升级实施记录

最终设计见 ../specs/2026-09-14-harness-015rc2-upgrade-design.md。旧双协议方案已废弃。

## 已实现

- [x] cache-epoch-1 目录隔离；只读历史组件 Code 基线；同代本地缓存离线启动。
- [x] 下载前 acquisition 持久化；双制品离线安装；部分下载手动续传；下载失败取消并等待兄弟请求。
- [x] rc.2 Cookie 认证和 slash RPC；旧认证会话在进程/页面代际切换时撤销。
- [x] 插件本地就绪通知；隐藏 Electron 页面验证；独立 nonce 和特权 IPC 校验。
- [x] 数据快照及外部事务记录；Profile 和 Release Set 协同提交；决定提交后只前进恢复。
- [x] 账号目录实际搬迁延迟到候选提交后；搬迁前复制已提交身份，账号容器禁止自动切回不同 Harness 身份。
- [x] 进程 PID/代际记录与 IPC 启动门禁；父进程崩溃清理后台进程，恢复数据前检查旧 PID/进程组已退出。
- [x] rc.2 依赖、锁文件、真实 app-boot 补丁和插件构建来源管理；保留无运行时安装包结构。

## 验证记录

- 管理器覆盖旧缓存隔离、Code 基线、候选中断、acquisition、离线启动、回退和坏制品边界。
- 下载/安装覆盖断流、Range、摘要、取消、完整双制品离线重装和完整性损坏。
- 数据/Profile/升级协调覆盖快照恢复、注册表缺失、提交中断、决定提交后新增数据保留及错误目标阻断。
- 真实解包 rc.2 arm64 运行时：认证主页200/未认证401、session/list、workspace/create、插件健康检查通过。
- 真实 Electron43 arm64 隐藏页面：本地就绪通知一次、Cookie 对脚本不可见、preload 隔离、特权更新操作拒绝通过。
- 已生成 darwin-arm64、darwin-x64、windows-x64、linux-x64 本地候选制品；仅 darwin-arm64 完成原生库执行及真实页面验证。其他平台结构验证不等于实际操作系统回归。
- 插件全量：Node24.12.0 下5,765项通过，9项跳过；typecheck/build通过。本地 node_modules 的跨工作区 React 链接已修正，未修改相关业务 UI。
- 等待页通过真实 Electron 截图检查，macOS arm64 无运行时安装包通过结构、updater及preload预检。
- 客户端最终全量：768项通过、4项跳过（85个测试文件通过）；最终源码构建及类型检查通过。
- 最新 macOS arm64 安装包离线端到端通过：完整 acquisition 双制品安装、旧代字节不变、旧数据迁移及身份转移、一个 completed 数据事务、同账号同代离线重启、最终页面稳定且无渲染错误。
- 对首个隔离客户端执行 SIGKILL 后，Harness PID 与整个进程组自行退出；随后新客户端通过遗留记录检查并正常重启。测试代理拒绝5次外部请求，启动未等待外部服务。
- 实际 rc.2 页面暴露的模型插槽依赖问题已修正：伴随插件声明 remote 与 remote.session；就绪通知改为 React 提交后发出，隐藏试运行保留两帧并识别本地插槽挂载失败。

## 发布前仍须完成

1. 将就绪插件正式发布并以真实不可变 commit/version 更新生产源和锁文件；当前生产0.1.52来源不包含本地就绪改动，生产运行时构建有明确门禁。
2. 从发布注册表分配新的客户端 versionCode（必须高于已发布最高值）；仓库当前0.2.9/code6尚未改为发布身份。
3. 为该 Code 配置 rc.2 + 新插件专属兼容范围，验证实际 manifest 响应的两个组件 Code 与防降级基线。
4. 在 darwin-x64、Windows、Linux 真机或 CI 中补齐原生执行、安装包、历史数据、账号切换和插件重启回归。
5. 以上通过后执行正式发布。当前本地候选带 LOCAL_CANDIDATE 标记，不可上传为生产运行时。

构建方法与来源约束见 ../../runtime/harness-0.1.5-rc.2-build.md。

## 复现与原始验证记录

- 客户端全量日志：/tmp/arkme-epoch-client-tests-final.log。
- 插件全量日志：/tmp/arkme-plugin-full-rc2-node24.log（Node24.12.0）。
- 安装包离线报告：/tmp/arkme-packaged-offline-report.json。
- 等待页截图：/tmp/arkme-network-waiting.png。
- 本地安装包：/tmp/arkme-rc2-runtime-free-desktop/mac-arm64/arkme.app（未签名、未发布）。

以上结果不代表生产 feed、新客户端 Code 兼容范围、真实登录账号升级、模型调用或其他平台原生执行已验收。发布前条目仍是明确的门禁。
