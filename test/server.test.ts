import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { serverConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';
import { hashKey, Store } from '../src/store.ts';
import { AI_ZH } from './fixtures.ts';

const ADMIN = 'adm_test_token';
let base = '';
let upstreamBase = '';
let server: Server;
let upstream: Server;
const upstreamRequests: { auth?: string; body: any }[] = [];

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

before(async () => {
  // 假的 OpenAI 兼容上游：把 <source_text> 里的原文去掉套话后返回
  upstream = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(req.headers.authorization === 'Bearer sk-secret-123456789' ? 200 : 401, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'gpt-a' }] }));
    }
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    upstreamRequests.push({ auth: req.headers.authorization, body });
    const user = body.messages.at(-1).content as string;
    const src = user.match(/<source_text>\n([\s\S]*?)\n<\/source_text>/)?.[1] ?? '';
    const out = src.replace(/值得注意的是，|总而言之，|首先，|其次，|最后，/g, '').replace(/这不仅仅是技术的进步，而是一场/, '这是一场');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: `<rewritten>\n${out}\n</rewritten>` }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
  });
  upstreamBase = await listen(upstream);

  const store = new Store(':memory:');
  // 显式写入离线配置，避免按本机环境变量自动接到真实供应商
  store.saveSettings({
    providers: [{ id: 'demo', type: 'mock' }],
    rewriters: [{ provider: 'demo', model: 'rules' }],
    judge: null,
    defaults: { mode: 'general', strength: 'medium', semanticCheck: false, maxRepairRounds: 2 },
  });
  const config = { ...serverConfig, accessMode: 'key' as const, allowByo: false, ratePerMin: 1000 };
  server = createServer(createApp({ store, config, adminTokenHash: hashKey(ADMIN) }));
  base = await listen(server);
});

after(() => {
  server.close();
  upstream.close();
});

