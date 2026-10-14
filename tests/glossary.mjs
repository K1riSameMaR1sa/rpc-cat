/**
 * tests/glossary.mjs — the shipped term base and per-sentence term lookup.
 *
 * Run: node tests/glossary.mjs
 */

import { installDom } from './dom-shim.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

installDom();

const { Glossary, loadGlossary } = await import('../js/glossary.js');

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const GZ = join(ROOT, 'data', 'glossary.tsv.gz');

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { passed += 1; return; }
  failed += 1;
  failures.push(name + (extra ? `\n      ${extra}` : ''));
}
function eq(name, a, b) {
  ok(name, JSON.stringify(a) === JSON.stringify(b),
    `expected ${JSON.stringify(b)}\n      actual   ${JSON.stringify(a)}`);
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

/* ------------------------------------------------------------------ lookup */

section('Glossary.lookup');

{
  const g = new Glossary([
    { en: 'Authority', zh: '管理局', source: 'memory', count: 1224, consistency: 0.91 },
    { en: 'Authority Security Force', zh: '管理局安全部队', source: 'wiki', count: 34, consistency: 1 },
    { en: 'Containment Protocols', zh: '收容协议', source: 'both', count: 168, consistency: 0.85 },
    { en: 'RPC-691', zh: 'RPC-691', source: 'memory', count: 12, consistency: 1 },
  ]);

  const a = g.lookup('The Authority Security Force is deployed.');
  eq('longest term wins over its own prefix', a.map((t) => t.en), ['Authority Security Force']);
  eq('and carries the right translation', a[0].zh, '管理局安全部队');

  const b = g.lookup('The Authority maintains order.');
  eq('bare Authority still matches', b.map((t) => t.en), ['Authority']);

  eq('no match in unrelated text', g.lookup('Nothing relevant here at all.').length, 0);
  eq('empty input is safe', g.lookup('').length, 0);
  eq('null input is safe', g.lookup(null).length, 0);

  // word boundaries: "Authorities" must not match the term "Authority"
  eq('does not match inside a longer word', g.lookup('The Authorities convened.').length, 0);

  const c = g.lookup('Containment protocols were revised.');
  eq('matching is case-insensitive', c.map((t) => t.en), ['Containment Protocols']);

  const multi = g.lookup('The Authority issued Containment Protocols today.');
  eq('several terms in one sentence', multi.map((t) => t.en).sort(),
    ['Authority', 'Containment Protocols']);

  ok('terms report their position',
    multi.every((t) => Number.isInteger(t.start) && t.end > t.start));

  const lim = g.lookup('The Authority issued Containment Protocols today.', { limit: 1 });
  eq('limit is honoured', lim.length, 1);
}

section('boundary and punctuation handling');

{
  const g = new Glossary([
    { en: 'Site Director', zh: '站点主管', source: 'memory', count: 39, consistency: 0.82 },
    { en: 'DATA EXPUNGED', zh: '数据删除', source: 'memory', count: 20, consistency: 0.9 },
  ]);
  eq('hyphen/space variants match', g.lookup('the site-director said').length, 1);
  eq('multi-word with spaces matches', g.lookup('The Site Director spoke.').length, 1);
  eq('does not match a suffix of a word', g.lookup('Offsite Directors met').length, 0);
}

/* ------------------------------------------------------------- the shipped file */

section('shipped term base');

if (!existsSync(GZ)) {
  ok('data/glossary.tsv.gz exists', false, 'run: npm run make-glossary');
} else {
  const tsv = gunzipSync(readFileSync(GZ)).toString('utf8');
  const lines = tsv.split('\n').filter(Boolean);
  ok('has a header comment', lines[0].startsWith('# en\tzh\t'));
  const rows = lines.slice(1).map((l) => l.split('\t'));
  ok('has a useful number of terms', rows.length > 500, `terms=${rows.length}`);
  ok('every row has 5 columns', rows.every((r) => r.length === 5),
    JSON.stringify(rows.find((r) => r.length !== 5)));
  ok('every row has an English term and a Chinese rendering',
    rows.every((r) => r[0] && r[1] && /[\u4e00-\u9fff]/.test(r[1])));
  ok('consistency is a 0-1 number',
    rows.every((r) => { const v = Number(r[4]); return v >= 0 && v <= 1; }));
  ok('source is one of memory/wiki/both',
    rows.every((r) => ['memory', 'wiki', 'both'].includes(r[2])),
    [...new Set(rows.map((r) => r[2]))].join(','));
  ok('no term contains a stray sentence fragment marker',
    rows.every((r) => !/[。！？]/.test(r[0]) && !/[。！？]/.test(r[1])));

  const g = new Glossary(rows.map((r) => ({
    en: r[0], zh: r[1], source: r[2], count: Number(r[3]), consistency: Number(r[4]),
  })));
  const st = g.stats();
  eq('stats count every term', st.total, rows.length);
  ok('most terms came from the memory', (st.bySource.memory || 0) > rows.length * 0.7,
    JSON.stringify(st.bySource));
  ok('some terms came from the wiki pages', (st.bySource.wiki || 0) > 0,
    JSON.stringify(st.bySource));

  section('lookup against real sentences');

  const cases = [
    ['RPC-691 is an MP4 video file distributed through various websites.', 'Containment'],
    ['The Authority Security Force was deployed to Site-002.', 'Authority'],
    ['Containment Protocols: instances of RPC-691 are to be confiscated.', 'Containment'],
  ];
  for (const [sentence] of cases) {
    const hits = g.lookup(sentence);
    ok(`finds terms in: ${sentence.slice(0, 44)}…`, hits.length > 0,
      `hits=${hits.length}`);
  }

  const t = g.lookup('The Authority Security Force was deployed.');
  ok('picks the longest cover for a run of words',
    t.length === 1 || !(t.some((x) => x.en === 'Authority') && t.some((x) => x.en === 'Authority Security Force')),
    JSON.stringify(t.map((x) => x.en)));

  section('search and export');

  ok('search by English', g.search('containment', { limit: 5 }).length > 0);
  ok('search by Chinese', g.search('收容', { limit: 5 }).length > 0);
  eq('empty search returns nothing', g.search('').length, 0);
  const out = g.toTsv();
  ok('TSV export round-trips the header', out.startsWith('# en\tzh\t'));
  eq('TSV export has one row per term', out.trim().split('\n').length, rows.length + 1);

  section('loadGlossary()');

  const loaded = await loadGlossary();
  // no fetch and no embedded copy in Node, so this legitimately returns null —
  // what matters is that it does not throw and the app copes
  ok('loadGlossary() resolves without throwing', loaded === null || loaded.size > 0);
}

/* -------------------------------------------------------------------- end */

console.log(`\n${'─'.repeat(58)}`);
if (failed === 0) {
  console.log(`\x1b[32m✓ all ${passed} glossary checks passed\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m✗ ${failed} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
