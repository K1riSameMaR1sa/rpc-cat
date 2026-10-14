/**
 * views/memory.js — manage translation memories: browse, search, edit, delete,
 * create, merge/dedupe and export.
 */

import * as db from '../db.js';
import { buildTmx } from '../tmx.js';
import { normalize } from '../match.js';
import {
  h, mount, toast, modal, confirmDialog, promptDialog, downloadText,
  fmtNum, fmtDate, debounce,
} from '../ui.js';

const PAGE = 100;

const st = {
  query: '',
  offset: 0,
  rows: [],
  total: 0,
  selected: new Set(),
  searching: false,
  hits: null,
};

let bodyEl = null;

/* ------------------------------------------------------------------ render */

export function render(ctx) {
  st.selected.clear();
  const { state } = ctx;

  const wrap = h('div');
  wrap.append(h('h1', '记忆库'));
  wrap.append(h('p.sub', '导入、检索、编辑与导出翻译记忆。所有内容保存在本机浏览器中。'));

  if (!state.memories.length) {
    wrap.append(h('div.empty',
      h('p', '还没有记忆库。'),
      h('div.row', { style: { justifyContent: 'center', marginTop: '10px' } },
        h('button.btn.primary', { onclick: () => createMemory(ctx) }, '新建空记忆库'),
        h('button.btn', { onclick: () => ctx.setView('align') }, '去「对齐制作」生成'),
      ),
    ));
    return wrap;
  }

  wrap.append(renderToolbar(ctx));
  wrap.append(renderStats(ctx));

  bodyEl = h('div');
  wrap.append(bodyEl);
  refreshRows(ctx);
  return wrap;
}

function renderToolbar(ctx) {
  const mem = ctx.state.activeMemory;
  const isSession = !!mem.session;
  const input = h('input', {
    type: 'search',
    placeholder: '检索源文或译文…（支持正则，格式 /pattern/）',
    value: st.query,
    style: { minWidth: '260px' },
  });
  const run = debounce(() => { st.query = input.value; st.offset = 0; refreshRows(ctx); }, 260);
  input.addEventListener('input', run);

  const actions = isSession
    ? [
        h('button.btn', { onclick: () => { ctx.clearSessionMemory(); ctx.refresh(); } },
          '清除临时记忆库'),
        h('button.btn', { onclick: () => ctx.setView('settings') }, '去设置里写入'),
      ]
    : [
        h('button.btn', { onclick: () => createMemory(ctx) }, '新建'),
        h('button.btn', { onclick: () => renameMemory(ctx) }, '重命名'),
        h('button.btn', { onclick: () => addUnitDialog(ctx) }, '+ 添加'),
        h('button.btn', { onclick: () => exportDialog(ctx) }, '导出'),
        h('button.btn', { onclick: () => toolsDialog(ctx) }, '工具'),
        h('button.btn.danger', { onclick: () => deleteMemory(ctx) }, '删除'),
      ];

  return h('div.card',
    h('div.row',
      h('div', h('strong', mem ? mem.name : ''),
        h('div.tiny', mem
          ? `${mem.srcLang} → ${mem.tgtLang}${mem.session
              ? ' · 只存在于内存中，关闭页面即消失'
              : (mem.note ? ' · ' + mem.note : '')}`
          : '')),
      h('span.grow'),
      input,
      ...actions,
    ),
    isSession
      ? h('p.tiny.mute', { style: { marginTop: '8px' } },
          '临时记忆库不能修改——它没有写进数据库。若想长期保留，'
          + '到「设置 → 总记忆库」改选「写入本机记忆库」。')
      : null,
  );
}

function renderStats(ctx) {
  const mem = ctx.state.activeMemory;
  const idx = ctx.state.index;
  const s = idx ? idx.stats() : null;
  const cards = [
    ['翻译单元', mem ? fmtNum(mem.count) : '0'],
    ['不同源句', s ? fmtNum(s.distinctSources) : '—'],
    ['重复源句', s ? fmtNum(s.duplicateSources) : '—'],
    ['索引词条', s ? fmtNum(s.distinctTokens) : '—'],
    ['建立时间', mem ? fmtDate(mem.createdAt) : '—'],
  ];
  return h('div.card', h('div.stat-grid',
    ...cards.map(([k, v]) => h('div.stat', h('div.v', v), h('div.k', k)))));
}

/* -------------------------------------------------------------------- rows */

