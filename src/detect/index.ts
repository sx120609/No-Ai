// AI 味指数：规则命中 + 文本统计特征，输出 0-100 的可解释分数。
// 这是写作风格指标，不是“AI 检测器”；它衡量的是读者一眼能看出的模型腔调。
//
// 设计取舍（来自配对语料研究和出题返修经验）：
// - 单个“AI 词”不是证据。词表类/弱信号只有扎堆或超出密度预算才计分、才交给模型处理，
//   否则全量替换只会换来另一种刻意（同义轮换）。
// - 句长变异系数在内容对齐后区分度很弱，只作参考，权重很低。

import type { DetectReport, Lang, PatternHit, TextStats } from '../types.ts';
import { CATEGORIES, patternsFor } from './patterns.ts';
import { computeStats, detectLang, splitParagraphs, splitSentences, unitLength } from './text.ts';

const SEVERITY_POINTS = { 1: 1, 2: 2.5, 3: 5 } as const;

// 同一个意思反复换词：既是模型腔，也是“改过头”的典型症状
const SYNONYM_GROUPS: Record<Lang, string[][]> = {
  zh: [
    ['提升', '提高', '增强', '改善', '优化', '加强'],
    ['显著', '明显', '大幅', '极大'],
    ['重要', '关键', '核心', '至关重要'],
    ['问题', '挑战', '难点', '痛点'],
    ['方法', '方式', '途径', '手段', '路径'],
    ['促进', '推动', '助力', '带动'],
    ['确保', '保证', '保障'],
  ],
  en: [
    ['improve', 'enhance', 'boost', 'elevate', 'strengthen'],
    ['significant', 'substantial', 'considerable', 'notable'],
    ['crucial', 'vital', 'essential', 'critical'],
    ['challenge', 'hurdle', 'obstacle', 'issue'],
  ],
};

export function findHits(text: string, lang: Lang): PatternHit[] {
  const hits: PatternHit[] = [];
  for (const p of patternsFor(lang)) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      if (!m[0]) continue;
      hits.push({
        id: p.id,
        category: p.category,
        label: p.label,
        severity: p.severity,
        start: m.index!,
        end: m.index! + m[0].length,
        match: m[0],
        advice: p.advice,
        actionable: true,
        weak: p.weak,
        clarity: p.clarity,
      });
    }
  }
  hits.push(...parallelismHits(text, lang), ...synonymRotationHits(text, lang));
  markActionable(hits, text, lang);
  return hits.sort((a, b) => a.start - b.start || b.end - a.end);
}

/**
 * 弱信号/词表类命中的处理预算：
 * - 同一规则每 500 字允许 2 次正常使用；
 * - 或者 ±80 字范围内有另外 2 个以上弱/词表类命中（扎堆）才算需要处理。
 */
function markActionable(hits: PatternHit[], text: string, lang: Lang) {
  const soft = hits.filter((h) => h.weak || h.clarity);
  if (!soft.length) return;
  const units = Math.max(1, unitLength(text, lang) / (lang === 'zh' ? 500 : 100));
  const budget = Math.max(2, Math.round(2 * units));
  const byId = new Map<string, PatternHit[]>();
  for (const h of soft) byId.set(h.id, [...(byId.get(h.id) ?? []), h]);
  for (const h of soft) {
    const overBudget = byId.get(h.id)!.length > budget;
    const neighbors = soft.filter((o) => o !== h && Math.abs(o.start - h.start) <= 80).length;
    h.actionable = overBudget || neighbors >= 2;
  }
}

