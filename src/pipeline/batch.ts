// 批量模式的跨篇检查：同一批改写结果互相像，是比单篇 AI 味更隐蔽的模板化。
// 规则来自出题项目：共享 24 个以上连续归一化字符即判为模板；开头/结尾套路重复超过 2 篇提示。

import type { Lang } from '../types.ts';
import { splitSentences } from '../detect/text.ts';
import { longestCommonSubstring, normalize } from './similarity.ts';

export interface DiversityIssue {
  kind: 'shared-span' | 'same-opening' | 'same-closing';
  items: number[];
  detail: string;
}

export function batchDiversity(texts: string[], lang: Lang, sharedLimit = 24): DiversityIssue[] {
  const issues: DiversityIssue[] = [];
  const norm = texts.map(normalize);
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const lcs = longestCommonSubstring(norm[i]!, norm[j]!);
      if (lcs.length >= sharedLimit) {
        issues.push({ kind: 'shared-span', items: [i, j], detail: `共享 ${lcs.length} 字：「${lcs.text.slice(0, 30)}…」` });
      }
    }
  }
  const grams = (s: string) => normalize(s).slice(0, lang === 'zh' ? 6 : 24);
  const groupBy = (keyOf: (t: string) => string, kind: DiversityIssue['kind'], label: string) => {
    const map = new Map<string, number[]>();
    texts.forEach((t, i) => {
      const k = keyOf(t);
      if (k) map.set(k, [...(map.get(k) ?? []), i]);
    });
    for (const [k, items] of map) if (items.length > 2) issues.push({ kind, items, detail: `${items.length} 篇${label}都是「${k}」` });
  };
  groupBy((t) => grams(splitSentences(t, lang)[0]?.text ?? ''), 'same-opening', '开头');
  groupBy((t) => grams(splitSentences(t, lang).at(-1)?.text ?? ''), 'same-closing', '结尾');
  return issues;
}
