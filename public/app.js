// 前台：实时检测、问题标注、SSE 流式改写、修订对比与检查结果。所有用户文本都用 textContent 渲染。

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* 无痕模式 */ } },
};
const mobile = matchMedia('(max-width: 760px)');

const CAT = {
  filler: '套话', template: '模板句式', buzz: '空洞词', inflate: '拔高', hedge: '对冲/说教',
  assistant: '助手腔', structure: '排版痕迹', punct: '标点', rhythm: '节奏', metaphor: '修辞',
  nominal: '名词化', overdone: '改过头',
};

const SAMPLE = `在当今数字化转型的大背景下，我们团队于 2026 年 9 月完成了客服系统的升级。值得注意的是，这不仅仅是一次技术迭代，而是一场服务理念的深刻变革。

首先，新系统将平均响应时间从 45 秒缩短到 12 秒；其次，工单自动分派准确率提升至 93%；最后，客户满意度显著提升。**数据**在这一过程中扮演着至关重要的角色，充分彰显了智能化运营的巨大潜力。

总而言之，此次升级为公司的数字化发展注入了强大动力，开启了客户服务的新篇章！🚀`;

let meta = null;
let strength = 'medium';
let lastResult = null;
let lastDetect = null;
let running = false;
let startedAt = 0;
let me = null;

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

async function api(path, body) {
  const headers = { 'content-type': 'application/json' };
  const key = store.get('noai.key');
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    if (res.status === 401 && meta?.accessMode === 'key') showKeyBox(true);
    throw new Error(msg);
  }
  return res;
}

// ---------- 分数 ----------

function setScore(which, report) {
  for (const id of which === 'in' ? ['scoreIn', 'miniIn'] : ['scoreOut', 'miniOut']) {
    const b = $(id);
    b.textContent = report ? report.score : '–';
    if (report) b.dataset.level = report.level;
    else delete b.dataset.level;
  }
}

// ---------- 视图 ----------

function setView(v) {
  document.body.dataset.view = v;
  for (const b of $('mtabs').children) b.classList.toggle('on', b.dataset.view === v);
  if (v === 'out') $('outDot').classList.add('hidden');
}

function openSheet(open) {
  document.body.classList.toggle('sheet-open', open);
}

function showKeyBox(open) {
  const box = $('keyBox');
  box.classList.remove('hidden');
  box.classList.toggle('collapsed', !open);
  if (open) $('accessKey').focus();
}

function switchTabs(tabsId, views, v) {
  for (const b of $(tabsId).children) b.classList.toggle('on', b.dataset.v === v);
  for (const [key, id] of Object.entries(views)) $(id).classList.toggle('hidden', key !== v);
}

function syncThemeLabel() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  $('theme').textContent = dark ? '浅色' : '深色';
  return dark;
}

// ---------- 初始化 ----------

async function init() {
  syncThemeLabel();
  meta = await (await api('/api/meta')).json();
  for (const m of meta.modes) $('mode').append(el('option', { value: m.id, text: m.name }));
  $('mode').value = store.get('noai.mode') || meta.defaults.mode;
  strength = store.get('noai.strength') || meta.defaults.strength;
  for (const s of meta.strengths) {
    $('strength').append(el('button', { 'data-v': s.id, role: 'radio', title: s.desc, text: s.name, onclick: () => setStrength(s.id) }));
  }
  setStrength(strength);
  $('semantic').checked = !!meta.defaults.semanticCheck && meta.judge;
  $('semantic').disabled = !meta.judge;
  if (!meta.judge) $('semantic').parentElement.title = '后台没有配置核对用的模型';
  const meInfo = await fetch('/api/me').then((r) => r.json()).catch(() => ({ user: null }));
  me = meInfo.user;
  if (me) {
    $('userName').textContent = me.name;
    $('userBox').classList.remove('hidden');
    showQuota(meInfo.quota);
  } else if (meta.auth?.provider) {
    $('loginLink').href = loginHref();
    $('loginLink').classList.remove('hidden');
  }
  if (meta.accessMode === 'key' && !me) {
    $('accessKey').value = store.get('noai.key') || '';
    if (mobile.matches) { $('keyToggle').classList.remove('hidden'); showKeyBox(!store.get('noai.key')); }
    else showKeyBox(true);
  }
  // 模型：后台开放了几个就列几个，记住上次的选择
  if (meta.rewriters.length) {
    $('model').replaceChildren(...meta.rewriters.map((r) => el('option', { value: r, text: r })));
    const savedModel = store.get('noai.model');
    $('model').value = savedModel && meta.rewriters.includes(savedModel) ? savedModel : meta.rewriters[0];
    $('modelBox').classList.toggle('hidden', meta.rewriters.length < 2);
  }
  if (meta.efforts?.length) {
    $('effort').replaceChildren(...meta.efforts.map((e) => el('option', { value: e.id, text: e.name })));
    $('effort').value = store.get('noai.effort') ?? '';
    $('effortBox').classList.remove('hidden');
  }
  const saved = store.get('noai.draft');
  if (saved) { $('input').value = saved; onInput(); }
}

