/**
 * 「补发定制招呼」用到的会话能力。
 *
 * 场景：用户自己在 BOSS 上点「立即沟通」，站点只替我发了一句系统默认招呼
 * （「您好，可以和您聊聊吗？」），没有真正的自我介绍。这个模块负责：
 *   1. 列出最近会话（左侧列表的数据其实在 Vue 实例的 props.source 里，
 *      直接读 DOM 文本拿不到 jobId / bossId / securityId）；
 *   2. 逐个打开会话，读出「我发的」「对方发的」「系统提示」三类消息；
 *   3. 判断这个会话是不是「只有自动招呼、没有定制文案」。
 *
 * 发送本身复用 zhipin.js 的 sendChatMessage —— 会话已经存在，不用再点
 * 「立即沟通」，也就绕过了首次沟通不跳聊天页那个坑。
 */
import { sleep } from './cdp.js';

export const CHAT_URL = 'https://www.zhipin.com/web/geek/chat';

/** 站点自动发的招呼语。命中任意一条即视为「没有我的定制内容」。 */
export const AUTO_GREET_PATTERNS = [
  /可以(和|跟)?您?聊聊吗/,
  /方便(和|跟)?您?聊聊吗/,
  /对(这个|该)职位很感兴趣/,
  /想(和|跟)?您(沟通|聊聊)/,
];

/**
 * 判断一条「我发的」消息是不是系统默认招呼。
 * 只要出现自我介绍的关键词（我是XXX / 年经验 / 熟悉 …）就当成定制文案。
 */
export function isAutoGreeting(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  const compact = raw.replace(/\s+/g, '');
  if (compact.length > 40) return false;
  if (/我是[\u4e00-\u9fa5]{2,4}[，,]/.test(compact)) return false;
  if (/年经验|熟悉|做过|负责过/.test(compact)) return false;
  return AUTO_GREET_PATTERNS.some((pattern) => pattern.test(compact));
}

/**
 * 「从什么时候开始」的时间边界，按本地时区算。
 * since 支持：today / week（本周一 0 点）/ month / all，或 days:N。
 * 返回毫秒时间戳；0 表示不限。
 */
