/**
 * BOSS直聘站点操作。
 *
 * 关键点：所有请求都在**已登录的页面上下文里**用 fetch 发，而不是从 Node 直连。
 * BOSS 的接口需要页面 JS 生成的 __zp_stoken__，并且和 UA / IP 绑定；脱离浏览器
 * 直接请求会返回 {"code":37,"message":"您的环境存在异常"}。放在页面里发就自然带上
 * 了所有 cookie 和风控参数。
 *
 * 打招呼走的是站点自己的链路：打开职位详情页 → 点「立即沟通」→ 站点打开聊天页 →
 * 在输入框里输入介绍 → 发送。消息本身走 WebSocket，DOM 操作由站点 SDK 代劳，
 * 比逆向它的二进制协议稳定得多。
 */
import { CdpConnection, CdpError, Page, listTargets, openTab, probeVersion, sleep } from './cdp.js';
import { resolveExperience } from './config.js';

const SEARCH_API = '/wapi/zpgeek/search/joblist.json';
const DETAIL_API = '/wapi/zpgeek/job/detail.json';
const FRIEND_ADD_API = '/wapi/zpgeek/friend/add.json';

/**
 * 详情页 URL。检索结果里叫 jobId，详情接口里叫 encryptJobId，两者都接受，
 * 免得调用方拿错字段拼出 /job_detail/undefined.html。
 */
