// 服务配置（环境变量）与后台设置的初始化、校验、脱敏。

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { resolveApiKey } from './providers/index.ts';
import { hashKey, type Settings, type Store } from './store.ts';
import type { ModelBinding, ProviderConfig } from './types.ts';

const env = process.env;
const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export const serverConfig = {
  port: int(env.PORT, 3001),
  host: env.HOST || '127.0.0.1',
  dataDir: env.DATA_DIR || join(process.cwd(), 'data'),
  /** open：任何人可用（按 IP 限额）；key：需要访问密钥；cpu：用药大拾间账号登录（访问密钥仍可用于 API） */
  accessMode: (env.ACCESS_MODE === 'open' || env.ACCESS_MODE === 'cpu' ? env.ACCESS_MODE : 'key') as 'open' | 'key' | 'cpu',
  /** 对外地址，用于登录回跳与同源校验，如 https://noai.cputime.cn */
  publicUrl: env.PUBLIC_URL || '',
  /** 登录用户在 No-AI 侧的每日字数上限，0 不限（用药大拾间 AI 时以拾间 AI 额度为准） */
  userDailyChars: int(env.USER_DAILY_CHARS, 0),
  /** 药大拾间集成：登录、AI 线路、拾间 AI 额度。CPUTIME_SECRET 与主站 NOAI_INTEGRATION_SECRET 相同 */
  cputime: {
    origin: (env.CPUTIME_ORIGIN || 'https://cputime.cn').replace(/\/+$/, ''),
    clientId: env.CPUTIME_CLIENT_ID || 'no-ai',
    secret: (env.CPUTIME_SECRET || '').trim(),
    publicUrl: env.PUBLIC_URL || '',
  },
  /** 允许请求自带供应商（BYO key），兼容旧版 /api/rewrite {text, apiKey, baseUrl, model} */
  allowByo: env.ALLOW_BYO === '1',
  maxInputChars: int(env.MAX_INPUT_CHARS, 20_000),
  ratePerMin: int(env.RATE_PER_MIN, 20),
  openDailyChars: int(env.OPEN_DAILY_CHARS, 20_000),
  maxConcurrent: int(env.MAX_CONCURRENT, 4),
  maxQueue: int(env.MAX_QUEUE, 20),
  storeResultsHours: int(env.STORE_RESULTS_HOURS, 0),
  corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: env.TRUST_PROXY === '1',
};

export type ServerConfig = typeof serverConfig;

/** 管理员令牌：优先用环境变量；否则首次启动生成并打印一次，库里只存哈希 */
export function ensureAdminToken(store: Store): { hash: string; token: string | null } {
  if (env.ADMIN_TOKEN) return { hash: hashKey(env.ADMIN_TOKEN), token: null };
  const row = store.db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_token_hash') as { value: string } | undefined;
  if (row) return { hash: row.value, token: null };
  const token = `adm_${randomBytes(18).toString('base64url')}`;
  store.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('admin_token_hash', hashKey(token));
  return { hash: hashKey(token), token };
}

