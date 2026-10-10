> Historical plan: superseded by [permanent installer plan](2026-09-16-jiwo-permanent-installer.md). Old appId/DMG/website rules below are no longer active.

# 即我 3.0 外壳与覆盖安装实施记录

依据本任务中用户确认的完整方案实施。正式版显示「即我」及 Flutter 2.0 平台图标；应用 ID com.senx.arkme.harness、内部 arkme 可执行名、Arkme Harness 数据目录、arkme:// 与内部页面品牌不变。测试版不变。

- [x] 外壳与打包资源、路径更新；真实 arm64 包结构已核验。
- [x] macOS 签名迁移 PKG 构建入口：身份校验、暂存后切换、事务恢复；常规 DMG/ZIP 同源。
- [x] Windows NSIS：签名旧版识别、同范围迁移、程序白名单及事务恢复。
- [x] 3.0.0 / 275 构建号与发布门禁、升级说明和验收清单。
- [x] 本地测试、构建、独立审查与边界说明；最终 802 项通过、4 项跳过，正式签名安装矩阵待发布环境验收。

旧数据只原位保留，不转换、清理或导入；用户重新登录后加载云端。只提供安装失败恢复，不提供成功升级后的 2.x 降级支持。禁止实际安装到当前机器或触碰真实用户数据进行测试。无需提交、推送或发布。

发布环境仍需完成证书签名/公证、macOS 双架构与 Windows 10/11 真机安装矩阵、带 MongoDB 的后端路由测试、官网入口配置；详细记录见 `docs/jiwo-3-migration-release.md`。
