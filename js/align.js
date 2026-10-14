/**
 * align.js — cross-lingual alignment of an English and a Chinese document.
 *
 * Port of the offline pipeline that built the shipped memory, so the web tool
 * and the batch build behave the same way:
 *
 *   1. blocks are aligned by monotone dynamic programming over
 *      language-independent features (shared codes/dates/numbers, structural
 *      labels, length plausibility, block kind, relative position).
 *      SKIPPING A BLOCK IS FREE and a pair must beat a threshold to be taken,
 *      so unrelated blocks stay unpaired instead of being forced together.
 *   2. each aligned block pair becomes one or more translation units. Equal
 *      sentence counts pair 1:1; otherwise a small monotone DP groups
 *      sentences, falling back to a single paragraph-level unit.
 */

import {
  getAnchors, detectLabel, splitSentencesEn, splitSentencesZh,
  enWords, cnUnits,
} from './segment.js';

export const EXPECTED_RATIO = 1.75;

const W_ANCHOR = 3.0;
const W_LABEL = 2.6;
const W_LENGTH = 1.6;
const W_KIND = 0.5;
const W_POS = 0.5;
const W_PRESERVE = 2.0;

export const PAIR_THRESHOLD = 0.46;
export const MIN_EMIT = 0.50;
const GROUP_PENALTY = 0.10;

/* --------------------------------------------------------------- features */

