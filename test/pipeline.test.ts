import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleCleanup } from '../src/pipeline/cleanup.ts';
import { applyEdits, chunk, runPipeline, type PipelineDeps } from '../src/pipeline/index.ts';
import { checkFacts, cnToNumber, extractFacts } from '../src/pipeline/ledger.ts';
import { compare } from '../src/pipeline/similarity.ts';
import { distillStyle } from '../src/pipeline/style.ts';
import { parseRewritten } from '../src/pipeline/prompts.ts';
import { createClient } from '../src/providers/index.ts';
import type { ChatRequest, LLMClient, PipelineEvent } from '../src/types.ts';
import { AI_ZH, HUMAN_ZH } from './fixtures.ts';

test('cleanup removes empty framing but never swaps vocabulary', () => {
  const r = ruleCleanup(AI_ZH);
  assert.ok(!r.text.includes('值得注意的是'));
  assert.ok(!r.text.includes('**'));
  assert.ok(!r.text.includes('🚀'));
  assert.ok(!r.text.includes('希望以上内容'));
  assert.ok(r.text.includes('AI能够'), 'CJK-latin space removed');
  // 词表类不做自动替换
  assert.ok(r.text.includes('显著提升'));
  assert.ok(r.text.includes('优化资源配置'));
});

test('cn numerals', () => {
  assert.equal(cnToNumber('三十五'), 35);
  assert.equal(cnToNumber('两千零五'), 2005);
  assert.equal(cnToNumber('十'), 10);
  assert.equal(cnToNumber('一万二千'), 12000);
});

test('ledger catches dropped numbers, invented numbers and dropped latin tokens', () => {
  const src = '设备通过 MQTT 接入，共 128 台，证书在 2026年7月17日 到期，详见 device_list.xlsx。';
  const facts = extractFacts(src, 'zh');
  const good = checkFacts(src, '共128台设备走MQTT接入，证书2026年7月17日到期，清单见device_list.xlsx。', facts, { lang: 'zh' });
  assert.ok(good.ok, good.problems.join(';'));
  const bad = checkFacts(src, '设备走 MQTT 接入，共 120 台，证书 2026年7月17日 到期，清单见附件。', facts, { lang: 'zh' });
  assert.ok(!bad.ok);
  assert.ok(bad.missing.some((f) => f.value === '128'));
  assert.ok(bad.missing.some((f) => f.value === 'device_list.xlsx'));
  assert.ok(bad.added.some((a) => a.value === '120'));
});

test('ledger accepts Chinese numerals for source digits and flags weakened hedges', () => {
  const src = '可能有3台设备证书过期，疑似是批量导入时出错，初步判断需要重签。';
  const facts = extractFacts(src, 'zh');
  const out = checkFacts(src, '三台设备证书过期，是批量导入时出错，需要重签。', facts, { lang: 'zh', minRatio: 0.5 });
  assert.equal(out.missing.length, 0);
  assert.ok(out.problems.some((p) => p.includes('事实强度')));
});

test('similarity flags near-copies', () => {
  const a = '证书指纹核对是进入轮换的第一道条件，指纹与台账对不上的设备直接排除在本批之外。';
  assert.ok(compare(a, a).edit === 1);
  assert.ok(compare(a, '先核对证书指纹，跟台账对不上的设备这批不动。').edit < 0.6);
});

test('span edits are applied only when safe', () => {
  const src = '值得注意的是，共有128台设备。这不仅仅是技术问题，而是管理问题。';
  const facts = extractFacts(src, 'zh');
  const raw = JSON.stringify({
    edits: [
      { find: '值得注意的是，', replace: '', rule: 'notably' },
      { find: '共有128台设备', replace: '共有一批设备', rule: 'bad' },
      { find: '这不仅仅是技术问题，而是管理问题', replace: '问题出在管理上，有200个', rule: 'adds number' },
      { find: '不存在的片段', replace: 'x' },
    ],
  });
  const r = applyEdits(src, raw, facts, 'zh');
  assert.equal(r.text, '共有128台设备。这不仅仅是技术问题，而是管理问题。');
  assert.deepEqual(r.edits.map((e) => e.applied), [true, false, false, false]);
});

