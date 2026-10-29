// 去 AI 流水线：
//   检测 → 抽事实台账 → 确定性清理 → 分块 → 多模型候选改写 → 本地校验（事实/相似度/复检/改过头）
//   → 必要时 LLM 裁判做语义核对 → 修复循环 → 选最优 → 汇总
//
// 修复策略沿用出题流水线：事实类严重问题从原文重写；只剩轻微问题时在上一版上定点修。

import { randomUUID } from 'node:crypto';
import type {
  Candidate, ChatMessage, DetectReport, Fact, Lang, LLMClient, ModelBinding, PipelineEvent,
  RewriteOptions, RewriteResult, SemanticVerdict, Strength,
} from '../types.ts';
import { detect, synonymRotationHits } from '../detect/index.ts';
import { detectLang, splitParagraphs, unitLength } from '../detect/text.ts';
import { ruleCleanup } from './cleanup.ts';
import { checkFacts, extractFacts } from './ledger.ts';
import {
  buildJudgeMessages, buildRepairMessages, buildRewriteMessages, buildSpanEditMessages, parseJson, parseRewritten,
} from './prompts.ts';
import { compare } from './similarity.ts';
import { ProviderError } from '../providers/http.ts';
import { copiedFromSamples, distillStyle, type StyleCard } from './style.ts';

export interface PipelineDeps {
  client(providerId: string): LLMClient;
  rewriters: ModelBinding[];
  judge?: ModelBinding | null;
  /** 并行块数上限 */
  concurrency?: number;
}

type Emit = (e: PipelineEvent) => void;

interface Usage { inputTokens: number; outputTokens: number; calls: number }

// 各力度下的“只换同义词”判定线（出题项目：编辑相似度 >0.72、trigram Jaccard >0.55、最长照抄 >36 字）
const COPY_LIMITS: Record<Strength, { edit: number; jaccard: number; longest: number } | null> = {
  light: null,
  medium: { edit: 0.9, jaccard: 0.8, longest: 80 },
  deep: { edit: 0.72, jaccard: 0.55, longest: 36 },
};