/** 排比/三连：同一句里三个以上结构相同的短语，或连续三句同样开头 */
function parallelismHits(text: string, lang: Lang): PatternHit[] {
  const out: PatternHit[] = [];
  const triple = lang === 'zh'
    ? /(?:更[一-鿿]{1,4}[、，,]){2,}更[一-鿿]{1,4}|(?:[一-鿿]{2,4}化[、，,]){2,}[一-鿿]{2,4}化|(?:让[^，。]{2,12}[，,]){2,}让[^，。]{2,12}/g
    : /\b(\w+ly|more \w+|\w+er), (\w+ly|more \w+|\w+er),? and (\w+ly|more \w+|\w+er)\b/gi;
  for (const m of text.matchAll(triple)) {
    out.push({
      id: `${lang}.rhythm.triple`, category: 'rhythm', label: lang === 'zh' ? '排比三连' : 'Rule of three',
      severity: 2, start: m.index!, end: m.index! + m[0].length, match: m[0], actionable: true,
      advice: lang === 'zh' ? '三连排比太工整，保留最实在的一项。' : 'Triplets read as generated; keep the strongest item.',
    });
  }
  const sents = splitSentences(text, lang);
  const head = (s: string) => (lang === 'zh' ? s.slice(0, 2) : s.split(/\s+/)[0]?.toLowerCase() ?? '');
  for (let i = 0; i + 2 < sents.length; i++) {
    const h = head(sents[i]!.text);
    if (h && h === head(sents[i + 1]!.text) && h === head(sents[i + 2]!.text)) {
      out.push({
        id: `${lang}.rhythm.anaphora`, category: 'rhythm', label: lang === 'zh' ? '连续同头句' : 'Repeated openers',
        severity: 2, start: sents[i]!.start, end: sents[i + 2]!.end, match: `${h}…`, actionable: true,
        advice: lang === 'zh' ? '连续几句开头相同，换个主语或合并。' : 'Vary sentence openings.',
      });
      i += 2;
    }
  }
  return out;
}

/** 同一段里同组近义词出现 3 个以上不同成员 → 同义轮换 */
export function synonymRotationHits(text: string, lang: Lang): PatternHit[] {
  const out: PatternHit[] = [];
  for (const para of splitParagraphs(text)) {
    for (const group of SYNONYM_GROUPS[lang]) {
      const found: { word: string; index: number }[] = [];
      for (const w of group) {
        const re = lang === 'zh' ? new RegExp(w, 'g') : new RegExp(`\\b${w}\\w*`, 'gi');
        for (const m of para.text.matchAll(re)) found.push({ word: w, index: para.start + m.index! });
      }
      const distinct = new Set(found.map((f) => f.word));
      if (distinct.size >= 3) {
        found.sort((a, b) => a.index - b.index);
        out.push({
          id: `${lang}.rhythm.synonym-rotation`, category: 'rhythm', label: lang === 'zh' ? '同义轮换' : 'Elegant variation',
          severity: 2, start: found[0]!.index, end: found.at(-1)!.index + found.at(-1)!.word.length,
          match: [...distinct].join('/'), actionable: true,
          advice: lang === 'zh'
            ? '同一个意思反复换词显得刻意，统一用最朴素的那个词，或者干脆少说一次。'
            : 'Same idea, rotating synonyms. Pick the plainest word and reuse it.',
        });
      }
    }
  }
  return out;
}

export function detect(text: string, langHint?: Lang | 'auto'): DetectReport {
  const lang = !langHint || langHint === 'auto' ? detectLang(text) : langHint;
  const hits = findHits(text, lang);
  const stats = computeStats(text, lang);
  const breakdown = scoreBreakdown(hits, stats, text, lang);
  const raw = breakdown.reduce((a, b) => a + b.points, 0);
  // 饱和映射：raw≈20 → 63，raw≈40 → 86
  const score = Math.round(100 * (1 - Math.exp(-raw / 20)));
  return {
    lang,
    score,
    level: score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low',
    hits,
    stats,
    breakdown,
  };
}

