// queue.js — 内存任务队列 + 单 worker 串行执行 + TTL 回收。
//
// 防 429/风控的主防线是「串行到 1」：任意时刻最多一个请求在飞。
// MIN_GAP_MS / MAX_GAP_MS 定义生图请求起点的随机间隔范围。

import { randomUUID } from 'node:crypto';

export class JobQueue {
  /**
   * @param {object} opts
   * @param {(body:object, signal:AbortSignal)=>Promise<{buf:Buffer,contentType:string}>} opts.runner
   * @param {number} [opts.minGapMs]
   * @param {number} [opts.maxGapMs]
   * @param {number} [opts.resultTtlMs]
   * @param {number} [opts.maxJobs]
   */
  constructor({ runner, onSettled = null, priority = null, minGapMs = 8000, maxGapMs = 12000, encodeMinGapMs = 3000, random = Math.random, resultTtlMs = 600000, maxJobs = 200 }) {
    this.runner = runner;
    this.onSettled = onSettled;
    this.priority = priority;
    this.minGapMs = minGapMs;
    this.maxGapMs = Math.max(minGapMs, maxGapMs);
    this.encodeMinGapMs = encodeMinGapMs;
    this.random = random;
    this.resultTtlMs = resultTtlMs;
    this.maxJobs = maxJobs;

    /** @type {Map<string, object>} */
    this.jobs = new Map();
    /** @type {string[]} FIFO，存 job id */
    this.queue = [];
    this.tokenOrder = [];
    this.lastTokenIndex = -1;
    this.working = false;
    this.lastStartAt = 0; // 上次向 NAI 发起请求的时间戳（限速基准）
    this._reaper = null;
  }