function setStrength(v) {
  strength = v;
  store.set('noai.strength', v);
  for (const b of $('strength').children) {
    b.classList.toggle('on', b.dataset.v === v);
    b.setAttribute('aria-checked', String(b.dataset.v === v));
  }
  $('strengthDesc').textContent = meta.strengths.find((s) => s.id === v)?.desc ?? '';
}

// ---------- 实时检测 ----------

let detectTimer = 0;
let detectSeq = 0;
function onInput() {
  const text = $('input').value;
  $('inCount').textContent = `${text.replace(/\s/g, '').length} 字`;
  store.set('noai.draft', text);
  clearTimeout(detectTimer);
  if (!text.trim()) { setScore('in', null); lastDetect = null; renderMarks(); return; }
  const seq = ++detectSeq;
  detectTimer = setTimeout(async () => {
    try {
      const r = await (await api('/api/detect', { text, lang: $('lang').value })).json();
      if (seq !== detectSeq) return;
      lastDetect = r;
      setScore('in', r);
      if (!$('marks').classList.contains('hidden')) renderMarks();
    } catch (e) {
      $('inCount').textContent = e.message;
    }
  }, 450);
}

function renderMarks() {
  const box = $('marks');
  box.replaceChildren();
  hidePop();
  const text = $('input').value;
  if (!lastDetect || !text.trim()) { box.append(el('span', { class: 'muted', text: '没有内容。' })); return; }
  // 需处理优先、严重优先、短的优先；跨句的结构类问题写进摘要
  const ranked = [...lastDetect.hits].sort((a, b) => (b.actionable - a.actionable) || b.severity - a.severity || (a.end - a.start) - (b.end - b.start));
  const chosen = [];
  const spans = [];
  for (const h of ranked) {
    if (h.end - h.start > 60) { spans.push(h); continue; }
    if (chosen.some((c) => h.start < c.end && c.start < h.end)) continue;
    chosen.push(h);
  }
  chosen.sort((a, b) => a.start - b.start);
  const need = lastDetect.hits.filter((h) => h.actionable).length;
  box.append(el('div', { class: 'marks-summary' },
    el('span', { text: `${need} 处要改` }),
    el('span', { text: `${lastDetect.hits.length - need} 处只是提醒（虚线）` }),
    [...new Set(spans.map((h) => h.label))].map((l) => el('span', { text: l })),
    lastDetect.breakdown.filter((b) => b.key.startsWith('stat.')).map((b) => el('span', { text: `${b.label} ${b.detail ?? ''}` }))));
  let pos = 0;
  for (const h of chosen) {
    box.append(text.slice(pos, h.start));
    const m = el('mark', { class: `m${h.actionable ? '' : ' soft'}`, tabindex: '0', text: text.slice(h.start, h.end) });
    m.addEventListener('click', (e) => { e.stopPropagation(); showPop(m, h); });
    m.addEventListener('keydown', (e) => { if (e.key === 'Enter') showPop(m, h); });
    box.append(m);
    pos = h.end;
  }
  box.append(text.slice(pos));
}

// ---------- 批注卡 ----------

