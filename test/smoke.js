// test/smoke.js — 第 1 层验证（本地、免真 key）。
// 启动 mock NAI + 代理（NAI_BASE_URL 指向 mock），断言：
//   令牌拒绝 / 提交→轮询→取 zip / 任务绑定令牌 / 串行不并发 / 限速间隔 /
//   429 重试后成功 / 401→KEY_INVALID / 未完成取结果 409 / 取消排队任务 / TTL 回收。
//
// 跑法：npm install && npm run smoke

import JSZip from 'jszip';
import { createMockApp, MOCK_VIBE_BYTES, MOCK_GENERATE_COST } from './mock-nai.js';
import { createApp } from '../server.js';
import { estimateAnlas } from '../anlas.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n      ${e?.message || e}`);
    failed++;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function start(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function cfg(over = {}) {
  return {
    naiKey: 'good-key',
    accessTokens: new Set(['tok1', 'tok2']),
    port: 0,
    minGapMs: 50,
    maxGapMs: 50,
    encodeMinGapMs: 10,
    random: () => 0,
    resultTtlMs: 600000,
    maxJobs: 200,
    reapIntervalMs: 60000,
    maxSamples: 0,
    maxSteps: 0,
    naiBaseUrl: MOCK_BASE,
    naiApiBaseUrl: MOCK_BASE,
    retry: { maxRetries: 5, retryBaseMs: 30, retryMaxMs: 120 },
    bodyLimit: '12mb',
    adminToken: 'admin',
    opusFree: true,
    statsDbPath: ':memory:',
    statsRetentionDays: 90,
    userProfiles: new Map([
      ['tok1', { name: 'Alice', timeZone: 'America/Los_Angeles' }],
      ['tok2', { name: 'Bob', timeZone: 'Asia/Shanghai' }],
    ]),
    ...over,
  };
}

async function withProxy(over, fn) {
  const app = createApp(cfg(over));
  const { server, base } = await start(app);
  try {
    await fn({ app, base, queue: app.get('queue') });
  } finally {
    app.get('queue').stopReaper();
    server.close();
  }
}

function naiBody(input = '1girl', params = {}) {
  return {
    input,
    model: 'nai-diffusion-4-5-full',
    action: 'generate',
    parameters: { n_samples: 1, steps: 28, ...params },
  };
}

async function submit(base, body, token = 'tok1') {
  return fetch(base + '/submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Access-Token': token } : {}),
    },
    body: JSON.stringify(body),
  });
}
async function statusReq(base, id, token = 'tok1') {
  return fetch(base + '/status/' + id, { headers: token ? { 'X-Access-Token': token } : {} });
}

function vibeBody(ie = 0.5, image = 'QUJD') {
  return { image, information_extracted: ie, model: 'nai-diffusion-4-5-full' };
}
async function encodeVibe(base, body, token = 'tok1') {
  return fetch(base + '/encode-vibe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Access-Token': token } : {}),
    },
    body: JSON.stringify(body),
  });
}
async function submitId(base, body, token = 'tok1') {
  const r = await submit(base, body, token);
  const j = await r.json();
  return j.job_id;
}
async function waitJob(base, id, token = 'tok1', timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = await (await statusReq(base, id, token)).json();
    if (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') return j;
    await delay(40);
  }
  throw new Error('waitJob 超时: ' + id);
}
const mockStats = () => fetch(MOCK_BASE + '/mock/stats').then((r) => r.json());
const mockReset = () => fetch(MOCK_BASE + '/mock/reset', { method: 'POST' });
// 等上一个测试可能残留的在飞请求结束（mock 工作 ~80ms），再清零统计，
// 避免跨测试的请求污染「串行 / 限速 / 429」这几项基于 mock 计数的断言。
async function drainAndReset() {
  await delay(250);
  await mockReset();
}

// ---- 启动 mock ----
const mock = await start(createMockApp());
const MOCK_BASE = mock.base;

console.log('NAI 拼车分发服务 · 第 1 层冒烟（mock，无真 key）\n');

await test('健康检查 + CORS 预检', () =>
  withProxy({}, async ({ base }) => {
    const h = await (await fetch(base + '/')).json();
    assert(h.ok === true, 'GET / 应 ok');
    const opt = await fetch(base + '/submit', { method: 'OPTIONS' });
    assert(opt.status === 204, `预检应 204，实际 ${opt.status}`);
    const allow = opt.headers.get('access-control-allow-headers') || '';
    assert(allow.includes('X-Access-Token'), 'CORS 应允许 X-Access-Token');
    assert(allow.toLowerCase().includes('authorization'), 'CORS 应允许 Authorization（NAI 兼容端点必需）');
  }));

