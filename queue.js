// queue.js — 内存任务队列 + 单 worker 串行执行 + TTL 回收。
//
// 防 429/风控的主防线是「串行到 1」：任意时刻最多一个请求在飞。
// MIN_GAP_MS 是额外的总体限速（相邻请求起点间隔）。

import { randomUUID } from 'node:crypto';

export class JobQueue {
  /**
   * @param {object} opts
   * @param {(body:object, signal:AbortSignal)=>Promise<{buf:Buffer,contentType:string}>} opts.runner
   * @param {number} [opts.minGapMs]
   * @param {number} [opts.resultTtlMs]
   * @param {number} [opts.maxJobs]
   */
  constructor({ runner, minGapMs = 12000, resultTtlMs = 600000, maxJobs = 200 }) {
    this.runner = runner;
    this.minGapMs = minGapMs;
    this.resultTtlMs = resultTtlMs;
    this.maxJobs = maxJobs;

    /** @type {Map<string, object>} */
    this.jobs = new Map();
    /** @type {string[]} FIFO，存 job id */
    this.queue = [];
    this.working = false;
    this.lastStartAt = 0; // 上次向 NAI 发起请求的时间戳（限速基准）
    this._reaper = null;
  }

  submit(token, body) {
    const id = randomUUID();
    const job = {
      id,
      token,
      body,
      status: 'queued', // queued | running | done | failed | cancelled
      resultBuf: null,
      contentType: null,
      error: null,
      errorCode: null,
      abort: null,
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
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
    const i = this.queue.indexOf(id);
    return i < 0 ? null : i + 1;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      const i = this.queue.indexOf(id);
      if (i >= 0) this.queue.splice(i, 1);
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
        const id = this.queue[0]; // 先 peek，限速等待期间保持在队列里（位次准确）
        const job = this.jobs.get(id);
        if (!job || job.status !== 'queued') {
          this.queue.shift();
          continue;
        }

        // 限速：与上次请求起点间隔 ≥ minGapMs
        const wait = this.minGapMs - (Date.now() - this.lastStartAt);
        if (wait > 0) await sleep(wait);

        // 等待期间可能被取消
        if (job.status !== 'queued') {
          this.queue.shift();
          continue;
        }

        this.queue.shift();
        job.status = 'running';
        job.startedAt = Date.now();
        job.abort = new AbortController();
        this.lastStartAt = Date.now();

        try {
          const { buf, contentType } = await this.runner(job.body, job.abort.signal);
          if (job.status === 'cancelled') continue; // 运行中被取消，丢弃结果
          job.resultBuf = buf;
          job.contentType = contentType || 'application/zip';
          job.status = 'done';
        } catch (e) {
          if (job.status === 'cancelled') continue;
          job.status = 'failed';
          job.error = e?.message || String(e);
          job.errorCode = e?.code || 'ERROR';
        } finally {
          if (!job.finishedAt) job.finishedAt = Date.now();
        }
      }
    } finally {
      this.working = false;
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