const call = async (path: string, init: { method?: string; body?: unknown; token?: string; accept?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.accept) headers.accept = init.accept;
  const res = await fetch(base + path, { method: init.method ?? (init.body ? 'POST' : 'GET'), headers, body: init.body ? JSON.stringify(init.body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE */ }
  return { status: res.status, json, text };
};

test('meta and detect are public, rewrite requires a key', async () => {
  const meta = await call('/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.json.accessMode, 'key');
  assert.equal((await call('/api/detect', { body: { text: AI_ZH } })).status, 200);
  assert.equal((await call('/api/rewrite', { body: { text: AI_ZH } })).status, 401);
  assert.equal((await call('/api/me')).json.user, null);
  const d = await call('/api/detect', { body: { text: AI_ZH }, token: ADMIN });
  assert.equal(d.status, 200);
  assert.ok(d.json.score >= 60);
});

test('static pages are served and traversal is blocked', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.ok((await home.text()).includes('<title>去AI味</title>'));
  assert.equal((await fetch(base + '/admin')).status, 200);
  assert.equal((await fetch(base + '/..%2Fpackage.json')).status, 404);
});

test('admin endpoints reject non-admin callers', async () => {
  assert.equal((await call('/api/admin/settings')).status, 401);
  const { json } = await call('/api/admin/keys', { body: { name: 'x' }, token: ADMIN });
  assert.equal((await call('/api/admin/settings', { token: json.key })).status, 403);
});

test('access key can rewrite with the offline demo provider (legacy text field included)', async () => {
  const { json } = await call('/api/admin/keys', { body: { name: 'client' }, token: ADMIN });
  const r = await call('/api/rewrite', { body: { text: AI_ZH, options: { strength: 'medium' } }, token: json.key });
  assert.equal(r.status, 200, r.text);
  assert.equal(typeof r.json.text, 'string');
  assert.equal(r.json.text, r.json.output);
  assert.ok(r.json.after.score < r.json.before.score);
});

test('SSE stream emits progress and a final done event', async () => {
  const r = await call('/api/rewrite?stream=1', { body: { text: AI_ZH }, token: ADMIN });
  assert.equal(r.status, 200);
  const events = [...r.text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
  assert.ok(events.includes('detect'));
  assert.ok(events.includes('candidate'));
  assert.equal(events.at(-1), 'done');
});

test('daily quota is enforced per key', async () => {
  const { json } = await call('/api/admin/keys', { body: { name: 'tiny', dailyChars: 50 }, token: ADMIN });
  const r = await call('/api/rewrite', { body: { text: AI_ZH }, token: json.key });
  assert.equal(r.status, 429);
});

test('bring-your-own provider is refused unless enabled', async () => {
  const r = await call('/api/rewrite', { body: { text: AI_ZH, apiKey: 'sk-x', baseUrl: 'https://example.com/v1', model: 'm' }, token: ADMIN });
  assert.equal(r.status, 403);
});

test('settings: keys are masked, admin-configured OpenAI-compatible provider is called correctly', async () => {
  const put = await call('/api/admin/settings', {
    method: 'PUT', token: ADMIN,
    body: {
      providers: [{ id: 'fake', name: 'Fake', type: 'openai', baseUrl: `${upstreamBase}/v1`, apiKey: 'sk-secret-123456789' }],
      rewriters: [{ provider: 'fake', model: 'fake-model' }],
      judge: null,
      defaults: { mode: 'general', strength: 'medium', semanticCheck: false, maxRepairRounds: 1 },
    },
  });
  assert.equal(put.status, 200, put.text);
  assert.ok(!put.text.includes('sk-secret'));
  const got = await call('/api/admin/settings', { token: ADMIN });
  assert.ok(!got.text.includes('sk-secret'));
  assert.equal(got.json.settings.providers[0].keyStatus, 'stored');

  // 不带新密钥再次保存：旧密钥保留
  const again = await call('/api/admin/settings', { method: 'PUT', token: ADMIN, body: got.json.settings });
  assert.equal(again.status, 200);

  const r = await call('/api/rewrite', { body: { text: AI_ZH }, token: ADMIN });
  assert.equal(r.status, 200, r.text);
  const req = upstreamRequests.at(-1)!;
  assert.equal(req.auth, 'Bearer sk-secret-123456789');
  assert.equal(req.body.model, 'fake-model');
  assert.equal(req.body.messages[0].role, 'system');
  assert.ok(!r.json.output.includes('值得注意的是'));
  assert.ok(r.json.usage.calls >= 1);
});

test('admin pulls upstream models; users pick one model and an effort per job', async () => {
  const pulled = await call('/api/admin/models', { body: { provider: 'fake' }, token: ADMIN });
  assert.deepEqual(pulled.json, { ok: true, models: ['gpt-a', 'gpt-b'] });
  const got = await call('/api/admin/settings', { token: ADMIN });
  const settings = got.json.settings;
  settings.rewriters = [{ provider: 'fake', model: 'gpt-a', label: 'gpt-a', public: true }, { provider: 'fake', model: 'gpt-b', label: 'gpt-b' }];
  assert.equal((await call('/api/admin/settings', { method: 'PUT', token: ADMIN, body: settings })).status, 200);
  // 未登录只看到公开的；管理员看到全部
  assert.deepEqual((await call('/api/meta')).json.rewriters, ['gpt-a']);
  assert.deepEqual((await call('/api/meta', { token: ADMIN })).json.rewriters, ['gpt-a', 'gpt-b']);
  const before = upstreamRequests.length;
  assert.equal((await call('/api/rewrite', { body: { text: AI_ZH, options: { model: 'gpt-b', effort: 'high', maxRepairRounds: 0 } }, token: ADMIN })).status, 200);
  const sent = upstreamRequests.slice(before);
  assert.equal(sent.length, 1, 'only the chosen model runs');
  assert.equal(sent[0]!.body.model, 'gpt-b');
  assert.equal(sent[0]!.body.reasoning_effort, 'high');
  // 没选模型时用第一个，而不是把所有开放的模型都跑一遍
  const before2 = upstreamRequests.length;
  await call('/api/rewrite', { body: { text: AI_ZH, options: { maxRepairRounds: 0 } }, token: ADMIN });
  assert.deepEqual(upstreamRequests.slice(before2).map((r) => r.body.model), ['gpt-a']);
  assert.equal((await call('/api/rewrite', { body: { text: AI_ZH, options: { model: 'not-offered' } }, token: ADMIN })).status, 400);
});

test('settings validation rejects bad input', async () => {
  const bad = await call('/api/admin/settings', {
    method: 'PUT', token: ADMIN,
    body: { providers: [{ id: 'x', type: 'openai', apiKeyEnv: 'ADMIN_TOKEN' }], rewriters: [{ provider: 'x', model: 'm' }] },
  });
  assert.equal(bad.status, 400);
  const dangling = await call('/api/admin/settings', {
    method: 'PUT', token: ADMIN,
    body: { providers: [{ id: 'x', type: 'mock' }], rewriters: [{ provider: 'nope', model: 'm' }] },
  });
  assert.equal(dangling.status, 400);
});

test('usage and job log are recorded', async () => {
  const u = await call('/api/admin/usage', { token: ADMIN });
  assert.equal(u.status, 200);
  assert.ok(u.json.days.length >= 1);
  const j = await call('/api/admin/jobs', { token: ADMIN });
  assert.ok(j.json.jobs.length >= 3);
  assert.ok(!('result_json' in j.json.jobs[0]));
});
