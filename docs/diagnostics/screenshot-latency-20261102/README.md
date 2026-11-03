# macOS 截图唤起延迟诊断（2026-11-02）

## 范围与基线

现象：用户反馈按快捷键后约 3 秒出现截图，每次均慢。
客户端基线 a667f92（HTTPS fetch master 核对）；插件基线 ca5238cc（v3.0.40，HTTPS fetch master）。
两个仓均在 zp-codex/screenshot-latency-20261102 独立分支；没有替换正在运行的正式客户端。

## 已测结果

本机双屏：3024×1964、3840×2160。使用现有 Electron 43.2.0，屏幕权限已授予。

| 测试 | 首次 | 后续四轮 |
| --- | --- | --- |
| 原生枚举、抓屏、PNG、Base64 | 676 ms | 511、521、517、551 ms |
| 隔离编辑器：截图调用至 showInactive 调用完成 | 608 ms | 497、497、483、471 ms |

原生测试中：窗口枚举首次 43.5 ms，后续 0.6–0.9 ms；PNG 编码每屏约 187–225 ms；Base64 每屏不到 0.4 ms。
两组测试时刻和画面内容不同，不能直接相减计算编辑器开销。
getSources 回调的测量包含主线程调度等待：其他屏的同步 PNG 编码会推迟 Promise 回调，因此不能将该数值解释为纯系统抓屏耗时。
show-called 代表显示 API 返回，不能等同于物理屏幕首帧呈现时间。

## 结论与限制

未在隔离编辑器复现 3 秒。抓屏与编码有约半秒量级的可见成本，但不足以证明它们解释完整延迟。
优先怀疑每次重载完整 Harness/插件入口、公共 preload 的同步 IPC，以及生产主进程繁忙导致的等待。
这些仍是待生产链路计时确认的候选根因，不能直接宣称剩余约 2.5 秒全部属于页面加载。
隔离实验使用新 Electron 进程、最小 preload、独立本地 HTTP 服务、真实截图 IPC 和真实截图编辑器；不复用正式账号或业务会话。
直接尝试加载正式本地 Harness 返回 401，未绕过认证。完整公共 preload 在独立实验中缺少业务 IPC handler 会超时，该次实验无效，不作为生产延迟证据。
没有保存截图文件，没有向网络上传截图；日志只包含耗时、阶段、随机会话 ID 和窗口 ID。

## 排查流程

1. 跟踪快捷键到 captureClipboard、抓屏、窗口创建、插件入口、图片解码、ready 和 showInactive。
2. 在两个独立 worktree 加可选诊断标记，默认关闭，不改视觉或交互。
3. 连续五轮实测原生链路；再通过独立轻量入口连续五轮测真实编辑器。
4. 比较分段数据，降低原生窗口枚举、Base64、编辑器自身作为 3 秒主因的优先级。
5. 完整生产链路需要运行包含两仓诊断改动的客户端与插件，启用下列开关后复测。

## 复测

在客户端仓：

```sh
node_modules/.bin/tsc -p tsconfig.build.json
node_modules/.bin/electron scripts/profile-screenshot.cjs
node scripts/build-screenshot-profile.mjs /absolute/path/to/instrumented-plugin
node_modules/.bin/electron scripts/profile-screenshot-editor.cjs /printed/build/directory
```

完整客户端使用其既有启动流程，并传入 `ARKME_SCREENSHOT_PROFILE=1`，过滤 `[arkme-screenshot-profile]` 日志。
必须实际加载本次插件改动，才能收到 context-decoded、image-decoded、canvas-painted；仅客户端改动也能记录 context-request 到 editor-ready 的总等待。
关键阶段：capture-start → native-windows → get-sources → png → base64 → window-create → load-url → context-request → context-decoded → image-decoded → canvas-painted → editor-ready → show-called。
同一个 requestId 内比较 elapsedMs；各屏并发阶段不可直接加总。渲染阶段为主进程接收 IPC 时刻，包含 IPC 调度误差。

## 验证

客户端构建 TypeScript 检查及全项目 typecheck 通过；截图 IPC/session 测试 48 项通过，包含诊断默认关闭与来源限制。
插件截图相关测试 35 项通过；真实编辑器 Vite production bundle 构建通过，Electron 五轮实验通过。
插件全量 typecheck 未通过（共享依赖环境下产生 239 行诊断，涉及 ArkmeBrand 等非本次修改文件）；未发现本次三个截图文件的类型诊断，不能据此宣称插件全量检查通过。

## 后续优化选择

若完整页面加载占主要时间，优先评估独立轻量截图入口，再评估编辑器预热/复用；若 PNG 占主要时间，再评估像素传输或编码路径。
本次仅增加诊断，不把隔离实验替换为正式截图入口，也未修改正式应用包、提交、推送或发布。