await test('无令牌 / 错令牌 → 401', () =>
  withProxy({}, async ({ base }) => {
    assert((await submit(base, naiBody(), null)).status === 401, '无令牌应 401');
    assert((await submit(base, naiBody(), 'nope')).status === 401, '错令牌应 401');
  }));

await test('提交 → 轮询 → 取 zip（含 PNG）', () =>
  withProxy({ minGapMs: 10 }, async ({ base }) => {
    const id = await submitId(base, naiBody('1girl', { n_samples: 2 }));
    const j = await waitJob(base, id);
    assert(j.status === 'done', `应 done，实际 ${j.status} ${j.error || ''}`);
    const rr = await fetch(base + '/result/' + id, { headers: { 'X-Access-Token': 'tok1' } });
    assert(rr.status === 200, `取结果应 200，实际 ${rr.status}`);
    assert((rr.headers.get('content-type') || '').includes('zip'), '应是 zip');
    const zip = await JSZip.loadAsync(Buffer.from(await rr.arrayBuffer()));
    const pngs = Object.keys(zip.files).filter((n) => n.endsWith('.png'));
    assert(pngs.length === 2, `应含 2 张 PNG，实际 ${pngs.length}`);
  }));

await test('NAI 兼容端点：Bearer 令牌 → 同步取 zip（含 PNG）', () =>
  withProxy({ minGapMs: 10 }, async ({ base }) => {
    const r = await fetch(base + '/ai/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok1' },
      body: JSON.stringify(naiBody('1girl', { n_samples: 2 })),
    });
    assert(r.status === 200, `应 200，实际 ${r.status}`);
    assert((r.headers.get('content-type') || '').includes('zip'), '应原样回传 zip');
    const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
    const pngs = Object.keys(zip.files).filter((n) => n.endsWith('.png'));
    assert(pngs.length === 2, `应含 2 张 PNG，实际 ${pngs.length}`);
  }));

await test('NAI 兼容端点：无/错 Bearer 令牌 → 401', () =>
  withProxy({ minGapMs: 10 }, async ({ base }) => {
    const noTok = await fetch(base + '/ai/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(naiBody()),
    });
    assert(noTok.status === 401, `无令牌应 401，实际 ${noTok.status}`);
    const badTok = await fetch(base + '/ai/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
      body: JSON.stringify(naiBody()),
    });
    assert(badTok.status === 401, `错令牌应 401，实际 ${badTok.status}`);
  }));

await test('任务绑定令牌：他人令牌 → 403', () =>
  withProxy({ minGapMs: 10 }, async ({ base }) => {
    const id = await submitId(base, naiBody(), 'tok1');
    const r = await statusReq(base, id, 'tok2');
    assert(r.status === 403, `他人令牌应 403，实际 ${r.status}`);
    await waitJob(base, id); // 排空，避免在飞请求泄漏到下个测试
  }));

await test('串行：任意时刻最多 1 个在飞', () =>
  withProxy({ minGapMs: 10 }, async ({ base }) => {
    await drainAndReset();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await submitId(base, naiBody('serial_' + i)));
    for (const id of ids) {
      const j = await waitJob(base, id);
      assert(j.status === 'done', `应 done，实际 ${j.status}`);
    }
    const s = await mockStats();
    assert(s.maxInflight === 1, `应串行 maxInflight=1，实际 ${s.maxInflight}`);
    assert(!s.concurrencyViolation, '不应出现并发重叠');
  }));

await test('随机限速：相邻请求起点落在 MIN/MAX_GAP_MS 范围', () =>
  withProxy({ minGapMs: 200, maxGapMs: 400, random: () => 0.5 }, async ({ base }) => {
    await drainAndReset();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await submitId(base, naiBody('gap_' + i)));
    for (const id of ids) await waitJob(base, id);
    const s = await mockStats();
    const t = s.callTimes.slice().sort((a, b) => a - b);
    for (let i = 1; i < t.length; i++) {
      const d = t[i] - t[i - 1];
      assert(d >= 300 - 60, `相邻间隔应接近 300ms 且不低于容差，实际 ${d}ms`);
      assert(d <= 300 + 100, `相邻间隔不应超过随机目标过多，实际 ${d}ms`);
    }
  }));