export function jobDetailUrl({ encryptJobId, jobId, securityId, lid }) {
  const id = encryptJobId || jobId;
  if (!id) throw new Error('jobDetailUrl 需要 jobId 或 encryptJobId');
  const params = new URLSearchParams();
  if (securityId) params.set('securityId', securityId);
  if (lid) params.set('lid', lid);
  const search = params.toString();
  return `https://www.zhipin.com/job_detail/${encodeURIComponent(id)}.html${search ? `?${search}` : ''}`;
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 站点的岗位列表字段很多，这里只留对匹配和展示有用的部分。 */
export function normalizeJob(raw = {}) {
  const jobId = String(raw.encryptJobId ?? raw.jobId ?? '');
  return {
    jobId,
    encryptJobId: jobId,
    jobName: String(raw.jobName ?? '').trim(),
    salary: String(raw.salaryDesc ?? ''),
    company: String(raw.brandName ?? '').trim(),
    industry: String(raw.brandIndustry ?? ''),
    stage: String(raw.brandStageName ?? ''),
    scale: String(raw.brandScaleName ?? ''),
    city: String(raw.cityName ?? ''),
    district: [raw.areaDistrict, raw.businessDistrict].filter(Boolean).join('·'),
    experience: String(raw.jobExperience ?? ''),
    degree: String(raw.jobDegree ?? ''),
    skills: Array.isArray(raw.skills) ? raw.skills.map(String) : [],
    labels: Array.isArray(raw.jobLabels) ? raw.jobLabels.map(String) : [],
    welfare: Array.isArray(raw.welfareList) ? raw.welfareList.slice(0, 8).map(String) : [],
    hrName: String(raw.bossName ?? ''),
    hrTitle: String(raw.bossTitle ?? ''),
    hrOnline: Boolean(raw.bossOnline),
    securityId: String(raw.securityId ?? ''),
    lid: String(raw.lid ?? ''),
    encryptBossId: String(raw.encryptBossId ?? ''),
    url: jobId ? jobDetailUrl({ jobId, securityId: raw.securityId, lid: raw.lid }) : '',
  };
}

function searchBody({ query, city, pageNo, pageSize, filters = {} }) {
  const body = {
    scene: 1,
    query: String(query ?? ''),
    city: String(city ?? ''),
    page: num(pageNo, 1),
    pageSize: num(pageSize, 30),
    experience: '',
    payType: '',
    partTime: '',
    degree: '',
    industry: '',
    scale: '',
    stage: '',
    position: '',
    jobType: '',
    salary: '',
    multiSubway: '',
    multiBusinessDistrict: '',
  };
  for (const key of ['experience', 'degree', 'industry', 'scale', 'stage', 'salary', 'jobType', 'position']) {
    if (filters[key] !== undefined && filters[key] !== null && filters[key] !== '') body[key] = String(filters[key]);
  }
  // 经验允许写中文（「5-10年」）或码值（106），统一成接口认的码
  if (body.experience) body.experience = resolveExperience(body.experience);
  return body;
}

/**
 * 检索职位。
 * 接口返回结构在不同客户端版本略有差异，这里按 zpData.jobList 取，并保留原始 code 便于排错。
 */
export async function searchJobs(page, options) {
  const { query, city, pageNo = 1, pageSize = 30, filters } = options;
  const body = searchBody({ query, city, pageNo, pageSize, filters });

  // 先落到搜索页再发请求。实测从首页上下文直接调接口会返回 code 37（环境存在异常），
  // 而在搜索页里调同一接口稳定返回 code 0 —— 站点会校验来源页面/referer。
  const warmUrl = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(String(query))}&city=${encodeURIComponent(String(city))}`;
  const current = await page.url().catch(() => '');
  if (!current.includes('/web/geek/jobs') || !current.includes('query=')) {
    await page.navigate(warmUrl);
  }
  await page.waitReady().catch(() => {});

  const result = await page.evaluate(
    `(async () => {
      const body = ${JSON.stringify(body)};
      const tryCall = async (method, url, init) => {
        try {
          const response = await fetch(url, Object.assign({ credentials: 'include' }, init));
          const text = await response.text();
          let json = null;
          try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
          return { httpStatus: response.status, json };
        } catch (error) {
          return { httpStatus: 0, json: { message: String(error && error.message || error) } };
        }
      };

      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) form.append(key, String(value));

      // code 37 = 环境存在异常/请求过密，等几秒再试通常能恢复。
      const withRetry = async (label, url, init, tries = 3) => {
        let last = null;
        for (let attempt = 1; attempt <= tries; attempt += 1) {
          last = await tryCall(label, url, init);
          last.label = label;
          if (last.json && (last.json.code === 0 || last.json.code === 37)) {
            if (last.json.code === 0) return last;
            await new Promise((r) => setTimeout(r, 2200 * attempt));
            continue;
          }
          return last;
        }
        return last;
      };

      // 只接受「参数真的生效」的返回：POST 一个 JSON body 会被接口忽略并返回默认推荐位
      // （code 仍是 0，但 query/city/pageSize 全不生效），这种静默错误比报错更危险。
      const attempts = [];
      attempts.push(await withRetry('post-form', ${JSON.stringify(SEARCH_API)}, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
      }));
      if (attempts[0].json && attempts[0].json.code === 0) return { ok: true, via: 'post-form', ...attempts[0] };

      attempts.push(await withRetry('get', ${JSON.stringify(SEARCH_API)} + '?' + form.toString(), {
        headers: { accept: 'application/json' },
      }));
      if (attempts[1].json && attempts[1].json.code === 0) return { ok: true, via: 'get', ...attempts[1] };

      return { ok: false, attempts };
    })()`,
    { timeout: 60000 },
  );

  if (result?.ok) {
    const data = result.json.zpData ?? {};
    const list = Array.isArray(data.jobList) ? data.jobList : [];
    return {
      ok: true,
      via: result.via,
      total: num(data.totalCount, list.length),
      hasMore: Boolean(data.hasMore),
      jobs: list.map(normalizeJob),
      rawCode: result.json.code,
    };
  }

  // 接口不通时退回 DOM 抓取：页面上渲染出来的卡片就是同一批数据。
  const fallback = await scrapeJobCards(page);
  if (fallback.jobs.length) {
    return { ok: true, via: 'dom', total: fallback.jobs.length, hasMore: false, jobs: fallback.jobs, warning: '接口返回异常，已改用页面 DOM 抓取' };
  }

  const first = result?.attempts?.[0]?.json ?? {};
  throw new Error(
    `职位检索失败（code=${first.code ?? '?'}，${first.message ?? '无返回'}）。` +
      (first.code === 37 || first.code === 7
        ? '通常表示未登录或触发风控：先 boss_login 登录，或在浏览器里手动通过验证码。'
        : '可在浏览器里手动搜索一次确认页面正常。'),
  );
}

/** DOM 兜底：解析搜索结果页卡片。 */
export async function scrapeJobCards(page) {
  const items = await page.evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('.job-card-wrapper, li.job-card-wrapper, .job-list-box .job-card-box'));
    return nodes.slice(0, 60).map((node) => {
      const link = node.querySelector('a[href*="job_detail"]');
      const href = link ? link.getAttribute('href') : '';
      const pick = (selector) => {
        const el = node.querySelector(selector);
        return el ? (el.innerText || '').trim() : '';
      };
      return {
        href,
        jobName: pick('.job-name') || pick('.job-title'),
        salary: pick('.salary') || pick('.red'),
        company: pick('.company-name') || pick('h3.company-name'),
        area: pick('.job-area'),
        tags: Array.from(node.querySelectorAll('.tag-list li, .job-card-footer .tag-list li')).map((li) => (li.innerText || '').trim()).filter(Boolean),
        hr: pick('.info-public em') || pick('.info-public'),
      };
    });
  })()`);

  const jobs = [];
  for (const item of items ?? []) {
    const match = /job_detail\/([^.?/]+)\.html/.exec(item.href ?? '');
    if (!match) continue;
    const url = item.href.startsWith('http') ? item.href : `https://www.zhipin.com${item.href}`;
    const securityId = new URL(url).searchParams.get('securityId') ?? '';
    jobs.push({
      jobId: match[1],
      jobName: item.jobName,
      salary: item.salary,
      company: item.company,
      city: item.area,
      district: '',
      industry: '',
      stage: '',
      scale: '',
      experience: '',
      degree: '',
      skills: [],
      labels: item.tags ?? [],
      welfare: [],
      hrName: item.hr,
      hrTitle: '',
      hrOnline: false,
      securityId,
      lid: '',
      encryptBossId: '',
      url,
    });
  }
  return { jobs };
}

