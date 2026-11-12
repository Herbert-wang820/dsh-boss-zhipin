/**
 * 配置解析：把 profile 里写的 config（可能只有几个键）补全成运行期配置。
 *
 * 之所以不导出 `Config` JSON Schema：这份配置的键比较多、且大部分用户只会改
 * city / 频率几个键，用解析期校验能给出更具体的中文报错，而不是一坨 schema 错误。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** 常见城市 → BOSS 城市编码。`city` 参数也直接接受数字编码。 */
export const CITIES = Object.freeze({
  全国: '100010000',
  北京: '101010100',
  上海: '101020100',
  广州: '101280100',
  深圳: '101280600',
  杭州: '101210100',
  成都: '101270100',
  南京: '101190100',
  武汉: '101200100',
  西安: '101110100',
  苏州: '101190400',
  长沙: '101250100',
  郑州: '101180100',
  天津: '101030100',
  重庆: '101040100',
  青岛: '101120200',
  合肥: '101220100',
  厦门: '101230200',
  福州: '101230100',
  济南: '101120100',
  东莞: '101281600',
  佛山: '101280800',
  宁波: '101210400',
  无锡: '101190200',
  昆明: '101290100',
  沈阳: '101070100',
  大连: '101070200',
  哈尔滨: '101050100',
  长春: '101060100',
  石家庄: '101090100',
  太原: '101100100',
  南昌: '101240100',
  贵阳: '101260100',
  南宁: '101300100',
  海口: '101310100',
  兰州: '101160100',
  乌鲁木齐: '101130100',
  呼和浩特: '101080100',
  银川: '101170100',
  西宁: '101150100',
  拉萨: '101140100',
});

const CITY_BY_CODE = new Map(Object.entries(CITIES).map(([name, code]) => [code, name]));

/**
 * 检索接口的筛选码值（实测得出，2026-11）：
 * 102 是「在校/应届」，104 是 1-3 年，105 是 3-5 年，以此类推。
 * 传中文标签或数字码都行，searchBody 会归一化。
 */
export const EXPERIENCE_CODES = {
  经验不限: '101',
  '在校/应届': '102',
  '1年以内': '103',
  '1-3年': '104',
  '3-5年': '105',
  '5-10年': '106',
  '10年以上': '107',
};

export function resolveExperience(input) {
  if (input === undefined || input === null || String(input).trim() === '') return '';
  const raw = String(input).trim();
  if (/^\d{3}$/.test(raw)) return raw;
  const key = raw.replace(/\s+/g, '').replace(/年以上$/, '年以上');
  if (EXPERIENCE_CODES[key]) return EXPERIENCE_CODES[key];
  const fixed = key.replace(/^(\d+)\s*[-~—]\s*(\d+)\s*年$/, '$1-$2年').replace(/年以内$/, '年以内');
  return EXPERIENCE_CODES[fixed] ?? raw;
}

export function cityLabel(code) {
  return CITY_BY_CODE.get(String(code ?? '')) ?? String(code ?? '');
}

export function resolveCity(input, fallback = CITIES.北京) {
  if (input === undefined || input === null || String(input).trim() === '') return fallback;
  const raw = String(input).trim();
  if (/^\d{6,9}$/.test(raw)) return raw;
  const key = raw.replace(/市$/, '');
  return CITIES[key] ?? fallback;
}

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function defaultDataDir() {
  return path.join(dshHome(), 'boss-zhipin');
}

const BROWSER_CANDIDATES = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};

/** 找一个可用的 Chromium 内核浏览器；找不到返回 undefined，由调用方报错。 */
export function detectBrowserPath(kind = 'auto', explicit) {
  if (explicit && String(explicit).trim()) return path.normalize(String(explicit).trim());
  const candidates = BROWSER_CANDIDATES[process.platform] ?? [];
  const filtered = kind === 'auto' ? candidates : candidates.filter((p) => new RegExp(kind, 'i').test(p));
  for (const candidate of filtered) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 忽略：只是探测 */
    }
  }
  return undefined;
}

