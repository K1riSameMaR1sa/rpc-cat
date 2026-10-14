/**
 * scripts/make-glossary.mjs — build data/glossary.tsv.gz, the shipped term base.
 *
 * Two sources, merged:
 *
 *   1. data/glossary-curated.json — terms a human already agreed on, harvested
 *      from the wiki's parallel index pages (see scripts/harvest-terms.mjs).
 *   2. Mined from the translation memory. A candidate English term is collected
 *      from every unit it appears in; if the SAME Chinese string shows up in
 *      enough of those units' translations, that string is its translation.
 *      The consistency ratio is the evidence — a term that only agrees half the
 *      time is not a term, it is a coincidence.
 *
 *   node scripts/make-glossary.mjs [path/to/memory.tmx]
 *
 * Output is TSV (en, zh, source, count, consistency), gzipped and committed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTmx, toPairs } from '../js/tmx.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SRC = join(ROOT, '..', 'rpc-tm', 'out', 'RPC_Authority_EN-ZH.tmx');
const SRC = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_SRC;
const CURATED = join(ROOT, 'data', 'glossary-curated.json');
const OUT = join(ROOT, 'data', 'glossary.tsv.gz');

/* ------------------------------------------------------------- candidate EN */

const EN_STOP = new Set(('a an the this that these those it its he she they them you we i his her '
  + 'their our your my me him us and or but not no nor so yet for of in on at by with from to into '
  + 'onto upon under over between during after before while when where which who whom whose what '
  + 'how why is are was were be been being am do does did done has have had having will would shall '
  + 'should can could may might must there here then than as if because about above below up down out '
  + 'off again further once all any both each few more most other some such only own same too very '
  + 'also just now ever never always often sometimes').split(' '));

// capitalised word (optionally hyphenated / with digits) up to 4 words long
const PHRASE_RE = /\b[A-Z][A-Za-z0-9-]*(?:\s+(?:of|the|and|for)\s+|\s+)?(?:[A-Z][A-Za-z0-9-]*)?(?:[\s-]+[A-Z][A-Za-z0-9-]*){0,2}\b/g;
const ACRONYM_RE = /\b[A-Z]{2,6}\b/g;

/**
 * Candidate English terms, each flagged with whether it ever appears
 * MID-SENTENCE. That flag matters: a capitalised word that only ever shows up
 * at the start of a sentence is probably just an ordinary word ("Contrary",
 * "Results"), whereas a real term also occurs inside sentences.
 */
function enCandidates(text) {
  const t = String(text || '');
  const out = new Map();       // term -> { mid }

  const note = (term, at) => {
    let i = at - 1;
    while (i >= 0 && /\s/.test(t[i])) i -= 1;
    const mid = i >= 0 && !/[.!?\u3002\uff01\uff1f\n]/.test(t[i]);
    const cur = out.get(term);
    if (cur) cur.mid = cur.mid || mid;
    else out.set(term, { mid });
  };

  for (const m of t.matchAll(ACRONYM_RE)) note(m[0], m.index);

  for (const m of t.matchAll(PHRASE_RE)) {
    let phrase = m[0].replace(/\s+/g, ' ').trim();
    if (!phrase) continue;
    phrase = phrase
      .replace(/^(?:of|the|and|for)\s+/i, '')
      .replace(/\s+(?:of|the|and|for)$/i, '')
      .replace(/^(?:A|An|The)\s+/, '');            // "An Authority" -> "Authority"
    if (!phrase) continue;
    const words = phrase.split(' ');
    if (words.length > 4) continue;
    if (phrase.length < 3 || phrase.length > 42) continue;
    // A lone capitalised word is mostly noise ("Dir." from an abbreviation).
    if (words.length === 1 && phrase.length < 4) continue;
    if (words.length === 1 && EN_STOP.has(phrase.toLowerCase())) continue;
    note(phrase, m.index);
  }
  return [...out.entries()].map(([term, v]) => ({ term, mid: v.mid }));
}