async function refreshRows(ctx) {
  if (!bodyEl) return;
  const mem = ctx.state.activeMemory;
  if (!mem) return;
  mount(bodyEl, h('div.loading', '读取中'));

  const isSession = !!mem.session;

  try {
    if (st.query.trim()) {
      const q = st.query.trim();
      const isRegex = q.length > 2 && q.startsWith('/') && q.endsWith('/');
      const needle = isRegex ? q.slice(1, -1) : q;
      let hits;
      if (ctx.state.index) {
        hits = ctx.state.index.concordance(needle, {
          regex: isRegex, limit: 800, field: 'both',
        });
        st.rows = hits.map((x) => ({
          id: x.unit.id, src: x.unit.src, tgt: x.unit.tgt, doc: x.unit.doc,
        }));
        st.total = st.rows.length;
      } else {
        st.rows = [];
        st.total = 0;
      }
      st.searching = true;
    } else if (isSession) {
      // A session memory exists only in the page — there is nothing in
      // IndexedDB to page through, so browse the in-memory units directly.
      const all = ctx.state.session.units;
      st.rows = all.slice(st.offset, st.offset + PAGE)
        .map((u, i) => ({ id: `s${st.offset + i}`, src: u.src, tgt: u.tgt, doc: u.doc }));
      st.total = all.length;
      st.searching = false;
    } else {
      st.rows = await db.getUnits(mem.id, { offset: st.offset, limit: PAGE });
      st.total = mem.count;
      st.searching = false;
    }
  } catch (err) {
    mount(bodyEl, h('div.card', '读取失败：' + err.message));
    return;
  }

  renderTable(ctx);
}

function renderTable(ctx) {
  if (!bodyEl) return;
  const rows = st.rows;
  if (!rows.length) {
    mount(bodyEl, h('div.empty', st.query ? '没有匹配的条目' : '这个记忆库还是空的'));
    return;
  }

  const allChecked = rows.every((r) => st.selected.has(r.id));
  const head = h('thead', h('tr',
    h('th', { style: { width: '34px' } },
      h('input', {
        type: 'checkbox', checked: allChecked, style: { width: 'auto' },
        onchange: (e) => {
          for (const r of rows) {
            if (e.target.checked) st.selected.add(r.id); else st.selected.delete(r.id);
          }
          renderTable(ctx);
        },
      })),
    h('th', { style: { width: '68px' } }, '操作'),
    h('th', '源文'),
    h('th', '译文'),
    h('th', { style: { width: '130px' } }, '来源'),
  ));

  const tbody = h('tbody');
  const isSession = !!ctx.state.activeMemory.session;
  for (const r of rows) {
    tbody.append(h('tr',
      h('td', h('input', {
        type: 'checkbox', checked: st.selected.has(r.id), style: { width: 'auto' },
        disabled: isSession,
        onchange: (e) => {
          if (e.target.checked) st.selected.add(r.id); else st.selected.delete(r.id);
          updateBulkBar(ctx);
        },
      })),
      h('td', h('div.row.tight',
        isSession
          ? h('span.tiny.mute', '只读')
          : h('button.btn.sm', { onclick: () => editUnit(ctx, r) }, '改'),
        isSession
          ? null
          : h('button.btn.sm.danger', { onclick: () => removeUnit(ctx, r) }, '删'),
      )),
      h('td', r.src),
      h('td', r.tgt),
      h('td.tiny.mute', r.doc || ''),
    ));
  }
  head.append(tbody);

  const table = h('table.data', head);
  const bar = h('div.row', { id: 'bulkBar', style: { marginBottom: '9px' } });
  const pager = st.searching
    ? h('div.tiny.mute', { style: { marginTop: '9px' } }, `检索到 ${fmtNum(st.total)} 条（最多显示 800 条）`)
    : h('div.row', { style: { marginTop: '10px' } },
        h('button.btn.sm', {
          disabled: st.offset === 0,
          onclick: () => { st.offset = Math.max(0, st.offset - PAGE); refreshRows(ctx); },
        }, '← 上一页'),
        h('span.tiny', `${fmtNum(st.offset + 1)}–${fmtNum(st.offset + rows.length)} / ${fmtNum(st.total)}`),
        h('button.btn.sm', {
          disabled: st.offset + PAGE >= st.total,
          onclick: () => { st.offset += PAGE; refreshRows(ctx); },
        }, '下一页 →'),
      );

  mount(bodyEl, h('div.card', bar, h('div.scroll-y', table), pager));
  updateBulkBar(ctx);
}

function updateBulkBar(ctx) {
  const bar = document.getElementById('bulkBar');
  if (!bar) return;
  const isSession = !!ctx.state.activeMemory.session;
  if (isSession) { mount(bar); return; }
  const n = st.selected.size;
  mount(bar,
    h('span.tiny.dim', n ? `已选 ${fmtNum(n)} 条` : '勾选后可批量操作'),
    h('span.grow'),
    n ? h('button.btn.sm.danger', { onclick: () => bulkDelete(ctx) }, `删除所选 ${fmtNum(n)} 条`) : null,
    n ? h('button.btn.sm', { onclick: () => bulkMove(ctx) }, '移动到其它记忆库') : null,
  );
}

/* ----------------------------------------------------------------- actions */

