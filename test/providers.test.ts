import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { assertPublicBaseUrl, createClient } from '../src/providers/index.ts';

let base = '';
let server: Server;
const seen: { url: string; headers: Record<string, unknown>; body: any }[] = [];
let failNext = 0;

before(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    seen.push({ url: req.url!, headers: req.headers, body: JSON.parse(raw) });
    if (failNext > 0) {
      failNext--;
      res.writeHead(503).end('busy');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url!.includes(':generateContent')) {
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'gemini-ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }));
    } else {
      res.end(JSON.stringify({ model: 'm', choices: [{ message: { content: '<think>hidden</think>openai-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test('openai-compatible client: request shape, think-stripping, retry on 503', async () => {
  failNext = 1;
  const c = createClient({ id: 'o', type: 'openai', baseUrl: `${base}/v1/`, apiKey: 'sk-1' });
  const r = await c.chat({ model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], maxTokens: 100, effort: 'high' });
  assert.equal(r.text, 'openai-ok');
  const last = seen.at(-1)!;
  assert.equal(last.url, '/v1/chat/completions');
  assert.equal(last.headers.authorization, 'Bearer sk-1');
  assert.equal(last.body.max_tokens, 100);
  assert.equal(last.body.reasoning_effort, 'high');
  assert.equal(last.body.temperature, undefined);
});

test('gemini client: system instruction, role mapping, thought parts skipped', async () => {
  const c = createClient({ id: 'g', type: 'gemini', baseUrl: base, apiKey: 'g-key' });
  const r = await c.chat({ model: 'gemini-x', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'u2' }] });
  assert.equal(r.text, 'gemini-ok');
  const last = seen.at(-1)!;
  assert.equal(last.url, '/v1beta/models/gemini-x:generateContent');
  assert.equal(last.headers['x-goog-api-key'], 'g-key');
  assert.equal(last.body.systemInstruction.parts[0].text, 'sys');
  assert.deepEqual(last.body.contents.map((c: any) => c.role), ['user', 'model', 'user']);
});

test('BYO base URL guard blocks private and non-https targets', () => {
  for (const bad of ['http://api.example.com', 'https://127.0.0.1/v1', 'https://localhost/v1', 'https://10.0.0.5/v1', 'https://192.168.1.2', 'https://[::1]/v1', 'https://169.254.169.254/latest']) {
    assert.throws(() => assertPublicBaseUrl(bad), bad);
  }
  assert.doesNotThrow(() => assertPublicBaseUrl('https://api.deepseek.com/v1'));
});