export function sinceThreshold(since, now = new Date()) {
  const value = String(since ?? 'week').trim().toLowerCase();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (value === 'all' || value === '0') return 0;
  if (value === 'today') return midnight.getTime();
  if (value === 'week') {
    // 周一为一周起点：getDay() 周日是 0，这里换算成「距周一几天」
    const offset = (midnight.getDay() + 6) % 7;
    return midnight.getTime() - offset * 86400000;
  }
  if (value === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const days = value.match(/^(?:days?[:=])?(\d+)$/);
  if (days) return midnight.getTime() - Number(days[1]) * 86400000;
  return null;
}

/** 把 since 参数翻译成一句人话，回显给调用方看。 */
export function describeSince(since, now = new Date()) {
  const value = String(since ?? 'week').trim().toLowerCase();
  const threshold = sinceThreshold(value, now);
  if (threshold === null) return { since: value, from: null, label: `无法识别的时间范围「${since}」，已按不限处理` };
  if (!threshold) return { since: value, from: null, label: '不限时间' };
  const from = new Date(threshold);
  const label = value === 'today'
    ? '今天'
    : value === 'week'
      ? '本周'
      : value === 'month'
        ? '本月'
        : `最近 ${Math.round((Date.now() - threshold) / 86400000)} 天`;
  return {
    since: value,
    from: from.toISOString(),
    label: `${label}（${from.getMonth() + 1}月${from.getDate()}日 起）`,
  };
}

/** 左侧会话列表的读取脚本：数据在 li.__vue__.$props.source（JSON 字符串）。 */
const LIST_EXPRESSION = `(function(){
  const lis = Array.from(document.querySelectorAll('.user-list-content ul[role="group"] li[role="listitem"]'));
  return lis.map((li) => {
    const vm = li.__vue__;
    const props = (vm && vm.$props) || {};
    let src = props.source;
    if (typeof src === 'string') {
      try { src = JSON.parse(src); } catch (error) { src = null; }
    }
    if (!src) {
      const text = (li.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
      return { bossId: '', jobId: '', name: text[0] || '', company: '', lastText: text[1] || '', unread: 0 };
    }
    return {
      bossId: String(src.encryptBossId || ''),
      jobId: String(src.encryptJobId || ''),
      securityId: String(src.securityId || ''),
      name: String(src.name || ''),
      title: String(src.title || ''),
      company: String(src.brandName || ''),
      lastText: String(src.lastText || ''),
      lastIsSelf: Boolean(src.lastIsSelf),
      unread: Number(src.unreadCount || 0),
      lastTS: Number(src.lastTS || 0),
      uniqueId: String(src.uniqueId || src.encryptBossId || ''),
    };
  });
})()`;

/** 打开指定会话：按 encryptBossId 找列表项并点击。 */
function openExpression(bossId) {
  return `(function(){
    const wanted = ${JSON.stringify(bossId)};
    const lis = Array.from(document.querySelectorAll('.user-list-content ul[role="group"] li[role="listitem"]'));
    const hit = lis.find((li) => {
      const vm = li.__vue__;
      const props = (vm && vm.$props) || {};
      let src = props.source;
      if (typeof src === 'string') { try { src = JSON.parse(src); } catch (error) { src = null; } }
      return src && String(src.encryptBossId || '') === wanted;
    });
    if (!hit) return null;
    const target = hit.querySelector('.friend-content') || hit;
    target.click();
    return (hit.innerText || '').slice(0, 60);
  })()`;
}

/** 会话消息读取：区分「我发的 / 对方发的 / 系统」。 */
const MESSAGES_EXPRESSION = `(function(){
  const items = Array.from(document.querySelectorAll('.message-item'));
  const rows = items.map((el) => {
    const cls = String(el.className || '');
    const kind = cls.includes('item-myself') ? 'self' : cls.includes('item-friend') ? 'friend' : cls.includes('item-system') ? 'system' : 'other';
    const textEl = el.querySelector('.text-content');
    const timeEl = el.querySelector('.item-time .time');
    return {
      kind,
      text: textEl ? String(textEl.innerText || '').trim() : '',
      time: timeEl ? String(timeEl.innerText || '').trim() : '',
    };
  });
  return rows;
})()`;

async function ensureChatPage(page) {
  const current = await page.url().catch(() => '');
  if (!String(current).includes('/web/geek/chat')) {
    await page.navigate(CHAT_URL, { timeout: 45000 }).catch(() => {});
    await page.waitReady({ timeout: 15000 }).catch(() => {});
  }
  await page
    .waitFor(`document.querySelectorAll('.user-list-content li[role="listitem"]').length > 0`, {
      timeout: 15000,
      label: '聊天列表加载',
    })
    .catch(() => false);
}

/** 把列表往下滚一屏，让虚拟列表把更早的会话渲染出来。 */
async function scrollListOnce(page) {
  return page
    .evaluate(`(function(){
      let node = document.querySelector('.user-list-content');
      while (node && node !== document.body) {
        if (node.scrollHeight > node.clientHeight + 20) {
          const before = node.scrollTop;
          node.scrollTop = node.scrollTop + Math.max(200, node.clientHeight - 120);
          return { scrolled: node.scrollTop !== before, top: node.scrollTop, height: node.scrollHeight };
        }
        node = node.parentElement;
      }
      return { scrolled: false, top: 0, height: 0 };
    })()`)
    .catch(() => ({ scrolled: false }));
}

/**
 * 列出最近会话。默认取 40 条；limit 更大时会边滚边收集。
 * 返回顺序与左侧列表一致（最近消息在前，置顶在最前）。
 */
export async function listConversations(page, { limit = 40, maxScrolls = 5 } = {}) {
  await ensureChatPage(page);
  const seen = new Map();
  let scrolls = 0;
  let lastCount = 0;

  const collect = async () => {
    const rows = (await page.evaluate(LIST_EXPRESSION).catch(() => [])) || [];
    for (const row of rows) {
      const key = row.bossId || `${row.name}|${row.company}|${row.lastText}`;
      if (key && !seen.has(key)) seen.set(key, row);
    }
    return rows.length;
  };

  lastCount = await collect();
  while (seen.size < limit && scrolls < maxScrolls) {
    const result = await scrollListOnce(page);
    scrolls += 1;
    if (!result?.scrolled) break;
    await sleep(900);
    const count = await collect();
    if (count <= lastCount && seen.size >= limit) break;
    lastCount = count;
  }

  return Array.from(seen.values()).slice(0, limit);
}

/**
 * 打开一个会话并等消息出现。
 * 优先在列表里点击（保持站点自己的路由状态）；列表里找不到时退回 URL 直开。
 */
export async function openConversation(page, conversation, { timeoutMs = 15000 } = {}) {
  const bossId = String(conversation.bossId ?? '');
  const jobId = String(conversation.jobId ?? '');
  await ensureChatPage(page);

  let clicked = null;
  if (bossId) clicked = await page.evaluate(openExpression(bossId)).catch(() => null);

  if (!clicked) {
    const params = new URLSearchParams();
    if (bossId) params.set('id', bossId);
    if (jobId) params.set('jobId', jobId);
    await page.navigate(`${CHAT_URL}${params.toString() ? `?${params.toString()}` : ''}`, { timeout: 45000 }).catch(() => {});
    await page.waitReady({ timeout: 15000 }).catch(() => {});
  }

  const ready = await page
    .waitFor(`document.querySelectorAll('.message-item').length > 0`, { timeout: timeoutMs, label: '会话消息加载' })
    .catch(() => false);

  // 消息列表是懒加载的，多等一拍再读，避免只读到半屏
  await sleep(900);
  return { opened: Boolean(ready), via: clicked ? 'list-click' : 'url' };
}

/** 读当前会话的消息，并给出「是否已有我的定制文案」的判断。 */
export async function readConversation(page) {
  const messages = (await page.evaluate(MESSAGES_EXPRESSION).catch(() => [])) || [];
  const selfTexts = messages.filter((m) => m.kind === 'self' && m.text).map((m) => m.text);
  const friendTexts = messages.filter((m) => m.kind === 'friend' && m.text).map((m) => m.text);
  const customTexts = selfTexts.filter((text) => !isAutoGreeting(text));
  return {
    messages,
    selfTexts,
    friendTexts,
    customTexts,
    autoOnly: selfTexts.length > 0 && customTexts.length === 0,
    hasCustom: customTexts.length > 0,
  };
}

/**
 * 找「只发了系统默认招呼」的会话。
 * since 限定只看最近这段时间内有消息的会话（本周 / 今天 / 本月 / all / days:N），
 * 免得把几个月前的老会话也逐个打开。
 * 只读：不发送任何内容（打开会话会让对方那条未读变已读，这点无法避免）。
 */
export async function findAutoGreetOnly(page, { limit = 40, since = 'week', now = new Date(), onProgress } = {}) {
  const threshold = sinceThreshold(since, now);
  const all = await listConversations(page, { limit });
  const conversations = threshold ? all.filter((conversation) => Number(conversation.lastTS ?? 0) >= threshold) : all;
  const outOfRange = threshold ? all.filter((conversation) => Number(conversation.lastTS ?? 0) < threshold) : [];
  const candidates = [];
  const skipped = [];

  for (let index = 0; index < conversations.length; index += 1) {
    const conversation = conversations[index];
    if (onProgress) onProgress({ index, total: conversations.length, conversation });

    if (!conversation.jobId) {
      skipped.push({ ...conversation, reason: '会话里没有关联职位 ID' });
      continue;
    }

    const opened = await openConversation(page, conversation).catch((error) => ({ opened: false, error: String(error?.message ?? error) }));
    if (!opened.opened) {
      skipped.push({ ...conversation, reason: `打开会话失败${opened.error ? `：${opened.error}` : ''}` });
      continue;
    }

    const state = await readConversation(page);
    if (!state.selfTexts.length) {
      skipped.push({ ...conversation, reason: '这个会话里我一句话都没发过（可能是对方先联系）' });
      continue;
    }
    if (state.hasCustom) {
      skipped.push({ ...conversation, reason: '已经发过定制文案', customTexts: state.customTexts.slice(-2) });
      continue;
    }

    candidates.push({
      ...conversation,
      autoGreeting: state.selfTexts[0] ?? '',
      friendTexts: state.friendTexts.slice(-3),
      messageCount: state.messages.length,
    });
  }

  return { conversations, candidates, skipped, outOfRange, threshold };
}
