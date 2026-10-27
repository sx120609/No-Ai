import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detect, synonymRotationHits } from '../src/detect/index.ts';
import { detectLang } from '../src/detect/text.ts';
import { AI_EN, AI_ZH, HUMAN_EN, HUMAN_ZH } from './fixtures.ts';

test('language detection', () => {
  assert.equal(detectLang(AI_ZH), 'zh');
  assert.equal(detectLang(AI_EN), 'en');
  assert.equal(detectLang('使用 MQTT 接入 IoTDA 平台'), 'zh');
});

test('obvious AI Chinese scores high, human Chinese scores low', () => {
  const ai = detect(AI_ZH);
  const human = detect(HUMAN_ZH);
  assert.ok(ai.score >= 60, `ai score ${ai.score}`);
  assert.ok(human.score < 30, `human score ${human.score}`);
  const ids = new Set(ai.hits.map((h) => h.id));
  for (const id of ['zh.filler.notably', 'zh.tpl.not-but', 'zh.inflate.tail', 'zh.assistant.closing', 'zh.struct.bold']) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
});

test('obvious AI English scores high, human English scores low', () => {
  const ai = detect(AI_EN);
  const human = detect(HUMAN_EN);
  assert.ok(ai.score >= 60, `ai score ${ai.score}`);
  assert.ok(human.score < 30, `human score ${human.score}`);
});

test('a single ordinary buzzword is reported but not actionable', () => {
  const text = '这次改版之后页面加载提升了一截，用户投诉少了不少，下个月再看看留存数据有没有变化，如果没有就回滚到旧版首页。';
  const r = detect(text);
  const buzz = r.hits.filter((h) => h.clarity || h.weak);
  assert.ok(buzz.length >= 1);
  assert.ok(buzz.every((h) => !h.actionable), 'single use should not be actionable');
  assert.ok(r.score < 15, `score ${r.score}`);
});

test('clustered buzzwords become actionable', () => {
  const text = '我们要全面提升服务质量，持续优化业务流程，深入探讨合作模式，积极探索创新路径，稳步推进项目落地。';
  const r = detect(text);
  assert.ok(r.hits.some((h) => (h.clarity || h.weak) && h.actionable));
});

test('synonym rotation is detected', () => {
  const text = '新版本提升了稳定性，也增强了兼容性，同时改善了启动速度，还优化了内存占用。';
  assert.equal(synonymRotationHits(text, 'zh').length, 1);
  assert.equal(synonymRotationHits('新版本提升了稳定性，也提升了启动速度。', 'zh').length, 0);
});

test('CJK-latin spacing is flagged', () => {
  const r = detect('我们用 Excel 做了一个 3 列的表，然后导出成 PDF 给财务看，财务说格式还行，就是字太小了看不清楚。');
  assert.ok(r.hits.some((h) => h.id === 'zh.punct.cjk-space'));
});
