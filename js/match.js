/**
 * match.js — translation-memory lookup.
 *
 * Two retrieval paths, like a CAT tool:
 *   • exact    — normalised source key -> all stored targets
 *   • fuzzy    — inverted token index prunes candidates, then a blended
 *                token-Dice + character-edit score ranks them and gives a %.
 *   • concordance — substring search over source and/or target, for research.
 *
 * Everything is in memory. The shipped memory is ~29k units, which is a few MB,
 * so an array plus a Map of postings is both simpler and faster than anything
 * cleverer.
 */

/* --------------------------------------------------------------- normalise */

export function normalize(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,;:!?、。，；：！？]+|[\s.,;:!?、。，；：！？]+$/g, '')
    .trim();
}

const TOKEN_RE = /[a-z0-9\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gi;

export function tokenize(s) {
  const t = normalize(s);
  const out = [];
  // Latin words + CJK bigrams: single CJK chars are far too common to index.
  const latin = t.match(/[a-z0-9]+/g) || [];
  for (const w of latin) if (w.length > 1 || /[0-9]/.test(w)) out.push(w);

  const cjkRuns = t.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) out.push(run);
    else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

function diceOf(A, B) {
  if (!A.size || !B.size) return 0;
  let inter = 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const x of small) if (big.has(x)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

/** Levenshtein similarity in [0,1]; bails out early when lengths differ a lot. */
export function editSimilarity(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 1;
  const ls = s.length;
  const lt = t.length;
  if (!ls || !lt) return 0;
  if (Math.max(ls, lt) / Math.min(ls, lt) > 3) return 0;

  // trim common prefix/suffix to cut the DP size
  let start = 0;
  while (start < ls && start < lt && s[start] === t[start]) start += 1;
  let endS = ls;
  let endT = lt;
  while (endS > start && endT > start && s[endS - 1] === t[endT - 1]) { endS -= 1; endT -= 1; }

  const A = s.slice(start, endS);
  const B = t.slice(start, endT);
  const n = A.length;
  const m = B.length;
  if (!n) return 1 - m / Math.max(ls, lt);
  if (!m) return 1 - n / Math.max(ls, lt);

  let prev = new Uint16Array(m + 1);
  let cur = new Uint16Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ca = A.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = ca === B.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      cur[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  const dist = prev[m];
  return Math.max(0, 1 - dist / Math.max(ls, lt));
}

/* ------------------------------------------------------------ memory index */

export class MemoryIndex {
  /**
   * @param {Array<{src:string,tgt:string,id?:any,props?:Object}>} units
   */
  constructor(units = [], opts = {}) {
    this.units = units;
    this.wDice = opts.wDice == null ? 0.5 : opts.wDice;
    this.build();
  }

  get size() { return this.units.length; }

  build() {
    this.normSrc = new Array(this.units.length);
    this.tokens = new Array(this.units.length);
    this.exactMap = new Map();
    this.postings = new Map();

    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const n = normalize(u.src);
      this.normSrc[i] = n;
      const toks = tokenize(u.src);
      this.tokens[i] = new Set(toks);

      let bucket = this.exactMap.get(n);
      if (!bucket) { bucket = []; this.exactMap.set(n, bucket); }
      bucket.push(i);

      for (const tk of this.tokens[i]) {
        let p = this.postings.get(tk);
        if (!p) { p = []; this.postings.set(tk, p); }
        p.push(i);
      }
    }
  }

  add(units) {
    const base = this.units.length;
    this.units = this.units.concat(units);
    for (let k = 0; k < units.length; k++) {
      const i = base + k;
      const u = units[k];
      const n = normalize(u.src);
      this.normSrc[i] = n;
      const toks = tokenize(u.src);
      this.tokens[i] = new Set(toks);
      let bucket = this.exactMap.get(n);
      if (!bucket) { bucket = []; this.exactMap.set(n, bucket); }
      bucket.push(i);
      for (const tk of this.tokens[i]) {
        let p = this.postings.get(tk);
        if (!p) { p = []; this.postings.set(tk, p); }
        p.push(i);
      }
    }
  }

  exact(src) {
    const ids = this.exactMap.get(normalize(src)) || [];
    return ids.map((i) => ({ unit: this.units[i], score: 100, kind: 'exact', index: i }));
  }

  /**
   * Fuzzy lookup.
   * @param {string} src
   * @param {Object} [opts] { limit, minScore (0-100), maxCandidates }
   */
  search(src, opts = {}) {
    const limit = opts.limit == null ? 5 : opts.limit;
    const minScore = opts.minScore == null ? 50 : opts.minScore;
    const maxCandidates = opts.maxCandidates == null ? 600 : opts.maxCandidates;

    const n = normalize(src);
    if (!n) return [];

    const exactIds = this.exactMap.get(n);
    if (exactIds && exactIds.length) {
      return exactIds.slice(0, limit).map((i) => ({
        unit: this.units[i], score: 100, kind: 'exact', index: i,
      }));
    }

    const qTokens = [...new Set(tokenize(src))];
    if (!qTokens.length) return [];

    // Rare tokens first: they discriminate best.
    qTokens.sort((a, b) => (this.postings.get(a) || []).length - (this.postings.get(b) || []).length);

    const hits = new Map();
    let seen = 0;
    const usedTokens = [];
    for (const tk of qTokens) {
      const p = this.postings.get(tk);
      if (!p || p.length === 0) continue;
      if (p.length > 20000) continue;                       // too common to help
      usedTokens.push(tk);
      for (const id of p) {
        hits.set(id, (hits.get(id) || 0) + 1);
        seen += 1;
      }
      if (seen >= maxCandidates * 4 || usedTokens.length >= 12) break;
    }
    if (!hits.size) return [];

    const qSet = new Set(qTokens);
    const qLen = n.length;

    const cands = [];
    for (const [id, overlap] of hits) {
      const len = this.normSrc[id].length;
      // cheap length guard before the expensive edit distance
      if (len / qLen > 2.6 || qLen / len > 2.6) continue;
      const coverage = overlap / Math.max(1, Math.min(qSet.size, this.tokens[id].size));
      cands.push({ id, coverage });
    }
    if (!cands.length) return [];

    cands.sort((a, b) => b.coverage - a.coverage);
    const pool = cands.slice(0, maxCandidates);

    const out = [];
    for (const c of pool) {
      const dice = diceOf(qSet, this.tokens[c.id]);
      const edit = editSimilarity(n, this.normSrc[c.id]);
      const score = 100 * (this.wDice * dice + (1 - this.wDice) * edit);
      if (score >= minScore) out.push({ unit: this.units[c.id], score, kind: 'fuzzy', index: c.id });
    }
    out.sort((a, b) => b.score - a.score);

    // keep at most 2 targets per distinct source text, so near-duplicates from
    // the same article don't crowd out other candidates
    const res = [];
    const perSrc = new Map();
    for (const r of out) {
      const key = this.normSrc[r.index];
      const k = perSrc.get(key) || 0;
      if (k >= 2) continue;
      perSrc.set(key, k + 1);
      res.push(r);
      if (res.length >= limit) break;
    }
    return res;
  }

  /**
   * Concordance / substring search.
   * @param {string} q
   * @param {Object} [opts] { field: 'src'|'tgt'|'both', caseSensitive, regex, limit }
   */
  concordance(q, opts = {}) {
    const field = opts.field || 'both';
    const limit = opts.limit == null ? 200 : opts.limit;
    if (!q) return [];
    let test;
    if (opts.regex) {
      let re;
      try { re = new RegExp(q, opts.caseSensitive ? 'g' : 'gi'); }
      catch (e) { throw new Error('正则表达式无效: ' + e.message); }
      test = (s) => re.test(s);
    } else if (opts.caseSensitive) {
      test = (s) => s.includes(q);
    } else {
      const nq = q.toLowerCase();
      test = (s) => s.toLowerCase().includes(nq);
    }

    const out = [];
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const a = field === 'tgt' ? false : test(u.src);
      const b = field === 'src' ? false : test(u.tgt);
      if (a || b) {
        out.push({ unit: u, index: i, inSrc: a, inTgt: b });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  stats() {
    const srcSet = this.exactMap.size;
    return {
      units: this.units.length,
      distinctSources: srcSet,
      distinctTokens: this.postings.size,
      duplicateSources: this.units.length - srcSet,
    };
  }
}

/** Rough word-level diff for showing what changed between two segments. */
export function diffWords(a, b) {
  const A = String(a || '').split(/(\s+)/);
  const B = String(b || '').split(/(\s+)/);
  const n = A.length;
  const m = B.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: '=', text: A[i] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: '-', text: A[i] }); i += 1; }
    else { out.push({ op: '+', text: B[j] }); j += 1; }
  }
  while (i < n) { out.push({ op: '-', text: A[i] }); i += 1; }
  while (j < m) { out.push({ op: '+', text: B[j] }); j += 1; }
  return out;
}
