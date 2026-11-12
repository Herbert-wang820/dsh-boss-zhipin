/**
 * 简历 ↔ 职位匹配打分。
 *
 * 目标不是"精确预测面试"，而是在几十个岗位里稳定地把「值得打招呼的」排到前面，
 * 并给出可解释的证据（命中技能 / 缺口 / 风险），让模型写介绍时有据可依。
 *
 * 分数构成（满分 100）：
 *   技能覆盖 45 + 岗位方向 20 + 年限匹配 15 + 学历匹配 10 + JD 关键词覆盖 10
 */
import { extractSkills } from './resume.js';

const DEGREE_RANK = { 高中: 0, 中专: 0, 大专: 1, 本科: 2, 硕士: 3, 博士: 4 };

/** 方向词：用于判断「前端」「后端」「算法」这类岗位方向是否对得上。 */
const ROLE_WORDS = [
  ['前端', ['前端', 'web前端', 'frontend', 'h5', '小程序', 'react', 'vue']],
  ['后端', ['后端', '服务端', 'backend', 'java', 'golang', 'python', 'node']],
  ['全栈', ['全栈', 'full stack', 'fullstack']],
  ['移动端', ['android', 'ios', '客户端', '移动端', 'flutter', 'react native']],
  ['算法', ['算法', '机器学习', '深度学习', 'nlp', 'cv', '推荐系统']],
  ['数据', ['数据分析', '数据开发', '大数据', '数仓', 'etl', 'bi']],
  ['测试', ['测试', 'qa', '自动化测试']],
  ['运维', ['运维', 'sre', 'devops', 'kubernetes']],
  ['产品', ['产品经理', '产品设计', 'product manager']],
  ['设计', ['ui', 'ux', '视觉设计', '交互设计']],
  ['运营', ['运营', '增长', '内容运营', '用户运营']],
  ['项目管理', ['项目经理', '项目管理', 'pmp']],
];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function parseExperience(text) {
  const source = String(text ?? '');
  if (!source) return { min: 0, max: 99, raw: '' };
  if (/不限|无要求|经验不限/.test(source)) return { min: 0, max: 99, raw: source };
  if (/应届|在校|实习/.test(source)) return { min: 0, max: 1, raw: source };
  const range = /(\d+(?:\.\d+)?)\s*[-~—至]\s*(\d+(?:\.\d+)?)\s*年/.exec(source);
  if (range) return { min: Number(range[1]), max: Number(range[2]), raw: source };
  const above = /(\d+(?:\.\d+)?)\s*年(?:以上|及以上|\+)/.exec(source);
  if (above) return { min: Number(above[1]), max: 99, raw: source };
  const below = /(\d+(?:\.\d+)?)\s*年(?:以内|以下)/.exec(source);
  if (below) return { min: 0, max: Number(below[1]), raw: source };
  return { min: 0, max: 99, raw: source };
}

export function roleOf(text) {
  const haystack = String(text ?? '').toLowerCase();
  const hits = ROLE_WORDS.filter(([, words]) => words.some((word) => haystack.includes(word))).map(([role]) => role);
  return hits;
}

/** 常驻海外的信号词：命中就在风险里标出来。 */
const OVERSEAS = /驻外|海外|外派|出国|马来西亚|新加坡|日本|韩国|东南亚|欧美|迪拜|沙特|港澳/;

/** 标签里混着年限、学历、福利，这些不是技能，算进覆盖率会压低分数并污染「缺口」。 */const NON_SKILL_LABEL =
  /^\s*(?:\d+(?:-\d+)?年|经验不限|在校\s*\/?\s*应届|应届|本科|大专|硕士|博士|高中|中专|五险一金|年终奖|双休|周末双休|年假|带薪年假|团建|团建聚餐|体检|定期体检|补充医疗|补充医疗保险|节日福利|绩效奖金|股票期权|期权|补贴|餐补|房补|交通补助|免费班车|员工旅游|零食|零食下午茶|下午茶|弹性工作|不加班|六险一金)\s*$/;