export async function runPipeline(
  input: string,
  opts: RewriteOptions,
  deps: PipelineDeps,
  emit: Emit = () => {},
  signal?: AbortSignal,
): Promise<RewriteResult> {
  const started = Date.now();
  const id = randomUUID();
  const text = input.replace(/\r\n?/g, '\n').replace(/^﻿/, '').trim();
  const lang: Lang = !opts.lang || opts.lang === 'auto' ? detectLang(text) : opts.lang;
  const strength: Strength = opts.strength ?? 'medium';
  const usage: Usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const warnings: string[] = [];

  emit({ type: 'stage', stage: 'detect', message: '检测 AI 味' });
  const before = detect(text, lang);
  emit({ type: 'detect', which: 'before', report: before });

  const facts = extractFacts(text, lang, opts.protect);
  emit({ type: 'ledger', facts });

  const style = opts.styleSamples?.length ? distillStyle(opts.styleSamples, lang) : null;
  if (opts.styleSamples?.length && !style) warnings.push('风格样本太短，已忽略');

  // 确定性清理；若清理意外破坏了事实，则退回原文
  const cleaned = ruleCleanup(text, { lang });
  const cleanedOk = checkFacts(text, cleaned.text, facts, { lang, minRatio: 0.5, maxRatio: 1.1 }).missing.filter((f) => f.strict).length === 0;
  const base = cleanedOk ? cleaned.text : text;
  if (cleaned.changes) emit({ type: 'cleanup', text: base, changes: cleaned.changes });

  // 原文已经很干净时跳过模型（避免越改越刻意）；选了「重写」说明用户就是要整段重来，照常调用模型
  const skip = (opts.skipIfClean ?? true) && strength !== 'deep' && before.score < 15 && !opts.instructions;
  if (skip) {
    const after = detect(base, lang);
    emit({ type: 'detect', which: 'after', report: after });
    const result: RewriteResult = {
      id, input: text, output: base, lang, before, after, facts, candidates: [], chosen: null,
      passed: true, skipped: true, chunks: 0,
      warnings: ['原文 AI 味已经很低，只做了确定性清理，没有调用模型（避免越改越刻意）；确实要改就选「重写」'],
      elapsedMs: Date.now() - started, usage,
    };
    emit({ type: 'done', result });
    return result;
  }

  const rewriters = (opts.rewriters?.length ? opts.rewriters : deps.rewriters).slice(0, Math.max(1, opts.candidates ?? deps.rewriters.length));
  if (!rewriters.length) throw new Error('没有可用的改写模型，请先在后台配置供应商和改写模型');

  const chunks = chunk(base, opts.chunkChars ?? (lang === 'zh' ? 1800 : 5000));
  emit({ type: 'stage', stage: 'rewrite', message: chunks.length > 1 ? `分 ${chunks.length} 块改写` : '改写中' });

  const allCandidates: Candidate[] = [];
  const outputs: string[] = new Array(chunks.length);
  let allPassed = true;
  const concurrency = Math.max(1, deps.concurrency ?? 3);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const i = next++;
      const unit = await rewriteUnit(chunks[i]!, i, {
        lang, strength, opts, deps, rewriters, style, usage, signal,
        emit: (c) => {
          allCandidates.push(c);
          emit({ type: 'candidate', candidate: c, chunk: i });
        },
      });
      outputs[i] = unit.text;
      if (!unit.passed) allPassed = false;
      warnings.push(...unit.warnings.map((w) => (chunks.length > 1 ? `第 ${i + 1} 块：${w}` : w)));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));

  const output = outputs.join('\n\n');
  const after = detect(output, lang);
  emit({ type: 'detect', which: 'after', report: after });
  const finalCheck = checkFacts(text, output, facts, { lang, keepStructure: opts.keepStructure, ...ratioBounds(strength), removableUnits: removableUnits(text, before) });
  if (!finalCheck.ok) {
    allPassed = false;
    warnings.push(...finalCheck.problems);
  }

  const chosen = allCandidates.filter((c) => c.passed).sort((a, b) => b.total - a.total)[0]?.id ?? null;
  const result: RewriteResult = {
    id, input: text, output, lang, before, after, facts, candidates: allCandidates, chosen,
    passed: allPassed, skipped: false, chunks: chunks.length, warnings: [...new Set(warnings)],
    elapsedMs: Date.now() - started, usage,
  };
  emit({ type: 'done', result });
  return result;
}

function ratioBounds(strength: Strength) {
  // 精修模式每处修改都单独过了事实守卫，删掉整段空话是正常的，篇幅下限放宽
  return strength === 'light' ? { minRatio: 0.45, maxRatio: 1.15 } : strength === 'deep' ? { minRatio: 0.55, maxRatio: 1.5 } : { minRatio: 0.6, maxRatio: 1.35 };
}

/** 按段落切块，单段超长时按句号再切 */
export function chunk(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const paras = splitParagraphs(text).map((p) => p.text);
  const out: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  for (const p of paras) {
    const pieces = p.length > max ? (p.match(/[^。！？.!?]+[。！？.!?]*|[。！？.!?]+/g) ?? [p]) : [p];
    for (const piece of pieces) {
      if (cur && cur.length + piece.length + 2 > max) flush();
      cur += (cur ? '\n\n' : '') + piece;
    }
  }
  flush();
  return out;
}

interface UnitCtx {
  lang: Lang;
  strength: Strength;
  opts: RewriteOptions;
  deps: PipelineDeps;
  rewriters: ModelBinding[];
  style: StyleCard | null;
  usage: Usage;
  signal?: AbortSignal;
  emit: (c: Candidate) => void;
}

