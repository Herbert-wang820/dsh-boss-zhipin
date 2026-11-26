# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.0] — 2026-11-26

### 新增

- **补发定制招呼**：`boss_rescue_scan` + `boss_rescue_send`，专门处理「用户自己点了『立即沟通』、
  站点只替我发了一句『您好，可以和您聊聊吗？』、没有真正自我介绍」的会话。
  - `boss_rescue_scan`（只读）：读左侧会话列表 → 逐个打开 → 读出「我发的 / 对方发的 / 系统」三类消息，
    挑出「只有自动招呼」的会话，按简历起草文案并给出匹配分。**默认只看本周**（`since='week'`），
    范围按会话最后消息时间算，超出的会话不会打开；`since` 也支持 `today` / `month` / `all` / `days:N`。
  - `boss_rescue_send`（默认 dry run）：直接进已有聊天页发消息，**不再点「立即沟通」**，
    因此绕开了首次沟通不跳聊天页的老问题；默认跳过已有定制文案的会话（`force:true` 才重发），
    并遵守每日配额与 `minIntervalMs`。
- `lib/rescue.js`：会话列表/打开/读消息/自动招呼判定。会话的 `jobId`、`bossId`、`securityId`
  从列表项的 Vue 实例 `$props.source` 里读（页面上根本没有这些字段）。
- `tests/rescue-scan.mjs`、`tests/rescue-tool-test.mjs`：真机只读扫描与工具层 dry run 回归脚本。

### 说明

- 自动招呼判定用正则白名单 + 长度/自我介绍关键词兜底：宁可漏判成「已定制」，也不误判成「只有自动招呼」，
  避免重复打扰 HR。
- 扫描要逐个打开会话，站点的未读状态因此会变化；20 个会话约需 2~3 分钟。

## [Unreleased] — 2026-11-13

### 修复

- **标签页越开越多（根因）**：`/json/list` 返回的字段是 `id`，代码只读 `targetId`，
  拿到的一直是 `undefined`。于是 `attachPage` 认为「没有可用标签页」，每次调用都新建一个；
  `waitForChatPage` 也永远匹配不到已开的聊天页。现在 `listTargets` 统一补 `targetId`。
- 打招呼不再每个岗位新建 1~3 个标签页：整批共用同一个工作标签页，
  每次先回 `about:blank` 再进详情（绕过站点把复用页弹回首页的行为），收尾统一关闭。
- 新增 `reapTabs()`：开跑前/收尾时清掉残留的 `/job_detail/` 页和重复的 BOSS 首页，
  只留一个主标签页；跑过几十个岗位后窗口里不再堆十几个首页。
- `Page.close()` 顺带关掉自己那条 CDP 连接，避免长期运行时悬挂 WebSocket。

### 新增

- `tests/tab-reuse.mjs`：真机验证「一个标签页连跑 3 个详情 + 残留清理」，可当作回归脚本。

### 变更

- **招呼文案不再以对方姓名/称呼开头**：`checkMessage` 增加 `startsWithRecipientName` 校验，
  「刘先生您好」「王昊您好」「刘女士，您好」这类开头直接判不通过，`boss_greet` 会返回校验失败；
  模板本来就从「您好，我是…」起句，系统提示与 README 同步写明这条硬性限制。
  单测覆盖拦截与「您好，我是…」这类正常开头的不误伤。

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
