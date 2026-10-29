// 药大拾间（cputime.cn）集成：OAuth 登录、管理员核验、AI 线路与拾间 AI 额度。
// 登录流程照搬拾间支付：授权码 + PKCE，拿到身份后立即吊销主站 token，本地只留自己的会话。

import { createHash, randomBytes } from 'node:crypto';
import type { ChatRequest, ChatResult, LLMClient, ProviderConfig } from './types.ts';
import { ProviderError } from './providers/http.ts';

export interface CputimeConfig {
  origin: string;
  clientId: string;
  secret: string;
  /** No-AI 对外地址，用于拼回调 */
  publicUrl: string;
}

export const cputimeEnabled = (c: CputimeConfig) => c.secret.length >= 32 && /^https?:\/\//.test(c.publicUrl);
const callback = (c: CputimeConfig) => `${c.publicUrl.replace(/\/+$/, '')}/api/auth/cputime/callback`;

type Fetcher = typeof fetch;

async function json(fetcher: Fetcher, url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<any> {
  const res = await fetcher(url, { redirect: 'error', signal: init.signal ?? AbortSignal.timeout(timeoutMs), ...init });
  const body = await res.text();
  let data: any = null;
  try { data = JSON.parse(body.replace(/^﻿/, '')); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = data?.message || data?.error || `药大拾间返回 ${res.status}`;
    throw Object.assign(new Error(String(msg).slice(0, 200)), { status: res.status });
  }
  if (!data) throw Object.assign(new Error('药大拾间返回格式异常'), { status: 502 });
  return data;
}

export function loginRequest(c: CputimeConfig) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code', client_id: c.clientId, redirect_uri: callback(c), scope: 'openid profile', state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  return { state, verifier, url: `${c.origin}/api/oauth/authorize?${query}` };
}

export async function loginUser(c: CputimeConfig, code: string, verifier: string, fetcher: Fetcher = fetch) {
  const client = { client_id: c.clientId, client_secret: c.secret };
  const post = (path: string, body: unknown) => json(fetcher, c.origin + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const token = await post('/api/oauth/token', { ...client, grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: callback(c) });
  if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('登录失败');
  try {
    const info = await json(fetcher, `${c.origin}/api/oauth/userinfo`, { headers: { authorization: `Bearer ${token.access_token}` } });
    const id = Number(info.data?.sub);
    if (info.code !== 0 || !Number.isSafeInteger(id) || id <= 0) throw new Error('登录失败');
    return {
      id,
      nickname: String(info.data.user?.nickname || `用户 ${id}`).slice(0, 60),
      avatar: typeof info.data.user?.avatar === 'string' ? info.data.user.avatar.slice(0, 500) : null,
    };
  } finally {
    await post('/api/oauth/revoke', { ...client, token: token.access_token }).catch(() => {});
  }
}

const headers = (c: CputimeConfig) => ({ 'x-noai-integration-secret': c.secret, 'content-type': 'application/json' });

export async function isGlobalAdmin(c: CputimeConfig, userId: number, fetcher: Fetcher = fetch): Promise<boolean> {
  const r = await json(fetcher, `${c.origin}/api/integrations/no-ai/users/${userId}/access`, { headers: headers(c) });
  if (r.code !== 0 || r.data?.userId !== userId || typeof r.data.globalAdmin !== 'boolean') throw new Error('权限响应无效');
  return r.data.globalAdmin === true;
}

export interface QuotaStatus {
  dailyQuota: number;
  used: number;
  remaining: number;
  points: number;
  totalRemaining: number;
  levelName: string;
  nextResetAt: string;
}

export async function quotaStatus(c: CputimeConfig, userId: number, fetcher: Fetcher = fetch): Promise<QuotaStatus> {
  return (await json(fetcher, `${c.origin}/api/integrations/no-ai/users/${userId}/quota`, { headers: headers(c) })).data;
}

export async function consumeQuota(c: CputimeConfig, userId: number, units: number, fetcher: Fetcher = fetch) {
  const r = await json(fetcher, `${c.origin}/api/integrations/no-ai/quota/consume`, {
    method: 'POST', headers: headers(c), body: JSON.stringify({ userId, units }),
  });
  return r.data as { reservations: unknown[]; quota: QuotaStatus };
}

export async function refundQuota(c: CputimeConfig, userId: number, reservations: unknown[], fetcher: Fetcher = fetch) {
  if (!reservations.length) return;
  await json(fetcher, `${c.origin}/api/integrations/no-ai/quota/refund`, {
    method: 'POST', headers: headers(c), body: JSON.stringify({ userId, reservations }),
  });
}

/** 走药大拾间 AI 线路的模型客户端；模型由主站后台的「拾间 AI 对话」线路决定 */
export function createCputimeClient(provider: ProviderConfig, c: CputimeConfig, userId?: number, fetcher: Fetcher = fetch): LLMClient {
  return {
    provider,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const started = Date.now();
      const signals = [AbortSignal.timeout(provider.timeoutMs ?? 600_000)];
      if (req.signal) signals.push(req.signal);
      // 主站接口只接受 system / user / assistant 三种角色，消息数有上限
      const messages = req.messages.slice(-12).map((m) => ({ role: m.role, content: m.content.slice(0, 60_000) }));
      let r: any;
      try {
        r = await json(fetcher, `${c.origin}/api/integrations/no-ai/chat`, {
          method: 'POST', headers: headers(c), signal: AbortSignal.any(signals),
          body: JSON.stringify({ messages, maxTokens: Math.min(16_000, req.maxTokens ?? 8000), ...(userId ? { userId } : {}) }),
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        throw new ProviderError(`药大拾间 AI：${(err as Error).message}`, { status, retryable: !status || status >= 500 });
      }
      const text = unwrapJsonOnly(String(r.data?.content ?? ''));
      // 很快返回空内容基本是被模型的安全策略拦下了，重试也一样，不要浪费调用
      if (!text.trim()) {
        throw new ProviderError('药大拾间 AI 没有返回内容，可能被模型安全策略拦下（例如文中含服务器命令或脚本），换个说法再试', { retryable: false });
      }
      return { text, model: String(r.data?.model || 'cputime'), latencyMs: Date.now() - started };
    },
  };
}

/**
 * 主站线路固定要求模型“只输出 JSON”，改写稿会被包成 {"rewritten": "…"}。
 * 只有一个字符串字段的 JSON 取出它（换行随 JSON 解析还原）；其他 JSON（如精修的 edits、审校结论）原样返回。
 */
export function unwrapJsonOnly(raw: string): string {
  const s = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (s.startsWith('{') && s.endsWith('}')) {
    try {
      const obj = JSON.parse(s);
      const entries = obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.entries(obj) : [];
      if (entries.length === 1 && typeof entries[0]![1] === 'string') return entries[0]![1] as string;
    } catch { /* 不是合法 JSON，按普通文本处理 */ }
  }
  // 没有真换行却有字面的 \n：还原
  if (!raw.includes('\n') && /\\[nr]/.test(raw)) return raw.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\\t/g, '\t');
  return raw;
}
