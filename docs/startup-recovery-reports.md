# Web 启动故障与恢复结果

客户端沿用 installer-reports schema 1：启动阶段仍是 `plugin-load`、`result=failure`、`error_code=STARTUP_FAILED`。这些字段表示发生过插件激活故障，不保证最终启动失败。接收端无需部署变更。

`log` 第二行的 `[startup-report] web-recovery` JSON 是固定白名单诊断：
- `attemptId`：本次 Web 故障随机生成的 32 位十六进制关联 ID，不包含账号或设备身份。
- `phase=detected,outcome=pending`：发现故障，恢复结果尚未知。
- `phase=outcome`：`recovered` 对应 `recovery=completed`；`failed` 对应 `recovery=failed`；`not-applicable` / `cancelled` 对应 `recovery=unknown`。

两阶段使用不同 `event_id`；每份报告离线重发保留原 `event_id` 和关联 ID。恢复中的 Supervisor 失败状态由终态报告承接，避免重复报成独立启动失败。正常启动不新增报告。进程在恢复中退出、队列限额或上传缺失时，只有 detected 的记录必须标“结果未知”。

`recovered` 只在原有隔离、重启、页面验证全部成功后产生。原隔离策略、核心保护、失败回滚和提示文案不变。`not-applicable` 只表示本次恢复未执行，不能据此推断最终业务界面状态。

离线日报：`python3 scripts/classify-startup-reports.py <证据目录>` 读取 `desktop-startup.json`，输出 `startup-outcomes.json`。先按 event_id 去重，再按 attemptId 合并；旧格式、终态缺失/冲突、版本维度冲突均为 unknown，不凭临近时间关联。恢复成功与恢复失败分开计数；日志报告数和关联故障数均不是用户数或失败率。

跨自然日及离线补报需补查相邻窗口并明确范围；单窗口的 unknown 不代表没有恢复。历史报告不会自动获得新客户端的恢复证据。
