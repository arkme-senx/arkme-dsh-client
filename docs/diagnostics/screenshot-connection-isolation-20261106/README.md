# 截图连接池隔离与双屏复用验证

日期：2026-11-06。基线：通过 HTTPS 拉取的 dev `36a3376`；分支 `zp-codex/screenshot-connection-isolation-20261106`。

## 根因与取证

正式版阶段日志先定位到：抓屏与编码约260ms完成，另一屏重建窗口的 loadURL 等待约5043ms，整个请求5340ms才显示。随后正常重启正式客户端开启 Chromium NetLog，在选屏、取消、再次截图路径中捕获 `SOCKET_POOL_STALLED_MAX_SOCKETS_PER_GROUP`：截图 editor.js 请求排队4379ms，获得连接后5ms完成下载。截图静态资源和业务事件流/API共用浏览器Session及本机HTTP地址，因而争用连接额度。

独立无业务数据对照中，保留6个HTTP请求、1200ms后释放：共用Session加载1224ms（排队1203ms），独立Session加载91ms（排队7ms）。两次正式采样不是同一请求；对照实验验证阻塞机制，不将后续网络日志冒充此前慢请求的逐阶段记录。

## 改动

- 独立截图编辑器采用惰性创建、进程内复用的非持久Session，隔离业务连接池、Cookie和缓存；不复制业务身份，拒绝编辑器权限请求。旧版非独立编辑器仍用原会话。
- 支持reset的编辑器选屏后隐藏未选屏窗口，在截图结束时统一清空画布并回收，不再每次销毁重建。主进程截图lease立即拒绝未选屏窗口继续读取或操作本次截图。
- 隐藏窗口崩溃时丢弃该窗口，不打断选中屏；账号失效时销毁包括隐藏窗口在内的全部截图窗口。

## 回归结果

先补测试确认旧代码出现5项预期失败，再实现修复。额外的隐藏窗口崩溃测试先失败、修复后通过。

- 截图IPC与会话：66项通过。
- TypeScript构建编译和全仓类型检查通过。
- Vitest全仓：1287通过、22跳过、1失败。失败项为 `tests/preload-bridge.test.ts:675` 的 `shows Linux website action and removes the whole notice after closing`，在677行找不到更新下载按钮。单独重跑及未修改基线36a3376的独立worktree均复现相同失败（38通过、1失败），与本次截图修改无关，未修改其产品逻辑或测试。
- 3个Node测试文件使用 `node --test` 单独执行，13项通过；不交给Vitest识别。

真实Electron双屏测试使用生产截图IPC、preload、系统抓屏与插件编辑器，插件bundle SHA256为 `70cb8e6c969ab096ef1ed31ed3b6fc854b92753461999f136c45b53ec3d71bd7`，与本机安装版本一致。启动时先占满业务Session的6个连接，6秒后释放；首轮截图要求3秒内显示，防止依赖释放后才通过。

| 场景 | 次数 | 前20次中位数 | 后20次中位数 | P95 | 最大值（含首次） | 主进程RSS峰值/结束 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 选屏后交替完成/取消 | 100 | 314.21ms | 277.55ms | 357.80ms | 760.17ms | 479/354MiB |
| 按钮截图直接取消 | 100 | 332.25ms | 286.68ms | 368.03ms | 584.00ms | 476/369MiB |
| 最终版选屏复验 | 20 | 240.22ms | 240.22ms | 278.58ms | 432.16ms | 489/418MiB |

两屏窗口ID始终为2和3，编辑器页面及脚本总共只加载4次请求；每轮结束均确认画布清空、无截图编辑器DOM、加载监听不累积。最终版另验证截图Session无业务测试Cookie且非持久。20次最终复验退出时有一条macOS `TASK_SUPPRESSION_POLICY invalid argument`诊断，测试结果passed、进程退出0。

数据见 `summary.json` 和对应 `*-stages.json`。100次选屏数据采于补充隐藏窗口崩溃清理分支前，最终20次在最终源码上复验；100次按钮测试为最终源码。

## 命令与边界

```sh
node_modules/.bin/tsc -p tsconfig.build.json
node_modules/.bin/tsc -p tsconfig.json --noEmit
node_modules/.bin/vitest run tests/desktop-screenshot-ipc.test.ts tests/desktop-screenshot-session.test.ts
node_modules/.bin/vitest run --exclude tests/ci-notify.test.mjs --exclude tests/ci-package-version.test.mjs --exclude tests/ci-restore-history.test.mjs --testTimeout 15000
node --test tests/ci-notify.test.mjs tests/ci-package-version.test.mjs tests/ci-restore-history.test.mjs
node_modules/.bin/electron tests/fixtures/screenshot-standalone-electron.cjs /tmp/arkme-screenshot-investigation-20261104-5mZWjU/plugin --selection --busy --rounds=100
node_modules/.bin/electron tests/fixtures/screenshot-standalone-electron.cjs /tmp/arkme-screenshot-investigation-20261104-5mZWjU/plugin --button --busy --rounds=100
```

这是隔离环境中的真实抓屏与生产IPC验证，不是已登录正式快记页面全链路验收。未替换本机正式安装包，未验证Windows真机。没有观察到本批次越用越慢或秒级连接池阻塞，不据此承诺系统抓屏永远没有尾延迟。正式程序的网络诊断此前已关闭。
