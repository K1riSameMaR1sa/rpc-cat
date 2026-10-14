/**
 * views/ai.js — DeepSeek-powered translation panel.
 *
 * Translates sentence by sentence rather than whole-document-at-once: each
 * sentence gets its own glossary terms and memory hits injected, which is what
 * makes the output follow the established terminology instead of inventing a
 * plausible alternative. It also means a bad sentence can be retried without
 * paying for the whole document again.
 */

import * as db from '../db.js';
import {
  streamChat, cleanTranslation, buildMessages, MODELS, DEFAULT_BASE_URL,
  estimateBatch,
} from '../ai.js';
import { detectLang } from '../segment.js';
import { parseDocument, flattenSentences, KIND } from '../document.js';
import {
  h, mount, toast, modal, downloadText, pickFile, readText, fmtNum, debounce,
} from '../ui.js';

/* ------------------------------------------------------------- view state */

const st = {
  key: '',
  model: 'deepseek-chat',
  baseUrl: DEFAULT_BASE_URL,
  temperature: 1,
  extra: '',
  useTerms: true,
  useMemory: true,
  useContext: true,
  source: '',
  sentences: [],      // { src, out, state: 'idle'|'running'|'done'|'error', terms, matches, error }
  running: false,
  abort: null,
  contextPreview: null,
};

let listEl = null;
let configEl = null;
let progressEl = null;

/* ------------------------------------------------------------------ load */

export async function loadAiSettings() {
  const saved = await db.getSetting('ai', null);
  if (saved && typeof saved === 'object') {
    st.key = saved.key || '';
    st.model = saved.model || 'deepseek-chat';
    st.baseUrl = saved.baseUrl || DEFAULT_BASE_URL;
    st.temperature = typeof saved.temperature === 'number' ? saved.temperature : 1;
    st.extra = saved.extra || '';
    st.useTerms = saved.useTerms !== false;
    st.useMemory = saved.useMemory !== false;
    st.useContext = saved.useContext !== false;
  }
}

async function saveAiSettings() {
  await db.setSetting('ai', {
    key: st.key, model: st.model, baseUrl: st.baseUrl,
    temperature: st.temperature, extra: st.extra,
    useTerms: st.useTerms, useMemory: st.useMemory, useContext: st.useContext,
  });
}

/* ------------------------------------------------------------------ render */

export function render(ctx) {
  const wrap = h('div');
  wrap.append(h('h1', 'AI 翻译'));
  wrap.append(h('p.sub',
    '接入 DeepSeek，按「临床腔」译成管理局档案体。每句话都会自动带上命中的术语与记忆库参考。'));

  configEl = h('div');
  renderConfig(ctx);
  wrap.append(configEl);

  wrap.append(renderInput(ctx));
  return wrap;
}

function renderConfig(ctx) {
  if (!configEl) return;
  const configured = !!st.key;

  const keyInput = h('input', {
    type: 'password', value: st.key, placeholder: 'sk-…（只保存在本机浏览器）',
    autocomplete: 'off',
  });
  keyInput.addEventListener('input', () => { st.key = keyInput.value.trim(); });

  const modelSel = h('select', { style: { width: 'auto' } },
    ...MODELS.map((m) => h('option', { value: m, selected: st.model === m }, m)));
  modelSel.addEventListener('change', () => { st.model = modelSel.value; });

  const tempInput = h('input', {
    type: 'number', min: '0', max: '2', step: '0.1', value: String(st.temperature),
    style: { width: '80px' },
  });
  tempInput.addEventListener('input', () => {
    const v = Number(tempInput.value);
    if (Number.isFinite(v)) st.temperature = Math.max(0, Math.min(2, v));
  });

  const baseInput = h('input', { type: 'text', value: st.baseUrl, style: { maxWidth: '260px' } });
  baseInput.addEventListener('input', () => { st.baseUrl = baseInput.value.trim() || DEFAULT_BASE_URL; });

  const save = h('button.btn.primary', {
    onclick: async () => {
      await saveAiSettings();
      toast(configured ? '已保存设置' : 'API Key 已保存到本机浏览器', 'ok');
      // re-render so the workbench's AI button and the source panel pick up
      // the new configuration
      ctx.refresh();
    },
  }, '保存');

  const body = h('div',
    h('div.row',
      h('div.grow', h('label.tiny.dim', 'API Key'), keyInput),
      h('div', h('label.tiny.dim', '模型'),
        h('div', modelSel)),
      h('div', h('label.tiny.dim', '温度'), h('div', tempInput)),
    ),
    h('div.row', { style: { marginTop: '9px' } },
      h('div', h('label.tiny.dim', '接口地址'), h('div', baseInput)),
      h('span.grow'),
      save,
      h('button.btn', {
        onclick: async () => {
          st.key = ''; st.baseUrl = DEFAULT_BASE_URL; st.model = 'deepseek-chat';
          st.temperature = 1; st.extra = '';
          await saveAiSettings();
          toast('已清除本机保存的设置', 'ok');
          ctx.refresh();
        },
      }, '清除'),
    ),
    h('p.tiny.mute', { style: { marginTop: '9px' } },
      'Key 只存在这个浏览器的 IndexedDB 里，不会上传到任何第三方，也不会进入仓库。'
      + '但它对本机其他使用者是可见的——共用电脑上别存。'
      + '请求由浏览器直连 api.deepseek.com。'),
  );

  const bodyWrap = h('div', { hidden: configured }, body);

  mount(configEl, h('div.card',
    h('div.row',
      h('h3', { style: { margin: 0 } }, 'DeepSeek 设置'),
      configured ? h('span.pill.ok', '已配置') : h('span.pill.new', '未配置'),
      h('span.grow'),
      h('button.btn.sm', {
        onclick: (e) => {
          bodyWrap.hidden = !bodyWrap.hidden;
          e.target.textContent = bodyWrap.hidden ? '展开设置' : '收起设置';
        },
      }, configured ? '展开设置' : '收起设置'),
    ),
    bodyWrap,
  ));
}

