/**
 * views/align.js — build a TMX from two parallel documents.
 *
 * Left/right panes take the English and Chinese text, "自动对齐" runs the same
 * monotone DP the offline pipeline uses, and the result is an editable row list:
 * a human can merge, split and re-pair before saving to a memory or exporting.
 */

import * as db from '../db.js';
import { buildTmx, parseTmx, toPairs } from '../tmx.js';
import {
  splitSentencesEn, splitSentencesZh,
} from '../segment.js';
import { translatableBlocks } from '../document.js';
import { alignBlocks, makeBlocks, buildTUs, MIN_EMIT } from '../align.js';
import {
  h, mount, toast, modal, downloadText, pickFile, readText, scoreClass,
  fmtNum, confirmDialog,
} from '../ui.js';

/* ------------------------------------------------------------- view state */

const st = {
  en: '',
  zh: '',
  name: '',
  rows: [],            // {enIndex, zhIndex, en, zh, score, paired}
  enBlocks: [],
  zhBlocks: [],
  pairs: [],
  ran: false,
  active: -1,
};

let rowsEl = null;
let previewEl = null;

/* ------------------------------------------------------------------ render */

export function render(ctx) {
  const wrap = h('div');
  wrap.append(h('h1', '对齐制作'));
  wrap.append(h('p.sub',
    '把英文原文和中文译文分别粘贴到左右两侧，自动对齐后即可生成 TMX，或直接存入记忆库。'));

  if (!st.ran) wrap.append(renderInputs(ctx));
  else wrap.append(renderResult(ctx));
  return wrap;
}

function renderInputs(ctx) {
  const enTa = h('textarea', {
    rows: 16, value: st.en, placeholder: '英文原文（支持 Wikidot 语法，段落之间空一行）',
  });
  enTa.addEventListener('input', () => { st.en = enTa.value; });

  const zhTa = h('textarea', {
    rows: 16, value: st.zh, placeholder: '中文译文',
  });
  zhTa.addEventListener('input', () => { st.zh = zhTa.value; });

  const nameInput = h('input', { type: 'text', value: st.name, placeholder: '文档名称（可选，会写进 tuid 与 x-doc）' });
  nameInput.addEventListener('input', () => { st.name = nameInput.value; });

  const openPair = h('button.btn', {
    onclick: async () => {
      const pair = await pickPair();
      if (!pair) return;
      enTa.value = pair.en; st.en = pair.en;
      zhTa.value = pair.zh; st.zh = pair.zh;
      if (!nameInput.value) { nameInput.value = pair.name; st.name = pair.name; }
    },
  }, '载入英文+中文文件');

  const loadTmx = h('button.btn', {
    onclick: async () => {
      const f = await pickFile({ accept: '.tmx,.xml' });
      if (!f) return;
      const text = await readText(f);
      let parsed;
      try { parsed = parseTmx(text); } catch (e) { toast('解析失败：' + e.message, 'err'); return; }
      const pairs = toPairs(parsed, { srcLang: 'en-US', tgtLang: 'zh-CN' });
      if (!pairs.length) { toast('没有找到成对内容', 'err'); return; }
      // round-trip an existing TMX through the editor
      st.en = pairs.map((p) => p.src).join('\n\n');
      st.zh = pairs.map((p) => p.tgt).join('\n\n');
      st.name = f.name.replace(/\.(tmx|xml)$/i, '');
      st.pairs = [];
      st.ran = false;
      enTa.value = st.en; zhTa.value = st.zh; nameInput.value = st.name;
      toast(`已载入 ${fmtNum(pairs.length)} 对，点「自动对齐」重新计算或直接编辑`, 'ok');
    },
  }, '从 TMX 载入');

  const run = h('button.btn.primary', {
    onclick: () => doAlign(ctx, enTa.value, zhTa.value, nameInput.value),
  }, '自动对齐');

  const demo = h('button.btn', {
    onclick: () => {
      const pair = DEMO;
      enTa.value = pair.en; zhTa.value = pair.zh;
      st.en = pair.en; st.zh = pair.zh;
      nameInput.value = pair.name; st.name = pair.name;
      toast('已填入示例，点「自动对齐」试试', 'ok');
    },
  }, '载入示例');

  return h('div',
    h('div.card',
      h('div.row', { style: { marginBottom: '10px' } },
        h('div.grow', nameInput), openPair, loadTmx, demo,
      ),
      h('div.grid2',
        h('div', h('h3', 'English'), enTa),
        h('div', h('h3', '中文'), zhTa),
      ),
      h('div.row', { style: { marginTop: '12px' } },
        run,
        h('span.tiny', '算法：段落级单调动态规划 + 块内句级对齐；编号/日期/术语标签作为锚点。'),
      ),
    ),
  );
}

