/**
 * views/workbench.js — CAT-style translation workbench.
 *
 * Paste English source -> segment by sentence -> each segment shows memory
 * matches (exact + fuzzy) and an input box.  Finished work can be saved as a
 * project, exported as a bilingual TMX, or as a translated text file.
 */

import * as db from '../db.js';
import { buildTmx } from '../tmx.js';
import {
  splitBlocks, splitSentences, highlightPlaceholders, placeholderSignature,
  cleanText,
} from '../segment.js';
import { scoreClass } from '../ui.js';
import {
  h, mount, toast, modal, downloadText, pickFile, readText,
  fmtNum, debounce,
} from '../ui.js';

/* ------------------------------------------------------------- view state */

const wb = {
  sourceText: '',
  title: '',
  segments: [],          // {src, tgt, note}
  active: 0,
  projectId: null,
  loaded: false,
};

let segListEl = null;
let progressEl = null;
let statEl = null;

function reset() {
  wb.sourceText = '';
  wb.title = '';
  wb.segments = [];
  wb.active = 0;
  wb.projectId = null;
  wb.loaded = false;
}

/* ------------------------------------------------------------------ render */

export function render(ctx) {
  const { state } = ctx;

  const wrap = h('div');

  if (!wb.loaded) {
    wrap.append(renderStart(ctx));
  } else {
    wrap.append(renderWorkspace(ctx));
  }

  if (state.indexBuilding) {
    wrap.append(h('div.loading', '正在建立记忆库索引'));
  }
  return wrap;
}

function renderStart(ctx) {
  const ta = h('textarea', {
    rows: 14,
    placeholder: '在此粘贴英文原文（支持 Wikidot 语法）。\n\n也可以点「打开文件」载入 .txt / .wikidot 文本；\n或点「从记忆库取一段」用记忆库里的英文句子练手。',
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
      if (!titleInput.value) { titleInput.value = f.name.replace(/\.[^.]+$/, ''); wb.title = titleInput.value; }
    },
  }, '打开文件');

  const sampleBtn = h('button.btn', {
    onclick: () => loadSample(ctx, ta, titleInput),
  }, '载入示例原文');

  return h('div',
    h('h1', '工作台'),
    h('p.sub', '粘贴英文原文，逐句翻译；每一句都会自动从当前记忆库中检索匹配。'),
    h('div.card',
      h('div.row', { style: { marginBottom: '10px' } },
        h('div.grow', titleInput),
        openBtn, sampleBtn,
      ),
      ta,
      h('div.row', { style: { marginTop: '12px' } },
        startBtn,
        h('span.tiny', '译文只保存在你的浏览器里，请用「导出」备份。'),
      ),
    ),
    ctx.state.memories.length ? null : h('div.card',
      h('h2', '还没有记忆库'),
      h('p.dim', '翻译时没有记忆库也能用，但不会有自动匹配。可以先到「对齐制作」用中英原文生成一个，或导入现成的 TMX。'),
    ),
  );
}

function startTranslation(ctx, text, title) {
  const src = cleanText(text || '');
  if (!src) { toast('请先粘贴原文', 'err'); return; }
  const blocks = splitBlocks(src);
  const segs = [];
  for (const b of blocks) {
    // keep structural Wikidot lines whole; split prose into sentences
    const isStruct = /^(\*+\s|#+\s|\++\s|>+\s|\|\||-{4,}|={4,})/.test(b);
    const parts = isStruct ? [b] : splitSentences(b, 'en-US');
    for (const p of parts) if (p.trim()) segs.push({ src: p, tgt: '', note: '' });
  }
  if (!segs.length) { toast('没有解析出可翻译的句子', 'err'); return; }
  wb.sourceText = text;
  wb.title = title || '未命名项目';
  wb.segments = segs;
  wb.active = 0;
  wb.loaded = true;
  wb.projectId = null;
  toast(`已切分为 ${fmtNum(segs.length)} 句`, 'ok');
  ctx.refresh();
}

function renderWorkspace(ctx) {
  const { state } = ctx;

  segListEl = h('div.seg-list');
  renderSegments(ctx);

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
            h('div.tiny', `${fmtNum(state.activeMemory.count)} 条单元`),
            state.index ? h('div.tiny', `索引：${fmtNum(state.index.stats().distinctSources)} 个不同源句`) : null)
        : h('div.dim', '未选择记忆库'),
    ),
    renderConcordancePanel(ctx),
  );

  return h('div',
    h('div.row', { style: { marginBottom: '12px' } },
      h('h1.grow', { style: { margin: 0 } }, wb.title || '工作台'),
      h('button.btn', { onclick: () => exportBilingual(ctx) }, '导出 TMX'),
      h('button.btn', { onclick: () => exportTarget() }, '导出译文'),
      h('button.btn', { onclick: () => saveProject(ctx) }, '保存项目'),
      h('button.btn.ghost', {
        onclick: async () => {
          if (wb.segments.some((s) => s.tgt.trim())) {
            const ok = await confirmDiscard();
            if (!ok) return;
          }
          reset();
          ctx.refresh();
        },
      }, '新建'),
    ),
    h('div.wb', h('div', segListEl), side),
  );
}

