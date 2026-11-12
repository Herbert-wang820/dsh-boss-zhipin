/**
 * 浏览器生命周期：启动 / 复用 Chrome，登录页跳转，登录状态探测。
 *
 * 登录方式就是用户要求的「跳转浏览器登录」：插件拉起一个**独立用户目录**的
 * Chrome 窗口，用户自己扫码或短信登录；登录态存在这个目录里，下次直接复用。
 * 这样既不用在插件里保存账号密码，也不会碰用户平时的浏览器资料。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { CdpConnection, CdpError, Page, attachPage, probeVersion, sleep } from './cdp.js';

export const LOGIN_URL = 'https://www.zhipin.com/web/user/?ka=header-login';
export const HOME_URL = 'https://www.zhipin.com/';

/** 需要登录才能返回 code 0 的接口，用来判断登录态。 */
const LOGIN_PROBE_URL = '/wapi/zpgeek/resume/baseinfo/query.json';

function browserArgs(config) {
  return [
    `--remote-debugging-port=${config.port}`,
    `--user-data-dir=${config.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--remote-allow-origins=*',
    '--window-size=1440,900',
    ...(config.headless ? ['--headless=new', '--disable-gpu'] : []),
  ];
}

/** 手动启动脚本：spawn 被系统或安全软件拦住时，让用户双击就能起浏览器。 */
export async function writeLaunchScript(config) {
  const file = path.join(config.dataDir, 'start-browser.cmd');
  await fsp.mkdir(config.dataDir, { recursive: true });
  const command = `"${config.browserPath}" ${browserArgs(config).map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')} ${LOGIN_URL}`;
  await fsp.writeFile(file, `@echo off\r\nstart "" ${command}\r\n`, 'utf8');
  return file;
}

export async function launchBrowser(config, url = LOGIN_URL) {
  const existing = await probeVersion(config.port, 800);
  if (existing) {
    return { reused: true, port: config.port, browser: existing.Browser };
  }
  if (!config.browserPath) {
    throw new CdpError('没有可用的 Chrome/Edge：请在插件 config.browserPath 指定浏览器路径');
  }

  const child = spawn(config.browserPath, [...browserArgs(config), url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  const spawnError = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve(error);
    });
  });
  if (spawnError) {
    const script = await writeLaunchScript(config);
    throw new CdpError(
      `无法直接启动浏览器（${spawnError.code ?? spawnError.message}）。` +
        `已生成启动脚本：${script}。请双击它以调试模式打开浏览器后，再调用 boss_login 或 boss_status。`,
    );
  }

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const version = await probeVersion(config.port, 1200);
    if (version) return { reused: false, port: config.port, browser: version.Browser };
    await sleep(300);
  }
  const script = await writeLaunchScript(config);
  throw new CdpError(
    `浏览器已启动但调试端口 ${config.port} 没有响应。可能被安全软件拦截，或端口被占用；` +
      `可双击 ${script} 手动启动后重试。`,
  );
}

export async function closeBrowser(config) {
  const version = await probeVersion(config.port, 800);
  if (!version) return { closed: false, reason: '浏览器未运行' };
  const connection = await CdpConnection.open(version.webSocketDebuggerUrl);
  try {
    await connection.send('Browser.close');
  } catch {
    /* 关窗口时连接会先断，属正常 */
  } finally {
    connection.close();
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!(await probeVersion(config.port, 500))) return { closed: true };
    await sleep(300);
  }
  return { closed: false, reason: '关闭指令已发出，但端口仍在响应' };
}

/** 打开（或复用）页面，并确保它停在 zhipin 域名下，跨域取不到 cookie。 */
export async function ensurePage(config, { navigateTo } = {}) {
  await launchBrowser(config);
  const page = await attachPage({ port: config.port, preferredUrlIncludes: 'zhipin.com' });
  if (navigateTo) {
    await page.navigate(navigateTo);
  } else {
    const current = await page.url();
    if (!current.includes('zhipin.com')) await page.navigate(HOME_URL);
  }
  return page;
}

/**
 * 探测登录态。返回 { loggedIn, code, message }。
 * 走一个需要登录的接口，比看 cookie 名字可靠：BOSS 的 cookie 名会变，接口语义稳定。
 *
 * 页面刚跳转时求值会得到 "Inspected target navigated or closed"，所以这里带重试，
 * 并且先等 document 就绪，避免把「正在加载」误判成「未登录」。
 */
export async function probeLogin(page, { retries = 3, interval = 800 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await page
        .waitFor(`document.readyState === 'complete' || document.readyState === 'interactive'`, {
          timeout: 8000,
          interval: 300,
          label: '页面就绪',
        })
        .catch(() => {});
      const payload = await page.evaluate(`(async () => {
        const r = await fetch(${JSON.stringify(LOGIN_PROBE_URL)}, {
          credentials: 'include',
          headers: { accept: 'application/json' },
        });
        const text = await r.text();
        try { return { status: r.status, body: JSON.parse(text) }; }
        catch { return { status: r.status, body: { raw: text.slice(0, 200) } }; }
      })()`);
      const code = payload?.body?.code;
      const message = payload?.body?.message ?? '';
      return { loggedIn: code === 0, code, message, httpStatus: payload?.status };
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(interval);
    }
  }
  return { loggedIn: false, code: null, message: String(lastError?.message ?? lastError ?? '登录态探测失败') };
}

export async function getCookies(page) {
  try {
    const { cookies } = await page.send('Network.getAllCookies');
    return cookies.filter((cookie) => String(cookie.domain).includes('zhipin.com'));
  } catch {
    return [];
  }
}

/** 阻塞等待用户完成登录（扫码/短信），期间每 2 秒探测一次。 */
export async function waitForLogin(config, { waitSeconds = config.loginWaitSeconds, page } = {}) {
  const session = page ?? (await ensurePage(config, { navigateTo: LOGIN_URL }));
  const deadline = Date.now() + waitSeconds * 1000;
  let last = { loggedIn: false, code: null, message: '' };
  while (Date.now() < deadline) {
    last = await probeLogin(session);
    if (last.loggedIn) {
      const cookies = await getCookies(session);
      await session.navigate(HOME_URL);
      return { ...last, page: session, cookies: cookies.length };
    }
    // 登录成功后站点通常会跳首页；这里不强制导航，避免打断扫码页。
    await sleep(2000);
  }
  return { ...last, page: session };
}

/** 页面是否被风控拦下（验证码 / 环境异常）。 */
export async function detectRiskControl(page) {
  try {
    const info = await page.evaluate(`(() => ({
      title: document.title || '',
      text: (document.body && document.body.innerText || '').slice(0, 4000),
    }))()`);
    const text = `${info?.title ?? ''} ${info?.text ?? ''}`;
    const markers = ['安全验证', '请输入验证码', '滑动验证', '环境存在异常', '访问过于频繁', '请完成下列验证'];
    const hit = markers.find((marker) => text.includes(marker));
    return hit ? { blocked: true, marker: hit } : { blocked: false };
  } catch {
    return { blocked: false };
  }
}

export async function saveScreenshot(page, store, name) {
  try {
    const buffer = await page.screenshotBytes();
    const file = await store.screenshot(`${name}-${Date.now()}.png`, buffer);
    return file;
  } catch {
    return null;
  }
}

export { Page };