function renderResult(ctx) {
  previewEl = h('div');
  rowsEl = h('div.scroll-y', { style: { border: 'none' } });

  renderRows(ctx);
  renderPreview(ctx);

  const stats = summarise();

  return h('div',
    h('div.row', { style: { marginBottom: '12px' } },
      h('div.grow',
        h('h1', { style: { margin: 0 } }, st.name || '对齐结果'),
        h('div.tiny', `${fmtNum(st.rows.filter((r) => r.paired).length)} 对 · 平均分 ${stats.avg}`),
      ),
      h('button.btn.primary', { onclick: () => saveToMemory(ctx) }, '存入记忆库'),
      h('button.btn', { onclick: () => exportAlignedTmx() }, '导出 TMX'),
      h('button.btn', { onclick: () => exportAlignedTsv() }, '导出表格'),
      h('button.btn.ghost', {
        onclick: async () => {
          if (!(await confirmDialog('返回编辑原文？当前对齐结果会丢失。'))) return;
          st.ran = false;
          ctx.refresh();
        },
      }, '返回'),
    ),
    h('div.card',
      h('div.row', { style: { marginBottom: '9px' } },
        h('span.tiny.dim', '选中一行后可用下列操作调整。未配对的灰色行不参与导出。'),
        h('span.grow'),
        h('button.btn.sm', { onclick: () => moveActive(-1) }, '↑ 上移'),
        h('button.btn.sm', { onclick: () => moveActive(1) }, '↓ 下移'),
        h('button.btn.sm', { onclick: () => adjust(ctx, -1) }, '并入上一行'),
        h('button.btn.sm', { onclick: () => adjust(ctx, 1) }, '并入下一行'),
        h('button.btn.sm', { onclick: () => splitActive(ctx) }, '拆分为两句'),
        h('button.btn.sm', { onclick: () => unlinkActive(ctx) }, '取消配对'),
        h('button.btn.sm', { onclick: () => dropActive(ctx) }, '删除该行'),
      ),
      rowsEl,
    ),
    h('div.card', h('h3', { style: { marginTop: 0 } }, '记忆库匹配预览'), previewEl),
  );
}

/* ------------------------------------------------------------------- rows */

function renderRows(ctx) {
  if (!rowsEl) return;
  const head = h('table.align-table',
    h('thead', h('tr',
      h('th', { style: { width: '34px' } }, '#'),
      h('th', { style: { width: '62px' } }, '分数'),
      h('th', 'English'),
      h('th', '中文'),
    )),
  );
  const tbody = h('tbody');
  st.rows.forEach((r, i) => {
    const tr = h('tr' + (r.paired ? '' : '.unpaired') + (i === st.active ? '.active' : ''),
      { dataset: { idx: String(i) }, onclick: () => { st.active = i; markActive(); } },
      h('td.mono', String(i + 1)),
      h('td.score-cell', r.paired
        ? h('span', h('span.score-bar', h('i', { style: { width: Math.round(r.score * 100) + '%' } })), String(Math.round(r.score * 100)))
        : h('span.mute', '—')),
      h('td', r.en),
      h('td', r.zh),
    );
    tbody.append(tr);
  });
  head.append(tbody);
  mount(rowsEl, head);
  void ctx;
}

function markActive() {
  if (!rowsEl) return;
  for (const tr of rowsEl.querySelectorAll('tbody tr')) {
    tr.classList.toggle('active', Number(tr.dataset.idx) === st.active);
  }
}