/* -------------------------------------------------------------- segments */

function renderSegments(ctx) {
  if (!segListEl) return;
  const frag = [];
  wb.segments.forEach((seg, i) => frag.push(renderSegment(ctx, seg, i)));
  mount(segListEl, ...frag);
  focusActive();
}

function renderSegment(ctx, seg, i) {
  const done = !!seg.tgt.trim();
  const node = h('div.seg' + (i === wb.active ? '.active' : '') + (done ? '.done' : ''),
    { dataset: { idx: String(i) } });

  const matches = ctx.state.index ? safeSearch(ctx.state.index, seg.src) : [];
  const ph = placeholderSignature(seg.src);
  const missing = done ? placeholderDiff(ph, placeholderSignature(seg.tgt)) : [];

  node.append(h('div.seg-head',
    h('span.seg-num', `#${i + 1}`),
    h('span.grow'),
    missing.length
      ? h('span.pill.new', { title: '译文缺少这些原文中的编号/占位符' }, `缺少 ${missing.join(' ')}`)
      : null,
    done ? h('span.pill.ok', '已译') : null,
  ));

  node.append(h('div.seg-src', { html: highlightPlaceholders(seg.src) }));

  const ta = h('textarea', {
    rows: Math.max(2, Math.min(8, Math.ceil(seg.src.length / 60))),
    placeholder: '输入译文…（Ctrl+Enter 确认并下一句）',
    value: seg.tgt,
    dataset: { seg: String(i) },
  });
  ta.addEventListener('input', () => {
    seg.tgt = ta.value;
    node.classList.toggle('done', !!seg.tgt.trim());
    renderStats();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      confirmSegment(seg, i);
    }
  });
  ta.addEventListener('focus', () => {
    wb.active = i;
    for (const el of segListEl.querySelectorAll('.seg')) el.classList.remove('active');
    node.classList.add('active');
  });
  node.append(ta);

  if (matches.length) {
    const box = h('div.seg-matches');
    for (const mt of matches) {
      const pct = Math.round(mt.score);
      const item = h('div.match', { title: '点击填入译文' },
        h('div.m-top',
          h('span.pill.' + scoreClass(mt.score), pct + '%'),
          mt.unit.doc ? h('span.tiny.mute', mt.unit.doc) : null,
        ),
        h('div.m-src', mt.unit.src.slice(0, 220)),
        h('div.m-tgt', mt.unit.tgt.slice(0, 220)),
      );
      item.addEventListener('click', () => {
        ta.value = mt.unit.tgt;
        seg.tgt = mt.unit.tgt;
        node.classList.toggle('done', true);
        renderStats();
        ta.focus();
      });
      box.append(item);
    }
    node.append(box);
  } else if (ctx.state.index) {
    node.append(h('div.tiny.mute', { style: { marginTop: '6px' } }, '记忆库中没有相近的句子'));
  }

  return node;
}

function safeSearch(index, src) {
  try {
    return index.search(src, { limit: 3, minScore: 50 });
  } catch (err) {
    console.error(err);
    return [];
  }
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
  for (const [k, v] of A) {
    const have = B.get(k) || 0;
    if (have < v) out.push(k);
  }
  if (a.bars > 0 && b.bars === 0) out.push('███');
  return out;
}

function confirmSegment(seg, i) {
  if (!seg.tgt.trim()) { toast('这一句还没有译文', 'err'); return; }
  if (i + 1 < wb.segments.length) {
    wb.active = i + 1;
    for (const el of segListEl.querySelectorAll('.seg')) {
      el.classList.toggle('active', Number(el.dataset.idx) === wb.active);
    }
    focusActive();
  } else {
    toast('已是最后一句', 'ok');
  }
  renderStats();
}

function focusActive() {
  if (!segListEl) return;
  const ta = segListEl.querySelector(`textarea[data-seg="${wb.active}"]`);
  if (ta) {
    ta.focus();
    ta.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function renderStats() {
  if (!statEl || !progressEl) return;
  const total = wb.segments.length;
  const done = wb.segments.filter((s) => s.tgt.trim()).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  progressEl.style.width = pct + '%';
  mount(statEl,
    h('div', { style: { marginTop: '9px' } }, `${fmtNum(done)} / ${fmtNum(total)} 句（${pct}%）`),
    h('div.tiny', `剩余 ${fmtNum(total - done)} 句`),
  );
}

/* ----------------------------------------------------------- concordance */

function renderConcordancePanel(ctx) {
  const results = h('div', { style: { marginTop: '9px', maxHeight: '46vh', overflow: 'auto' } });
  const input = h('input', {
    type: 'search',
    placeholder: '查证检索（源文或译文）…',
    dataset: { role: 'concordance' },
  });

  const run = debounce(() => {
    const q = input.value.trim();
    if (!q || !ctx.state.index) { mount(results); return; }
    let hits = [];
    try { hits = ctx.state.index.concordance(q, { limit: 60 }); }
    catch { mount(results, h('div.tiny.mute', '检索出错')); return; }
    if (!hits.length) { mount(results, h('div.tiny.mute', '没有结果')); return; }
    mount(results, ...hits.map((x) => h('div.match',
      h('div.m-src', x.unit.src.slice(0, 160)),
      h('div.m-tgt', x.unit.tgt.slice(0, 160)),
    )));
  }, 220);
  input.addEventListener('input', run);

  return h('div.card',
    h('h3', { style: { marginTop: 0 } }, '查证检索'),
    input,
    results,
  );
}

/* --------------------------------------------------------------- actions */

function stripHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const sel of ['script', 'style', 'nav', 'header', 'footer', '#side-bar', '#page-tags']) {
    for (const el of doc.querySelectorAll(sel)) el.remove();
  }
  const content = doc.querySelector('#page-content') || doc.body;
  // turn block elements into paragraph breaks so splitBlocks sees structure
  const blocks = [];
  for (const el of content.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, blockquote')) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) blocks.push(t);
  }
  if (!blocks.length) return (content.textContent || '').trim();
  return blocks.join('\n\n');
}