function showPop(anchor, h) {
  const pop = $('pop');
  document.querySelectorAll('mark.m.active').forEach((x) => x.classList.remove('active'));
  anchor.classList.add('active');
  pop.replaceChildren(
    el('div', { class: 't', text: h.label }),
    el('p', { text: h.advice ?? '' }),
    el('div', { class: 'soft', text: `${CAT[h.category] ?? h.category}${h.actionable ? '' : ' · 只出现一次，可以不改'}` }),
  );
  pop.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const left = Math.min(Math.max(12, r.left + window.scrollX), window.scrollX + document.documentElement.clientWidth - pw - 12);
  pop.style.left = `${left}px`;
  pop.style.top = `${r.bottom + window.scrollY + 6}px`;
}

function hidePop() {
  $('pop').classList.add('hidden');
  document.querySelectorAll('mark.m.active').forEach((x) => x.classList.remove('active'));
}

// ---------- 改写 ----------

function collectOptions() {
  const lines = (id) => $(id).value.split('\n').map((s) => s.trim()).filter(Boolean);
  const samples = $('samples').value.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  return {
    mode: $('mode').value,
    strength,
    lang: $('lang').value,
    protect: lines('protect'),
    styleSamples: samples,
    instructions: $('instructions').value.trim() || undefined,
    keepStructure: $('keepStructure').checked || undefined,
    semanticCheck: $('semantic').checked,
    skipIfClean: !$('force').checked,
    model: $('model').value || undefined,
    effort: $('effort').value || undefined,
  };
}

const timeline = {
  reset() {
    $('timeline').replaceChildren();
    $('logPanel').classList.remove('idle', 'folded');
    $('fold').textContent = '收起';
  },
  add(state, title, problems = []) {
    const sec = ((Date.now() - startedAt) / 1000).toFixed(1);
    const li = el('li', {},
      el('span', { class: 't', text: `${sec}s` }),
      el('span', { class: `ic ${state}` }),
      el('div', {}, title, problems.length ? el('ul', { class: 'problems' }, problems.map((p) => el('li', { text: p }))) : null));
    $('timeline').append(li);
    li.scrollIntoView({ block: 'nearest' });
    return li;
  },
};

function setBusy(on) {
  running = on;
  $('run').disabled = on;
  $('runMobile').disabled = on;
  $('run').replaceChildren(...(on ? ['处理中…'] : ['去 AI 味 ', el('kbd', { text: 'Ctrl ↵' })]));
  $('runMobile').textContent = on ? '处理中…' : '去 AI 味';
}

function showQuota(q) {
  const box = $('quotaInfo');
  if (!q) { box.classList.add('hidden'); return; }
  box.textContent = q.remaining > 0 ? `拾间 AI 今日剩 ${q.remaining} 次` : `今日额度已用完${q.points > 0 ? `，剩 ${q.points} 点` : ''}`;
  box.title = `每 3000 字算 1 次；日额度 ${q.dailyQuota} 次，用完扣点数`;
  box.classList.remove('hidden');
}

async function refreshQuota() {
  if (!me) return;
  const r = await fetch('/api/me').then((x) => x.json()).catch(() => null);
  if (r) showQuota(r.quota);
}

function loginHref() {
  return `${meta?.auth?.loginUrl ?? '/auth/login'}?next=${encodeURIComponent(location.pathname)}`;
}

async function run() {
  const text = $('input').value.trim();
  if (!text || running) return;
  if (meta.accessMode === 'cpu' && !me) {
    // 草稿已经存在本地，登录回来还在
    location.href = loginHref();
    return;
  }
  openSheet(false);
  hidePop();
  setBusy(true);
  startedAt = Date.now();
  timeline.reset();
  if (mobile.matches) setView('log');
  const tick = setInterval(() => { $('elapsed').textContent = `${((Date.now() - startedAt) / 1000).toFixed(0)}s`; }, 500);
  let current = timeline.add('run', '提交');
  try {
    const res = await api('/api/rewrite?stream=1', { text, options: collectOptions() });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        if (data) current = handleEvent(JSON.parse(data), current);
      }
    }
  } catch (e) {
    current.querySelector('.ic').className = 'ic bad';
    timeline.add('bad', `失败：${e.message}`);
  } finally {
    clearInterval(tick);
    setBusy(false);
    refreshQuota();
  }
}