export const DEFAULTS = Object.freeze({
  /** 浏览器可执行文件；留空自动探测 Chrome → Edge。 */
  browserPath: '',
  browserKind: 'auto',
  /** 专用浏览器用户目录：登录态留在这里，不会动用户平时的浏览器资料。 */
  userDataDir: '',
  /** 远程调试端口；被占用时会顺延。 */
  port: 9333,
  headless: false,
  /** 数据目录：简历、历史记录、登录快照、截图。 */
  dataDir: '',
  /** 默认城市编码，可写中文名。 */
  city: CITIES.北京,
  /** 单次搜索最多返回多少条。 */
  maxJobs: 30,
  /** 打招呼：每天上限、两次之间最小间隔、单次批量上限。 */
  dailyGreetLimit: 30,
  minIntervalMs: 20000,
  maxPerRun: 5,
  /** false 时所有发送动作直接拒绝（只保留检索/分析）。 */
  allowSend: true,
  /** 每步操作后是否自动截图（默认只在失败时截图）。 */
  screenshotOnError: true,
  /** 打招呼后的等待时间，等对方会话建立。 */
  chatReadyTimeoutMs: 25000,
  /** 登录等待上限（秒）。 */
  loginWaitSeconds: 180,
});

function asBool(value, fallback, problems, key) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  problems.push(`config.${key} 不是布尔值（收到 ${JSON.stringify(value)}），已用默认值 ${fallback}`);
  return fallback;
}

function asInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}, problems = [], key = '') {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    problems.push(`config.${key} 不是整数（收到 ${JSON.stringify(value)}），已用默认值 ${fallback}`);
    return fallback;
  }
  if (number < min || number > max) {
    problems.push(`config.${key} 超出范围 [${min}, ${max}]（收到 ${number}），已用默认值 ${fallback}`);
    return fallback;
  }
  return number;
}

/**
 * @param {Record<string, unknown> | undefined} raw
 * @returns {{ config: Record<string, any>, problems: string[] }}
 */
export function resolveConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const problems = [];
  const config = { ...DEFAULTS };

  for (const key of Object.keys(DEFAULTS)) {
    if (source[key] !== undefined) config[key] = source[key];
  }

  config.browserKind = ['auto', 'chrome', 'edge', 'chromium'].includes(String(config.browserKind))
    ? String(config.browserKind)
    : 'auto';
  config.port = asInt(config.port, DEFAULTS.port, { min: 1024, max: 65535 }, problems, 'port');
  config.maxJobs = asInt(config.maxJobs, DEFAULTS.maxJobs, { min: 1, max: 100 }, problems, 'maxJobs');
  config.dailyGreetLimit = asInt(config.dailyGreetLimit, DEFAULTS.dailyGreetLimit, { min: 0, max: 500 }, problems, 'dailyGreetLimit');
  config.minIntervalMs = asInt(config.minIntervalMs, DEFAULTS.minIntervalMs, { min: 0, max: 600000 }, problems, 'minIntervalMs');
  config.maxPerRun = asInt(config.maxPerRun, DEFAULTS.maxPerRun, { min: 1, max: 50 }, problems, 'maxPerRun');
  config.loginWaitSeconds = asInt(config.loginWaitSeconds, DEFAULTS.loginWaitSeconds, { min: 10, max: 600 }, problems, 'loginWaitSeconds');
  config.chatReadyTimeoutMs = asInt(config.chatReadyTimeoutMs, DEFAULTS.chatReadyTimeoutMs, { min: 5000, max: 120000 }, problems, 'chatReadyTimeoutMs');
  config.headless = asBool(config.headless, DEFAULTS.headless, problems, 'headless');
  config.allowSend = asBool(config.allowSend, DEFAULTS.allowSend, problems, 'allowSend');
  config.screenshotOnError = asBool(config.screenshotOnError, DEFAULTS.screenshotOnError, problems, 'screenshotOnError');

  config.city = resolveCity(config.city, DEFAULTS.city);
  config.dataDir = config.dataDir ? path.resolve(String(config.dataDir)) : defaultDataDir();
  config.userDataDir = config.userDataDir
    ? path.resolve(String(config.userDataDir))
    : path.join(config.dataDir, 'browser-profile');
  config.browserPath = detectBrowserPath(config.browserKind, config.browserPath);
  if (!config.browserPath) {
    problems.push(
      '未找到 Chrome/Edge。请在插件 config.browserPath 指定浏览器可执行文件路径（例如 "C:/Program Files/Google/Chrome/Application/chrome.exe"）。',
    );
  }

  return { config, problems };
}