## 正式运行环境复测补充

- macOS 26.4 (25E246)，ARM64；/Applications/即我.app，客户端 3.0.23 (301)，主进程 PID 1111；页面版本 v3.40.301。
- 使用用户正在登录的正式应用，通过系统 UI 自动化点击截屏按钮。第一次成功：点击调用返回约 191 ms，首次 AX 观察到截图编辑器时距点击调用开始 2497 ms。该值含输入及 AX 观察开销，只有一次有效观察，不能当作精确内部耗时或多轮平均。
- 截图窗口 URL 为原 Harness 地址加 ?arkmeScreenshot=1。其 AX 树同时出现 Harness 会话侧栏、工作区与会话内容，随后出现截图编辑器，证明正式截图窗口确实启动了完整 Harness 页面；但尚不能量化该部分占比。
- 后续自动化点击与快捷键未稳定触发截图，相关轮次全部无效，不纳入速度统计。进程 sample 未可靠覆盖成功触发区间，不作瓶颈证据。
- 未修改应用安装包、未开启远程调试或绕过认证。已请求用户手动按平时的快捷键，并保留截图选框，等待进一步检查。

### 用户手动触发后的确认

用户回复“已出现”后，在正式应用 AX 树确认：
- 活动窗口 URL 含 `?arkmeScreenshot=1`。
- 同一页面树中同时存在 Harness 的“全局面板”“添加工作区”“会话层级”、已加载的历史对话与输入区，以及“截图编辑”“截图编辑工具”。
- 截图工具栏“完成”的行为是“保存到剪贴板”，对应用户全局快捷键场景，而非独立实验或聊天附件替代路径。
- 读取已安装 app.asar 的截图实现，与源码结构一致：每次 new BrowserWindow、loadURL，全部屏幕 ready 后才 showInactive。

因此已确认“截图窗口启动完整业务页面”的结构性开销，不再仅依据源码推测。尚无完整运行版本的分阶段日志，不能证明这项开销独占 3 秒；也不能把 AX 观察时间当作真实首帧时间。
正式窗口菜单没有开发者工具入口，未改签名包或启用调试端口。检查菜单时 Esc 同时取消了截图，之后关闭菜单并确认回到主窗口；没有完成、保存或发送截图。
建议性能修复优先让截图窗口加载独立编辑器入口，保留现有截图交互，再在真实安装环境计时验证。先前隔离入口数据仅作为可行性参考，不作为正式修复收益承诺。

## 优化实现与最终验证

已在客户端及插件两个 worktree 实现独立入口：

- 插件增加静态 `/arkme-self/screenshot` 页面及自包含 editor.js，直接挂载既有编辑器。
- 客户端并行探测入口能力，支持时使用专用 screenshot-preload；旧插件回退原页面和 preload。
- 继续使用相同 origin、主 frame 与截图 lease 校验，多屏 ready 屏障、账号切换取消及“问 DSH”协议不变。
- 专用页面 CSP 禁止业务网络连接和 iframe；专用 preload 不做会话恢复或同步业务 IPC。
- 打包配置与 packaged-smoke 增加专用 preload 和入口解析模块，防止构建后漏带。

最终产物：现有完整插件 client.js 13,225,409 bytes；独立 screenshot-editor.js 166,067 bytes（包含 React）。这是构建文件大小对比，不是实际网络传输量或启动收益的精确比例。

最终 Electron fixture 使用实际生产 HTTP handler、生产 bundle、专用 preload 和生产截图 IPC；本机双屏真实抓屏。五轮 showInactive 调用返回耗时：668.53、500.01、480.42、491.48、508.24 ms。
断言：所有截图窗口都使用独立路径；无 Harness boot graph，无 arkmeDesktop 业务 bridge；没有非预期 HTTP 资源请求；五轮仅一次能力探测；没有 renderer error。
证据见 optimized-entry.log。该结果是独立进程中的新路径验收，不是已更新正式安装包后的端到端对照，不能直接和单次正式 AX 观察值相减宣称固定提速百分比。

### 最终检查结果（替代前文依赖不匹配下的失败记录）

之前共享 node_modules 实际包含 DSH 0.1.0-rc.7，而锁文件要求 0.2.1-rc.2。现已在本次插件 worktree 按 frozen lockfile 独立安装，未修改原仓依赖目录或锁文件。

- 插件 `pnpm run build` 全量通过，含 TypeScript 声明、全部 bundle、local-session Profile、可执行入口/worker 验证。
- 插件 37 项相关测试通过。
- 客户端完整 typecheck 通过、截图相关测试 56 项通过。
- 最终 Electron 集成测试五轮通过。
- 两仓 diff whitespace 检查通过。

