/**
 * app.js — application shell: state, routing, memory loading, import/export.
 */

import * as db from './db.js';
import { parseTmx, buildTmx, toPairs } from './tmx.js';
import { MemoryIndex } from './match.js';
import {
  h, mount, toast, modal, confirmDialog, downloadText, pickFile, readText,
  fmtNum, fmtBytes,
} from './ui.js';

import * as workbench from './views/workbench.js';
import * as alignView from './views/align.js';
import * as memoryView from './views/memory.js';
import * as corpusView from './views/corpus.js';
import * as settingsView from './views/settings.js';

const VIEWS = {
  workbench,
  align: alignView,
  memory: memoryView,
  corpus: corpusView,
  settings: settingsView,
};

export const state = {
  memories: [],
  activeMemoryId: null,
  activeMemory: null,
  index: null,          // MemoryIndex for the active memory
  indexBuilding: false,
  view: 'workbench',
};

/* ------------------------------------------------------------------ events */

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit() { for (const fn of listeners) fn(); }

/* ------------------------------------------------------------- memory load */

export async function refreshMemories({ keepActive = true } = {}) {
  state.memories = await db.listMemories();
  if (!keepActive || !state.memories.some((m) => m.id === state.activeMemoryId)) {
    state.activeMemoryId = state.memories.length ? state.memories[0].id : null;
  }
  state.activeMemory = state.memories.find((m) => m.id === state.activeMemoryId) || null;
  renderMemoryPicker();
  await updateStorageStat();
  emit();
}

/**
 * Load the active memory into memory and build the fuzzy index.
 * The shipped memory is ~29k units; this takes a moment, so it is announced.
 */
export async function loadActiveIndex({ silent = false } = {}) {
  if (!state.activeMemoryId) {
    state.index = null;
    emit();
    return;
  }
  const mem = state.activeMemory;
  if (!silent) toast(`正在载入记忆库「${mem ? mem.name : ''}」…`);
  state.indexBuilding = true;
  emit();
  try {
    const rows = await db.getAllUnits(state.activeMemoryId);
    const units = rows.map((r) => ({
      src: r.src, tgt: r.tgt, id: r.id, doc: r.doc, props: r.props || {},
    }));
    state.index = new MemoryIndex(units);
    if (!silent) {
      toast(`记忆库已就绪：${fmtNum(units.length)} 条翻译单元`, 'ok');
    }
  } catch (err) {
    console.error(err);
    toast('载入记忆库失败：' + err.message, 'err');
    state.index = null;
  } finally {
    state.indexBuilding = false;
    emit();
  }
}

export async function setActiveMemory(id, { reload = true } = {}) {
  state.activeMemoryId = id;
  state.activeMemory = state.memories.find((m) => m.id === id) || null;
  renderMemoryPicker();
  emit();
  if (reload) await loadActiveIndex();
}

/* ------------------------------------------------------------------- shell */

function renderMemoryPicker() {
  const sel = document.getElementById('activeMemory');
  if (!sel) return;
  mount(sel, ...(state.memories.length
    ? state.memories.map((m) => h('option', {
        value: String(m.id),
        selected: m.id === state.activeMemoryId,
      }, `${m.name} (${fmtNum(m.count)})`))
    : [h('option', { value: '' }, '（暂无记忆库）')]));
  sel.value = state.activeMemoryId == null ? '' : String(state.activeMemoryId);
}

async function updateStorageStat() {
  const el = document.getElementById('storageStat');
  if (!el) return;
  const total = state.memories.reduce((a, m) => a + (m.count || 0), 0);
  const u = await db.usage();
  mount(el,
    h('div', `${state.memories.length} 个记忆库`),
    h('div', `${fmtNum(total)} 条单元`),
    u && u.quota ? h('div.mute', `已用 ${fmtBytes(u.usage)} / ${fmtBytes(u.quota)}`) : null);
}

