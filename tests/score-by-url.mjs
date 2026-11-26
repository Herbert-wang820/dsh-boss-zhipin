import * as m from '../lib/cdp.js';
import { resolveConfig } from '../lib/config.js';
import { Store } from '../lib/store.js';
import { scoreJob } from '../lib/match.js';

const { config } = resolveConfig({});
const store = new Store(config.dataDir);
const resume = await store.getResume();

const ids = process.argv.slice(2);
const tab = await m.openTab(config.port, 'https://www.zhipin.com/');

for (const id of ids) {
  const url = `https://www.zhipin.com/job_detail/${id}.html`;
  await tab.navigate(url);
  await new Promise((r) => setTimeout(r, 4500));
  const info = await tab.evaluate(`(function(){
    const pick = (sel) => { const e = document.querySelector(sel); return e ? (e.innerText||'').trim() : ''; };
    const body = document.body.innerText || '';
    const lines = body.split('\\n').map(s=>s.trim()).filter(Boolean);
    const name = pick('.job-banner .name h1, .job-name, h1');
    const salary = pick('.job-banner .salary, .salary');
    const company = pick('.company-info .company-name, .sider-company .company-name');
    const descNode = document.querySelector('.job-sec-text, .job-detail-section .text, .job-sec');
    const desc = descNode ? (descNode.innerText||'').trim() : '';
    const expLine = lines.find(l => /年经验|经验不限/.test(l)) || '';
    const eduLine = lines.find(l => /^(本科|大专|硕士|学历不限)$/.test(l)) || '';
    return { name, salary, company, desc: desc.slice(0, 1600), expLine, eduLine };
  })()`);
  const job = {
    jobId: id,
    jobName: info.name,
    salary: info.salary,
    company: info.company,
    experience: info.expLine,
    degree: info.eduLine,
    description: info.desc,
    skills: [],
  };
  const sc = scoreJob(resume, job);
  console.log(JSON.stringify({ id, name: info.name, salary: info.salary, company: info.company, exp: info.expLine, edu: info.eduLine, score: sc.score, grade: sc.grade, matched: sc.matched, missing: (sc.missing||[]).slice(0, 6), overseas: !!sc.overseas }));
  if (process.env.SHOW_DESC) console.log('  DESC:', info.desc.replace(/\n/g, ' | ').slice(0, 600));
}
await tab.close();
process.exit(0);