运行新路径 fixture：

```sh
# 插件仓：先 pnpm run build，再生成测试所需的独立 route module
pnpm exec tsdown --no-config src/screenshot-editor-route.ts --format esm --platform node --out-dir lib/screenshot-test --no-dts
# 客户端仓
node_modules/.bin/tsc -p tsconfig.build.json
node_modules/.bin/electron tests/fixtures/screenshot-standalone-electron.cjs /absolute/path/to/plugin-worktree
```

当前正式应用未替换；代码未提交、推送、打发布包或发布。完整优化生效需要客户端和插件都包含本次改动并重启。旧版组合保留原行为。


## 实际 dev 反馈后的纠正与修复（待实际 dev 复验）

用户反馈仍有延迟后，检查 `/tmp/arkme-screenshot-dev-20261102.log` 的实际截图请求，而非继续以独立 fixture 推断体验：

- 请求 `61e5515e-d4fb-487c-86d3-553be74faf3c`：抓屏编码约 499 ms；770 ms 记录 `entry-legacy`；1399.48 ms 调用显示。
- 请求 `dbe1dc82-9611-4e9b-83c3-301810e37e81`：抓屏编码约 364 ms；364 ms 记录 `entry-legacy`；1320.27 ms 调用显示。

确认的直接原因：新增能力探测首次未成功，750 ms 超时后将 false 长期缓存，后续截图持续加载完整业务页面，独立入口优化没有实际生效。session.fetch 最初为何未完成尚未确认；curl HEAD 成功不能证明应用内探测成功。

修复已取消网络探测，改为插件主页面通过专用 IPC 登记独立入口能力。主进程仅接受受信任主窗口顶层 frame，并按 origin 和主窗口 ID 校验；旧插件没有登记仍回退旧路径。独立 fixture 同步改为生产登记 IPC，断言零 HEAD 探测。

本轮客户端编译、51 项截图 IPC/session 测试通过；插件全量构建、16 项 route/native/window 测试通过。这些结果不代表真实 dev 性能验收完成。

重启时旧 dev 主进程被“草稿尚未保存”保护拦住，窗口已空白；新进程因单实例占用退出。已询问用户是否允许结束旧 dev 进程，尚未强制退出。正式应用未受影响。待重启后必须确认 `standalone registered`、实际请求 `entry-standalone` 及其显示耗时，不能使用前文独立环境五轮数据替代实际验收。


### 用户批准重启后的真实 dev 结果

用户确认 dev 无待保存内容后，仅结束已核实的旧 dev 主进程和 Harness 子进程，保留独立数据目录并重新运行 pnpm dev。构建通过、登录状态保留，日志确认 standalone registered。

重启后前三次实际请求全部 entry-standalone，show-called 分别 915.43、698.96、2985.48 ms。前两次在 UI 自动化点击前已发生，不能冒认是自动化触发；第三次由实际 dev 聊天窗口截图按钮触发，AX 确认截图窗口 URL 为 /arkme-self/screenshot?arkmeScreenshot=1，出现截图编辑器，随后 Esc 取消。未保存、发送截图。

第三次抓屏编码在 620.81 ms 完成；慢屏窗口 676.53 ms 开始 loadURL，2907.99 ms dom-ready，约 2231 ms 耗在页面加载到 DOM ready 区间。另一屏约 1270 ms。现有证据确认入口回退 bug 已修复，但仍存在窗口加载阶段长尾，尚不能区分网络服务响应、renderer 启动及自动化 AX 观测的影响。不能宣布延迟完全解决，也不能仅挑选前两次较快数据。

后续自动化按钮及快捷键没有产生新请求，不作为有效计时。证据 actual-dev-registered-entry.log 仅保留截图阶段日志。dev 继续运行，正式应用未替换。


## 连续截图最终修复与真实 dev 验收

### 排查流程与确认原因

1. 先通过正式版 AX 与源码确认，每次截图启动完整 Harness 业务页。
2. 实际 dev 分阶段日志发现首版优化探测超时后缓存 false，导致持续 entry-legacy；取消网络探测，改主窗口能力登记。
3. 独立页面仍每次创建 renderer：实际一次 2985.48 ms 请求中，慢屏 loadURL 至 DOM ready 约 2231 ms。该阶段的系统/服务内部细分未完全定因，不将其归咎于未经测量的网络组件。
4. 尝试一次性预热：修复会话 SPA 导航错误清理能力后，仍在连续快速操作中出现 2169.31、1866.19 ms；日志确认预热窗口尚未加载完，补充速度跟不上消费。
5. 改为持久复用已加载编辑器；每轮结束隐藏窗口，通过 reset-v1 同步卸载旧画布、撤销 Blob URL、清空图片及全部编辑状态。每轮 IPC 绑定截图 requestId，旧轮 ready/select/close/complete/save/ask-dsh 被拒绝。账号失效时销毁窗口。旧插件保持一次性窗口策略。
6. 双屏默认 PNG 编码另占约 270 ms；macOS 不透明 BGRA 位图改为低压缩、无损 RGB PNG。透明或不支持的输入回退原编码器，Windows/Linux 保持原行为。真实屏幕新旧编码产物经 Electron 解码逐像素一致；独立实测约 249→57 ms、85→34 ms。文件体积可能增大，仅用于本机 IPC 预览，最终导出仍用原编辑器流程。

