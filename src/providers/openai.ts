// OpenAI 兼容 Chat Completions：覆盖 OpenAI、DeepSeek、通义/百炼、Kimi、智谱、OpenRouter、
// 硅基流动、各类中转网关以及本地 Ollama / vLLM。

import type { ChatRequest, ChatResult, LLMClient, ProviderConfig } from '../types.ts';
import { postJson, ProviderError, stripThinking } from './http.ts';

export function createOpenAIClient(provider: ProviderConfig, apiKey: string | undefined): LLMClient {
  const base = (provider.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const official = /api\.openai\.com/.test(base);

  return {
    provider,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const started = Date.now();
      const body: Record<string, unknown> = { model: req.model, messages: req.messages };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      // 官方推理模型只认 max_completion_tokens，第三方网关普遍只认 max_tokens
      if (req.maxTokens) body[official ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens;
      if (req.effort) body.reasoning_effort = req.effort;

      const headers: Record<string, string> = { ...provider.headers };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;

      const data = await postJson(`${base}/chat/completions`, body, {
        headers,
        timeoutMs: provider.timeoutMs,
        signal: req.signal,
      });
      const choice = data?.choices?.[0];
      const content = choice?.message?.content;
      const text = Array.isArray(content)
        ? content.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
        : String(content ?? '');
      if (!text.trim()) throw new ProviderError(`模型返回空内容（finish_reason=${choice?.finish_reason ?? '?'}）`, { retryable: true });
      return {
        text: stripThinking(text),
        model: data.model ?? req.model,
        usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
        latencyMs: Date.now() - started,
        finishReason: choice?.finish_reason,
      };
    },
  };
}
