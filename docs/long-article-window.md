# 独立长文窗口

实现分支：`zp-codex/long-article-window`。客户端基线 `ab866ab`，插件基线 `cddf385`。需一起集成两个仓库的改动；当前客户端 catalog 中的旧插件版本不会自动包含新入口。本次未修改版本、运行中的 App 或远端制品。

## 行为

新建长文打开独立非模态窗口，复用现有富文本/图片编辑器及 DSH 主题。聊天中“添加长文”的已有文章选择保持现状，“新建长文”打开独立窗口并可直接发送。网页或无 v1 bridge 的旧客户端继续使用现有弹层。

同一账号会话复用窗口；主窗口切换会话不改变发送目标。窗口发送成功回传绑定会话；失败保留内容及请求标识。原生关闭和 App 退出都先处理草稿；保存失败保持窗口，账号失效后仍需明确放弃才会丢弃脏编辑。账号失效时可保留窗口复制内容，不能写入新账号。活动编辑窗口存在时更新流程不能先停止 Harness。

## 检查与证据

- 客户端：`pnpm typecheck`、`pnpm build`；`pnpm exec vitest run tests/long-article-windows.test.ts tests/app-quit-guard.test.ts`，15 项通过。
- 插件：`pnpm typecheck`、`pnpm build`；12 个相关测试文件，73 项通过。Node 25 运行 jsdom 测试需设置 `NODE_OPTIONS=--no-experimental-webstorage`，否则既有 composer-article-store 测试遇到 `localStorage.clear is not a function`。
- 真实 Electron、production preload、production editor 与本地 fake Provider：10 项冒烟通过，覆盖窗口去重、IPC 角色隔离、富文本草稿、关闭取消、保存失败保留、草稿恢复、幂等重试、会话切换和回执、账号失效保护。
- 已检查 light/dark/close 截图。未向真实会话发送测试内容；未做 Windows 实机或真实后端联调。
- OpenSpec sidecar：meta 的 `c20260920-arkme-long-article-window`。新 change ID 合规；全仓命名脚本被基线已有 `calendar-offline-read` 目录阻断，不修改该无关目录。当前环境没有 openspec CLI，未声称 CLI validate 通过。

## 重跑本地 Electron 冒烟

先在插件工作区运行：

```sh
node scripts/build-long-article-window-smoke.mjs /tmp/arkme-long-article-smoke
```

然后在已安装 Electron 二进制的客户端工作区运行：

```sh
pnpm build
pnpm exec electron tests/fixtures/long-article-window-electron.mjs ../arkme-dsh-plugin /tmp/arkme-long-article-smoke /tmp/arkme-long-article-qa
```

生成 `result.json` 和三个 PNG。测试使用独立 userData 与本地 HTTP fake Provider，不读取正式账号或发送真实消息。

## 2026-09-20 入口最终确认

聊天输入框保持原“添加长文”入口，点击后打开原选择弹层；选择已有长文加入输入框待发送。在弹层点击“＋新建长文”才打开独立 Electron 编辑窗口，完成编辑并直接发送。撤回本次新增的“写长文／选择已有长文”两个聊天菜单项。非聊天场景的原有“写长文”入口不变。

独立窗口顶部显示固定发送对象与发送按钮，使用原生窗口关闭按钮。窗口/草稿/发送恢复已通过真实 Electron + 本地模拟 Provider 的 10 项验收，未向真实会话发送测试消息。

## 已发送长文独立编辑

点击聊天原文卡片或气泡外围（含 Enter/Space）打开 existing 窗口。服务端 editable 为 true 时自动进入编辑，保存使用原 source.long-article.update 与 version；成功更新原消息并关闭，不发送新消息。无编辑权限只读；转发快照使用 snapshot 独立窗口，不调用更新接口。相同账号/会话/文章/模式复用窗口，不与新建互相覆盖。

桥接版本升级为 2，保留 v1 新建调用兼容；旧版桌面桥接不支持 existing/snapshot 时回退原页面流程。新 preload 生效需要重启开发应用。更新回执不得进入新发送保留缓存。

验证：原生 17 项测试、插件 72 项相关测试、双方类型检查与构建；真实 Electron + 模拟 Provider 13 项验收，包括原文更新无新增发送、无权限只读和转发快照只读，错误列表为空。未向真实会话发送或修改消息。
