/**
 * views/workbench.js — CAT-style translation workbench.
 *
 * Operates on the structure-preserving document model (js/document.js) rather
 * than a flattened sentence list, so line breaks, blank lines, list markers,
 * table rows, Wikidot markup and code blocks all survive the round trip and
 * the exported translation can be pasted straight back into the wiki.
 */

import * as db from '../db.js';
import { buildTmx } from '../tmx.js';
import { detectLang, highlightPlaceholders, placeholderSignature } from '../segment.js';
import {
  parseDocument, reconstruct, documentStats, collectPairs, flattenSentences,
  KIND,
} from '../document.js';
import { scoreClass } from '../ui.js';
import {
  h, mount, toast, modal, downloadText, pickFile, readText,
  fmtNum, debounce,
} from '../ui.js';

/* ------------------------------------------------------------- view state */

const wb = {
  sourceText: '',
  title: '',
  srcLang: 'en-US',
  blocks: [],
  flat: [],
  active: 0,
  projectId: null,
  loaded: false,
};

let listEl = null;
let progressEl = null;
let statEl = null;

function reset() {
  wb.sourceText = '';
  wb.title = '';
  wb.blocks = [];
  wb.flat = [];
  wb.active = 0;
  wb.projectId = null;
  wb.loaded = false;
}

function reparse(text, lang) {
  wb.sourceText = text;
  wb.srcLang = lang || detectLang(text);
  wb.blocks = parseDocument(text, wb.srcLang);
  wb.flat = flattenSentences(wb.blocks);
}

/* ------------------------------------------------------------------ render */

export function render(ctx) {
  const wrap = h('div');
  if (!wb.loaded) wrap.append(renderStart(ctx));
  else wrap.append(renderWorkspace(ctx));
  if (ctx.state.indexBuilding) wrap.append(h('div.loading', '正在建立记忆库索引'));
  return wrap;
}

function renderStart(ctx) {
  const ta = h('textarea', {
    rows: 14,
    placeholder: '在此粘贴英文原文（Wikidot 语法原样保留）。\n\n'
      + '换行、空行、列表与标题标记、||表格||、[[code]] 代码块、\n'
      + '[[module]] / [[include]] 等标记都会被完整保留，不会被断句切碎。',
    value: wb.sourceText,
  });
  ta.addEventListener('input', () => { wb.sourceText = ta.value; });

  const titleInput = h('input', { type: 'text', placeholder: '项目名称（可选）', value: wb.title });
  titleInput.addEventListener('input', () => { wb.title = titleInput.value; });

  const startBtn = h('button.btn.primary', {
    onclick: () => startTranslation(ctx, ta.value, titleInput.value),
  }, '开始翻译');

  const openBtn = h('button.btn', {
    onclick: async () => {
      const f = await pickFile({ accept: '.txt,.md,.wikidot,.htm,.html' });
      if (!f) return;
      let text = await readText(f);
      if (/\.html?$/i.test(f.name)) text = stripHtml(text);
      ta.value = text;
      wb.sourceText = text;
      if (!titleInput.value) {
        titleInput.value = f.name.replace(/\.[^.]+$/, '');
        wb.title = titleInput.value;
      }
    },
  }, '打开文件');

  return h('div',
    h('h1', '工作台'),
    h('p.sub', '粘贴原文逐句翻译；原文格式会被完整保留，导出时按原结构回填。'),
    h('div.card',
      h('div.row', { style: { marginBottom: '10px' } }, h('div.grow', titleInput), openBtn),
      ta,
      h('div.row', { style: { marginTop: '12px' } },
        startBtn,
        h('span.tiny', '译文只保存在你的浏览器里，请用「导出」备份。')),
    ),
    ctx.state.memories.length ? null : h('div.card',
      h('h2', '还没有记忆库'),
      h('p.dim', '没有记忆库也能翻译，但不会有自动匹配。可以到「记忆库」载入总记忆库，或到「对齐制作」自己生成一个。'),
    ),
  );
}

function startTranslation(ctx, text, title) {
  if (!String(text || '').trim()) { toast('请先粘贴原文', 'err'); return; }
  reparse(text, detectLang(text));
  if (!wb.flat.length && !wb.blocks.some((b) => b.kind === KIND.CODE)) {
    toast('没有解析出可翻译的内容', 'err');
    return;
  }
  wb.title = title || '未命名项目';
  wb.loaded = true;
  wb.projectId = null;
  wb.active = 0;
  const st = documentStats(wb.blocks);
  toast(`已解析：${fmtNum(st.sentences)} 句，${fmtNum(st.kinds.code)} 个代码块`, 'ok');
  ctx.refresh();
}

