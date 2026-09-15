# 失败运行时组合的手动恢复

## 问题与证据

2026-09-14，测试客户端 0.2.9 / Code 7 的旧组合（Harness Code 9 + 插件 Code 35）因缺少 desktop Harness readiness v1 失败。测试服务随后已返回插件 Code 36，但客户端仍读取旧 acquisition。后台在 activeReleaseId 为空时直接返回 current，未查询远端。

排查顺序：启动日志 → 本机 state/acquisition → 已安装 ASAR 的 manager 实现 → 测试兼容接口。未清理用户数据，也未替换用户运行中的应用。

## 修复边界

- 只有手动重试会为已有启动失败记录的 acquisition 查询替代组合；新安装和未完成下载仍优先本地恢复。
- 保持旧 acquisition 为 Code 防降级查询基线；新清单验证通过才由安装流程原子保存，网络失败或 Code 回退不覆盖旧记录。
- 缓存按制品摘要复用，不清除相同 Harness 下载。
- 缺少就绪能力记录 PLUGIN_DESKTOP_READINESS_UNSUPPORTED，兼容识别旧 RUNTIME_START_FAILED 的相同报错；同一不兼容组合不重复试运行。
- 没有 active 的后台检查返回 no-active，且不请求网络、不显示安装通知。
- 数据恢复继续先于运行时准备；缓存 epoch 保持 1，无 UI 改动。

## 验证

新增恢复回归在修改前出现 6 项预期失败；修改后全量客户端测试 775 通过、4 跳过，类型检查和测试环境编译通过。全量测试所需临时本机 HTTP 监听须在允许监听的环境中执行。

交付包保持用户指定 0.2.9 / Code 7，属于手动安装的修复测试包；不会因相同 Code 自动覆盖已安装版本。包签名使用公司 Developer ID，未配置 Apple 公证。此轮不启动用户的 Arkme Test，不改测试服务配置。
