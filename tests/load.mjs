/**
 * 宿主加载冒烟测试：用假的 ctx 模拟 DSH 的 Host 环境，确认
 *   - 模块能 import（没有引到宿主内部包）；
 *   - apply() 能跑完并注册全部工具；
 *   - 工具在没有任何配置时的返回是可读的错误，而不是崩溃。
 *
 *   node tests/load.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { apply, inject, name } from '../lib/index.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boss-load-'));
const registered = new Map();
const logs = [];

const cleanups = [];
const ctx = {
  logger: {
    info: (message) => logs.push(['info', message]),
    warn: (message) => logs.push(['warn', message]),
    error: (message) => logs.push(['error', message]),
  },
  effect(fn) {
    // 和 cordis 一样：fn 返回的清理函数由外层在 dispose 时调用
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  },
  tools: {
    register(tool) {
      assert.ok(!registered.has(tool.name), `重复注册 ${tool.name}`);
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
  },
  inject(_names, callback) {
    callback({
      effect: (fn) => fn(),
      systemPrompt: { section: (section) => section },
    });
  },
};

const dispose = apply(ctx, { dataDir: dir, port: 9555 });
assert.equal(dispose, undefined, 'apply 不需要返回值，清理逻辑通过 ctx.effect 注册');
assert.equal(name, 'dsh-boss-zhipin');
assert.deepEqual(inject, ['tools']);
assert.equal(registered.size, 12, `应注册 12 个工具，实际 ${registered.size}`);

const names = [...registered.keys()].sort();
console.log('registered tools:', names.join(', '));

// 系统提示注入
assert.ok(logs.some(([, message]) => message.includes('已注册 12 个工具')), logs.map(([, m]) => m).join('\n'));

// 无浏览器时 boss_status 不能抛：它要把错误装进结果里
const status = await registered.get('boss_status').execute({});
assert.equal(status.ok, true);
assert.equal(status.browser.running, false);
assert.ok(String(status.browser.error ?? '').length > 0, '应说明浏览器为什么没起来');
assert.equal(status.quota.dailyLimit, 30);

// 简历：没有时给出可操作提示
const resume = await registered.get('boss_resume').execute({ action: 'get' });
assert.equal(resume.exists, false);

// 保存一段简历后能读回摘要
const sample = `李四
前端工程师
13800138000 lisi@example.com
个人优势
5 年前端经验，负责过电商中后台。
专业技能
Vue、TypeScript、Webpack
工作经历
2020.03-2025.01 某某公司 前端工程师
教育经历
2016.09-2020.06 某某大学 本科`;
const saved = await registered.get('boss_resume').execute({ action: 'set', text: sample });
assert.equal(saved.saved, true);
assert.ok(saved.summary.skills.includes('Vue'));

// 参数错误要可读
const search = await registered.get('boss_search_jobs').execute({ query: '' });
assert.equal(search.ok, false);
assert.match(search.error, /query/);

// 清理：逐个执行 ctx.effect 注册的清理函数，不应抛
for (const cleanup of cleanups.reverse()) cleanup();
assert.ok(cleanups.length >= 1);

await fs.rm(dir, { recursive: true, force: true });
console.log('\nload smoke test passed');