export function lengthSim(enText, cnText) {
  const ew = enWords(enText);
  const cu = cnUnits(cnText);
  if (ew === 0 && cu === 0) return 1;
  if (ew === 0 || cu === 0) return 0.05;
  const ratio = cu / ew;
  return Math.max(0, Math.min(1, Math.exp(-Math.abs(Math.log(ratio / EXPECTED_RATIO)) * 1.15)));
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

const PRESERVE_RE = /\b[A-Za-z0-9][A-Za-z0-9-]*\b/g;

/**
 * Tokens a translation is normally expected to keep verbatim.
 *
 * Deliberately restricted to identifiers containing a digit (RPC-691, MP4,
 * 3.75G) and camelCase names.  All-caps *words* are NOT included: an English
 * header written in capitals ("CHATLOGS RECOVERED FROM PHONES AT DISCOVERY
 * SITE:") would otherwise look like seven must-keep acronyms and stop a
 * perfectly good pair from aligning.
 */
export function preservedTokens(s) {
  const out = new Set();
  const t = String(s || '');
  PRESERVE_RE.lastIndex = 0;
  let m;
  while ((m = PRESERVE_RE.exec(t))) {
    const tok = m[0];
    if (/\d/.test(tok) || /[a-z][A-Z]/.test(tok)) out.add(tok.toLowerCase());
  }
  return out;
}

/**
 * How consistently both sides keep their verbatim tokens, or null when neither
 * side has any — in which case the feature is simply not applied.
 *
 * This is what stops two unrelated blocks from pairing: length and block kind
 * alone will happily match a paragraph of English with a paragraph of Chinese,
 * but a source full of codes that the target shares NONE of is strong evidence
 * against a pairing.
 */
function preservationScore(aText, bText) {
  const A = preservedTokens(aText);
  const B = preservedTokens(bText);
  if (!A.size && !B.size) return null;
  let shared = 0;
  for (const x of A) if (B.has(x)) shared += 1;
  const ra = A.size ? shared / A.size : 1;
  const rb = B.size ? shared / B.size : 1;
  return Math.min(ra, rb);
}

/** Turn a Wikidot-prefixed line into a block record. */
export function makeBlock(text, index) {
  const t = String(text || '');
  const head = t.trimStart();
  let kind = 'p';
  if (/^\*+\s/.test(head)) kind = 'li';
  else if (/^#+\s/.test(head)) kind = 'li';
  else if (/^\++\s/.test(head)) kind = 'h';
  else if (/^>+\s/.test(head)) kind = 'blockquote';
  else if (/^\|\|/.test(head)) kind = 'td';
  else if (/^-{4,}/.test(head) || /^={4,}/.test(head)) kind = 'hr';
  return {
    text: t,
    kind,
    index,
    anchors: getAnchors(t),
    label: detectLabel(t),
  };
}

export function makeBlocks(blockTexts) {
  return blockTexts.map((t, i) => makeBlock(t, i));
}

export function blockSimilarity(a, b, i, j, n, m) {
  let num = 0;
  let den = 0;

  const A = a.anchors;
  const B = b.anchors;
  if (A.length && B.length) {
    num += W_ANCHOR * jaccard(A, B);
    den += W_ANCHOR;
  } else if (A.length || B.length) {
    // one side silent: a translation may paraphrase a number away, or an
    // extractor may miss it — weak evidence, not a penalty
    num += 0.35;
    den += 1.0;
  }

  if (a.label && b.label) {
    num += W_LABEL * (a.label === b.label ? 1 : 0);
    den += W_LABEL;
  } else if (a.label || b.label) {
    num += W_LABEL * 0.15;
    den += W_LABEL;
  }

  num += W_LENGTH * lengthSim(a.text, b.text);
  den += W_LENGTH;

  const pres = preservationScore(a.text, b.text);
  if (pres !== null) {
    num += W_PRESERVE * pres;
    den += W_PRESERVE;
  }

  if (a.kind === b.kind) num += W_KIND;
  else if (['p', 'li', 'td', 'blockquote'].includes(a.kind) &&
           ['p', 'li', 'td', 'blockquote'].includes(b.kind)) num += W_KIND * 0.5;
  den += W_KIND;

  if (n > 1 && m > 1) {
    const pos = 1 - Math.abs((i / (n - 1)) - (j / (m - 1)));
    num += W_POS * pos;
    den += W_POS;
  }

  return Math.max(0, Math.min(1, den ? num / den : 0));
}

/* ------------------------------------------------------------ block align */

/**
 * Monotone DP alignment. Skips are free; a pair scores (similarity - threshold),
 * so only profitable pairs appear.
 * @returns {Array<{i:number,j:number,score:number}>}
 */
export function alignBlocks(en, zh, threshold = PAIR_THRESHOLD) {
  const n = en.length;
  const m = zh.length;
  if (!n || !m) return [];

  const sim = [];
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(m);
    for (let j = 0; j < m; j++) row[j] = blockSimilarity(en[i], zh[j], i, j, n, m);
    sim.push(row);
  }

  const dp = [];
  const bt = [];
  for (let i = 0; i <= n; i++) {
    dp.push(new Float64Array(m + 1));
    bt.push(new Int8Array(m + 1));
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = dp[i - 1][j - 1] + (sim[i - 1][j - 1] - threshold);
      let move = 0;
      if (dp[i - 1][j] > best) { best = dp[i - 1][j]; move = 1; }
      if (dp[i][j - 1] > best) { best = dp[i][j - 1]; move = 2; }
      dp[i][j] = best;
      bt[i][j] = move;
    }
  }

  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const mv = bt[i][j];
    if (mv === 0) { pairs.push({ i: i - 1, j: j - 1, score: sim[i - 1][j - 1] }); i -= 1; j -= 1; }
    else if (mv === 1) i -= 1;
    else j -= 1;
  }
  pairs.reverse();
  return pairs;
}

/* --------------------------------------------------------- sentence align */

