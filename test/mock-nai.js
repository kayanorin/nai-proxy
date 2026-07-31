// test/mock-nai.js — 假 NAI 服务，给本地逻辑验证用（不需要真 key）。
//
// 行为由「请求体里的标记」控制，因为代理只透传 body、不透传客户端自定义头：
//   input 含 MOCK_401      → 返回 401（验 key 失效映射）
//   input 含 MOCK_402      → 返回 402（验余额不足）
//   input 含 MOCK_429xN    → 前 N 次返回 429，之后正常（验退避重试后成功）
//   input 含 MOCK_429      → 每次都 429（验重试耗尽）
//   其它                    → 返回含 n_samples 张 PNG 的真 zip
//
// 另外记录并发数与每次请求时刻，供 smoke 校验「串行」「限速间隔」。

import express from 'express';
import JSZip from 'jszip';
import { pathToFileURL } from 'node:url';

// 一张合法的 1x1 PNG
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

export function createMockApp() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  const state = {
    calls: 0,
    inflight: 0,
    maxInflight: 0,
    concurrencyViolation: false,
    callTimes: [], // 每次进入 generate 的时间戳
    seen: new Map(), // MOCK_429xN 的计数
    balance: 10000,
    subscriptionEnabled: true,
  };

  app.post('/ai/generate-image', async (req, res) => {
    state.calls++;
    state.callTimes.push(Date.now());
    state.inflight++;
    state.maxInflight = Math.max(state.maxInflight, state.inflight);
    if (state.inflight > 1) state.concurrencyViolation = true;
    try {
      const probe = String(req.body?.input || '');
      await delay(80); // 模拟工作耗时，制造并发窗口

      if (probe.includes('MOCK_401')) return res.status(401).json({ message: 'invalid token' });
      if (probe.includes('MOCK_402')) return res.status(402).json({ message: 'insufficient anlas' });

      const m = probe.match(/MOCK_429x(\d+)/);
      if (m) {
        const want = Number(m[1]);
        const n = (state.seen.get(probe) || 0) + 1;
        state.seen.set(probe, n);
        if (n <= want) return res.status(429).json({ message: 'rate limited' });
        // 超过 N 次 → 落到正常返回
      } else if (probe.includes('MOCK_429')) {
        return res.status(429).json({ message: 'rate limited' });
      }

      const count = clampInt(req.body?.parameters?.n_samples, 1, 8);
      const zip = new JSZip();
      for (let i = 0; i < count; i++) zip.file(`image_${i}.png`, PNG_1x1);
      const buf = await zip.generateAsync({ type: 'nodebuffer' });
      state.balance -= 7;
      res.set('Content-Type', 'application/zip');
      res.send(buf);
    } finally {
      state.inflight--;
    }
  });

  app.post('/ai/encode-vibe', async (req, res) => {
    state.calls++;
    state.callTimes.push(Date.now());
    state.inflight++;
    state.maxInflight = Math.max(state.maxInflight, state.inflight);
    if (state.inflight > 1) state.concurrencyViolation = true;
    try {
      await delay(30);
      state.balance -= 2;
      res.type('application/octet-stream').send(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    } finally {
      state.inflight--;
    }
  });

  app.get('/user/subscription', (req, res) => {
    if (!state.subscriptionEnabled) return res.status(503).json({ error: 'mock subscription disabled' });
    res.json({ trainingStepsLeft: { fixedTrainingStepsLeft: state.balance, purchasedTrainingSteps: 0 } });
  });

  app.get('/mock/stats', (req, res) => {
    res.json({
      calls: state.calls,
      maxInflight: state.maxInflight,
      concurrencyViolation: state.concurrencyViolation,
      callTimes: state.callTimes,
      balance: state.balance,
    });
  });
  app.post('/mock/reset', (req, res) => {
    state.calls = 0;
    state.maxInflight = 0;
    state.concurrencyViolation = false;
    state.callTimes = [];
    state.seen.clear();
    state.balance = 10000;
    state.subscriptionEnabled = true;
    res.json({ ok: true });
  });
  app.post('/mock/subscription/:state', (req, res) => {
    state.subscriptionEnabled = req.params.state !== 'off';
    res.json({ enabled: state.subscriptionEnabled });
  });

  app._state = state;
  return app;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function clampInt(v, lo, hi) {
  v = Number(v);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_PORT) || 4545;
  createMockApp().listen(port, () => console.log(`[mock-nai] 监听 :${port}`));
}
