/**
 * 暴露给模型的工具。
 *
 * 设计原则：
 *  - 读操作（status/search/detail/match/draft）可以直接调用；
 *  - 写操作（greet/greet_batch）默认 dry_run = true，只返回「打算发什么、发给谁」，
 *    必须显式 dry_run:false 才真的发出去；另外还有 allowSend 总开关和每日配额。
 */
import path from 'node:path';

import { CITIES, cityLabel, resolveCity } from './config.js';
import {
  closeBrowser,
  detectRiskControl,
  ensurePage,
  getCookies,
  launchBrowser,
  LOGIN_URL,
  probeLogin,
  saveScreenshot,
  waitForLogin,
} from './browser.js';
import { attachPage, probeVersion } from './cdp.js';
import { checkMessage, draftIntro } from './intro.js';
import { rankJobs, scoreJob } from './match.js';
import { buildResume, readResumeFile, summarizeResume } from './resume.js';
import { jobDetail, searchJobs, greetJob, jobDetailUrl } from './zhipin.js';

export const OUTPUT_SCHEMA = { type: 'object' };

/** 版本与构建标记：boss_status 会回显，用来确认宿主加载的是哪一版代码。 */
export const PLUGIN_VERSION = '0.1.0';
export const BUILD = '2026-11-12.1';

function render(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

function toolError(message) {
  return { ok: false, error: message };
}

function compactJob(job, extra = {}) {
  return {
    jobId: job.jobId,
    jobName: job.jobName,
    company: job.company,
    salary: job.salary,
    city: job.city,
    district: job.district,
    experience: job.experience,
    degree: job.degree,
    skills: job.skills,
    hr: job.hrName ? `${job.hrName}${job.hrTitle ? `·${job.hrTitle}` : ''}` : '',
    hrOnline: job.hrOnline,
    url: job.url,
    ...extra,
  };
}

function requireResume(store) {
  return store.getResume().then((resume) => {
    if (!resume) throw new Error('还没有保存简历：先调用 boss_resume（action:"set"，传 text 或 file_path）');
    return resume;
  });
}

/**
 * 解析职位详情/打招呼所需的 securityId 与 lid：
 * 显式传入优先，否则从搜索缓存里补（详情接口没有 securityId 会返回 code 17）。
 */
async function resolveJobParams(store, jobId, args = {}, fallback = {}) {
  const cached = await store.getJob(jobId).catch(() => null);
  return {
    securityId: args.security_id ? String(args.security_id) : cached?.securityId ?? fallback.securityId ?? '',
    lid: args.lid ? String(args.lid) : cached?.lid ?? fallback.lid ?? '',
  };
}

/**
 * 合并检索结果与详情：详情接口不返回 city/district/degree 等列表字段（值为空），
 * 直接展开会把列表里的有效值覆盖掉，所以只覆盖「有内容」的字段。
 */
function mergeJob(base, detail) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(detail ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    // 详情里的 hrOnline 是 Boolean(bossOnline) 兜出来的 false，检索结果的 true 更准，别降级
    if (key === 'hrOnline' && value === false && base?.hrOnline === true) continue;
    merged[key] = value;
  }
  if (!merged.jobName) merged.jobName = detail?.jobName ?? base?.jobName ?? '';
  return merged;
}

async function withPage(config, fn, { navigateTo } = {}) {
  const page = await ensurePage(config, { navigateTo });
  try {
    const login = await probeLogin(page);
    if (!login.loggedIn) {
      throw new Error(
        `BOSS直聘未登录（接口返回 code=${login.code ?? '?'}，${login.message || '无消息'}）。请先调用 boss_login 打开浏览器完成登录。`,
      );
    }
    return await fn(page);
  } finally {
    // 页面留在浏览器里，不主动关：用户可能要接着手动操作。
  }
}

// ------------------------------------------------------------------ 工具实现

async function runStatus({ config, store }, args) {
  const resume = await store.getResume();
  const session = await store.getSession();
  const todayCount = await store.countToday();
  const result = {
    ok: true,
    plugin: { name: 'dsh-boss-zhipin', version: PLUGIN_VERSION, build: BUILD },
    browser: {
      running: false,
      port: config.port,
      path: config.browserPath ?? null,
      profileDir: config.userDataDir,
    },
    login: { loggedIn: false },
    resume: summarizeResume(resume, { maxChars: 200 }),
    quota: {
      sentToday: todayCount,
      dailyLimit: config.dailyGreetLimit,
      remaining: Math.max(0, config.dailyGreetLimit - todayCount),
      minIntervalMs: config.minIntervalMs,
      allowSend: config.allowSend,
    },
    dataDir: config.dataDir,
    lastSession: session ? { at: session.updatedAt, loginUrl: session.loginUrl } : null,
  };

  try {
    // 只探测端口，不主动拉起浏览器：status 是只读动作，弹窗留给 boss_login。
    const version = await probeVersion(config.port, 1200);
    if (!version) {
      result.browser.error = `调试端口 ${config.port} 没有浏览器在运行；需要时调用 boss_login 打开。`;
      return result;
    }
    result.browser.running = true;
    result.browser.browser = version.Browser;

    const page = await attachPage({ port: config.port, preferredUrlIncludes: 'zhipin.com' });
    const current = await page.url().catch(() => '');
    if (!current.includes('zhipin.com')) await page.navigate('https://www.zhipin.com/');
    const login = await probeLogin(page);
    result.login = { loggedIn: login.loggedIn, code: login.code, message: login.message };
    if (login.loggedIn) {
      const cookies = await getCookies(page);
      result.login.cookieCount = cookies.length;
      await store.setSession({ loggedIn: true, loginUrl: await page.url(), cookies: cookies.length });
    }
    if (args?.detail) {
      result.page = { url: await page.url(), title: await page.title() };
    }
  } catch (error) {
    result.browser.error = String(error?.message ?? error);
  }
  return result;
}

