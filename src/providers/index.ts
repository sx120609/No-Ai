import { isIP } from 'node:net';
import type { LLMClient, ProviderConfig } from '../types.ts';
import { createAnthropicClient } from './anthropic.ts';
import { createGeminiClient } from './gemini.ts';
import { createMockClient } from './mock.ts';
import { createOpenAIClient } from './openai.ts';

export { ProviderError } from './http.ts';

export const PROVIDER_PRESETS: { type: ProviderConfig['type']; name: string; baseUrl?: string; models: string[] }[] = [
  // 模型列表只放确定存在的名字，其余由管理员在后台自行填写
  { type: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: [] },
  { type: 'anthropic', name: 'Anthropic Claude', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  { type: 'gemini', name: 'Google Gemini', models: ['gemini-3.1-pro-preview'] },
  { type: 'openai', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { type: 'openai', name: '通义千问（百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus'] },
  { type: 'openai', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: [] },
  { type: 'openai', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [] },
  { type: 'openai', name: '中转网关（OpenAI 兼容）', baseUrl: '', models: [] },
  { type: 'openai', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: [] },
  { type: 'openai', name: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', models: [] },
  { type: 'cputime', name: '药大拾间 AI（主站线路）', models: ['assistant'] },
  { type: 'mock', name: '离线演示（规则改写）', models: ['rules'] },
];

export function resolveApiKey(p: ProviderConfig): string | undefined {
  if (p.apiKeyEnv && process.env[p.apiKeyEnv]) return process.env[p.apiKeyEnv];
  return p.apiKey || undefined;
}

export function createClient(p: ProviderConfig): LLMClient {
  const key = resolveApiKey(p);
  switch (p.type) {
    case 'openai':
      return createOpenAIClient(p, key);
    case 'anthropic':
      return createAnthropicClient(p, key);
    case 'gemini':
      return createGeminiClient(p, key);
    case 'mock':
      return createMockClient(p);
    case 'cputime':
      throw new Error('药大拾间 AI 由服务端按登录用户创建');
    default:
      throw new Error(`未知的供应商类型：${(p as ProviderConfig).type}`);
  }
}

/**
 * 用户自带供应商（BYO key）时的 SSRF 防护：只允许 https、禁止内网/环回地址。
 * 管理员在后台配置的供应商不受此限制（可接本地 Ollama）。
 */
export function assertPublicBaseUrl(raw: string | undefined): void {
  if (!raw) return;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('baseUrl 不是合法 URL');
  }
  if (u.protocol !== 'https:') throw new Error('自带供应商只允许 https');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('不允许内网地址');
  }
  if (isIP(host) && isPrivateIp(host)) throw new Error('不允许内网地址');
}

function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