function scoreBreakdown(hits: PatternHit[], s: TextStats, text: string, lang: Lang): DetectReport['breakdown'] {
  const out: DetectReport['breakdown'] = [];
  const units = Math.max(1, unitLength(text, lang) / (lang === 'zh' ? 500 : 100));
  const byCat = new Map<string, { pts: number; n: number }>();
  for (const h of hits) {
    if (!h.actionable) continue;
    let pts: number = SEVERITY_POINTS[h.severity];
    if (h.weak) pts *= 0.6;
    if (h.clarity) pts *= 0.4;
    const c = byCat.get(h.category) ?? { pts: 0, n: 0 };
    byCat.set(h.category, { pts: c.pts + pts, n: c.n + 1 });
  }
  for (const [cat, { pts, n }] of byCat) {
    const points = Math.min(14, pts / Math.sqrt(units));
    out.push({ key: `cat.${cat}`, label: CATEGORIES[cat] ?? cat, points: +points.toFixed(1), detail: `${n} 处` });
  }

  if (s.sentences >= 6 && s.sentenceLenCV < 0.35) {
    out.push({ key: 'stat.burst', label: '句长均匀（参考）', points: +Math.min(3, (0.35 - s.sentenceLenCV) * 15).toFixed(1), detail: `CV=${s.sentenceLenCV}` });
  }
  if (lang === 'zh' && s.sentences >= 4 && s.commaPeriodRatio < 1.8) {
    // 模型爱写短促完整句；人写中文常用逗号把一件事一口气说完
    out.push({ key: 'stat.comma', label: '逗号/句号比偏低', points: +Math.min(4, (1.8 - s.commaPeriodRatio) * 4).toFixed(1), detail: `${s.commaPeriodRatio}` });
  }
  const iso = adjacentIsomorphism(text, lang);
  if (iso.pairs >= 4 && iso.rate > 0.12) {
    // 配对语料里相邻句同构：AI 8.7% vs 人类 5.5%
    out.push({ key: 'stat.iso', label: '相邻句同构', points: +Math.min(5, (iso.rate - 0.12) * 30).toFixed(1), detail: `${Math.round(iso.rate * 100)}%` });
  }
  if (s.paragraphs >= 4 && s.paragraphLenCV < 0.25) {
    out.push({ key: 'stat.para', label: '段落长度整齐', points: +((0.25 - s.paragraphLenCV) * 10).toFixed(1), detail: `CV=${s.paragraphLenCV}` });
  }
  if (s.repeatedOpenerRate > 0.35 && s.sentences >= 5) {
    out.push({ key: 'stat.opener', label: '句首重复', points: +((s.repeatedOpenerRate - 0.35) * 10).toFixed(1), detail: `${Math.round(s.repeatedOpenerRate * 100)}%` });
  }
  if (s.listItems >= 3 || s.headings >= 2) {
    // 小节数是配对语料里差异最大的特征之一（AI 中位数 7 节，人类 1 节）
    out.push({ key: 'stat.md', label: '列表/小标题排版', points: +Math.min(8, s.listItems * 0.5 + s.headings * 2).toFixed(1), detail: `${s.listItems} 项 / ${s.headings} 标题` });
  }
  return out.filter((b) => b.points > 0);
}

/** 相邻两句标点骨架相同、长度接近、首字相同 */
function adjacentIsomorphism(text: string, lang: Lang): { rate: number; pairs: number } {
  const sents = splitSentences(text, lang);
  if (sents.length < 3) return { rate: 0, pairs: 0 };
  const skel = (s: string) => s.replace(/[^，。！？；：、,.!?;:]/g, '');
  let same = 0;
  for (let i = 1; i < sents.length; i++) {
    const a = sents[i - 1]!.text;
    const b = sents[i]!.text;
    const la = unitLength(a, lang);
    const lb = unitLength(b, lang);
    if (skel(a) === skel(b) && Math.abs(la - lb) <= Math.max(3, 0.2 * Math.max(la, lb)) && a[0] === b[0]) same++;
  }
  return { rate: same / (sents.length - 1), pairs: sents.length - 1 };
}