async function runLogin({ config, store }, args) {
  const waitSeconds = Number(args?.wait_seconds ?? 0);
  await launchBrowser(config, LOGIN_URL);
  const page = await ensurePage(config, { navigateTo: LOGIN_URL });

  if (waitSeconds <= 0) {
    const login = await probeLogin(page);
    return {
      ok: true,
      launched: true,
      loggedIn: login.loggedIn,
      message: login.loggedIn
        ? '已登录，可以直接检索职位。'
        : `已打开浏览器登录页（${LOGIN_URL}）。请在浏览器窗口里扫码或手机号登录，完成后调用 boss_status 或再次调用 boss_login（wait_seconds: 120）确认。`,
    };
  }

  const result = await waitForLogin(config, { waitSeconds: Math.min(waitSeconds, 600), page });
  if (result.loggedIn) {
    await store.setSession({ loggedIn: true, loginUrl: LOGIN_URL, cookies: result.cookies ?? 0 });
    return { ok: true, loggedIn: true, waitedSeconds: waitSeconds, cookies: result.cookies ?? 0, message: '登录成功，登录态已保存在专用浏览器目录里，下次不用重复登录。' };
  }
  return {
    ok: false,
    loggedIn: false,
    waitedSeconds: waitSeconds,
    error: `等待 ${waitSeconds} 秒仍未检测到登录（code=${result.code ?? '?'}）。浏览器窗口没有关的话，手动登录后重试 boss_status 即可。`,
  };
}

async function runBrowser({ config, store }, args) {
  const action = String(args?.action ?? 'status');
  if (action === 'close') {
    const result = await closeBrowser(config);
    return { ok: true, action, ...result };
  }
  if (action === 'open') {
    const result = await launchBrowser(config, args?.url || LOGIN_URL);
    return { ok: true, action, ...result };
  }
  const page = await ensurePage(config, { navigateTo: args?.url });
  if (action === 'status') {
    return { ok: true, action, url: await page.url(), title: await page.title(), browser: { port: config.port, running: true } };
  }
  if (action === 'screenshot') {
    const file = await saveScreenshot(page, store, 'manual');
    return { ok: true, action, file };
  }
  if (action === 'goto') {
    if (!args?.url) return toolError('goto 需要 url 参数');
    await page.navigate(String(args.url));
    return { ok: true, action, url: await page.url(), title: await page.title() };
  }
  if (action === 'eval') {
    if (!args?.expression) return toolError('eval 需要 expression 参数');
    const value = await page.evaluate(String(args.expression));
    return { ok: true, action, value };
  }
  return toolError(`不支持的 action：${action}`);
}

async function runResume({ config, store }, args) {
  const action = String(args?.action ?? 'get');
  if (action === 'get') {
    const resume = await store.getResume();
    if (!resume) return { ok: true, exists: false, message: '还没有简历，用 action:"set" 保存一份。' };
    return { ok: true, exists: true, resume: summarizeResume(resume) };
  }

  if (action === 'set') {
    let source;
    if (args?.file_path) {
      source = await readResumeFile(String(args.file_path));
    } else if (args?.text) {
      source = { text: String(args.text), source: 'text', kind: 'text' };
    } else {
      return toolError('set 需要 text 或 file_path');
    }
    const resume = buildResume(source);
    if (args?.name) resume.name = String(args.name);
    const saved = await store.setResume(resume);
    return {
      ok: true,
      saved: true,
      summary: summarizeResume(saved),
      message: `简历已保存到 ${path.join(config.dataDir, 'resume.json')}（${saved.chars} 字，识别到 ${saved.skills.length} 项技能）。`,
    };
  }

  if (action === 'import_from_boss') {
    return withPage(config, async (page) => {
      const payload = await page.evaluate(`(async () => {
        const call = async (url) => {
          try {
            const r = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
            const json = await r.json();
            return { code: json.code, data: json.zpData ?? null };
          } catch (error) { return { code: -1, data: null, message: String(error && error.message || error) }; }
        };
        return {
          baseinfo: await call('/wapi/zpgeek/resume/baseinfo/query.json'),
          userdesc: await call('/wapi/zpgeek/resume/userdesc/query.json'),
        };
      })()`);

      // 站点只开放基础信息和个人优势两个分块（工作经历/技能分块接口需要额外参数），
      // 所以这里按「基础信息 + 个人优势全文」拼成简历文本，而不是盲扫整棵 JSON。
      const base = payload?.baseinfo?.data ?? {};
      const desc = payload?.userdesc?.data ?? {};
      const advantage = String(desc.advantage ?? '').trim();
      if (!base.name && !advantage) {
        return toolError(
          `没能从 BOSS 在线资料里读到内容（baseinfo code=${payload?.baseinfo?.code ?? '?'}，userdesc code=${payload?.userdesc?.code ?? '?'}）。` +
            '确认已登录后重试，或改用 boss_resume {action:"set", text/file_path}。',
        );
      }

      const metaLine = [base.degreeCategory, base.workYearDesc || (base.workYears ? `${base.workYears}年经验` : ''), base.age]
        .filter(Boolean)
        .join(' · ');
      const text = [base.name, metaLine, advantage ? `个人优势\n${advantage}` : ''].filter(Boolean).join('\n');
      const resume = buildResume({ text, source: 'boss-profile', kind: 'boss' });
      if (base.name) resume.name = String(base.name);
      if (base.degreeCategory) resume.degree = String(base.degreeCategory);
      if (Number(base.workYears)) resume.years = Number(base.workYears);
      const saved = await store.setResume(resume);
      return {
        ok: true,
        saved: true,
        summary: summarizeResume(saved),
        message: '已从 BOSS 在线资料导入（基础信息 + 个人优势）。工作经历/技能标签站点没有开放接口，建议用 boss_resume {action:"set", file_path} 补一份完整简历。',
      };
    });
  }

  return toolError(`不支持的 action：${action}`);
}