async function rewriteUnit(source: string, chunkIndex: number, ctx: UnitCtx): Promise<{ text: string; passed: boolean; warnings: string[] }> {
  const { lang, strength, opts } = ctx;
  const report = detect(source, lang);
  const facts = extractFacts(source, lang, opts.protect);
  const promptInput = {
    lang, mode: opts.mode ?? 'general', strength, source, report, facts,
    keepStructure: !!opts.keepStructure, instructions: opts.instructions, style: ctx.style,
  } as const;
  const maxRounds = Math.max(0, opts.maxRepairRounds ?? 2);
  const warnings: string[] = [];

  const fatalErrors = new Set<string>();
  // 第一轮：每个改写模型各出一个候选
  const first = await Promise.all(ctx.rewriters.map((b) => attempt(b, 0, null)));
  let best = pickBest(first);

  for (let round = 1; round <= maxRounds && best && !best.passed; round++) {
    // 只有一个改写模型、而它的错误重试也没用（如额度用完、被安全策略拦下）时直接停
    if (best.error && fatalErrors.has(best.id) && ctx.rewriters.length === 1) break;
    // 调用失败时换下一个模型从头来；内容不过关时由同一模型修复
    const idx = ctx.rewriters.findIndex((b) => label(b) === best!.binding);
    const binding = best.error ? ctx.rewriters[(idx + 1) % ctx.rewriters.length]! : ctx.rewriters[Math.max(0, idx)]!;
    const repaired = await attempt(binding, round, best.error ? null : best);
    // 修复没有带来任何变化就别再浪费调用
    const stuck = !best.error && !repaired.error && repaired.text === best.text;
    best = pickBest([best, repaired]);
    if (stuck) break;
  }

  if (!best || best.error) {
    warnings.push(best?.error ? `改写失败：${best.error}` : '改写失败');
    return { text: source, passed: false, warnings };
  }
  if (!best.passed) warnings.push(...best.problems.map((p) => `未完全通过：${p}`));
  return { text: best.text, passed: best.passed, warnings };

  async function attempt(binding: ModelBinding, round: number, prev: Candidate | null): Promise<Candidate> {
    const cid = randomUUID().slice(0, 8);
    const started = Date.now();
    try {
      const client = ctx.deps.client(binding.provider);
      let text: string;
      let edits: Candidate['edits'];
      if (strength === 'light') {
        const baseText = prev && !prev.severe ? prev.text : source;
        const msgs = buildSpanEditMessages({ ...promptInput, source: baseText, report: detect(baseText, lang) }, 12);
        if (prev) msgs[1]!.content += `\n\n${lang === 'zh' ? '上一版仍有问题：' : 'Remaining problems:'}\n${prev.problems.map((p) => `- ${p}`).join('\n')}`;
        const raw = await call(client, binding, msgs);
        ({ text, edits } = applyEdits(baseText, raw, facts, lang));
      } else {
        const baseMsgs = buildRewriteMessages(promptInput);
        const msgs = prev ? buildRepairMessages(baseMsgs, prev.text, prev.problems, lang, prev.severe) : baseMsgs;
        text = parseRewritten(await call(client, binding, msgs));
      }
      text = ruleCleanup(text, { lang }).text;
      const cand = await evaluate(cid, label(binding), text, round, source, report, facts, ctx);
      cand.edits = edits;
      cand.latencyMs = Date.now() - started;
      ctx.emit(cand);
      return cand;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cand: Candidate = {
        id: cid, binding: label(binding), text: source, round, detect: report,
        ledger: { ok: false, missing: [], added: [], lengthRatio: 1, paragraphDelta: 0, problems: [] },
        problems: [message], severe: true, total: -1, passed: false, error: message, latencyMs: Date.now() - started,
      };
      if (err instanceof ProviderError && !err.retryable) fatalErrors.add(cid);
      ctx.emit(cand);
      if (ctx.signal?.aborted) throw err;
      return cand;
    }
  }

  async function call(client: LLMClient, binding: ModelBinding, messages: ChatMessage[]): Promise<string> {
    const res = await client.chat({
      model: binding.model, messages, temperature: binding.temperature, maxTokens: binding.maxTokens,
      effort: binding.effort, signal: ctx.signal,
    });
    ctx.usage.calls++;
    ctx.usage.inputTokens += res.usage?.inputTokens ?? 0;
    ctx.usage.outputTokens += res.usage?.outputTokens ?? 0;
    return res.text;
  }
}

