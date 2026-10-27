// 离线 mock：无需任何密钥即可跑通整条流水线（演示/测试用）。
// 改写任务：取 <source_text> 中的原文，做规则清理；裁判任务：返回通过的 JSON。

import type { ChatRequest, ChatResult, LLMClient, ProviderConfig } from '../types.ts';
import { ruleCleanup } from '../pipeline/cleanup.ts';

export function createMockClient(provider: ProviderConfig): LLMClient {
  return {
    provider,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const started = Date.now();
      const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
      let text: string;
      if (/"aiLikeness"/.test(system)) {
        text = JSON.stringify({ score: 92, issues: [], aiLikeness: 30 });
      } else if (/"edits"/.test(system)) {
        const src = user.match(/<source_text>\n?([\s\S]*?)\n?<\/source_text>/)?.[1] ?? '';
        const edits = ruleCleanup(src).applied
          .filter((a) => a.from && src.split(a.from).length === 2)
          .map((a) => ({ find: a.from, replace: a.to, rule: a.id }));
        text = JSON.stringify({ edits });
      } else {
        const src = user.match(/<source_text>\n?([\s\S]*?)\n?<\/source_text>/)?.[1] ?? user;
        text = ruleCleanup(src, { aggressive: true }).text;
      }
      return {
        text,
        model: req.model,
        usage: { inputTokens: Math.ceil(user.length / 2), outputTokens: Math.ceil(text.length / 2) },
        latencyMs: Date.now() - started,
        finishReason: 'stop',
      };
    },
  };
}