function sentSim(enText, zhText, ratio, pe, pc) {
  let num = 0;
  let den = 0;

  const A = getAnchors(enText);
  const B = getAnchors(zhText);
  if (A.length && B.length) {
    num += W_ANCHOR * jaccard(A, B);
    den += W_ANCHOR;
  } else if (A.length || B.length) {
    num += 0.35;
    den += 1.0;
  }

  const ew = enWords(enText);
  const cu = cnUnits(zhText);
  let ls = 0.05;
  if (ew && cu && ratio > 0) {
    const r = cu / ew;
    ls = Math.max(0, Math.min(1, Math.exp(-Math.abs(Math.log(r / ratio)) * 1.2)));
  }
  num += W_LENGTH * ls;
  den += W_LENGTH;

  const pres = preservationScore(enText, zhText);
  if (pres !== null) {
    num += W_PRESERVE * pres;
    den += W_PRESERVE;
  }

  num += W_POS * (1 - Math.min(1, Math.abs(pe - pc)));
  den += W_POS;

  return Math.max(0, Math.min(1, den ? num / den : 0));
}

const MOVES = [[1, 1], [1, 2], [2, 1], [1, 3], [3, 1], [2, 2]];

/**
 * Group sentences of an aligned block pair.
 * @returns {{groups: Array<[string,string]>, mean: number}}
 */
export function alignSentences(es, cs, threshold = PAIR_THRESHOLD) {
  const n = es.length;
  const m = cs.length;
  if (!n || !m) return { groups: [], mean: 0 };
  if (n === 1 && m === 1) {
    const s = sentSim(es[0], cs[0], ratioFor(es, cs), 0, 0);
    return { groups: [[es[0], cs[0]]], mean: s };
  }

  const ratio = ratioFor(es, cs);
  const join = (arr, a, b) => arr.slice(a, b).join(' ');
  const mid = (idx, total) => (total <= 1 ? 0 : idx / (total - 1));

  const NEG = -Infinity;
  const dp = [];
  const acc = [];
  const bt = [];
  for (let i = 0; i <= n; i++) {
    dp.push(new Float64Array(m + 1).fill(NEG));
    acc.push(new Float64Array(m + 1));
    bt.push(new Array(m + 1).fill(null));
  }
  dp[0][0] = 0;

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (dp[i][j] === NEG) continue;
      for (const [da, db] of MOVES) {
        const ni = i + da;
        const nj = j + db;
        if (ni > n || nj > m) continue;
        const pe = mid((i + ni - 1) / 2, n);
        const pc = mid((j + nj - 1) / 2, m);
        const s = sentSim(join(es, i, ni), join(cs, j, nj), ratio, pe, pc);
        const pen = GROUP_PENALTY * (da + db - 2);
        const val = dp[i][j] + (s - threshold) - pen;
        if (val > dp[ni][nj]) {
          dp[ni][nj] = val;
          bt[ni][nj] = [i, j];
          acc[ni][nj] = acc[i][j] + s;
        }
      }
    }
  }
  if (!bt[n][m]) return { groups: [], mean: 0 };

  const groups = [];
  let i = n;
  let j = m;
  while (i !== 0 || j !== 0) {
    const p = bt[i][j];
    if (!p) break;
    groups.push([join(es, p[0], i), join(cs, p[1], j)]);
    i = p[0];
    j = p[1];
  }
  groups.reverse();
  return { groups, mean: groups.length ? acc[n][m] / groups.length : 0 };
}

function ratioFor(es, cs) {
  const ew = enWords(es.join(' '));
  const cu = cnUnits(cs.join(' '));
  return ew ? cu / ew : EXPECTED_RATIO;
}

/* -------------------------------------------------------------- build TUs */

/**
 * Align two documents.
 * @param {string[]} enBlocks
 * @param {string[]} zhBlocks
 * @param {Object} [opts] { threshold, minEmit }
 * @returns {{units: Array, stats: Object, blockPairs: Array}}
 */
