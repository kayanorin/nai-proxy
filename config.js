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
  const userProfiles = parseUserProfiles(env.USER_PROFILES_JSON, accessTokens);
  const minGapMs = numEnv(env.MIN_GAP_MS, 8000);
  const maxGapMs = Math.max(minGapMs, numEnv(env.MAX_GAP_MS, 12000));

  return {
    // 共享 NAI token —— 换 key 就改这个环境变量（Render 上改了会自动重部署）
    naiKey: env.NAI_KEY || '',
    // 逗号分隔的访问令牌，一人一个、方便单独吊销
    accessTokens,
    userProfiles,

    // Render 会注入 PORT
    port: numEnv(env.PORT, 3000),

    // 总体限速：每个生图任务独立抽取相邻请求「起点」间隔（默认 8–12s）
    minGapMs,
    maxGapMs,
    // vibe 编码任务的间隔（比生图轻很多，可以更密；仍走同一条串行队列）
    encodeMinGapMs: numEnv(env.ENCODE_MIN_GAP_MS, 3000),
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
    // NAI 订阅/额度接口已迁到 image host；旧 api host 会要求客户端改用 image URL。
    naiApiBaseUrl: env.NAI_API_BASE_URL || 'https://image.novelai.net',

    // 429 / 网络错误重试参数（沿用客户端原来 10 次的思路）
    retry: {
      maxRetries: numEnv(env.NAI_MAX_RETRIES, 10),
      retryBaseMs: numEnv(env.NAI_RETRY_BASE_MS, 3000),
      retryMaxMs: numEnv(env.NAI_RETRY_MAX_MS, 30000),
    },

    // Express body 上限：/encode-vibe 的请求体里装的是【原图 base64】（不是编码结果），
    // 大图 base64 膨胀 4/3 后轻松破 10MB。这里刻意【不调大】——免费套餐机器，放开上限
    // 容易超流量/内存；客户端会先把超限的图压成 WebP，压不进就本地拦下不发请求。
    bodyLimit: env.BODY_LIMIT || '12mb',

    // 用量统计 / 管理端
    adminToken: env.ADMIN_TOKEN || '',     // 设了才开 /stats、/stats/reset（车主专用）
    opusFree: env.OPUS_FREE !== 'false',   // Anlas 估算是否按 Opus 免费档（默认 true）
    statsDbPath: env.STATS_DB_PATH || './data/stats.sqlite',
    statsRetentionDays: numEnv(env.STATS_RETENTION_DAYS, 90),
  };
}

function parseUserProfiles(raw, accessTokens) {
  const profiles = new Map();
  if (!raw) return profiles;
  let value;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new Error('USER_PROFILES_JSON 不是合法 JSON：' + e.message);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('USER_PROFILES_JSON 必须是以访问令牌为 key 的对象');
  }
  const names = new Set();
  for (const [token, profile] of Object.entries(value)) {
    if (!accessTokens.has(token)) throw new Error('USER_PROFILES_JSON 包含不在 ACCESS_TOKENS 中的令牌');
    const name = typeof profile?.name === 'string' ? profile.name.trim() : '';
    const timeZone = typeof profile?.timeZone === 'string' ? profile.timeZone.trim() : '';
    if (!name || !timeZone) throw new Error('USER_PROFILES_JSON 每项都需要 name 和 timeZone');
    if (names.has(name)) throw new Error(`USER_PROFILES_JSON 用户名重复：${name}`);
    try { new Intl.DateTimeFormat('en-US', { timeZone }).format(); }
    catch { throw new Error(`USER_PROFILES_JSON 时区无效：${timeZone}`); }
    names.add(name);
    profiles.set(token, { name, timeZone });
  }
  return profiles;
}

function numEnv(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