test('chunking keeps all text', () => {
  const para = '这是一句话。'.repeat(50);
  const text = [para, para, para].join('\n\n');
  const parts = chunk(text, 400);
  assert.ok(parts.length > 1);
  assert.equal(parts.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
});

test('parseRewritten handles tags, truncation and bare output', () => {
  assert.equal(parseRewritten('blah <rewritten>\n正文\n</rewritten> tail'), '正文');
  assert.equal(parseRewritten('<rewritten>\n截断的正文'), '截断的正文');
  assert.equal(parseRewritten('正文'), '正文');
});

test('style card never contains sample sentences', () => {
  const samples = [HUMAN_ZH, '周五下午系统又卡了一次，查了日志是定时任务和备份撞车，挪到凌晨三点以后就没再出现，先观察一周再说。'];
  const card = distillStyle(samples, 'zh')!;
  const dump = JSON.stringify(card);
  assert.ok(!dump.includes('报销'));
  assert.ok(!dump.includes('定时任务'));
  assert.ok(card.meanSentenceLen > 0);
});

const mockDeps: PipelineDeps = {
  client: (id) => createClient({ id, type: 'mock' }),
  rewriters: [{ provider: 'mock', model: 'rules' }],
  judge: { provider: 'mock', model: 'rules' },
};

test('pipeline skips text that is already natural', async () => {
  const r = await runPipeline(HUMAN_ZH, {}, mockDeps);
  assert.ok(r.skipped);
  assert.equal(r.usage.calls, 0);
});

test('pipeline runs end to end with mock provider and emits events', async () => {
  const events: PipelineEvent['type'][] = [];
  const r = await runPipeline(AI_ZH, { strength: 'medium', semanticCheck: true }, mockDeps, (e) => events.push(e.type));
  assert.ok(r.after.score < r.before.score, `${r.before.score} -> ${r.after.score}`);
  assert.ok(r.candidates.length >= 1);
  assert.ok(events.includes('candidate') && events.at(-1) === 'done');
  assert.ok(r.output.includes('AI'));
});

test('pipeline repairs a candidate that dropped a fact', async () => {
  let calls = 0;
  const flaky: LLMClient = {
    provider: { id: 'flaky', type: 'mock' },
    async chat(req: ChatRequest) {
      calls++;
      const src = req.messages.at(-1)!.content.match(/<source_text>\n([\s\S]*?)\n<\/source_text>/)?.[1] ?? '';
      // 第一次故意丢掉数字，修复轮返回正确版本
      const text = calls === 1 ? '设备证书快到期了，得分批换。' : '128台设备的证书7月到期，要分批轮换，难点在管理上怎么排批次，技术上倒不复杂。';
      void src;
      return { text: `<rewritten>\n${text}\n</rewritten>`, model: 'x', latencyMs: 1 };
    },
  };
  const src = '值得注意的是，128台设备的证书将于7月到期。综上所述，我们需要分批进行证书轮换，这不仅仅是技术问题，而是管理问题。';
  const r = await runPipeline(src, { strength: 'medium', skipIfClean: false }, {
    client: () => flaky, rewriters: [{ provider: 'flaky', model: 'x' }],
  });
  assert.equal(calls, 2);
  assert.ok(r.output.includes('128'));
  assert.ok(r.candidates[0]!.problems.some((p) => p.includes('128')));
});

test('choosing 重写 still calls the model on clean text', async () => {
  const r = await runPipeline(HUMAN_ZH, { strength: 'deep' }, mockDeps);
  assert.equal(r.skipped, false);
  assert.ok(r.usage.calls >= 1);
});