  submit(token, body, kind = 'generate') {
    const id = randomUUID();
    const job = {
      id,
      token,
      body,
      kind,
      status: 'queued', // queued | running | done | failed | cancelled
      resultBuf: null,
      contentType: null,
      error: null,
      errorCode: null,
      errorDetails: null,
      abort: null,
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    if (!this.tokenOrder.includes(token)) this.tokenOrder.push(token);
    this._evictIfNeeded();
    this._kick();
    return id;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }
  size() {
    return this.jobs.size;
  }
  queueLength() {
    return this.queue.length;
  }
  isWorking() {
    return this.working;
  }

  // 队列里的位次（1 起）；不在队列（运行中/已结束）返回 null
  position(id) {
    const i = this._scheduledIds().indexOf(id);
    return i < 0 ? null : i + 1;
  }

  // 等待任务结束（done/failed/cancelled）；已结束则立即兑现。给同步端点（NAI 兼容路径）用。
  waitFor(id) {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new Error('job not found'));
    if (isEnded(job)) return Promise.resolve(job);
    return new Promise((resolve) => {
      (job._waiters || (job._waiters = [])).push(resolve);
    });
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      const i = this.queue.indexOf(id);
      if (i >= 0) this.queue.splice(i, 1);
      this._settle(job); // 兑现 waitFor（排队中被取消不会进 worker 的 finally）
      return true;
    }
    if (job.status === 'running') {
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      try {
        job.abort?.abort();
      } catch {
        /* ignore */
      }
      return true;
    }
    return false; // 已结束的不可取消
  }

  _kick() {
    if (!this.working) this._loop();
  }

  async _loop() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const id = this._nextQueuedId(); // per-token round-robin; keep queued during gap wait
        const job = this.jobs.get(id);
        if (!job || job.status !== 'queued') {
          this._removeQueuedId(id);
          continue;
        }

        // 生图任务每次独立抽取间隔；Vibe 编码保留自己的固定间隔。
        const gapMs = job.kind === 'encode-vibe' ? this.encodeMinGapMs : this._nextGenerateGapMs();
        const wait = gapMs - (Date.now() - this.lastStartAt);
        if (wait > 0) await sleep(wait);

        // 等待期间可能被取消
        if (job.status !== 'queued') {
          this._removeQueuedId(id);
          continue;
        }

        this._removeQueuedId(id);
        const servedIndex = this.tokenOrder.indexOf(job.token);
        if (servedIndex >= 0) this.lastTokenIndex = servedIndex;
        job.status = 'running';
        job.startedAt = Date.now();
        job.abort = new AbortController();
        this.lastStartAt = Date.now();

        try {
          const { buf, contentType } = await this.runner(job, job.abort.signal);
          if (job.status === 'cancelled') continue; // 运行中被取消，丢弃结果
          job.resultBuf = buf;
          job.contentType = contentType || 'application/zip';
          job.status = 'done';
        } catch (e) {
          if (job.status === 'cancelled') continue;
          job.status = 'failed';
          job.error = e?.message || String(e);
          job.errorCode = e?.code || 'ERROR';
          job.errorDetails = e?.details || null;
        } finally {
          if (!job.finishedAt) job.finishedAt = Date.now();
          this._settle(job);
        }
      }
    } finally {
      this.working = false;
    }
  }

  _nextGenerateGapMs() {
    if (this.maxGapMs <= this.minGapMs) return this.minGapMs;
    const unit = Math.max(0, Math.min(0.999999999, Number(this.random()) || 0));
    return this.minGapMs + Math.floor(unit * (this.maxGapMs - this.minGapMs + 1));
  }

  _removeQueuedId(id) {
    const index = this.queue.indexOf(id);
    if (index >= 0) this.queue.splice(index, 1);
  }

  _nextQueuedId(queue = this.queue, cursor = this.lastTokenIndex) {
    if (!queue.length) return null;
    const available = new Set(queue.map((id) => this.jobs.get(id)?.token).filter(Boolean));
    if (this.priority && available.size > 1) {
      const candidates = [...available].map((token) => {
        const id = queue.find((queuedId) => this.jobs.get(queuedId)?.token === token);
        const score = Number(this.priority(this.jobs.get(id)));
        return { id, score };
      }).filter((candidate) => Number.isFinite(candidate.score));
      if (candidates.length > 1) {
        candidates.sort((a, b) => a.score - b.score);
        if (candidates[0].score + 1e-9 < candidates[1].score) return candidates[0].id;
      }
    }
    for (let offset = 1; offset <= this.tokenOrder.length; offset++) {
      const index = (cursor + offset + this.tokenOrder.length) % this.tokenOrder.length;
      const token = this.tokenOrder[index];
      if (!available.has(token)) continue;
      return queue.find((id) => this.jobs.get(id)?.token === token) || null;
    }
    return queue[0] || null;
  }

  _scheduledIds() {
    const remaining = [...this.queue];
    const ordered = [];
    let cursor = this.lastTokenIndex;
    while (remaining.length) {
      const id = this._nextQueuedId(remaining, cursor);
      if (!id) break;
      ordered.push(id);
      const token = this.jobs.get(id)?.token;
      const index = this.tokenOrder.indexOf(token);
      if (index >= 0) cursor = index;
      remaining.splice(remaining.indexOf(id), 1);
    }
    return ordered;
  }

  // 统一收尾：跑 onSettled 回调 + 兑现所有 waitFor。
  // 两条结束路径都走这里：worker 跑完（_loop 的 finally）/ 排队中被取消（cancel）。
  _settle(job) {
    if (this.onSettled) {
      try {
        this.onSettled(job);
      } catch (e) {
        console.error('[queue] onSettled 回调出错：', e);
      }
    }
    const waiters = job._waiters;
    if (waiters && waiters.length) {
      job._waiters = null;
      for (const fn of waiters) {
        try {
          fn(job);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // 总量超限时，驱逐最旧的「已结束」job
  _evictIfNeeded() {
    if (this.jobs.size <= this.maxJobs) return;
    const finished = [...this.jobs.values()]
      .filter((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')
      .sort((a, b) => a.finishedAt - b.finishedAt);
    while (this.jobs.size > this.maxJobs && finished.length) {
      this.jobs.delete(finished.shift().id);
    }
  }

  startReaper(intervalMs = 60000) {
    if (this._reaper) return;
    this._reaper = setInterval(() => this._reap(), intervalMs);
    // 不阻止进程退出
    if (this._reaper.unref) this._reaper.unref();
  }
  stopReaper() {
    if (this._reaper) {
      clearInterval(this._reaper);
      this._reaper = null;
    }
  }

  // 回收：已结束且超过 TTL 的 job 删掉，释放 resultBuf
  _reap() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      const ended = job.status === 'done' || job.status === 'failed' || job.status === 'cancelled';
      if (ended && job.finishedAt && now - job.finishedAt > this.resultTtlMs) {
        this.jobs.delete(id);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEnded(job) {
  return job.status === 'done' || job.status === 'failed' || job.status === 'cancelled';
}