function handleEvent(e, current) {
  const finish = (ok = true) => current && (current.querySelector('.ic').className = `ic ${ok ? 'ok' : 'bad'}`);
  switch (e.type) {
    case 'stage':
      finish();
      return timeline.add('run', e.message);
    case 'detect':
      if (e.which === 'before') {
        setScore('in', e.report);
        finish();
        return timeline.add('ok', `原文 AI 味 ${e.report.score}，${e.report.hits.filter((h) => h.actionable).length} 处要改`);
      }
      setScore('out', e.report);
      return current;
    case 'ledger':
      timeline.add('ok', `记下 ${e.facts.filter((f) => f.strict).length} 处不能动的数字、名称和文件名`);
      return current;
    case 'cleanup':
      timeline.add('ok', `先删掉 ${e.changes} 处套话、加粗和 emoji`);
      return current;
    case 'candidate': {
      const c = e.candidate;
      const head = c.error
        ? `${c.binding} 调用失败`
        : `${c.binding}${c.round ? ` 第 ${c.round} 次返工` : ''}：AI 味 ${c.detect.score}，${c.passed ? '通过' : '没通过'}（${(c.latencyMs / 1000).toFixed(0)}s）`;
      timeline.add(c.passed ? 'ok' : 'bad', head, c.passed ? [] : c.problems);
      return current;
    }
    case 'error':
      finish(false);
      return timeline.add('bad', e.message);
    case 'done': {
      finish();
      showResult(e.result);
      const r = e.result;
      const line = timeline.add(r.passed ? 'ok' : 'bad', r.skipped ? '原文本来就不像 AI，只删了套话，没调用模型' : r.passed ? `完成 ${r.before.score} → ${r.after.score}` : '完成，但有检查没通过，见“检查”');
      // 顺利完成就把过程收起来，给正文腾地方；有问题则保持展开
      if (r.passed && !mobile.matches) { $('logPanel').classList.add('folded'); $('fold').textContent = '展开'; }
      return line;
    }
    default:
      return current;
  }
}

function showResult(r) {
  lastResult = r;
  const out = $('output');
  out.classList.remove('empty');
  out.replaceChildren();
  if (r.warnings.length) out.append(el('div', { class: 'notes' }, r.warnings.map((w) => el('div', { class: `notice ${r.passed ? 'warn' : 'bad'}`, text: w }))));
  out.append(r.output);
  setScore('out', r.after);
  $('copy').disabled = false;
  const changed = renderDiff(r.input, r.output);
  $('outMeta').textContent = `${r.output.replace(/\s/g, '').length} 字 · 改动 ${changed}% · ${(r.elapsedMs / 1000).toFixed(0)}s`;
  renderInfo(r);
  switchTabs('outTabs', { out: 'output', diff: 'diff', info: 'info' }, 'out');
  if (mobile.matches) setView('out');
  else $('outDot').classList.remove('hidden');
}

// ---------- 修订对比（Myers diff，中文按字、英文按词） ----------

