// anlas.js — NAI 生图 Anlas 点数【估算】。
//
// 注意：这是近似值，只供拼车内部「谁用得多」分摊参考。NAI 官方不在生图响应里回传计费，
// 真实余额请车主自己在 NAI 后台手工核对（本服务也不查询余额）。
//
// 估算口径：
//  · 单张原始点数用社区常见的 NAI 估算式（约 1024×1024 / 28 步 ≈ 20 点）。
//  · Opus 免费档（单张 ≤ 1024×1024 且 steps ≤ 28）：免费覆盖 1 张，批量里多出的按张计。
//  · 超出免费档（更大尺寸 / 更高步数）：全部按张计 perSample × n_samples。
//  · 非 Opus（OPUS_FREE=false）：一律 perSample × n_samples。
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
  const strength = p.image ? (num(p.strength) || 1) : 1;
  const perSample = Math.max(Math.ceil(base * strength), 2);
  const withinOpusFree = opus && area <= 1024 * 1024 && steps <= 28;
  // Opus 免费档免费覆盖单张；批量里多出的 (samples-1) 张按张计。非 Opus / 超规格：全部按张计。
  const billable = withinOpusFree ? Math.max(0, samples - 1) : samples;
  const directorN = Array.isArray(p.director_reference_images) ? p.director_reference_images.length : 0;
  const vibeN = Array.isArray(p.reference_image_multiple_cached) ? p.reference_image_multiple_cached.length : 0;
  return billable * perSample + 5 * directorN * samples + Math.max(0, vibeN - 4) * 2;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
