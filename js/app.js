/**
 * app.js — application shell: state, routing, memory loading, import/export.
 */

import * as db from './db.js';
import { parseTmx, buildTmx, toPairs } from './tmx.js';
import { MemoryIndex } from './match.js';
import { loadConfig, openMasterGate, readMaybeGzip, masterAvailable } from './master.js';
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
  config: null,         // data/config.json (licence text, admin hash, master info)
  session: null,        // master memory held in memory only, never written
};

export const SESSION_ID = '__session__';

/* ------------------------------------------------------------------ events */

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit() { for (const fn of listeners) fn(); }

/* ------------------------------------------------------------- memory load */

export async function refreshMemories({ keepActive = true } = {}) {
  state.memories = await db.listMemories();
  const valid = state.memories.some((m) => m.id === state.activeMemoryId)
    || (state.activeMemoryId === SESSION_ID && state.session);
  if (!keepActive || !valid) {
    state.activeMemoryId = state.session
      ? SESSION_ID
      : (state.memories.length ? state.memories[0].id : null);
  }
  state.activeMemory = state.activeMemoryId === SESSION_ID
    ? sessionAsMemory()
    : (state.memories.find((m) => m.id === state.activeMemoryId) || null);
  renderMemoryPicker();
  await updateStorageStat();
  emit();
}

function sessionAsMemory() {
  const s = state.session;
  if (!s) return null;
  return {
    id: SESSION_ID,
    name: `${s.name}（临时，未写入）`,
    srcLang: s.srcLang,
    tgtLang: s.tgtLang,
    note: '只存在于内存中，关闭页面即消失',
    count: s.units.length,
    session: true,
  };
}

/**
 * Hold a memory in the page only — nothing touches IndexedDB.  Used for the
 * "只本次使用，不写入" choice in the master-memory gate.
 */
export async function loadSessionMemory(pairs, meta) {
  state.indexBuilding = true;
  emit();
  try {
    const units = pairs.map((p) => ({
      src: p.src, tgt: p.tgt, id: null, doc: (p.props && p.props['x-doc']) || '', props: p.props || {},
    }));
    state.session = {
      name: meta.name || '总记忆库',
      srcLang: meta.srcLang || 'en-US',
      tgtLang: meta.tgtLang || 'zh-CN',
      units,
      index: new MemoryIndex(units),
    };
    state.activeMemoryId = SESSION_ID;
    state.activeMemory = sessionAsMemory();
    renderMemoryPicker();
    await updateStorageStat();
    toast(`临时记忆库已就绪：${fmtNum(units.length)} 条（未写入本机）`, 'ok');
  } finally {
    state.indexBuilding = false;
    emit();
  }
}

export function clearSessionMemory() {
  state.session = null;
  if (state.activeMemoryId === SESSION_ID) state.activeMemoryId = null;
  refreshMemories();
}

/**
 * Load the active memory into memory and build the fuzzy index.
 * The shipped memory is ~29k units; this takes a moment, so it is announced.
 */
export async function loadActiveIndex({ silent = false } = {}) {
  if (state.activeMemoryId === SESSION_ID && state.session) {
    state.index = state.session.index;
    emit();
    return;
  }
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
    if (!silent) toast(`记忆库已就绪：${fmtNum(units.length)} 条翻译单元`, 'ok');
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
  state.activeMemory = id === SESSION_ID
    ? sessionAsMemory()
    : (state.memories.find((m) => m.id === id) || null);
  renderMemoryPicker();
  emit();
  if (reload) await loadActiveIndex();
}

/* ------------------------------------------------------------------- shell */

function renderMemoryPicker() {
  const sel = document.getElementById('activeMemory');
  if (!sel) return;
  const opts = state.memories.map((m) => h('option', {
    value: String(m.id),
    selected: m.id === state.activeMemoryId,
  }, `${m.name} (${fmtNum(m.count)})`));

  if (state.session) {
    opts.unshift(h('option', {
      value: SESSION_ID,
      selected: state.activeMemoryId === SESSION_ID,
    }, `总记忆库 · 临时 ${fmtNum(state.session.units.length)} 条（未写入）`));
  }
  if (!opts.length) opts.push(h('option', { value: '' }, '（暂无记忆库）'));

  mount(sel, ...opts);
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
    state.session ? h('div', { style: { color: 'var(--warn)' } },
      `+ 临时 ${fmtNum(state.session.units.length)} 条`) : null,
    u && u.quota ? h('div.mute', `已用 ${fmtBytes(u.usage)} / ${fmtBytes(u.quota)}`) : null);
}

