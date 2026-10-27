// 风格卡：从用户提供的人写样本里蒸馏出抽象特征（句长、标点、段落形态、人称、开头方式）。
// 只把抽象特征交给模型，不把样本原文塞进提示词，避免模型照搬（出题项目里吃过这个亏）。

import type { Lang } from '../types.ts';
import { computeStats, cv, mean, splitParagraphs, splitSentences, unitLength } from '../detect/text.ts';
import { compare } from './similarity.ts';

export interface StyleCard {
  lang: Lang;
  samples: number;
  meanSentenceLen: number;
  sentenceLenCV: number;
  commaPeriodRatio: number;
  paragraphShape: string;
  voice: string;
  openers: string[];
  habits: string[];
}

export function distillStyle(samples: string[], lang: Lang): StyleCard | null {
  const texts = samples.map((s) => s.trim()).filter((s) => unitLength(s, lang) >= 30);
  if (!texts.length) return null;
  const all = texts.join('\n\n');
  const st = computeStats(all, lang);

  const paraLens = texts.flatMap((t) => splitParagraphs(t).map((p) => unitLength(p.text, lang)));
  const paraPerSample = mean(texts.map((t) => splitParagraphs(t).length));
  const paraCV = cv(paraLens);
  const paragraphShape = paraPerSample <= 1.3
    ? lang === 'zh' ? '多为单段成文' : 'mostly a single block'
    : paraCV > 0.5
      ? lang === 'zh' ? `约 ${Math.round(paraPerSample)} 段，长短不一` : `about ${Math.round(paraPerSample)} paragraphs of uneven length`
      : lang === 'zh' ? `约 ${Math.round(paraPerSample)} 段，篇幅接近` : `about ${Math.round(paraPerSample)} similar-length paragraphs`;

  const firstPerson = (all.match(lang === 'zh' ? /我们|我/g : /\b(?:I|we|my|our)\b/g) ?? []).length;
  const secondPerson = (all.match(lang === 'zh' ? /你们|你|您/g : /\byou(?:r)?\b/gi) ?? []).length;
  const per1k = (n: number) => (n * 1000) / Math.max(1, unitLength(all, lang));
  const voice = per1k(firstPerson) > 8
    ? lang === 'zh' ? '常用第一人称' : 'frequent first person'
    : per1k(secondPerson) > 8
      ? lang === 'zh' ? '常直接对“你”说话' : 'addresses the reader directly'
      : lang === 'zh' ? '以客观陈述为主，人称很少' : 'mostly impersonal';

  // 开头方式只描述类型，不给原句
  const openers = new Set<string>();
  for (const t of texts) {
    const first = splitSentences(t, lang)[0]?.text ?? '';
    const len = unitLength(first, lang);
    if (/^(?:我|我们|I |We )/.test(first)) openers.add(lang === 'zh' ? '从自己正在做的事说起' : 'starts from what the writer is doing');
    else if (/[？?]$/.test(first)) openers.add(lang === 'zh' ? '用问题开头' : 'opens with a question');
    else if (/\d/.test(first)) openers.add(lang === 'zh' ? '开头就给具体数字或时间' : 'opens with a concrete number or time');
    else if (len <= 15) openers.add(lang === 'zh' ? '短句开门见山' : 'short, direct first sentence');
    else openers.add(lang === 'zh' ? '一句长句交代来龙去脉' : 'long first sentence that sets up context');
  }

  const habits: string[] = [];
  if (lang === 'zh') {
    if (st.dashDensity < 0.5) habits.push('几乎不用破折号');
    if (st.semicolonDensity < 0.5) habits.push('几乎不用分号');
    if (st.listItems === 0) habits.push('不用列表');
    if ((all.match(/（[^）]{1,20}）/g) ?? []).length >= texts.length) habits.push('习惯用括号补充说明');
    if (st.connectorDensity < 3) habits.push('很少用“此外、然而、因此”这类连接词');
  } else {
    if (st.dashDensity < 0.5) habits.push('rarely uses dashes');
    if (st.listItems === 0) habits.push('no bullet lists');
    if (/\b(?:don't|isn't|it's|we're|I'm)\b/.test(all)) habits.push('uses contractions');
  }

  return {
    lang,
    samples: texts.length,
    meanSentenceLen: Math.round(st.meanSentenceLen),
    sentenceLenCV: +st.sentenceLenCV.toFixed(2),
    commaPeriodRatio: +st.commaPeriodRatio.toFixed(1),
    paragraphShape,
    voice,
    openers: [...openers].slice(0, 3),
    habits,
  };
}

/** 改写稿与范文的最长共享片段过长，视为照搬 */
export function copiedFromSamples(output: string, samples: string[], maxShared = 18): { sample: number; text: string } | null {
  for (let i = 0; i < samples.length; i++) {
    const r = compare(samples[i]!, output);
    if (r.longestCopy >= maxShared) return { sample: i, text: r.longestCopyText };
  }
  return null;
}