/* ------------------------------------------------------------ workspace */

function renderWorkspace(ctx) {
  const state = ctx.state;
  listEl = h('div.seg-list');
  renderBlocks(ctx);

  progressEl = h('div.progress-inner');
  statEl = h('div');
  renderStats();

  const side = h('div.side-panel',
    h('div.card',
      h('h3', { style: { marginTop: 0 } }, '进度'),
      h('div.progress-outer', progressEl),
      statEl,
    ),
    h('div.card',
      h('h3', { style: { marginTop: 0 } }, '当前记忆库'),
      state.activeMemory
        ? h('div',
            h('div', h('strong', state.activeMemory.name)),
            h('div.tiny', `${state.activeMemory.srcLang} → ${state.activeMemory.tgtLang}`),
            h('div.tiny', `${fmtNum(state.activeMemory.count)} 条单元`))
        : h('div.dim', '未选择记忆库'),
    ),
    renderConcordancePanel(ctx),
  );

  return h('div',
    h('div.row', { style: { marginBottom: '12px' } },
      h('div.grow',
        h('h1', { style: { margin: 0 } }, wb.title || '工作台'),
        h('div.tiny', formatSummary())),
      h('button.btn', { onclick: () => previewOutput() }, '预览输出'),
      h('button.btn', { onclick: () => exportTarget() }, '导出译文（保留格式）'),
      h('button.btn', { onclick: () => exportBilingual() }, '导出 TMX'),
      h('button.btn', { onclick: () => saveProject(ctx) }, '保存项目'),
      h('button.btn.ghost', {
        onclick: async () => {
          if (wb.flat.some((f) => f.sentence.tgt.trim())) {
            const ok = await new Promise((resolve) => modal({
              title: '放弃当前进度？',
              body: '当前项目有未导出的译文，新建后将会丢失。',
              actions: [
                { label: '取消', onClick: (c) => { c(); resolve(false); } },
                { label: '放弃', danger: true, onClick: (c) => { c(); resolve(true); } },
              ],
            }));
            if (!ok) return;
          }
          reset();
          ctx.refresh();
        },
      }, '新建'),
    ),
    h('div.wb', h('div', listEl), side),
  );
}

function formatSummary() {
  const st = documentStats(wb.blocks);
  const bits = [`${fmtNum(st.blocks)} 块`, `${fmtNum(st.sentences)} 句`];
  if (st.kinds.code) bits.push(`${fmtNum(st.kinds.code)} 代码块`);
  if (st.kinds.table) bits.push(`${fmtNum(st.kinds.table)} 表格行`);
  return bits.join(' · ');
}

/* --------------------------------------------------------------- blocks */

function renderBlocks(ctx) {
  if (!listEl) return;
  const nodes = [];
  let flatIndex = 0;

  for (let bi = 0; bi < wb.blocks.length; bi++) {
    const b = wb.blocks[bi];
    if (b.kind === KIND.BLANK) {
      nodes.push(h('div.block-gap', { title: '空行（保留）' }));
      continue;
    }
    if (b.kind === KIND.CODE) {
      nodes.push(renderCodeBlock(b, bi));
      continue;
    }
    if (b.kind === KIND.MARKUP) {
      nodes.push(h('div.block-markup', { title: '标记行（原样保留，不翻译）' },
        h('span.pill', '标记'), h('code', b.parts[0].text)));
      continue;
    }

    const textParts = b.parts.filter((p) => p.type === 'text');
    nodes.push(renderTextBlock(ctx, b, bi, textParts, () => {
      const start = flatIndex;
      let n = 0;
      for (const p of textParts) n += p.sentences.length;
      flatIndex += n;
      return { start, count: n };
    }));
  }

  mount(listEl, ...nodes);
  focusActive();
}

function renderCodeBlock(b, bi) {
  return h('div.seg.block-code',
    h('div.seg-head',
      h('span.seg-num', `#${bi + 1}`),
      h('span.pill', '代码块'),
      h('span.tiny.mute', '原样保留，不翻译、不参与断句'),
    ),
    h('pre.block-pre', b.parts[0].text),
  );
}

