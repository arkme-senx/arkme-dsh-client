# 连续截图性能修复与验证（2026-11-05）

## 结论

已修复复用截图窗口时不断积累的加载监听；macOS 窗口枚举改为异步原生调用，与抓屏并行，并为可选窗口吸附信息设置 100 ms 等待预算。连续 100 次生产截图 IPC 调用通过，未出现耗时和内存随次数增长的趋势。仍观察到系统抓屏的偶发延迟，不能承诺所有操作恒定耗时或永不失败。

代码位于 `zp-codex/screenshot-repeat-performance-20261105`，基于当次成功 fetch 的 `origin/master`（99d51ec）。原业务 checkout 保持不变；没有替换正式应用、提交、推送或发布。

## 根因与排查流程

1. 用户将问题收窄为快记输入框截图按钮、选框出现前，且连续操作后变慢。
2. 对照实际安装包和插件源码：按钮先经过输入页，再调用 capture IPC；快捷键直接进入同一主进程 capture。主进程阶段日志不覆盖输入页点击排队时间。
3. 通过生产模块、preload、当前插件编辑器和真实双屏抓屏连续调用 40 次。复用窗口每轮注册 `dom-ready` / `did-finish-load` 一次性监听，但不再导航，也未在结束时移除。每窗每种事件累积到 39 个监听，出现 MaxListenersExceededWarning；主进程 RSS 从 361 MiB 增长到 2518 MiB。
4. 只在隔离实验中清理这些监听，40 次后 RSS 为 462 MiB，证实监听保留造成资源持续累积。但慢请求仍存在，不能把两者直接认定为同一原因。
5. 分段日志捕获到 712.77 ms 请求，其中同步窗口枚举耗时 473.15 ms；窗口已复用、没有重建。该枚举仅用于可选窗口吸附，却阻塞了主进程和后续抓屏。

## 修改

- 仅新加载的截图窗口注册加载计时监听，并在本轮 finish/取消时显式解绑；复用窗口不再注册。
- 使用 Koffi 的异步调用执行 `CGWindowListCopyWindowInfo`。返回的 CFArray 始终在解码后释放，包括已经超过等待预算的结果。
- 窗口枚举与屏幕像素抓取并行。超过预算或原生失败时继续现有手动框选降级；同一 reader 最多一个未完成原生请求，不积压工作，不复用上一轮的迟到坐标。
- 100 ms 是事件循环上的等待预算，不是整个截图的实时保证。系统调度、其他主线程任务及 `desktopCapturer.getSources` 仍可能延迟回调。
- 未改变按钮、编辑器布局、截图完成/取消协议或结果写入目标。Windows 的原生枚举实现保持原样，本次原生性能验证限 macOS。

## 验证

回归先失败后通过：旧实现的复用监听计数应为 0、实际为 1；新增慢枚举约束初始缺少实现。最终测试还覆盖迟到结果丢弃、失败恢复、单个在途原生请求、抓屏与枚举并发、取消后的结果隔离，以及新窗口未加载完成时的监听清理。

- TypeScript 构建编译及完整 typecheck 通过。
- Vitest：1271 通过、19 条条件跳过；3 个使用 Node test runner 的 CI 文件另跑，13 通过。
- 默认 Vitest 命令首次把上述 3 个 Node 测试文件识别为“没有测试套件”，且一次插件打包测试触发默认 5 秒超时。最终仅排除这 3 个文件、改用正确 runner，并将涉及打包的测试预算设为 15 秒，完整复验通过。没有修改无关测试配置或隐藏失败。
- 真实原生窗口枚举：前后层级、坐标、隐藏窗口排除均通过，使用新异步 macOS reader。
- 真实双屏按钮 capture IPC：连续 100 次取消通过，每轮加载监听为 0、窗口复用、画布清空。
- 真实双屏选区后完成/取消：交替 20 次通过；完成只返回合成的 1×1 PNG 到隔离 owner，不写系统剪贴板或发送实际截图。

| 指标 | 结果 |
| --- | --- |
| 100 次中的前 20 个热请求中位数 | 230.28 ms |
| 最后 20 次中位数 | 227.50 ms |
| 前段 / 后段 P95 | 742.46 / 712.96 ms |
| 99 个热请求中位数 / P95 / 最大 | 223.65 / 738.14 / 863.12 ms |
| RSS 首次 / 峰值 / 结束 | 327 / 472 / 370 MiB |
| 20 次选区操作首次 / 后续范围 | 437.96 / 245.48–273.23 ms |

计时为主进程 capture-start 到 showInactive 返回，不包含用户点击投递及快记输入页的前置操作，也不是光学首帧时间。测试使用真实屏幕、当前插件 3.0.49 和生产截图 IPC，但在无业务账号的隔离进程中运行，没有冒充已替换正式应用后的端到端验收。

首次 100 次尝试与全仓测试并行，第 60 次遇到系统屏幕缩略图为空：`get-sources-end:3024x1964` 在 3001.54 ms 才返回，当次窗口枚举 1.08 ms 已完成。该批次不计作通过。之后单独运行 100 次全部通过。修复后仍有 600–800 ms 请求，主要等待系统抓屏；这项残余风险保留，不宣称两处修复消除了所有系统级卡顿。

## 复现命令

```sh
node_modules/.bin/tsc -p tsconfig.build.json
node_modules/.bin/tsc -p tsconfig.json --noEmit
node_modules/.bin/vitest run --exclude tests/ci-notify.test.mjs --exclude tests/ci-package-version.test.mjs --exclude tests/ci-restore-history.test.mjs --testTimeout 15000
node --test tests/ci-notify.test.mjs tests/ci-package-version.test.mjs tests/ci-restore-history.test.mjs
node_modules/.bin/electron tests/fixtures/screenshot-window-native.cjs
node_modules/.bin/electron tests/fixtures/screenshot-standalone-electron.cjs /path/to/plugin --button --rounds=100
node_modules/.bin/electron tests/fixtures/screenshot-standalone-electron.cjs /path/to/plugin --selection --rounds=20
```

`plugin` 目录需包含 `lib/screenshot-editor.js` 与编译的 `lib/screenshot-test/screenshot-editor-route.mjs`。本次使用当前安装插件的编辑器文件，静态 handler 沿用已有生产 route fixture。

`summary.json` 保存每轮时间、内存、源码摘要和验证边界；`button-100-stages.json` 保存全部 100 次的阶段计时，无截图像素、窗口标题、业务会话或账号内容。