await test('429 退避重试后成功', () =>
  withProxy({ minGapMs: 10 }, async ({ base }) => {
    await drainAndReset();
    const id = await submitId(base, naiBody('MOCK_429x2 retry'));
    const j = await waitJob(base, id);
    assert(j.status === 'done', `429 重试后应 done，实际 ${j.status} ${j.error || ''}`);
    const s = await mockStats();
    assert(s.calls >= 3, `应 ≥3 次调用（2×429 + 1 成功），实际 ${s.calls}`);
    const activity = await (await fetch(base + '/stats/me/activity?days=7', { headers: { 'X-Access-Token': 'tok1' } })).json();
    assert(activity.totals.requests === 1, `重试只应计一次，实际 ${activity.totals.requests}`);
  }));

await test('401 → 任务 failed + KEY_INVALID', () =>
  withProxy({ minGapMs: 10 }, async ({ base }) => {
    const id = await submitId(base, naiBody('MOCK_401'));
    const j = await waitJob(base, id);
    assert(j.status === 'failed', `应 failed，实际 ${j.status}`);
    assert(j.code === 'KEY_INVALID', `应 KEY_INVALID，实际 ${j.code}`);
    const activity = await (await fetch(base + '/stats/me/activity?days=7', { headers: { 'X-Access-Token': 'tok1' } })).json();
    assert(activity.totals.requests === 0, '失败任务不应计活动');
  }));

await test('未完成取结果 → 409', () =>
  withProxy({ minGapMs: 5000 }, async ({ base }) => {
    const id = await submitId(base, naiBody('pending'));
    const rr = await fetch(base + '/result/' + id, { headers: { 'X-Access-Token': 'tok1' } });
    assert(rr.status === 409, `未完成取结果应 409，实际 ${rr.status}`);
  }));

await test('取消排队中的任务', () =>
  withProxy({ minGapMs: 5000 }, async ({ base }) => {
    const id1 = await submitId(base, naiBody('keep'));
    const id2 = await submitId(base, naiBody('drop'));
    const c = await (
      await fetch(base + '/cancel/' + id2, {
        method: 'POST',
        headers: { 'X-Access-Token': 'tok1' },
      })
    ).json();
    assert(c.cancelled === true, '排队任务应可取消');
    const s2 = await (await statusReq(base, id2)).json();
    assert(s2.status === 'cancelled', `应 cancelled，实际 ${s2.status}`);
    await waitJob(base, id1); // 排空运行中的 id1
    const activity = await (await fetch(base + '/stats/me/activity?days=7', { headers: { 'X-Access-Token': 'tok1' } })).json();
    assert(activity.totals.requests === 1, `取消任务不应计活动，实际 ${activity.totals.requests}`);
  }));

await test('TTL 回收：超时后 job 404', () =>
  withProxy({ minGapMs: 10, resultTtlMs: 200 }, async ({ base, queue }) => {
    const id = await submitId(base, naiBody('ttl'));
    await waitJob(base, id);
    await delay(300);
    queue._reap();
    const r = await statusReq(base, id);
    assert(r.status === 404, `TTL 回收后应 404，实际 ${r.status}`);
  }));

await test('活动 self API：只返回本人 24 小时数据', () =>
  withProxy({ minGapMs: 10 }, async ({ base }) => {
    await drainAndReset();
    const id = await submitId(base, naiBody('activity-self', { width: 1024, height: 1024 }), 'tok1');
    await waitJob(base, id, 'tok1');
    const r = await fetch(base + '/stats/me/activity?days=7', { headers: { 'X-Access-Token': 'tok1' } });
    const data = await r.json();
    assert(r.status === 200, `应 200，实际 ${r.status}`);
    assert(data.scope.name === 'Alice', `应是 Alice，实际 ${data.scope.name}`);
    assert(data.scope.timeZone === 'America/Los_Angeles', '应返回配置时区');
    assert(data.hours.length === 24, '应固定返回 24 小时');
    assert(data.totals.requests === 1, `应 1 次，实际 ${data.totals.requests}`);
    assert(!JSON.stringify(data).includes('tok1'), '响应不应泄露原始令牌');
  }));

