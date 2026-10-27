// 相似度：防“只换同义词”（改写太像原文）和防“抄范文/批次互抄”。

const STRIP = /[\s\p{P}\p{S}]/gu;
const PROTECTED = /https?:\/\/\S+|[\w.-]+\.(?:xlsx?|csv|docx?|pdf|pptx?|json|txt|md|zip|png|jpe?g)\b|\/[\w/.-]{3,}|\b[0-9a-f]{12,}\b/gi;

/** 归一化：去掉 URL/文件名/路径/哈希这类必须原样保留的内容，再去空白和标点 */
export function normalize(text: string): string {
  return text.replace(PROTECTED, '').replace(STRIP, '').toLowerCase();
}

/** 1 - 编辑距离/较长串长度（两行滚动数组，O(nm) 时间 O(m) 空间） */
export function editSimilarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  // 超长文本按段抽样，避免 O(nm) 爆炸
  if (a.length * b.length > 25_000_000) return trigramJaccard(a, b);
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

function grams(s: string, n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

export function trigramJaccard(a: string, b: string): number {
  const A = grams(a, 3);
  const B = grams(b, 3);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 最长公共子串（DP，返回长度和内容） */
export function longestCommonSubstring(a: string, b: string): { length: number; text: string } {
  if (!a || !b) return { length: 0, text: '' };
  if (a.length * b.length > 25_000_000) return lcsByGrams(a, b);
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  let best = 0;
  let endA = 0;
  for (let i = 1; i <= a.length; i++) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = ca === b.charCodeAt(j - 1) ? Math.min(65535, prev[j - 1]! + 1) : 0;
      if (cur[j]! > best) {
        best = cur[j]!;
        endA = i;
      }
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return { length: best, text: a.slice(endA - best, endA) };
}

// 长文本退化方案：以 8-gram 为种子向两侧扩展
function lcsByGrams(a: string, b: string): { length: number; text: string } {
  const n = 8;
  const index = new Map<string, number[]>();
  for (let j = 0; j + n <= b.length; j++) {
    const g = b.slice(j, j + n);
    const list = index.get(g);
    if (list) list.length < 8 && list.push(j);
    else index.set(g, [j]);
  }
  let best = { length: 0, text: '' };
  for (let i = 0; i + n <= a.length; i++) {
    for (const j of index.get(a.slice(i, i + n)) ?? []) {
      let k = n;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best.length) best = { length: k, text: a.slice(i, i + k) };
    }
  }
  return best;
}

export interface CopyReport {
  edit: number;
  jaccard: number;
  longestCopy: number;
  longestCopyText: string;
}

export function compare(source: string, target: string): CopyReport {
  const a = normalize(source);
  const b = normalize(target);
  const lcs = longestCommonSubstring(a, b);
  return {
    edit: +editSimilarity(a, b).toFixed(3),
    jaccard: +trigramJaccard(a, b).toFixed(3),
    longestCopy: lcs.length,
    longestCopyText: lcs.text,
  };
}
