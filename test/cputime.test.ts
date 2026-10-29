import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { serverConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';
import { hashKey, Store } from '../src/store.ts';
import { AI_ZH, HUMAN_ZH } from './fixtures.ts';

const SECRET = 'noai-test-integration-secret-32-chars!';
let base = '';
let main: Server;
let app: Server;
const log: string[] = [];
let used = 0;
let failChat = false;
let lastChat: any = null;

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const ok = (res: any, data: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 0, data })); };

before(async () => {
  // 假的药大拾间
  main = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, 'http://x');
    log.push(url.pathname);
    const authed = req.headers['x-noai-integration-secret'] === SECRET;
    if (url.pathname === '/api/oauth/token') {
      assert.equal(body.client_secret, SECRET);
      assert.equal(body.code, 'good-code');
      assert.ok(body.code_verifier);
      return void res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer' }));
    }
    if (url.pathname === '/api/oauth/userinfo') return ok(res, { sub: '42', user: { id: 42, nickname: '小药', avatar: null } });
    if (url.pathname === '/api/oauth/revoke') return ok(res, {});
    if (!authed) { res.writeHead(401); return void res.end('{}'); }
    if (url.pathname === '/api/integrations/no-ai/users/42/access') return ok(res, { userId: 42, globalAdmin: false });
    if (url.pathname === '/api/integrations/no-ai/users/42/quota') return ok(res, { dailyQuota: 5, used, remaining: 5 - used, points: 0, totalRemaining: 5 - used, levelName: 'L1', nextResetAt: '' });
    if (url.pathname === '/api/integrations/no-ai/quota/consume') {
      if (used + body.units > 5) { res.writeHead(403); return void res.end(JSON.stringify({ message: '额度用完' })); }
      used += body.units;
      return ok(res, { reservations: Array.from({ length: body.units }, () => ({ source: 'daily', dateKey: '2026-10-29' })), quota: {} });
    }
    if (url.pathname === '/api/integrations/no-ai/quota/refund') { used -= body.reservations.length; return ok(res, { refunded: body.reservations.length }); }
    if (url.pathname === '/api/integrations/no-ai/chat') {
      lastChat = body;
      if (failChat) { res.writeHead(502); return void res.end('{}'); }
      const src = body.messages.at(-1).content.match(/<source_text>\n([\s\S]*?)\n<\/source_text>/)?.[1] ?? '';
      const out = src.replace(/值得注意的是，|总而言之，|首先，|其次，|最后，/g, '').replace(/这不仅仅是技术的进步，而是一场/, '这是一场');
      return ok(res, { content: `<rewritten>\n${out}\n</rewritten>`, model: 'assistant-model' });
    }
    res.writeHead(404); res.end('{}');
  });
  const mainOrigin = await listen(main);

  const store = new Store(':memory:');
  store.saveSettings({
    providers: [{ id: 'demo', type: 'mock' }],
    rewriters: [{ provider: 'demo', model: 'rules' }],
    judge: null,
    defaults: { mode: 'general', strength: 'medium', semanticCheck: false, maxRepairRounds: 0 },
  });
  const config = {
    ...serverConfig, accessMode: 'cpu' as const, ratePerMin: 1000, publicUrl: 'http://127.0.0.1',
    cputime: { origin: mainOrigin, clientId: 'no-ai', secret: SECRET, publicUrl: 'http://127.0.0.1' },
  };
  app = createServer(createApp({ store, config, adminTokenHash: hashKey('adm') }));
  base = await listen(app);
});

after(() => { main.close(); app.close(); });

let cookie = '';
const call = (path: string, body?: unknown) => fetch(base + path, {
  method: body ? 'POST' : 'GET', redirect: 'manual',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

test('meta advertises 药大拾间 login and settings switch to the main-site AI line', async () => {
  const meta = await (await call('/api/meta')).json();
  assert.equal(meta.auth.provider, 'cputime');
  assert.deepEqual(meta.rewriters, ['药大拾间 AI']);
  assert.equal((await call('/api/rewrite', { text: AI_ZH })).status, 401);
});

test('login runs the authorization-code + PKCE flow and creates a session', async () => {
  const start = await call('/auth/login?next=/admin');
  assert.equal(start.status, 303);
  const target = new URL(start.headers.get('location')!);
  assert.equal(target.pathname, '/api/oauth/authorize');
  assert.equal(target.searchParams.get('client_id'), 'no-ai');
  assert.equal(target.searchParams.get('scope'), 'openid profile');
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(target.searchParams.get('redirect_uri'), 'http://127.0.0.1/api/auth/cputime/callback');
  const state = target.searchParams.get('state')!;

  const bad = await call(`/api/auth/cputime/callback?code=good-code&state=forged`);
  assert.equal(bad.status, 303);
  assert.match(bad.headers.get('location')!, /login_error/);

  const cb = await call(`/api/auth/cputime/callback?code=good-code&state=${state}`);
  assert.equal(cb.status, 303);
  assert.equal(cb.headers.get('location'), '/admin');
  const set = cb.headers.get('set-cookie')!;
  assert.match(set, /noai_sid=.+HttpOnly/);
  cookie = set.split(';')[0]!;
  assert.ok(log.includes('/api/oauth/revoke'), 'main-site token is revoked right away');
  // state 只能用一次
  assert.match((await call(`/api/auth/cputime/callback?code=good-code&state=${state}`)).headers.get('location')!, /login_error/);

  const me = await (await call('/api/me')).json();
  assert.equal(me.user.name, '小药');
  assert.equal(me.user.admin, false);
  assert.equal(me.quota.remaining, 5);
  assert.equal((await call('/api/admin/settings')).status, 403);
});

test('rewrite goes through the main-site AI line and charges quota once per job', async () => {
  const r = await call('/api/rewrite', { text: AI_ZH, options: { strength: 'medium' } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(!j.output.includes('值得注意的是'));
  assert.equal(lastChat.userId, 42);
  assert.equal(lastChat.messages[0].role, 'system');
  assert.equal(used, 1);
});

test('text that is already natural costs nothing', async () => {
  const r = await (await call('/api/rewrite', { text: HUMAN_ZH })).json();
  assert.ok(r.skipped);
  assert.equal(used, 1);
});

test('quota is refunded when the model never succeeds, and exhaustion is reported', async () => {
  failChat = true;
  const r = await (await call('/api/rewrite', { text: AI_ZH, options: { maxRepairRounds: 0 } })).json();
  assert.ok(r.warnings.some((w: string) => w.includes('药大拾间 AI')));
  assert.equal(used, 1, 'refunded');
  failChat = false;
  used = 5;
  const r2 = await (await call('/api/rewrite', { text: AI_ZH, options: { maxRepairRounds: 0 } })).json();
  assert.ok(r2.warnings.some((w: string) => w.includes('额度')));
  assert.equal(used, 5);
});

test('logout ends the session', async () => {
  assert.equal((await call('/auth/logout', {})).status, 200);
  assert.deepEqual((await (await call('/api/me')).json()).user, null);
});