async function runSearch({ config, store }, args) {
  const prefs = await store.getPrefs();
  const query = String(args?.query ?? prefs.query ?? '').trim();
  if (!query) {
    return toolError('query 不能为空，例如 "前端工程师"；也可以先用 boss_preferences 保存方向和城市');
  }
  const city = resolveCity(args?.city ?? prefs.city ?? config.city, config.city);
  const pageSize = Math.min(Number(args?.page_size ?? config.maxJobs) || config.maxJobs, 100);
  const pageNo = Number(args?.page ?? 1) || 1;

  return withPage(config, async (page) => {
    const result = await searchJobs(page, { query, city, pageNo, pageSize, filters: args?.filters ?? {} });
    const jobs = result.jobs.slice(0, pageSize);
    // 缓存 securityId/lid：详情接口和打招呼页面都要用，模型通常只记得 jobId
    await store.rememberJobs(jobs);
    await store.setSettings({ lastSearch: { query, city, at: new Date().toISOString(), count: jobs.length } });
    await store.setPrefs({ query, city });
    return {
      ok: true,
      query,
      city: { code: city, name: cityLabel(city) },
      page: pageNo,
      total: result.total,
      hasMore: result.hasMore,
      via: result.via,
      warning: result.warning,
      jobs: jobs.map((job) => compactJob(job)),
      hint: '下一步：boss_match_jobs（传 job_ids）按简历排序，再 boss_draft_intro 生成介绍。',
    };
  });
}

async function runDetail({ config, store }, args) {
  const jobId = String(args?.job_id ?? '').trim();
  if (!jobId) return toolError('job_id 不能为空（来自 boss_search_jobs 的 jobId）');
  const params = await resolveJobParams(store, jobId, args ?? {});
  if (!params.securityId) {
    return toolError(`缺少 securityId：先 boss_search_jobs 检索到这个职位（插件会缓存 securityId），或用 security_id 参数显式传入`);
  }
  return withPage(config, async (page) => {
    const job = await jobDetail(page, { encryptJobId: jobId, securityId: params.securityId });
    if (params.securityId) job.securityId = params.securityId;
    if (params.lid) job.lid = params.lid;
    await store.rememberJobs([job]);
    return {
      ok: true,
      job: {
        ...compactJob(job),
        description: job.description,
        requirement: job.requirement,
        address: job.address,
        hrActive: job.hrActive,
        companyIntro: job.companyIntro,
        companySize: job.companySize || job.scale,
      },
    };
  });
}