export function renderView() {
  const host = document.getElementById('view');
  if (!host) return;
  const mod = VIEWS[state.view] || VIEWS.workbench;
  let node;
  try {
    node = mod.render({
      state,
      refreshMemories,
      loadActiveIndex,
      setActiveMemory,
      refresh: () => renderView(),
      importPairs: doImport,
      importTmxFile,
      exportActiveMemory,
      setView,
    });
  } catch (err) {
    console.error(err);
    node = h('div.card', h('h2', '视图渲染出错'), h('pre.mono', String(err && err.stack || err)));
  }
  mount(host, node);
}

function setView(name) {
  state.view = name;
  for (const b of document.querySelectorAll('.nav-item')) {
    b.classList.toggle('active', b.dataset.view === name);
  }
  renderView();
}

/* ---------------------------------------------------------- import / export */

export async function importTmxFile(file) {
  const text = await readText(file);
  let parsed;
  try {
    parsed = parseTmx(text);
  } catch (err) {
    toast('TMX 解析失败：' + err.message, 'err');
    return;
  }
  if (!parsed.units.length) {
    toast('该 TMX 中没有找到翻译单元', 'err');
    return;
  }

  // figure out the language pair from the data
  const langs = new Map();
  for (const u of parsed.units.slice(0, 400)) {
    for (const t of u.tuvs || []) {
      if (t.lang) langs.set(t.lang, (langs.get(t.lang) || 0) + 1);
    }
  }
  const ranked = [...langs.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  const srcLang = ranked[0] || 'en-US';
  const tgtLang = ranked[1] || 'zh-CN';

  const pairs = toPairs(parsed, { srcLang, tgtLang });
  if (!pairs.length) {
    toast('TMX 中的单元缺少源语或目标语文本', 'err');
    return;
  }

  await doImport(pairs, {
    defaultName: file.name.replace(/\.(tmx|xml)$/i, '') || 'Imported TM',
    srcLang, tgtLang,
  });
}

/**
 * Import pairs, either into a new memory or appended to an existing one.
 */
export async function doImport(pairs, { defaultName, srcLang, tgtLang }) {
  let mode = 'new';

  const newNameInput = h('input', { type: 'text', value: defaultName, placeholder: '记忆库名称' });
  const existingSel = h('select', ...state.memories.map((m) => h('option', { value: String(m.id) }, `${m.name} (${fmtNum(m.count)})`)));
  const dedupeBox = h('input', { type: 'checkbox', checked: true, style: { width: 'auto' } });

  const radioNew = h('input', { type: 'radio', name: 'imp', checked: true, style: { width: 'auto' }, onchange: () => { mode = 'new'; sync(); } });
  const radioAdd = h('input', { type: 'radio', name: 'imp', style: { width: 'auto' }, onchange: () => { mode = 'add'; sync(); } });
  const newRow = h('div.row', radioNew, h('span', '新建记忆库'), newNameInput);
  const addRow = h('div.row', radioAdd, h('span', '并入已有'), existingSel);
  function sync() {
    newNameInput.disabled = mode !== 'new';
    existingSel.disabled = mode !== 'add';
    if (state.memories.length === 0) { radioAdd.disabled = true; existingSel.disabled = true; }
  }
  if (!state.memories.length) { radioAdd.disabled = true; existingSel.disabled = true; }
  sync();

  const body = h('div',
    h('p.dim', `共解析到 ${fmtNum(pairs.length)} 条翻译单元（${srcLang} → ${tgtLang}）。`),
    newRow, addRow,
    h('label.row', { style: { marginTop: '10px' } }, dedupeBox,
      h('span', '跳过源文重复的条目（保留已有译文）')),
    h('p.tiny', '导入后可用「记忆库」页导出为 TMX、CSV 或 JSON。'),
  );

  const ok = await new Promise((resolve) => {
    modal({
      title: '导入翻译记忆',
      body,
      actions: [
        { label: '取消', onClick: (close) => { close(); resolve(false); } },
        {
          label: '导入',
          primary: true,
          onClick: (close) => { close(); resolve(true); },
        },
      ],
    });
  });
  if (!ok) return;

  let memoryId;
  if (mode === 'new') {
    memoryId = await db.createMemory({
      name: newNameInput.value.trim() || defaultName,
      srcLang, tgtLang,
      note: `导入自 ${defaultName}`,
    });
  } else {
    memoryId = Number(existingSel.value);
  }

  let units = pairs.map((p) => ({ src: p.src, tgt: p.tgt, srcNorm: db.normSrc(p.src), props: p.props || {}, doc: (p.props && p.props['x-doc']) || '' }));

  // de-duplicate against what is already stored, and within the batch
  const seen = new Set();
  units = units.filter((u) => {
    if (!u.src || !u.tgt) return false;
    const k = u.srcNorm + '\u0000' + u.tgt;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  toast(`正在写入 ${fmtNum(units.length)} 条…`);
  await db.addUnits(memoryId, units, (done, total) => {
    if (done % 15000 === 0) toast(`写入中 ${fmtNum(done)} / ${fmtNum(total)}`);
  });

  await refreshMemories();
  await setActiveMemory(memoryId);
  toast(`导入完成：${fmtNum(units.length)} 条单元`, 'ok');
  emit();
}

export async function exportActiveMemory(format = 'tmx') {
  if (!state.activeMemoryId) { toast('请先选择一个记忆库', 'err'); return; }
  const mem = state.activeMemory;
  toast('正在读取记忆库…');
  const rows = await db.getAllUnits(state.activeMemoryId);
  if (!rows.length) { toast('该记忆库为空', 'err'); return; }
  const safeName = (mem.name || 'memory').replace(/[\\/:*?"<>|]+/g, '_');

  if (format === 'tmx') {
    const { xml } = buildTmx({
      units: rows.map((r) => ({
        src: r.src, tgt: r.tgt,
        tuid: `${r.doc || 'unit'}#${r.id}`,
        props: r.props || {},
      })),
      srcLang: mem.srcLang,
      tgtLang: mem.tgtLang,
      headerProps: { Project: mem.name, Note: mem.note || '' },
    });
    downloadText(`${safeName}.tmx`, xml, 'application/xml;charset=utf-8');
  } else if (format === 'csv') {
    const esc = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
    const lines = ['source,target,doc,id'];
    for (const r of rows) lines.push([r.src, r.tgt, r.doc || '', r.id].map(esc).join(','));
    downloadText(`${safeName}.csv`, '\ufeff' + lines.join('\n'), 'text/csv;charset=utf-8');
  } else {
    downloadText(`${safeName}.json`, JSON.stringify(rows.map((r) => ({
      src: r.src, tgt: r.tgt, doc: r.doc, props: r.props,
    })), null, 1), 'application/json;charset=utf-8');
  }
  toast(`已导出 ${fmtNum(rows.length)} 条`, 'ok');
}

/* ------------------------------------------------------------------- start */

async function firstRunCheck() {
  if (state.memories.length) return;

  // The bundled single-file build embeds the demo memory, because fetch() is
  // blocked when a page is opened from the filesystem.
  const loadDemoText = async () => {
    if (typeof globalThis.__RPC_CAT_DEMO_TMX === 'string' && globalThis.__RPC_CAT_DEMO_TMX) {
      return globalThis.__RPC_CAT_DEMO_TMX;
    }
    const res = await fetch('data/demo-tm.tmx');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  };

  let available = false;
  try {
    if (typeof globalThis.__RPC_CAT_DEMO_TMX === 'string' && globalThis.__RPC_CAT_DEMO_TMX) {
      available = true;
    } else {
      const res = await fetch('data/demo-tm.tmx', { method: 'HEAD' });
      available = res.ok;
    }
  } catch { available = false; }
  if (!available) return;

  const loadDemo = async () => {
    try {
      const text = await loadDemoText();
      const parsed = parseTmx(text);
      const pairs = toPairs(parsed, { srcLang: 'en-US', tgtLang: 'zh-CN' });
      await doImport(pairs, {
        defaultName: 'RPC Authority 示例记忆库',
        srcLang: 'en-US', tgtLang: 'zh-CN',
      });
    } catch (err) {
      toast('载入示例失败：' + err.message, 'err');
    }
  };

  modal({
    title: '开始使用',
    body: h('div',
      h('p', '还没有任何记忆库。你可以：'),
      h('ul', { style: { paddingLeft: '20px', color: 'var(--text-dim)' } },
        h('li', '导入自己的 TMX（顶部「导入 TMX」）'),
        h('li', '在「对齐制作」里粘贴中英原文，自动生成 TMX'),
        h('li', '载入内置的 RPC Authority 示例记忆库试用')),
      h('p.tiny', '全部数据只保存在你自己的浏览器里，不会上传到任何服务器。'),
    ),
    actions: [
      { label: '稍后', onClick: (close) => close() },
      {
        label: '载入示例记忆库',
        primary: true,
        onClick: async (close) => { close(); await loadDemo(); },
      },
    ],
  });
}

export async function main() {
  // Signals to the boot watchdog in index.html that the scripts actually ran.
  globalThis.__rpcCatBooted = true;

  try {
    await db.openDb();
  } catch (err) {
    document.getElementById('view').append(
      h('div.card', h('h2', '无法初始化本地数据库'), h('p', err.message),
        h('p.tiny', '若使用无痕模式或禁用了本地存储，请改用普通窗口。')));
    return;
  }

  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  }
  document.getElementById('activeMemory').addEventListener('change', (e) => {
    const id = e.target.value ? Number(e.target.value) : null;
    setActiveMemory(id);
  });
  document.getElementById('btnImportTmx').addEventListener('click', async () => {
    const f = await pickFile({ accept: '.tmx,.xml' });
    if (f) await importTmxFile(f);
  });
  document.getElementById('btnExportTmx').addEventListener('click', () => exportActiveMemory('tmx'));
  document.getElementById('btnHelp').addEventListener('click', showHelp);

  // Re-render when something a view actually depends on changes — the active
  // memory, or whether the fuzzy index has finished building.  Without this the
  // workbench would keep showing "no matches" until the user touched something.
  let lastKey = '';
  subscribe(() => {
    const key = [
      state.view,
      state.activeMemoryId,
      state.indexBuilding ? 1 : 0,
      state.index ? state.index.size : -1,
      state.memories.map((m) => `${m.id}:${m.count}`).join(','),
    ].join('|');
    if (key === lastKey) return;
    lastKey = key;
    renderView();
  });

  await refreshMemories();
  renderView();
  await firstRunCheck();
  if (state.activeMemoryId) await loadActiveIndex({ silent: true });
}

function showHelp() {
  modal({
    wide: true,
    title: '使用说明',
    body: h('div',
      h('h3', '工作台'),
      h('p.dim', '粘贴英文原文（支持 Wikidot 语法），系统按句切分，并为每一句自动从记忆库中查找匹配（100% 精确 + 模糊匹配）。填入译文后按 Ctrl+Enter 确认并跳到下一句。译文只保存在浏览器里。'),
      h('h3', '对齐制作'),
      h('p.dim', '分别粘贴英文原文与中文译文，点「自动对齐」。算法按段落、再按句子做单调对齐；可以手动合并/拆分/改配，确认后直接存入记忆库或导出 TMX。'),
      h('h3', '记忆库'),
      h('p.dim', '导入/导出 TMX，检索、编辑、删除条目，查看统计，合并去重。'),
      h('h3', '语料库'),
      h('p.dim', '管理翻译项目（双语对照），可继续翻译、导出 TMX 或纯译文。'),
      h('h3', '快捷键'),
      h('ul', { style: { paddingLeft: '20px', color: 'var(--text-dim)' } },
        h('li', 'Ctrl+Enter — 确认当前句并跳到下一句'),
        h('li', 'Alt+↑ / Alt+↓ — 上一句 / 下一句'),
        h('li', 'Ctrl+K — 打开查证检索'),
        h('li', 'Esc — 关闭弹窗'),
      ),
      h('h3', '隐私'),
      h('p.dim', '所有数据保存在浏览器的 IndexedDB 中，不会上传。清除浏览器数据会一并删除，请定期用「导出 TMX」备份。'),
    ),
    actions: [{ label: '知道了', primary: true }],
  });
}

main();