/** 职位详情：返回 JD 全文 + HR/公司信息。安全参数 securityId 是必需的。 */
export async function jobDetail(page, { encryptJobId, securityId, lid }) {
  await page.waitReady().catch(() => {});
  const query = new URLSearchParams({ encryptJobId: String(encryptJobId) });
  if (securityId) query.set('securityId', String(securityId));
  const fetchExpression = `(async () => {
      const url = ${JSON.stringify(DETAIL_API)} + '?' + ${JSON.stringify(query.toString())};
      const response = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
      const text = await response.text();
      try { return { httpStatus: response.status, json: JSON.parse(text) }; }
      catch { return { httpStatus: response.status, json: { raw: text.slice(0, 300) } }; }
    })()`;

  // 连续拉详情很容易撞上 code 37（频控）：隔一会儿重试，最后一次先打开这个
  // 职位的页面再请求，换个页面上下文通常就能过。
  const failures = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await sleep(attempt === 1 ? 1500 : 2800);
      if (attempt === 2) {
        await page.navigate(jobDetailUrl({ encryptJobId, securityId })).catch(() => {});
        await page.waitReady().catch(() => {});
      }
    }

    let payload;
    try {
      payload = await page.evaluate(fetchExpression, { timeout: 30000 });
    } catch (error) {
      failures.push(`请求失败：${String(error?.message ?? error).slice(0, 80)}`);
      continue;
    }

    const code = payload?.json?.code;
    if (code === 0) return parseJobDetail(payload.json, { encryptJobId, securityId, lid });

    if (code === 17) {
      throw new Error('职位详情获取失败（code=17）：接口要求 securityId，用 boss_search_jobs 的结果（含 securityId）或显式传 security_id。');
    }
    failures.push(`code=${code ?? '?'} ${payload?.json?.message ?? ''}`.trim());
  }

  throw new Error(
    `职位详情获取失败（重试 3 次：${failures.join('；')}）。这是 BOSS 的频控/风控，稍等一下再试；如果反复出现，先在浏览器窗口里确认已登录（必要时 boss_login）。`,
  );
}