function moveActive(delta) {
  if (st.active < 0) { toast('请先点击一行', 'err'); return; }
  const next = st.active + delta;
  if (next < 0 || next >= st.rows.length) return;
  st.active = next;
  markActive();
  const tr = rowsEl.querySelector(`tbody tr[data-idx="${next}"]`);
  if (tr) tr.scrollIntoView({ block: 'nearest' });
}

function adjust(ctx, dir) {
  if (st.active < 0) { toast('请先点击一行', 'err'); return; }
  const i = st.active;
  const j = i + dir;
  if (j < 0 || j >= st.rows.length) return;
  const a = st.rows[i];
  const b = st.rows[j];
  if (dir < 0) {
    b.en = [b.en, a.en].filter(Boolean).join(' ');
    b.zh = [b.zh, a.zh].filter(Boolean).join(' ');
    b.paired = !!(b.en && b.zh);
    b.score = b.paired ? Math.min(a.score || 0, b.score || 0) : 0;
    st.rows.splice(i, 1);
    st.active = j - 1;
  } else {
    a.en = [a.en, b.en].filter(Boolean).join(' ');
    a.zh = [a.zh, b.zh].filter(Boolean).join(' ');
    a.paired = !!(a.en && a.zh);
    a.score = a.paired ? Math.min(a.score || 0, b.score || 0) : 0;
    st.rows.splice(j, 1);
    st.active = i;
  }
  renderRows(ctx);
  renderPreview(ctx);
}

/** Split a paired row into sentences and re-pair them 1:1 / by DP. */
function splitActive(ctx) {
  if (st.active < 0) { toast('请先点击一行', 'err'); return; }
  const r = st.rows[st.active];
  const es = splitSentencesEn(r.en);
  const zs = splitSentencesZh(r.zh);
  if (es.length < 2 && zs.length < 2) { toast('这一行无法再拆分', 'err'); return; }

  const { units } = buildTUs([r.en], [r.zh]);
  if (!units.length) { toast('拆分失败', 'err'); return; }

  const replacement = units.map((u) => ({
    enIndex: r.enIndex, zhIndex: r.zhIndex,
    en: u.src, zh: u.tgt, score: u.score, paired: true,
  }));
  st.rows.splice(st.active, 1, ...replacement);
  renderRows(ctx);
  renderPreview(ctx);
  toast(`已拆分为 ${replacement.length} 句`, 'ok');
}

function unlinkActive(ctx) {
  if (st.active < 0) { toast('请先点击一行', 'err'); return; }
  const r = st.rows[st.active];
  r.zh = '';
  r.paired = false;
  r.score = 0;
  renderRows(ctx);
  renderPreview(ctx);
}

function dropActive(ctx) {
  if (st.active < 0) { toast('请先点击一行', 'err'); return; }
  st.rows.splice(st.active, 1);
  st.active = Math.min(st.active, st.rows.length - 1);
  renderRows(ctx);
  renderPreview(ctx);
}

/* ---------------------------------------------------------------- preview */

function renderPreview(ctx) {
  if (!previewEl) return;
  const pairs = collectPairs();
  if (!ctx.state.index) {
    mount(previewEl, h('div.dim', '未选择记忆库，无法预览匹配。'));
    return;
  }
  if (!pairs.length) {
    mount(previewEl, h('div.dim', '还没有已配对的行。'));
    return;
  }
  const sample = pairs.slice(0, 40);
  const out = sample.map((p) => {
    let hits = [];
    try { hits = ctx.state.index.search(p.src, { limit: 2, minScore: 60 }); } catch { /* ignore */ }
    return h('div', { style: { borderBottom: '1px solid var(--line)', padding: '7px 0' } },
      h('div.tiny.mono', p.src.slice(0, 120)),
      h('div', hits.length
        ? hits.map((x) => h('div.tiny', { style: { marginTop: '3px' } },
            h('span.pill.' + scoreClass(x.score), Math.round(x.score) + '%'),
            ' ', x.unit.tgt.slice(0, 110)))
        : h('span.tiny.mute', '无相近条目——这是一条新记忆')),
    );
  });
  mount(previewEl, ...out, pairs.length > 40
    ? h('div.tiny.mute', { style: { marginTop: '8px' } }, `仅预览前 40 条，共 ${fmtNum(pairs.length)} 条`)
    : null);
}