async function runMatch({ config, store }, args) {
  const resume = await requireResume(store);
  const prefs = await store.getPrefs();
  // 门槛优先级：显式参数 > 已保存偏好 > 默认 60
  const minScore = Number.isFinite(Number(args?.min_score)) ? Number(args.min_score) : prefs.minScore;
  const includeDetails = Boolean(args?.include_details);

  const jobs = [];
  if (Array.isArray(args?.job_ids) && args.job_ids.length) {
    for (const jobId of args.job_ids.slice(0, 30)) {
      // 先用检索时的缓存打底（含技能标签），只用 jobId 也能得到和检索路径一致的分数
      const cached = await store.getJob(jobId).catch(() => null);
      jobs.push({
        jobId: String(jobId),
        jobName: cached?.jobName ?? '',
        company: cached?.company ?? '',
        salary: cached?.salary ?? '',
        city: cached?.city ?? '',
        district: cached?.district ?? '',
        experience: cached?.experience ?? '',
        degree: cached?.degree ?? '',
        skills: Array.isArray(cached?.skills) ? cached.skills : [],
        labels: Array.isArray(cached?.labels) ? cached.labels : [],
        hrOnline: Boolean(cached?.hrOnline),
        description: '',
      });
    }
    await withPage(config, async (page) => {
      for (const job of jobs) {
        try {
          const params = await resolveJobParams(store, job.jobId, args ?? {});
          const detail = await jobDetail(page, { encryptJobId: job.jobId, securityId: params.securityId });
          Object.assign(job, mergeJob(job, detail));
          if (params.lid) job.lid = params.lid;
        } catch (error) {
          job.error = String(error?.message ?? error);
        }
      }
    });
  } else if (args?.query || prefs.query) {
    const query = String(args?.query ?? prefs.query);
    const city = resolveCity(args?.city ?? prefs.city ?? config.city, config.city);
    const pageSize = Math.min(Number(args?.page_size ?? config.maxJobs) || config.maxJobs, 50);
    await withPage(config, async (page) => {
      const result = await searchJobs(page, { query, city, pageNo: 1, pageSize, filters: args?.filters ?? {} });
      await store.rememberJobs(result.jobs);
      for (const job of result.jobs) {
        try {
          const detail = await jobDetail(page, { encryptJobId: job.jobId, securityId: job.securityId });
          jobs.push(mergeJob(job, detail));
        } catch {
          jobs.push(job);
        }
      }
    });
    await store.setPrefs({ query, city });
  } else {
    return toolError('需要 job_ids（来自 boss_search_jobs）或 query（直接搜索并分析）；也可以用 boss_preferences 先设好城市和方向');
  }

  const usable = jobs.filter((job) => !job.error && job.jobName);
  const ranked = rankJobs(resume, usable, { minScore });
  const failed = jobs.filter((job) => job.error).map((job) => ({ jobId: job.jobId, error: job.error }));

  return {
    ok: true,
    resume: { name: resume.name, skills: resume.skills, years: resume.years, degree: resume.degree },
    threshold: minScore,
    thresholdLabel: thresholdLabel(minScore),
    analyzed: usable.length,
    aboveThreshold: ranked.length,
    failed: failed.length ? failed : undefined,
    results: ranked.map((item) => ({
      ...compactJob(item.job),
      score: item.score,
      grade: item.grade,
      overseas: item.overseas,
      matched: item.matched,
      missing: item.missing,
      reasons: item.reasons,
      risks: item.risks,
      ...(includeDetails ? { details: item.details } : {}),
    })),
    hint:
      ranked.length === 0
        ? `没有岗位达到 ${minScore} 分门槛（本次分析 ${usable.length} 个）。把门槛调低（boss_preferences 设 min_score）或换个方向再看。`
        : '对结果里的岗位用 boss_draft_intro 生成介绍，核对后 boss_greet（默认 dry run）。',
  };
}

async function runPreferences({ store }, args) {
  const action = String(args?.action ?? 'get').toLowerCase();
  if (action === 'set') {
    const patch = {};
    if (args?.city !== undefined) {
      const raw = String(args.city).trim();
      if (!raw) return toolError('city 不能是空字符串');
      const code = resolveCity(raw, '');
      if (!code) return toolError(`没认出城市「${raw}」，试试「广州」或城市编码 101280100`);
      patch.city = code;
    }
    if (args?.query !== undefined) patch.query = String(args.query).trim();
    if (args?.min_score !== undefined) {
      const value = Number(args.min_score);
      if (!Number.isFinite(value) || value < 0 || value > 100) return toolError('min_score 需要 0~100 的数字');
      patch.minScore = value;
    }
    if (!Object.keys(patch).length) return toolError('没有要改的项：可以传 query（方向）、city（城市）、min_score（匹配门槛 0~100）');
    const prefs = await store.setPrefs(patch);
    return {
      ok: true,
      saved: true,
      preferences: describePrefs(prefs),
      hint: `已保存。之后 boss_search_jobs / boss_match_jobs 不传参数也会用这套偏好（门槛 ${prefs.minScore}：${thresholdLabel(prefs.minScore)}）。`,
    };
  }
  const prefs = await store.getPrefs();
  return {
    ok: true,
    preferences: describePrefs(prefs),
    hint: '调整：boss_preferences {action:"set", query:"运维", city:"广州", min_score:70}；门槛越高越严、越低越宽松。',
  };
}

function describePrefs(prefs) {
  return {
    query: prefs.query || null,
    city: prefs.city || null,
    cityName: prefs.city ? cityLabel(prefs.city) : null,
    minScore: prefs.minScore,
    thresholdLabel: thresholdLabel(prefs.minScore),
    updatedAt: prefs.updatedAt,
  };
}

/** 把 0~100 的打分翻译成人能懂的三档描述，方便模型和用户对话。 */
function thresholdLabel(score) {
  if (score >= 80) return '严格（只要高度匹配）';
  if (score >= 65) return '偏严（推荐）';
  if (score >= 55) return '标准';
  if (score >= 40) return '宽松（大致符合就进）';
  return '极宽松（先都捞出来）';
}

