// 事实台账：改写前抽取必须保留的硬信息，改写后逐项核对。
// 经验来源：出题流水线里改写丢场景、改输入性质、漏格式名、凭空加数字等返修记录。

import type { Fact, FactKind, Lang, LedgerCheck } from '../types.ts';
import { splitParagraphs, unitLength } from '../detect/text.ts';

const NUM = /(?<![\w.])[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.])[-+]?\d+(?:\.\d+)?/g;
const DATE = /\d{4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*[日号])?|\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?(?!\d)|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{1,2}:\d{2}(?::\d{2})?/g;
const URL = /https?:\/\/[^\s，。、；）)」”"']+/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const FILE = /[\w一-鿿.-]+\.(?:xlsx?|csv|docx?|pdf|pptx?|json|txt|md|zip|png|jpe?g|html?|ya?ml|py|js|ts)\b/gi;
const CODE = /`[^`\n]+`/g;
const IDENT = /\b[A-Za-z_][A-Za-z0-9_]*(?:_[A-Za-z0-9]+|[a-z][A-Z][A-Za-z0-9]*)\b|\b[A-Z][A-Z0-9]{1,}(?:[-.][A-Z0-9]+)*\b|\b[A-Za-z]+[-.]?\d+(?:\.\d+)*\b/g;
const LATIN_WORD = /\b[A-Za-z][A-Za-z+#.-]{1,}\b/g;
const TITLE = /《[^》\n]{1,40}》/g;
const QUOTE = /[“"「『]([^”"」』\n]{1,40})[”"」』]/g;

// 确定性强弱：改写把“可能”改成“必然”会改变事实强度
const HEDGES_ZH = /可能|或许|也许|大概|疑似|似乎|看似|估计|初步|暂定|待确认|待核|尚未|未经|不确定/g;
const HEDGES_EN = /\b(?:may|might|could|possibly|likely|unlikely|appears?|seems?|suggests?|preliminary|unconfirmed|estimated|approximately)\b/gi;

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };

/** 把简单中文数字转成阿拉伯数字（“三十五”→35），用于宽松比对 */
export function cnToNumber(s: string): number | null {
  if (!/^[零〇一二两三四五六七八九十百千万亿]+$/.test(s)) return null;
  let total = 0, section = 0, num = 0;
  for (const ch of s) {
    if (ch in CN_DIGIT) num = CN_DIGIT[ch]!;
    else {
      const u = CN_UNIT[ch]!;
      if (u >= 10000) {
        section = (section + num) * u;
        total += section;
        section = 0;
      } else section += (num || 1) * u;
      num = 0;
    }
  }
  return total + section + num;
}

function normNum(s: string): string {
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? String(n) : s;
}

/** 文本里出现的数值，规范化后的多重集；withCn 时把中文数字也算进来（只用于宽松匹配） */
function numberBag(text: string, withCn: boolean): Map<string, number> {
  const bag = new Map<string, number>();
  const add = (k: string) => bag.set(k, (bag.get(k) ?? 0) + 1);
  for (const m of text.matchAll(NUM)) add(normNum(m[0]));
  if (withCn) {
    for (const m of text.matchAll(/[零〇一二两三四五六七八九十百千万亿]{1,8}/g)) {
      const v = cnToNumber(m[0]);
      if (v !== null) add(String(v));
    }
  }
  return bag;
}

function push(facts: Fact[], seen: Set<string>, kind: FactKind, value: string, norm: string, strict: boolean) {
  const key = `${kind}:${norm}`;
  if (seen.has(key) || !norm) return;
  seen.add(key);
  facts.push({ kind, value, norm, strict });
}

export function extractFacts(text: string, lang: Lang, protect: string[] = []): Fact[] {
  const facts: Fact[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(URL)) push(facts, seen, 'url', m[0], m[0], true);
  for (const m of text.matchAll(EMAIL)) push(facts, seen, 'url', m[0], m[0], true);
  for (const m of text.matchAll(FILE)) push(facts, seen, 'filename', m[0], m[0].toLowerCase(), true);
  for (const m of text.matchAll(CODE)) push(facts, seen, 'code', m[0], m[0].slice(1, -1), true);
  for (const m of text.matchAll(DATE)) push(facts, seen, 'date', m[0], m[0].replace(/\s+/g, ''), true);
  for (const m of text.matchAll(NUM)) {
    // 序号类小整数（1. 2. 3.）不入账
    const before = text[m.index! - 1] ?? '';
    const after = text[m.index! + m[0].length] ?? '';
    if (/^\d$/.test(m[0]) && (/[.、)）]/.test(after) || before === '\n' || m.index === 0)) continue;
    push(facts, seen, 'number', m[0], normNum(m[0]), true);
  }
  for (const m of text.matchAll(TITLE)) push(facts, seen, 'quote', m[0], m[0], true);
  for (const m of text.matchAll(QUOTE)) push(facts, seen, 'quote', m[0], m[1]!, false);
  if (lang === 'zh') {
    // 中文里夹的英文/缩写（MQTT、Excel、X.509）是来源事实，必须保留
    for (const m of text.matchAll(LATIN_WORD)) {
      if (/^(?:https?|www)$/i.test(m[0])) continue;
      push(facts, seen, 'latin', m[0], m[0].toLowerCase(), true);
    }
  } else {
    for (const m of text.matchAll(IDENT)) push(facts, seen, 'term', m[0], m[0].toLowerCase(), true);
  }
  for (const p of protect.map((s) => s.trim()).filter(Boolean)) push(facts, seen, 'term', p, p.toLowerCase(), true);
  return facts;
}

export interface LedgerOptions {
  lang: Lang;
  keepStructure?: boolean;
  minRatio?: number;
  maxRatio?: number;
  /** 原文里可以整段删掉的空壳（套话、拔高、助手腔）的长度，篇幅下限按扣掉它们之后的正文算 */
  removableUnits?: number;
}

export function checkFacts(source: string, output: string, facts: Fact[], opts: LedgerOptions): LedgerCheck {
  const lower = output.toLowerCase();
  const compact = lower.replace(/\s+/g, '');
  const outNums = numberBag(output, true);
  const missing: Fact[] = [];

  for (const f of facts) {
    if (f.kind === 'number') {
      if (!outNums.has(f.norm)) missing.push(f);
    } else if (f.kind === 'date') {
      if (!compact.includes(f.norm.toLowerCase())) {
        // 日期允许 2026-07-17 ↔ 2026年7月17日 这类等价写法
        const parts = f.norm.match(/\d+/g) ?? [];
        if (!parts.every((p) => outNums.has(normNum(p)))) missing.push(f);
      }
    } else if (!lower.includes(f.norm) && !compact.includes(f.norm.replace(/\s+/g, ''))) {
      missing.push(f);
    }
  }

  // 凭空出现的数字：输出里的阿拉伯数字必须能在原文（含中文数字写法）找到
  const srcNums = numberBag(source, true);
  const added: LedgerCheck['added'] = [];
  for (const n of numberBag(output, false).keys()) {
    if (!srcNums.has(n)) added.push({ kind: 'number', value: n });
  }

  const srcLen = Math.max(1, unitLength(source, opts.lang));
  const lengthRatio = +(unitLength(output, opts.lang) / srcLen).toFixed(2);
  const paragraphDelta = splitParagraphs(output).length - splitParagraphs(source).length;

  const problems: string[] = [];
  const strictMissing = missing.filter((f) => f.strict);
  if (strictMissing.length) problems.push(`丢失 ${strictMissing.length} 项硬信息：${strictMissing.slice(0, 8).map((f) => f.value).join('、')}`);
  if (added.length) problems.push(`新增了原文没有的数字：${added.slice(0, 6).map((a) => a.value).join('、')}`);
  // 空壳占比高的文本，删干净后本来就会短很多
  const contentShare = Math.max(0.3, 1 - (opts.removableUnits ?? 0) / srcLen);
  const minR = +((opts.minRatio ?? 0.6) * contentShare).toFixed(2);
  const maxR = opts.maxRatio ?? 1.45;
  if (lengthRatio < minR) problems.push(`篇幅缩水到原文的 ${Math.round(lengthRatio * 100)}%，可能删了内容`);
  if (lengthRatio > maxR) problems.push(`篇幅膨胀到原文的 ${Math.round(lengthRatio * 100)}%，可能加了原文没有的内容`);
  if (opts.keepStructure && paragraphDelta !== 0) problems.push(`段落数变化 ${paragraphDelta > 0 ? '+' : ''}${paragraphDelta}`);

  const hedge = opts.lang === 'zh' ? HEDGES_ZH : HEDGES_EN;
  const hs = (source.match(hedge) ?? []).length;
  const ho = (output.match(hedge) ?? []).length;
  if (hs >= 2 && ho < hs / 2) problems.push(`不确定性表述从 ${hs} 处减少到 ${ho} 处，事实强度可能被改强了`);

  return {
    ok: strictMissing.length === 0 && added.length === 0 && lengthRatio >= minR && lengthRatio <= maxR && !(opts.keepStructure && paragraphDelta !== 0),
    missing,
    added,
    lengthRatio,
    paragraphDelta,
    problems,
  };
}