/* ------------------------------------------------------------- the actions */

function doAlign(ctx, enText, zhText, name) {
  const en = (enText || '').trim();
  const zh = (zhText || '').trim();
  if (!en || !zh) { toast('请同时填入英文原文与中文译文', 'err'); return; }

  const enBlocks = translatableBlocks(en, 'en-US');
  const zhBlocks = translatableBlocks(zh, 'zh-CN');
  const enB = makeBlocks(enBlocks);
  const zhB = makeBlocks(zhBlocks);
  if (!enB.length || !zhB.length) { toast('没有解析出可对齐的段落', 'err'); return; }

  toast('正在对齐…');
  const pairs = alignBlocks(enB, zhB);
  const kept = pairs.filter((p) => p.score >= MIN_EMIT);

  // build editable rows: paired rows plus the leftovers from each side
  const rows = [];
  const zUsed = new Set();
  const map = new Map(kept.map((p) => [p.i, p]));
  for (let i = 0; i < enB.length; i++) {
    const p = map.get(i);
    if (p) {
      zUsed.add(p.j);
      rows.push({ enIndex: i, zhIndex: p.j, en: enB[i].text, zh: zhB[p.j].text, score: p.score, paired: true });
    } else {
      rows.push({ enIndex: i, zhIndex: null, en: enB[i].text, zh: '', score: 0, paired: false });
    }
  }
  for (let j = 0; j < zhB.length; j++) {
    if (!zUsed.has(j)) rows.push({ enIndex: null, zhIndex: j, en: '', zh: zhB[j].text, score: 0, paired: false });
  }

  st.en = enText; st.zh = zhText; st.name = name || '';
  st.enBlocks = enBlocks; st.zhBlocks = zhBlocks; st.pairs = kept;
  st.rows = rows;
  st.ran = true;
  st.active = rows.findIndex((r) => r.paired);
  ctx.refresh();
  toast(`对齐完成：${fmtNum(kept.length)} 对，${fmtNum(rows.length - kept.length)} 行未配对`, 'ok');
}

function summarise() {
  const paired = st.rows.filter((r) => r.paired);
  const avg = paired.length
    ? (paired.reduce((a, r) => a + r.score, 0) / paired.length).toFixed(3)
    : '—';
  const low = paired.filter((r) => r.score < 0.7).length;
  return { paired: paired.length, avg, low };
}

export function collectPairs() {
  return st.rows
    .filter((r) => r.paired && r.en.trim() && r.zh.trim())
    .map((r, i) => ({
      src: r.en.trim(),
      tgt: r.zh.trim(),
      tuid: `${st.name || 'align'}#${i}`,
      props: {
        'x-doc': st.name || 'align',
        'x-seg-score': Math.round(r.score * 10000) / 10000,
        'x-origin': 'manual-align',
      },
    }));
}

async function saveToMemory(ctx) {
  const pairs = collectPairs();
  if (!pairs.length) { toast('没有可保存的配对行', 'err'); return; }
  const low = pairs.filter((p) => p.props['x-seg-score'] < 0.7).length;
  if (low > 0) {
    const ok = await confirmDialog(
      `其中有 ${low} 条的自动对齐置信度低于 0.70，可能是错配。仍然全部保存吗？`);
    if (!ok) return;
  }
  await ctx.importPairs(pairs, {
    defaultName: st.name || '对齐导入',
    srcLang: 'en-US', tgtLang: 'zh-CN',
  });
}

function exportAlignedTmx() {
  const pairs = collectPairs();
  if (!pairs.length) { toast('没有可导出的配对行', 'err'); return; }
  const { xml } = buildTmx({
    units: pairs, srcLang: 'en-US', tgtLang: 'zh-CN',
    headerProps: { Project: st.name || 'RPC CAT alignment', segtype: 'sentence' },
  });
  downloadText(`${safe(st.name || 'alignment')}.tmx`, xml, 'application/xml;charset=utf-8');
  toast(`已导出 ${fmtNum(pairs.length)} 条`, 'ok');
}

