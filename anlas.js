// anlas.js — NAI 生图 Anlas 点数【估算】。
//
// 注意：这是近似值。真实记账以「任务前后查 NAI 余额取差值」为准（见 server.js runner），
// 本文件只用于两处：排队时给出预估显示、余额查不到时的记账回落。
//
// 估算口径（对齐官网前端逆向出的算法）：
//  · 基础价用社区常见的 NAI 估算式（约 1024×1024 / 28 步 ≈ 20 点）。
//  · img2img / 局部重绘：基础价按 strength 折算，且单张最低 2 点。
//  · Opus 免费档（单张 ≤ 1024×1024 且 steps ≤ 28）：免费覆盖 1 张，批量里多出的按张计。
//  · precise / 角色参考：每张参考图 5 点 × 请求张数，Opus 免费档【不豁免】。
//  · vibe 引用：第 5 个起每个 +2（本项目只传已缓存编码，编码本身的 2 点在 encode 时另计）。
export function estimateAnlas(body, { opus = true } = {}) {
  const p = (body && body.parameters) || {};
  const width = num(p.width);
  const height = num(p.height);
  const steps = num(p.steps);
  const samples = Math.max(1, num(p.n_samples) || 1);
  const area = width * height;
  if (!area || !steps) return 0;

  const base = Math.ceil(
    2951823174884865e-21 * area + 5.753298233447344e-7 * area * steps
  );
  // img2img / 局部重绘：按 strength 折算，单张最低 2 点（无底图时因子为 1）
  const strength = p.image ? (num(p.strength) || 1) : 1;
  const perSample = Math.max(Math.ceil(base * strength), 2);
  const withinOpusFree = opus && area <= 1024 * 1024 && steps <= 28;
  // Opus 免费档免费覆盖单张；批量里多出的 (samples-1) 张按张计。非 Opus / 超规格：全部按张计。
  const billable = withinOpusFree ? Math.max(0, samples - 1) : samples;
  // precise（角色参考）：每参考图 5 点 × 请求张数，Opus 免费档不豁免
  const directorN = Array.isArray(p.director_reference_images) ? p.director_reference_images.length : 0;
  // vibe 引用：第 5 个起每个 +2
  const vibeN = Array.isArray(p.reference_image_multiple_cached) ? p.reference_image_multiple_cached.length : 0;
  return billable * perSample + 5 * directorN * samples + Math.max(0, vibeN - 4) * 2;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
