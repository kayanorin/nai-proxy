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
import { ActivityStore } from './activity.js';

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
  const activity = new ActivityStore({
    dbPath: config.statsDbPath || ':memory:',
    retentionDays: config.statsRetentionDays || 90,
    accessTokens: config.accessTokens,
    userProfiles: config.userProfiles || new Map(),
  });
  app.set('activityStore', activity);

  // 最近一次已知的 Anlas 余额（runner 每跑完一单顺手更新，/balance 优先读它，省得频繁打 NAI）
  let _balCache = { balance: null, at: 0 };
  const balanceOpts = { baseUrl: config.naiApiBaseUrl, apiKey: config.naiKey };

  const queue = new JobQueue({
    minGapMs: config.minGapMs,
    maxGapMs: config.maxGapMs,
    encodeMinGapMs: config.encodeMinGapMs,
    random: config.random,
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
      activity.record(job.token, { at: job.createdAt, kind: job.kind, anlas });
      const p = (job.body && job.body.parameters) || {};
      const profile = activity.profileForToken(job.token);
      console.log(JSON.stringify({
        evt: 'usage',
        at: new Date().toISOString(),
        // 记稳定的 userId 而不是原始访问令牌：日志会长期留在 Render 上，别把令牌写进去
        userId: profile?.id || 'unknown',
        model: job.body && job.body.model,
        size: `${p.width || '?'}x${p.height || '?'}`,
        steps: p.steps,
        samples: p.n_samples || 1,
        kind: job.kind,
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
      eta_ms: etaMs(position, averageGapMs(config.minGapMs, config.maxGapMs)),
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
      // 生图的间隔是随机的，预估用区间均值；vibe 编码走自己那档固定间隔
      eta_ms: etaMs(
        position,
        job.kind === 'encode-vibe'
          ? config.encodeMinGapMs
          : averageGapMs(config.minGapMs, config.maxGapMs)
      ),
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
  app.get('/stats', adminAuth, (req, res) => {
    const snap = stats.snapshot();
    for (const [token, entry] of Object.entries(snap.tokens)) Object.assign(entry, activity.profileForToken(token) || {});
    res.json(snap);
  });
  app.get('/stats/me/activity', auth, (req, res) => {
    const days = ActivityStore.validDays(req.query.days ?? 7);
    if (!days) return res.status(400).json({ error: 'days 只支持 7 / 30 / 90', code: 'BAD_DAYS' });
    const data = activity.querySelf(req.token, days);
    if (!data) return res.status(404).json({ error: '未找到用户资料', code: 'NO_PROFILE' });
    res.json(data);
  });
  app.get('/stats/activity', adminAuth, (req, res) => {
    const days = ActivityStore.validDays(req.query.days ?? 7);
    if (!days) return res.status(400).json({ error: 'days 只支持 7 / 30 / 90', code: 'BAD_DAYS' });
    const data = activity.queryAdmin(days, String(req.query.user || 'all'));
    if (!data) return res.status(400).json({ error: '未知用户', code: 'BAD_USER' });
    res.json(data);
  });
  // 按账期手动清零（不调也行——Render 免费档重启会自然清零）
  app.post('/stats/reset', adminAuth, (req, res) => {
    stats.reset();
    activity.reset();
    res.json({ ok: true, since: stats.snapshot().since });
  });

  // 用量统计的简易网页（车主用）：页面本身不含密钥，可公开加载；
  // 进页面后填【管理员令牌】，前端用 X-Access-Token 头去打 /stats（令牌只留在浏览器 localStorage，不进 URL）。
  app.get('/stats/ui', (req, res) => res.type('html').send(STATS_UI_HTML));

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

function averageGapMs(min, max) {
  return Math.round((min + Math.max(min, max)) / 2);
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

// /stats/ui 的页面：纯静态、无密钥。填管理员令牌 → 前端带 X-Access-Token 头拉 /stats 渲染。
const STATS_UI_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nai-proxy 用量</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, system-ui, "Segoe UI", sans-serif; max-width: 820px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
  .muted { opacity: .65; font-size: .85rem; }
  .bar { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin: 1rem 0; }
  input, select { flex: 1; min-width: 140px; padding: .5rem .6rem; border: 1px solid #8886; border-radius: 8px; background: transparent; color: inherit; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: 8px; background: #8882; color: inherit; cursor: pointer; }
  button:hover { background: #8883; }
  button.danger { border-color: #e5484d88; color: #e5484d; }
  .cards { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0; }
  .card { flex: 1; min-width: 140px; border: 1px solid #8883; border-radius: 12px; padding: .8rem 1rem; }
  .card .n { font-size: 1.6rem; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: .5rem; }
  th, td { text-align: left; padding: .5rem .4rem; border-bottom: 1px solid #8882; }
  th { font-size: .8rem; opacity: .7; font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  code { word-break: break-all; font-size: .85em; }
  #msg { color: #e5484d; font-size: .85rem; }
  .hours { display:grid; grid-template-columns:repeat(12,1fr); gap:.35rem; margin:1rem 0; }
  .hour { min-height:54px; display:grid; place-items:center; border-radius:8px; background:color-mix(in srgb,#0f766e calc(var(--heat)*100%),#8881); font-size:.72rem; text-align:center; }
  @media(max-width:640px){.hours{grid-template-columns:repeat(6,1fr)}}
</style>
</head>
<body>
  <h1>nai-proxy 用量统计</h1>
  <div class="muted" id="since">—</div>

  <div class="bar">
    <input id="tok" type="password" placeholder="管理员令牌 (ADMIN_TOKEN)" autocomplete="current-password">
    <label class="muted"><input type="checkbox" id="remember" style="flex:none;min-width:auto"> 记住</label>
    <button id="load">刷新</button>
    <button id="reset" class="danger">清零账期</button>
  </div>
  <div class="bar">
    <select id="days" aria-label="统计周期"><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option></select>
    <select id="user" aria-label="用户"><option value="all">所有用户（各自本地时间）</option></select>
  </div>
  <div id="msg"></div>

  <div class="cards">
    <div class="card"><div class="muted">总请求数</div><div class="n" id="tCount">—</div></div>
    <div class="card"><div class="muted">总消耗 Anlas</div><div class="n" id="tAnlas">—</div></div>
    <div class="card"><div class="muted">朋友数</div><div class="n" id="tUsers">—</div></div>
  </div>
  <div class="hours" id="hours"></div>

  <table>
    <thead><tr><th>访问令牌</th><th class="num">次数</th><th class="num">Anlas</th><th>最近一次</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>

<script>
  const $ = (id) => document.getElementById(id);
  const KEY = 'nai_admin_token';
  const saved = localStorage.getItem(KEY);
  if (saved) { $('tok').value = saved; $('remember').checked = true; }

  const fmtTime = (ms) => ms ? new Date(ms).toLocaleString() : '—';
  const fmtNum = (n) => (n ?? 0).toLocaleString();

  async function load() {
    const tok = $('tok').value.trim();
    $('msg').textContent = '';
    if (!tok) { $('msg').textContent = '请先填管理员令牌'; return; }
    if ($('remember').checked) localStorage.setItem(KEY, tok); else localStorage.removeItem(KEY);
    let r;
    let ar;
    try {
      [r, ar] = await Promise.all([
        fetch('/stats', { headers: { 'X-Access-Token': tok } }),
        fetch('/stats/activity?days=' + $('days').value + '&user=' + encodeURIComponent($('user').value), { headers: { 'X-Access-Token': tok } }),
      ]);
    }
    catch (e) { $('msg').textContent = '网络错误：' + e.message; return; }
    if (r.status === 401) { $('msg').textContent = '管理员令牌不对'; return; }
    if (r.status === 404) { $('msg').textContent = 'stats 未启用（服务端未设 ADMIN_TOKEN）'; return; }
    if (!r.ok) { $('msg').textContent = '出错：HTTP ' + r.status; return; }
    if (!ar.ok) { $('msg').textContent = '活动统计出错：HTTP ' + ar.status; return; }
    render(await r.json(), await ar.json());
  }

  function render(d, a) {
    $('since').textContent = '账期起点：' + fmtTime(d.since);
    $('tCount').textContent = fmtNum(d.totals.count);
    $('tAnlas').textContent = fmtNum(d.totals.anlas);
    const entries = Object.entries(d.tokens).sort((a, b) => b[1].anlas - a[1].anlas);
    $('tUsers').textContent = entries.length;
    const selected = $('user').value;
    $('user').innerHTML = '<option value="all">所有用户（各自本地时间）</option>' + (a.users || []).map(u => '<option value="' + u.id + '">' + u.name.replace(/[<&]/g, c => c === '<' ? '&lt;' : '&amp;') + ' · ' + u.timeZone + '</option>').join('');
    if ([...$('user').options].some(o => o.value === selected)) $('user').value = selected;
    const max = Math.max(0, ...a.hours.map(h => h.count || 0));
    $('hours').innerHTML = a.hours.map(h => {
      const heat = h.count && max ? .2 + .8 * Math.sqrt(h.count / max) : 0;
      return '<div class="hour" style="--heat:' + heat + '"><span>' + String(h.hour).padStart(2,'0') + ':00</span><strong>' + h.count + '</strong></div>';
    }).join('');
    $('rows').innerHTML = entries.map(([t, e]) =>
      '<tr><td><code>' + (e.name || ('…' + t.slice(-6))).replace(/[<&]/g, c => c === '<' ? '&lt;' : '&amp;') + '</code></td>' +
      '<td class="num">' + fmtNum(e.count) + '</td>' +
      '<td class="num">' + fmtNum(e.anlas) + '</td>' +
      '<td>' + fmtTime(e.lastAt) + '</td></tr>'
    ).join('') || '<tr><td colspan="4" class="muted">暂无数据</td></tr>';
  }

  async function reset() {
    const tok = $('tok').value.trim();
    if (!tok) { $('msg').textContent = '请先填管理员令牌'; return; }
    if (!confirm('确定清零当前账期的统计？（逐条账本仍在服务器日志里）')) return;
    const r = await fetch('/stats/reset', { method: 'POST', headers: { 'X-Access-Token': tok } });
    if (r.ok) load(); else $('msg').textContent = '清零失败：HTTP ' + r.status;
  }

  $('load').onclick = load;
  $('reset').onclick = reset;
  $('days').onchange = load;
  $('user').onchange = load;
  $('tok').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  if (saved) load();
</script>
</body>
</html>`;

// ---- 直接运行时启动服务 ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const app = createApp(config);
  app.listen(config.port, () => {
    console.log(
      `[nai-proxy] 监听 :${config.port}  生图间隔=${config.minGapMs}–${config.maxGapMs}ms  ` +
        `令牌数=${config.accessTokens.size}  NAI=${config.naiBaseUrl}`
    );
    if (!config.naiKey) console.warn('[nai-proxy] ⚠ 未配置 NAI_KEY，/submit 会拒绝');
    if (config.accessTokens.size === 0)
      console.warn('[nai-proxy] ⚠ 未配置 ACCESS_TOKENS，所有任务接口会拒绝');
  });
}