/** 首次启动：根据环境变量里已有的密钥自动生成供应商，没有就只放离线演示 */
export function seedSettings(): Settings {
  const providers: ProviderConfig[] = [];
  const rewriters: ModelBinding[] = [];
  if (env.DE_AI_REWRITE_API_KEY && env.DE_AI_REWRITE_BASE_URL) {
    providers.push({ id: 'gateway', name: '中转网关', type: 'openai', baseUrl: env.DE_AI_REWRITE_BASE_URL, apiKeyEnv: 'DE_AI_REWRITE_API_KEY' });
    if (env.DE_AI_REWRITE_MODEL) rewriters.push({ provider: 'gateway', model: env.DE_AI_REWRITE_MODEL });
  }
  if (env.ANTHROPIC_API_KEY) {
    providers.push({ id: 'anthropic', name: 'Anthropic', type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', serverFallback: true });
    rewriters.push({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium' });
  }
  if (env.OPENAI_API_KEY) providers.push({ id: 'openai', name: 'OpenAI', type: 'openai', apiKeyEnv: 'OPENAI_API_KEY' });
  if (env.GEMINI_API_KEY) providers.push({ id: 'gemini', name: 'Gemini', type: 'gemini', apiKeyEnv: 'GEMINI_API_KEY' });
  if (env.DEEPSEEK_API_KEY) {
    providers.push({ id: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' });
    rewriters.push({ provider: 'deepseek', model: 'deepseek-chat' });
  }
  if (env.DASHSCOPE_API_KEY) {
    providers.push({ id: 'qwen', name: '通义千问', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY' });
  }
  providers.push({ id: 'demo', name: '离线演示（规则改写）', type: 'mock' });
  if (!rewriters.length) rewriters.push({ provider: 'demo', model: 'rules' });
  return {
    providers,
    rewriters: rewriters.slice(0, 1),
    judge: null,
    defaults: { mode: 'general', strength: 'medium', semanticCheck: false, maxRepairRounds: 2 },
  };
}

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const TYPES = new Set(['openai', 'anthropic', 'gemini', 'mock', 'cputime']);

/** 校验管理员提交的设置；未提交新密钥时保留旧密钥 */
export function validateSettings(input: unknown, current: Settings): Settings {
  const s = input as Partial<Settings>;
  if (!s || !Array.isArray(s.providers)) throw new Error('providers 必须是数组');
  const seen = new Set<string>();
  const providers: ProviderConfig[] = s.providers.map((p) => {
    if (!p || !ID.test(p.id)) throw new Error(`供应商 id 不合法：${p?.id}（小写字母数字、-、_）`);
    if (seen.has(p.id)) throw new Error(`供应商 id 重复：${p.id}`);
    seen.add(p.id);
    if (!TYPES.has(p.type)) throw new Error(`未知类型：${p.type}`);
    if (p.baseUrl) new URL(p.baseUrl);
    // 只允许引用 *_KEY 形式的环境变量，避免把 ADMIN_TOKEN 之类的变量发给外部地址
    if (p.apiKeyEnv && !/^[A-Z][A-Z0-9_]*_KEY$/.test(p.apiKeyEnv.trim())) throw new Error(`环境变量名必须形如 XXX_API_KEY：${p.apiKeyEnv}`);
    const old = current.providers.find((o) => o.id === p.id);
    const apiKey = p.apiKey === undefined || p.apiKey === MASK ? old?.apiKey : p.apiKey || undefined;
    return {
      id: p.id,
      name: p.name?.slice(0, 40),
      type: p.type,
      baseUrl: p.baseUrl?.trim() || undefined,
      apiKey,
      apiKeyEnv: p.apiKeyEnv?.trim() || undefined,
      headers: p.headers && typeof p.headers === 'object' ? p.headers : undefined,
      timeoutMs: p.timeoutMs ? Math.min(900_000, Math.max(5_000, Number(p.timeoutMs))) : undefined,
      serverFallback: p.serverFallback,
      models: Array.isArray(p.models) ? p.models.map(String).slice(0, 30) : undefined,
      enabled: p.enabled !== false,
    };
  });
  const binding = (b: ModelBinding, where: string): ModelBinding => {
    if (!b || !seen.has(b.provider)) throw new Error(`${where} 引用了不存在的供应商：${b?.provider}`);
    if (!b.model?.trim()) throw new Error(`${where} 缺少模型名`);
    return {
      provider: b.provider,
      model: b.model.trim(),
      label: b.label?.slice(0, 40) || undefined,
      public: b.public === true ? true : undefined,
      temperature: b.temperature === undefined || b.temperature === null || (b.temperature as unknown) === '' ? undefined : Number(b.temperature),
      maxTokens: b.maxTokens ? Number(b.maxTokens) : undefined,
      effort: b.effort || undefined,
    };
  };
  const rewriters = (s.rewriters ?? []).map((b, i) => binding(b, `改写模型 #${i + 1}`));
  if (!rewriters.length) throw new Error('至少配置一个改写模型');
  return {
    providers,
    rewriters: rewriters.slice(0, 40),
    judge: s.judge ? binding(s.judge, '审校模型') : null,
    defaults: { ...current.defaults, ...(s.defaults ?? {}) },
  };
}

export const MASK = '••••••••';

/** 返回给后台页面的设置：密钥只显示是否已配置 */
export function maskSettings(s: Settings) {
  return {
    ...s,
    providers: s.providers.map((p) => ({
      ...p,
      apiKey: p.apiKey ? MASK : '',
      keyStatus: p.type === 'mock' || p.type === 'cputime' ? 'none-needed' : resolveApiKey(p) ? (p.apiKeyEnv && process.env[p.apiKeyEnv] ? `env:${p.apiKeyEnv}` : 'stored') : 'missing',
    })),
  };
}