async function runDraftIntro({ config, store }, args) {
  const jobId = String(args?.job_id ?? '').trim();
  if (!jobId) return toolError('job_id 不能为空');
  const resume = await requireResume(store);
  const params = await resolveJobParams(store, jobId, args ?? {});
  if (!params.securityId) {
    return toolError('缺少 securityId：先在 boss_search_jobs 里检索过这个职位，或显式传 security_id');
  }
  return withPage(config, async (page) => {
    const job = await jobDetail(page, { encryptJobId: jobId, securityId: params.securityId });
    if (params.securityId) job.securityId = params.securityId;
    if (params.lid) job.lid = params.lid;
    const message = draftIntro(resume, job, { extra: args?.extra ? String(args.extra) : undefined });
    const check = checkMessage(message);
    return {
      ok: true,
      job: compactJob(job),
      message,
      check,
      matched: (job.skills ?? []).filter((skill) => (resume.skills ?? []).includes(skill)),
      hint: '可以把这段改成更贴岗位的版本，再传给 boss_greet（默认 dry_run，不会真的发）。',
    };
  });
}

/**
 * 发送前的公共校验：总开关、重复、配额、间隔。
 */
async function preflight(config, store, jobId) {
  const problems = [];
  if (!config.allowSend) problems.push('插件配置 allowSend=false，已禁止发送');
  const greeted = await store.findGreeted(jobId);
  if (greeted) problems.push(`这个岗位已经打过招呼（${greeted.at}），不重复发送`);
  const todayCount = await store.countToday();
  if (todayCount >= config.dailyGreetLimit) problems.push(`今天已发 ${todayCount} 条，达到上限 ${config.dailyGreetLimit}`);
  const last = await store.lastSentAt();
  const waitMs = last ? config.minIntervalMs - (Date.now() - last) : 0;
  if (waitMs > 0) problems.push(`距离上一条只过了 ${Math.round((Date.now() - last) / 1000)} 秒，至少间隔 ${Math.round(config.minIntervalMs / 1000)} 秒`);
  return { problems, todayCount, waitMs };
}

async function runGreet({ config, store }, args) {
  const jobId = String(args?.job_id ?? '').trim();
  if (!jobId) return toolError('job_id 不能为空（来自 boss_search_jobs / boss_match_jobs）');
  const dryRun = args?.dry_run !== false;
  const resume = await store.getResume();

  const pre = await preflight(config, store, jobId);
  let message = args?.message ? String(args.message) : '';
  let job = null;
  let draftCheck = null;

  const page = await ensurePage(config, { navigateTo: 'https://www.zhipin.com/' });
  const login = await probeLogin(page);
  if (!login.loggedIn) {
    return { ok: false, error: `未登录（code=${login.code ?? '?'}）：先 boss_login`, jobId };
  }

  const params = await resolveJobParams(store, jobId, args ?? {});
  if (!params.securityId) {
    return { ok: false, jobId, error: '缺少 securityId：先在 boss_search_jobs 里检索过这个职位，或显式传 security_id' };
  }
  job = await jobDetail(page, { encryptJobId: jobId, securityId: params.securityId });
  // 详情接口不一定回 jobId，这里以入参为准，greetJob 拼详情页链接要用
  job.jobId = jobId;
  job.encryptJobId = jobId;
  if (params.securityId) job.securityId = params.securityId;
  if (params.lid) job.lid = params.lid;
  await store.rememberJobs([job]);

  if (!message) {
    if (!resume) return toolError('没有传 message，也没有保存简历；先 boss_resume 保存简历再让插件起草');
    message = draftIntro(resume, job, { extra: args?.extra ? String(args.extra) : undefined });
    draftCheck = checkMessage(message);
  }
  const check = checkMessage(message);

  // 用同一套打分卡住「匹配度不够还去打扰 HR」的情况：门槛默认取用户偏好，
  // 也可以用 min_score 覆盖；确实想发时传 ignore_threshold:true 放行。
  const prefs = await store.getPrefs();
  const threshold = Number.isFinite(Number(args?.min_score)) ? Number(args.min_score) : prefs.minScore;
  let match = null;
  if (resume && !args?.ignore_threshold) {
    const scored = scoreJob(resume, job);
    match = { score: scored.score, grade: scored.grade, matched: scored.matched, missing: scored.missing, threshold };
    if (scored.score < threshold) {
      return {
        ok: false,
        dryRun,
        jobId,
        job: compactJob(job),
        message,
        match,
        error: `匹配度 ${scored.score} 分，低于你的门槛 ${threshold}（${thresholdLabel(threshold)}），已拦下。`,
        hint: '确实想发就再调用一次并传 ignore_threshold:true；或用 boss_preferences 把 min_score 调低。',
      };
    }
  }

  const plan = {
    ok: true,
    dryRun,
    job: compactJob(job),
    message,
    match,
    checks: {
      message: check,
      ...pre,
      ready: check.ok && pre.problems.length === 0,
    },
  };

  if (dryRun) {
    plan.hint = '这是 dry run：确认 people/文案无误后，用 dry_run:false 再调用一次才会真正发送。';
    return plan;
  }

  if (!check.ok) return { ...plan, ok: false, error: `文案校验未通过：${check.problems.join('；')}` };
  if (pre.problems.length) return { ...plan, ok: false, error: pre.problems.join('；') };

  const risk = await detectRiskControl(page);
  if (risk.blocked) {
    const file = config.screenshotOnError ? await saveScreenshot(page, store, 'risk-control') : null;
    return { ...plan, ok: false, error: `页面触发风控（${risk.marker}），请先在浏览器里手动处理验证码`, screenshot: file };
  }

  let result;
  try {
    result = await greetJob(page, { job, message, timeoutMs: config.chatReadyTimeoutMs, send: true });
  } catch (error) {
    const file = config.screenshotOnError ? await saveScreenshot(page, store, 'greet-error') : null;
    await store.addHistory({ jobId, jobName: job.jobName, company: job.company, message, status: 'failed', error: String(error?.message ?? error) });
    return { ...plan, ok: false, error: `发送失败：${error?.message ?? error}`, screenshot: file, steps: [] };
  }

  const status = result.ok ? 'sent' : 'failed';
  const record = await store.addHistory({
    jobId,
    jobName: job.jobName,
    company: job.company,
    url: job.url,
    message,
    status,
    via: result.steps?.find((step) => step.step === 'send-message')?.via,
    error: result.reason,
  });

  const screenshot = result.ok ? null : config.screenshotOnError ? await saveScreenshot(page, store, 'greet-failed') : null;
  const after = await store.countToday();

  return {
    ...plan,
    ok: result.ok,
    sent: result.ok,
    steps: result.steps,
    chatUrl: result.chatUrl,
    error: result.ok ? undefined : result.reason,
    screenshot,
    history: { at: record.at, status: record.status },
    quota: { sentToday: after, dailyLimit: config.dailyGreetLimit, remaining: Math.max(0, config.dailyGreetLimit - after) },
  };
}

