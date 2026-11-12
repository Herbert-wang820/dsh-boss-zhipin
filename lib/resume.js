/**
 * 简历解析：把 .txt / .md / .docx / .json 或直接粘贴的文本，整理成
 * 「原文 + 分段 + 技能 + 年限 + 学历 + 亮点」的结构，供匹配和写介绍使用。
 *
 * .docx 用 node:zlib 手工解 zip（只取 word/document.xml），不引第三方包。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const SECTION_PATTERNS = [
  ['summary', /^(个人优势|自我评价|个人简介|个人总结|关于我|自我介绍|简介)/],
  ['intent', /^(求职意向|期望职位|期望工作|职业意向)/],
  ['skills', /^(专业技能|技能特长|技能清单|技术栈|技能|专业能力)/],
  ['experience', /^(工作经历|工作经验|职业经历|实习经历|工作履历)/],
  ['projects', /^(项目经历|项目经验|项目介绍|主要项目)/],
  ['education', /^(教育经历|教育背景|学历|教育)/],
  ['awards', /^(荣誉奖项|获奖经历|证书|资格证书|荣誉)/],
  ['other', /^(其他|补充|兴趣爱好)/],
];

/** 技能词典：中文名 + 英文别名，匹配时统一小写。 */
const SKILLS = [
  ['JavaScript', ['javascript', 'js', 'es6', 'ecmascript']],
  ['TypeScript', ['typescript', 'ts']],
  ['React', ['react', 'react.js', 'reactjs']],
  ['Vue', ['vue', 'vue.js', 'vuejs', 'vue2', 'vue3']],
  ['Angular', ['angular', 'angularjs']],
  ['Node.js', ['node.js', 'nodejs', 'node']],
  ['Next.js', ['next.js', 'nextjs']],
  ['Nuxt', ['nuxt', 'nuxt.js']],
  ['Webpack', ['webpack']],
  ['Vite', ['vite']],
  ['Rollup', ['rollup']],
  ['HTML5', ['html5', 'html']],
  ['CSS3', ['css3', 'css']],
  ['Sass/Less', ['sass', 'scss', 'less']],
  ['Tailwind CSS', ['tailwind']],
  ['小程序', ['小程序', 'miniprogram', 'uni-app', 'uniapp', 'taro']],
  ['Flutter', ['flutter', 'dart']],
  ['React Native', ['react native', 'react-native']],
  ['Android', ['android', 'jetpack compose']],
  ['iOS', ['ios', 'swift', 'objective-c', 'objc']],
  ['Java', ['java', 'spring', 'springboot', 'spring boot', 'spring cloud']],
  ['Go', ['golang', 'go语言', ' go ']],
  ['Python', ['python', 'django', 'flask', 'fastapi']],
  ['C++', ['c++', 'cpp']],
  ['C#', ['c#', 'csharp', '.net', 'dotnet']],
  ['Rust', ['rust']],
  ['PHP', ['php', 'laravel', 'thinkphp']],
  ['Ruby', ['ruby', 'rails']],
  ['Kotlin', ['kotlin']],
  ['Scala', ['scala']],
  ['Shell', ['shell', 'bash', 'linux']],
  ['MySQL', ['mysql']],
  ['PostgreSQL', ['postgresql', 'postgres', 'pgsql']],
  ['MongoDB', ['mongodb', 'mongo']],
  ['Redis', ['redis']],
  ['Elasticsearch', ['elasticsearch', 'es搜索引擎']],
  ['Kafka', ['kafka']],
  ['RabbitMQ', ['rabbitmq', 'rocketmq']],
  ['Docker', ['docker']],
  ['Kubernetes', ['kubernetes', 'k8s']],
  ['CI/CD', ['ci/cd', 'jenkins', 'gitlab ci', 'github actions']],
  ['Nginx', ['nginx']],
  ['AWS', ['aws', 'amazon web services']],
  ['阿里云', ['阿里云', 'aliyun', 'oss']],
  ['腾讯云', ['腾讯云', 'tencent cloud']],
  ['微服务', ['微服务', 'microservice', 'micro service']],
  ['分布式', ['分布式', 'distributed']],
  ['高并发', ['高并发', 'high concurrency']],
  ['性能优化', ['性能优化', '性能调优', 'performance']],
  ['架构设计', ['架构设计', '架构', 'architecture']],
  ['数据可视化', ['数据可视化', 'echarts', 'd3', 'three.js', 'threejs', 'webgl']],
  ['Canvas', ['canvas']],
  ['机器学习', ['机器学习', 'machine learning', 'ml']],
  ['深度学习', ['深度学习', 'deep learning']],
  ['PyTorch', ['pytorch']],
  ['TensorFlow', ['tensorflow']],
  ['大模型', ['大模型', 'llm', 'gpt', 'transformer', 'rag']],
  ['数据分析', ['数据分析', 'data analysis', 'pandas', 'numpy']],
  ['SQL', ['sql', '写sql']],
  ['Hive', ['hive']],
  ['Spark', ['spark']],
  ['Flink', ['flink']],
  ['ETL', ['etl', '数据仓库', '数仓']],
  ['产品设计', ['产品设计', 'prd', '需求分析', 'axure']],
  ['项目管理', ['项目管理', 'project management', 'pmp']],
  ['敏捷开发', ['敏捷', 'scrum', 'agile']],
  ['UI/UX', ['ui设计', 'ux', 'figma', 'sketch', '交互设计']],
  ['测试', ['自动化测试', 'selenium', 'pytest', 'test']],
  ['运维', ['运维', 'devops', 'sre', '自动化运维', '运维开发']],
  ['CMDB', ['cmdb', '配置管理数据库']],
  ['ITSM', ['itsm', '工单系统', '服务台']],
  ['监控告警', ['监控告警', '监控', '告警', 'prometheus', 'zabbix', 'grafana', 'elk']],
  ['Linux', ['linux', 'centos', 'ubuntu', 'unix']],
  ['私有云/虚拟化', ['openstack', 'vmware', '虚拟化', 'kvm']],
  ['数据库运维', ['mysql', 'oracle', 'redis', '数据库运维']],
  ['网络', ['tcp/ip', '网络协议', '交换机', '路由', '防火墙']],
  ['网络安全', ['安全', 'security', '渗透测试']],
  ['算法', ['算法', 'algorithm', 'leetcode']],
  ['团队管理', ['团队管理', '带团队', '团队负责人', 'tech lead', 'leader']],
  ['跨部门协作', ['跨部门', '协作', '沟通协调']],
  ['英语', ['英语', 'english', 'cet-6', 'cet6', '雅思', '托福']],
];