const label = (b: ModelBinding) => b.label || `${b.provider}/${b.model}`;

const REMOVABLE = new Set(['filler', 'inflate', 'assistant', 'metaphor', 'structure']);

/** 原文中可整体删除的空壳长度（合并重叠区间） */
function removableUnits(source: string, report: DetectReport): number {
  const spans = report.hits
    .filter((h) => h.actionable && REMOVABLE.has(h.category) && h.end - h.start <= 80)
    .map((h) => [h.start, h.end] as const)
    .sort((a, b) => a[0] - b[0]);
  let total = 0, curS = -1, curE = -1;
  for (const [s, e] of spans) {
    if (s > curE) { if (curE > curS) total += unitLength(source.slice(curS, curE), report.lang); curS = s; curE = e; }
    else curE = Math.max(curE, e);
  }
  if (curE > curS) total += unitLength(source.slice(curS, curE), report.lang);
  return total;
}

function pickBest(cands: (Candidate | null)[]): Candidate | null {
  const ok = cands.filter((c): c is Candidate => !!c);
  return ok.sort((a, b) => Number(b.passed) - Number(a.passed) || b.total - a.total)[0] ?? null;
}

/** 解析并应用片段修改；每处修改单独做事实守卫，不安全的修改直接拒绝 */
export function applyEdits(source: string, raw: string, facts: Fact[], lang: Lang): { text: string; edits: NonNullable<Candidate['edits']> } {
  const parsed = parseJson<{ edits?: { find?: string; replace?: string; rule?: string }[] }>(raw);
  const edits: NonNullable<Candidate['edits']> = [];
  let text = source;
  for (const e of parsed?.edits ?? []) {
    const find = e.find ?? '';
    const replace = e.replace ?? '';
    const rec = { find, replace, rule: e.rule, applied: false, reason: undefined as string | undefined };
    edits.push(rec);
    if (!find) { rec.reason = '空片段'; continue; }
    const first = text.indexOf(find);
    if (first < 0) { rec.reason = '原文中找不到该片段'; continue; }
    if (text.indexOf(find, first + 1) >= 0) { rec.reason = '片段不唯一'; continue; }
    const lost = facts.filter((f) => f.strict && find.toLowerCase().includes(f.norm) && !replace.toLowerCase().includes(f.norm));
    if (lost.length) { rec.reason = `会丢失：${lost.map((f) => f.value).join('、')}`; continue; }
    const newNums = (replace.match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => !find.includes(n));
    if (newNums.length) { rec.reason = `引入了新数字：${newNums.join('、')}`; continue; }
    text = text.slice(0, first) + replace + text.slice(first + find.length);
    rec.applied = true;
  }
  return { text: lang === 'zh' ? text : text.replace(/[ \t]{2,}/g, ' '), edits };
}