### 验收环境与数据

当前 macOS ARM64、双屏 3024×1964/3840×2160，真实已登录 dev，客户端 3.0.24/vc302、当前插件工作区。dev 独立 userData 保留，正式安装包未替换。

- 重启后首次实际截图：786.53 ms。
- 用户随后快速连续触发并 Esc 取消 5 次：348.62、323.62、287.94、303.21、289.68 ms；均值 310.61 ms，最大 348.62 ms。
- 六次均 entry-standalone；双屏 webContents ID 始终为 2、3，证明没有每轮重建。用户回复已完成操作，但未提供主观体感评价。
- 耗时定义为主进程收到 capture 到编辑器就绪并调用 showInactive 返回，包含抓屏、编码、IPC、解码、画布绘制及 ready 屏障；不包含按键送达之前的系统开销，也不是光学测量的首帧显示时间。
- 实际 AX 确认独立 URL 和截图编辑器出现。未保存、发送截图。
- 证据：actual-dev-reused-editor.log。有限样本下连续截图未复现秒级长尾，不据此保证任意系统负载下的上限。

### 最终检查

- 客户端完整 typecheck 与构建编译通过。
- 客户端截图 IPC/session/PNG 测试 59 项通过，覆盖连续复用、旧轮请求拒绝、账号失效销毁、导航与屏幕变化、PNG 通道/行边界/CRC/回退。
- 插件全量构建通过，5 个截图测试文件共 22 项通过。
- 真实 Electron 生产 handler/preload/bundle/IPC 集成连续 10 次通过；同一组窗口复用，每次取消后断言无 canvas、无编辑器节点，窗口隐藏；无业务 bridge/Harness boot、零 HEAD 探测。首次 687.69 ms，其余 267.08～311.15 ms。独立测试只作协议与生命周期补充，不替代上述用户 dev 实测。
- macOS 真实截图快速 PNG 编码与原 native PNG 解码后逐像素一致。
- 代码未提交、推送或发布。当前 dev 保持运行。


## 2026-11-03：选区后“截图会话已失效”回归修复

用户报告完成截图时失效。检查真实 dev 日志发现 arkme-screenshot:close 的 Object has been destroyed，栈指向 finish 中新增的事件清理函数；AX 也确认选区工具栏下显示“截图会话已失效，请重新截图”。

根因：双屏 select 会先从活动窗口集合移除并销毁另一屏窗口；finish 仍逐个执行事件清理函数，其中读取已销毁 BrowserWindow.webContents 会抛异常。此时 active 已清空、lease 已关闭，但窗口回收和 capture Promise 结算未完成；随后完成按钮收到 false，出现会话失效提示。上轮速度验收集中在未选区直接取消，未覆盖这个分支。

排查步骤：真实日志异常栈 → 对照 select/finish 生命周期 → 增加模拟 Electron 销毁后属性访问报错的双屏测试 → 修复前 complete/close 两项稳定失败 → 清理前检查 window.isDestroyed() → 复验及真实 Electron 集成。

修复只跳过已销毁窗口的 webContents 事件移除，活窗口正常解绑；保留会话鉴权、截图预热和无损编码优化。新增双屏选区后 complete/close 及下一轮可用性回归测试。独立真实 Electron 集成 --selection 模式轮流执行选区后完成、选区后取消，共 4 轮；通过真实主窗口 capture IPC 断言 captured/cancelled 状态，并验证窗口隐藏、画布清空。完成测试使用 1×1 合成 PNG，仅返回到测试 owner，不写文件/剪贴板、不上传实际截图。

客户端 61 项相关测试、构建和完整 typecheck 通过；双屏集成 4 轮通过，耗时 598.95、340.76、275.11、258.16 ms。证据 selection-completion-regression-20261103.log。已正常退出卡住的旧 dev 并重启修复版，保留登录数据，等待用户在实际 dev 复验完成/取消。

用户实际 dev 复验回复“两种都正常”：选区后完成、选区后 Esc 均正常结束。对应阶段日志另存 actual-dev-selection-fix-20261103.log。