const DEGREES = [
  ['博士', /博士|phd|doctor/],
  ['硕士', /硕士|研究生|master/],
  ['本科', /本科|学士|bachelor/],
  ['大专', /大专|专科|college/],
  ['高中', /高中|中专|职高/],
];

const SECTION_TITLES = {
  summary: '个人优势',
  intent: '求职意向',
  skills: '专业技能',
  experience: '工作经历',
  projects: '项目经历',
  education: '教育经历',
  awards: '荣誉证书',
  other: '其他',
  header: '基本信息',
};

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/** 从 docx 的 zip 里取出 word/document.xml 并转成纯文本（保留段落换行）。 */
export function extractDocxText(buffer) {
  const signature = 0x04034b50;
  let offset = 0;
  const chunks = [];
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === signature) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString('utf8');
    const dataStart = nameStart + fileNameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (name === 'word/document.xml') {
      const xml = method === 0 ? data : zlib.inflateRawSync(data);
      chunks.push(xml.toString('utf8'));
    }
    offset = dataStart + compressedSize;
  }
  if (!chunks.length) throw new Error('这个 .docx 里没有 word/document.xml，文件可能已损坏或只是改了后缀名');
  return chunks
    .join('\n')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => decodeXmlEntities(line).replace(/\s+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function readResumeFile(filePath) {
  const absolute = path.resolve(filePath);
  const ext = path.extname(absolute).toLowerCase();
  if (ext === '.docx') {
    const buffer = await fs.readFile(absolute);
    return { text: extractDocxText(buffer), source: absolute, kind: 'docx' };
  }
  if (ext === '.pdf') {
    throw new Error('暂不支持 PDF：请导出为 .docx / .md / .txt，或把简历文本直接传给 boss_resume（text 参数）');
  }
  const text = await fs.readFile(absolute, 'utf8');
  return { text, source: absolute, kind: ext.replace('.', '') || 'txt' };
}

/** 按标题把简历切成段落。没有标题的整篇算「基本信息」。 */
export function splitSections(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const sections = { header: [] };
  let current = 'header';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      sections[current]?.push('');
      continue;
    }
    // 标题行：短、且命中关键字
    const isHeading = line.length <= 24 && SECTION_PATTERNS.some(([, pattern]) => pattern.test(line.replace(/[:：\s]/g, '')));
    if (isHeading) {
      const hit = SECTION_PATTERNS.find(([, pattern]) => pattern.test(line.replace(/[:：\s]/g, '')));
      current = hit[0];
      sections[current] ??= [];
      continue;
    }
    sections[current] ??= [];
    sections[current].push(line);
  }
  const out = {};
  for (const [key, value] of Object.entries(sections)) {
    const joined = value.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (joined) out[key] = joined;
  }
  return out;
}