await test('活动 admin API：聚合、参数校验与 reset', () =>
  withProxy({ minGapMs: 10 }, async ({ base }) => {
    await drainAndReset();
    const a = await submitId(base, naiBody('admin-a', { width: 1024, height: 1024 }), 'tok1');
    const b = await submitId(base, naiBody('admin-b', { width: 1024, height: 1024 }), 'tok2');
    await waitJob(base, a, 'tok1');
    await waitJob(base, b, 'tok2');
    const headers = { 'X-Access-Token': 'admin' };
    assert((await fetch(base + '/stats/activity?days=7', { headers: { 'X-Access-Token': 'nope' } })).status === 401, '错管理员令牌应 401');
    assert((await fetch(base + '/stats/me/activity?days=7', { headers: { 'X-Access-Token': 'nope' } })).status === 401, '错用户令牌应 401');
    const all = await (await fetch(base + '/stats/activity?days=7&user=all', { headers })).json();
    assert(all.totals.requests === 2, `聚合应 2 次，实际 ${all.totals.requests}`);
    assert(all.users.length === 2, '管理员应拿到用户选择列表');
    const aliceId = all.users.find((u) => u.name === 'Alice')?.id;
    const alice = await (await fetch(base + `/stats/activity?days=7&user=${aliceId}`, { headers })).json();
    assert(alice.scope.name === 'Alice' && alice.totals.requests === 1, '管理员单用户查询应只返回 Alice');
    assert((await fetch(base + '/stats/activity?days=8', { headers })).status === 400, '非法 days 应 400');
    assert((await fetch(base + '/stats/activity?days=7&user=missing', { headers })).status === 400, '未知用户应 400');
    await fetch(base + '/stats/reset', { method: 'POST', headers });
    const empty = await (await fetch(base + '/stats/activity?days=7&user=all', { headers })).json();
    assert(empty.totals.requests === 0, 'reset 后活动历史应清空');
  }));

await test('vibe 编码：提交 → 轮询 → 取裸字节，计 2 Anlas', () =>
  withProxy({ minGapMs: 10 }, async ({ base }) => {
    const r = await encodeVibe(base, vibeBody());
    assert(r.status === 200, `提交应 200，实际 ${r.status}`);
    const sub = await r.json();
    assert(sub.anlas_est === 2, `估点应为 2，实际 ${sub.anlas_est}`);
    const j = await waitJob(base, sub.job_id);
    assert(j.status === 'done', `应 done，实际 ${j.status} ${j.error || ''}`);
    const rr = await fetch(base + '/result/' + sub.job_id, { headers: { 'X-Access-Token': 'tok1' } });
    assert(rr.status === 200, `取结果应 200，实际 ${rr.status}`);
    assert(!rr.headers.get('content-disposition'), 'vibe 结果不该带 zip 附件头');
    const got = Buffer.from(await rr.arrayBuffer());
    assert(got.equals(MOCK_VIBE_BYTES), 'vibe 字节应与 mock 返回一致');
    const st = await (await fetch(base + '/stats', { headers: { 'X-Access-Token': 'admin' } })).json();
    assert(st.tokens?.tok1?.anlas === 2, `该令牌应记 2 Anlas，实际 ${st.tokens?.tok1?.anlas}`);
  }));

await test('vibe 编码：缺字段 → 400，无令牌 → 401', () =>
  withProxy({ minGapMs: 10 }, async ({ base }) => {
    const bad = await encodeVibe(base, { model: 'nai-diffusion-4-5-full' });
    assert(bad.status === 400, `缺字段应 400，实际 ${bad.status}`);
    const noTok = await encodeVibe(base, vibeBody(), null);
    assert(noTok.status === 401, `无令牌应 401，实际 ${noTok.status}`);
  }));

// body 超限的 413 必须带 CORS 头：否则浏览器把它当 CORS 违规拦掉，
// 前端只看得到「Failed to fetch」，用户完全不知道是图太大（曾经踩过）。
await test('body 超限 → 413 JSON 且带 CORS 头', () =>
  withProxy({ minGapMs: 10, bodyLimit: '100kb' }, async ({ base }) => {
    const r = await encodeVibe(base, vibeBody(0.5, 'A'.repeat(200 * 1024)));
    assert(r.status === 413, `超限应 413，实际 ${r.status}`);
    assert(r.headers.get('access-control-allow-origin') === '*', '413 响应必须带 CORS 头');
    const j = await r.json();
    assert(j.code === 'BODY_TOO_LARGE', `应回 BODY_TOO_LARGE，实际 ${j.code}`);
  }));

