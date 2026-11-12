# dsh-boss-zhipin · BOSS直聘求职助手

[![test](https://github.com/Herbert-wang820/dsh-boss-zhipin/actions/workflows/test.yml/badge.svg)](https://github.com/Herbert-wang820/dsh-boss-zhipin/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个 [DeepSeek Harness](https://github.com/) Host 插件：用**浏览器扫码登录** BOSS直聘，检索职位 → 按简历匹配打分 → 对合适的岗位发送**结合简历与 JD 的自我介绍**。

适合"想批量但不想盲投"的场景：先把不相关、薪资明显不匹配、常驻海外的岗位筛掉，剩下的再逐条确认文案。

```
boss_preferences → boss_login → boss_resume → boss_search_jobs → boss_match_jobs → boss_greet
```

## 特性

- **不存账号密码**：拉起独立用户目录的 Chrome 窗口，你自己扫码/短信登录，登录态保存在本地，下次自动复用。
- **请求走真实页面**：所有站内接口都在已登录标签页里发出，自动带 `__zp_stoken__` 等风控参数（从 Node 直连会被判 `code 37 环境存在异常`）。
- **可解释的匹配**：本地打分（技能 45 + 方向 20 + 年限 15 + 学历 10 + JD 覆盖 10），输出命中项、缺口、风险。
- **一个可调门槛**：0~100 的数字，高则只要高度匹配，低则大概符合就进；打招呼前用同一门槛再拦一次。
- **发送有刹车**：默认 dry run、每日配额、最小间隔、同岗位去重、总开关 `allowSend`，批量遇到风控自动中止。
- **不发垃圾消息**：文案校验会拦掉占位符、链接和超长内容；低于门槛的岗位会被拦下。

## 安装

插件以 DSH bundle 的形式加载。把它放到任意目录，然后在 profile 的 `package.json` 里声明：

```json
{
  "dependencies": {
    "dsh-boss-zhipin": "link:/path/to/dsh-boss-zhipin"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-boss-zhipin"]
    }
  }
}
```

`link:` 依赖需要在该 profile 的 `node_modules/` 下有一个指向本目录的链接（pnpm 处理 `link:` 时会自动创建，也可以手动 `mklink /J`）。

要求：Node.js ≥ 22，本机装有 Chrome 或 Edge（路径可用 `browserPath` 指定）。

改完配置**重启 DSH**，工具才会出现在会话里。

## 快速开始

```
boss_preferences {action:"set", query:"运维", city:"广州", min_score:65}  # 方向 / 城市 / 匹配门槛
boss_status                        # 浏览器、登录态、简历、今日配额
boss_login                         # 弹出浏览器登录页，你自己扫码
boss_resume  {action:"set", file_path:"C:/path/resume.docx"}   # 或直接粘贴 text
boss_resume  {action:"import_from_boss"}                        # 或读 BOSS 在线资料
boss_search_jobs                   # 不传参数就用偏好里的方向和城市
boss_match_jobs                    # 只返回达到门槛的岗位，带命中/缺口/风险
boss_draft_intro {job_id:"..."}    # 起草（不发送）
boss_greet {job_id:"...", dry_run:true}    # 预览：发给谁、发什么、多少分
boss_greet {job_id:"...", dry_run:false}   # 确认后真发
```

## 工具

| 工具 | 作用 |
|---|---|
| `boss_preferences` | 查看/保存方向（`query`）、城市（`city`）、匹配门槛（`min_score`）。 |
| `boss_status` | 浏览器是否在跑、是否登录、简历摘要、今日配额。只读。 |
| `boss_login` | 打开登录页；`wait_seconds>0` 时阻塞等登录完成。 |
| `boss_browser` | 调试：`status` / `open` / `close` / `goto` / `screenshot` / `eval`。 |
| `boss_resume` | `get` / `set`（`text` 或 `.txt`/`.md`/`.docx`）/ `import_from_boss`。 |
| `boss_search_jobs` | 关键词 + 城市 + 筛选检索，返回 jobId、薪资、技能标签、HR、链接。 |
| `boss_job_detail` | 完整 JD、任职要求、地址、HR 活跃度、公司简介。 |
| `boss_match_jobs` | 简历打分排序，按门槛过滤，返回分数/等级/命中/缺口/风险。 |
| `boss_draft_intro` | 用模板起草一段介绍（不发送）。 |
| `boss_greet` | 单个岗位打招呼；默认 dry run，发送前校验匹配门槛、配额、间隔、去重。 |
| `boss_greet_batch` | 批量发送，按 `minIntervalMs` 限速，遇风控/未登录自动中止。 |
| `boss_history` | 打招呼历史（含完整文案与失败原因），用于去重与复盘。 |

## 匹配门槛（那个"可调指标"）

存偏好里，也能每次调用时用 `min_score` 覆盖：

| 门槛 | 含义 | 适合 |
|---|---|---|
| 80+ | 严格：只要高度匹配 | 岗位多、只投最对口的 |
| 65 | 偏严（默认） | 常规投递 |
| 55 | 标准 | 想多看几个 |
| 40 | 宽松：大致符合就进 | 转方向、先摸清市场 |
| 0 | 极宽松：全都捞出来 | 只看 JD、不打算投 |

> 分数只衡量"简历 vs JD 的文本重合度"，**不含薪资和职级**。一个 10 年经验的人投 10-12K 的岗位会拿到 100 分。
> 所以结果里额外给了 `overseas` 标记和「薪资上限和年限可能不匹配」的风险提示——分数用来排序和筛掉不相关的，不用来决定值不值得投。

## 配置

写在 profile 的 `cordis.patch.yml`（按 id 覆盖会替换整个 config，需要的键要一次写全）：

```yaml
- id: boss-zhipin
  config:
    city: 101210100          # 中文名或 BOSS 城市编码
    browserPath: "C:/Program Files/Google/Chrome/Application/chrome.exe"
    port: 9333
    dataDir: "C:/Users/you/.dsh/boss-zhipin"
    dailyGreetLimit: 30
    minIntervalMs: 20000
    maxPerRun: 5
    allowSend: true
```

| 键 | 默认 | 说明 |
|---|---|---|
| `city` | 北京 | 默认城市，支持 `杭州` 或 `101210100` |
| `browserPath` | 自动探测 | Chrome/Edge 路径 |
| `browserKind` | `auto` | 浏览器类型：`auto`/`chrome`/`edge`/`chromium` |
| `userDataDir` | `<dataDir>/browser-profile` | 专用浏览器资料目录（登录态） |
| `port` | 9333 | 调试端口 |
| `headless` | false | 有头模式更接近真人，建议保持 false |
| `dataDir` | `~/.dsh/boss-zhipin` | 简历/偏好/历史/截图 |
| `maxJobs` | 30 | 单次检索条数 |
| `dailyGreetLimit` | 30 | 每日发送上限 |
| `minIntervalMs` | 20000 | 两次发送的最小间隔 |
| `maxPerRun` | 5 | 单次批量上限 |
| `allowSend` | true | false 时禁止一切发送 |
| `loginWaitSeconds` | 180 | 登录等待上限 |
| `chatReadyTimeoutMs` | 25000 | 等聊天页就绪的上限 |
| `screenshotOnError` | true | 失败时截图到 `dataDir/screenshots` |

## 数据与隐私

`dataDir` 下只有插件自己的文件：`resume.json`、`prefs.json`、`history.json`、`jobs-cache.json`、
`browser-profile/`（登录态，等同你的 cookie，注意保护）、`screenshots/`。

- 不保存账号密码，不经过任何中间服务器；
- 所有请求由你本机的浏览器发出；
- 简历、历史、登录态都只在本地，插件代码不联网上报。

## 已知限制

- **风控**：BOSS 会检测自动化。插件已避开 `Runtime.enable`（实测会触发 DevTools 检测，页面被清成 `about:blank`），检索前先落到搜索页（否则接口返回 `code 37`），详情接口做退避重试。即便如此，短时间高频操作仍可能触发验证码——在浏览器窗口里手动过一次即可。
- **站点会先发它自己的招呼语**：点「立即沟通」时 BOSS 自动发送"您好，可以和您聊聊吗？"，我们的介绍紧随其后。介意的话可以在 BOSS 设置里改默认招呼语。
- **首次联系要两次点击**：给陌生 HR 点「立即沟通」只建会话不跳转，插件会自动重开详情页再点一次，不需要你干预（但会多花约 10 秒）。
- **聊天靠 DOM 驱动**：消息走 WebSocket，插件不逆向协议，而是驱动真实页面发送，所以浏览器窗口不能被系统挂起。
- **页面结构会变**：输入框/发送按钮用多组候选选择器兜底，站点大改后可能需要更新 `lib/zhipin.js` 的 `sendChatMessage`。
- **薪资字段可能为空**：未登录时部分岗位不返回 `salaryDesc`。

## 排障

| 现象 | 处理 |
|---|---|
| `code 37 环境存在异常` | 先完成登录；在浏览器里手动搜一次；等几十秒再试 |
| 页面变 `about:blank` | 站点检测到调试器；确认版本未启用 `Runtime` 域 |
| 启动浏览器报 `EPERM`/被拦截 | 手动双击 Chrome 打开同一 `userDataDir`，再调 `boss_status` |
| 端口被占用 | 改 `port`，或 `boss_browser {action:"close"}` 关掉旧实例 |
| `code 17 缺少必要参数` | 详情需要 `securityId`：先 `boss_search_jobs`（会缓存）或显式传 `security_id` |
| 打招呼返回"没有进入聊天页" | 看 `dataDir/screenshots/` 的截图；多数是页面弹了验证码或登录框 |
| 改了代码不生效 | Host 插件不支持热加载，必须重启 DSH |

## 开发

```bash
node tests/run.mjs          # 单元测试（配置/存储/简历/打分/文案/工具定义），不联网
node tests/load.mjs         # 用假 ctx 模拟宿主，验证 apply() 注册 12 个工具
node tests/live.mjs 9333 运维 101280100   # 联调：需浏览器已登录，跑真实检索/详情/匹配/起草
```

目录：

```
lib/config.js    配置解析、城市表、经验码表、浏览器探测
lib/store.js     本地 JSON 存储（原子写 + 串行化）
lib/cdp.js       最小 CDP 客户端（只用 Page 域）
lib/browser.js   启动/复用浏览器、登录探测、风控识别、截图
lib/zhipin.js    站点操作：检索、详情、沟通、发消息
lib/resume.js    简历解析、技能与年限抽取
lib/match.js     匹配打分与风险提示
lib/intro.js     文案草稿与发送前校验
lib/tools.js     12 个工具的定义与实现
lib/index.js     插件入口
docs/ARCHITECTURE.md   架构与关键实现决策
docs/RETROSPECTIVE.md  开发复盘：踩过的坑与实测结论
```

## 免责声明

本项目仅用于个人求职效率工具，请遵守 BOSS直聘 的用户协议与当地法律法规：

- 不要用于批量骚扰、群发广告或任何商业用途；
- 发送频率请保持在人类合理范围（默认 20 秒/条、30 条/天）；
- 因使用本工具导致的账号风险（限流、验证、封禁）由使用者自行承担。

## License

[MIT](LICENSE)
