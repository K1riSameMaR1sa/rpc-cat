/**
 * tests/smoke.mjs — load every module and render every view against a DOM shim.
 *
 * This catches what unit tests cannot: a named import that does not exist, a
 * view that throws while building its tree, a helper used before definition.
 * Run: node tests/smoke.mjs
 */

import { installDom } from './dom-shim.mjs';

installDom();

const { MemoryIndex } = await import('../js/match.js');
const { buildTmx } = await import('../js/tmx.js');

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { passed += 1; return; }
  failed += 1;
  failures.push(name + (extra ? `\n      ${extra}` : ''));
}

function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

async function tryImport(label, path) {
  try {
    const mod = await import(path);
    ok(`import ${label}`, true);
    return mod;
  } catch (err) {
    ok(`import ${label}`, false, String(err && err.stack || err).split('\n').slice(0, 4).join('\n      '));
    return null;
  }
}

section('module graph');

const ui = await tryImport('ui.js', '../js/ui.js');
const tmx = await tryImport('tmx.js', '../js/tmx.js');
const seg = await tryImport('segment.js', '../js/segment.js');
const align = await tryImport('align.js', '../js/align.js');
const match = await tryImport('match.js', '../js/match.js');
const dbmod = await tryImport('db.js', '../js/db.js');
const glossary = await tryImport('glossary.js', '../js/glossary.js');
const docmod = await tryImport('document.js', '../js/document.js');
const workbench = await tryImport('views/workbench.js', '../js/views/workbench.js');
const alignView = await tryImport('views/align.js', '../js/views/align.js');
const memoryView = await tryImport('views/memory.js', '../js/views/memory.js');
const corpusView = await tryImport('views/corpus.js', '../js/views/corpus.js');
const settingsView = await tryImport('views/settings.js', '../js/views/settings.js');
const app = await tryImport('app.js', '../js/app.js');

section('exports');

for (const [mod, names, label] of [
  [ui, ['h', 'mount', 'toast', 'modal', 'downloadText', 'fmtNum', 'fmtBytes', 'debounce'], 'ui'],
  [tmx, ['parseTmx', 'buildTmx', 'toPairs'], 'tmx'],
  [seg, ['splitBlocks', 'splitSentencesEn', 'splitSentencesZh', 'getAnchors', 'detectLabel'], 'segment'],
  [align, ['buildTUs', 'alignBlocks', 'makeBlocks'], 'align'],
  [match, ['MemoryIndex', 'normalize', 'editSimilarity'], 'match'],
  [dbmod, ['openDb', 'listMemories', 'addUnits', 'getUnits', 'saveDocument'], 'db'],
  [glossary, ['loadGlossary', 'Glossary', 'getGlossary'], 'glossary'],
  [docmod, ['parseDocument', 'reconstruct', 'documentStats', 'collectPairs', 'flattenSentences'], 'document'],
  [workbench, ['render', 'openProject'], 'workbench'],
  [alignView, ['render', 'collectPairs'], 'align view'],
  [memoryView, ['render'], 'memory view'],
  [corpusView, ['render'], 'corpus view'],
  [settingsView, ['render', 'parseCsv'], 'settings view'],
  [app, ['main', 'refreshMemories', 'renderView', 'doImport', 'exportActiveMemory'], 'app'],
]) {
  for (const n of names) {
    ok(`${label} exports ${n}`, mod && typeof mod[n] === 'function',
      mod ? `got ${typeof mod[n]}` : 'module failed to load');
  }
}

section('view rendering');

// A ctx shaped exactly like the one app.renderView() passes.
const fakeMem = {
  id: 1, name: '测试记忆库', srcLang: 'en-US', tgtLang: 'zh-CN',
  note: '', createdAt: Date.now(), count: 3,
};
const ctx = {
  state: {
    memories: [fakeMem],
    activeMemoryId: 1,
    activeMemory: fakeMem,
    index: new MemoryIndex([
      { src: 'RPC-691 is an MP4 video file.', tgt: 'RPC-691 是一个 MP4 视频文件。', id: 1, doc: 'rpc-691' },
      { src: 'Containment Protocols: RPC-691 is contained within a cell.', tgt: '收容协议：RPC-691 被收容在一个监笼内。', id: 2, doc: 'rpc-691' },
      { src: 'The boils are getting worse, guys.', tgt: '疮越来越严重了，各位。', id: 3, doc: 'rpc-691' },
    ]),
    indexBuilding: false,
    view: 'workbench',
    config: { gate: { requireConsent: true, consentPoints: [] }, master: null },
    session: null,
    glossary: new glossary.Glossary([
      { en: 'Authority', zh: '管理局', source: 'memory', count: 1224, consistency: 0.91 },
      { en: 'Containment Protocols', zh: '收容协议', source: 'both', count: 168, consistency: 0.85 },
    ]),
  },
  refreshMemories: async () => {},
  loadActiveIndex: async () => {},
  setActiveMemory: async () => {},
  refresh: () => {},
  importPairs: async () => {},
  setView: () => {},
};

