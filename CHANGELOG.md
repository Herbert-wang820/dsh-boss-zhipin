# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.0] — 2026-11-12

首个可用版本。在真实账号上完成过一轮完整流程：24 个岗位检索与打分、3 个岗位实际发送。

### 新增

- 12 个工具：`boss_preferences`、`boss_status`、`boss_login`、`boss_browser`、`boss_resume`、
  `boss_search_jobs`、`boss_job_detail`、`boss_match_jobs`、`boss_draft_intro`、`boss_greet`、
  `boss_greet_batch`、`boss_history`。
- 浏览器扫码登录，登录态保存在独立 `userDataDir`，不保存账号密码。
- 检索/详情/沟通全部在已登录页面上下文里发起，绕过 `code 37 环境存在异常`。
- 本地匹配打分（技能 45 / 方向 20 / 年限 15 / 学历 10 / JD 覆盖 10），输出命中、缺口、风险。
- 可调匹配门槛（0~100），保存在偏好里，发送前二次拦截。
- 自我介绍草稿生成 + 发送前校验（占位符、链接、长度）。
- 发送保护：默认 dry run、每日配额、最小间隔、同岗位去重、`allowSend` 总开关、批量遇风控中止。
- 失败自动截图，历史记录含失败原因。

### 修复（开发期实测踩坑）

- 详情页 URL 必须带 `securityId`，否则「立即沟通」点击无效。
- 复用标签页会被站点重定向回首页 → 改为每次新开标签页、用完即关。
- 首次联系点「立即沟通」只建会话不跳转 → 自动重开详情页再点一次（按钮已变「继续沟通」）。
- 发送按钮在输入框为空时带 `disabled` → 等按钮可点再发送，并用「输入框已清空 + 聊天区已出现」双向校验，未发出时补一次回车。
- 详情接口频控 `code 37` → 三次重试 + 退避，第三次先导航到详情页再取。
- `hrOnline` 被详情结果覆盖成 false → 合并时空值不覆盖、`true` 不降级。
- `job_ids` 打分比关键词路径低 2 分 → 缓存里补齐 `skills`/`labels`，两条路径同源。
- 年限识别 `10 余年` 解析为 0 → 正则支持「余/多」在「年」前。
- 工具输出含 `undefined`/`NaN` 被宿主拒绝 → 统一走 `jsonSafe`。