export function renderView() {
  const host = document.getElementById('view');
  if (!host) return;
  const mod = VIEWS[state.view] || VIEWS.workbench;
  let node;
  try {
    node = mod.render(ctxForViews());
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
  let text;
  try {
    text = await readMaybeGzip(file);          // handles .tmx, .xml and .tmx.gz
  } catch (err) {
    toast('读取失败：' + err.message, 'err');
    return;
  }
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
  if (state.memories.length || state.session) return;
  const cfg = state.config || {};
  const hasMaster = masterAvailable(cfg);

  // Offer the small demo memory, which needs no gate.
  let demoAvailable = false;
  try {
    if (typeof globalThis.__RPC_CAT_DEMO_TMX === 'string' && globalThis.__RPC_CAT_DEMO_TMX) {
      demoAvailable = true;
    } else {
      const res = await fetch('data/demo-tm.tmx', { method: 'HEAD' });
      demoAvailable = res.ok;
    }
  } catch { demoAvailable = false; }

  if (!demoAvailable && !hasMaster) return;

  const loadDemo = async () => {
    try {
      const text = (typeof globalThis.__RPC_CAT_DEMO_TMX === 'string' && globalThis.__RPC_CAT_DEMO_TMX)
        ? globalThis.__RPC_CAT_DEMO_TMX
        : await (await fetch('data/demo-tm.tmx')).text();
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

  const actions = [{ label: '稍后', onClick: (close) => close() }];
  if (hasMaster) {
    actions.push({
      label: '载入总记忆库…',
      primary: !demoAvailable,
      onClick: async (close) => {
        close();
        await openMasterGate(ctxForViews());
      },
    });
  }
  if (demoAvailable) {
    actions.push({
      label: '载入示例记忆库',
      primary: hasMaster ? false : true,
      onClick: async (close) => { close(); await loadDemo(); },
    });
  }

  modal({
    title: '开始使用',
    body: h('div',
      h('p', '还没有任何记忆库。你可以：'),
      h('ul', { style: { paddingLeft: '20px', color: 'var(--text-dim)' } },
        h('li', '导入自己的 TMX / TMX.GZ（顶部「导入 TMX」）'),
        h('li', '在「对齐制作」里粘贴中英原文，自动生成 TMX'),
        hasMaster
          ? h('li', `载入内置的${cfg.master && cfg.master.name ? cfg.master.name : '总记忆库'}`
              + `（${fmtNum((cfg.master && cfg.master.units) || 0)} 条，需要管理员口令）`)
          : null,
        demoAvailable ? h('li', '载入内置示例记忆库（660 条，无需口令）') : null),
      h('p.tiny', '全部数据只保存在你自己的浏览器里，不会上传到任何服务器。'),
    ),
    actions,
  });
}

/** The same context object app.renderView() hands to views. */
function ctxForViews() {
  return {
    state,
    refreshMemories,
    loadActiveIndex,
    setActiveMemory,
    refresh: () => renderView(),
    importPairs: doImport,
    importTmxFile,
    exportActiveMemory,
    loadSessionMemory,
    clearSessionMemory,
    openMasterGate,
    setView,
  };
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
    const raw = e.target.value;
    const id = raw === SESSION_ID ? SESSION_ID : (raw ? Number(raw) : null);
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

  // config first: the first-run dialog needs to know whether a master memory
  // exists and what the licence text says
  state.config = await loadConfig();

  await refreshMemories();
  renderView();
  await firstRunCheck();
  if (state.activeMemoryId && state.activeMemoryId !== SESSION_ID) {
    await loadActiveIndex({ silent: true });
  }
}

function showHelp() {
  modal({
    wide: true,
    title: '使用说明',
    body: h('div',
      h('h3', '原格式会被保留'),
      h('p.dim', '粘贴原文后按行解析：换行、空行、缩进、列表与标题标记、'
        + '||表格行||、[[code]] 代码块、[[module]] / [[include]] 等标记都原样保留。'
        + '代码块整块不翻译也不断句，导出的是可以直接贴回 Wikidot 的完整文件；'
        + '未翻译的句子会保留原文，不会丢内容。'),
      h('h3', '总记忆库'),
      h('p.dim', '「设置 → 总记忆库」可载入完整的 29,271 条中英记忆库。'
        + '需要勾选授权条款并输入管理员口令，口令向站点管理员索取。'
        + '可以选择「写入本机记忆库」（长期保留）或「只本次使用，不写入」'
        + '（仅放在内存里查证，关掉页面即消失）。'),
      h('h3', '工作台'),
      h('p.dim', '逐句翻译，每句自动从当前记忆库检索匹配（100% 精确 + 模糊百分比），'
        + '点一下即填入。译文漏掉原文编号时会就地提示。'
        + 'Ctrl+Enter 确认并跳到下一句。'),
      h('h3', '对齐制作'),
      h('p.dim', '分别粘贴中英原文，点「自动对齐」。算法按段落、再按句子做单调对齐；'
        + '可以手动合并、拆分、改配，确认后存入记忆库或导出 TMX。代码块与标记行不参与对齐。'),
      h('h3', '记忆库 / 语料库'),
      h('p.dim', '导入导出 TMX（含 .tmx.gz）、CSV、JSON，检索编辑去重；'
        + '翻译项目保存在语料库里，随时继续。'),
      h('h3', '快捷键'),
      h('ul', { style: { paddingLeft: '20px', color: 'var(--text-dim)' } },
        h('li', 'Ctrl+Enter — 确认当前句并跳到下一句'),
        h('li', 'Esc — 关闭弹窗')),
      h('h3', '隐私'),
      h('p.dim', '所有数据保存在浏览器的 IndexedDB 中，不会上传。'
        + '清除浏览器数据会一并删除，请定期用「导出 TMX」备份。'),
    ),
    actions: [{ label: '知道了', primary: true }],
  });
}

main();