function exportAlignedTsv() {
  const pairs = collectPairs();
  if (!pairs.length) { toast('没有可导出的配对行', 'err'); return; }
  const esc = (s) => String(s == null ? '' : s).replace(/\t/g, ' ').replace(/\n/g, ' ');
  const lines = ['source\ttarget\tscore\tdoc'];
  for (const p of pairs) {
    lines.push([p.src, p.tgt, p.props['x-seg-score'], p.props['x-doc']].map(esc).join('\t'));
  }
  downloadText(`${safe(st.name || 'alignment')}.tsv`, '\ufeff' + lines.join('\n'), 'text/tab-separated-values;charset=utf-8');
  toast(`已导出 ${fmtNum(pairs.length)} 行`, 'ok');
}

/* ------------------------------------------------------------------ utils */

function safe(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
}

/** Pick an English file and a Chinese file in one dialog (multi-select). */
function pickPair() {
  return new Promise((resolve) => {
    const enTa = h('textarea', { rows: 6, placeholder: '英文原文' });
    const zhTa = h('textarea', { rows: 6, placeholder: '中文译文' });
    const nameInput = h('input', { type: 'text', placeholder: '文档名称' });

    const loadBtn = h('button.btn', {
      onclick: async () => {
        const files = await pickFile({ accept: '.txt,.md,.wikidot,.htm,.html', multiple: true });
        if (!files.length) return;
        for (const f of files) {
          let text = await readText(f);
          if (/\.html?$/i.test(f.name)) text = stripHtml(text);
          const looksZh = /[\u4e00-\u9fff]/.test(text.slice(0, 400));
          if (looksZh) zhTa.value = text; else enTa.value = text;
          if (!nameInput.value) nameInput.value = f.name.replace(/\.[^.]+$/, '').replace(/([._-](en|zh|cn))$/i, '');
        }
      },
    }, '选择文件（可多选）');

    modal({
      title: '载入中英对照文本',
      wide: true,
      body: h('div',
        loadBtn,
        h('div.grid2', { style: { marginTop: '12px' } },
          h('div', h('h3', 'English'), enTa),
          h('div', h('h3', '中文'), zhTa)),
        h('div', { style: { marginTop: '10px' } }, nameInput),
      ),
      actions: [
        { label: '取消', onClick: (c) => { c(); resolve(null); } },
        {
          label: '使用',
          primary: true,
          onClick: (c) => {
            c();
            resolve({ en: enTa.value, zh: zhTa.value, name: nameInput.value || '未命名' });
          },
        },
      ],
    });
  });
}

function stripHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const sel of ['script', 'style', 'nav', 'header', 'footer', '#side-bar', '#page-tags']) {
    for (const el of doc.querySelectorAll(sel)) el.remove();
  }
  const content = doc.querySelector('#page-content') || doc.body;
  const blocks = [];
  for (const el of content.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, blockquote')) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) blocks.push(t);
  }
  return blocks.length ? blocks.join('\n\n') : (content.textContent || '').trim();
}

const DEMO = {
  name: 'RPC-691 片段（示例）',
  en: `RPC-691 is an MP4 video file distributed through various websites.

Repeated watchers and listeners incur a number of nonspecific psychological effects. Two hours of separation from RPC-691 results in acute withdrawal symptoms.

CHATLOGS RECOVERED FROM PHONES AT DISCOVERY SITE:

Today is my first day on my hypnosis journey. I've pulled up a video called "Binaural beats to make you into a raptor" made by some channel named "Kittykawaii". I've been listening for the whole day today. Starting to feel something… I think it might be working! Might just be my imagination though :P. Will update in a few days.`,
  zh: `RPC-691是一种在互联网各网站传播的MP4视频文件。

重复观看和收听会产生一系列非特异性的心理影响。与RPC-691分离两小时即会导致急性戒断症状。

从发现现场手机中恢复的聊天记录：

今天是我催眠之旅的第一天。我打开了一个叫“Kittykawaii”的频道制作的视频，标题是“让你变成迅猛龙的双耳节拍”。我听了一整天。开始感觉到什么了……我觉得可能有效！不过也许只是我的想象 :P。过几天再来更新。`,
};