function renderTextBlock(ctx, block, bi, textParts, claimRange) {
  const { start } = claimRange();
  const node = h('div.seg', { dataset: { block: String(bi) } });
  const kindLabel = block.kind === KIND.TABLE ? '表格行' : null;

  node.append(h('div.seg-head',
    h('span.seg-num', `#${bi + 1}`),
    kindLabel ? h('span.pill', kindLabel) : null,
    h('span.grow'),
    h('span.tiny.mute', { dataset: { role: 'blockstate', block: String(bi) } }, ''),
  ));

  // the exact original line, so markers and spacing are visible
  node.append(h('pre.block-raw', { title: '原文行（格式将被保留）' }, block.parts
    .map((p) => (p.type === 'literal' ? p.text : p.src)).join('')));

  let local = start;
  for (const part of textParts) {
    for (const s of part.sentences) {
      const idx = local;
      local += 1;
      node.append(renderSentence(ctx, s, idx, bi));
    }
  }
  return node;
}

function renderSentence(ctx, sentence, idx, bi) {
  const matches = ctx.state.index ? safeSearch(ctx.state.index, sentence.src) : [];
  const terms = ctx.state.glossary ? safeTerms(ctx.state.glossary, sentence.src) : [];
  const missing = sentence.tgt.trim()
    ? placeholderDiff(placeholderSignature(sentence.src), placeholderSignature(sentence.tgt))
    : [];

  const row = h('div.sentence' + (sentence.tgt.trim() ? '.done' : ''),
    { dataset: { flat: String(idx), block: String(bi) } });

  row.append(h('div.sentence-head',
    h('span.sent-idx.mono', `${idx + 1}`),
    missing.length ? h('span.pill.new', `缺少 ${missing.join(' ')}`) : null,
    h('span.grow'),
    terms.length ? h('span.tiny.mute', `${terms.length} 个术语`) : null,
    h('span.tiny.mute', { dataset: { role: 'matchcount' } },
      matches.length ? `${matches.length} 条匹配` : '无匹配'),
  ));

  row.append(h('div.seg-src', { html: highlightPlaceholders(sentence.src) }));

  const ta = h('textarea', {
    rows: Math.max(1, Math.min(6, Math.ceil(sentence.src.length / 58))),
    placeholder: '译文…（Ctrl+Enter 下一句）',
    value: sentence.tgt,
    dataset: { flat: String(idx) },
  });

  // terms in THIS sentence: click one to insert its translation at the cursor
  if (terms.length) {
    const box = h('div.term-row', { title: '本句出现的术语（点击插入译文）' });
    for (const t of terms) {
      const chip = h('button.term-chip', {
        title: `${t.source === 'memory' ? '记忆库挖掘' : '维基术语表'} · 出现 ${t.count} 次 · 一致度 ${t.consistency}`,
      },
        h('span.term-en', t.en),
        h('span.term-arrow', '→'),
        h('span.term-zh', t.zh),
      );
      chip.addEventListener('click', () => {
        insertAtCursor(ta, t.zh);
        sentence.tgt = ta.value;
        row.classList.add('done');
        renderStats();
        updateBlockState(bi);
        ta.focus();
      });
      box.append(chip);
    }
    row.append(box);
  }

  // one-click AI translation for this sentence, with the same context injection
  if (ctx.aiReady) {
    const toolRow = h('div.row.tight', { style: { marginTop: '6px' } });

    const doAi = async () => {
      if (aiBtn.disabled) return;
      aiBtn.disabled = true;
      const old = aiBtn.textContent;
      aiBtn.textContent = '翻译中…';
      try {
        const prev = idx > 0 && wb.flat[idx - 1] ? wb.flat[idx - 1].sentence.src : '';
        const next = wb.flat[idx + 1] ? wb.flat[idx + 1].sentence.src : '';
        const out = await ctx.aiTranslate(sentence.src, { prev, next });
        if (!out) throw new Error('模型返回了空内容');
        ta.value = out;
        sentence.tgt = out;
        row.classList.add('done');
        renderStats();
        updateBlockState(bi);
      } catch (err) {
        toast('AI 翻译失败：' + err.message, 'err');
      } finally {
        aiBtn.disabled = false;
        aiBtn.textContent = old;
      }
    };

    const aiBtn = h('button.btn.sm', {
      title: '用 DeepSeek 翻译本句（临床腔，自动带上术语与记忆库）',
      onclick: doAi,
    }, sentence.tgt.trim() ? '✦ 重译' : '✦ AI 译');
    toolRow.append(aiBtn);
    row.append(toolRow);
  }

  ta.addEventListener('input', () => {
    sentence.tgt = ta.value;
    row.classList.toggle('done', !!sentence.tgt.trim());
    renderStats();
    updateBlockState(bi);
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      gotoFlat(idx + 1);
    }
  });
  ta.addEventListener('focus', () => { wb.active = idx; markActive(); });
  row.append(ta);

  if (matches.length) {
    const box = h('div.seg-matches');
    for (const mt of matches) {
      const item = h('div.match', { title: '点击填入译文' },
        h('div.m-top',
          h('span.pill.' + scoreClass(mt.score), Math.round(mt.score) + '%'),
          mt.unit.doc ? h('span.tiny.mute', mt.unit.doc) : null),
        h('div.m-src', mt.unit.src.slice(0, 200)),
        h('div.m-tgt', mt.unit.tgt.slice(0, 200)),
      );
      item.addEventListener('click', () => {
        ta.value = mt.unit.tgt;
        sentence.tgt = mt.unit.tgt;
        row.classList.add('done');
        renderStats();
        updateBlockState(bi);
        ta.focus();
      });
      box.append(item);
    }
    row.append(box);
  }
  return row;
}

