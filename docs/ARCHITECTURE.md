# 架构说明

## 分层

```
index.js      插件入口：注册工具 + 注入系统提示
tools.js      12 个工具的定义与实现（参数校验、配额/门槛/去重、输出裁剪）
  ├─ config.js   配置解析、城市表、经验码表、浏览器探测
  ├─ store.js    本地 JSON 存储（原子写 + 串行化），数据目录默认 ~/.dsh/boss-zhipin
  ├─ resume.js   简历解析（文本 / .txt / .md / .docx）、技能与年限抽取
  ├─ match.js    匹配打分与风险提示
  ├─ intro.js    介绍文案生成与发送前校验
  ├─ zhipin.js   站点操作：检索、详情、沟通、发消息（DOM 驱动）
  ├─ browser.js  启动/复用 Chrome、登录探测、风控识别、截图
  └─ cdp.js      最小 CDP 客户端（WebSocket + Page 域）
```

依赖方向是单向的：`tools` 依赖其余模块，其余模块之间不互相依赖（`match`/`intro` 是纯函数，可直接单测）。

## 为什么不用 Playwright / Puppeteer

- 只想连一个**用户自己看得见**的浏览器窗口，不想再带一份 Chromium 内核；
- 需要精确控制"只启用 `Page` 域"这件事（见下），高层库默认会开一堆域；
- 依赖越少，插件越不容易因为宿主环境变化而装不上。

`lib/cdp.js` 因此是一个手写的极简 CDP 客户端：WebSocket 连接 + 消息分发 + 几个常用动作
（`navigate` / `evaluate` / `waitFor` / `clickElement` / `typeText` / `pressKey` / `screenshot`）。

## 为什么所有站内请求都在页面里发

BOSS 的接口会校验页面上下文（`__zp_stoken__`、referer 等）。从 Node 直连会稳定得到
`code 37 您的环境存在异常`。所以：

```
page.navigate('https://www.zhipin.com/web/geek/jobs?...')
page.evaluate(`fetch('/wapi/...', { credentials: 'include', ... })`)
```

请求、cookie、风控参数都由浏览器负责，插件只负责解析返回的 JSON。

## 风控相关的三个硬约束

1. **不启用 `Runtime` 域**：实测会触发站点的 DevTools 检测，页面 1 秒后被清成 `about:blank`。
2. **不复用标签页跳详情**：老标签页会被重定向到首页，必须每次新开、用完即关。
3. **必须带 `securityId`**：详情页 URL 缺这个参数时页面能渲染，但「立即沟通」点击无效。

## 发送流程

```
boss_greet
  ├─ 前置校验：登录态 → 匹配门槛 → allowSend → 每日配额 → 最小间隔 → 同岗位去重
  ├─ 打开详情（新标签页，带 securityId）
  ├─ 点「立即沟通」→ 等 8 秒
  │    └─ 没跳转（首次联系）：重开详情页再点一次（此时是「继续沟通」）
  ├─ 等聊天页就绪（当前标签页跳转，或新开的聊天标签页）
  ├─ 写入文案 → 等 `button.btn-send` 去掉 disabled → 点发送
  ├─ 校验：输入框已清空 + 聊天区出现文案；否则补一次回车
  └─ 关标签页 → 记历史（成功/失败都记，失败带原因和截图）
```

任何一步失败都会返回 `ok:false` + 原因，并在 `dataDir/screenshots/` 留截图。

## 数据文件

| 文件 | 内容 |
|---|---|
| `resume.json` | 解析后的简历（原文 + 技能 + 年限 + 学历 + 亮点） |
| `prefs.json` | 方向、城市、匹配门槛 |
| `history.json` | 打招呼记录（含完整文案、状态、失败原因） |
| `jobs-cache.json` | `jobId → {jobName, salary, securityId, lid, url, skills, labels, hrOnline…}` |
| `browser-profile/` | 专用 Chrome 用户目录（登录态，等同于 cookie，注意保护） |
| `screenshots/` | 失败截图 |

全部为插件自己读写的本地文件，不涉及任何服务端。

## 打分算法

| 维度 | 权重 | 说明 |
|---|---|---|
| 技能覆盖 | 45 | 简历技能 ∩ 岗位技能（含标签，过滤掉年限/学历/福利词） |
| 岗位方向 | 20 | 职位名称与简历求职意向/方向词的匹配 |
| 年限 | 15 | 岗位要求区间与简历年限 |
| 学历 | 10 | 学历门槛 |
| JD 覆盖 | 10 | 简历技能在 JD 正文中的覆盖 |

分数阈值：`≥75 强匹配` / `≥60 可投递` / `≥45 一般` / 其余不建议。

**注意**：分数只反映文本重合度，不含薪资与职级。为此额外输出 `overseas` 标记和薪资倒挂提示，
避免出现"100 分但只有 12K"这类误判。
