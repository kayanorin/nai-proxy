// anlas.js — NAI 生图 Anlas 点数【估算】。
//
// 注意：这是近似值，只供拼车内部「谁用得多」分摊参考。NAI 官方不在生图响应里回传计费，
// 真实余额请车主自己在 NAI 后台手工核对（本服务也不查询余额）。
//
// 估算口径：
//  · 单张原始点数用社区常见的 NAI 估算式（约 1024×1024 / 28 步 ≈ 20 点）。
//  · Opus 免费档：单张 ≤ 1024×1024 且 steps ≤ 28 记 0 点（含批量，按 Opus「免费生成」处理）。
//  · 超出免费档（更大尺寸 / 更高步数）：perSample × n_samples。
//  · 非 Opus（OPUS_FREE=false）：一律 perSample × n_samples。
export function estimateAnlas(body, { opus = true } = {}) {
  const p = (body && body.parameters) || {};
  const width = num(p.width);
  const height = num(p.height);
  const steps = num(p.steps);
  const samples = Math.max(1, num(p.n_samples) || 1);
  const area = width * height;
  if (!area || !steps) return 0;

  const perSample = Math.ceil(
    2951823174884865e-21 * area + 5.753298233447344e-7 * area * steps
  );
  const withinOpusFree = opus && area <= 1024 * 1024 && steps <= 28;
  return withinOpusFree ? 0 : perSample * samples;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