/* --------------------------------------------------------------- input UI */

function renderInput(ctx) {
  const wrap = h('div');
  wrap.append(renderOptions(ctx));
  wrap.append(renderSource(ctx));
  return wrap;
}

let optionsEl = null;
let sourceEl = null;

function renderOptions(ctx) {
  optionsEl = h('div');
  mountOptions(ctx);
  return optionsEl;
}

function mountOptions(ctx) {
  if (!optionsEl) return;
  const check = (label, get, set, hint) => {
    const box = h('input', {
      type: 'checkbox', checked: get(), style: { width: 'auto' },
      onchange: () => { set(box.checked); saveAiSettings(); },
    });
    return h('label.row', { style: { marginRight: '14px' } }, box,
      h('span', label, hint ? h('span.tiny.mute', ` ${hint}`) : null));
  };

  const extraInput = h('textarea', {
    rows: 2, value: st.extra,
    placeholder: '附加要求（可选），例如：本句是访谈对白，口语一点；或：保留「博士」这一称谓',
  });
  const save = debounce(() => { st.extra = extraInput.value; saveAiSettings(); }, 400);
  extraInput.addEventListener('input', save);

  mount(optionsEl, h('div.card',
    h('h3', { style: { marginTop: 0 } }, '注入的上下文'),
    h('div.row',
      check('术语表', () => st.useTerms, (v) => { st.useTerms = v; }),
      check('记忆库参考', () => st.useMemory, (v) => { st.useMemory = v; }),
      check('前后句', () => st.useContext, (v) => { st.useContext = v; }),
    ),
    h('div', { style: { marginTop: '9px' } }, extraInput),
  ));
}

function renderSource(ctx) {
  sourceEl = h('div');
  mountSource(ctx);
  return sourceEl;
}

function mountSource(ctx) {
  if (!sourceEl) return;

  const ta = h('textarea', {
    rows: 10, value: st.source,
    placeholder: '粘贴英文原文，或点「从工作台取当前文档」。\n'
      + '会按行/句拆分，逐句翻译；代码块与标记行不会被翻译。',
  });
  ta.addEventListener('input', () => { st.source = ta.value; });

  const parse = () => {
    const text = ta.value;
    st.source = text;
    if (!text.trim()) { toast('请先填入原文', 'err'); return false; }
    buildSentences(text);
    if (!st.sentences.length) { toast('没有解析出可翻译的句子', 'err'); return false; }
    return true;
  };

  const fromWorkbench = h('button.btn', {
    onclick: async () => {
      const doc = await db.listDocuments();
      if (!doc.length) { toast('语料库里还没有项目，先去工作台保存一个', 'err'); return; }
      const full = await db.getDocument(doc[0].id);
      ta.value = full.source || '';
      st.source = ta.value;
      toast(`已取入「${full.name}」`, 'ok');
    },
  }, '从工作台取当前文档');

  const openFile = h('button.btn', {
    onclick: async () => {
      const f = await pickFile({ accept: '.txt,.md,.wikidot,.htm,.html' });
      if (!f) return;
      let text = await readText(f);
      if (/\.html?$/i.test(f.name)) text = stripHtml(text);
      ta.value = text;
      st.source = text;
    },
  }, '打开文件');

  const runBtn = h('button.btn.primary', {
    onclick: async () => {
      if (!parse()) return;
      await runAll(ctx);
    },
  }, '全部翻译');

  const stopBtn = h('button.btn.danger', {
    onclick: () => { if (st.abort) st.abort.abort(); },
  }, '停止');

  progressEl = h('div.tiny.mute');

  listEl = h('div.seg-list');

  mount(sourceEl,
    h('div.card',
      h('div.row', { style: { marginBottom: '9px' } },
        fromWorkbench, openFile,
        h('span.grow'),
        h('span.tiny.mute', '按句调用 API；一句一次请求，便于单独重试'),
      ),
      ta,
      h('div.row', { style: { marginTop: '11px' } },
        runBtn, stopBtn, progressEl),
      st.sentences.length ? renderEstimate() : null,
    ),
    listEl,
  );
  renderSentences(ctx);
}