/** Insert text into a textarea at the caret, replacing any selection. */
function insertAtCursor(ta, text) {
  const start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  const end = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  const pos = start + text.length;
  try { ta.setSelectionRange(pos, pos); } catch { /* shim */ }
}

function safeTerms(glossary, src) {
  try { return glossary.lookup(src, { limit: 8 }); }
  catch (err) { console.error(err); return []; }
}

function updateBlockState(bi) {
  const el = listEl && listEl.querySelector(`[data-role="blockstate"][data-block="${bi}"]`);
  if (!el) return;
  const flat = wb.flat.filter((f) => f.bi === bi);
  const done = flat.filter((f) => f.sentence.tgt.trim()).length;
  el.textContent = flat.length ? `${done}/${flat.length}` : '';
}

function safeSearch(index, src) {
  try { return index.search(src, { limit: 3, minScore: 50 }); }
  catch (err) { console.error(err); return []; }
}

function placeholderDiff(a, b) {
  const out = [];
  const countOf = (arr) => {
    const m = new Map();
    for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
    return m;
  };
  const A = countOf(a.codes);
  const B = countOf(b.codes);
  for (const [k, v] of A) if ((B.get(k) || 0) < v) out.push(k);
  if (a.bars > 0 && b.bars === 0) out.push('███');
  return out;
}

/* ------------------------------------------------------------ navigation */

function markActive() {
  if (!listEl) return;
  for (const r of listEl.querySelectorAll('.sentence')) {
    r.classList.toggle('active', Number(r.dataset.flat) === wb.active);
  }
}

function gotoFlat(idx) {
  if (idx < 0 || idx >= wb.flat.length) { toast('已是最后一句', 'ok'); return; }
  wb.active = idx;
  markActive();
  focusActive();
}

function focusActive() {
  if (!listEl) return;
  const ta = listEl.querySelector(`textarea[data-flat="${wb.active}"]`);
  if (ta) {
    ta.focus();
    ta.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } else {
    // landed on a non-translatable block; find the next sentence
    const next = wb.flat.findIndex((f) => f.sentence && f.sentence.tgt === '' );
    if (next >= 0 && next !== wb.active) { wb.active = next; focusActive(); }
  }
}

function renderStats() {
  if (!statEl || !progressEl) return;
  const st = documentStats(wb.blocks);
  const pct = st.sentences ? Math.round((st.translated / st.sentences) * 100) : 0;
  progressEl.style.width = pct + '%';
  mount(statEl,
    h('div', { style: { marginTop: '9px' } },
      `${fmtNum(st.translated)} / ${fmtNum(st.sentences)} 句（${pct}%）`),
    h('div.tiny', `剩余 ${fmtNum(st.sentences - st.translated)} 句`),
    h('div.tiny', { style: { marginTop: '6px' } },
      `保留：${fmtNum(st.kinds.code)} 代码块 · ${fmtNum(st.kinds.table)} 表格行 · `
      + `${fmtNum(st.kinds.markup)} 标记行 · ${fmtNum(st.kinds.blank)} 空行`),
  );
}

/* ----------------------------------------------------------- concordance */

function renderConcordancePanel(ctx) {
  const results = h('div', { style: { marginTop: '9px', maxHeight: '46vh', overflow: 'auto' } });
  const input = h('input', { type: 'search', placeholder: '查证检索（源文或译文）…' });
  const run = debounce(() => {
    const q = input.value.trim();
    if (!q || !ctx.state.index) { mount(results); return; }
    let hits = [];
    try { hits = ctx.state.index.concordance(q, { limit: 60 }); }
    catch { mount(results, h('div.tiny.mute', '检索出错')); return; }
    if (!hits.length) { mount(results, h('div.tiny.mute', '没有结果')); return; }
    mount(results, ...hits.map((x) => h('div.match',
      h('div.m-src', x.unit.src.slice(0, 160)),
      h('div.m-tgt', x.unit.tgt.slice(0, 160)))));
  }, 220);
  input.addEventListener('input', run);
  return h('div.card', h('h3', { style: { marginTop: 0 } }, '查证检索'), input, results);
}