async function evaluate(
  id: string, binding: string, text: string, round: number, source: string, before: DetectReport, facts: Fact[], ctx: UnitCtx,
): Promise<Candidate> {
  const { lang, strength, opts } = ctx;
  const problems: string[] = [];
  let severe = false;

  const after = detect(text, lang);
  const ledger = checkFacts(source, text, facts, {
    lang, keepStructure: !!opts.keepStructure, ...ratioBounds(strength), removableUnits: removableUnits(source, before),
  });
  if (!ledger.ok) {
    problems.push(...ledger.problems);
    severe ||= ledger.missing.some((f) => f.strict) || ledger.added.length > 0;
  }

  // 仍残留的强信号（非弱信号、需处理、严重级别 3）
  const strong = after.hits.filter((h) => h.actionable && !h.weak && !h.clarity && h.severity === 3);
  if (strong.length) problems.push(`仍有明显模型腔：${[...new Set(strong.map((h) => `${h.label}「${h.match.slice(0, 16)}」`))].slice(0, 5).join('、')}`);

  // 改过头：引入了原文没有的同义轮换、表演型口语
  const rotBefore = synonymRotationHits(source, lang).length;
  const rotAfter = synonymRotationHits(text, lang).length;
  if (rotAfter > rotBefore) problems.push('改写引入了同义轮换（同一个意思换着词说），读起来刻意，请统一用一个朴素的词');
  const overdone = after.hits.filter((h) => h.category === 'overdone').length - before.hits.filter((h) => h.category === 'overdone').length;
  if (overdone > 0) problems.push('出现了刻意口语或虚构情节，请保持清楚克制的语气');

  const copy = compare(source, text);
  const limit = COPY_LIMITS[strength];
  if (limit && before.score >= 30 && (copy.edit > limit.edit || copy.jaccard > limit.jaccard || copy.longestCopy > limit.longest)) {
    problems.push(`改动太少，和原文过于相似（编辑相似度 ${copy.edit}，最长照抄 ${copy.longestCopy} 字：「${copy.longestCopyText.slice(0, 24)}…」）。请改变信息顺序、句子主语和动词，而不是逐句换词`);
  }
  if (opts.styleSamples?.length) {
    const copied = copiedFromSamples(text, opts.styleSamples);
    if (copied) {
      problems.push(`照搬了风格样本 ${copied.sample + 1} 的原句「${copied.text.slice(0, 20)}…」`);
      severe = true;
    }
  }
  if (after.score > before.score + 5) problems.push(`AI 味不降反升（${before.score} → ${after.score}）`);

  let semantic: SemanticVerdict | undefined;
  // 本地校验都过了才花钱跑裁判
  if (!problems.length && opts.semanticCheck && ctx.deps.judge) {
    semantic = await judge(source, text, ctx);
    // 只有高严重度（事实、要求、凭空新增）才拦；问题是局部的，在这一版上定点修而不是从头重写
    if (semantic && semantic.blocking.length) problems.push(...semantic.blocking.slice(0, 5).map((i) => `语义核对：${i}`));
  }

  const total = Math.round(
    100
      - after.score * 0.6
      - (ledger.missing.filter((f) => f.strict).length + ledger.added.length) * 25
      - (rotAfter > rotBefore ? 10 : 0)
      - Math.max(0, overdone) * 8
      - (semantic ? (100 - semantic.score) * 0.3 : 0)
      - (limit ? Math.max(0, copy.edit - limit.edit) * 40 : 0),
  );

  return {
    id, binding, text, round, detect: after, ledger, semantic,
    copy: { edit: copy.edit, jaccard: copy.jaccard, longestCopy: copy.longestCopy },
    problems, severe, total, passed: problems.length === 0,
  };
}

async function judge(source: string, output: string, ctx: UnitCtx): Promise<SemanticVerdict | undefined> {
  const b = ctx.deps.judge!;
  try {
    const res = await ctx.deps.client(b.provider).chat({
      model: b.model, messages: buildJudgeMessages(source, output, ctx.lang), temperature: b.temperature,
      maxTokens: b.maxTokens, effort: b.effort, signal: ctx.signal,
    });
    ctx.usage.calls++;
    ctx.usage.inputTokens += res.usage?.inputTokens ?? 0;
    ctx.usage.outputTokens += res.usage?.outputTokens ?? 0;
    const v = parseJson<{ score?: unknown; aiLikeness?: unknown; issues?: unknown[] }>(res.text);
    if (!v) return undefined;
    const issues = (Array.isArray(v.issues) ? v.issues : []).map((i) =>
      typeof i === 'string' ? { level: 'high', text: i } : { level: String((i as any)?.level ?? 'high'), text: String((i as any)?.text ?? '') },
    ).filter((i) => i.text);
    const blocking = issues.filter((i) => i.level === 'high').map((i) => i.text);
    return {
      equivalent: blocking.length === 0,
      score: Number(v.score) || 0,
      issues: issues.map((i) => (i.level === 'high' ? i.text : `（轻微）${i.text}`)),
      blocking,
      aiLikeness: v.aiLikeness !== undefined ? Number(v.aiLikeness) : undefined,
    };
  } catch {
    return undefined; // 裁判失败不阻断主流程
  }
}
