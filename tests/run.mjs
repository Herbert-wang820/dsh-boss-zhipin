/**
 * 单元测试：不联网、不需要浏览器，跑完即知对错。
 *   node tests/run.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CITIES, cityLabel, resolveCity, resolveConfig, resolveExperience } from '../lib/config.js';
import { Store, DEFAULT_MIN_SCORE } from '../lib/store.js';
import { buildResume, extractSkills, estimateYears, splitSections } from '../lib/resume.js';
import { parseExperience, rankJobs, scoreJob } from '../lib/match.js';
import { checkMessage, draftIntro } from '../lib/intro.js';
import { jobDetailUrl, normalizeJob, parseJobDetail } from '../lib/zhipin.js';
import { buildTools } from '../lib/tools.js';

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}`);
    console.log(`     ${String(error?.message ?? error).split('\n')[0]}`);
  }
}

const RESUME_TEXT = `张三
男 | 28岁 | 13800138000 | zhangsan@example.com
求职意向：前端开发工程师
个人优势
6 年前端开发经验，主导过中后台系统从 0 到 1 的搭建，做过首屏性能优化。
专业技能
Vue、React、TypeScript、Webpack、Vite、Node.js、CSS
工作经历
2019.07-2025.03 某某科技有限公司 高级前端工程师
负责 B 端管理系统的架构设计与性能优化。
教育经历
2015.09-2019.06 某某大学 计算机科学与技术 本科`;

const FRONTEND_JOB = {
  jobId: 'abc123',
  jobName: '高级前端工程师',
  company: '某某科技',
  skills: ['Vue', 'React', 'TypeScript', 'Webpack'],
  labels: ['3-5年', '本科'],
  experience: '3-5年',
  degree: '本科',
  description: '负责前端架构，要求熟悉 Vue/React、TypeScript、Webpack，有性能优化经验。',
};

const BACKEND_JOB = {
  jobId: 'def456',
  jobName: 'Java 后端工程师',
  company: '某银行',
  skills: ['Java', 'Spring', 'MySQL', 'Redis'],
  labels: ['3-5年', '本科'],
  experience: '3-5年',
  degree: '本科',
  description: '负责核心交易系统，要求 Java、Spring、MySQL、Redis，熟悉分布式事务。',
};

await test('城市解析：中文名、带“市”、编码、未知值回退', () => {
  assert.equal(resolveCity('杭州'), CITIES.杭州);
  assert.equal(resolveCity('杭州市'), CITIES.杭州);
  assert.equal(resolveCity('101210100'), '101210100');
  assert.equal(resolveCity('不存在城市', '101010100'), '101010100');
  assert.equal(cityLabel('101210100'), '杭州');
});

await test('配置：默认值、端口越界回退、allowSend 解析', () => {
  const { config } = resolveConfig({ dataDir: 'C:/tmp/boss-test' });
  assert.equal(config.maxJobs, 30);
  assert.equal(config.allowSend, true);
  assert.ok(config.port >= 1 && config.port <= 65535);

  const bad = resolveConfig({ port: 70000, dataDir: 'C:/tmp/boss-test' }).config;
  assert.ok(bad.port <= 65535, '越界端口应回退到默认值');

  assert.equal(resolveConfig({ allowSend: 'false' }).config.allowSend, false);
  assert.equal(resolveConfig({ allowSend: 'no' }).config.allowSend, false);
  assert.equal(resolveConfig({ allowSend: 'maybe' }).config.allowSend, true);
});

await test('简历解析：姓名、技能、学历、年限、分段', () => {
  const resume = buildResume({ text: RESUME_TEXT });
  assert.equal(resume.name, '张三');
  assert.equal(resume.degree, '本科');
  assert.ok(resume.skills.includes('Vue'));
  assert.ok(resume.skills.includes('TypeScript'));
  assert.ok(resume.years >= 5 && resume.years <= 7, `年限应在 5~7 之间，实际 ${resume.years}`);
  assert.ok(resume.highlights.length > 0);
  assert.ok(splitSections(RESUME_TEXT).skills.includes('React'));
});

await test('技能抽取不受大小写和别名影响', () => {
  assert.deepEqual(extractSkills('我会 react 和 k8s'), ['React', 'Kubernetes']);
  assert.equal(estimateYears('3年以上经验'), 3);
  assert.equal(parseExperience('3-5年').min, 3);
  assert.equal(parseExperience('经验不限').max, 99);
});

await test('英文技能按词边界匹配：java ≠ javascript', () => {
  const js = extractSkills('熟练使用 JavaScript 开发');
  assert.ok(js.includes('JavaScript'));
  assert.ok(!js.includes('Java'), 'JavaScript 不应命中 Java');

  const java = extractSkills('3 年 Java 后端经验，熟悉 Spring');
  assert.ok(java.includes('Java'));
  assert.ok(!java.includes('JavaScript'));

  const cpp = extractSkills('熟悉 C++ 与 Node.js');
  assert.ok(cpp.includes('C++'));
  assert.ok(cpp.includes('Node.js'));
});

await test('姓名抽取不会把段落标题或句子片段当成名字', () => {
  const noName = buildResume({
    text: `个人优势\n5 年前端开发经验，做过性能优化和组件库建设。\n专业技能\nVue、React`,
  });
  assert.equal(noName.name, '');
  const message = draftIntro(noName, { jobName: '前端工程师', skills: ['Vue'] });
  assert.ok(message.startsWith('您好，'), message);
  assert.ok(!message.includes('我是个人优势'), message);

  const sentence = buildResume({
    text: `示例候选人\n前端开发工程师\n个人优势\n6 年经验，主导过系统从 0 到 1 的搭建，做过优化。`,
  });
  assert.notEqual(sentence.name, '的搭建');
});

await test('年限识别：10 余年 / 10年以上 / 表头 10年', () => {
  assert.equal(estimateYears('10 余年 IT 运维经验'), 10);
  assert.equal(estimateYears('10年以上工作经验'), 10);
  assert.equal(estimateYears('王硕\n本科 · 10年经验 · 33岁\n个人优势\n做过运维'), 10);
  assert.equal(estimateYears('本科 · 10年 · 33岁'), 10);
  assert.equal(estimateYears('没有任何年限信息'), 0);
});

await test('匹配打分：对口岗位高、跨方向岗位低', () => {
  const resume = buildResume({ text: RESUME_TEXT });
  const front = scoreJob(resume, FRONTEND_JOB);
  const back = scoreJob(resume, BACKEND_JOB);
  assert.ok(front.score > back.score, `前端 ${front.score} 应高于后端 ${back.score}`);
  assert.ok(front.score >= 70, `对口岗位分数偏低：${front.score}`);
  assert.ok(front.matched.includes('Vue'));
  assert.ok(back.missing.includes('Java'));
});

await test('匹配门槛：高于门槛才保留', () => {
  const resume = buildResume({ text: RESUME_TEXT });
  const all = rankJobs(resume, [FRONTEND_JOB, BACKEND_JOB], { minScore: 0 });
  assert.equal(all.length, 2);
  const strict = rankJobs(resume, [FRONTEND_JOB, BACKEND_JOB], { minScore: 80 });
  assert.ok(strict.every((item) => item.score >= 80));
  const loose = rankJobs(resume, [FRONTEND_JOB, BACKEND_JOB], { minScore: 30 });
  assert.ok(loose.length >= strict.length);
});

await test('单标签岗位不会被捧成满分', () => {
  const resume = buildResume({ text: RESUME_TEXT });
  const thin = { jobName: '前端工程师', skills: ['Vue'], labels: [], degree: '本科', experience: '3-5年', description: '' };
  const scored = scoreJob(resume, thin);
  assert.ok(scored.score <= 80, `只有一个技能的岗位不该拿高分，实际 ${scored.score}`);
});

await test('年限/学历/福利标签不算技能缺口', () => {
  const resume = buildResume({ text: RESUME_TEXT });
  const job = {
    jobName: '前端工程师',
    skills: ['Vue'],
    labels: ['3-5年', '本科', '五险一金', '年终奖'],
    degree: '本科',
    experience: '3-5年',
    description: '',
  };
  const scored = scoreJob(resume, job);
  for (const noise of ['3-5年', '本科', '五险一金', '年终奖']) {
    assert.ok(!scored.missing.includes(noise), `「${noise}」不该出现在技能缺口里`);
  }
});

await test('分数构成稳定：各维度加起来等于总分', () => {
  const resume = buildResume({ text: RESUME_TEXT });
  const scored = scoreJob(resume, FRONTEND_JOB);
  const details = Object.values(scored.details ?? {}).map(Number);
  const sum = details.reduce((total, value) => total + value, 0);
  assert.equal(Math.round(sum), scored.score);
});

await test('文案：包含真实信息、无占位符、长度可控', () => {
  const resume = buildResume({ text: RESUME_TEXT });
  const message = draftIntro(resume, FRONTEND_JOB);
  assert.ok(message.includes('张三'));
  assert.ok(/Vue|React|TypeScript/.test(message));
  assert.ok(!/[{}<>]|xxx|你的名字/i.test(message));
  assert.ok(message.length >= 40 && message.length <= 180, `文案长度 ${message.length}`);
});

await test('文案校验：占位符、链接、超长', () => {
  assert.equal(checkMessage('您好，我是张三。').ok, true);
  assert.equal(checkMessage('您好，我是{name}').ok, false);
  assert.equal(checkMessage('您好，详情见 https://example.com').ok, false);
  assert.equal(checkMessage('您好' + '很长的内容'.repeat(60)).ok, false);
});

await test('职位归一化：jobId 能拼出详情链接', () => {
  const job = normalizeJob({
    encryptJobId: 'enc-1',
    jobName: '前端',
    salaryDesc: '20-30K',
    brandName: '某公司',
    securityId: 'sec-1',
    lid: 'lid-1',
  });
  assert.equal(job.jobId, 'enc-1');
  assert.equal(job.encryptJobId, 'enc-1');
  assert.ok(job.url.includes('/job_detail/enc-1.html'));
  assert.ok(job.url.includes('securityId=sec-1'));
  // 只给 jobId（检索结果的字段名）也要能用
  assert.ok(jobDetailUrl({ jobId: 'enc-2' }).includes('enc-2'));
  assert.throws(() => jobDetailUrl({}), /jobId|encryptJobId/);
});

await test('年份码：中文标签与三位码互认（101=经验不限 … 107=10年以上）', () => {
  assert.equal(resolveExperience('经验不限'), '101');
  assert.equal(resolveExperience('在校/应届'), '102');
  assert.equal(resolveExperience('1年以内'), '103');
  assert.equal(resolveExperience('1-3年'), '104');
  assert.equal(resolveExperience('3-5年'), '105');
  assert.equal(resolveExperience('5-10年'), '106');
  assert.equal(resolveExperience('10年以上'), '107');
  // 带空格、带 ~ 的写法要能归一
  assert.equal(resolveExperience('1-3 年'), '104');
  assert.equal(resolveExperience('5~10年'), '106');
  // 已经是三位码就原样透传
  assert.equal(resolveExperience('106'), '106');
  // 空值与未知值不编造
  assert.equal(resolveExperience(''), '');
  assert.equal(resolveExperience(undefined), '');
});

await test('风险提示：驻外岗位打标、低薪高龄提示，避免「100 分但只有 12K」', () => {
  const senior = buildResume({ text: `李四\n本科 · 12年经验\n个人优势\n12 年 Linux 运维经验，熟悉 K8s、Docker。` });
  const overseas = scoreJob(senior, {
    jobName: '资深运维工程师（驻马来西亚）',
    skills: ['K8s', 'Docker'],
    labels: ['5-10年', '本科'],
    description: '负责海外数据中心运维，常驻马来西亚。',
    salary: '20-25K',
  });
  assert.equal(overseas.overseas, true);
  assert.ok(overseas.risks.some((risk) => risk.includes('海外')), JSON.stringify(overseas.risks));

  const lowPaid = scoreJob(senior, {
    jobName: '运维工程师',
    skills: ['K8s', 'Docker'],
    labels: ['5-10年', '本科'],
    description: '',
    salary: '8-12K',
  });
  assert.ok(lowPaid.risks.some((risk) => risk.includes('薪资上限')), JSON.stringify(lowPaid.risks));
  assert.ok(lowPaid.score >= 75, '低薪岗位分数依然会高，所以才需要风险提示');

  const local = scoreJob(senior, {
    jobName: '运维工程师',
    skills: ['K8s'],
    labels: ['5-10年', '本科'],
    description: '',
    salary: '20-30K',
  });
  assert.equal(local.overseas, false);
  assert.ok(!local.risks.some((risk) => risk.includes('薪资上限')));
});

await test('详情解析：补齐 jobId 与 securityId，保证能拼出可点击的详情链接', () => {
  const payload = {
    zpData: {
      jobInfo: {
        jobName: '运维工程师',
        salaryDesc: '15-25K',
        postDescription: '负责 Linux 运维',
        address: '广州',
      },
      bossInfo: { name: '苏女士', title: '招聘专员', activeTimeDesc: '刚刚活跃' },
      brandComInfo: { brandName: '某某科技', scaleName: '1000-9999人' },
    },
  };
  const job = parseJobDetail(payload, { encryptJobId: 'enc-9', securityId: 'sec-9', lid: 'lid-9' });
  assert.equal(job.jobId, 'enc-9');
  assert.equal(job.securityId, 'sec-9');
  assert.equal(job.lid, 'lid-9');
  assert.ok(job.url.includes('securityId=sec-9'), job.url);
  assert.ok(job.url.includes('lid=lid-9'), job.url);
  assert.equal(job.description, '负责 Linux 运维');
  assert.equal(job.hrName, '苏女士');
});

await test('工具定义：12 个、名称唯一、schema 合法', () => {
  const dir = path.join(os.tmpdir(), `boss-tools-${Date.now()}`);
  const store = new Store(dir);
  const tools = buildTools({ dataDir: dir, port: 9555 }, store);
  assert.equal(tools.length, 12);
  const names = tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 20);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.isConcurrencySafe, 'function');
  }
  assert.ok(names.includes('boss_preferences'));
});

await test('偏好：读写门槛并夹在 0~100', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boss-prefs-'));
  const store = new Store(dir);
  assert.equal((await store.getPrefs()).minScore, DEFAULT_MIN_SCORE);

  const saved = await store.setPrefs({ query: '运维', city: '101280100', minScore: 75 });
  assert.equal(saved.query, '运维');
  assert.equal(saved.city, '101280100');
  assert.equal(saved.minScore, 75);

  assert.equal((await store.setPrefs({ minScore: 140 })).minScore, 100);
  assert.equal((await store.setPrefs({ minScore: -5 })).minScore, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

await test('工具返回值可无损序列化（不允许 undefined/NaN）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boss-json-'));
  const store = new Store(dir);
  await store.addHistory({ jobId: 'x1', jobName: '前端', company: 'A', message: 'hi', status: 'sent' });
  const tools = buildTools(
    {
      dataDir: dir,
      port: 9481,
      allowSend: true,
      dailyGreetLimit: 30,
      minIntervalMs: 20000,
      maxPerRun: 5,
      maxJobs: 30,
      city: '101010100',
      chatReadyTimeoutMs: 5000,
      loginWaitSeconds: 1,
      screenshotOnError: false,
    },
    store,
  );

  const unsafe = (value, trail = '$') => {
    if (value === undefined) return trail;
    if (typeof value === 'number' && !Number.isFinite(value)) return trail;
    if (typeof value === 'function') return trail;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const found = unsafe(value[i], `${trail}[${i}]`);
        if (found) return found;
      }
      return null;
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        const found = unsafe(item, `${trail}.${key}`);
        if (found) return found;
      }
    }
    return null;
  };

  // 只跑不依赖浏览器的工具；需要浏览器的会连端口 9481 而失败，跳过
  const offline = ['boss_status', 'boss_resume', 'boss_history', 'boss_preferences'];
  for (const tool of tools.filter((item) => offline.includes(item.name))) {
    const out = await tool.execute({ action: 'get' }, {}).catch(() => null);
    if (out === null) continue;
    assert.equal(unsafe(out), null, `${tool.name} 输出里出现了不可序列化的值`);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

await test('greet 默认 dry_run，且允许关闭发送', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boss-greet-'));
  // 用一个几乎不可能被占用的端口，避免连到用户正在用的调试浏览器
  const { config } = resolveConfig({ dataDir: dir, port: 9481 });
  const store = new Store(dir);
  const tools = buildTools({ ...config, port: 9481 }, store);
  const greet = tools.find((tool) => tool.name === 'boss_greet');

  const out = await greet
    .execute({ job_id: 'not-exist' }, {})
    .catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
  assert.ok(out.ok === false || out.dryRun === true, '默认调用不应真的发送');

  const blocked = await greet
    .execute({ job_id: 'not-exist', dry_run: false, message: '您好' }, {})
    .catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
  assert.equal(blocked.ok, false);
  await fs.rm(dir, { recursive: true, force: true });
});

await test('文档与代码一致：README 工具表覆盖全部工具，配置表覆盖全部配置键', async () => {
  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boss-doc-'));
  const store = new Store(dir);
  const { config } = resolveConfig({ dataDir: dir, port: 9481 });
  const tools = buildTools({ ...config, port: 9481 }, store);
  const missingTools = tools.map((tool) => tool.name).filter((name) => !readme.includes(`\`${name}\``));
  assert.deepEqual(missingTools, [], `README 缺少这些工具：${missingTools.join(', ')}`);

  const { config: defaults } = resolveConfig({ dataDir: dir });
  const missingKeys = Object.keys(defaults).filter((key) => !readme.includes(`\`${key}\``));
  assert.deepEqual(missingKeys, [], `README 缺少这些配置键：${missingKeys.join(', ')}`);
  await fs.rm(dir, { recursive: true, force: true });
});

console.log('');
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} failed`);
  for (const failure of failures) console.log(`\n--- ${failure.name}\n${failure.error?.stack ?? failure.error}`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
