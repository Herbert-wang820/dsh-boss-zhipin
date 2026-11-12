/**
 * 联调脚本（需要浏览器已打开）：用真实站点跑一遍检索 → 详情 → 匹配 → 起草。
 * 不写用户的真实数据目录，简历和历史都落在临时目录里。
 *
 *   node tests/live.mjs [port] [keyword] [city]
 *
 * 前置：boss_login 打开浏览器并登录（未登录时检索可能返回风控码）。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveConfig } from '../lib/config.js';
import { Store } from '../lib/store.js';
import { attachPage, probeVersion } from '../lib/cdp.js';
import { probeLogin } from '../lib/browser.js';
import { jobDetail, searchJobs } from '../lib/zhipin.js';
import { buildResume } from '../lib/resume.js';
import { scoreJob } from '../lib/match.js';
import { draftIntro, checkMessage } from '../lib/intro.js';

const port = Number(process.argv[2] ?? 9333);
const keyword = process.argv[3] ?? '前端';
const city = process.argv[4] ?? '101010100';
const started = Date.now();
const log = (...args) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...args);

const version = await probeVersion(port, 2000);
if (!version) {
  console.error(`端口 ${port} 上没有浏览器，请先运行 boss_login`);
  process.exit(1);
}
log('browser:', version.Browser);

const page = await attachPage({ port, preferredUrlIncludes: 'zhipin.com' });
if (!String(await page.url()).includes('zhipin.com')) {
  await page.navigate('https://www.zhipin.com/');
}
await page.waitReady().catch(() => {});
log('page:', await page.url());

const login = await probeLogin(page);
log('login:', JSON.stringify(login));

// 1) 检索
const search = await searchJobs(page, { query: keyword, city, pageNo: 1, pageSize: 5 });
log(`search: via=${search.via} total=${search.total} returned=${search.jobs.length}`);
if (!search.jobs.length) {
  console.error('没有检索到职位，后续步骤跳过');
  process.exit(1);
}
console.log(search.jobs.map((job) => `  ${job.jobName} | ${job.company} | ${job.salary || '(薪资空)'} | ${job.city}`).join('\n'));

// 2) 详情
const first = search.jobs[0];
const detail = await jobDetail(page, { encryptJobId: first.jobId, securityId: first.securityId, lid: first.lid });
log(`detail: ${detail.jobName} | HR ${detail.hrName || '?'} | JD ${detail.description.length} 字`);
console.log('JD 摘要:', detail.description.slice(0, 160).replace(/\n/g, ' '), '…');

// 3) 匹配 + 起草（用一份示例简历，验证数据链路）
const demo = buildResume({
  text: `示例候选人
前端开发工程师
13800138000 demo@example.com
个人优势
6 年前端开发经验，主导过中后台系统从 0 到 1 的搭建，做过性能优化。
专业技能
Vue、React、TypeScript、Webpack、Vite、Node.js
工作经历
2019.07-2025.03 某某科技 高级前端工程师
教育经历
2015.09-2019.06 某某大学 计算机科学与技术 本科`,
});
const score = scoreJob(demo, detail);
log(`match: ${score.score} 分 / ${score.grade}；命中 ${score.matched.join('、') || '无'}`);
console.log('  理由:', score.reasons.join('；'));
if (score.risks.length) console.log('  风险:', score.risks.join('；'));

const message = draftIntro(demo, detail);
const check = checkMessage(message);
log(`draft: ${message.length} 字，校验 ${check.ok ? '通过' : `未通过(${check.problems.join('、')})`}`);
console.log('  ', message);

// 4) 数据落盘（临时目录）
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boss-live-'));
const { config } = resolveConfig({ dataDir: dir, port });
const store = new Store(config.dataDir);
await store.setResume(demo);
await store.addHistory({ jobId: detail.jobId, jobName: detail.jobName, company: detail.company, message, status: 'sent' });
log('store: 今日计数 =', await store.countToday(), '；重复检查 =', Boolean(await store.findGreeted(detail.jobId)));
await fs.rm(dir, { recursive: true, force: true });

log('联调完成（未发送任何消息）');
process.exit(0);