async function runGreetBatch({ config, store }, args) {
  const jobIds = Array.isArray(args?.job_ids) ? args.job_ids.map(String).filter(Boolean) : [];
  if (!jobIds.length) return toolError('job_ids 不能为空');
  const limit = Math.min(jobIds.length, Math.min(Number(args?.max ?? config.maxPerRun) || config.maxPerRun, config.maxPerRun));
  const targets = jobIds.slice(0, limit);
  const dryRun = args?.dry_run !== false;
  const messages = args?.messages && typeof args.messages === 'object' ? args.messages : {};

  const results = [];
  for (const jobId of targets) {
    const message = messages[jobId] !== undefined ? String(messages[jobId]) : args?.message ? String(args.message) : '';
    try {
      const result = await runGreet({ config, store }, { job_id: jobId, message, dry_run: dryRun, security_id: args?.security_id, lid: args?.lid });
      results.push({ jobId, ok: result.ok, sent: result.sent ?? false, error: result.error, score: undefined, job: result.job, message: result.message, checks: result.checks });
      if (!result.ok && !dryRun) {
        const fatal = /风控|未登录|验证码|环境存在异常/.test(String(result.error ?? ''));
        if (fatal) {
          results.push({ jobId: null, ok: false, error: `已中止批量：${result.error}` });
          break;
        }
      }
    } catch (error) {
      results.push({ jobId, ok: false, error: String(error?.message ?? error) });
    }
    if (!dryRun && jobId !== targets[targets.length - 1]) {
      const wait = Math.max(0, config.minIntervalMs);
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  return {
    ok: results.every((item) => item.ok || item.jobId === null ? true : item.ok),
    dryRun,
    total: targets.length,
    sent: results.filter((item) => item.sent).length,
    results,
    hint: dryRun ? '这是批量 dry run：确认每个岗位的文案后，再用 dry_run:false 执行。' : '批量执行完毕；失败项可检查浏览器窗口和截图。',
  };
}

async function runHistory({ store }, args) {
  const records = await store.getHistory();
  const jobId = args?.job_id ? String(args.job_id) : null;
  const filtered = jobId ? records.filter((record) => String(record.jobId) === jobId) : records;
  const limit = Math.min(Number(args?.limit ?? 20) || 20, 200);
  return {
    ok: true,
    total: filtered.length,
    today: filtered.filter((record) => record.day === new Date().toISOString().slice(0, 10)).length,
    records: filtered.slice(-limit).reverse().map((record) => ({
      at: record.at,
      jobId: record.jobId,
      jobName: record.jobName,
      company: record.company,
      status: record.status,
      error: record.error,
      message: record.message,
    })),
  };
}

// ------------------------------------------------------------------ 定义

/**
 * 工具出口统一清洗：丢掉 undefined / 函数，把 NaN、Infinity 变成 null。
 * 宿主对返回值做无损 JSON 校验，一个值为 undefined 的字段就会让整个调用报
 * “value is not lossless JSON”，所以不能指望 JSON.stringify 自动丢键。
 */
function jsonSafe(value) {
  if (Array.isArray(value)) return value.map(jsonSafe).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === 'function') continue;
      out[key] = jsonSafe(item);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'function') return undefined;
  return value;
}