/* --------------------------------------------------------------- actions */

function previewOutput() {
  const text = reconstruct(wb.blocks);
  modal({
    title: '导出预览（保留原格式）',
    wide: true,
    body: h('div',
      h('p.tiny.dim', '未翻译的句子会保留原文，代码块与标记原样输出。可直接复制粘贴回 Wikidot。'),
      h('pre.block-pre', { style: { maxHeight: '60vh', overflow: 'auto' } }, text)),
    actions: [
      { label: '关闭', onClick: (c) => c() },
      { label: '下载', primary: true, onClick: (c) => { c(); exportTarget(); } },
    ],
  });
}

function exportTarget() {
  const text = reconstruct(wb.blocks);
  downloadText(`${safe(wb.title || 'translation')}-zh.txt`, text, 'text/plain;charset=utf-8');
  const st = documentStats(wb.blocks);
  toast(`已导出（${fmtNum(st.translated)}/${fmtNum(st.sentences)} 句已译）`, 'ok');
}

function exportBilingual() {
  const pairs = collectPairs(wb.blocks);
  if (!pairs.length) { toast('还没有可导出的译文', 'err'); return; }
  const { xml } = buildTmx({
    units: pairs.map((p, i) => ({
      src: p.src, tgt: p.tgt, tuid: `${wb.title || 'workbench'}#${i}`,
      props: { 'x-doc': wb.title || 'workbench', 'x-origin': 'workbench' },
    })),
    srcLang: wb.srcLang, tgtLang: 'zh-CN',
    headerProps: { Project: wb.title || 'RPC CAT workbench', segtype: 'sentence' },
  });
  downloadText(`${safe(wb.title || 'workbench')}.tmx`, xml, 'application/xml;charset=utf-8');
  toast(`已导出 ${fmtNum(pairs.length)} 条双语对照`, 'ok');
}

async function saveProject(ctx) {
  const st = documentStats(wb.blocks);
  if (!st.translated) { toast('还没有任何译文', 'err'); return; }
  const id = await db.saveDocument({
    id: wb.projectId || undefined,
    name: wb.title || '未命名项目',
    kind: 'project',
    srcLang: wb.srcLang,
    tgtLang: 'zh-CN',
    source: wb.sourceText,
    // store by flat index; re-applied after re-parsing on open
    translations: wb.flat.map((f) => f.sentence.tgt || ''),
    segments: wb.flat.map((f) => ({ src: f.sentence.src, tgt: f.sentence.tgt || '' })),
  });
  wb.projectId = id;
  toast(`项目已保存（${fmtNum(st.translated)} 句译文）`, 'ok');
  void ctx;
}

/** Reopen a saved project: re-parse the source, then re-apply translations. */
export function openProject(doc) {
  reparse(doc.source || (doc.segments || []).map((s) => s.src).join('\n\n'), doc.srcLang);
  const saved = doc.translations || [];
  if (saved.length === wb.flat.length) {
    wb.flat.forEach((f, i) => { f.sentence.tgt = saved[i] || ''; });
  } else {
    // fall back to matching on source text if the parser output changed
    const byText = new Map();
    for (const s of (doc.segments || [])) {
      if (s.tgt) byText.set(s.src, s.tgt);
    }
    for (const f of wb.flat) {
      const t = byText.get(f.sentence.src);
      if (t) f.sentence.tgt = t;
    }
  }
  wb.title = doc.name || '未命名项目';
  wb.projectId = doc.id;
  wb.loaded = true;
  wb.active = Math.max(0, wb.flat.findIndex((f) => !f.sentence.tgt.trim()));
}

function stripHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const sel of ['script', 'style', 'nav', 'header', 'footer', '#side-bar', '#page-tags']) {
    for (const el of doc.querySelectorAll(sel)) el.remove();
  }
  const content = doc.querySelector('#page-content') || doc.body;
  const blocks = [];
  for (const el of content.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, blockquote, pre')) {
    const t = (el.textContent || '').replace(/\s+$/, '');
    if (t.trim()) blocks.push(t);
  }
  return blocks.length ? blocks.join('\n\n') : (content.textContent || '').trim();
}

function safe(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
}