export function parseJobDetail(json, options = {}) {
  const data = json.zpData ?? {};
  const info = data.jobInfo ?? {};
  const boss = data.bossInfo ?? {};
  const brand = data.brandComInfo ?? {};
  const job = normalizeJob({ ...info, ...brand, bossName: boss.name ?? info.bossName, bossTitle: boss.title ?? info.bossTitle });
  const jobId = String(job.jobId || options?.encryptJobId || '');
  const securityId = String(job.securityId || options?.securityId || '');
  const lid = String(job.lid || options?.lid || '');
  return {
    ...job,
    // 详情接口的 jobInfo 不带 encryptJobId/securityId，不补上的话后续拼详情页链接会缺参数
    jobId,
    encryptJobId: jobId,
    securityId,
    lid,
    url: jobDetailUrl({ encryptJobId: jobId, securityId, lid }),
    description: String(info.postDescription ?? data.jobInfo?.postDescription ?? '').replace(/\r\n/g, '\n'),
    requirement: String(info.requirements ?? ''),
    address: String(info.address ?? ''),
    longitude: info.longitude ?? null,
    latitude: info.latitude ?? null,
    hrName: String(boss.name ?? job.hrName ?? ''),
    hrTitle: String(boss.title ?? job.hrTitle ?? ''),
    hrActive: boss.activeTimeDesc ?? '',
    companyIntro: String(brand.introduction ?? brand.brandIntroduction ?? ''),
    companySize: String(brand.scaleName ?? job.scale ?? ''),
    raw: { jobInfo: info, bossInfo: boss },
  };
}

/** 详情页元素出现/加载完成的判定。 */
function detailReadyExpression() {
  return `(() => {
    const text = (document.body && document.body.innerText) || '';
    return text.includes('职位描述') || text.includes('岗位职责') || text.includes('立即沟通') || text.includes('继续沟通');
  })()`;
}

/**
 * 打招呼：详情页点按钮 → 聊天页输入 → 发送。
 *
 * @param {Page} page 当前页面（会被导航到职位详情）
 * @param {{job: object, message: string, timeoutMs: number, send: boolean}} options
 */
