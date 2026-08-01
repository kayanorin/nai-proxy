// nai.js — 向 NovelAI 转发请求，带 429 退避重试 + 友好错误映射。
// 结果是二进制（生图 zip / vibe 编码原始字节），按 Buffer 原样返回（绝不当文本解析）。

/**
 * 调用 NAI 接口，带重试。
 * @param {object} body  客户端拼好的 NAI 请求体（透传，服务端不重写 prompt/尺寸/vibe）
 * @param {object} opts
 * @param {string} opts.baseUrl   NAI 基址（默认真地址，测试指向 mock）
 * @param {string} opts.apiKey    NAI token（仅服务端持有）
 * @param {string} [opts.path]    接口路径（默认生图；vibe 编码传 /ai/encode-vibe）
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxRetries]
 * @param {number} [opts.retryBaseMs]
 * @param {number} [opts.retryMaxMs]
 * @returns {Promise<{buf: Buffer, contentType: string}>}
 */
export async function callNAIWithRetry(
  body,
  {
    baseUrl,
    apiKey,
    path = '/ai/generate-image',
    signal,
    maxRetries = 10,
    retryBaseMs = 3000,
    retryMaxMs = 30000,
  } = {}
) {
  const url = String(baseUrl).replace(/\/+$/, '') + path;
  // 生图回 zip，encode-vibe 回一段裸字节；缺 content-type 时按接口兜底
  const defaultContentType =
    path === '/ai/generate-image' ? 'application/zip' : 'application/octet-stream';
  let attempt = 0;

  while (true) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/zip, application/x-zip-compressed, */*',
          // 伪装成 NAI 官网发出的请求：降低被判定为「外部非法调用」的概率（共享账号防封）。
          // 浏览器禁止脚本设置 Origin/Referer，但 Node(undici) 不拦，会原样发出。
          Origin: 'https://novelai.net',
          Referer: 'https://novelai.net/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (isAbort(e)) throw mkErr('已取消', 'ABORTED');
      // 网络层错误：按可重试处理几次
      attempt++;
      if (attempt > maxRetries) throw mkErr('连接 NAI 失败：' + (e?.message || e), 'NETWORK');
      await sleep(backoff(attempt, retryBaseMs, retryMaxMs), signal);
      continue;
    }

    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') || defaultContentType;
      return { buf, contentType };
    }

    if (res.status === 429) {
      attempt++;
      if (attempt > maxRetries) {
        throw mkErr(`NAI 持续限流（429），已重试 ${maxRetries} 次`, 'RATE_LIMITED');
      }
      const ra = retryAfterMs(res);
      await sleep(ra != null ? ra : backoff(attempt, retryBaseMs, retryMaxMs), signal);
      continue;
    }

    // 401 / 402 给车主看得懂的提示
    if (res.status === 401) {
      throw mkErr('NAI 鉴权失败（401）：车主请更新 NAI_KEY', 'KEY_INVALID');
    }
    if (res.status === 402) {
      throw mkErr('NAI 余额不足（402）：Anlas 不足', 'INSUFFICIENT_FUNDS');
    }

    const text = await safeText(res);
    throw mkErr(`NAI 返回 ${res.status}${text ? '：' + text.slice(0, 300) : ''}`, 'NAI_' + res.status);
  }
}

/**
 * 查当前 Anlas 余额（GET /user/subscription，注意主机是 api.novelai.net 不是 image.）。
 * 用于「任务前后取差值＝真实消耗」这条统计口径。
 * 任何失败都返回 null 而不抛：余额查不到只是统计回落到估算，绝不能影响出图。
 * @returns {Promise<number|null>}
 */
export async function fetchAnlasBalance({ baseUrl, apiKey, timeoutMs = 10000 } = {}) {
  if (!baseUrl || !apiKey) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(String(baseUrl).replace(/\/+$/, '') + '/user/subscription', {
      headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const j = await res.json();
    const left = j?.trainingStepsLeft;
    const fixed = Number(left?.fixedTrainingStepsLeft);
    const purchased = Number(left?.purchasedTrainingSteps);
    if (!Number.isFinite(fixed) && !Number.isFinite(purchased)) {
      // 响应结构与预期不符：打出来供车主核对，本次按查不到处理
      console.log(JSON.stringify({ evt: 'balance_shape_unexpected', body: j }));
      return null;
    }
    return (Number.isFinite(fixed) ? fixed : 0) + (Number.isFinite(purchased) ? purchased : 0);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function backoff(attempt, base, max) {
  const exp = Math.min(base * Math.pow(2, attempt - 1), max);
  // ±10% 抖动，避免多次重试同步
  const jitter = (Math.random() * 0.2 - 0.1) * exp;
  return Math.max(0, Math.round(exp + jitter));
}

function retryAfterMs(res) {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.min(s * 1000, 60000);
  return null;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(mkErr('已取消', 'ABORTED'));
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(mkErr('已取消', 'ABORTED'));
        },
        { once: true }
      );
    }
  });
}

function isAbort(e) {
  return e?.name === 'AbortError' || e?.code === 'ABORTED';
}

function mkErr(msg, code) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