await test('点数统计走实测：记的是余额差值而非估算', () =>
  withProxy({ minGapMs: 10 }, async ({ base }) => {
    await drainAndReset();
    // 1024×1024 / 28 步 / 2 张：估算是 20，mock 每次生图只扣 MOCK_GENERATE_COST
    const body = naiBody('measured', { n_samples: 2, width: 1024, height: 1024, steps: 28 });
    assert(estimateAnlas(body, { opus: true }) === 20, '前提：该 body 的估算应为 20');
    const j = await waitJob(base, await submitId(base, body));
    assert(j.status === 'done', `应 done，实际 ${j.status}`);
    assert(j.anlas_actual === MOCK_GENERATE_COST, `/status 应回实测 ${MOCK_GENERATE_COST}，实际 ${j.anlas_actual}`);
    const st = await (await fetch(base + '/stats', { headers: { 'X-Access-Token': 'admin' } })).json();
    assert(st.tokens?.tok1?.anlas === MOCK_GENERATE_COST,
      `应记实测 ${MOCK_GENERATE_COST}，实际 ${st.tokens?.tok1?.anlas}`);
  }));

await test('余额接口挂掉 → 记账回落估算，任务不受影响', () =>
  withProxy({ minGapMs: 10 }, async ({ base }) => {
    await drainAndReset();
    await fetch(MOCK_BASE + '/mock/subscription-down', { method: 'POST' });
    try {
      const body = naiBody('fallback', { n_samples: 2, width: 1024, height: 1024, steps: 28 });
      const j = await waitJob(base, await submitId(base, body));
      assert(j.status === 'done', `应 done，实际 ${j.status} ${j.error || ''}`);
      assert(j.anlas_actual === undefined, '查不到余额时不该有实测值');
      const st = await (await fetch(base + '/stats', { headers: { 'X-Access-Token': 'admin' } })).json();
      assert(st.tokens?.tok1?.anlas === 20, `应回落估算 20，实际 ${st.tokens?.tok1?.anlas}`);
    } finally {
      await fetch(MOCK_BASE + '/mock/subscription-down?on=false', { method: 'POST' });
    }
  }));

await test('GET /balance：回当前余额，无令牌 401', () =>
  withProxy({ minGapMs: 10 }, async ({ base }) => {
    await drainAndReset();
    const noTok = await fetch(base + '/balance');
    assert(noTok.status === 401, `无令牌应 401，实际 ${noTok.status}`);
    const r = await fetch(base + '/balance', { headers: { 'X-Access-Token': 'tok1' } });
    assert(r.status === 200, `应 200，实际 ${r.status}`);
    const j = await r.json();
    const real = (await (await fetch(MOCK_BASE + '/mock/balance')).json()).balance;
    assert(j.balance === real, `余额应为 ${real}，实际 ${j.balance}`);
  }));

await test('估算公式：局部重绘按 strength 折算、precise 参考每张 5 点', () => {
  const free = { parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 } };
  assert(estimateAnlas(free, { opus: true }) === 0, 'Opus 免费档单张 txt2img 应为 0');

  const director = {
    parameters: { ...free.parameters, director_reference_images: ['ref1'] },
  };
  assert(estimateAnlas(director, { opus: true }) === 5, `带 1 张 precise 参考应为 5，实际 ${estimateAnlas(director, { opus: true })}`);

  const infill = { parameters: { ...free.parameters, image: 'base64', strength: 0.5 } };
  assert(estimateAnlas(infill, { opus: true }) === 0, '免费档内的局部重绘仍为 0');

  // 超出免费档（2 张）时 strength 折算才看得出来：20 → ceil(20×0.5)=10，两张按 1 张计
  const infillPaid = { parameters: { ...infill.parameters, n_samples: 2 } };
  assert(estimateAnlas(infillPaid, { opus: true }) === 10, `strength 0.5 应折半为 10，实际 ${estimateAnlas(infillPaid, { opus: true })}`);
});

console.log(`\n${failed ? '✗ 失败' : '✓ 全部通过'}：${passed} / ${passed + failed}`);
mock.server.close();
process.exit(failed ? 1 : 0);
