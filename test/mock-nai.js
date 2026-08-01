// test/mock-nai.js — 假 NAI 服务，给本地逻辑验证用（不需要真 key）。
//
// 行为由「请求体里的标记」控制，因为代理只透传 body、不透传客户端自定义头：
//   input 含 MOCK_401      → 返回 401（验 key 失效映射）
//   input 含 MOCK_402      → 返回 402（验余额不足）
//   input 含 MOCK_429xN    → 前 N 次返回 429，之后正常（验退避重试后成功）
//   input 含 MOCK_429      → 每次都 429（验重试耗尽）
//   其它                    → 返回含 n_samples 张 PNG 的真 zip
//
// 还 mock 了 /ai/encode-vibe（回固定裸字节）和 /user/subscription（假余额，按次扣减），
// 供验证 vibe 编码链路与「余额差值＝真实消耗」的统计口径。
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

// encode-vibe 的假返回：一段固定裸字节（真接口回的也是不透明二进制）
export const MOCK_VIBE_BYTES = Buffer.from([0x4d, 0x4f, 0x43, 0x4b, 0x56, 0x49, 0x42, 0x45, 0x00, 0x01, 0x02, 0xff]);

// 假余额里一次生图的扣点（随便取的固定值，只要与估算不同就能验出记的是实测值）
export const MOCK_GENERATE_COST = 7;

export function createMockApp() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  const state = {
    calls: 0,
    encodeCalls: 0,
    inflight: 0,
    // 假余额：generate-image 每次扣 GENERATE_COST，encode-vibe 扣 2（验「实测差值」口径）
    balance: 10000,
    subscriptionDown: false,
    maxInflight: 0,
    concurrencyViolation: false,
    callTimes: [], // 每次进入 generate 的时间戳
    seen: new Map(), // MOCK_429xN 的计数
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
      state.balance -= MOCK_GENERATE_COST;
      res.set('Content-Type', 'application/zip');
      res.send(buf);
    } finally {
      state.inflight--;
    }
  });

  // vibe 编码：回一段固定裸字节，并计入串行/限速统计（与生图同一条队列）
  app.post('/ai/encode-vibe', async (req, res) => {
    state.calls++;
    state.callTimes.push(Date.now());
    state.inflight++;
    state.maxInflight = Math.max(state.maxInflight, state.inflight);
    if (state.inflight > 1) state.concurrencyViolation = true;
    try {
      await delay(40);
      state.encodeCalls++;
      state.balance -= 2;
      res.set('Content-Type', 'application/octet-stream');
      res.send(MOCK_VIBE_BYTES);
    } finally {
      state.inflight--;
    }
  });

  // 账号接口：查 Anlas 余额（真服务在 api.novelai.net，测试里与生图共用一个 mock）
  app.get('/user/subscription', (req, res) => {
    if (state.subscriptionDown) return res.status(500).json({ message: 'down' });
    res.json({
      tier: 3,
      trainingStepsLeft: { fixedTrainingStepsLeft: state.balance, purchasedTrainingSteps: 0 },
    });
  });
  // 开关：模拟余额接口挂掉（验记账回落估算）
  app.post('/mock/subscription-down', (req, res) => {
    state.subscriptionDown = String(req.query.on || '') !== 'false';
    res.json({ ok: true, down: state.subscriptionDown });
  });
  app.get('/mock/balance', (req, res) => res.json({ balance: state.balance }));

  app.get('/mock/stats', (req, res) => {
    res.json({
      calls: state.calls,
      encodeCalls: state.encodeCalls,
      maxInflight: state.maxInflight,
      concurrencyViolation: state.concurrencyViolation,
      callTimes: state.callTimes,
    });
  });
  app.post('/mock/reset', (req, res) => {
    state.calls = 0;
    state.encodeCalls = 0;
    state.maxInflight = 0;
    state.concurrencyViolation = false;
    state.callTimes = [];
    state.seen.clear();
    state.balance = 10000;
    state.subscriptionDown = false;
    res.json({ ok: true });
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