export function jobSkillSet(job) {
  const set = new Set();
  for (const item of [...(job.skills ?? []), ...(job.labels ?? [])]) {
    const text = String(item ?? '').trim();
    if (!text || NON_SKILL_LABEL.test(text)) continue;
    const matched = extractSkills(text);
    if (matched.length) matched.forEach((skill) => set.add(skill));
    else set.add(text);
  }
  const fromDescription = extractSkills([job.description, job.requirement].filter(Boolean).join('\n'));
  fromDescription.forEach((skill) => set.add(skill));
  return set;
}

function skillScore(resumeSkills, jobSkills) {
  if (!jobSkills.size) return { ratio: 0.35, matched: [], missing: [], note: '岗位没有技能标签，技能分按保守值处理' };
  const resume = new Set(resumeSkills);
  const matched = [...jobSkills].filter((skill) => resume.has(skill));
  const missing = [...jobSkills].filter((skill) => !resume.has(skill));
  const ratio = matched.length / jobSkills.size;
  // 岗位只写了 1~2 个标签时，命中一个就等于 100%，会把「运维」这种大词捧成满分。
  // 要求越少，覆盖率越不可信，做一次上限压缩（1 个标签最多算 0.6，2 个最多 0.8）。
  const ceiling = jobSkills.size === 1 ? 0.6 : jobSkills.size === 2 ? 0.8 : 1;
  return { ratio: Math.min(ratio, ceiling), matched, missing, note: jobSkills.size <= 2 ? `岗位技能标签只有 ${jobSkills.size} 个，覆盖率已按上限折算` : '' };
}

function titleScore(job, resume) {
  const resumeRoles = new Set(roleOf([resume?.text, ...(resume?.skills ?? [])].join(' ')));
  const jobRoles = roleOf(`${job.jobName} ${(job.skills ?? []).join(' ')}`);
  if (!jobRoles.length) return { ratio: 0.5, overlap: [], note: '岗位方向不明确，按中性分处理' };
  const overlap = jobRoles.filter((role) => resumeRoles.has(role));
  if (overlap.length) return { ratio: 1, overlap, note: '' };
  // 方向不同但有关联（如前端 vs 全栈）给一点分
  const adjacent = jobRoles.some((role) => (role === '全栈' && resumeRoles.size) || (role === '移动端' && resumeRoles.has('前端')));
  return { ratio: adjacent ? 0.5 : 0.15, overlap: [], note: adjacent ? '岗位方向相近' : '岗位方向与简历差异较大' };
}

function experienceScore(job, resume) {
  const requirement = parseExperience(job.experience);
  const years = Number(resume?.years ?? 0);
  if (requirement.max === 99 && requirement.min === 0) return { ratio: 1, note: '' };
  if (years >= requirement.min && years <= requirement.max) return { ratio: 1, note: '' };
  if (years < requirement.min) {
    const gap = requirement.min - years;
    return {
      ratio: clamp(1 - gap / Math.max(requirement.min, 1), 0, 1),
      risk: `经验可能不足：岗位要求${job.experience || `${requirement.min}年以上`}，简历约 ${years} 年`,
      note: '',
    };
  }
  const over = years - requirement.max;
  return {
    ratio: clamp(1 - over / 10, 0.4, 1),
    risk: `经验高于岗位区间：岗位${job.experience}，简历约 ${years} 年（可能薪资不匹配）`,
    note: '',
  };
}

function degreeScore(job, resume) {
  const need = String(job.degree ?? '').match(/博士|硕士|本科|大专|高中/)?.[0];
  const have = String(resume?.degree ?? '').match(/博士|硕士|本科|大专|高中/)?.[0];
  if (!need || /不限/.test(String(job.degree))) return { ratio: 1, note: '' };
  if (!have) return { ratio: 0.6, note: '简历未识别到学历，按中性偏低处理' };
  const needRank = DEGREE_RANK[need] ?? 2;
  const haveRank = DEGREE_RANK[have] ?? 2;
  if (haveRank >= needRank) return { ratio: 1, note: '' };
  return {
    ratio: clamp(1 - (needRank - haveRank) * 0.35, 0, 1),
    risk: `学历要求${need}，简历为${have}`,
    note: '',
  };
}