export function extractSkills(text) {
  const haystack = String(text ?? '').toLowerCase();
  const found = [];
  for (const [name, aliases] of SKILLS) {
    const hit = aliases.some((alias) => {
      const needle = alias.trim().toLowerCase();
      if (!needle) return false;
      // 中文别名直接子串匹配；英文别名要求词边界，否则 java 会命中 javascript、
      // go 会命中 google，匹配结果会虚高。
      if (/[^\x00-\x7f]/.test(needle)) return haystack.includes(needle);
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(haystack);
    });
    if (hit) found.push(name);
  }
  return found;
}

export function extractDegree(text) {
  const source = String(text ?? '');
  for (const [name, pattern] of DEGREES) if (pattern.test(source)) return name;
  return '';
}

/**
 * 从「2018.07-2021.09」这类区间粗略推算工作年限。
 * 传了 sections 就优先只用「工作经历」段：教育经历里的 2015-2019 会被误算成工龄。
 */
export function estimateYears(text, sections) {
  const full = String(text ?? '');
  let source = sections?.experience;
  if (!source) {
    // 没有分段信息时，至少把教育经历那一段剔掉。
    source = full;
    if (sections?.education) {
      const education = sections.education;
      if (education) source = full.split(education).join('\n');
    }
  }
  source = String(source ?? '');
  const ranges = [...source.matchAll(/((?:19|20)\d{2})\s*[.\-/年]\s*(\d{1,2})?\s*[-~—至到]\s*((?:19|20)\d{2})\s*[.\-/年]\s*(\d{1,2})?|((?:19|20)\d{2})\s*[-~—至到]\s*(至今|现在|present)/gi)];
  let months = 0;
  const now = new Date();
  for (const match of ranges) {
    if (match[1] && match[3]) {
      const start = Number(match[1]) * 12 + (Number(match[2] ?? 1) - 1);
      const end = Number(match[3]) * 12 + (Number(match[4] ?? 12) - 1);
      if (end >= start) months += end - start;
    } else if (match[5]) {
      const start = Number(match[5]) * 12;
      const end = now.getFullYear() * 12 + now.getMonth();
      if (end >= start) months += end - start;
    }
  }
  const years = months / 12;
  if (!years) {
    // 「10年经验」「10 余年经验」「10年以上工作经验」都算（“余/多”在“年”前后都可能出现）
    const explicit =
      /(\d{1,2})\s*(?:余|多|\+)?\s*年\s*(?:余|多|\+)?\s*(?:以上)?\s*(?:工作)?经验/.exec(source) ??
      /(\d{1,2})\s*(?:余|多|\+)?\s*年\s*(?:余|多|\+)?\s*(?:以上)?\s*(?:工作)?经验/.exec(full) ??
      /(\d{1,2})\s*(?:余|多)\s*年/.exec(full);
    if (explicit) return Number(explicit[1]);
    // 表头写法：「本科 · 10年 · 33岁」。只看前几行，避免把「2016年」当成年限。
    const header = full.split(/\r?\n/).slice(0, 5).join(' ');
    const inline = /(?:^|[^\d])(\d{1,2})\s*(?:余|多|\+)?\s*年(?![\d\-/.])/.exec(header);
    if (inline) {
      const value = Number(inline[1]);
      if (value > 0 && value <= 40) return value;
    }
    return 0;
  }
  return Math.round(years * 10) / 10;
}

