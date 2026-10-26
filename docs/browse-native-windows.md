# 位置、长文库原生窗口交付

日期：2026-10-26。分支：`zp-codex/location-article-windows-20261026`。

## 结果与范围

- 位置、长文库在桌面优先打开独立非模态原生窗口；同账号同类窗口重复打开会恢复、聚焦已有窗口。
- 位置窗口保留地图/来源/日期筛选；从日历进入会更新已有窗口的日期、时区和位置上下文。打开会话记录会聚焦主窗口并定位原消息。
- 长文库保留最近/我共享的/共享给我的。库内打开文章、新建文章复用现有原生长文编辑器；库内新建沿用自动发布，聊天新建保留手动发送。
- 修改和删除刷新主窗口、长文库；账号切换关闭浏览窗，编辑窗保留原有草稿保护。
- 无 v3 桥接的旧客户端、网页继续使用页面弹窗。原生窗口打开失败时展示错误并回退页面弹窗。

## 根因与排查路径

原插件的 ArkmeLocationDialog、ArkmeLongArticleLibraryDialog 都使用 createPortal 渲染在当前 document.body，未调用客户端窗口管理器。客户端已有 v2 单篇长文窗口，但没有承载位置/长文库的 surface。

排查过程：HTTPS fetch 两仓最新 master -> 查看位置 35e57f47、长文库 9365cd21 的 diff -> 追踪入口、createPortal 和编辑工作区 -> 对照 preload/IPC/窗口管理器 -> 类型检查、相关回归 -> 隔离 Electron + 生产 preload + 本地假 Provider 验证。补查发现原定位权限只允许主窗口，现仅增加当前账号有效位置窗口，并保留同源、顶层 sender、焦点和用户操作要求。

## 初始实现基线和跨仓合同

- 插件：`cfb95e018683eac429e6dc999eed446bc995890d`（v3.0.31）。
- 客户端：`75d74fab13b98ff8c97a63088fd7b062f961dc2f`。
- meta：`793f6b0c`，change `c20261026-arkme-browse-native-windows`。
- 窗口桥接升级到 v3，兼容 v1/v2。增加 surface/location/autoPublish 上下文，navigate/changed/onContextChanged/onNavigate/onChanged 窄接口。navigate 由主进程补入账号，插件接收时再次核对，避免账号切换后处理旧事件。
- 两仓源码需一起集成；当前客户端锁定的插件制品不会自动包含这次改动。未改包版本、未发布制品；本次交付通过插件向 dev、客户端向 master 的两个合并请求集成。

## 验证

客户端：`pnpm typecheck`、`pnpm build` 通过；以下 5 文件 47 项通过：

```sh
pnpm exec vitest run tests/long-article-windows.test.ts tests/long-article-window-ipc.test.ts tests/app-quit-guard.test.ts tests/desktop-location.test.ts tests/harness-permission-policy.test.ts
```

插件：`pnpm typecheck`、`pnpm build` 通过；以下 9 文件 112 项通过：

```sh
NODE_OPTIONS=--no-experimental-webstorage pnpm exec vitest run tests/long-article-window-bridge.test.ts tests/long-article-library.test.tsx tests/day-location-map.test.tsx tests/long-article-window-ui.test.tsx tests/long-article-focus-ui.test.tsx tests/long-article-quick-view.test.tsx tests/search-surface.test.tsx tests/explore-ui.test.tsx tests/long-article-workspace.test.tsx
```

真实 macOS Electron + 生产 preload + 本地假 Provider，8 项通过，renderer 错误列表为空：窗口复用、文章窗口与目录、自动发布、保存失败保留及重试关闭、库内新建自动发布、位置日期更新、主窗口导航、账号失效关闭。明暗主题截图已人工复核。地图测试未提供真实百度 AK，截图为未配置地图的降级状态；地图坐标/选择交互由已有 mock 地图回归覆盖，未声称真实地图或系统定位通过。

重跑：先在插件目录运行 `node scripts/build-long-article-window-smoke.mjs /tmp/arkme-browse-windows-bundle`，然后在客户端目录运行：

```sh
pnpm build
pnpm exec electron tests/fixtures/browse-windows-electron.mjs ../arkme-dsh-plugin /tmp/arkme-browse-windows-bundle .workstreams/browse-windows/evidence
```

新 worktree 若使用 `pnpm install --ignore-scripts`，需先完成 Electron 本地安装脚本，或使用已有 Electron 二进制运行上述夹具。测试仅绑定 127.0.0.1，使用独立 userData；不读取正式账号，不向真实会话发消息。证据见 `.workstreams/browse-windows/evidence/result.json` 与 PNG。测试主题样式从当前已安装 DSH 主题包提取，避免依赖已移除的旧 CSS 路径。

剩余发布前验证：Windows 实机、真实地图 AK/系统定位。OpenSpec CLI 未安装，未声称严格校验通过；仓库 change 命名脚本只报告基线已有 `calendar-offline-read`，本次 change 名称符合规则。