export async function greetJob(page, { job, message, timeoutMs = 25000, send = true }) {
  const steps = [];
  const jobId = job.jobId || job.encryptJobId;
  // 详情页 URL 必须带 securityId：缺了它页面照样渲染，但「立即沟通」点下去没反应（实测踩过）。
  const url =
    job.url && String(job.url).includes('securityId=')
      ? job.url
      : jobDetailUrl({ encryptJobId: jobId, securityId: job.securityId, lid: job.lid });
  steps.push({
    step: 'build-url',
    hasSecurityId: String(url).includes('securityId='),
    url: String(url).slice(0, 100),
  });

  // 按钮文案：没聊过是「立即沟通」，聊过是「继续沟通」。
  const buttonExpression = `(() => {
    const texts = ['立即沟通', '继续沟通', '马上沟通'];
    const nodes = Array.from(document.querySelectorAll('a, button, span, div'));
    for (const node of nodes) {
      const text = (node.innerText || '').trim();
      if (!text || text.length > 12) continue;
      if (!texts.some((t) => text === t || text === t + ' ')) continue;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      return node;
    }
    return null;
  })()`;

  // 复用标签页会被站点弹回首页，所以每次都用干净标签页打开详情，发完关掉。
  let workPage = page;
  let ownTab = false;
  const cleanup = async () => {
    if (ownTab) await workPage.close().catch(() => {});
  };

  const openDetail = async (label) => {
    try {
      workPage = await openTab(page.port, url);
      ownTab = true;
    } catch {
      workPage = page;
      ownTab = false;
      await page.navigate(url);
    }
    await workPage.waitReady().catch(() => {});
    const ready = await workPage
      .waitFor(detailReadyExpression(), { timeout: 20000, label: '职位详情页加载' })
      .catch(() => false);
    steps.push({ step: label, ok: Boolean(ready), freshTab: ownTab });
    return ready;
  };

  /** 点沟通按钮并等页面跳到聊天页，最多等 8 秒。 */
  const clickAndWait = async (label) => {
    const clicked = await workPage.clickElement(buttonExpression, { timeout: 12000 }).catch(() => null);
    steps.push({ step: label, clicked: Boolean(clicked), text: clicked?.text ?? '' });
    if (!clicked) return { clicked: false, navigated: false };

    let current = await workPage.url().catch(() => '');
    for (let i = 0; i < 8 && !String(current).includes('/web/geek/chat'); i += 1) {
      await sleep(1000);
      current = await workPage.url().catch(() => '');
    }
    const navigated = String(current).includes('/web/geek/chat');
    steps.push({ step: `${label}-navigated`, navigated, url: String(current).slice(0, 80) });
    return { clicked: true, navigated, text: clicked.text ?? '' };
  };

  await openDetail('open-detail');
  let attempt = await clickAndWait('click-chat-button');

  // 第一次给陌生 HR 点「立即沟通」：站点只建会话、不跳聊天页（实测两个岗位都这样）。
  // 重新打开详情页再点，此时按钮已变成「继续沟通」，会正常进入聊天。
  if (attempt.clicked && !attempt.navigated) {
    await cleanup();
    await sleep(1500);
    await openDetail('reopen-detail');
    attempt = await clickAndWait('click-chat-button-retry');
  }

  if (!attempt.clicked) {
    await cleanup();
    return { ok: false, steps, reason: '在职位详情页没找到「立即沟通」按钮，可能未登录或页面结构变化' };
  }

  // 站点可能在当前标签页跳转，也可能开新标签页。
  let chatPage;
  try {
    chatPage = await waitForChatPage(workPage, { timeoutMs });
  } catch (error) {
    // 点完没进聊天页：多半是未登录（站点会弹登录框），给出可执行的原因
    const hint = await workPage
      .evaluate(`(() => {
        const text = (document.body && document.body.innerText) || '';
        if (text.includes('扫码登录') || text.includes('登录后')) return '页面提示需要登录';
        if (text.includes('安全验证') || text.includes('验证码')) return '页面要求安全验证';
        return '';
      })()`)
      .catch(() => '');
    await cleanup();
    return {
      ok: false,
      steps,
      reason: `点击「${attempt.text || '立即沟通'}」后没有进入聊天页${hint ? `（${hint}）` : ''}。${hint.includes('登录') ? '请先 boss_login 完成登录。' : '请检查浏览器窗口里的提示。'}`,
    };
  }
  steps.push({ step: 'chat-page', url: await chatPage.url().catch(() => ''), reused: chatPage === workPage });

  if (!send) {
    await cleanup();
    return { ok: true, steps, chatUrl: '', sent: false };
  }

  const sendResult = await sendChatMessage(chatPage, message, { timeoutMs });
  steps.push({ step: 'send-message', ...sendResult });

  // 站点常常新开一个聊天标签页：发完关掉，避免窗口越堆越多（原标签页不动）
  if (chatPage !== workPage) {
    const closed = await chatPage.close().then(() => true).catch(() => false);
    steps.push({ step: 'close-chat-tab', closed });
  }

  const chatUrl = await chatPage.url().catch(() => '');
  await cleanup();

  return {
    ok: sendResult.ok,
    steps,
    chatUrl,
    sent: sendResult.ok,
    reason: sendResult.reason,
  };
}

/**
 * 找到聊天页：先看当前页是否已经跳到 /web/geek/chat，再找有没有新开的聊天标签页。
 */
