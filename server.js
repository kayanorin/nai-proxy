// server.js — Express 应用：CORS + 令牌鉴权 + submit/status/result/cancel + 健康检查。
//
// 架构：朋友浏览器 POST /submit（NAI body）→ 入队 → 单 worker 串行加 key 转发 NAI
//        → GET /status 轮询 → GET /result 取原始 zip。
// key 只在服务端（NAI_KEY 环境变量），朋友只用访问令牌（X-Access-Token）。

import express from 'express';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { JobQueue } from './queue.js';
import { callNAIWithRetry, fetchAnlasBalance } from './nai.js';
import { estimateAnlas } from './anlas.js';
import { UsageStats } from './stats.js';

export function createApp(config) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: config.bodyLimit || '12mb' }));

  // ---- CORS（无 cookie，允许任意源 + 自定义头；覆盖 file:// 的 null 源）----
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    // X-Access-Token：网页端用；Authorization：NAI 原生兼容端点用（酒馆插件只能填 key→Bearer）
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Access-Token, Authorization');
    res.set('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204); // 预检
    next();
  });

  // 按令牌累计用量（内存聚合；逐条账本走下面 onSettled 里的 stdout `usage` 日志）
  const stats = new UsageStats();
  app.set('stats', stats);

  // 最近一次已知的 Anlas 余额（runner 每跑完一单顺手更新，/balance 优先读它，省得频繁打 NAI）
  let _balCache = { balance: null, at: 0 };
  const balanceOpts = { baseUrl: config.naiApiBaseUrl, apiKey: config.naiKey };

  const queue = new JobQueue({
    minGapMs: config.minGapMs,
    encodeMinGapMs: config.encodeMinGapMs,
    resultTtlMs: config.resultTtlMs,
    maxJobs: config.maxJobs,
    // 任务前后各查一次余额，差值＝这一单的真实扣点（队列串行，同一 key 上没有并发任务，
    // 归因是准的）。查询失败就退回估算，不影响出图。
    runner: async (job, signal) => {
      const before = await fetchAnlasBalance(balanceOpts);
      const out = await callNAIWithRetry(job.body, {
        baseUrl: config.naiBaseUrl,
        apiKey: config.naiKey,
        path: job.kind === 'encode-vibe' ? '/ai/encode-vibe' : '/ai/generate-image',
        signal,
        ...config.retry,
      });
      const after = await fetchAnlasBalance(balanceOpts);
      if (after != null) _balCache = { balance: after, at: Date.now() };
      if (before != null && after != null) job.anlasActual = Math.max(0, before - after);
      return out;
    },
    // 任务结束回调：只对成功(done)计点，并写一条结构化用量日志（车主看 Render 日志长期对账）
    onSettled: (job) => {
      if (job.status !== 'done') return;
      const anlas =
        typeof job.anlasActual === 'number'
          ? job.anlasActual
          : typeof job.anlasEst === 'number'
            ? job.anlasEst
            : estimateAnlas(job.body, { opus: config.opusFree });
      stats.record(job.token, anlas);
      const p = (job.body && job.body.parameters) || {};
      console.log(JSON.stringify({
        evt: 'usage',
        at: new Date().toISOString(),
        token: job.token,
        kind: job.kind,
        model: job.body && job.body.model,
        size: `${p.width || '?'}x${p.height || '?'}`,
        steps: p.steps,
        samples: p.n_samples || 1,
        anlas,
        actual: typeof job.anlasActual === 'number' ? job.anlasActual : null,
      }));
    },
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
    const id = queue.submit(req.token, body, 'generate');
    const job = queue.get(id);
    // 估点一次存到 job 上：/status 复用、完成计入统计，三处同一个数
    job.anlasEst = estimateAnlas(body, { opus: config.opusFree });
    const position = queue.position(id);
    res.json({
      job_id: id,
      status: 'queued',
      position,
      eta_ms: etaMs(position, config.minGapMs),
      anlas_est: job.anlasEst,
    });
  });

  // ---- 轮询状态 ----
  app.get('/status/:id', auth, (req, res) => {
    const job = queue.get(req.params.id);
    if (!job) return notFound(res);
    if (job.token !== req.token) return forbidden(res);
    const position = queue.position(job.id);
    res.json({
      job_id: job.id,
      status: job.status,
      position,
      eta_ms: etaMs(position, job.kind === 'encode-vibe' ? config.encodeMinGapMs : config.minGapMs),
      anlas_est: typeof job.anlasEst === 'number'
        ? job.anlasEst
        : estimateAnlas(job.body, { opus: config.opusFree }),
      ...(typeof job.anlasActual === 'number' ? { anlas_actual: job.anlasActual } : {}),
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
    // 只有 zip（生图结果）才当附件下载；vibe 编码结果是裸字节，前端直接读
    if (/zip/i.test(job.contentType || 'application/zip')) {
      res.set('Content-Disposition', 'attachment; filename="result.zip"');
    }
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

  // ---- 提交 vibe 编码任务 ----
  // 与 /submit 同一条串行队列（共用限速 / 单一真 key / 用量统计），只是打 NAI 的 /ai/encode-vibe。
  // 结果是一段裸字节（vibe encoding），照常 GET /status 轮询 + GET /result 取。
  app.post('/encode-vibe', auth, (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'body 必须是 NAI 请求的 JSON 对象', code: 'BAD_BODY' });
    }
    if (body.image == null || body.information_extracted == null || !body.model) {
      return res
        .status(400)
        .json({ error: 'body 需要 image / information_extracted / model 三个字段', code: 'BAD_BODY' });
    }
    if (!config.naiKey) {
      return res.status(503).json({ error: '服务端未配置 NAI_KEY', code: 'NO_KEY' });
    }
    const id = queue.submit(req.token, body, 'encode-vibe');
    const job = queue.get(id);
    job.anlasEst = 2; // NAI 每次 vibe 编码固定 2 Anlas
    const position = queue.position(id);
    res.json({
      job_id: id,
      status: 'queued',
      position,
      eta_ms: etaMs(position, config.encodeMinGapMs),
      anlas_est: job.anlasEst,
    });
  });

  // ---- 查 Anlas 余额（朋友端显示用）----
  // 优先走缓存：每跑完一单 runner 都会顺手刷新，正常用不着额外打 NAI。
  const BALANCE_TTL_MS = 60 * 1000;
  app.get('/balance', auth, async (req, res) => {
    if (!config.naiKey) return res.json({ balance: null, at: 0 });
    if (_balCache.balance != null && Date.now() - _balCache.at < BALANCE_TTL_MS) {
      return res.json({ balance: _balCache.balance, at: _balCache.at });
    }
    const balance = await fetchAnlasBalance(balanceOpts);
    if (balance != null) _balCache = { balance, at: Date.now() };
    res.json({ balance, at: _balCache.at });
  });

  // ---- NAI 原生兼容端点 ----
  // 给「只能填 NAI key、且要同步拿图」的第三方客户端用（如酒馆 st-chatu8 插件）。
  // 朋友把【访问令牌】填进插件的 key 栏 → 浏览器发 Authorization: Bearer <令牌>，
  // 这里读出令牌、入【同一个队列】（与网页端共用限速 / 单一真 key / 用量统计），
  // 然后【阻塞等出图】，把 NAI 原始响应（zip 或 msgpack 流，原样）同步返回。
  const naiCompatAuth = (req, res, next) => {
    if (config.accessTokens.size === 0) {
      return res.status(503).json({ error: '服务端未配置 ACCESS_TOKENS', code: 'NO_TOKENS' });
    }
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    const token = bearer || req.get('X-Access-Token') || '';
    if (!config.accessTokens.has(token)) {
      return res
        .status(401)
        .json({ error: '访问令牌无效（把【访问令牌】填到插件的 key 栏，不是 NAI key）', code: 'BAD_TOKEN' });
    }
    req.token = token;
    next();
  };

  app.post('/ai/generate-image', naiCompatAuth, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'body 必须是 NAI 请求的 JSON 对象', code: 'BAD_BODY' });
    }
    if (!config.naiKey) {
      return res.status(503).json({ error: '服务端未配置 NAI_KEY', code: 'NO_KEY' });
    }
    clampBody(body, config);
    const id = queue.submit(req.token, body, 'generate');
    const job = queue.get(id);
    job.anlasEst = estimateAnlas(body, { opus: config.opusFree }); // 与 /submit 同口径，完成时计入统计

    // 客户端断开（超时 / 手动停）时取消任务，别白烧 Anlas、也别占着 worker
    let settled = false;
    res.on('close', () => {
      if (!settled) queue.cancel(id);
    });

    await queue.waitFor(id);
    settled = true;

    if (job.status === 'done') {
      res.set('Content-Type', job.contentType || 'application/zip'); // 原样回传（zip / msgpack）
      return res.send(job.resultBuf);
    }
    if (job.status === 'cancelled') {
      return res.status(499).json({ error: '任务已取消', code: 'CANCELLED' });
    }
    // failed：把 NAI 错误映射成合适的 HTTP 状态（车主 key 的问题对插件用户算 502，不是他们的锅）
    return res
      .status(naiErrStatus(job.errorCode))
      .json({ error: job.error || 'NAI 生成失败', code: job.errorCode || 'ERROR' });
  });

  // ---- 用量统计（车主专用，设了 ADMIN_TOKEN 才开；朋友令牌看不到）----
  const adminAuth = (req, res, next) => {
    if (!config.adminToken) {
      return res.status(404).json({ error: 'stats 未启用（设 ADMIN_TOKEN 开启）', code: 'STATS_DISABLED' });
    }
    if ((req.get('X-Access-Token') || '') !== config.adminToken) {
      return res.status(401).json({ error: '需要管理员令牌', code: 'BAD_ADMIN' });
    }
    next();
  };
  // { since, totals:{count,anlas}, tokens:{ <token>:{count,anlas,lastAt} } }
  app.get('/stats', adminAuth, (req, res) => res.json(stats.snapshot()));
  // 按账期手动清零（不调也行——Render 免费档重启会自然清零）
  app.post('/stats/reset', adminAuth, (req, res) => {
    stats.reset();
    res.json({ ok: true, since: stats.snapshot().since });
  });

  // ---- 兜底：未匹配的路径打一条日志（便于确认第三方客户端实际打的路径），并 404 ----
  app.use((req, res) => {
    console.log(JSON.stringify({ evt: 'unmatched', method: req.method, path: req.path }));
    res.status(404).json({ error: '未知路径：' + req.path, code: 'NO_ROUTE' });
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

// NAI 失败码 → 对外 HTTP 状态（给 NAI 原生兼容端点用）。
function naiErrStatus(code) {
  switch (code) {
    case 'INSUFFICIENT_FUNDS':
      return 402; // NAI 余额不足
    case 'RATE_LIMITED':
      return 429; // 持续限流
    case 'ABORTED':
      return 499; // 已取消
    default:
      return 502; // KEY_INVALID / NETWORK / NAI_5xx 等：一律当上游网关错误
  }
}

// 预估等待（毫秒）：队列里第 position 位 ≈ position × 串行间隔才轮到自己开跑。
// NAI 同时只跑 1 个，算不算正在跑的那个只差一格、对体感无所谓；不在队列(运行中/已结束)记 0。
function etaMs(position, gapMs) {
  return position != null && position > 0 ? position * gapMs : 0;
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
