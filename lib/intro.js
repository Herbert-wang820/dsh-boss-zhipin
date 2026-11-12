/**
 * 打招呼文案草稿。
 *
 * 这里只做「不依赖模型也能用」的兜底模板：从简历里挑真正存在的经历和技能，
 * 拼一段 100~180 字、像人写的第一人称介绍。实际使用时，模型可以基于
 * boss_match_jobs 的证据自己写更贴岗位的版本，再把文本传给 boss_greet。
 *
 * 硬规则：不编造简历里没有的公司/项目/数字；文案里不出现占位符。
 */

function clean(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[。；;，,]{2,}/g, '。')
    .trim();
}

/** 这些是软技能，放进「技术栈/熟悉」里读起来很怪。 */
const SOFT_SKILLS = new Set(['项目管理', '团队管理', '跨部门协作', '英语', '敏捷开发', '产品设计', '算法', '数据分析']);

/**
 * 判断简历属于哪个方向。给了 job 时优先选「和岗位重叠」的那个方向，
 * 避免简历里同时有「运维」和「大模型」时被写成「10 年算法经验」。
 */
function roleText(resume, job) {
  const skills = resume?.skills ?? [];
  const has = (names) => names.some((name) => skills.includes(name));
  const candidates = [];
  if (has(['运维', 'CMDB', 'ITSM', '监控告警', 'Linux'])) candidates.push('运维');
  if (has(['测试'])) candidates.push('测试');
  if (has(['React', 'Vue', 'TypeScript', 'HTML5'])) candidates.push('前端开发');
  if (has(['Java', 'Go', 'Python', 'Node.js'])) candidates.push('后端开发');
  if (has(['Android', 'iOS', 'Flutter'])) candidates.push('移动端开发');
  if (has(['机器学习', '深度学习', '大模型'])) candidates.push('算法');
  if (has(['数据分析', 'SQL', 'Hive'])) candidates.push('数据');
  if (has(['UI/UX'])) candidates.push('设计');

  const title = String(job?.jobName ?? '');
  const preferred = candidates.find((role) => title.includes(role.replace(/开发$/, '')));
  return preferred ?? candidates[0] ?? '';
}

/**
 * 从简历亮点里取一句能直接说出口的话：
 * 去掉「专业能力：」这类小标题，跳过「10 余年经验」这种和第一句重复的开头，
 * 在第一个句号/分号处截断，控制在一句话的长度内。
 */
function firstUsefulClause(line) {
  let text = String(line ?? '')
    .replace(/^[^：:]{1,8}[：:]\s*/, '')
    .trim();
  const clauses = text.split(/[，,。；;]/).map((item) => item.trim()).filter(Boolean);
  const useful = clauses.find((clause) => !/^[0-9一二三四五六七八九十]+\s*[余多]?\s*年/.test(clause));
  if (!useful) return '';
  const clause = useful.length > 46 ? `${useful.slice(0, 44)}…` : useful;
  return clause.replace(/[。；;]$/, '');
}

function pickHighlight(resume, job) {
  const highlights = resume?.highlights ?? [];
  if (!highlights.length) return '';
  const jobWords = `${job?.jobName ?? ''} ${(job?.skills ?? []).join(' ')} ${job?.description ?? ''}`.toLowerCase();
  const scored = highlights
    .map((line) => {
      let hits = 0;
      for (const skill of resume?.skills ?? []) {
        if (jobWords.includes(skill.toLowerCase()) && line.toLowerCase().includes(skill.toLowerCase())) hits += 2;
      }
      hits += (job?.skills ?? []).filter((skill) => line.includes(String(skill))).length;
      return { clause: firstUsefulClause(line), hits };
    })
    .filter((item) => item.clause)
    .sort((a, b) => b.hits - a.hits);
  return scored[0]?.clause ?? '';
}

/**
 * 生成一段自我介绍草稿。
 * @param {object} resume 结构化简历
 * @param {object} job 职位（含 jobName/company/skills/description）
 * @param {{maxChars?: number, extra?: string}} [options]
 */
export function draftIntro(resume, job, { maxChars = 180, extra } = {}) {
  if (!resume) throw new Error('还没有简历：先调用 boss_resume 保存简历');
  if (!job) throw new Error('缺少职位信息');

  const name = resume.name ? String(resume.name) : '';
  const years = Number(resume.years ?? 0);
  const role = roleText(resume, job);
  const pieces = [];

  // 没有识别出姓名时不要硬塞「我是」，否则会变成「我是有 6 年经验的」这种病句。
  const who = name ? `我是${name}，` : '';
  const exp = years >= 1 ? `有 ${Math.round(years)} 年` : '';
  pieces.push(`您好，${who}${exp}${role ? `${role}` : ''}经验。`);

  const matched = (job.skills ?? []).filter((skill) => (resume.skills ?? []).includes(skill));
  const pool = (matched.length ? matched : (resume.skills ?? [])).filter((skill) => !SOFT_SKILLS.has(skill));
  const topSkills = pool.slice(0, 3);
  if (topSkills.length) {
    pieces.push(`日常主要涉及 ${topSkills.join('、')}，和这个岗位的要求重合度比较高。`);
  } else if (job.jobName) {
    pieces.push(`看到贵司在招 ${job.jobName}，和我的经历方向比较一致。`);
  }

  const highlight = pickHighlight(resume, job);
  if (highlight) pieces.push(`另外，${highlight}。`);

  if (extra) pieces.push(clean(extra));
  else if (job.jobName) {
    // 岗位名里常带空格/括号/技术要求，句子中引用时截短一点
    const title = String(job.jobName).trim().replace(/\s+/g, ' ');
    const short = title.length > 20 ? `${title.slice(0, 20)}…` : title;
    pieces.push(`想详细了解一下${short}这个岗位，如果方便的话希望和您聊聊。`);
  }

  let text = clean(pieces.join(''));
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars - 1)}…`;
  }
  return text;
}

/** 发送前的安全检查：空、过长、含占位符、疑似群发痕迹。 */
export function checkMessage(message, { maxChars = 300 } = {}) {
  const text = clean(message);
  const problems = [];
  if (!text) problems.push('文案为空');
  if (text.length > maxChars) problems.push(`文案 ${text.length} 字，超过 ${maxChars} 字上限，BOSS 输入框可能截断`);
  const placeholders = ['{', '}', '{{', '[姓名]', 'XXX', 'xxx', '公司名', '职位名'];
  const hit = placeholders.find((token) => text.includes(token));
  if (hit) problems.push(`文案里还有占位符「${hit}」，请替换成真实内容`);
  if (/https?:\/\//.test(text)) problems.push('文案里带了链接，容易被判定为营销');
  return { ok: problems.length === 0, problems, text };
}
