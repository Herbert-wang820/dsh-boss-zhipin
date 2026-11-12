/**
 * dsh-boss-zhipin — BOSS直聘求职助手。
 *
 * 注册 12 个工具（偏好/状态/登录/浏览器/简历/搜索/详情/匹配/起草/打招呼/批量/历史），
 * 并在系统提示里补一段使用说明，避免模型在没登录时反复试错。
 *
 * 设计上和 dsh-sdp-api 保持同样的形态：只依赖宿主注入的 ctx，不 import 任何
 * @deepseek-ai/* 运行时包，避免插件加载期因为宿主内部模块解析失败而整行挂掉。
 */
import { resolveConfig } from './config.js';
import { Store } from './store.js';
import { buildTools } from './tools.js';

export const name = 'dsh-boss-zhipin';
export const inject = ['tools'];

const GUIDANCE = `BOSS直聘求职助手已就绪（boss_preferences / boss_status / boss_login / boss_browser / boss_resume / boss_search_jobs / boss_job_detail / boss_match_jobs / boss_draft_intro / boss_greet / boss_greet_batch / boss_history）。

标准流程：
1. boss_preferences 先确认方向和城市（用户没说就用上次保存的）；用户想调整时用 set 改 query/city/min_score。
2. boss_status 看浏览器与登录态；没登录就 boss_login（会弹出独立浏览器窗口，让用户自己扫码/短信登录，登录态保存在插件的 browser-profile 目录）。
3. boss_resume set 保存简历（粘贴 text，或给 .txt/.md/.docx 的 file_path），也可以用 import_from_boss 直接读在线资料；解析结果里的技能/年限/亮点会用于匹配。
4. boss_search_jobs 用关键词+城市检索，拿 jobId；必要时 boss_job_detail 看完整 JD。
5. boss_match_jobs 按简历打分排序（不传 query/city 就用偏好），只看达到 min_score 门槛的岗位。门槛是用户可调的指标：80+ 只要高度匹配，65 偏严，55 标准，40 宽松（大致符合就进）。用户说「放宽一点/严一点」时改这个数，不要自己另设标准。
6. boss_draft_intro 起草，或由你基于 match 给出的命中技能/亮点改写一段 100~180 字的第一人称介绍；不要编造简历里没有的经历或数字。
7. boss_greet 先 dry_run（默认）核对「发给谁、发什么、匹配多少分」，得到用户确认后再传 dry_run:false；批量用 boss_greet_batch，它按 minIntervalMs 限速，遇到风控或未登录会自动中止。

约束与注意：
- boss_greet 会检查匹配门槛，低于门槛会直接拦下；确实要发时传 ignore_threshold:true，不要绕过用户意图。
- 发送有每日配额（dailyGreetLimit）、最小间隔（minIntervalMs）和去重（同一 jobId 不重复打）；配置 allowSend:false 时所有发送会被拒绝。连发多条时如果收到「至少间隔 N 秒」，等够时间再调一次。
- 打招呼会点击「立即沟通」并进入聊天页发消息；BOSS 可能先自动发一句系统默认招呼语，我们的介绍紧随其后，属正常现象。
- 给没聊过的 HR 首次点「立即沟通」时站点不会跳聊天页，插件会自动重开详情页再点一次，耗时约 10 秒，不要因此认为失败。
- 匹配分数只反映「简历文本 vs JD 文本」的重合度，不含薪资与职级：高分不等于值得投。向用户汇报时要把薪资、district、risks（尤其是 overseas 和「薪资上限」提示）一起说清楚，别只念分数。
- 页面出现验证码/「环境存在异常」时不要硬试：提示用户在浏览器窗口里手动处理，再重试。
- 不要为了凑数量群发：只联系与简历真实匹配的岗位，文案里不要带链接、不要编造简历里没有的经历或数字。`;

function report(ctx, message, level = 'info') {
  const logger = ctx?.logger;
  const sink = logger ? Reflect.get(logger, level) : undefined;
  if (typeof sink === 'function') sink.call(logger, message);
  else if (level === 'error') console.error(message);
  else if (level === 'warn') console.warn(message);
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rawConfig
 */
export function apply(ctx, rawConfig) {
  const { config, problems } = resolveConfig(rawConfig);
  for (const problem of problems) report(ctx, `dsh-boss-zhipin: ${problem}`, 'warn');

  const store = new Store(config.dataDir);
  try {
    store.ensureDirs();
  } catch (error) {
    report(ctx, `dsh-boss-zhipin: 无法创建数据目录 ${config.dataDir}：${error?.message ?? error}`, 'error');
  }

  ctx.effect(() => {
    const disposers = [];
    for (const tool of buildTools(config, store)) {
      try {
        const dispose = ctx.tools.register(tool);
        if (typeof dispose === 'function') disposers.push(dispose);
      } catch (error) {
        report(ctx, `dsh-boss-zhipin: 注册 ${tool.name} 失败：${error?.message ?? error}`, 'error');
      }
    }
    report(ctx, `dsh-boss-zhipin: 已注册 ${disposers.length} 个工具（数据目录 ${config.dataDir}）`, 'info');
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch (error) {
          report(ctx, `dsh-boss-zhipin: 注销工具失败：${error?.message ?? error}`, 'warn');
        }
      }
    };
  }, 'dsh-boss-zhipin: tools');

  try {
    ctx.inject(['systemPrompt'], (inner) => {
      inner.effect(
        () =>
          inner.systemPrompt.section({
            name: 'dsh-boss-zhipin:usage',
            order: 3350,
            interpolate: false,
            text: GUIDANCE,
          }),
        'dsh-boss-zhipin: guidance',
      );
    });
  } catch (error) {
    report(ctx, `dsh-boss-zhipin: 使用说明注入失败（不影响工具）：${error?.message ?? error}`, 'warn');
  }
}
