// Gemini 原生 generateContent。走 OpenAI 兼容网关的 Gemini 请用 openai 类型。

import type { ChatRequest, ChatResult, LLMClient, ProviderConfig } from '../types.ts';
import { postJson, ProviderError } from './http.ts';

export function createGeminiClient(provider: ProviderConfig, apiKey: string | undefined): LLMClient {
  const base = (provider.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');

  return {
    provider,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const started = Date.now();
      const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const contents = req.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

      const generationConfig: Record<string, unknown> = {};
      if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
      if (req.maxTokens) generationConfig.maxOutputTokens = req.maxTokens;
      if (req.effort) generationConfig.thinkingConfig = { thinkingLevel: req.effort };

      const body: Record<string, unknown> = { contents, generationConfig };
      if (system) body.systemInstruction = { parts: [{ text: system }] };

      const headers: Record<string, string> = { ...provider.headers };
      if (apiKey) headers['x-goog-api-key'] = apiKey;

      const data = await postJson(`${base}/v1beta/models/${encodeURIComponent(req.model)}:generateContent`, body, {
        headers,
        timeoutMs: provider.timeoutMs,
        signal: req.signal,
      });
      const cand = data?.candidates?.[0];
      const text = (cand?.content?.parts ?? [])
        .filter((p: any) => !p.thought)
        .map((p: any) => p.text ?? '')
        .join('');
      if (!text.trim()) {
        const reason = cand?.finishReason ?? data?.promptFeedback?.blockReason ?? '?';
        throw new ProviderError(`Gemini 返回空内容（${reason}）`, { retryable: reason !== 'SAFETY' });
      }
      return {
        text: text.trim(),
        model: req.model,
        usage: {
          inputTokens: data.usageMetadata?.promptTokenCount,
          outputTokens: data.usageMetadata?.candidatesTokenCount,
        },
        latencyMs: Date.now() - started,
        finishReason: cand?.finishReason,
      };
    },
  };
}
