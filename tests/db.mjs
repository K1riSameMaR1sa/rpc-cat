/**
 * tests/db.mjs — exercise the storage layer against an in-memory IndexedDB.
 *
 * This is the end-to-end path the app actually uses: create a memory, import
 * the bundled TMX into it, read it back, build the fuzzy index and search.
 * Run: node tests/db.mjs
 */

import { installFakeIndexedDB } from './idb-shim.mjs';

installFakeIndexedDB();

const db = await import('../js/db.js');
const { parseTmx, toPairs } = await import('../js/tmx.js');
const { MemoryIndex } = await import('../js/match.js');
const { readFileSync, existsSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const { dirname, join } = await import('node:path');

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { passed += 1; return; }
  failed += 1;
  failures.push(name + (extra ? `\n      ${extra}` : ''));
}
function eq(name, a, b) {
  ok(name, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}\n      actual   ${JSON.stringify(a)}`);
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

section('memory lifecycle');

await db.openDb();

const memId = await db.createMemory({ name: '单元测试库', srcLang: 'en-US', tgtLang: 'zh-CN' });
ok('createMemory returns an id', typeof memId === 'number' || memId != null, String(memId));

await db.addUnits(memId, [
  { src: 'RPC-691 is an MP4 video file.', tgt: 'RPC-691 是一个 MP4 视频文件。', srcNorm: db.normSrc('RPC-691 is an MP4 video file.'), doc: 'rpc-691' },
  { src: 'The boils are getting worse, guys.', tgt: '疮越来越严重了，各位。', srcNorm: db.normSrc('The boils are getting worse, guys.'), doc: 'rpc-691' },
  { src: 'Containment Protocols: RPC-691 is contained within a cell.', tgt: '收容协议：RPC-691 被收容在一个监笼内。', srcNorm: db.normSrc('Containment Protocols: RPC-691 is contained within a cell.'), doc: 'rpc-691' },
]);

let mems = await db.listMemories();
eq('listMemories count', mems.length, 1);
eq('listMemories unit count', mems[0].count, 3);
eq('listMemories name', mems[0].name, '单元测试库');

eq('countUnits', await db.countUnits(memId), 3);
eq('getAllUnits', (await db.getAllUnits(memId)).length, 3);

const page = await db.getUnits(memId, { offset: 1, limit: 1 });
eq('getUnits pagination', page.length, 1);
eq('getUnits offset lands on the 2nd row', page[0].src, 'The boils are getting worse, guys.');

const byDoc = await db.getUnits(memId, { offset: 0, limit: 50, doc: 'rpc-691' });
eq('getUnits doc filter', byDoc.length, 3);

section('lookup, update, delete');

const found = await db.findBySource(memId, 'The boils are getting worse, guys.');
eq('findBySource finds one', found.length, 1);
eq('findBySource target', found[0].tgt, '疮越来越严重了，各位。');
eq('findBySource normalises case/space', (await db.findBySource(memId, '  the boils   are getting worse, guys.  ')).length, 1);

const target = (await db.getAllUnits(memId)).find((u) => u.src.startsWith('RPC-691 is'));
await db.updateUnit(target.id, { tgt: 'RPC-691 是一个 MP4 视频文件（修订）。' });
const after = (await db.getAllUnits(memId)).find((u) => u.id === target.id);
eq('updateUnit changes the target', after.tgt, 'RPC-691 是一个 MP4 视频文件（修订）。');
eq('updateUnit keeps the source', after.src, target.src);

await db.updateUnit(target.id, { src: 'CHANGED SOURCE' });
const afterSrc = (await db.getAllUnits(memId)).find((u) => u.id === target.id);
eq('updateUnit recomputes srcNorm', afterSrc.srcNorm, db.normSrc('CHANGED SOURCE'));

section('documents and settings');

const docId = await db.saveDocument({
  name: '测试项目', kind: 'project', srcLang: 'en-US', tgtLang: 'zh-CN',
  source: 'a\n\nb', segments: [{ src: 'a', tgt: '甲' }, { src: 'b', tgt: '' }],
});
ok('saveDocument returns an id', docId != null);
const docs = await db.listDocuments();
eq('listDocuments count', docs.length, 1);
eq('listDocuments counts done segments', docs[0].done, 1);
eq('listDocuments counts total segments', docs[0].segments, 2);
const full = await db.getDocument(docId);
eq('getDocument round-trips segments', full.segments[1].src, 'b');

await db.setSetting('theme', 'dark');
eq('getSetting', await db.getSetting('theme'), 'dark');
eq('getSetting default', await db.getSetting('missing', 'fallback'), 'fallback');

section('memory deletion cascades');

await db.deleteMemory(memId);
mems = await db.listMemories();
eq('memory removed from list', mems.length, 0);
eq('countUnits after delete', await db.countUnits(memId), 0);
ok('getAllUnits is empty after delete', (await db.getAllUnits(memId)).length === 0);
eq('documents untouched by memory delete', (await db.listDocuments()).length, 1);

section('end-to-end: import the bundled TMX');

const demoPath = join(here, '..', 'data', 'demo-tm.tmx');
if (!existsSync(demoPath)) {
  ok('demo TMX present', false, demoPath);
} else {
  const parsed = parseTmx(readFileSync(demoPath, 'utf8'));
  const pairs = toPairs(parsed, { srcLang: 'en-US', tgtLang: 'zh-CN' });
  const bigId = await db.createMemory({ name: '示例库', srcLang: 'en-US', tgtLang: 'zh-CN' });

  let progressCalls = 0;
  await db.addUnits(bigId, pairs.map((p) => ({
    src: p.src, tgt: p.tgt, srcNorm: db.normSrc(p.src), doc: p.props['x-doc'] || '',
  })), () => { progressCalls += 1; });

  ok('addUnits reported progress', progressCalls > 0, `calls=${progressCalls}`);

  const stored = await db.getAllUnits(bigId);
  eq('every pair was stored', stored.length, pairs.length);

  const listed = (await db.listMemories()).find((m) => m.id === bigId);
  eq('listMemories reports the right count', listed.count, pairs.length);

  // build the index exactly as app.loadActiveIndex does
  const idx = new MemoryIndex(stored.map((r) => ({ src: r.src, tgt: r.tgt, id: r.id, doc: r.doc })));
  eq('index size', idx.size, pairs.length);

  const probe = pairs.find((p) => p.src.length > 60).src;
  const exact = idx.search(probe);
  eq('exact hit from the database round-trip', Math.round(exact[0].score), 100);
  eq('exact hit target survived storage', exact[0].unit.tgt, pairs.find((p) => p.src === probe).tgt);

  const variant = probe.replace(/\bis\b/, 'was').replace(/\.$/, '!');
  const fuzzy = idx.search(variant, { minScore: 40 });
  ok('fuzzy hit from the database round-trip', fuzzy.length > 0 && fuzzy[0].score > 80,
    JSON.stringify(fuzzy.map((h) => Math.round(h.score))));

  const con = idx.concordance('RPC-691', { limit: 10 });
  ok('concordance works on stored data', con.length > 0, `hits=${con.length}`);

  // editing a stored row must be reflected after a reload
  const one = stored[0];
  await db.updateUnit(one.id, { tgt: one.tgt + '（改）' });
  const reloaded = await db.getAllUnits(bigId);
  ok('edited row persists', reloaded.some((r) => r.id === one.id && r.tgt.endsWith('（改）')));

  await db.deleteMemory(bigId);
  eq('bulk delete removed every unit', (await db.getAllUnits(bigId)).length, 0);
}

section('wipe');

await db.wipeAll();
eq('wipeAll clears memories', (await db.listMemories()).length, 0);
eq('wipeAll clears documents', (await db.listDocuments()).length, 0);
eq('wipeAll clears settings', await db.getSetting('theme'), null);

console.log(`\n${'─'.repeat(58)}`);
if (failed === 0) {
  console.log(`\x1b[32m✓ all ${passed} storage checks passed\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m✗ ${failed} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
