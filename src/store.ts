// 持久化：SQLite（node:sqlite，零依赖）。保存后台配置、访问密钥、任务记录与用量。

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ModelBinding, ProviderConfig } from './types.ts';

export interface Settings {
  providers: ProviderConfig[];
  rewriters: ModelBinding[];
  judge: ModelBinding | null;
  defaults: {
    mode: string;
    strength: string;
    semanticCheck: boolean;
    maxRepairRounds: number;
  };
}

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  disabled: number;
  daily_chars: number;
}

export interface JobRow {
  id: string;
  key_id: string | null;
  ip: string | null;
  created_at: number;
  kind: string;
  status: string;
  input_chars: number;
  output_chars: number;
  before_score: number | null;
  after_score: number | null;
  passed: number | null;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  elapsed_ms: number;
  error: string | null;
  result_json: string | null;
}

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
        created_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, daily_chars INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, key_id TEXT, ip TEXT, created_at INTEGER NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL, input_chars INTEGER NOT NULL DEFAULT 0, output_chars INTEGER NOT NULL DEFAULT 0,
        before_score INTEGER, after_score INTEGER, passed INTEGER, calls INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        elapsed_ms INTEGER NOT NULL DEFAULT 0, error TEXT, result_json TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at);
      CREATE INDEX IF NOT EXISTS jobs_key ON jobs(key_id, created_at);
    `);
  }

  // ---------- settings ----------

  getSettings(): Settings | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('main') as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Settings) : null;
  }

  saveSettings(s: Settings) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('main', JSON.stringify(s));
  }

  // ---------- api keys ----------

  createKey(name: string, dailyChars = 0): { row: ApiKeyRow; key: string } {
    const key = `nai_${randomBytes(24).toString('base64url')}`;
    const row: ApiKeyRow = {
      id: randomBytes(6).toString('hex'), name, prefix: key.slice(0, 10), created_at: Date.now(), disabled: 0, daily_chars: dailyChars,
    };
    this.db.prepare('INSERT INTO api_keys (id, name, key_hash, prefix, created_at, disabled, daily_chars) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.name, hashKey(key), row.prefix, row.created_at, 0, dailyChars);
    return { row, key };
  }

  findKey(key: string): ApiKeyRow | null {
    const row = this.db.prepare('SELECT id, name, prefix, created_at, disabled, daily_chars FROM api_keys WHERE key_hash = ?')
      .get(hashKey(key)) as ApiKeyRow | undefined;
    return row && !row.disabled ? row : null;
  }

  listKeys(): (ApiKeyRow & { used_today: number })[] {
    const since = startOfDay();
    return this.db.prepare(`
      SELECT k.id, k.name, k.prefix, k.created_at, k.disabled, k.daily_chars,
        COALESCE((SELECT SUM(input_chars) FROM jobs j WHERE j.key_id = k.id AND j.created_at >= ?), 0) AS used_today
      FROM api_keys k ORDER BY k.created_at DESC`).all(since) as unknown as (ApiKeyRow & { used_today: number })[];
  }

  updateKey(id: string, patch: { disabled?: boolean; daily_chars?: number; name?: string }) {
    const cur = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow | undefined;
    if (!cur) return false;
    this.db.prepare('UPDATE api_keys SET disabled = ?, daily_chars = ?, name = ? WHERE id = ?').run(
      patch.disabled === undefined ? cur.disabled : Number(patch.disabled),
      patch.daily_chars ?? cur.daily_chars,
      patch.name ?? cur.name,
      id,
    );
    return true;
  }

  deleteKey(id: string) {
    return this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id).changes > 0;
  }

  // ---------- jobs / usage ----------

  usedToday(keyId: string | null, ip: string | null): number {
    const since = startOfDay();
    const row = keyId
      ? this.db.prepare('SELECT COALESCE(SUM(input_chars),0) AS n FROM jobs WHERE key_id = ? AND created_at >= ?').get(keyId, since)
      : this.db.prepare('SELECT COALESCE(SUM(input_chars),0) AS n FROM jobs WHERE key_id IS NULL AND ip = ? AND created_at >= ?').get(ip, since);
    return Number((row as { n: number }).n);
  }

  recordJob(j: Omit<JobRow, 'result_json'> & { result_json?: string | null }) {
    this.db.prepare(`INSERT INTO jobs (id, key_id, ip, created_at, kind, status, input_chars, output_chars, before_score, after_score,
      passed, calls, input_tokens, output_tokens, elapsed_ms, error, result_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      j.id, j.key_id, j.ip, j.created_at, j.kind, j.status, j.input_chars, j.output_chars, j.before_score, j.after_score,
      j.passed, j.calls, j.input_tokens, j.output_tokens, j.elapsed_ms, j.error, j.result_json ?? null,
    );
  }

  listJobs(limit = 50): Omit<JobRow, 'result_json'>[] {
    return this.db.prepare(`SELECT id, key_id, ip, created_at, kind, status, input_chars, output_chars, before_score, after_score,
      passed, calls, input_tokens, output_tokens, elapsed_ms, error FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit) as unknown as Omit<JobRow, 'result_json'>[];
  }

  getJob(id: string): JobRow | null {
    return (this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined) ?? null;
  }

  usageByDay(days = 14) {
    const since = startOfDay() - (days - 1) * 86_400_000;
    return this.db.prepare(`
      SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS jobs,
        SUM(input_chars) AS chars, SUM(calls) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
        AVG(before_score) AS avg_before, AVG(after_score) AS avg_after
      FROM jobs WHERE created_at >= ? GROUP BY day ORDER BY day`).all(since);
  }

  /** 过期任务正文清理（默认只保留统计，不留原文） */
  purgeResults(olderThanMs: number) {
    this.db.prepare('UPDATE jobs SET result_json = NULL WHERE created_at < ? AND result_json IS NOT NULL').run(Date.now() - olderThanMs);
  }
}

function startOfDay(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
