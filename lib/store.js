/**
 * 本地数据存放：简历、打招呼历史、登录会话快照、截图。
 *
 * 所有写入都是「写临时文件 → rename」，避免进程被杀时留下半个 JSON。
 * 只用 node:fs，不引第三方依赖。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** 匹配门槛的默认值：60 分以上才算「值得投」。 */
export const DEFAULT_MIN_SCORE = 60;

function today(now = new Date()) {  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

async function readJson(file, fallback) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.resumeFile = path.join(dataDir, 'resume.json');
    this.historyFile = path.join(dataDir, 'history.json');
    this.sessionFile = path.join(dataDir, 'session.json');
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.jobsFile = path.join(dataDir, 'jobs-cache.json');
    this.screenshotDir = path.join(dataDir, 'screenshots');
    this.queue = Promise.resolve();
  }

  ensureDirs() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.screenshotDir, { recursive: true });
  }

  /** 串行化读改写，避免并发工具调用把同一份 JSON 覆盖掉。 */
  withLock(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  // ---------------------------------------------------------------- 简历

  async getResume() {
    return readJson(this.resumeFile, null);
  }

  async setResume(resume) {
    return this.withLock(async () => {
      const payload = { ...resume, updatedAt: new Date().toISOString() };
      await writeJson(this.resumeFile, payload);
      return payload;
    });
  }

  // ---------------------------------------------------------------- 会话

  async getSession() {
    return readJson(this.sessionFile, null);
  }

  async setSession(session) {
    return this.withLock(async () => {
      const payload = { ...session, updatedAt: new Date().toISOString() };
      await writeJson(this.sessionFile, payload);
      return payload;
    });
  }

  async clearSession() {
    return this.withLock(async () => {
      await fsp.rm(this.sessionFile, { force: true });
    });
  }

  // ---------------------------------------------------------------- 设置

  async getSettings() {
    return readJson(this.settingsFile, {});
  }

  async setSettings(patch) {
    return this.withLock(async () => {
      const current = await readJson(this.settingsFile, {});
      const next = { ...current, ...patch };
      await writeJson(this.settingsFile, next);
      return next;
    });
  }

  /**
   * 求职偏好：城市、方向（检索词）、匹配门槛。
   * 门槛 0~100，越高越严（只保留高度匹配），越低越宽松（大致符合就进）。
   */
  async getPrefs() {
    const settings = await this.getSettings();
    const minScore = Number(settings.minScore);
    return {
      city: settings.city ? String(settings.city) : '',
      query: settings.query ? String(settings.query) : '',
      minScore: Number.isFinite(minScore) ? Math.min(100, Math.max(0, minScore)) : DEFAULT_MIN_SCORE,
      updatedAt: settings.prefsUpdatedAt ?? null,
    };
  }

  async setPrefs(patch) {
    const merged = {};
    if (patch.city !== undefined) merged.city = String(patch.city);
    if (patch.query !== undefined) merged.query = String(patch.query);
    if (patch.minScore !== undefined) merged.minScore = Math.min(100, Math.max(0, Number(patch.minScore)));
    merged.prefsUpdatedAt = new Date().toISOString();
    await this.setSettings(merged);
    return this.getPrefs();
  }

  // ---------------------------------------------------------------- 职位缓存

  /**
   * 记住检索结果。详情接口要求 securityId，而模型通常只记得 jobId，
   * 所以这里把 jobId → securityId/lid 的对应关系存下来，供详情/匹配/打招呼复用。
   */
  async rememberJobs(jobs) {
    return this.withLock(async () => {
      const data = await readJson(this.jobsFile, {});
      const now = new Date().toISOString();
      for (const job of jobs ?? []) {
        if (!job?.jobId) continue;
        data[job.jobId] = {
          jobId: job.jobId,
          jobName: job.jobName,
          company: job.company,
          salary: job.salary,
          city: job.city,
          district: job.district,
          experience: job.experience,
          degree: job.degree,
          hrOnline: Boolean(job.hrOnline),
          // 技能/标签存下来，后面只用 jobId 分析时分数才不会比检索路径低
          skills: Array.isArray(job.skills) ? job.skills : [],
          labels: Array.isArray(job.labels) ? job.labels : [],
          securityId: job.securityId,
          lid: job.lid,
          url: job.url,
          at: now,
        };
      }
      const entries = Object.values(data)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, 400);
      await writeJson(this.jobsFile, Object.fromEntries(entries.map((entry) => [entry.jobId, entry])));
    });
  }

  async getJob(jobId) {
    const data = await readJson(this.jobsFile, {});
    return data[String(jobId)] ?? null;
  }

  // ---------------------------------------------------------------- 历史

  async getHistory() {
    const data = await readJson(this.historyFile, { records: [] });
    return Array.isArray(data?.records) ? data.records : [];
  }

  /**
   * 一条打招呼记录：jobId、公司、职位、消息、结果、时间。
   * 同时用于去重（同一 jobId 不重复打招呼）和每日配额统计。
   */
  async addHistory(record) {
    return this.withLock(async () => {
      const data = await readJson(this.historyFile, { records: [] });
      const records = Array.isArray(data?.records) ? data.records : [];
      const entry = { at: new Date().toISOString(), day: today(), ...record };
      records.push(entry);
      // 只保留最近 2000 条，避免文件无限增长。
      await writeJson(this.historyFile, { records: records.slice(-2000) });
      return entry;
    });
  }

  async countToday() {
    const records = await this.getHistory();
    const day = today();
    return records.filter((record) => record.day === day && record.status === 'sent').length;
  }

  async findGreeted(jobId) {
    const records = await this.getHistory();
    return records.find((record) => String(record.jobId) === String(jobId) && record.status === 'sent') ?? null;
  }

  async lastSentAt() {
    const records = await this.getHistory();
    const sent = records.filter((record) => record.status === 'sent');
    if (!sent.length) return 0;
    const times = sent.map((record) => Date.parse(record.at)).filter((value) => Number.isFinite(value));
    return times.length ? Math.max(...times) : 0;
  }

  async screenshot(fileName, buffer) {
    this.ensureDirs();
    const target = path.join(this.screenshotDir, fileName);
    await fsp.writeFile(target, buffer);
    return target;
  }
}

export { today };
