/**
 * 极简 Chrome DevTools Protocol 客户端（无第三方依赖）。
 *
 * 只用 Node 22+ 内置的全局 WebSocket 和 fetch：
 *  - HTTP 端点 /json/version、/json/list 用来发现、复用调试目标；
 *  - 浏览器级 WebSocket + Target.attachToTarget(flatten) 操作页面。
 *
 * 整个插件只需要「打开页面、在页面里取数、点一下、输入文字、截图」这几件事，
 * 所以这里不实现完整的 CDP 封装，保持可读、可调试。
 */

const DEFAULT_TIMEOUT = 30000;

export class CdpError extends Error {
  constructor(message, { method, details } = {}) {
    super(message);
    this.name = 'CdpError';
    this.method = method;
    this.details = details;
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CdpError(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpJson(url, timeout = 5000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new CdpError(`HTTP ${response.status} ${url}`);
  return response.json();
}

/** 探测调试端口是否已有浏览器在监听。 */
export async function probeVersion(port, timeout = 1500) {
  try {
    return await httpJson(`http://127.0.0.1:${port}/json/version`, timeout);
  } catch {
    return null;
  }
}

export async function listTargets(port) {
  try {
    return await httpJson(`http://127.0.0.1:${port}/json/list`, 3000);
  } catch {
    return [];
  }
}

export class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    ws.addEventListener('message', (event) => this.#onMessage(event));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new CdpError('调试连接已关闭'));
      }
      this.pending.clear();
    });
  }

  static async open(wsUrl, timeout = 10000) {
    const ws = new WebSocket(wsUrl);
    await withTimeout(
      new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new CdpError(`无法连接 ${wsUrl}`)), { once: true });
      }),
      timeout,
      '连接调试端口',
    );
    return new CdpConnection(ws);
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CdpError(message.error.message || 'CDP 调用失败', { method: entry.method, details: message.error }));
      else entry.resolve(message.result);
      return;
    }
    const handlers = this.listeners.get(message.method);
    if (handlers) {
      for (const handler of [...handlers]) handler(message.params, message.sessionId);
    }
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }

  send(method, params = {}, sessionId, timeout = DEFAULT_TIMEOUT) {
    if (this.closed) return Promise.reject(new CdpError('调试连接已关闭', { method }));
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP ${method} 超时`, { method }));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (error) {
      this.pending.delete(id);
      return Promise.reject(new CdpError(`CDP ${method} 发送失败：${error?.message ?? error}`, { method }));
    }
    return promise;
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* 已经关了 */
    }
  }
}

/** 一个页面（tab）的句柄：把常用操作包成直白的方法。 */
export class Page {
  constructor(connection, sessionId, targetId, port) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.port = port;
    this.consoleErrors = [];
  }

  send(method, params = {}, timeout) {
    return this.connection.send(method, params, this.sessionId, timeout);
  }

  /**
   * 只开 Page 域，**故意不开 Runtime.enable**。
   *
   * BOSS 的 browser-check 脚本会检测 DevTools：一旦 Runtime 域被启用（console 钩子被
   * 接管），页面会在 1 秒内被清成 about:blank。实测「只 Page.enable」或「什么都不开」
   * 时页面能稳定存活，而 Runtime.evaluate 不需要 enable 也能用，所以这里保持最小暴露。
   */
  async enable() {
    await this.send('Page.enable');
    return this;
  }

  async url() {
    const { result } = await this.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    return result?.value ?? '';
  }

  async title() {
    const { result } = await this.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    return result?.value ?? '';
  }

  /**
   * 在页面上下文里求值。
   * @param {string} expression 需要是表达式或 IIFE 字符串
   * @param {{timeout?: number, awaitPromise?: boolean}} [options]
   */
  async evaluate(expression, options = {}) {
    const { timeout = DEFAULT_TIMEOUT, awaitPromise = true } = options;
    const { result, exceptionDetails } = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true,
        includeCommandLineAPI: false,
      },
      timeout,
    );
    if (exceptionDetails) {
      const text = exceptionDetails.exception?.description ?? exceptionDetails.text ?? '页面脚本异常';
      throw new CdpError(`页面脚本异常：${String(text).split('\n')[0]}`.slice(0, 500), { details: exceptionDetails });
    }
    return result?.value;
  }

  async navigate(url, { waitForLoad = true, timeout = 45000 } = {}) {
    const loaded = new Promise((resolve) => {
      const off = this.connection.on('Page.loadEventFired', (params, session) => {
        if (session && session !== this.sessionId) return;
        off();
        resolve();
      });
      setTimeout(() => {
        off();
        resolve();
      }, timeout);
    });
    await this.send('Page.navigate', { url }, timeout);
    if (waitForLoad) await loaded;
    return this;
  }

  /**
   * 等到页面真正稳定：document 就绪 + location 连续一段时间没变。
   * BOSS 首页会按 IP 302 到城市页，导航「完成」之后往往还有一跳；直接求值会拿到
   * "Inspected target navigated or closed"，所以读写之前都先过这一层。
   */
  async waitReady({ timeout = 20000, settle = 500 } = {}) {
    const deadline = Date.now() + timeout;
    let lastHref = null;
    let stableSince = 0;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate(`({ readyState: document.readyState, href: location.href })`, { timeout: 5000 });
        if (state?.readyState === 'complete') {
          if (state.href === lastHref) {
            stableSince ||= Date.now();
            if (Date.now() - stableSince >= settle) return true;
          } else {
            lastHref = state.href;
            stableSince = Date.now();
          }
        }
      } catch {
        // 正在跳转，下一轮再看
      }
      await sleep(250);
    }
    return false;
  }

  /** 轮询直到 fn 返回真值；超时抛错并回传最后一次求值结果。 */
  async waitFor(expression, { timeout = 20000, interval = 400, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(expression, { timeout: Math.max(2000, Math.min(15000, timeout)) });
        if (last) return last;
      } catch (error) {
        last = String(error?.message ?? error);
      }
      await sleep(interval);
    }
    throw new CdpError(`等待超时：${label}（最后一次结果：${JSON.stringify(last)?.slice(0, 300)}）`);
  }

  async screenshotBytes(format = 'png') {
    const { data } = await this.send('Page.captureScreenshot', { format, captureBeyondViewport: false });
    return Buffer.from(data, 'base64');
  }

  async screenshotFile(filePath) {
    const { writeFile } = await import('node:fs/promises');
    const buffer = await this.screenshotBytes();
    await writeFile(filePath, buffer);
    return filePath;
  }

  /** 用真实鼠标事件点一个坐标（比 element.click() 更接近用户操作）。 */
  async clickAt(x, y) {
    const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await sleep(40);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  /**
   * 找一个元素并点击它。
   * @param {string} expression 求值得到元素（返回 null 表示没找到）
   * @param {{timeout?: number}} [options]
   */
  async clickElement(expression, { timeout = 10000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const rect = await this.evaluate(`(() => {
        const el = (${expression});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName, text: (el.innerText || '').slice(0, 40) };
      })()`);
      if (rect) {
        await this.clickAt(rect.x, rect.y);
        return rect;
      }
      await sleep(300);
    }
    throw new CdpError(`找不到可点击元素：${expression}`.slice(0, 300));
  }

  /** 聚焦一个元素（点击它）后插入文本，走浏览器输入通道，前端框架能收到事件。 */
  async typeText(elementExpression, text) {
    const rect = await this.clickElement(elementExpression);
    await sleep(120);
    if (text) {
      await this.send('Input.insertText', { text });
      await sleep(120);
    }
    return rect;
  }

  async pressKey(key) {
    const map = {
      Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
      Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
    };
    const spec = map[key];
    if (!spec) throw new CdpError(`不支持的按键：${key}`);
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...spec });
    await sleep(30);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec });
  }

  async close() {
    try {
      await this.connection.send('Target.closeTarget', { targetId: this.targetId });
    } catch {
      /* 关不掉就算了，Tab 留着也不影响 */
    }
  }
}

/**
 * 新开一个标签页并打开指定地址，返回可操作的 Page。
 *
 * 为什么要新开：直接在被反复复用的标签页里跳到职位详情，BOSS 的前端会把页面
 * 弹回首页（`/guangzhou/?seoRefer=index`）；新标签页打开则正常渲染详情和
 * 「立即沟通」。用完记得 page.close()，否则窗口越堆越多。
 */
export async function openTab(port, url) {
  const version = await probeVersion(port);
  if (!version) throw new CdpError(`调试端口 ${port} 上没有浏览器`);
  const connection = await CdpConnection.open(version.webSocketDebuggerUrl);
  const { targetId } = await connection.send('Target.createTarget', { url: url || 'about:blank' });
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(connection, sessionId, targetId, port);
  await page.enable();
  return page;
}

/**
 * 连接浏览器并拿到一个可用页面。
 * @param {{port: number, preferredUrlIncludes?: string}} options
 */
export async function attachPage({ port, preferredUrlIncludes = 'zhipin.com' }) {
  const version = await probeVersion(port);
  if (!version) throw new CdpError(`调试端口 ${port} 上没有浏览器，请先调用 boss_login 打开浏览器`);
  const connection = await CdpConnection.open(version.webSocketDebuggerUrl);

  const targets = await listTargets(port);
  // 跳过 devtools / chrome:// 这类内部页面；优先用已经在 zhipin 域名下的标签页，
  // 否则用第一个普通网页（about:blank 也算），避免把浏览器内部页当成工作页。
  const pages = targets.filter(
    (target) => target.type === 'page' && !String(target.url).startsWith('devtools://') && !String(target.url).startsWith('chrome://'),
  );
  const zhipin = pages.find((target) => String(target.url).includes(preferredUrlIncludes));
  const blank = pages.find((target) => target.url === 'about:blank');
  const preferred = zhipin ?? blank ?? pages[0];

  let targetId = preferred?.targetId;
  if (!targetId) {
    const created = await connection.send('Target.createTarget', { url: 'about:blank' });
    targetId = created.targetId;
  }
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(connection, sessionId, targetId, port);
  await page.enable();
  return page;
}