async function createMemory(ctx) {
  const name = await promptDialog({ title: '新建记忆库', label: '名称', placeholder: '例如：RPC 主站对照' });
  if (!name) return;
  const id = await db.createMemory({ name, srcLang: 'en-US', tgtLang: 'zh-CN' });
  await ctx.refreshMemories();
  await ctx.setActiveMemory(id);
  st.query = ''; st.offset = 0;
  toast('已创建', 'ok');
  ctx.refresh();
}

async function renameMemory(ctx) {
  const mem = ctx.state.activeMemory;
  if (!mem) return;
  const name = await promptDialog({ title: '重命名记忆库', label: '名称', value: mem.name });
  if (!name) return;
  await db.updateMemory(mem.id, { name });
  await ctx.refreshMemories();
  toast('已重命名', 'ok');
  ctx.refresh();
}

async function deleteMemory(ctx) {
  const mem = ctx.state.activeMemory;
  if (!mem) return;
  const ok = await confirmDialog(
    `删除记忆库「${mem.name}」及其 ${fmtNum(mem.count)} 条单元？此操作不可撤销。建议先导出 TMX 备份。`,
    { danger: true, okLabel: '删除' });
  if (!ok) return;
  await db.deleteMemory(mem.id);
  await ctx.refreshMemories();
  toast('已删除', 'ok');
  ctx.refresh();
}

async function editUnit(ctx, row) {
  const src = h('textarea', { rows: 3, value: row.src });
  const tgt = h('textarea', { rows: 3, value: row.tgt });
  const docIn = h('input', { type: 'text', value: row.doc || '', placeholder: '来源标识（可选）' });
  modal({
    title: '编辑条目',
    wide: true,
    body: h('div',
      h('h3', '源文'), src,
      h('h3', { style: { marginTop: '12px' } }, '译文'), tgt,
      h('h3', { style: { marginTop: '12px' } }, '来源'), docIn,
    ),
    actions: [
      { label: '取消', onClick: (c) => c() },
      {
        label: '保存',
        primary: true,
        onClick: async (c) => {
          await db.updateUnit(row.id, { src: src.value, tgt: tgt.value, doc: docIn.value });
          c();
          await ctx.loadActiveIndex({ silent: true });
          toast('已保存', 'ok');
          refreshRows(ctx);
        },
      },
    ],
  });
}

async function removeUnit(ctx, row) {
  await db.deleteUnit(row.id);
  st.selected.delete(row.id);
  await ctx.refreshMemories();
  await ctx.loadActiveIndex({ silent: true });
  toast('已删除', 'ok');
  refreshRows(ctx);
}

async function bulkDelete(ctx) {
  const n = st.selected.size;
  if (!n) return;
  const ok = await confirmDialog(`删除选中的 ${fmtNum(n)} 条？`, { danger: true, okLabel: '删除' });
  if (!ok) return;
  await db.deleteUnits([...st.selected]);
  st.selected.clear();
  await ctx.refreshMemories();
  await ctx.loadActiveIndex({ silent: true });
  toast(`已删除 ${fmtNum(n)} 条`, 'ok');
  refreshRows(ctx);
}

async function bulkMove(ctx) {
  const n = st.selected.size;
  if (!n) return;
  const others = ctx.state.memories.filter((m) => m.id !== ctx.state.activeMemoryId);
  if (!others.length) { toast('没有其它记忆库', 'err'); return; }
  const sel = h('select', ...others.map((m) => h('option', { value: String(m.id) }, `${m.name} (${fmtNum(m.count)})`)));
  modal({
    title: `移动 ${fmtNum(n)} 条到`,
    body: sel,
    actions: [
      { label: '取消', onClick: (c) => c() },
      {
        label: '移动',
        primary: true,
        onClick: async (c) => {
          const targetId = Number(sel.value);
          const rows = ctx.state.index
            ? ctx.state.index.units.filter((u) => st.selected.has(u.id))
            : [];
          const units = rows.map((u) => ({ src: u.src, tgt: u.tgt, doc: u.doc, props: u.props }));
          c();
          if (!units.length) { toast('无法读取所选条目', 'err'); return; }
          await db.addUnits(targetId, units.map((u) => ({ ...u, srcNorm: db.normSrc(u.src) })));
          await db.deleteUnits([...st.selected]);
          st.selected.clear();
          await ctx.refreshMemories();
          await ctx.loadActiveIndex({ silent: true });
          toast(`已移动 ${fmtNum(units.length)} 条`, 'ok');
          refreshRows(ctx);
        },
      },
    ],
  });
}

