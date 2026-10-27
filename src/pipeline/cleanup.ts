// 确定性清理：只做不改事实的删除/替换（套话提示语、助手腔、加粗、emoji、中英文空格等）。
// 在调用模型前跑一遍能减少模型的工作量，模型输出后再跑一遍兜底。

import type { Lang } from '../types.ts';
import { detectLang } from '../detect/text.ts';
import { patternsFor } from '../detect/patterns.ts';

export interface CleanupResult {
  text: string;
  changes: number;
  applied: { id: string; from: string; to: string }[];
}

export function ruleCleanup(input: string, opts: { lang?: Lang; aggressive?: boolean } = {}): CleanupResult {
  const lang = opts.lang ?? detectLang(input);
  const applied: CleanupResult['applied'] = [];
  let text = input;

  for (const p of patternsFor(lang)) {
    if (!p.cleanup) continue;
    p.re.lastIndex = 0;
    text = text.replace(p.re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpMatchArray; // [match, ...groups]
      const to = p.cleanup!(m);
      if (to === null || to === m[0]) return m[0];
      applied.push({ id: p.id, from: m[0], to });
      return to;
    });
  }

  if (opts.aggressive) {
    const before = text;
    text = text
      .replace(/^\s*#{1,6}\s+/gm, '')
      .replace(/^\s*[-*•]\s+/gm, '')
      .replace(lang === 'zh' ? /——/g : /\s?—\s?/g, lang === 'zh' ? '，' : ', ');
    if (text !== before) applied.push({ id: 'aggressive', from: '', to: '' });
  }

  text = tidy(text, lang);
  return { text, changes: applied.length, applied };
}

/** 删词之后修补标点和空白 */
export function tidy(text: string, lang: Lang): string {
  let t = text;
  if (lang === 'zh') {
    t = t
      .replace(/([，、；：])\s*[，、；：]+/g, '$1')
      .replace(/([。！？])\s*[，、；：]+/g, '$1')
      .replace(/(^|\n)\s*[，、；：]+/g, '$1')
      .replace(/[，、]\s*([。！？])/g, '$1');
  } else {
    t = t
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/,\s*,/g, ',')
      .replace(/(^|[.!?]\s+|\n)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())
      .replace(/[ \t]{2,}/g, ' ');
  }
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