/**
 * 给单个职位打分。
 * @returns {{score:number, grade:string, matched:string[], missing:string[], reasons:string[], risks:string[]}}
 */
export function scoreJob(resume, job) {
  const resumeSkills = resume?.skills ?? [];
  const jobSkills = jobSkillSet(job);
  const skill = skillScore(resumeSkills, jobSkills);
  const title = titleScore(job, resume);
  const exp = experienceScore(job, resume);
  const degree = degreeScore(job, resume);

  const resumeSkillSet = new Set(resumeSkills);
  const jdSkills = new Set(extractSkills([job.description, job.requirement].filter(Boolean).join('\n')));
  const jdCoverage = jdSkills.size ? [...jdSkills].filter((skill) => resumeSkillSet.has(skill)).length / jdSkills.size : 0.5;

  const score = Math.round(
    clamp(skill.ratio, 0, 1) * 45 +
      clamp(title.ratio, 0, 1) * 20 +
      clamp(exp.ratio, 0, 1) * 15 +
      clamp(degree.ratio, 0, 1) * 10 +
      clamp(jdCoverage, 0, 1) * 10,
  );

  const reasons = [];
  if (skill.matched.length) reasons.push(`技能命中：${skill.matched.slice(0, 8).join('、')}`);
  if (title.overlap.length) reasons.push(`岗位方向一致：${title.overlap.join('、')}`);
  if (exp.ratio === 1 && job.experience) reasons.push(`经验匹配：${job.experience}（简历约 ${resume?.years ?? 0} 年）`);
  if (degree.ratio === 1 && job.degree && !/不限/.test(job.degree)) reasons.push(`学历满足：${job.degree}`);
  if (!reasons.length) reasons.push(title.note || skill.note || '信息有限，按简历与 JD 的关键词重合度估算');

  const risks = [skill.missing.length ? `技能缺口：${skill.missing.slice(0, 8).join('、')}` : '', exp.risk ?? '', degree.risk ?? ''].filter(Boolean);

  // 常驻海外的岗位（标题或 JD 里写了驻外/海外/马来西亚…）单独标出来：
  // 用户只想看本地机会时，可以用它一眼跳过。
  const overseas = OVERSEAS.test(`${job?.jobName ?? ''} ${job?.district ?? ''} ${job?.description ?? ''}`);
  if (overseas) risks.unshift('岗位可能常驻海外/驻外（标题或 JD 提到海外地点）');

  // 分数只看「简历 vs JD 文本」，不含薪资/职级：老手投低薪岗位会拿高分，反而该提醒一句。
  const salaryMax = parseSalaryMax(job?.salary);
  if (salaryMax && (resume?.years ?? 0) >= 8 && salaryMax <= 12) {
    risks.push(`薪资上限约 ${salaryMax}K，和 ${resume.years} 年经验的期望可能不匹配`);
  }

  const grade = score >= 75 ? '强匹配' : score >= 60 ? '可投递' : score >= 45 ? '一般' : '不建议';

  return {
    score,
    grade,
    overseas,
    matched: skill.matched,
    missing: skill.missing,
    reasons,
    risks,
    details: {
      skill: Math.round(clamp(skill.ratio, 0, 1) * 45),
      direction: Math.round(clamp(title.ratio, 0, 1) * 20),
      experience: Math.round(clamp(exp.ratio, 0, 1) * 15),
      degree: Math.round(clamp(degree.ratio, 0, 1) * 10),
      jd: Math.round(clamp(jdCoverage, 0, 1) * 10),
    },
  };
}

/** 从「15-25K·14薪」「7-9K」里取出上限（K），取不到返回 0。 */
function parseSalaryMax(salary) {
  const text = String(salary ?? '');
  const matches = [...text.matchAll(/(\d{1,3})\s*[-~—]?\s*(\d{1,3})?\s*[Kk]/g)];
  if (!matches.length) return 0;
  const last = matches[matches.length - 1];
  return Number(last[2] ?? last[1]) || 0;
}

/** 批量打分并按分数排序。 */
export function rankJobs(resume, jobs, { minScore = 0 } = {}) {
  return jobs
    .map((job) => ({ job, ...scoreJob(resume, job) }))
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score);
}
