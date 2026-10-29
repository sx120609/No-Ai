// HTTP 服务：网页、公开 API（检测/改写/批量，支持 SSE 实时进度）、管理后台 API。

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { extname, join, normalize as normPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAdminToken, maskSettings, seedSettings, serverConfig, validateSettings, type ServerConfig } from './config.ts';
import { detect } from './detect/index.ts';
import { batchDiversity } from './pipeline/batch.ts';
import { runPipeline, type PipelineDeps } from './pipeline/index.ts';
import { MODES } from './pipeline/prompts.ts';
import { assertPublicBaseUrl, createClient, listUpstreamModels, PROVIDER_PRESETS, ProviderError } from './providers/index.ts';
import { hashKey, Store, type Settings } from './store.ts';
import * as cputime from './cputime.ts';
import type { LLMClient, Mode, ModelBinding, ProviderConfig, RewriteOptions, RewriteResult, Strength } from './types.ts';

const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Caller {
  admin: boolean;
  keyId: string | null;
  /** 用药大拾间账号登录的用户 */
  userId: string | null;
  dailyChars: number;
  ip: string;
}

const SESSION_COOKIE = 'noai_sid';
const SESSION_TTL = 30 * 86_400_000;

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export interface AppOptions {
  store: Store;
  config?: ServerConfig;
  /** 管理员令牌的 sha256 */
  adminTokenHash: string | null;
}

