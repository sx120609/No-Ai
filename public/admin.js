// 管理后台：供应商/模型绑定、访问密钥、用量。

const $ = (id) => document.getElementById(id);
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const MASK = '••••••••';

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'value') n.value = v ?? '';
    else if (k === 'checked') n.checked = !!v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

async function api(path, method = 'GET', body) {
  const token = ls.get('noai.admin');
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) { showLogin(data.error); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let state = null; // { providers, rewriters, judge, defaults }
let presets = [];

function showLogin(msg) {
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('logout').classList.add('hidden');
  $('nav').classList.add('hidden');
  if (msg && ls.get('noai.admin')) { $('loginErr').textContent = msg; $('loginErr').classList.remove('hidden'); }
}

async function boot() {
  fetch('/api/meta').then((r) => r.json()).then((m) => { if (m.auth?.provider) $('ssoLogin').classList.remove('hidden'); }).catch(() => {});
  // 没存令牌时也先试一下：药大拾间管理员登录后靠会话 cookie 就能进
  let data;
  try {
    data = await api('/settings');
  } catch {
    return showLogin();
  }
  state = structuredClone(data.settings);
  presets = data.presets;
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('logout').classList.remove('hidden');
  $('nav').classList.remove('hidden');
  $('preset').replaceChildren(...presets.map((p, i) => el('option', { value: i, text: p.name })));
  const meta = await fetch('/api/meta').then((r) => r.json());
  $('dMode').replaceChildren(...meta.modes.map((m) => el('option', { value: m.id, text: m.name })));
  renderAll();
}

// ---------- 模型配置 ----------

function renderAll() {
  renderProviders();
  renderBindings();
  $('dMode').value = state.defaults.mode;
  $('dStrength').value = state.defaults.strength;
  $('dRounds').value = state.defaults.maxRepairRounds;
  $('dSemantic').checked = state.defaults.semanticCheck;
}

function renderProviders() {
  const box = $('providers');
  box.replaceChildren();
  if (!state.providers.length) box.append(el('div', { class: 'muted', text: '还没有供应商，从右上角选择预设添加。' }));
  state.providers.forEach((p, i) => {
    const bind = (key, transform = (v) => v) => (e) => { p[key] = transform(e.target.type === 'checkbox' ? e.target.checked : e.target.value); if (key === 'id' || key === 'models') renderBindings(); };
    const status = { 'none-needed': ['good', '无需密钥'], stored: ['good', '已保存密钥'], missing: ['bad', '缺少密钥'] }[p.keyStatus] ?? (p.keyStatus?.startsWith('env:') ? ['good', `读取 ${p.keyStatus.slice(4)}`] : ['', '未保存']);
    const testModel = el('input', { type: 'text', placeholder: '测试用模型名', value: p.models?.[0] ?? '', list: `models-${i}` });
    const testOut = el('span', { class: 'small muted' });
    box.append(el('div', { class: 'prov' },
      el('label', {}, 'ID', el('input', { type: 'text', value: p.id, oninput: bind('id') })),
      el('label', {}, '名称', el('input', { type: 'text', value: p.name ?? '', oninput: bind('name') })),
      el('label', {}, '类型', el('select', { onchange: bind('type') }, ['openai', 'anthropic', 'gemini', 'mock'].map((t) => el('option', { value: t, text: { openai: 'OpenAI 兼容', anthropic: 'Anthropic', gemini: 'Gemini 原生', mock: '离线演示' }[t], selected: p.type === t ? '' : null })))),
      el('label', {}, '启用', el('input', { type: 'checkbox', checked: p.enabled !== false, onchange: bind('enabled') })),
      el('label', { class: 'wide' }, 'Base URL', el('input', { type: 'text', value: p.baseUrl ?? '', placeholder: p.type === 'openai' ? 'https://…/v1' : '留空使用官方地址', oninput: bind('baseUrl') })),
      el('label', {}, 'API Key', el('input', { type: 'password', value: p.apiKey ?? '', placeholder: '直接填写（只存在服务端）', autocomplete: 'off', oninput: bind('apiKey') })),
      el('label', {}, '或读取环境变量', el('input', { type: 'text', value: p.apiKeyEnv ?? '', placeholder: 'XXX_API_KEY', oninput: bind('apiKeyEnv') })),
      el('label', { class: 'wide' }, '模型列表（逗号分隔，供下拉提示）', el('input', { type: 'text', value: (p.models ?? []).join(', '), oninput: bind('models', (v) => v.split(/[,，\s]+/).filter(Boolean)) })),
      el('label', {}, '超时（毫秒）', el('input', { type: 'number', value: p.timeoutMs ?? '', placeholder: '默认 180000', oninput: bind('timeoutMs', (v) => (v ? Number(v) : undefined)) })),
      el('label', {}, '状态', el('span', { class: `pill ${status[0]}`, text: status[1] })),
      el('div', { class: 'actions' },
        testModel,
        el('datalist', { id: `models-${i}` }, (p.models ?? []).map((m) => el('option', { value: m }))),
        el('button', { class: 'btn small', text: '测试连通', onclick: async () => {
          testOut.textContent = '测试中…（需先保存配置）';
          try {
            const r = await api('/test', 'POST', { provider: p.id, model: testModel.value });
            testOut.textContent = r.ok ? `✓ ${r.latencyMs}ms：${r.reply}` : `✗ ${r.error}`;
            testOut.className = `small ${r.ok ? 'lv-low' : 'lv-high'}`;
          } catch (e) { testOut.textContent = e.message; }
        } }),
        testOut,
        el('span', { style: 'flex:1' }),
        el('button', { class: 'btn small danger', text: '删除', onclick: () => { state.providers.splice(i, 1); renderAll(); } }),
      )));
  });
}

function bindingRow(b, onRemove) {
  const prov = state.providers.find((p) => p.id === b.provider);
  const listId = `bl-${Math.random().toString(36).slice(2)}`;
  return el('div', { class: 'bind' },
    el('label', {}, '供应商', el('select', { onchange: (e) => { b.provider = e.target.value; renderBindings(); } },
      state.providers.map((p) => el('option', { value: p.id, text: p.name || p.id, selected: p.id === b.provider ? '' : null })))),
    el('label', {}, '模型', el('input', { type: 'text', value: b.model ?? '', list: listId, oninput: (e) => { b.model = e.target.value; } }),
      el('datalist', { id: listId }, (prov?.models ?? []).map((m) => el('option', { value: m })))),
    el('label', {}, '显示名（可选）', el('input', { type: 'text', value: b.label ?? '', oninput: (e) => { b.label = e.target.value || undefined; } })),
    el('label', {}, '推理强度', el('input', { type: 'text', value: b.effort ?? '', list: 'effortList', placeholder: '默认', oninput: (e) => { b.effort = e.target.value || undefined; } })),
    el('label', {}, '温度', el('input', { type: 'number', step: '0.05', min: '0', max: '2', value: b.temperature ?? '', placeholder: '默认', title: '部分模型（如新版 Claude）不支持，留空即可', oninput: (e) => { b.temperature = e.target.value === '' ? undefined : Number(e.target.value); } })),
    onRemove ? el('button', { class: 'btn small danger', text: '移除', onclick: onRemove }) : el('span'),
  );
}

function renderBindings() {
  const rw = $('rewriters');
  rw.replaceChildren(...state.rewriters.map((b, i) => bindingRow(b, () => { state.rewriters.splice(i, 1); renderBindings(); })));
  if (!state.rewriters.length) rw.append(el('div', { class: 'notice warn', text: '至少需要一个改写模型' }));
  $('judgeOn').checked = !!state.judge;
  const j = $('judge');
  j.replaceChildren(state.judge ? bindingRow(state.judge) : el('div', { class: 'muted small', text: '未启用' }));
}

$('addProv').addEventListener('click', () => {
  const p = presets[Number($('preset').value)];
  let id = (p.name.match(/[A-Za-z]+/)?.[0] ?? p.type).toLowerCase();
  while (state.providers.some((x) => x.id === id)) id += '2';
  state.providers.push({ id, name: p.name, type: p.type, baseUrl: p.baseUrl || undefined, models: p.models, enabled: true, apiKey: '' });
  renderAll();
});
$('addRw').addEventListener('click', () => {
  if (state.rewriters.length >= 4) return;
  const p = state.providers[0];
  state.rewriters.push({ provider: p?.id ?? '', model: p?.models?.[0] ?? '' });
  renderBindings();
});
$('judgeOn').addEventListener('change', (e) => {
  const p = state.providers[0];
  state.judge = e.target.checked ? { provider: p?.id ?? '', model: p?.models?.[0] ?? '' } : null;
  renderBindings();
});

$('save').addEventListener('click', async () => {
  state.defaults = {
    mode: $('dMode').value,
    strength: $('dStrength').value,
    maxRepairRounds: Number($('dRounds').value) || 0,
    semanticCheck: $('dSemantic').checked,
  };
  const msg = $('saveMsg');
  msg.textContent = '保存中…';
  msg.className = 'small muted';
  try {
    const payload = structuredClone(state);
    for (const p of payload.providers) { delete p.keyStatus; if (p.apiKey === '') delete p.apiKey; }
    const data = await api('/settings', 'PUT', payload);
    state = structuredClone(data.settings);
    renderAll();
    msg.textContent = '已保存';
    msg.className = 'small lv-low';
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'small lv-high';
  }
});

// ---------- 访问密钥 ----------

async function loadKeys() {
  const { keys } = await api('/keys');
  const t = $('keys');
  t.replaceChildren(el('tr', {}, ['名称', '前缀', '创建时间', '今日已用 / 上限', '状态', ''].map((h) => el('th', { text: h }))));
  for (const k of keys) {
    t.append(el('tr', {},
      el('td', { text: k.name }),
      el('td', {}, el('code', { class: 'k', text: `${k.prefix}…` })),
      el('td', { text: new Date(k.created_at).toLocaleString() }),
      el('td', { text: `${k.used_today} / ${k.daily_chars || '不限'}` }),
      el('td', {}, el('span', { class: `pill ${k.disabled ? 'bad' : 'good'}`, text: k.disabled ? '停用' : '正常' })),
      el('td', {},
        el('button', { class: 'btn small', text: k.disabled ? '启用' : '停用', onclick: async () => { await api(`/keys/${k.id}`, 'PATCH', { disabled: !k.disabled }); loadKeys(); } }),
        ' ',
        el('button', { class: 'btn small danger', text: '删除', onclick: async () => { if (confirm(`删除密钥「${k.name}」？使用它的客户端将立即失效。`)) { await api(`/keys/${k.id}`, 'DELETE'); loadKeys(); } } }))));
  }
  if (!keys.length) t.append(el('tr', {}, el('td', { colspan: 6, class: 'muted', text: '暂无' })));
}

$('kCreate').addEventListener('click', async () => {
  const r = await api('/keys', 'POST', { name: $('kName').value, dailyChars: Number($('kDaily').value) || 0 });
  const box = $('kNew');
  box.classList.remove('hidden');
  box.replaceChildren(el('div', { class: 'notice good' }, '新密钥（只显示这一次，请立即复制保存）：', el('br'), el('code', { class: 'k', text: r.key })));
  $('kName').value = '';
  loadKeys();
});

// ---------- 用户 ----------

async function loadUsers() {
  const { users, defaultDailyChars } = await api('/users');
  $('usersNote').textContent = `用药大拾间账号登录。每日额度留空或 0 时用默认值（${defaultDailyChars || '不限'} 字）`;
  const t = $('users');
  t.replaceChildren(el('tr', {}, ['用户', '身份', '最近登录', '今日已用', '每日额度', '状态', ''].map((h) => el('th', { text: h }))));
  for (const u of users) {
    const quota = el('input', { type: 'number', min: '0', value: u.daily_chars || '', placeholder: '默认', style: 'width:90px' });
    t.append(el('tr', {},
      el('td', { text: u.name, title: u.id }),
      el('td', { text: u.role === 'admin' ? '管理员' : '用户' }),
      el('td', { text: new Date(u.last_login).toLocaleString() }),
      el('td', { class: 'mono', text: u.used_today }),
      el('td', {}, quota, ' ', el('button', { class: 'btn small', text: '保存', onclick: async () => { await api(`/users/${encodeURIComponent(u.id)}`, 'PATCH', { dailyChars: Number(quota.value) || 0 }); loadUsers(); } })),
      el('td', {}, el('span', { class: `pill ${u.disabled ? 'bad' : 'good'}`, text: u.disabled ? '停用' : '正常' })),
      el('td', {}, el('button', { class: 'btn small', text: u.disabled ? '启用' : '停用', onclick: async () => { await api(`/users/${encodeURIComponent(u.id)}`, 'PATCH', { disabled: !u.disabled }); loadUsers(); } }))));
  }
  if (!users.length) t.append(el('tr', {}, el('td', { colspan: 7, class: 'muted', text: '还没有人登录过' })));
}

// ---------- 用量 ----------

async function loadUsage() {
  const [{ days, running, queued }, { jobs }] = await Promise.all([api('/usage?days=14'), api('/jobs?limit=50')]);
  $('live').textContent = `进行中 ${running} · 排队 ${queued}`;
  const max = Math.max(1, ...days.map((d) => d.chars || 0));
  $('bars').replaceChildren(...days.map((d) => el('div', { class: 'row' },
    el('span', { class: 'muted', text: d.day }),
    el('span', { class: 'track' }, el('i', { style: `width:${((d.chars || 0) / max) * 100}%` })),
    el('span', { text: `${d.chars || 0} 字 · ${d.jobs} 次` }))));
  if (!days.length) $('bars').replaceChildren(el('div', { class: 'muted', text: '暂无数据' }));
  const t = $('usage');
  t.replaceChildren(el('tr', {}, ['日期', '任务', '通过', '失败', '模型调用', 'tokens 入/出', '平均 AI 味 前→后'].map((h) => el('th', { text: h }))),
    days.map((d) => el('tr', {},
      el('td', { text: d.day }), el('td', { text: d.jobs }), el('td', { text: d.passed }), el('td', { text: d.errors }),
      el('td', { text: d.calls }), el('td', { text: `${d.input_tokens}/${d.output_tokens}` }),
      el('td', { text: d.avg_before === null ? '–' : `${Math.round(d.avg_before)} → ${Math.round(d.avg_after ?? 0)}` }))));
  const j = $('jobs');
  j.replaceChildren(el('tr', {}, ['时间', '类型', '字数', 'AI 味', '结果', '用时', '来源'].map((h) => el('th', { text: h }))),
    jobs.map((x) => el('tr', {},
      el('td', { text: new Date(x.created_at).toLocaleString() }),
      el('td', { text: x.kind }),
      el('td', { text: x.input_chars }),
      el('td', { text: x.before_score === null ? '–' : `${x.before_score} → ${x.after_score}` }),
      el('td', {}, el('span', { class: `pill ${x.status === 'error' ? 'bad' : x.passed ? 'good' : 'warn'}`, text: x.status === 'error' ? `失败` : x.passed ? '通过' : '部分通过', title: x.error ?? '' })),
      el('td', { text: `${(x.elapsed_ms / 1000).toFixed(1)}s` }),
      el('td', { class: 'muted', text: x.key_id ? `密钥 ${x.key_id}` : x.ip ?? '' }))));
}

// ---------- 导航 ----------

for (const b of $('nav').children) b.addEventListener('click', () => {
  for (const x of $('nav').children) x.classList.toggle('on', x === b);
  for (const v of ['models', 'users', 'keys', 'usage']) $(`v-${v}`).classList.toggle('hidden', v !== b.dataset.v);
  if (b.dataset.v === 'users') loadUsers();
  if (b.dataset.v === 'keys') loadKeys();
  if (b.dataset.v === 'usage') loadUsage();
});
$('refresh').addEventListener('click', loadUsage);
const isDark = () => {
  const root = document.documentElement;
  return root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};
const themeLabel = () => { $('theme').textContent = isDark() ? '浅色' : '深色'; };
themeLabel();
$('theme').addEventListener('click', () => {
  document.documentElement.dataset.theme = isDark() ? 'light' : 'dark';
  ls.set('noai.theme', document.documentElement.dataset.theme);
  themeLabel();
});
$('doLogin').addEventListener('click', async () => {
  ls.set('noai.admin', $('token').value.trim());
  $('loginErr').classList.add('hidden');
  try { await boot(); } catch { /* showLogin 已处理 */ }
});
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('doLogin').click(); });
$('logout').addEventListener('click', async () => {
  ls.set('noai.admin', null);
  await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

boot().catch(() => {});