async function waitForChatPage(page, { timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = '';
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const current = await page.url();
      lastUrl = current;
      if (String(current).includes('/web/geek/chat')) return page;
    } catch (error) {
      // 页面正在跳转时上下文会被销毁，属正常，记下来继续等
      lastError = String(error?.message ?? error).slice(0, 120);
    }

    const targets = await listTargets(page.port).catch(() => []);
    const chatTarget = targets.find((target) => target.type === 'page' && String(target.url).includes('/web/geek/chat'));
    if (chatTarget && chatTarget.targetId !== page.targetId) {
      const attached = await attachTarget(page.port, chatTarget.targetId);
      if (attached) return attached;
    }
    await sleep(500);
  }
  throw new CdpError(
    `等待聊天页面超时：点击沟通按钮后没有打开聊天页（最后地址：${String(lastUrl).slice(0, 80) || '未知'}${lastError ? `；最后错误：${lastError}` : ''}）`,
  );
}

async function attachTarget(port, targetId) {
  const version = await probeVersion(port);
  if (!version) return null;
  const connection = await CdpConnection.open(version.webSocketDebuggerUrl);
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(connection, sessionId, targetId, port);
  await page.enable();
  return page;
}

/** 在聊天页找到输入框并发送一条文本。 */
export async function sendChatMessage(page, message, { timeoutMs = 20000 } = {}) {
  const editorExpression = `(() => {
    const candidates = [
      '.chat-editor [contenteditable="true"]',
      '.chat-input[contenteditable="true"]',
      '.editor[contenteditable="true"]',
      'div[contenteditable="true"]',
      '.chat-editor textarea',
      'textarea',
    ];
    for (const selector of candidates) {
      const nodes = Array.from(document.querySelectorAll(selector));
      const visible = nodes.filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 40 && rect.height > 10;
      });
      if (visible.length) return visible[visible.length - 1];
    }
    return null;
  })()`;

  const editor = await page.waitFor(`Boolean(${editorExpression})`, { timeout: timeoutMs, label: '聊天输入框' }).catch(() => false);
  if (!editor) return { ok: false, reason: '聊天页没有找到输入框（页面结构可能变化，或会话未建立）' };

  await page.typeText(editorExpression, message);
  await sleep(300);

  // 发送按钮在输入框为空时带 disabled 类；等它变可点，否则点上去不生效。
  const sendReady = await page
    .waitFor(
      `(() => {
        const button = document.querySelector('button.btn-send, button[class*="btn-send"]');
        return Boolean(button) && !String(button.className).includes('disabled');
      })()`,
      { timeout: 4000, label: '发送按钮可点' },
    )
    .catch(() => false);

  // 优先点发送按钮，找不到就用回车（BOSS 默认回车发送）。
  const sendButtonExpression = `(() => {
    const nodes = Array.from(document.querySelectorAll('button, div, span, a'));
    const hit = nodes.find((node) => {
      const text = (node.innerText || '').trim();
      if (text !== '发送' && text !== '发 送') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 20 && rect.height > 10;
    });
    return hit || null;
  })()`;

  const buttonClicked = sendReady ? await page.clickElement(sendButtonExpression, { timeout: 2500 }).catch(() => null) : null;
  if (!buttonClicked) await page.pressKey('Enter');
  await sleep(1200);

  const verify = () =>
    page
      .evaluate(`(() => {
        const editors = Array.from(document.querySelectorAll('[contenteditable="true"], textarea'));
        const editorText = editors.map((node) => (node.innerText || node.value || '').trim()).join('\\n');
        const bodyText = (document.body && document.body.innerText) || '';
        return {
          stillInEditor: editorText.includes(${JSON.stringify(message.slice(0, 20))}),
          appeared: bodyText.includes(${JSON.stringify(message.slice(0, 20))}),
        };
      })()`)
      .catch(() => ({ stillInEditor: false, appeared: false }));

  let verified = await verify();
  let via = buttonClicked ? 'button' : 'enter';

  // 按钮点了没反应（仍留在输入框）时，补一次回车再校验
  if (verified?.stillInEditor) {
    await page.pressKey('Enter');
    await sleep(1500);
    verified = await verify();
    via = 'enter-retry';
  }

  const ok = Boolean(verified?.appeared) && !verified?.stillInEditor;
  return {
    ok,
    via,
    verified,
    reason: ok ? undefined : '消息可能没有发出去：请查看浏览器窗口确认（输入框残留或发送按钮不可点）',
  };
}