export function createApp({ store, config = serverConfig, adminTokenHash }: AppOptions): RequestListener {
  let settings: Settings = store.getSettings() ?? seedSettings();
  const cpu = config.cputime;
  const cpuOn = cputime.cputimeEnabled(cpu);
  // 接了药大拾间就默认走主站 AI 线路：补上供应商；原来只有离线演示时换成它
  if (cpuOn && !settings.providers.some((p) => p.type === 'cputime')) {
    settings = { ...settings, providers: [{ id: 'cputime', name: '药大拾间 AI', type: 'cputime' }, ...settings.providers] };
    if (settings.rewriters.every((b) => settings.providers.find((p) => p.id === b.provider)?.type === 'mock')) {
      settings.rewriters = [{ provider: 'cputime', model: 'assistant', label: '药大拾间 AI' }];
    }
  }
  store.saveSettings(settings);

  let clients = new Map<string, LLMClient>();
  const providerFor = (id: string) => {
    const p = settings.providers.find((x) => x.id === id && x.enabled !== false);
    if (!p) throw new HttpError(400, `供应商不存在或已停用：${id}`);
    return p;
  };
  const clientFor = (id: string) => {
    let c = clients.get(id);
    if (!c) {
      const p = providerFor(id);
      if (p.type === 'cputime') {
        if (!cpuOn) throw new HttpError(503, '药大拾间集成未配置');
        return cputime.createCputimeClient(p, cpu);
      }
      clients.set(id, (c = createClient(p)));
    }
    return c;
  };
  const cpuUserId = (userId: string | null) => (userId?.startsWith('cpu:') ? Number(userId.slice(4)) : null);

  /**
   * 拾间 AI 额度：一次任务第一次真正调用主站模型时才扣（原文不像 AI、没调模型就不扣），
   * 按篇幅每 3000 字 1 次，最多 8 次；任务里模型一次都没成功则退回。
   */
  function quotaTicket(c: Caller, chars: number) {
    const uid = cpuUserId(c.userId);
    const units = Math.min(8, Math.max(1, Math.ceil(chars / 3000)));
    let pending: Promise<void> | null = null;
    let reservations: unknown[] = [];
    return {
      ensure() {
        if (uid === null) return Promise.resolve();
        pending ??= cputime.consumeQuota(cpu, uid, units).then((r) => { reservations = r.reservations; }).catch((err) => {
          const status = (err as { status?: number }).status;
          throw new ProviderError(status === 403 ? '今天的拾间 AI 额度和点数都已用完，明天 00:00 恢复' : `扣除拾间 AI 额度失败：${(err as Error).message}`, { status, retryable: false });
        });
        return pending;
      },
      async refund() {
        if (uid !== null && reservations.length) await cputime.refundQuota(cpu, uid, reservations).catch(() => {});
        reservations = [];
      },
    };
  }

  // ---- 限流、并发 ----
  const hits = new Map<string, number[]>();
  const rateLimit = (id: string) => {
    const now = Date.now();
    const arr = (hits.get(id) ?? []).filter((t) => now - t < 60_000);
    if (arr.length >= config.ratePerMin) throw new HttpError(429, '请求太频繁，请稍后再试');
    arr.push(now);
    hits.set(id, arr);
  };
  let running = 0;
  const waiters: (() => void)[] = [];
  const acquire = async () => {
    if (running < config.maxConcurrent) {
      running++;
      return;
    }
    if (waiters.length >= config.maxQueue) throw new HttpError(503, '服务繁忙，请稍后再试');
    await new Promise<void>((r) => waiters.push(r));
    running++;
  };
  const release = () => {
    running--;
    waiters.shift()?.();
  };
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
    if (config.storeResultsHours) store.purgeResults(config.storeResultsHours * 3_600_000);
  }, 60_000).unref();

  const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  const oauthStates = new Map<string, { verifier: string; next: string; expires: number }>();
  const safeNext = (v: string | null) => (v && /^\/(?!\/)[\w\-./?=&%]*$/.test(v) ? v : '/');
  const loginFailed = (res: ServerResponse, msg: string) => {
    res.writeHead(303, { location: `/?login_error=${encodeURIComponent(msg)}`, 'cache-control': 'no-store' });
    res.end();
  };
  const sessionId = (req: IncomingMessage) => parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
  const sessionCookie = (value: string, maxAgeMs: number) =>
    `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${config.publicUrl.startsWith('https:') ? '; Secure' : ''}`;

  function caller(req: IncomingMessage): Caller {
    const ip = clientIp(req, config.trustProxy);
    const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '') || (req.headers['x-api-key'] as string | undefined) || '';
    if (auth && adminTokenHash && safeEq(hashKey(auth), adminTokenHash)) return { admin: true, keyId: null, userId: null, dailyChars: 0, ip };
    if (auth) {
      const k = store.findKey(auth);
      if (!k) throw new HttpError(401, '访问密钥无效');
      return { admin: false, keyId: k.id, userId: null, dailyChars: k.daily_chars, ip };
    }
    const sid = sessionId(req);
    if (sid) {
      // 用 cookie 登录的请求做同源校验，防跨站提交
      const origin = req.headers.origin;
      if (origin && config.publicUrl && origin !== new URL(config.publicUrl).origin) throw new HttpError(403, '来源不被允许');
      const u = store.sessionUser(sid);
      if (u) return { admin: u.role === 'admin', keyId: null, userId: u.id, dailyChars: u.daily_chars || config.userDailyChars, ip };
    }
    if (config.accessMode === 'open') return { admin: false, keyId: null, userId: null, dailyChars: config.openDailyChars, ip };
    throw new HttpError(401, config.accessMode === 'cpu' ? '请先用药大拾间账号登录' : '需要访问密钥');
  }

  function requireAdmin(req: IncomingMessage) {
    const c = caller(req);
    if (!c.admin) throw new HttpError(403, '需要管理员权限');
  }

  function checkQuota(c: Caller, chars: number) {
    if (chars > config.maxInputChars) throw new HttpError(413, `单次最多 ${config.maxInputChars} 字`);
    if (c.admin || !c.dailyChars) return;
    const used = c.userId ? store.usedTodayByUser(c.userId) : store.usedToday(c.keyId, c.keyId ? null : c.ip);
    if (used + chars > c.dailyChars) throw new HttpError(429, `今日额度已用完（${used}/${c.dailyChars} 字）`);
  }

  function meta() {
    return {
      accessMode: config.accessMode,
      allowByo: config.allowByo,
      maxInputChars: config.maxInputChars,
      modes: Object.entries(MODES).map(([id, m]) => ({ id, name: m.zh })),
      strengths: [
        { id: 'light', name: '小改', desc: '只改被标出的句子，其余一字不动，最快' },
        { id: 'medium', name: '中改', desc: '重排句子和节奏，段落结构不变' },
        { id: 'deep', name: '重写', desc: '只保留事实，从头重新组织表达' },
      ],
      rewriters: settings.rewriters.map(label),
      efforts: [
        { id: '', name: '默认' }, { id: 'low', name: '低' }, { id: 'medium', name: '中' }, { id: 'high', name: '高' }, { id: 'xhigh', name: '极高' },
      ],
      judge: !!settings.judge,
      auth: cpuOn ? { provider: 'cputime', name: '药大拾间', loginUrl: '/auth/login' } : null,
      defaults: settings.defaults,
    };
  }

  /** 解析用户提交的改写参数；BYO 供应商另外生成依赖 */
  function buildRequest(body: any, c?: Caller, ticket?: ReturnType<typeof quotaTicket>): { text: string; options: RewriteOptions; deps: PipelineDeps } {
    const text = String(body?.text ?? '').trim();
    if (!text) throw new HttpError(400, 'text 不能为空');
    const o = body.options ?? {};
    const pickStr = (v: unknown, allowed: string[], d: string) => (typeof v === 'string' && allowed.includes(v) ? v : d);
    const strArr = (v: unknown, max: number, maxLen: number) =>
      Array.isArray(v) ? v.map(String).map((s) => s.slice(0, maxLen)).filter((s) => s.trim()).slice(0, max) : undefined;

    const uid = cpuUserId(c?.userId ?? null);
    if (config.accessMode === 'cpu' && uid === null && !c?.admin && !c?.keyId) throw new HttpError(401, '请先用药大拾间账号登录');
    let deps: PipelineDeps = {
      client: (id) => {
        const p = providerFor(id);
        if (p.type === 'cputime' && !cpuOn) throw new HttpError(503, '药大拾间集成未配置');
        const inner = p.type === 'cputime' ? cputime.createCputimeClient(p, cpu, uid ?? undefined) : clientFor(id);
        if (p.type === 'mock') return inner;
        // 不管用哪个模型，药大拾间登录的用户都按拾间 AI 额度计次（一次任务扣一次）
        return { provider: p, chat: async (r) => { await ticket?.ensure(); return inner.chat(r); } };
      },
      rewriters: settings.rewriters,
      judge: settings.judge,
      concurrency: 3,
    };

    // 自带供应商：新格式 body.provider，或旧版 {apiKey, baseUrl, model}
    const byo = body.provider ?? (body.apiKey && body.model ? { type: 'openai', baseUrl: body.baseUrl, apiKey: body.apiKey, model: body.model } : null);
    if (byo) {
      if (!config.allowByo) throw new HttpError(403, '本服务未开放自带 API Key');
      const type = pickStr(byo.type, ['openai', 'anthropic', 'gemini'], 'openai') as ProviderConfig['type'];
      try {
        assertPublicBaseUrl(byo.baseUrl);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      if (!byo.apiKey || !byo.model) throw new HttpError(400, '自带供应商需要 apiKey 和 model');
      const client = createClient({ id: 'byo', type, baseUrl: byo.baseUrl, apiKey: String(byo.apiKey), timeoutMs: 300_000 });
      deps = { client: () => client, rewriters: [{ provider: 'byo', model: String(byo.model) }], judge: null, concurrency: 2 };
    }

    let rewriters: ModelBinding[] | undefined;
    if (!byo) {
      const wanted = typeof o.model === 'string' ? [o.model] : Array.isArray(o.models) ? o.models.map(String) : [];
      rewriters = wanted.length ? settings.rewriters.filter((b) => wanted.includes(label(b))) : settings.rewriters.slice(0, 1);
      if (!rewriters.length) throw new HttpError(400, '选择的模型不存在或已下线');
      const effort = typeof o.effort === 'string' && EFFORTS.includes(o.effort) ? o.effort : null;
      if (effort) rewriters = rewriters.map((b) => ({ ...b, effort }));
    }

    const d = settings.defaults;
    const options: RewriteOptions = {
      mode: pickStr(o.mode, Object.keys(MODES), d.mode) as Mode,
      strength: pickStr(o.strength, ['light', 'medium', 'deep'], d.strength) as Strength,
      lang: pickStr(o.lang, ['auto', 'zh', 'en'], 'auto') as RewriteOptions['lang'],
      protect: strArr(o.protect, 50, 100),
      styleSamples: strArr(o.styleSamples, 5, 3000),
      keepStructure: o.keepStructure === undefined ? undefined : !!o.keepStructure,
      instructions: typeof o.instructions === 'string' ? o.instructions.slice(0, 500) : undefined,
      candidates: Math.min(4, Math.max(1, Number(o.candidates) || (rewriters ?? deps.rewriters).length)),
      maxRepairRounds: Math.min(3, Math.max(0, o.maxRepairRounds === undefined ? d.maxRepairRounds : Number(o.maxRepairRounds))),
      semanticCheck: (o.semanticCheck ?? d.semanticCheck) && !!deps.judge,
      skipIfClean: o.skipIfClean === undefined ? true : !!o.skipIfClean,
      rewriters,
    };
    return { text, options, deps };
  }

  function record(c: Caller, kind: string, input: number, r: RewriteResult | null, err: unknown, started: number) {
    store.recordJob({
      id: r?.id ?? randomUUID(), key_id: c.keyId, user_id: c.userId, ip: c.ip, created_at: started, kind,
      status: err ? 'error' : 'done', input_chars: input, output_chars: r?.output.length ?? 0,
      before_score: r?.before.score ?? null, after_score: r?.after.score ?? null, passed: r ? Number(r.passed) : null,
      calls: r?.usage.calls ?? 0, input_tokens: r?.usage.inputTokens ?? 0, output_tokens: r?.usage.outputTokens ?? 0,
      elapsed_ms: Date.now() - started, error: err ? String((err as Error).message ?? err).slice(0, 500) : null,
      result_json: r && config.storeResultsHours ? JSON.stringify(r) : null,
    });
  }

  async function handleRewrite(req: IncomingMessage, res: ServerResponse, url: URL) {
    const c = caller(req);
    rateLimit(c.userId ?? c.keyId ?? c.ip);
    const body = await readJson(req);
    const ticket = quotaTicket(c, String(body?.text ?? '').length);
    const { text, options, deps } = buildRequest(body, c, ticket);
    checkQuota(c, text.length);
    const stream = url.searchParams.get('stream') === '1' || /text\/event-stream/.test(req.headers.accept ?? '');
    const ac = new AbortController();
    res.on('close', () => !res.writableFinished && ac.abort(new Error('客户端已断开')));

    await acquire();
    const started = Date.now();
    let result: RewriteResult | null = null;
    try {
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
        const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        try {
          result = await runPipeline(text, options, deps, (e) => send(e.type, e), ac.signal);
        } catch (err) {
          send('error', { type: 'error', message: (err as Error).message });
          throw err;
        } finally {
          clearInterval(ping);
          res.end();
        }
      } else {
        result = await runPipeline(text, options, deps, undefined, ac.signal);
        if (!result.candidates.some((x) => !x.error)) await ticket.refund();
        // text 字段兼容旧版 /api/rewrite 客户端
        sendJson(res, 200, { text: result.output, ...result });
      }
      if (!result.candidates.some((x) => !x.error)) await ticket.refund();
      record(c, 'rewrite', text.length, result, null, started);
    } catch (err) {
      await ticket.refund();
      record(c, 'rewrite', text.length, null, err, started);
      if (!stream) throw err;
    } finally {
      release();
    }
  }

  async function handleBatch(req: IncomingMessage, res: ServerResponse) {
    const c = caller(req);
    rateLimit(c.userId ?? c.keyId ?? c.ip);
    const body = await readJson(req);
    const items: string[] = Array.isArray(body?.items) ? body.items.map(String).filter((s: string) => s.trim()).slice(0, 30) : [];
    if (!items.length) throw new HttpError(400, 'items 不能为空（最多 30 篇）');
    const total = items.reduce((a, b) => a + b.length, 0);
    checkQuota(c, total);
    const parsed = items.map((t) => {
      const ticket = quotaTicket(c, t.length);
      return { ...buildRequest({ ...body, text: t }, c, ticket), ticket };
    });
    await acquire();
    const started = Date.now();
    try {
      const results: RewriteResult[] = [];
      for (const p of parsed) {
        try {
          const r = await runPipeline(p.text, p.options, p.deps);
          if (!r.candidates.some((x) => !x.error)) await p.ticket.refund();
          results.push(r);
        } catch (err) {
          await p.ticket.refund();
          throw err;
        }
      }
      const lang = results[0]!.lang;
      const diversity = batchDiversity(results.map((r) => r.output), lang);
      for (const r of results) record(c, 'batch', r.input.length, r, null, started);
      sendJson(res, 200, { results, diversity });
    } finally {
      release();
    }
  }

  async function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL) {
    requireAdmin(req);
    const path = url.pathname.replace(/^\/api\/admin/, '');
    if (path === '/settings' && req.method === 'GET') return sendJson(res, 200, { settings: maskSettings(settings), presets: PROVIDER_PRESETS });
    if (path === '/settings' && req.method === 'PUT') {
      try {
        settings = validateSettings(await readJson(req), settings);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      store.saveSettings(settings);
      clients = new Map();
      return sendJson(res, 200, { settings: maskSettings(settings) });
    }
    if (path === '/models' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        return sendJson(res, 200, { ok: true, models: await listUpstreamModels(providerFor(String(body.provider))) });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: (e as Error).message });
      }
    }
    if (path === '/test' && req.method === 'POST') {
      const body = await readJson(req);
      const started = Date.now();
      try {
        const r = await clientFor(String(body.provider)).chat({
          model: String(body.model),
          messages: [{ role: 'user', content: '用一句话回答：1+1 等于几？' }],
          maxTokens: 2000,
          signal: AbortSignal.timeout(60_000),
        });
        return sendJson(res, 200, { ok: true, reply: r.text.slice(0, 200), model: r.model, latencyMs: Date.now() - started });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: (e as Error).message, latencyMs: Date.now() - started });
      }
    }
    if (path === '/users' && req.method === 'GET') return sendJson(res, 200, { users: store.listUsers(), defaultDailyChars: config.userDailyChars });
    const userMatch = path.match(/^\/users\/([\w:.-]+)$/);
    if (userMatch && req.method === 'PATCH') {
      const body = await readJson(req);
      const ok = store.updateUser(userMatch[1]!, {
        disabled: body.disabled === undefined ? undefined : !!body.disabled,
        daily_chars: body.dailyChars === undefined ? undefined : Math.max(0, Number(body.dailyChars) || 0),
      });
      if (!ok) throw new HttpError(404, '不存在');
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/keys' && req.method === 'GET') return sendJson(res, 200, { keys: store.listKeys() });
    if (path === '/keys' && req.method === 'POST') {
      const body = await readJson(req);
      const name = String(body.name ?? '').trim().slice(0, 40) || '未命名';
      const { row, key } = store.createKey(name, Math.max(0, Number(body.dailyChars) || 0));
      return sendJson(res, 200, { key, row });
    }
    const keyMatch = path.match(/^\/keys\/([0-9a-f]+)$/);
    if (keyMatch && req.method === 'PATCH') {
      const body = await readJson(req);
      if (!store.updateKey(keyMatch[1]!, { disabled: body.disabled, daily_chars: body.dailyChars, name: body.name })) throw new HttpError(404, '不存在');
      return sendJson(res, 200, { ok: true });
    }
    if (keyMatch && req.method === 'DELETE') {
      if (!store.deleteKey(keyMatch[1]!)) throw new HttpError(404, '不存在');
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/usage' && req.method === 'GET') {
      return sendJson(res, 200, { days: store.usageByDay(Number(url.searchParams.get('days')) || 14), running, queued: waiters.length });
    }
    if (path === '/jobs' && req.method === 'GET') return sendJson(res, 200, { jobs: store.listJobs(Math.min(200, Number(url.searchParams.get('limit')) || 50)) });
    const jobMatch = path.match(/^\/jobs\/([\w-]+)$/);
    if (jobMatch && req.method === 'GET') {
      const j = store.getJob(jobMatch[1]!);
      if (!j) throw new HttpError(404, '不存在');
      return sendJson(res, 200, { job: { ...j, result: j.result_json ? JSON.parse(j.result_json) : null, result_json: undefined } });
    }
    throw new HttpError(404, 'Not found');
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
    const rel = pathname === '/' ? 'index.html' : pathname === '/admin' ? 'admin.html' : pathname.slice(1);
    const file = normPath(join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(404, 'Not found');
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    // 每次都向服务器确认（ETag 命中时 304），发布新版本后立即生效
    const etag = `"${createHash('sha1').update(data).digest('base64url').slice(0, 16)}"`;
    if (req.headers['if-none-match'] === etag) return void res.writeHead(304, { etag }).end();
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', etag });
    res.end(data);
  }

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin) && url.pathname.startsWith('/api/')) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'content-type, authorization, x-api-key');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    try {
      if (req.method === 'OPTIONS') return void res.writeHead(204).end();
      if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, running, queued: waiters.length });
      if (url.pathname === '/api/meta') return sendJson(res, 200, meta());
      if (url.pathname === '/api/me') {
        const sid = sessionId(req);
        const u = sid ? store.sessionUser(sid) : null;
        const uid = cpuUserId(u?.id ?? null);
        const quota = uid !== null && cpuOn ? await cputime.quotaStatus(cpu, uid).catch(() => null) : null;
        return sendJson(res, 200, { user: u ? { id: u.id, name: u.name, avatar: u.avatar, admin: u.role === 'admin' } : null, quota });
      }
      if (url.pathname === '/auth/login' && req.method === 'GET') {
        if (!cpuOn) throw new HttpError(404, '没有配置药大拾间登录');
        const next = safeNext(url.searchParams.get('next'));
        const { state, verifier, url: target } = cputime.loginRequest(cpu);
        for (const [k, v] of oauthStates) if (v.expires < Date.now()) oauthStates.delete(k);
        if (oauthStates.size > 5000) throw new HttpError(503, '登录请求过多，请稍后再试');
        oauthStates.set(state, { verifier, next, expires: Date.now() + 10 * 60_000 });
        res.writeHead(303, { location: target, 'cache-control': 'no-store' });
        return void res.end();
      }
      if (url.pathname === '/api/auth/cputime/callback' && req.method === 'GET') {
        const key = url.searchParams.get('state') || '';
        const st = oauthStates.get(key);
        oauthStates.delete(key);
        const code = url.searchParams.get('code') || '';
        if (!st || st.expires < Date.now() || !code) return loginFailed(res, '登录已过期，请重新登录');
        try {
          const who = await cputime.loginUser(cpu, code, st.verifier);
          const admin = await cputime.isGlobalAdmin(cpu, who.id).catch(() => false);
          const user = store.upsertUser({ id: `cpu:${who.id}`, name: who.nickname, avatar: who.avatar, role: admin ? 'admin' : 'user' });
          if (user.disabled) return loginFailed(res, '这个账号在去AI味已被停用');
          // 管理员会话短一些，主站权限变化能更快生效
          const ttl = admin ? 8 * 3_600_000 : SESSION_TTL;
          res.writeHead(303, { location: st.next, 'set-cookie': sessionCookie(store.createSession(user.id, ttl), ttl), 'cache-control': 'no-store' });
          return void res.end();
        } catch (err) {
          console.error('[cputime login]', (err as Error).message);
          return loginFailed(res, '药大拾间登录失败，请稍后重试');
        }
      }
      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        const sid = sessionId(req);
        if (sid) store.deleteSession(sid);
        res.setHeader('set-cookie', sessionCookie('', 0));
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === '/api/detect' && req.method === 'POST') {
        // 检测不调用模型，未登录也能用，按 IP 限流
        let id = `d:${clientIp(req, config.trustProxy)}`;
        try {
          const c = caller(req);
          id = `d:${c.userId ?? c.keyId ?? c.ip}`;
        } catch { /* 匿名 */ }
        rateLimit(id);
        const body = await readJson(req);
        const text = String(body?.text ?? '');
        if (!text.trim()) throw new HttpError(400, 'text 不能为空');
        if (text.length > config.maxInputChars * 2) throw new HttpError(413, '文本过长');
        return sendJson(res, 200, detect(text, body.lang));
      }
      if (url.pathname === '/api/rewrite' && req.method === 'POST') return await handleRewrite(req, res, url);
      if (url.pathname === '/api/batch' && req.method === 'POST') return await handleBatch(req, res);
      if (url.pathname.startsWith('/api/admin/')) return await handleAdmin(req, res, url);
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
      if (req.method === 'GET') return await serveStatic(req, res, url.pathname);
      throw new HttpError(405, 'Method not allowed');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? `服务内部错误：${(err as Error).message}` : (err as Error).message });
      else res.end();
    }
  };
}