/* ---------------------------------------------------------- Chinese n-grams */

function ngrams(text, min = 2, max = 9) {
  const out = new Set();
  const clean = String(text || '').replace(/[\s\u3000]+/g, '');
  for (let n = min; n <= max; n++) {
    for (let i = 0; i + n <= clean.length; i++) out.add(clean.slice(i, i + n));
  }
  return [...out];
}

/** An n-gram that starts or ends on punctuation is a fragment, not a term. */
const BAD_EDGE = new RegExp(
  '^[：:，,。.、；;！!？?（）()\\[\\]【】「」『』"\'“”‘’·\\-—…/+\\\\=]+'
  + '|[：:，,。.、；;！!？?（）()\\[\\]【】「」『』"\'“”‘’·\\-—…/+\\\\=]+$'
);

/**
 * 的 marks a clause, not a term — "此层根据收容物的级" is a sentence fragment
 * that happened to be frequent enough to win the longest-match race.
 */
const CLAUSE_RE = /[的得地]/;

/** Honourifics that stick to a transliterated name but are not part of it. */
const HONORIFICS = ['博士', '先生', '女士', '小姐', '教授', '研究员', '长官', '上校', '中校', '少校'];

function trimTerm(zh) {
  let s = String(zh);
  // a leading 年/月 that belongs to a date, not to the term ("年7月" -> "7月")
  s = s.replace(/^年(?=\d)/, '');
  for (const h of HONORIFICS) {
    if (s.length > h.length + 1 && s.endsWith(h)) { s = s.slice(0, -h.length); break; }
  }
  return s;
}

/**
 * The Chinese string that best explains a set of translations of one English
 * term.
 *
 * Naively picking the highest-frequency n-gram is WRONG: a substring can only
 * be at least as frequent as the string containing it, so "管理" always beats
 * "管理局" and every term comes out truncated. Instead: take the frequency of
 * the best candidate, keep everything within a small margin of it, and only
 * then prefer the LONGEST — that recovers "管理局" without letting an
 * occasional long phrase win.
 *
 * Seeded from a few translations rather than one, so an unusual first rendering
 * cannot hide the real term.
 */
function bestTranslation(zhTexts, minConsistency, minDf, maxZh) {
  if (zhTexts.length < minDf) return null;

  const seeds = new Set();
  for (const t of zhTexts.slice(0, 4)) for (const g of ngrams(t)) seeds.add(g);

  const scored = [];
  for (const g of seeds) {
    if (g.length < 2) continue;
    if (BAD_EDGE.test(g)) continue;              // "级：", "[已", "沃-"
    if (CLAUSE_RE.test(g)) continue;             // sentence fragments
    if (/[：:，,。.、；;！!？?]/.test(g)) continue; // punctuation inside a term
    if (/^\d+$/.test(g)) continue;
    let df = 0;
    for (const t of zhTexts) if (t.includes(g)) df += 1;
    if (df < minDf) continue;
    const consistency = df / zhTexts.length;
    if (consistency < minConsistency) continue;
    scored.push({ zh: g, df, consistency });
  }
  if (!scored.length) return null;

  const maxDf = Math.max(...scored.map((s) => s.df));
  // Keep everything reasonably close to the best frequency, then prefer the
  // longest. The margin has to be fairly wide: a longer form is *always* at
  // least slightly rarer than its own prefix, and a tight margin truncates real
  // terms mid-word ("管理局安" instead of "管理局安保部队").
  let good = scored.filter((s) => s.df >= maxDf * 0.6);
  // ...but a term cannot be much longer than what it translates. Without this
  // a whole clause can win the "longest" race when its frequency is close.
  const capped = good.filter((s) => s.zh.length <= maxZh);
  if (capped.length) good = capped;

  good.sort((a, b) => b.zh.length - a.zh.length || b.df - a.df);
  const pick = good[0];
  return { ...pick, zh: trimTerm(pick.zh) };
}

/* ------------------------------------------------------------------- build */

