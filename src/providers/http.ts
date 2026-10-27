// fetch 封装：超时、重试（429/5xx/网络错误）、错误信息里绝不带密钥。

export class ProviderError extends Error {
  status?: number;
  retryable: boolean;
  constructor(message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

export async function postJson(
  url: string,
  body: unknown,
  opts: { headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; retries?: number } = {},
): Promise<any> {
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? 180_000)];
    if (opts.signal) signals.push(opts.signal);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
      const raw = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new ProviderError(`HTTP ${res.status}: ${summarize(raw)}`, { status: res.status, retryable });
      }
      try {
        return JSON.parse(raw);
      } catch {
        throw new ProviderError(`响应不是 JSON: ${summarize(raw)}`);
      }
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw err;
      const retryable = err instanceof ProviderError ? err.retryable : true; // 网络错误/超时可重试
      if (!retryable || attempt === retries) break;
      await sleep(800 * 2 ** attempt, opts.signal);
    }
  }
  if (lastErr instanceof ProviderError) throw lastErr;
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new ProviderError(`请求失败: ${msg}`, { retryable: true });
}

function summarize(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  // 网关有时把请求头回显在错误里，统一抹掉疑似密钥
  return s.replace(/(sk|AIza|key)[-_A-Za-z0-9]{12,}/g, '[redacted]').slice(0, 400);
}

/** 去掉推理模型混在正文里的 <think> 块 */
export function stripThinking(text: string): string {
  return text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
}