function tokenize(s, lang) {
  return lang === 'zh' ? [...s] : s.match(/\s+|[A-Za-z0-9'’-]+|[^\sA-Za-z0-9]/g) ?? [];
}

function diffTokens(a, b) {
  const n = a.length, m = b.length, max = n + m, off = max + 1;
  if (max > 30000) return null;
  const v = new Int32Array(2 * max + 3);
  const trace = []; // trace[d] 保存第 d 轮开始前 k∈[-d-1, d+1] 的状态，内存约 D²
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
    if (d > 3000) return null;
  }
  return null;
}

function backtrack(trace, a, b, D) {
  let x = a.length, y = b.length;
  const ops = [];
  for (let d = D; d >= 0; d--) {
    const t = trace[d];
    const get = (k) => t[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const px = get(prevK), py = px - prevK;
    while (x > px && y > py) { ops.push(['=', a[x - 1]]); x--; y--; }
    if (d > 0) {
      if (x === px) ops.push(['+', b[y - 1]]);
      else ops.push(['-', a[x - 1]]);
    }
    x = px; y = py;
  }
  return ops.reverse();
}

/** 渲染修订对比，返回改动比例（删掉的原文非空白字符占比） */
function renderDiff(a, b) {
  const box = $('diff');
  box.replaceChildren();
  const lang = lastResult?.lang ?? 'zh';
  const ops = diffTokens(tokenize(a, lang), tokenize(b, lang));
  if (!ops) { box.textContent = '改动太大，没法逐字对比。'; return 100; }
  let cur = null, buf = '', removed = 0, total = 0;
  const flush = () => {
    if (!buf) return;
    box.append(cur === '=' ? buf : el(cur === '+' ? 'ins' : 'del', { text: buf }));
    buf = '';
  };
  for (const [op, t] of ops) {
    if (op !== '+' && t.trim()) { total += t.length; if (op === '-') removed += t.length; }
    if (op !== cur) { flush(); cur = op; }
    buf += t;
  }
  flush();
  return total ? Math.round((removed / total) * 100) : 0;
}

// ---------- 检查结果 ----------

const tableWrap = (...rows) => el('div', { class: 'table-wrap' }, el('table', { class: 'kv' }, ...rows));

function renderInfo(r) {
  const box = $('info');
  box.replaceChildren();
  const lower = r.output.toLowerCase();
  const strict = r.facts.filter((f) => f.strict);
  box.append(el('section', {},
    el('h3', { text: `不能动的内容（${strict.length}）` }),
    strict.length
      ? el('div', { class: 'chips' }, strict.map((f) => {
          const kept = f.kind === 'number' || f.kind === 'date' || lower.includes(f.norm);
          return el('span', { class: `chip${kept ? '' : ' miss'}`, title: kept ? '已保留' : '丢了', text: f.value });
        }))
      : el('div', { class: 'muted', text: '没有数字、专名或文件名需要锁定。' })));

  const brk = (rep) => new Map(rep.breakdown.map((b) => [b.label, b]));
  const bb = brk(r.before), ba = brk(r.after);
  const labels = [...new Set([...bb.keys(), ...ba.keys()])];
  const cell = (b) => (b ? `${b.points}　${b.detail ?? ''}` : '–');
  box.append(el('section', {},
    el('h3', { text: `AI 味从哪来　${r.before.score} → ${r.after.score}` }),
    tableWrap(
      el('tr', {}, el('th', { text: '' }), el('th', { text: '改前' }), el('th', { text: '改后' })),
      labels.map((l) => el('tr', {}, el('td', { text: l }), el('td', { class: 'mono', text: cell(bb.get(l)) }), el('td', { class: 'mono', text: cell(ba.get(l)) }))))));

  if (r.candidates.length) {
    box.append(el('section', {},
      el('h3', { text: '每一稿' }),
      tableWrap(
        el('tr', {}, ['模型', '', 'AI 味', '篇幅', '和原文相似', ''].map((h) => el('th', { text: h }))),
        r.candidates.map((c) => el('tr', {},
          el('td', { text: c.binding }),
          el('td', { text: c.round ? `返工 ${c.round}` : '初稿' }),
          el('td', { class: 'mono', text: c.error ? '–' : c.detect.score }),
          el('td', { class: 'mono', text: c.error ? '–' : `${Math.round(c.ledger.lengthRatio * 100)}%` }),
          el('td', { class: 'mono', text: c.copy ? c.copy.edit : '–' }),
          el('td', {}, el('span', { class: `pill ${c.passed ? 'good' : 'bad'}`, text: c.passed ? (c.id === r.chosen ? '用了这稿' : '通过') : c.error ? '出错' : '没通过' })))))));
    const edits = r.candidates.flatMap((c) => c.edits ?? []);
    if (edits.length) {
      box.append(el('section', {},
        el('h3', { text: '逐处修改' }),
        tableWrap(edits.map((e) => el('tr', {},
          el('td', {}, el('del', { text: e.find })),
          el('td', {}, e.replace ? el('ins', { text: e.replace }) : el('span', { class: 'muted', text: '删掉' })),
          el('td', { class: 'muted small', text: e.applied ? '' : `没用：${e.reason}` }))))));
    }
  }
  box.append(el('div', { class: 'muted small mono', text: `${(r.elapsedMs / 1000).toFixed(1)}s · 调用 ${r.usage.calls} 次 · tokens ${r.usage.inputTokens}/${r.usage.outputTokens}${r.chunks > 1 ? ` · 分 ${r.chunks} 段处理` : ''}` }));
}

// ---------- 事件 ----------

$('input').addEventListener('input', onInput);
$('lang').addEventListener('change', onInput);
$('mode').addEventListener('change', () => store.set('noai.mode', $('mode').value));
$('model').addEventListener('change', () => store.set('noai.model', $('model').value));
$('effort').addEventListener('change', () => store.set('noai.effort', $('effort').value));
$('run').addEventListener('click', run);
$('runMobile').addEventListener('click', run);
$('toggleAdv').addEventListener('click', (e) => {
  e.stopPropagation();
  const hidden = $('adv').classList.toggle('hidden');
  $('toggleAdv').setAttribute('aria-expanded', String(!hidden));
});
$('adv').addEventListener('click', (e) => e.stopPropagation());
$('saveKey').addEventListener('click', () => {
  store.set('noai.key', $('accessKey').value.trim() || null);
  if (mobile.matches) showKeyBox(false);
  onInput();
});
$('keyToggle').addEventListener('click', () => showKeyBox($('keyBox').classList.contains('collapsed')));
$('theme').addEventListener('click', () => {
  const next = syncThemeLabel() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('noai.theme', next);
  syncThemeLabel();
});
$('sample').addEventListener('click', () => {
  $('input').value = SAMPLE;
  switchTabs('inTabs', { edit: 'input', marks: 'marks' }, 'edit');
  onInput();
});
$('fold').addEventListener('click', () => {
  const folded = $('logPanel').classList.toggle('folded');
  $('fold').textContent = folded ? '展开' : '收起';
});
for (const b of $('mtabs').children) b.addEventListener('click', () => setView(b.dataset.view));
for (const b of $('inTabs').children) b.addEventListener('click', () => {
  switchTabs('inTabs', { edit: 'input', marks: 'marks' }, b.dataset.v);
  if (b.dataset.v === 'marks') renderMarks();
  else hidePop();
});
for (const b of $('outTabs').children) b.addEventListener('click', () => switchTabs('outTabs', { out: 'output', diff: 'diff', info: 'info' }, b.dataset.v));
$('logoutBtn').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});
$('copy').addEventListener('click', async () => {
  if (!lastResult) return;
  try { await navigator.clipboard.writeText(lastResult.output); $('copy').textContent = '已复制'; } catch { $('copy').textContent = '复制失败'; }
  setTimeout(() => { $('copy').textContent = '复制'; }, 1500);
});
$('openSheet').addEventListener('click', () => openSheet(true));
$('sheetDone').addEventListener('click', () => openSheet(false));
$('sheetClose').addEventListener('click', () => openSheet(false));
$('scrim').addEventListener('click', () => openSheet(false));
document.addEventListener('click', (e) => {
  if (!$('pop').contains(e.target)) hidePop();
  if (!mobile.matches && !$('adv').classList.contains('hidden') && !$('controls').contains(e.target)) {
    $('adv').classList.add('hidden');
    $('toggleAdv').setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run();
  if (e.key === 'Escape') { hidePop(); openSheet(false); $('adv').classList.add('hidden'); }
});
window.addEventListener('resize', hidePop);

const loginError = new URLSearchParams(location.search).get('login_error');
if (loginError) {
  $('output').classList.remove('empty');
  $('output').replaceChildren(el('div', { class: 'notice bad', text: loginError }));
  history.replaceState(null, '', location.pathname);
}

init().catch((e) => {
  $('output').classList.remove('empty');
  $('output').replaceChildren(el('div', { class: 'notice bad', text: `加载失败：${e.message}` }));
});