export function buildTools(config, store) {
  const ctx = { config, store };
  const tools = buildToolDefinitions(ctx);
  for (const tool of tools) {
    const run = tool.execute;
    tool.execute = async (args, exec) => jsonSafe(await run(args, exec));
  }
  return tools;
}

function buildToolDefinitions(ctx) {
  return [
    {
      name: 'boss_preferences',
      description:
        '查看/保存求职偏好：方向（query）、城市（city）、匹配门槛（min_score，0~100）。门槛越高越严（只留高度匹配），越低越宽松（大致符合就进）；保存后检索和匹配默认用它，打招呼低于门槛会被拦下。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set'], description: 'get 查看，set 保存。默认 get。' },
          query: { type: 'string', description: '检索方向，如 "运维"、"DevOps"、"Java 后端"。' },
          city: { type: 'string', description: '城市名或编码，如 "广州" / 101280100。' },
          min_score: { type: 'integer', description: '匹配门槛 0~100：80+ 严格、65 偏严、55 标准、40 宽松。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => render(value) },
      execute: (args) => runPreferences(ctx, args ?? {}),
    },
    {
      name: 'boss_status',
      description:
        '查看 BOSS直聘助手的整体状态：浏览器是否在运行、是否已登录、简历是否已保存、今日发送配额与剩余次数。开始工作或排查问题时先调用它。',
      parameters: {
        type: 'object',
        properties: {
          detail: { type: 'boolean', description: '是否额外返回当前页面 URL/标题（默认 false）。' },
        },
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => render(value) },
      execute: (args) => runStatus(ctx, args ?? {}),
    },
    {
      name: 'boss_login',
      description:
        '打开（或复用）专用浏览器窗口并跳到 BOSS直聘登录页，由你扫码/短信登录。登录态保存在插件自己的浏览器目录里，后续调用自动复用。wait_seconds>0 时会阻塞等待登录完成。',
      parameters: {
        type: 'object',
        properties: {
          wait_seconds: { type: 'integer', description: '等待登录完成的秒数，0 表示只打开登录页立即返回（默认 0，建议先 0 再手动确认）。' },
        },
        additionalProperties: false,
      },
      isConcurrencySafe: () => false,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => render(value) },
      execute: (args) => runLogin(ctx, args ?? {}),
    },
    {
      name: 'boss_browser',
      description:
        '浏览器调试入口：status 查看当前页面、open 打开浏览器、close 关闭、goto 跳转、screenshot 截图、eval 在页面里执行 JS（排查风控/页面结构时很有用）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'open', 'close', 'goto', 'screenshot', 'eval'], description: '要执行的动作，默认 status。' },
          url: { type: 'string', description: 'open/goto 的目标地址。' },
          expression: { type: 'string', description: 'eval 时执行的 JS 表达式（返回可序列化值）。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      isConcurrencySafe: () => false,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => render(value) },
      execute: (args) => runBrowser(ctx, args ?? {}),
    },
    {
      name: 'boss_resume',
      description:
        '管理简历：get 查看已保存简历的摘要；set 用 text（直接粘贴）或 file_path（.txt/.md/.docx）保存并解析出技能、年限、学历、亮点；import_from_boss 尝试从 BOSS 在线资料导入（实验性）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set', 'import_from_boss'], description: '默认 get。' },
          text: { type: 'string', description: 'set 时直接提供的简历全文。' },
          file_path: { type: 'string', description: 'set 时读取的简历文件路径（.txt/.md/.docx）。' },
          name: { type: 'string', description: '可选：覆盖识别出的姓名。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      isConcurrencySafe: () => false,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => render(value) },
      execute: (args) => runResume(ctx, args ?? {}),
    },
    {
      name: 'boss_search_jobs',
      description:
        '按关键词检索 BOSS直聘职位（在已登录的浏览器页面里发请求，自动带上风控参数）。返回精简职位列表：jobId、职位、公司、薪资、地点、经验/学历、技能标签、HR 与详情链接。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，如 "前端工程师"、"Java 后端"、"产品经理"。' },
          city: { type: 'string', description: '城市名或 BOSS 城市编码，如 "杭州" / 101210100；默认用插件配置里的城市。' },
          page: { type: 'integer', description: '页码，默认 1。' },
          page_size: { type: 'integer', description: '本页条数，默认取配置 maxJobs（最大 100）。' },
          filters: {
            type: 'object',
            description: '可选筛选条件，值用 BOSS 的编码字符串：experience（经验）、degree（学历）、salary（薪资）、industry（行业）、scale（规模）、stage（融资阶段）。留空表示不限。',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      isConcurrencySafe: () => false,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => render(value) },
      execute: (args) => runSearch(ctx, args ?? {}),
    },
    {
      name: 'boss_job_detail',
      description: '获取单个职位的详情：完整 JD（职位描述）、任职要求、地址、HR 活跃状态、公司简介与规模。',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: '职位 ID（encryptJobId），来自 boss_search_jobs 的 jobId。' },
          security_id: { type: 'string', description: '可选：搜索结果里的 securityId，用于打开详情页时带上。' },
          lid: { type: 'string', description: '可选：搜索结果里的 lid。' },
        },
        required: ['job_id'],
        additionalProperties: false,
      },
      isConcurrencySafe: () => false,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => render(value) },
      execute: (args) => runDetail(ctx, args ?? {}),
    },
    {
      name: 'boss_match_jobs',
      description:
        '用已保存的简历给职位打分排序（技能覆盖 45 + 岗位方向 20 + 年限 15 + 学历 10 + JD 覆盖 10），返回分数、等级、命中的技能、缺口和风险。传 job_ids（先搜索得到），或直接传 query 让它边搜边分析。不传 query/city/min_score 时用 boss_preferences 里保存的偏好。',
      parameters: {
        type: 'object',
        properties: {
          job_ids: { type: 'array', items: { type: 'string' }, description: '要分析的职位 ID 列表（最多 30 个）。' },
          query: { type: 'string', description: '也可以直接给关键词：先搜索再逐个拉详情分析（默认用偏好里的方向）。' },
          city: { type: 'string', description: '配合 query 使用的城市（默认用偏好里的城市）。' },
          page_size: { type: 'integer', description: '配合 query 时最多分析多少个职位，默认取配置 maxJobs。' },
          min_score: {
            type: 'integer',
            description: '匹配门槛 0~100，默认取偏好（60）。80+ 只要高度匹配，55 标准，40 宽松；低于门槛的不返回。',
          },
          include_details: { type: 'boolean', description: '是否返回分数构成明细（默认 false）。' },
        },
        additionalProperties: false,
      },
      isConcurrencySafe: () => false,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => render(value) },
      execute: (args) => runMatch(ctx, args ?? {}),
    },
    {
      name: 'boss_draft_intro',
      description: '根据简历和某个职位的 JD 起草一段打招呼用的自我介绍（不发送，纯草稿）。可选 extra 追加一句针对岗位的补充。',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: '职位 ID。' },
          extra: { type: 'string', description: '想额外强调的一句话，会拼进文案。' },
          security_id: { type: 'string', description: '可选 securityId。' },
          lid: { type: 'string', description: '可选 lid。' },
        },
        required: ['job_id'],
        additionalProperties: false,
      },
      isConcurrencySafe: () => false,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => render(value) },
      execute: (args) => runDraftIntro(ctx, args ?? {}),
    },
    {
      name: 'boss_greet',
      description:
        '给指定职位发打招呼/自我介绍：打开职位详情 → 点「立即沟通」→ 在聊天页输入文案并发送。默认 dry_run=true，只返回将要发送的内容和校验结果；确认无误后传 dry_run:false 才真正发送。发送前会检查匹配门槛、总开关、重复打招呼、每日配额和最小间隔。',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: '职位 ID。' },
          message: { type: 'string', description: '要发送的自我介绍；不传则用简历自动起草。' },
          dry_run: { type: 'boolean', description: '默认 true：只预览不发送。真正发送请传 false。' },
          extra: { type: 'string', description: '自动起草时追加的一句话。' },
          min_score: { type: 'integer', description: '本次使用的匹配门槛（覆盖偏好里的设置）。' },
          ignore_threshold: { type: 'boolean', description: '低于匹配门槛也想发时传 true，跳过门槛拦截。' },
          security_id: { type: 'string', description: '可选 securityId（来自搜索结果）。' },
          lid: { type: 'string', description: '可选 lid（来自搜索结果）。' },
        },
        required: ['job_id'],
        additionalProperties: false,
      },
      isConcurrencySafe: () => false,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => render(value) },
      execute: (args) => runGreet(ctx, args ?? {}),
    },
    {
      name: 'boss_greet_batch',
      description:
        '批量打招呼：对一组职位依次发送（默认 dry_run=true 预览全部）。受 maxPerRun 条数限制，每条之间按 minIntervalMs 自动等待；一旦出现风控/未登录会中止后续发送。',
      parameters: {
        type: 'object',
        properties: {
          job_ids: { type: 'array', items: { type: 'string' }, description: '职位 ID 列表（按顺序发送）。' },
          message: { type: 'string', description: '统一文案；单个岗位要不同文案时用 messages。' },
          messages: { type: 'object', description: '按 jobId 指定文案，如 {"abc123":"您好……"}。' },
          max: { type: 'integer', description: '本次最多发几条，默认取配置 maxPerRun。' },
          dry_run: { type: 'boolean', description: '默认 true：只预览；真正发送传 false。' },
          security_id: { type: 'string', description: '可选 securityId。' },
          lid: { type: 'string', description: '可选 lid。' },
        },
        required: ['job_ids'],
        additionalProperties: false,
      },
      isConcurrencySafe: () => false,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => render(value) },
      execute: (args) => runGreetBatch(ctx, args ?? {}),
    },
    {
      name: 'boss_history',
      description: '查看打招呼历史（时间、职位、公司、文案、成功/失败原因），用于去重和复盘。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '返回最近多少条，默认 20，最多 200。' },
          job_id: { type: 'string', description: '只看某个职位的记录。' },
        },
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => render(value) },
      execute: (args) => runHistory(ctx, args ?? {}),
    },
  ];
}

export { CITIES, jobDetailUrl, scoreJob, summarizeResume };