export function buildTUs(enBlocks, zhBlocks, opts = {}) {
  const threshold = opts.threshold == null ? PAIR_THRESHOLD : opts.threshold;
  const minEmit = opts.minEmit == null ? MIN_EMIT : opts.minEmit;

  const en = makeBlocks(enBlocks);
  const zh = makeBlocks(zhBlocks);
  const pairs = alignBlocks(en, zh, threshold);

  const units = [];
  const blockPairs = [];
  const stats = {
    enBlocks: en.length,
    zhBlocks: zh.length,
    blockPairs: 0,
    weakPairs: 0,
    sentenceUnits: 0,
    paragraphUnits: 0,
    unpairedEn: 0,
    unpairedZh: 0,
  };

  const usedEn = new Set();
  const usedZh = new Set();

  for (const p of pairs) {
    if (p.score < minEmit) { stats.weakPairs += 1; continue; }
    stats.blockPairs += 1;
    usedEn.add(p.i);
    usedZh.add(p.j);
    blockPairs.push(p);

    const a = en[p.i];
    const b = zh[p.j];
    const es = splitSentencesEn(a.text);
    const cs = splitSentencesZh(b.text);
    const ratio = ratioFor(es, cs);

    let emitted = null;

    if (es.length === cs.length && es.length > 1) {
      const n = es.length;
      let sum = 0;
      const groups = [];
      for (let k = 0; k < n; k++) {
        const pos = n <= 1 ? 0 : k / (n - 1);
        sum += sentSim(es[k], cs[k], ratio, pos, pos);
        groups.push([es[k], cs[k]]);
      }
      const mean = sum / n;
      if (mean >= 0.50) emitted = { groups, mean, level: 'sentence' };
    } else if (es.length === 1 && cs.length === 1) {
      emitted = { groups: [[es[0], cs[0]]], mean: p.score, level: 'sentence' };
    }

    if (!emitted) {
      const { groups, mean } = alignSentences(es, cs, threshold);
      if (groups.length && mean >= 0.52) emitted = { groups, mean, level: 'sentence' };
    }

    if (emitted) {
      stats.sentenceUnits += emitted.groups.length;
      for (const [s, t] of emitted.groups) {
        units.push({
          src: s, tgt: t,
          block: p.i, blockZh: p.j,
          blockScore: round4(p.score),
          score: round4(emitted.mean),
          level: emitted.level,
        });
      }
    } else {
      stats.paragraphUnits += 1;
      units.push({
        src: a.text, tgt: b.text,
        block: p.i, blockZh: p.j,
        blockScore: round4(p.score),
        score: round4(p.score),
        level: 'paragraph',
      });
    }
  }

  stats.unpairedEn = en.length - usedEn.size;
  stats.unpairedZh = zh.length - usedZh.size;

  // Per-unit sentence index within its block, for stable ids.
  const perBlock = new Map();
  for (const u of units) {
    const k = perBlock.get(u.block) || 0;
    u.seg = k;
    perBlock.set(u.block, k + 1);
  }

  return { units, stats, blockPairs, enBlocks: en, zhBlocks: zh };
}

function round4(x) { return Math.round(x * 10000) / 10000; }

/**
 * Alignment view rows: every block on both sides, paired or not, so the editor
 * can show gaps and let a human fix them.
 */
export function buildAlignmentRows(enBlocks, zhBlocks, pairs, minEmit = MIN_EMIT) {
  const en = makeBlocks(enBlocks);
  const zh = makeBlocks(zhBlocks);
  const rows = [];
  const map = new Map();
  for (const p of pairs) if (p.score >= minEmit) map.set(p.i, p);

  const usedZh = new Set();
  for (let i = 0; i < en.length; i++) {
    const p = map.get(i);
    if (p) {
      usedZh.add(p.j);
      rows.push({ enIndex: i, zhIndex: p.j, score: p.score, en: en[i].text, zh: zh[p.j].text, paired: true });
    } else {
      rows.push({ enIndex: i, zhIndex: null, score: 0, en: en[i].text, zh: '', paired: false });
    }
  }
  for (let j = 0; j < zh.length; j++) {
    if (!usedZh.has(j)) {
      rows.push({ enIndex: null, zhIndex: j, score: 0, en: '', zh: zh[j].text, paired: false });
    }
  }
  return { rows, en, zh };
}
