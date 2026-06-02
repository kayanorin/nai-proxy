// server.js — Express 应用：CORS + 令牌鉴权 + submit/status/result/cancel + 健康检查。
//
// 架构：朋友浏览器 POST /submit（NAI body）→ 入队 → 单 worker 串行加 key 转发 NAI
//        → GET /status 轮询 → GET /result 取原始 zip。
// key 只在服务端（NAI_KEY 环境变量），朋友只用访问令牌（X-Access-Token）。

import express from 'express';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { JobQueue } from './queue.js';
import { callNAIWithRetry } from './nai.js';

export function createApp(config) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: config.bodyLimit || '12mb' }));

  // ---- CORS（无 cookie，允许任意源 + 自定义头；覆盖 file:// 的 null 源）----
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Access-Token');
    res.set('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204); // 预检
    next();
  });

  const queue = new JobQueue({
    minGapMs: config.minGapMs,
    resultTtlMs: config.resultTtlMs,
    maxJobs: config.maxJobs,
    runner: (body, signal) =>
      callNAIWithRetry(body, {
        baseUrl: config.naiBaseUrl,
        apiKey: config.naiKey,
        signal,
        ...config.retry,
      }),
  });
  queue.startReaper(config.reapIntervalMs);
  app.set('queue', queue); // 便于测试 introspect

  // ---- 令牌鉴权（只挂在任务接口上）----
  const auth = (req, res, next) => {
    if (config.accessTokens.size === 0) {
      return res.status(503).json({ error: '服务端未配置 ACCESS_TOKENS', code: 'NO_TOKENS' });
    }
    const token = req.get('X-Access-Token') || '';
    if (!config.accessTokens.has(token)) {
      return res.status(401).json({ error: '访问令牌无效', code: 'BAD_TOKEN' });
    }
    req.token = token;
    next();
  };

  // ---- 健康检查 / 保活 ----
  app.get('/', (req, res) => {
    res.json({
      ok: true,
      service: 'nai-proxy',
      queueLen: queue.queueLength(),
      working: queue.isWorking(),
      jobs: queue.size(),
    });
  });

  // ---- 诊断：本服务出口 IP（验「单一 IP」用）----
  app.get('/egress-ip', async (req, res) => {
    try {
      const r = await fetch('https://api.ipify.org?format=json');
      const j = await r.json();
      res.json({ egress_ip: j.ip });
    } catch (e) {
      res.status(502).json({ error: '查询出口 IP 失败：' + (e?.message || e) });
    }
  });

  // ---- 提交任务 ----
  app.post('/submit', auth, (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'body 必须是 NAI 请求的 JSON 对象', code: 'BAD_BODY' });
    }
    if (!config.naiKey) {
      return res.status(503).json({ error: '服务端未配置 NAI_KEY', code: 'NO_KEY' });
    }
    clampBody(body, config);
    const id = queue.submit(req.token, body);
    res.json({ job_id: id, status: 'queued', position: queue.position(id) });
  });

  // ---- 轮询状态 ----
  app.get('/status/:id', auth, (req, res) => {
    const job = queue.get(req.params.id);
    if (!job) return notFound(res);
    if (job.token !== req.token) return forbidden(res);
    res.json({
      job_id: job.id,
      status: job.status,
      position: queue.position(job.id),
      error: job.error,
      code: job.errorCode,
    });
  });

  // ---- 取结果（原始 zip）----
  app.get('/result/:id', auth, (req, res) => {
    const job = queue.get(req.params.id);
    if (!job) return notFound(res);
    if (job.token !== req.token) return forbidden(res);
    if (job.status !== 'done') {
      return res
        .status(409)
        .json({ error: '任务尚未完成', status: job.status, code: job.errorCode || null });
    }
    res.set('Content-Type', job.contentType || 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="result.zip"');
    res.send(job.resultBuf);
  });

  // ---- 取消 ----
  app.post('/cancel/:id', auth, (req, res) => {
    const job = queue.get(req.params.id);
    if (!job) return notFound(res);
    if (job.token !== req.token) return forbidden(res);
    const ok = queue.cancel(job.id);
    res.json({ cancelled: ok, status: job.status });
  });

  return app;
}

function notFound(res) {
  return res
    .status(404)
    .json({ error: '任务不存在（可能已过期或服务重启过，请重新提交）', code: 'NOT_FOUND' });
}
function forbidden(res) {
  return res.status(403).json({ error: '无权访问该任务', code: 'FORBIDDEN' });
}

// 可选的参数 clamp，防误操作烧 Anlas（0 = 不限制）
function clampBody(body, config) {
  const p = body.parameters;
  if (!p || typeof p !== 'object') return;
  if (config.maxSamples > 0 && Number(p.n_samples) > config.maxSamples) {
    p.n_samples = config.maxSamples;
  }
  if (config.maxSteps > 0 && Number(p.steps) > config.maxSteps) {
    p.steps = config.maxSteps;
  }
}

// ---- 直接运行时启动服务 ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const app = createApp(config);
  app.listen(config.port, () => {
    console.log(
      `[nai-proxy] 监听 :${config.port}  串行间隔=${config.minGapMs}ms  ` +
        `令牌数=${config.accessTokens.size}  NAI=${config.naiBaseUrl}`
    );
    if (!config.naiKey) console.warn('[nai-proxy] ⚠ 未配置 NAI_KEY，/submit 会拒绝');
    if (config.accessTokens.size === 0)
      console.warn('[nai-proxy] ⚠ 未配置 ACCESS_TOKENS，所有任务接口会拒绝');
  });
}
