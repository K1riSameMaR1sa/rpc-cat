/**
 * glossary.js — the term base and per-sentence term lookup.
 *
 * The shipped file is TSV (en, zh, source, count, consistency), gzipped:
 *
 *   en              the English term
 *   zh              its Chinese rendering
 *   source          'memory' (mined from the translation memory),
 *                   'wiki'   (agreed by the wiki's own index pages), or 'both'
 *   count           how many translation units the term occurred in
 *   consistency     how often those units used the same Chinese string
 *
 * `consistency` is the honest quality signal: 1.0 means every occurrence was
 * rendered the same way, 0.6 means it varied. Terms are mined automatically, so
 * the score is what tells a curator which ones deserve a second look.
 */

import { readMaybeGzip } from './master.js';

/* ------------------------------------------------------------------ loading */

let _cache = null;

function parseTsv(text) {
  const entries = [];
  for (const line of String(text).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [en, zh, source, count, consistency] = line.split('\t');
    if (!en || !zh) continue;
    entries.push({
      en,
      zh,
      source: source || 'memory',
      count: Number(count) || 0,
      consistency: Number(consistency) || 0,
    });
  }
  return new Glossary(entries);
}

/**
 * Load the shipped term base. The single-file build inlines it; otherwise it is
 * fetched from data/.
 * @returns {Promise<Glossary|null>}
 */
export async function loadGlossary() {
  if (_cache) return _cache;
  try {
    if (globalThis.__RPC_CAT_GLOSSARY_GZ) {
      const bin = atob(globalThis.__RPC_CAT_GLOSSARY_GZ);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      _cache = parseTsv(await readMaybeGzip(bytes.buffer));
      return _cache;
    }
    const res = await fetch('data/glossary.tsv.gz', { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _cache = parseTsv(await readMaybeGzip(await res.arrayBuffer()));
  } catch {
    _cache = null;            // no term base available: the app still works
  }
  return _cache;
}

export function getGlossary() { return _cache; }

/* ------------------------------------------------------------------ lookup */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Glossary {
  /** @param {Array<{en:string,zh:string,source:string,count:number,consistency:number}>} entries */
  constructor(entries) {
    this.entries = entries;
    this.byToken = new Map();

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      // word-boundary matching, case-insensitive; tolerant of the hyphen and
      // spacing variants that appear in the source text
      const body = e.en.split(/\s+/).map(escapeRe).join('[\\s-]+');
      try {
        e._re = new RegExp(`(^|[^A-Za-z0-9])(${body})(?![A-Za-z0-9])`, 'i');
      } catch {
        e._re = null;
        continue;
      }
      e._len = e.en.length;
      const tokens = new Set((e.en.toLowerCase().match(/[a-z0-9]+/g) || []));
      for (const t of tokens) {
        let list = this.byToken.get(t);
        if (!list) { list = []; this.byToken.set(t, list); }
        list.push(i);
      }
    }
  }

  get size() { return this.entries.length; }

  stats() {
    const bySource = {};
    for (const e of this.entries) bySource[e.source] = (bySource[e.source] || 0) + 1;
    const avg = this.entries.length
      ? this.entries.reduce((a, e) => a + e.consistency, 0) / this.entries.length
      : 0;
    return { total: this.entries.length, bySource, avgConsistency: Math.round(avg * 100) / 100 };
  }

  /**
   * Terms occurring in a sentence, longest first, with overlaps removed so that
   * "Authority Security Force" does not also report "Authority" and "Security".
   * @param {string} text
   * @param {Object} [opts] { limit }
   */
  lookup(text, opts = {}) {
    const limit = opts.limit == null ? 12 : opts.limit;
    const s = String(text || '');
    if (!s) return [];

    const tokens = new Set(s.toLowerCase().match(/[a-z0-9]+/g) || []);
    const candidates = new Set();
    for (const t of tokens) {
      const list = this.byToken.get(t);
      if (list) for (const i of list) candidates.add(i);
    }
    if (!candidates.size) return [];

    const hits = [];
    for (const i of candidates) {
      const e = this.entries[i];
      if (!e._re) continue;
      const m = e._re.exec(s);
      if (!m) continue;
      const start = m.index + m[1].length;
      hits.push({ entry: e, start, end: start + m[2].length });
    }
    if (!hits.length) return [];

    // longest match wins; a term fully covered by one already kept is dropped
    hits.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
    const kept = [];
    for (const h of hits) {
      const covered = kept.some((k) => h.start >= k.start && h.end <= k.end);
      if (covered) continue;
      kept.push(h);
      if (kept.length >= limit) break;
    }
    kept.sort((a, b) => a.start - b.start);
    return kept.map((k) => ({ ...k.entry, start: k.start, end: k.end }));
  }

  /** Substring search over terms, for the term-base browser. */
  search(q, { limit = 200, field = 'both' } = {}) {
    const query = String(q || '').toLowerCase();
    if (!query) return [];
    const out = [];
    for (const e of this.entries) {
      const a = field === 'zh' ? false : e.en.toLowerCase().includes(query);
      const b = field === 'en' ? false : e.zh.includes(q);
      if (a || b) {
        out.push(e);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /** TSV export, so a curator can review and edit the table in a spreadsheet. */
  toTsv() {
    const lines = ['# en\tzh\tsource\tcount\tconsistency'];
    for (const e of this.entries) {
      lines.push([e.en, e.zh, e.source, e.count, e.consistency].join('\t'));
    }
    return `${lines.join('\n')}\n`;
  }
}