const label = (b: ModelBinding) => b.label || `${b.provider}/${b.model}`;
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    // X-Real-IP 由反代直接设置；X-Forwarded-For 的第一段客户端可以伪造，只取最后一段（反代追加的）
    const real = (req.headers['x-real-ip'] as string | undefined)?.trim();
    if (real) return real;
    const xff = (req.headers['x-forwarded-for'] as string | undefined)?.split(',').at(-1)?.trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, '请求体过大');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, ''));
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

// 直接运行时启动服务
if (process.argv[1] && fileURLToPath(import.meta.url) === normPath(process.argv[1])) {
  const store = new Store(join(serverConfig.dataDir, 'no-ai.db'));
  const { hash, token } = ensureAdminToken(store);
  const server = createServer(createApp({ store, adminTokenHash: hash }));
  server.requestTimeout = 0; // 长文本改写可能超过默认超时
  server.listen(serverConfig.port, serverConfig.host, () => {
    console.log(`No-AI 去AI味服务已启动：http://${serverConfig.host}:${serverConfig.port}`);
    console.log(`访问模式：${serverConfig.accessMode === 'open' ? '公开（按 IP 限额）' : '需要访问密钥'}　管理后台：/admin`);
    if (token) console.log(`首次启动已生成管理员令牌（只显示这一次，也可用 ADMIN_TOKEN 环境变量指定）：\n  ${token}`);
  });
}
