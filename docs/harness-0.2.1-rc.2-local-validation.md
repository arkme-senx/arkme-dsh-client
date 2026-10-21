# Harness 0.2.1-rc.2 本地集成验证

2026-10-20。本地候选，未提交、未上线。用户已确认保持 Arkme 原布局和交互，只迁移新版接口。

## 适配与根因

- 新版移除了旧 `*Outline16/*Outline14` 导出。旧组件在渲染时变成 undefined，引发 React #130。已改用公开的 Medium 图标，14px 场景显式保留尺寸。
- 布局入口改为 keyed `main`（key=conversation）与 `rightbar`。已迁移注册和原生 Slot owner 类型。
- 会话 Controller 不再提供 current/open。通过公开 mainView retention 读取选中状态，通过 uiWorkspace 打开会话，保留持久化恢复、人工切换和账户隔离。
- 新版工作区列表新增行菜单、操作、leading/hover 子插槽。Arkme 用独立声明组合这些贡献，保留它们的注入和 hookContext。
- 官方页面注入 `<base href="./">` 并使用相对资源地址。嵌入 `/arkme-self/harness-frame` 时资源会错误地落到子目录；现将嵌入文档 base 固定到原始根页面。
- 新版 RpcFetch 接收 `api/session/create` 等相对字符串。旧转接层读取 URL.pathname 导致 startsWith 异常，现兼容字符串和 URL。
- 原生 selector hook 要求稳定快照。列表选择器的新对象导致 React #185；现先读取稳定目录，再 memoize Arkme 投影。
- 插件的 DSH peers 现在明确匹配 0.2.1-rc.2，不再声明尚未验证的 0.1 兼容。

## 本轮四项回归（2026-10-20）

| 现象 | 根因与处理 |
| --- | --- |
| 新建会话 startsWith 异常 | RpcFetch 现在传相对字符串，旧转接按 URL 读取 pathname。统一解析为 URL；从 Arkme「＋ → 新建 DSH 会话」与 Harness 下拉入口实测。 |
| Harness 露出原生侧栏 | 旧 DOM 识别只接受旧网格定义和 header 包装；适配新版 minmax 右列、常驻 header、纯文本标题与 Tooltip 包装，恢复顶部产品名和居中会话下拉。 |
| 普通聊天左右留白消失 | 官方宽度 CSS 变量从 root 移至 body，旧适配没有继承。复用新版 body 样式，同时给宽度变量提供兜底值。 |
| 个人菜单设置打不开 | 新版 settings.launcher 被原生账户菜单替换，旧代码误当弹窗 trigger。通过公开 openSettings/settingsOpen owner 属性恢复原设置弹窗。 |

复查还发现跨设备目录摘要缺少 0.2 要求的 projections.kind，导致 api-session/added 的订阅抛出 AggregateError。目录缓存标记为 cached，本地摘要恢复时保留原 kind，云端列表同样补齐；完整 snapshot 的 sequenced 数据不改为缓存提示。

最终分发包已解包运行于本机 53881 端口；原入口新建会话、居中下拉、聊天留白、设置打开与关闭均已复验。该进程截至复验完成时，日志中 startsWith / AggregateError / React minified error 均为 0。五个组件 SHA256 校验全部通过。

本轮排查：按截图逐入口复现 → 对照官方 tag 的网格/header/设置 owner/会话 projection 合同 → 最小修复与回归 → 构建分发、解包重启 → 实际点击和最新进程日志核对。临时 console 明细诊断仅用于独立预览快照，已恢复，未进入源码或分发包。

## 排查流程

1. 完整构建收集真实公开类型变更，对照已安装 0.2.1-rc.2 声明和官方 tag 源码。
2. 用本地 Harness 分发包与本次插件创建独立 appData 测试预览，关闭自动更新，不读取在线 release set。
3. 对照桌面日志、iframe 资源地址、真实点击结果和会话持久化记录定位故障。
4. 增补资源基址、字符串 RPC、导航恢复、稳定订阅及新增子插槽的回归测试。
5. 完整构建插件，打包再解包启动。撤销临时精确版本豁免；排查用运行时日志补丁已恢复。

## 验证与限制

- 插件完整构建、类型检查及 frozen-lockfile 安装通过。
- 前阶段 44 个相关测试文件，421 项通过、1 项跳过；本轮回归 8 个文件，105 项通过、1 项跳过。
- macOS arm64 / Electron 43.2.0 / ABI 148：本地解包启动、Arkme 主界面、原生新建会话、输入框、模型目录及 DeepSeek V4 Flash 选择已实测。
- 最小模型请求已到达测试托管服务，但返回 HTTP 502（SERVER）。追踪 ID：83095408-7137-4f20-9b65-6e7b0367c7b8。已通过持久化 assistant/attempt 与 turn/end 交叉确认；服务端 502 的内部原因未排查，完整回复链路尚未通过。
- 其他三个平台仅构建和文件检查，不代表已完成原机执行验证；跨设备会话与真实工具调用未做现场端到端测试。
- 本地集合清单是离线组件描述，不是线上更新服务 manifest。插件保留源码版本 3.0.18，用候选标记与校验和区分，不能直接覆盖线上同版本。

## 本机产物

- 预览入口：`.runtime/local-preview-021/run-preview.command`
- 当前插件：`.runtime/local-preview-021/distributed-plugin-ui-parity-final`（最终分发包解包）
- 本地 release set：`.runtime/artifacts/release-set-0.2.1-rc.2-local-20261020/`
- 内含四平台 Harness、适配插件、local-release-set.json、SHA256SUMS。


## 恢复生产 Release Set（2026-10-21）

用户完成本地测试后要求恢复生产加载路径。正式源码的 `src/main.ts`、`runtime/service-config.ts` 与更新策略此前未被改成本地 manifest；本地运行依靠独立 `.runtime/local-preview-021` 壳和环境变量覆盖。

本轮已完成：

- 重新编译客户端并重新生成根 `dist/runtime-service-config.json`：`environment=prod`、`serviceBaseUrl=https://api.jotmo.cc`，不带 migrationTest。
- 原 `run-preview.command` 清除本地插件、临时 appData、服务覆盖和更新开关，转交现有 `scripts/run-packaged-shell.mjs prod`；旧离线启动脚本保存为 `run-local-preview.command.disabled`。
- 已关闭仍在运行的离线测试预览。离线组件及测试数据留存，不纳入正式客户端 `dist/**/*` 打包范围。
- 正式非 MAS、非本地测试包进入 `ElectronRuntimeManager`，从生产服务解析 release set，启用正常自动更新策略。保留本轮 Harness 与插件适配源码。
- `tsconfig.build.json` 编译与正式配置生成通过；runtime-service-config、update-check-policy、packaged-shell、electron-runtime-manifest 共 4 文件 17 测试通过。

当前没有 `release/mac-universal/即我.app` 正式壳，未伪造 packaged 模式运行，也未发版或改生产服务配置。完成正式打包后通过 `pnpm run run:prod` 启动；实际 Harness/插件版本由生产 release set 决定，本地验证通过不会自动发布候选组合。