for (const [label, mod] of [
  ['workbench', workbench], ['align', alignView], ['memory', memoryView],
  ['corpus', corpusView], ['settings', settingsView],
]) {
  if (!mod) continue;
  try {
    const node = mod.render(ctx);
    ok(`${label}.render() returns a node`, node && node.nodeType === 1,
      `got ${node && node.constructor && node.constructor.name}`);
    ok(`${label}.render() produced content`, node && node.childNodes.length > 0);
  } catch (err) {
    ok(`${label}.render() does not throw`, false,
      String(err && err.stack || err).split('\n').slice(0, 6).join('\n      '));
  }
}

section('view rendering with no memory selected');

const emptyCtx = {
  ...ctx,
  state: { ...ctx.state, memories: [], activeMemoryId: null, activeMemory: null, index: null },
};
for (const [label, mod] of [
  ['workbench', workbench], ['align', alignView], ['memory', memoryView],
  ['corpus', corpusView], ['settings', settingsView],
]) {
  if (!mod) continue;
  try {
    const node = mod.render(emptyCtx);
    ok(`${label}.render() handles an empty state`, node && node.nodeType === 1);
  } catch (err) {
    ok(`${label}.render() handles an empty state`, false,
      String(err && err.stack || err).split('\n').slice(0, 6).join('\n      '));
  }
}

section('workbench interaction');

{
  // Drive the "start translation" path through the rendered DOM: find the
  // textarea, fill it, click the primary button, and check segments appear.
  const node = workbench.render(ctx);
  const textareas = [];
  const buttons = [];
  (function walk(n) {
    if (n.nodeType !== 1) return;
    if (n.tagName === 'TEXTAREA') textareas.push(n);
    if (n.tagName === 'BUTTON') buttons.push(n);
    for (const c of n.childNodes) walk(c);
  }(node));

  ok('workbench has a source textarea', textareas.length >= 1);
  const primary = buttons.find((b) => String(b.className).includes('primary'));
  ok('workbench has a start button', !!primary);

  if (textareas.length && primary) {
    textareas[0].value = 'RPC-691 is an MP4 video file.\n\nThe boils are getting worse, guys.';
    textareas[0].dispatch('input');
    try {
      primary.dispatch('click');
      const after = workbench.render(ctx);
      const segs = [];
      (function walk(n) {
        if (n.nodeType !== 1) return;
        if (String(n.className).includes('seg') && !String(n.className).includes('seg-')) segs.push(n);
        for (const c of n.childNodes) walk(c);
      }(after));
      ok('workbench produced segments after start', segs.length >= 2,
        `found ${segs.length}`);
    } catch (err) {
      ok('workbench start does not throw', false,
        String(err && err.stack || err).split('\n').slice(0, 6).join('\n      '));
    }
  }
  workbench.openProject({ id: 9, name: 'P', source: 'a', segments: [{ src: 'a', tgt: 'b' }] });
  ok('workbench.openProject does not throw', true);
}

section('alignment view');

{
  ok('collectPairs returns an array', Array.isArray(alignView.collectPairs()));
  const pairs = alignView.collectPairs();
  ok('collectPairs yields TU-ready objects',
    pairs.every((p) => typeof p.src === 'string' && typeof p.tgt === 'string' && p.props));
  const { xml } = buildTmx({ units: pairs, srcLang: 'en-US', tgtLang: 'zh-CN' });
  ok('empty alignment still builds valid TMX', xml.includes('<tmx version="1.4">'));
}

section('settings csv parser');

{
  const rows = settingsView.parseCsv('source,target\n"a, b",c\n"line\nbreak",d\n');
  ok('parseCsv row count', rows.length === 3, JSON.stringify(rows));
  ok('parseCsv quoted comma', rows[1][0] === 'a, b');
  ok('parseCsv embedded newline', rows[2][0] === 'line\nbreak');
}

section('db module shape');

{
  ok('db.normSrc normalises', dbmod.normSrc('  Hello   World  ') === 'hello world');
  let threw = false;
  try { await dbmod.openDb(); } catch { threw = true; }
  ok('db.openDb rejects without IndexedDB (shim has none)', threw);
}

console.log(`\n${'─'.repeat(58)}`);
if (failed === 0) {
  console.log(`\x1b[32m✓ all ${passed} smoke checks passed\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m✗ ${failed} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
