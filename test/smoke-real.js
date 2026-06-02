// test/smoke-real.js — 第 2 层验证（本地、真 key）。
// 打通 提交→轮询→取 zip，确认 NAI 真收下透传 body、真回图（不经网页，纯验服务端）。
//
// 前置：另开一个终端把代理跑起来（带真 key）：
//   PowerShell:  $env:NAI_KEY="真key"; $env:ACCESS_TOKENS="tok1"; node server.js
//   或（任意 shell，Node ≥20.6）:  node --env-file=.env server.js
// 然后本终端跑：
//   node test/smoke-real.js
//   可用环境变量覆盖目标：BASE（默认 http://localhost:3000）、TOKEN（默认 tok1）
//   PowerShell 覆盖示例:  $env:TOKEN="tok1"; node test/smoke-real.js
//
// 产物（test 目录下，已被 .gitignore 忽略）：
//   result-real.zip —— NAI 原样回传的 zip
//   result-real.png —— zip 里第一张图，直接打开看一眼确认是正常图
//
// 花费：832x1216 / 28 步 / 1 张，Opus 档免费；非 Opus 约几 Anlas。

import JSZip from 'jszip';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/+$/, '');
const TOKEN = process.env.TOKEN || 'tok1';
const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPT = 'masterpiece, best quality, scenery, detailed';
const NEG = 'lowres, bad anatomy, bad hands, worst quality, jpeg artifacts';

// 与网页客户端 callNAI 同构的最小 V4 body（透传给 NAI）。
const body = {
  input: PROMPT,
  model: 'nai-diffusion-4-5-full',
  action: 'generate',
  parameters: {
    width: 512,
    height: 512,
    scale: 5,
    cfg_rescale: 0,
    sampler: 'k_euler_ancestral',
    steps: 23,
    n_samples: 2,
    seed: 42,
    noise_schedule: 'karras',
    params_version: 3,
    sm: false,
    sm_dyn: false,
    skip_cfg_above_sigma: null,
    use_coords: false,
    legacy_uc: false,
    qualityToggle: true,
    ucPreset: 0,
    uc: NEG,
    negative_prompt: NEG,
    v4_prompt: {
      caption: { base_caption: PROMPT, char_captions: [] },
      use_coords: false,
      use_order: true,
      legacy_uc: false,
    },
    v4_negative_prompt: {
      caption: { base_caption: NEG, char_captions: [] },
      use_coords: false,
      use_order: false,
      legacy_uc: false,
    },
  },
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const authHdr = { 'X-Access-Token': TOKEN };

function die(msg) {
  console.error('\n❌ ' + msg);
  process.exit(1);
}

async function main() {
  console.log(`[smoke-real] 目标代理：${BASE}   令牌：${TOKEN}`);

  // 0. 健康检查
  let health;
  try {
    const r = await fetch(`${BASE}/`);
    health = await r.json();
  } catch (e) {
    die(`连不上代理 ${BASE} —— 先在另一个终端把 server.js 跑起来（带真 key）。原因：${e.message}`);
  }
  console.log('  ✓ GET /          ' + JSON.stringify(health));

  // 1. 提交
  const sub = await fetch(`${BASE}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHdr },
    body: JSON.stringify(body),
  });
  const subData = await sub.json().catch(() => ({}));
  if (!sub.ok) {
    die(`POST /submit 失败 HTTP ${sub.status}：${subData.error || ''}（code=${subData.code || '-'}）` +
        (sub.status === 401 ? '\n   → 令牌不对：确认服务端 ACCESS_TOKENS 含此 TOKEN。' : '') +
        (sub.status === 503 ? '\n   → 服务端没配 NAI_KEY / ACCESS_TOKENS。' : ''));
  }
  const jobId = subData.job_id;
  console.log(`  ✓ POST /submit   job_id=${jobId}  起始位次=${subData.position}`);

  // 2. 轮询（最多 3 分钟）
  const deadline = Date.now() + 180000;
  let last = '';
  while (true) {
    if (Date.now() > deadline) die('轮询超时（3 分钟）。看代理终端日志：是否在反复重试 429，或卡在 running。');
    await delay(2000);
    const r = await fetch(`${BASE}/status/${jobId}`, { headers: authHdr });
    if (r.status === 404) die('任务消失（404）：代理重启过或被 TTL 回收。重跑一次。');
    const s = await r.json().catch(() => ({}));
    if (!r.ok) die(`GET /status 失败 HTTP ${r.status}：${s.error || ''}`);
    if (s.status !== last) {
      console.log(`    … status=${s.status}${s.position != null ? `  位次=${s.position}` : ''}`);
      last = s.status;
    }
    if (s.status === 'done') break;
    if (s.status === 'failed') {
      die(`任务 failed：${s.error || ''}（code=${s.code || '-'}）` +
          (s.code === 'KEY_INVALID' ? '\n   → NAI key 失效/过期，更新 NAI_KEY 后重启代理。' : '') +
          (s.code === 'INSUFFICIENT_FUNDS' ? '\n   → Anlas 余额不足。' : ''));
    }
    if (s.status === 'cancelled') die('任务被取消了。');
  }

  // 3. 取结果 zip
  const res = await fetch(`${BASE}/result/${jobId}`, { headers: authHdr });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    die(`GET /result 失败 HTTP ${res.status}：${e.error || ''}`);
  }
  const contentType = res.headers.get('content-type');
  const zipBuf = Buffer.from(await res.arrayBuffer());
  const zipPath = join(__dirname, 'result-real.zip');
  writeFileSync(zipPath, zipBuf);
  console.log(`  ✓ GET /result    ${(zipBuf.length / 1024).toFixed(1)} KB  content-type=${contentType}`);

  // 4. 解 zip + 落地首图
  let zip;
  try {
    zip = await JSZip.loadAsync(zipBuf);
  } catch (e) {
    die(`回传的不是合法 zip（content-type=${contentType}）：${e.message}`);
  }
  const pngs = Object.keys(zip.files).filter((n) => !zip.files[n].dir && /\.png$/i.test(n));
  if (!pngs.length) die(`zip 里没有 PNG（内含：${Object.keys(zip.files).join(', ') || '空'}）`);
  const firstPng = await zip.files[pngs[0]].async('nodebuffer');
  const pngPath = join(__dirname, 'result-real.png');
  writeFileSync(pngPath, firstPng);

  console.log(`\n✅ 通过：NAI 收下透传 body 并回了 ${pngs.length} 张图（zip 内：${pngs.join(', ')}）`);
  console.log(`   zip  → ${zipPath}`);
  console.log(`   首图 → ${pngPath}  （打开看一眼确认是正常图）`);
}

main().catch((e) => die(e?.stack || e?.message || String(e)));