console.log(`source memory : ${relative(ROOT, SRC)}`);
const text = readFileSync(SRC, 'utf8');
const pairs = toPairs(parseTmx(text), { srcLang: 'en-US', tgtLang: 'zh-CN' });
console.log(`translation units: ${pairs.length.toLocaleString('en-US')}`);

const buckets = new Map();     // en -> {display, zhTexts:[], mid}
for (const p of pairs) {
  for (const { term, mid } of enCandidates(p.src)) {
    const key = term.toLowerCase();
    let b = buckets.get(key);
    if (!b) { b = { display: term, zhTexts: [], mid: false }; buckets.set(key, b); }
    b.mid = b.mid || mid;
    b.zhTexts.push(p.tgt);
  }
}
console.log(`candidate terms  : ${buckets.size.toLocaleString('en-US')}`);

const mined = [];
for (const [, b] of buckets) {
  const words = b.display.split(' ').length;
  const isAcronym = /^[A-Z]{2,6}$/.test(b.display);
  // A one-word candidate that only ever appears at the start of a sentence is
  // an ordinary word that happens to be capitalised, not terminology.
  if (words === 1 && !isAcronym && !b.mid) continue;

  const minConsistency = words > 1 || isAcronym ? 0.6 : 0.75;
  const minDf = words > 1 || isAcronym ? 3 : 4;
  if (b.zhTexts.length < minDf) continue;

  const maxZh = Math.min(11, words * 3 + 2);
  const best = bestTranslation(b.zhTexts, minConsistency, minDf, maxZh);
  if (!best) continue;
  if (!/[\u4e00-\u9fff]/.test(best.zh)) continue;      // ignore untranslated leftovers

  mined.push({
    en: b.display,
    zh: best.zh,
    source: 'memory',
    count: b.zhTexts.length,
    consistency: Math.round(best.consistency * 100) / 100,
  });
}
console.log(`mined terms      : ${mined.length.toLocaleString('en-US')}`);

/* -------------------------------------------------------------------- merge */

const curated = JSON.parse(readFileSync(CURATED, 'utf8'));
const byKey = new Map();
for (const t of mined) byKey.set(t.en.toLowerCase(), { ...t });

let addedByWiki = 0;
let agreedByWiki = 0;
for (const c of curated.terms) {
  const key = c.en.toLowerCase();
  const cur = byKey.get(key);
  if (!cur) {
    byKey.set(key, {
      en: c.en, zh: c.zh, source: 'wiki', count: 0, consistency: 1,
    });
    addedByWiki += 1;
    continue;
  }
  if (cur.zh === c.zh) {
    cur.source = 'both';
    cur.consistency = Math.max(cur.consistency, 1);
    agreedByWiki += 1;
  } else if (cur.count < 4) {
    // the mined evidence is thin; trust the curated term
    cur.zh = c.zh;
    cur.source = 'both';
    cur.consistency = 1;
    agreedByWiki += 1;
  }
}

const all = [...byKey.values()].sort(
  (a, b) => b.consistency - a.consistency || b.count - a.count || a.en.localeCompare(b.en));

const lines = ['# en\tzh\tsource\tcount\tconsistency'];
for (const t of all) {
  lines.push([t.en, t.zh, t.source, t.count, t.consistency].join('\t'));
}
const tsv = `${lines.join('\n')}\n`;
writeFileSync(OUT, gzipSync(tsv, { level: 9, mtime: 0 }));

console.log(`curated input    : ${curated.terms.length}`);
console.log(`  new from wiki  : ${addedByWiki}`);
console.log(`  agreed / fixed : ${agreedByWiki}`);
console.log(`total terms      : ${all.length.toLocaleString('en-US')}`);
console.log(`wrote            : ${relative(ROOT, OUT)} (${(gzipSync(tsv, { level: 9, mtime: 0 }).length / 1024).toFixed(0)} KB)`);
console.log('');
const bySource = {};
for (const t of all) bySource[t.source] = (bySource[t.source] || 0) + 1;
console.log('by source        :', JSON.stringify(bySource));