function renderEstimate() {
  const est = estimateBatch(st.sentences.map((s) => s.src));
  return h('p.tiny.mute', { style: { marginTop: '8px' } },
    `共 ${fmtNum(st.sentences.length)} 句 / ${fmtNum(est.chars)} 字符，`
    + `预计输入约 ${fmtNum(est.inTokens)} tokens、输出约 ${fmtNum(est.outTokens)} tokens。`);
}

/* ------------------------------------------------------------- sentences */

function buildSentences(text) {
  const blocks = parseDocument(text, detectLang(text));
  const flat = flattenSentences(blocks);
  st.sentences = flat.map((f) => ({
    src: f.sentence.src,
    out: '',
    state: 'idle',
    terms: [],
    matches: [],
    error: '',
  }));
}

function contextFor(ctx, i) {
  const s = st.sentences[i];
  const terms = (st.useTerms && ctx.state.glossary)
    ? safe(() => ctx.state.glossary.lookup(s.src, { limit: 12 }), [])
    : [];
  const matches = (st.useMemory && ctx.state.index)
    ? safe(() => ctx.state.index.search(s.src, { limit: 3, minScore: 60 })
        .map((m) => ({ src: m.unit.src, tgt: m.unit.tgt })), [])
    : [];
  const prev = st.useContext && i > 0 ? st.sentences[i - 1].src : '';
  const next = st.useContext && i + 1 < st.sentences.length ? st.sentences[i + 1].src : '';
  return { terms, matches, prev, next };
}

function safe(fn, dflt) {
  try { return fn(); } catch { return dflt; }
}

async function runAll(ctx) {
  if (!st.key) { toast('请先填写 DeepSeek API Key', 'err'); return; }
  if (st.running) return;
  st.running = true;
  st.abort = new AbortController();
  const todo = st.sentences
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.state !== 'done');
  toast(`开始翻译 ${fmtNum(todo.length)} 句…`);

  for (const { i } of todo) {
    if (!st.running) break;
    await runOne(ctx, i);
  }
  st.running = false;
  st.abort = null;
  renderProgress();
  toast('翻译结束', 'ok');
}

async function runOne(ctx, i) {
  const s = st.sentences[i];
  if (!s) return;
  const { terms, matches, prev, next } = contextFor(ctx, i);
  s.terms = terms;
  s.matches = matches;
  s.state = 'running';
  s.out = '';
  s.error = '';
  renderSentences(ctx);
  renderProgress();

  const messages = buildMessages({
    source: s.src,
    terms: terms.map((t) => ({ en: t.en, zh: t.zh })),
    matches,
    prev, next,
    extra: st.extra,
  });

  try {
    let acc = '';
    for await (const d of streamChat({
      apiKey: st.key, baseUrl: st.baseUrl, model: st.model,
      temperature: st.temperature, messages, signal: st.abort ? st.abort.signal : undefined,
    })) {
      acc += d;
      s.out = acc;
      updateSentenceNode(i, acc);
    }
    s.out = cleanTranslation(acc);
    s.state = s.out ? 'done' : 'error';
    if (!s.out) s.error = '模型返回了空内容';
  } catch (err) {
    s.state = 'error';
    s.error = err.message;
    if (/API Key/.test(err.message)) st.running = false;
  }
  renderSentences(ctx);
  renderProgress();
}

/** Patch just the output box while streaming, to avoid rebuilding the DOM. */
function updateSentenceNode(i, text) {
  if (!listEl) return;
  const node = listEl.querySelector(`[data-out="${i}"]`);
  if (node) node.textContent = text;
}

function renderProgress() {
  if (!progressEl) return;
  const done = st.sentences.filter((s) => s.state === 'done').length;
  const err = st.sentences.filter((s) => s.state === 'error').length;
  const running = st.sentences.some((s) => s.state === 'running');
  mount(progressEl,
    `${fmtNum(done)}/${fmtNum(st.sentences.length)} 已完成`
    + (err ? ` · ${err} 句失败` : '')
    + (running ? ' · 进行中…' : ''));
}

