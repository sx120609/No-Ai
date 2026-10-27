// 文本基础工具：语言判断、分句、分段、统计量。

import type { Lang, TextStats } from '../types.ts';

const CJK = /[㐀-鿿豈-﫿]/g;

export function detectLang(text: string): Lang {
  const cjk = text.match(CJK)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  return cjk >= latin * 0.25 ? 'zh' : 'en';
}

export interface Span {
  text: string;
  start: number;
  end: number;
}

export function splitParagraphs(text: string): Span[] {
  const out: Span[] = [];
  const re = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g;
  for (const m of text.matchAll(re)) {
    if (m[0].trim()) out.push({ text: m[0], start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

export function splitSentences(text: string, lang: Lang): Span[] {
  const out: Span[] = [];
  const re = lang === 'zh'
    ? /[^。！？!?；\n]+[。！？!?；]*[”」』）)]*/g
    : /[^.!?\n]+(?:[.!?]+(?=\s|$)|$)["')\]]*/g;
  for (const m of text.matchAll(re)) {
    const t = m[0].trim();
    if (t.length < 2) continue;
    const lead = m[0].length - m[0].trimStart().length;
    out.push({ text: t, start: m.index! + lead, end: m.index! + lead + t.length });
  }
  return out;
}

/** 中文按字、英文按词计长度 */
export function unitLength(s: string, lang: Lang): number {
  if (lang === 'zh') return (s.match(CJK)?.length ?? 0) + (s.match(/[A-Za-z0-9]+/g)?.length ?? 0);
  return s.split(/\s+/).filter(Boolean).length;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function cv(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  if (!m) return 0;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v) / m;
}

const segmenters = new Map<string, Intl.Segmenter>();
export function words(text: string, lang: Lang): string[] {
  const key = lang === 'zh' ? 'zh-CN' : 'en';
  let seg = segmenters.get(key);
  if (!seg) segmenters.set(key, (seg = new Intl.Segmenter(key, { granularity: 'word' })));
  const out: string[] = [];
  for (const s of seg.segment(text)) if (s.isWordLike) out.push(s.segment.toLowerCase());
  return out;
}

const ZH_CONNECTORS = /(此外|另外|同时|然而|因此|所以|总之|总而言之|综上所述|首先|其次|再次|最后|与此同时|不仅如此|更重要的是|换句话说|也就是说|事实上|实际上|值得注意的是|需要注意的是|一方面|另一方面|进一步|进而|从而|由此可见)/g;
const EN_CONNECTORS = /\b(moreover|furthermore|additionally|however|therefore|thus|consequently|in addition|in conclusion|overall|ultimately|notably|importantly|that said|on the other hand|as a result|in summary|firstly|secondly|lastly|finally)\b/gi;

const EMOJI = /\p{Extended_Pictographic}/gu;

export function computeStats(text: string, lang: Lang): TextStats {
  const paras = splitParagraphs(text);
  const sents = splitSentences(text, lang);
  const sentLens = sents.map((s) => unitLength(s.text, lang)).filter((n) => n > 0);
  const paraLens = paras.map((p) => unitLength(p.text, lang)).filter((n) => n > 0);
  const size = Math.max(1, unitLength(text, lang));
  const per1k = (n: number) => (n * 1000) / size;

  const openers = sents.map((s) => {
    const t = s.text.replace(/^[\s\-*#>\d.、（(）)]+/, '');
    return lang === 'zh' ? t.slice(0, 2) : (t.split(/\s+/)[0] ?? '').toLowerCase();
  });
  const counts = new Map<string, number>();
  for (const o of openers) if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
  const repeated = [...counts.values()].filter((c) => c >= 2).reduce((a, b) => a + b, 0);

  const ws = words(text, lang);
  const window = ws.slice(0, 400); // 截断窗口，避免长度偏置
  const lexicalDiversity = window.length ? new Set(window).size / window.length : 0;

  return {
    chars: text.length,
    sentences: sents.length,
    paragraphs: paras.length,
    meanSentenceLen: +mean(sentLens).toFixed(1),
    sentenceLenCV: +cv(sentLens).toFixed(3),
    paragraphLenCV: +cv(paraLens).toFixed(3),
    repeatedOpenerRate: sents.length ? +(repeated / sents.length).toFixed(3) : 0,
    connectorDensity: +per1k((text.match(lang === 'zh' ? ZH_CONNECTORS : EN_CONNECTORS) ?? []).length).toFixed(2),
    dashDensity: +per1k((text.match(lang === 'zh' ? /——|—/g : /—|–| -- /g) ?? []).length).toFixed(2),
    colonDensity: +per1k((text.match(/[：:]/g) ?? []).length).toFixed(2),
    semicolonDensity: +per1k((text.match(/[；;]/g) ?? []).length).toFixed(2),
    listItems: (text.match(/^\s*(?:[-*•]|\d+[.、)]|[（(]?[一二三四五六七八九十]+[)）、])\s*/gm) ?? []).length,
    boldSpans: (text.match(/\*\*[^*\n]+\*\*|__[^_\n]+__/g) ?? []).length,
    headings: (text.match(/^\s*#{1,6}\s+/gm) ?? []).length,
    emoji: (text.match(EMOJI) ?? []).length,
    lexicalDiversity: +lexicalDiversity.toFixed(3),
    commaPeriodRatio: +((text.match(/[，,]/g) ?? []).length / Math.max(1, (text.match(/[。.!！?？]/g) ?? []).length)).toFixed(2),
    firstSentenceLen: sentLens[0] ?? 0,
  };
}
