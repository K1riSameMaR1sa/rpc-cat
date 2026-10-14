/**
 * tests/master.mjs — the master memory file and the config that describes it.
 *
 * There is deliberately no password on the master memory any more: it is a
 * static site, so a client-side code could not protect the data and only got in
 * the way. What the config still carries is the licence text and the
 * write / don't-write defaults.
 *
 * Run: node tests/master.mjs
 */

import { installDom } from './dom-shim.mjs';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

installDom();

const { readMaybeGzip, masterAvailable } = await import('../js/master.js');
const { parseTmx, toPairs } = await import('../js/tmx.js');
const { MemoryIndex } = await import('../js/match.js');

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

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

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/* --------------------------------------------------------------- gunzip */

section('readMaybeGzip');

{
  const gzPath = join(ROOT, 'data', 'rpc-memory.tmx.gz');
  if (!existsSync(gzPath)) {
    ok('master memory file exists', false, `${gzPath} (run: npm run make-master)`);
  } else {
    const gz = readFileSync(gzPath);
    const text = await readMaybeGzip(toArrayBuffer(gz));
    ok('gunzipped text looks like TMX',
      text.startsWith('<?xml') && text.includes('<tmx version="1.4">'), text.slice(0, 60));

    const parsed = parseTmx(text);
    ok('master memory parses', parsed.units.length > 20000, `units=${parsed.units.length}`);

    const plain = await readMaybeGzip(
      new TextEncoder().encode('<tmx version="1.4"><body></body></tmx>').buffer);
    ok('plain XML passes through', plain.includes('<tmx'), plain.slice(0, 40));

    const glossaryGz = join(ROOT, 'data', 'glossary.tsv.gz');
    if (existsSync(glossaryGz)) {
      const g = await readMaybeGzip(toArrayBuffer(readFileSync(glossaryGz)));
      ok('glossary is gzipped TSV', g.startsWith('# en\tzh\t'), g.slice(0, 30));
    }
  }
}

/* ---------------------------------------------------------------- config */

section('data/config.json');

{
  const cfgPath = join(ROOT, 'data', 'config.json');
  ok('config exists', existsSync(cfgPath));
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));

    ok('gate asks for consent', !!(cfg.gate && cfg.gate.requireConsent));
    ok('gate spells out the licence points',
      Array.isArray(cfg.gate.consentPoints) && cfg.gate.consentPoints.length >= 3);
    ok('config carries no admin code any more',
      cfg.adminCodeHash === undefined && cfg.adminCodeIsDefault === undefined,
      JSON.stringify(Object.keys(cfg)));

    ok('master metadata present', !!(cfg.master && cfg.master.file && cfg.master.units));
    ok('master declines its licence', !!cfg.master.license);
    ok('master declares attribution', !!cfg.master.attribution);

    const gzPath = join(ROOT, cfg.master.file);
    if (existsSync(gzPath)) {
      eq('declared byte size matches the file', cfg.master.bytes, statSync(gzPath).size);
      const text = await readMaybeGzip(toArrayBuffer(readFileSync(gzPath)));
      const units = (text.match(/<tu\b/g) || []).length;
      eq('declared unit count matches the file', cfg.master.units, units);
    }

    ok('masterAvailable() true with a real config', masterAvailable(cfg));
    ok('masterAvailable() false without one', !masterAvailable({ master: null }));
  }
}

/* -------------------------------------------------- end to end over the data */

section('master memory is usable');

{
  const cfg = JSON.parse(readFileSync(join(ROOT, 'data', 'config.json'), 'utf8'));
  const gzPath = join(ROOT, cfg.master.file);
  if (existsSync(gzPath)) {
    const text = await readMaybeGzip(toArrayBuffer(readFileSync(gzPath)));
    const pairs = toPairs(parseTmx(text), {
      srcLang: cfg.master.srcLang, tgtLang: cfg.master.tgtLang,
    });
    eq('every unit normalises to a pair', pairs.length, cfg.master.units);

    // Spot-check that the corpus is genuinely bilingual. A small residue of
    // non-bilingual units is expected: the aligner can drift on runs of very
    // short list items, where length and structure match well and there are no
    // codes or dates to anchor on. The rate is asserted so a regression in the
    // alignment pipeline shows up here.
    const cjk = /[\u4e00-\u9fff]/;
    const latin = /[A-Za-z]/;
    const sample = pairs.slice(0, 4000);
    const bad = sample.filter((p) => !cjk.test(p.tgt) || !latin.test(p.src));
    const rate = bad.length / sample.length;
    ok('master memory is overwhelmingly bilingual (EN -> ZH)',
      rate < 0.02,
      `non-bilingual ${bad.length}/${sample.length} = ${(rate * 100).toFixed(2)}%\n`
      + bad.slice(0, 3).map((p) => `        ${JSON.stringify(p.src.slice(0, 40))} -> ${JSON.stringify(p.tgt.slice(0, 40))}`).join('\n'));

    const idx = new MemoryIndex(pairs.map((p) => ({ src: p.src, tgt: p.tgt })));
    eq('index covers the whole memory', idx.size, cfg.master.units);
    const probe = pairs.find((p) => p.src.length > 60).src;
    eq('exact lookup works on the master memory', Math.round(idx.search(probe)[0].score), 100);
    ok('concordance works on the master memory',
      idx.concordance('RPC-691', { limit: 5 }).length > 0);
  }
}

/* -------------------------------------------------------------------- end */

console.log(`\n${'─'.repeat(58)}`);
if (failed === 0) {
  console.log(`\x1b[32m✓ all ${passed} master-memory checks passed\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m✗ ${failed} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