async function loadSample(ctx, ta, titleInput) {
  const samples = [
    { name: 'RPC-691 片段', text: 'RPC-691 is an MP4 video file distributed through various websites.\n\nRepeated watchers and listeners incur a number of nonspecific psychological effects.\n\nThe Authority was alerted to an abandoned warehouse in [REDACTED], Pennsylvania.' },
    { name: '管理局简史 片段', text: 'A Brief History of the Authority\n\n1456: In the lead-up to the abortive 1456 Crusade to retake Constantinople from the Turks, Pope Callixtus III creates a semi-autonomous branch of the Papal Inquisition.\n\n16-17 July, 1462: Agents of the Auctoritas, accompanying Vlad III of Wallachia, use what is described at the time as a "blood beast".' },
  ];
  const pick = await new Promise((resolve) => {
    modal({
      title: '选择示例原文',
      body: h('div', ...samples.map((s) => h('button.btn', {
        style: { display: 'block', width: '100%', marginBottom: '8px', textAlign: 'left' },
        onclick: (close) => { close(); resolve(s); },
      }, s.name))),
      actions: [{ label: '取消', onClick: (c) => { c(); resolve(null); } }],
    });
  });
  if (!pick) return;
  ta.value = pick.text;
  wb.sourceText = pick.text;
  titleInput.value = pick.name;
  wb.title = pick.name;
  void ctx;
}

function confirmDiscard() {
  return new Promise((resolve) => {
    modal({
      title: '放弃当前进度？',
      body: '当前项目有未导出的译文，新建后将会丢失。',
      actions: [
        { label: '取消', onClick: (c) => { c(); resolve(false); } },
        { label: '放弃', danger: true, onClick: (c) => { c(); resolve(true); } },
      ],
    });
  });
}

async function saveProject(ctx) {
  const done = wb.segments.filter((s) => s.tgt.trim()).length;
  if (!done) { toast('还没有任何译文', 'err'); return; }
  const doc = {
    id: wb.projectId || undefined,
    name: wb.title || '未命名项目',
    kind: 'project',
    srcLang: 'en-US',
    tgtLang: 'zh-CN',
    source: wb.sourceText,
    segments: wb.segments.map((s) => ({ src: s.src, tgt: s.tgt })),
  };
  const id = await db.saveDocument(doc);
  wb.projectId = id;
  toast(`项目已保存（${fmtNum(done)} 句译文）`, 'ok');
  void ctx;
}

function exportBilingual(ctx) {
  const units = wb.segments.filter((s) => s.tgt.trim()).map((s, i) => ({
    src: s.src, tgt: s.tgt, tuid: `wb#${i}`,
    props: { 'x-doc': wb.title || 'workbench', 'x-origin': 'workbench' },
  }));
  if (!units.length) { toast('还没有可导出的译文', 'err'); return; }
  const { xml } = buildTmx({
    units, srcLang: 'en-US', tgtLang: 'zh-CN',
    headerProps: { Project: wb.title || 'RPC CAT workbench', segtype: 'sentence' },
  });
  downloadText(`${safe(wb.title || 'workbench')}.tmx`, xml, 'application/xml;charset=utf-8');
  toast(`已导出 ${fmtNum(units.length)} 条双语对照`, 'ok');
  void ctx;
}

function exportTarget() {
  const done = wb.segments.filter((s) => s.tgt.trim());
  if (!done.length) { toast('还没有可导出的译文', 'err'); return; }
  const text = done.map((s) => s.tgt).join('\n');
  downloadText(`${safe(wb.title || 'translation')}-zh.txt`, text, 'text/plain;charset=utf-8');
  toast(`已导出 ${fmtNum(done.length)} 句译文`, 'ok');
}

function safe(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
}

export function openProject(doc) {
  wb.title = doc.name || '未命名项目';
  wb.sourceText = doc.source || (doc.segments || []).map((s) => s.src).join('\n\n');
  wb.segments = (doc.segments || []).map((s) => ({ src: s.src, tgt: s.tgt || '', note: s.note || '' }));
  wb.projectId = doc.id;
  wb.loaded = true;
  wb.active = Math.max(0, wb.segments.findIndex((s) => !s.tgt.trim()));
}
