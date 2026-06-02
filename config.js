// config.js — 从环境变量读取配置（带默认值）。
// 所有密钥（NAI_KEY / ACCESS_TOKENS）都来自环境变量，代码里不含任何秘密，
// 因此本仓库可以公开。

export function loadConfig(env = process.env) {
  const accessTokens = new Set(
    String(env.ACCESS_TOKENS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  return {
    // 共享 NAI token —— 换 key 就改这个环境变量（Render 上改了会自动重部署）
    naiKey: env.NAI_KEY || '',
    // 逗号分隔的访问令牌，一人一个、方便单独吊销
    accessTokens,

    // Render 会注入 PORT
    port: numEnv(env.PORT, 3000),

    // 总体限速：相邻请求「起点」最小间隔（默认 12s ≈ 5/分钟）
    minGapMs: numEnv(env.MIN_GAP_MS, 12000),
    // 结果保留时长，超时回收释放内存（默认 10 分钟）
    resultTtlMs: numEnv(env.RESULT_TTL_MS, 10 * 60 * 1000),
    // 内存里最多保留多少 job（含已完成），超出驱逐最旧的已结束 job
    maxJobs: numEnv(env.MAX_JOBS, 200),
    // 回收扫描间隔
    reapIntervalMs: numEnv(env.REAP_INTERVAL_MS, 60 * 1000),

    // 可选参数上限（0 = 不限制），防止误操作烧 Anlas
    maxSamples: numEnv(env.MAX_SAMPLES, 0),
    maxSteps: numEnv(env.MAX_STEPS, 0),

    // NAI 接口基址，默认真地址；测试时指向本地 mock
    naiBaseUrl: env.NAI_BASE_URL || 'https://image.novelai.net',

    // 429 / 网络错误重试参数（沿用客户端原来 10 次的思路）
    retry: {
      maxRetries: numEnv(env.NAI_MAX_RETRIES, 10),
      retryBaseMs: numEnv(env.NAI_RETRY_BASE_MS, 3000),
      retryMaxMs: numEnv(env.NAI_RETRY_MAX_MS, 30000),
    },

    // Express body 上限：vibe encoding 较大（单个 ~64KB，可能多个），给足余量
    bodyLimit: env.BODY_LIMIT || '12mb',

    // 用量统计 / 管理端
    adminToken: env.ADMIN_TOKEN || '',     // 设了才开 /stats、/stats/reset（车主专用）
    opusFree: env.OPUS_FREE !== 'false',   // Anlas 估算是否按 Opus 免费档（默认 true）
  };
}

function numEnv(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
