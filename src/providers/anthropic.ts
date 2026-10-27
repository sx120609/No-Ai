// Anthropic Messages API（官方 SDK）。也可指向兼容 Anthropic 协议的中转 baseUrl。

import Anthropic from '@anthropic-ai/sdk';
import type { ChatRequest, ChatResult, LLMClient, ProviderConfig } from '../types.ts';
import { ProviderError } from './http.ts';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function createAnthropicClient(provider: ProviderConfig, apiKey: string | undefined): LLMClient {
  const official = !provider.baseUrl || /api\.anthropic\.com/.test(provider.baseUrl);
  const client = new Anthropic({
    apiKey: apiKey ?? null,
    baseURL: provider.baseUrl || undefined,
    timeout: provider.timeoutMs ?? 300_000,
    maxRetries: 2,
    defaultHeaders: provider.headers,
  });
  // 服务端拒答兜底只在官方 API 上可用
  const useFallback = official && provider.serverFallback !== false;

  return {
    provider,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const started = Date.now();
      const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const messages = req.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
      // 注意：当前 Messages API 对所有模型都拒绝 temperature/top_p，这里不发送
      const params = {
        model: req.model,
        max_tokens: req.maxTokens ?? 16000,
        messages,
        ...(system ? { system } : {}),
        ...(req.effort && EFFORTS.has(req.effort) ? { output_config: { effort: req.effort as Effort } } : {}),
      };

      try {
        const res = useFallback
          ? await client.beta.messages.create(
              { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as any },
              { signal: req.signal },
            )
          : await client.messages.create(params, { signal: req.signal });

        if (res.stop_reason === 'refusal') {
          const cat = (res as any).stop_details?.category ?? 'unknown';
          throw new ProviderError(`模型拒答（${cat}）`, { retryable: false });
        }
        const text = (res.content as any[])
          .filter((b) => b.type === 'text')
          .map((b) => b.text as string)
          .join('');
        if (!text.trim()) throw new ProviderError(`模型返回空内容（stop_reason=${res.stop_reason}）`, { retryable: true });
        return {
          text: text.trim(),
          model: res.model,
          usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
          latencyMs: Date.now() - started,
          finishReason: res.stop_reason ?? undefined,
        };
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        if (err instanceof Anthropic.RateLimitError) throw new ProviderError('限流（429）', { status: 429, retryable: true });
        if (err instanceof Anthropic.AuthenticationError) throw new ProviderError('密钥无效（401）', { status: 401 });
        if (err instanceof Anthropic.BadRequestError) throw new ProviderError(`请求参数错误：${err.message}`, { status: 400 });
        if (err instanceof Anthropic.APIError) {
          const status = typeof err.status === 'number' ? err.status : undefined;
          throw new ProviderError(`Anthropic ${status ?? ''}: ${err.message}`, { status, retryable: !status || status >= 500 });
        }
        throw err;
      }
    },
  };
}