const NAME_NOISE = /简历|求职|应聘|优势|评价|简介|总结|技能|经历|教育|联系方式|电话|邮箱|微信|期望|岗位|年龄|性别|信息|专业|项目/;

export function extractContact(text) {
  const source = String(text ?? '');
  const phone = /(?<!\d)(1[3-9]\d{9})(?!\d)/.exec(source)?.[1] ?? '';
  const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(source)?.[0] ?? '';

  // 姓名：只看前几行的短片段。带句号/逗号的行是句子，不是姓名行；
  // 「个人优势」「专业技能」这类标题也是 2~4 个汉字，必须一并排掉。
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6);
  const tokens = lines
    .filter((line) => line.length <= 20 && !/[。，、；：!？,;]/.test(line))
    .flatMap((line) => line.split(/[|｜·\s/]+/))
    .filter(Boolean);
  const name =
    tokens.find(
      (token) =>
        /^[\u4e00-\u9fa5]{2,4}$/.test(token) &&
        !NAME_NOISE.test(token) &&
        !SECTION_PATTERNS.some(([, pattern]) => pattern.test(token)),
    ) ?? '';

  return { phone, email, name };
}

/** 取要点：优先个人优势段落，其次工作/项目段落里的短句。 */
export function extractHighlights(sections, limit = 8) {
  const source = [sections.summary, sections.experience, sections.projects].filter(Boolean).join('\n');
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s•·●○\-*—>]+/, '').trim())
    .filter((line) => line.length >= 8 && line.length <= 120)
    .filter((line) => /[\u4e00-\u9fa5A-Za-z]/.test(line));
  const unique = [...new Set(lines)];
  return unique.slice(0, limit);
}

/**
 * 把任意来源的简历整理成结构化对象。
 * @param {{text: string, source?: string, kind?: string}} input
 */
export function buildResume({ text, source, kind = 'text' }) {
  const clean = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (clean.length < 20) throw new Error('简历内容太短（少于 20 字），请提供完整一些的简历文本');
  const sections = splitSections(clean);
  const contact = extractContact(clean);
  const name = contact.name;
  return {
    name,
    source: source ?? 'text',
    kind,
    text: clean,
    chars: clean.length,
    sections,
    sectionTitles: SECTION_TITLES,
    skills: extractSkills(clean),
    degree: extractDegree(clean),
    years: estimateYears(clean, sections),
    contact,
    highlights: extractHighlights(sections),
    updatedAt: null,
  };
}

/** 给模型看的摘要（避免每次把整份简历塞回上下文）。 */
export function summarizeResume(resume, { maxChars = 1200 } = {}) {
  if (!resume) return null;
  return {
    name: resume.name,
    skills: resume.skills,
    degree: resume.degree,
    years: resume.years,
    highlights: resume.highlights,
    sections: Object.keys(resume.sections ?? {}),
    chars: resume.chars,
    updatedAt: resume.updatedAt,
    preview: String(resume.text ?? '').slice(0, maxChars),
  };
}
