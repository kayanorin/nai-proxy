// nai.js — 向 NovelAI 转发请求，带 429 退避重试 + 友好错误映射。
// 结果是 zip 二进制，按 Buffer 原样返回（绝不当文本解析）。

/**
 * 调用 NAI 生图接口，带重试。
 * @param {object} body  客户端拼好的 NAI 请求体（透传，服务端不重写 prompt/尺寸/vibe）
 * @param {object} opts
 * @param {string} opts.baseUrl   NAI 基址（默认真地址，测试指向 mock）
 * @param {string} opts.apiKey    NAI token（仅服务端持有）
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxRetries]
 * @param {number} [opts.retryBaseMs]
 * @param {number} [opts.retryMaxMs]
 * @returns {Promise<{buf: Buffer, contentType: string}>}
 */
export async function callNAIWithRetry(
  body,
  { baseUrl, apiKey, signal, maxRetries = 10, retryBaseMs = 3000, retryMaxMs = 30000 } = {}
) {
  const url = String(baseUrl).replace(/\/+$/, '') + '/ai/generate-image';
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
      const contentType = res.headers.get('content-type') || 'application/zip';
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