function renderSentences(ctx) {
  if (!listEl) return;
  if (!st.sentences.length) {
    mount(listEl, h('div.empty', '还没有待翻译内容。粘贴原文后点「全部翻译」。'));
    return;
  }
  mount(listEl, ...st.sentences.map((s, i) => renderSentence(ctx, s, i)));
}

function renderSentence(ctx, s, i) {
  const node = h('div.seg' + (s.state === 'done' ? '.done' : ''),
    { dataset: { idx: String(i) } });

  node.append(h('div.seg-head',
    h('span.seg-num', `#${i + 1}`),
    s.state === 'running' ? h('span.pill.fuzzy', '翻译中')
      : (s.state === 'done' ? h('span.pill.ok', '已完成')
        : (s.state === 'error' ? h('span.pill.new', '失败') : null)),
    h('span.grow'),
    h('span.tiny.mute', s.terms.length ? `${s.terms.length} 术语` : ''),
    h('span.tiny.mute', s.matches.length ? ` ${s.matches.length} 参考` : ''),
  ));

  node.append(h('div.seg-src', s.src));

  if (s.terms.length) {
    node.append(h('div.term-row', ...s.terms.slice(0, 10).map((t) => h('span.term-chip',
      { style: { cursor: 'default' } },
      h('span.term-en', t.en), h('span.term-arrow', '→'), h('span.term-zh', t.zh)))));
  }

  if (s.state === 'error' && s.error) {
    node.append(h('div.tiny', { style: { color: 'var(--accent-2)', marginTop: '6px' } }, s.error));
  }

  node.append(h('pre.block-pre', {
    dataset: { out: String(i) },
    style: { minHeight: '34px' },
  }, s.out || (s.state === 'running' ? '' : '（尚未翻译）')));

  const actions = h('div.row.tight', { style: { marginTop: '7px' } },
    h('button.btn.sm' + (s.state === 'done' ? '.primary' : ''), {
      onclick: () => runOne(ctx, i),
    }, s.state === 'done' ? '重译' : 'AI 译'),
    s.out ? h('button.btn.sm', {
      onclick: () => {
        navigator.clipboard && navigator.clipboard.writeText(s.out);
        toast('已复制', 'ok');
      },
    }, '复制') : null,
    s.matches.length ? h('button.btn.sm', {
      onclick: () => showMatches(s),
    }, '看参考译文') : null,
  );
  node.append(actions);

  return node;
}

function showMatches(s) {
  modal({
    title: '记忆库参考',
    wide: true,
    body: h('div', ...s.matches.map((m) => h('div', { style: { marginBottom: '12px' } },
      h('div.tiny.mute', 'EN'), h('div', m.src),
      h('div.tiny.mute', { style: { marginTop: '5px' } }, 'ZH'), h('div', m.tgt)))),
    actions: [{ label: '关闭', primary: true }],
  });
}

function stripHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const sel of ['script', 'style', 'nav', 'header', 'footer', '#side-bar', '#page-tags']) {
    for (const el of doc.querySelectorAll(sel)) el.remove();
  }
  const content = doc.querySelector('#page-content') || doc.body;
  const out = [];
  for (const el of content.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, blockquote, pre')) {
    const t = (el.textContent || '').replace(/\s+$/, '');
    if (t.trim()) out.push(t);
  }
  return out.length ? out.join('\n\n') : (content.textContent || '').trim();
}

/**
 * Translate a single sentence on the workbench's behalf, with the same context
 * injection. Used by the per-sentence AI button there.
 */
export async function translateSentence(ctx, src, { prev = '', next = '' } = {}) {
  if (!st.key) throw new Error('还没有配置 DeepSeek API Key（设置 → AI 翻译）');
  const terms = (st.useTerms && ctx.state.glossary)
    ? safe(() => ctx.state.glossary.lookup(src, { limit: 12 }), []) : [];
  const matches = (st.useMemory && ctx.state.index)
    ? safe(() => ctx.state.index.search(src, { limit: 3, minScore: 60 })
        .map((m) => ({ src: m.unit.src, tgt: m.unit.tgt })), []) : [];
  const messages = buildMessages({
    source: src,
    terms: terms.map((t) => ({ en: t.en, zh: t.zh })),
    matches,
    prev: st.useContext ? prev : '',
    next: st.useContext ? next : '',
    extra: st.extra,
  });
  let acc = '';
  for await (const d of streamChat({
    apiKey: st.key, baseUrl: st.baseUrl, model: st.model,
    temperature: st.temperature, messages,
  })) acc += d;
  return cleanTranslation(acc);
}

export function isConfigured() { return !!st.key; }
export function currentKey() { return st.key; }
export function getOptions() {
  return { useTerms: st.useTerms, useMemory: st.useMemory, useContext: st.useContext, extra: st.extra };
}
export { KIND };