function addUnitDialog(ctx) {
  const src = h('textarea', { rows: 3, placeholder: '源文（英文）' });
  const tgt = h('textarea', { rows: 3, placeholder: '译文（中文）' });
  const docIn = h('input', { type: 'text', placeholder: '来源标识（可选）' });
  modal({
    title: '手动添加条目',
    wide: true,
    body: h('div',
      h('h3', '源文'), src,
      h('h3', { style: { marginTop: '12px' } }, '译文'), tgt,
      h('h3', { style: { marginTop: '12px' } }, '来源'), docIn,
    ),
    actions: [
      { label: '取消', onClick: (c) => c() },
      {
        label: '添加',
        primary: true,
        onClick: async (c) => {
          if (!src.value.trim() || !tgt.value.trim()) { toast('源文与译文都不能为空', 'err'); return; }
          c();
          await db.addUnits(ctx.state.activeMemoryId, [{
            src: src.value.trim(), tgt: tgt.value.trim(),
            srcNorm: db.normSrc(src.value), doc: docIn.value,
          }]);
          await ctx.refreshMemories();
          await ctx.loadActiveIndex({ silent: true });
          toast('已添加', 'ok');
          refreshRows(ctx);
        },
      },
    ],
  });
}

function exportDialog(ctx) {
  const mem = ctx.state.activeMemory;
  modal({
    title: '导出记忆库',
    body: h('div',
      h('p.dim', `「${mem.name}」共 ${fmtNum(mem.count)} 条单元。`),
      h('div.row',
        h('button.btn.primary', {
          onclick: async (c) => { c(); await exportAs(ctx, 'tmx'); },
        }, 'TMX（翻译记忆标准格式）'),
        h('button.btn', { onclick: async (c) => { c(); await exportAs(ctx, 'csv'); } }, 'CSV'),
        h('button.btn', { onclick: async (c) => { c(); await exportAs(ctx, 'json'); } }, 'JSON'),
      ),
      h('p.tiny', { style: { marginTop: '12px' } },
        'TMX 可直接导入 Trados、memoQ、OmegaT、CafeTran 等 CAT 工具。'),
    ),
  });
}

async function exportAs(ctx, format) {
  await ctx.exportActiveMemory(format);
}

async function toolsDialog(ctx) {
  const mem = ctx.state.activeMemory;
  const dupes = countDuplicates(ctx);
  modal({
    title: '工具',
    body: h('div',
      h('h3', { style: { marginTop: 0 } }, '去重'),
      h('p.dim', `当前记忆库有 ${fmtNum(dupes.sameSrcSameTgt)} 条完全重复（源文与译文都相同），`
        + `${fmtNum(dupes.sameSrcDiffTgt)} 组同一源文存在多个不同译文。`),
      h('button.btn', {
        onclick: async (c) => {
          c();
          await dedupeExact(ctx);
        },
      }, '删除完全重复的条目'),
      h('hr.sep'),
      h('h3', '重建索引'),
      h('p.dim', '编辑大量条目后，检索索引可能与数据库不同步。'),
      h('button.btn', {
        onclick: async (c) => { c(); await ctx.loadActiveIndex(); },
      }, '重建当前记忆库索引'),
      h('hr.sep'),
      h('h3', '统计'),
      h('p.tiny', `记忆库 ID：${mem.id} · 创建于 ${fmtDate(mem.createdAt)}`),
    ),
  });
}

function countDuplicates(ctx) {
  const idx = ctx.state.index;
  if (!idx) return { sameSrcSameTgt: 0, sameSrcDiffTgt: 0 };
  const bySrc = new Map();
  for (const u of idx.units) {
    const k = normalize(u.src);
    let list = bySrc.get(k);
    if (!list) { list = []; bySrc.set(k, list); }
    list.push(u.tgt);
  }
  let sameSrcSameTgt = 0;
  let sameSrcDiffTgt = 0;
  for (const list of bySrc.values()) {
    if (list.length > 1) {
      const uniq = new Set(list);
      sameSrcSameTgt += list.length - uniq.size;
      if (uniq.size > 1) sameSrcDiffTgt += 1;
    }
  }
  return { sameSrcSameTgt, sameSrcDiffTgt };
}

async function dedupeExact(ctx) {
  const idx = ctx.state.index;
  if (!idx) { toast('索引未就绪', 'err'); return; }
  const seen = new Set();
  const remove = [];
  for (const u of idx.units) {
    const k = normalize(u.src) + '\u0000' + u.tgt;
    if (seen.has(k)) remove.push(u.id);
    else seen.add(k);
  }
  if (!remove.length) { toast('没有完全重复的条目', 'ok'); return; }
  const ok = await confirmDialog(`将删除 ${fmtNum(remove.length)} 条完全重复的条目，继续？`,
    { danger: true, okLabel: '删除' });
  if (!ok) return;
  await db.deleteUnits(remove);
  await ctx.refreshMemories();
  await ctx.loadActiveIndex({ silent: true });
  toast(`已删除 ${fmtNum(remove.length)} 条`, 'ok');
  refreshRows(ctx);
}
