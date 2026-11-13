/**
 * 验证「一个工作标签页跑完整批」是否成立：
 *  - 同一标签页连续导航 3 个职位详情，页面都能正常渲染（不会被弹回首页）；
 *  - 全程标签页数量不增加；
 *  - reapTabs 能把残留的详情页/重复首页清掉。
 *
 * 只做导航和读取，不点「立即沟通」，不会产生任何招呼。
 * 用法：node tests/tab-reuse.mjs [port]
 */
import { listTargets, openTab, reapTabs, sleep } from '../lib/cdp.js';

const port = Number(process.argv[2] ?? 9333);
const jobIds = [
  'd7339a3c391c872a0nxy09q6FlZV',
  '314e89bece1d12cf0nB-2d24ElBY',
  '2c070c880aa812300nx_3N-8FFBY',
];

const detailReady = `(() => {
  const text = (document.body && document.body.innerText) || '';
  return text.includes('职位描述') || text.includes('岗位职责') || text.includes('立即沟通') || text.includes('继续沟通');
})()`;

const pages = async () =>
  (await listTargets(port)).filter((t) => t.type === 'page' && !String(t.url).startsWith('chrome://'));

const before = await pages();
console.log(`起始标签页：${before.length}`);

const work = await openTab(port, 'about:blank');
console.log(`开一个工作页后：${await pages().then((p) => p.length)}`);

for (const jobId of jobIds) {
  const url = `https://www.zhipin.com/job_detail/${jobId}.html`;
  await work.navigate('about:blank', { timeout: 8000 }).catch(() => {});
  await sleep(150);
  await work.navigate(url, { timeout: 45000 }).catch(() => {});
  await work.waitReady({ timeout: 15000 }).catch(() => {});
  const ok = await work.waitFor(detailReady, { timeout: 20000, label: '详情页' }).then(() => true).catch(() => false);
  const current = await work.url().catch(() => '');
  const count = (await pages()).length;
  console.log(`${jobId.slice(0, 10)}  ready=${ok}  onDetail=${String(current).includes('/job_detail/')}  标签页=${count}  url=${String(current).slice(0, 70)}`);
}

await work.close().catch(() => {});
const reaped = await reapTabs(port, { keep: [] });
const after = await pages();
console.log(`reap 关闭：${reaped.closed.length} 个`);
console.log(`最终标签页：${after.length}`);
for (const p of after) console.log(`  - ${String(p.url).slice(0, 80)}`);
process.exit(0);
