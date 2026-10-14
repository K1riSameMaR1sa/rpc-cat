/**
 * tests/master.mjs — the master memory file and the gate in front of it.
 *
 * Node has DecompressionStream, Blob, Response and crypto.subtle, so master.js
 * can be exercised for real here rather than mocked.
 *
 * Run: node tests/master.mjs
 */

import { installDom } from './dom-shim.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

installDom();

const { sha256Hex, readMaybeGzip, masterAvailable } = await import('../js/master.js');
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

/* ------------------------------------------------------------------ hashing */

section('sha256');

{
  const cases = ['rpc-admin', 'a', '', '口令测试', 'x'.repeat(500)];
  for (const c of cases) {
    const mine = await sha256Hex(c);
    const theirs = createHash('sha256').update(c, 'utf8').digest('hex');
    eq(`sha256(${JSON.stringify(c.slice(0, 12))}) matches node:crypto`, mine, theirs);
  }
  ok('hash is 64 lowercase hex chars', /^[0-9a-f]{64}$/.test(await sha256Hex('anything')));
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
      text.startsWith('<?xml') && text.includes('<tmx version="1.4">'),
      text.slice(0, 60));

    const parsed = parseTmx(text);
    ok('master memory parses', parsed.units.length > 20000,
      `units=${parsed.units.length}`);

    // uncompressed input must pass through untouched
    const plain = await readMaybeGzip(new TextEncoder().encode('<tmx version="1.4"><body></body></tmx>').buffer);
    ok('plain XML passes through', plain.includes('<tmx'), plain.slice(0, 40));
  }
}

/* ---------------------------------------------------------------- config */

section('data/config.json');

{
  const cfgPath = join(ROOT, 'data', 'config.json');
  ok('config exists', existsSync(cfgPath));
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    ok('adminCodeHash is a sha256 hex digest',
      /^[0-9a-f]{64}$/.test(cfg.adminCodeHash || ''), cfg.adminCodeHash);
    ok('gate asks for consent', !!(cfg.gate && cfg.gate.requireConsent));
    ok('gate spells out the licence points',
      Array.isArray(cfg.gate.consentPoints) && cfg.gate.consentPoints.length >= 3);
    ok('config flags whether the code is still the default',
      typeof cfg.adminCodeIsDefault === 'boolean');

    // the shipped default MUST match the documented one, otherwise nobody can
    // get in — and it must be flagged so the UI can nag about changing it
    const defaultHash = await sha256Hex('rpc-admin');
    if (cfg.adminCodeIsDefault) {
      eq('default code is the documented "rpc-admin"', cfg.adminCodeHash, defaultHash);
      ok('a default-code hint is present', !!cfg.adminHint);
    } else {
      ok('custom code does not equal the default', cfg.adminCodeHash !== defaultHash);
    }

    ok('master metadata present', !!(cfg.master && cfg.master.file && cfg.master.units));
    ok('master declares its licence', !!cfg.master.license);
    ok('master declares attribution', !!cfg.master.attribution);

    // the declared numbers must match the actual file
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

section('gate data is usable');

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
    // short list items ("Ballistic" vs "animated"), where length and structure
    // match well and there are no codes or dates to anchor on. The rate is
    // asserted so that a regression in the alignment pipeline shows up here.
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
    eq('exact lookup works on the master memory',
      Math.round(idx.search(probe)[0].score), 100);
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
