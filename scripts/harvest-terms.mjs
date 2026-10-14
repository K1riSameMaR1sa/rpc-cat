/**
 * scripts/harvest-terms.mjs — regenerate data/glossary-curated.json.
 *
 * Maintenance script (needs network). The wiki's index pages are PARALLEL: the
 * English and Chinese branches cover the same pages. Terms are read off them
 * two ways:
 *
 *   (a) link titles paired by target slug. Both branches link the same slug with
 *       a translated title, so the pairing is the translators' own —
 *       "Amnestics" / "记忆删除", "Viderics" / "真视素".
 *   (b) bold runs, paired per tab and ONLY when the two sides have the same
 *       number of entries. Pairing a whole page as one sequence is not safe:
 *       the hazards page has a tab whose entries are ordered differently in each
 *       branch, and aligning across the page drifted by one from there on
 *       ("Animated" ended up paired with "水生性"). Rather than guess, anything
 *       that does not line up exactly is dropped.
 *
 *   node scripts/harvest-terms.mjs
 *
 * The output is committed, so `npm run make-glossary` stays offline.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'glossary-curated.json');

const EN = 'https://rpc-wiki.net';
const CN = 'https://rpc-wiki-cn.wikidot.com';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36 rpc-cat-glossary/1.0';

/** [english slug, chinese slug] — mostly identical, with known divergences. */
const PAGES = [
  ['terminology-index', 'terminology-index'],
  ['object-classes', 'object-classes'],
  ['threats-hazards', 'threats-hazards'],
  ['security-clearance-levels', 'security-clearance-levels'],
  ['list-of-all-msts', 'mst-registry'],
  ['groups-of-interest', 'groups-of-interest'],
  ['governments-of-interest', 'governments-of-interest'],
  ['alternate-realities', 'alternate-realities'],
  ['site-index', 'site-index'],
  ['personnel-dossier', 'personnel-dossier'],
  ['directorate', 'directorate'],
  ['about-the-rpc-authority', 'about-the-rpc-authority'],
  ['acs-guide', 'acs-guide'],
  ['amnestics', 'amnestics'],
  ['viderics-guide', 'viderics-guide'],
  ['memotics-hub', 'memotics-hub'],
  ['authority-departmental-hierarchy', 'authority-departmental-hierarchy'],
  ['operational-districts', 'operational-districts'],
  ['authority-security-force', 'authority-security-force'],
  ['authority-central-intelligence', 'authority-central-intelligence'],
  ['office-of-financial-affairs', 'office-of-financial-affairs'],
  ['global-operations', 'global-operations'],
  ['authority-regional-sites', 'authority-regional-sites'],
];

async function get(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i === tries) throw err;
      await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
  return '';
}

const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

const bodyOf = (html) => {
  const i = html.indexOf('id="page-content"');
  return i === -1 ? html : html.slice(i);
};

/** Every internal link with a human title on the page, keyed by target slug. */
function linksBySlug(html) {
  const body = bodyOf(html);
  const out = new Map();
  const re = /<a\b[^>]*href="\/([A-Za-z0-9\-_%:.]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(body))) {
    const slug = m[1];
    if (!slug || slug.startsWith('system:') || slug.startsWith('forum:')) continue;
    const title = decode(m[2].replace(/<[^>]*>/g, ''));
    if (!title || title.length > 60) continue;
    if (/^[!?#]/.test(title)) continue;
    if (!out.has(slug)) out.set(slug, title);
  }
  return out;
}

/** Every <strong> run inside a fragment, in document order. */
function strongsIn(fragment) {
  const out = [];
  for (const m of fragment.matchAll(/<strong>([\s\S]*?)<\/strong>/g)) {
    const t = decode(m[1].replace(/<[^>]*>/g, ''));
    if (t && t.length <= 48) out.push(t);
  }
  return out;
}

/** Bold runs split per tab, falling back to the whole body when untabbed. */
function strongSections(html) {
  const body = bodyOf(html);
  const parts = body.split(/<div id="wiki-tab-\d+-\d+"/);
  const sections = parts.map(strongsIn).filter((s) => s.length);
  return sections.length ? sections : [strongsIn(body)];
}

/** Trim a trailing colon (both branches mark terms with one) and tidy up. */
const tidyTerm = (s) => String(s).replace(/[：:]\s*$/, '').trim();

function isUsefulPair(en, zh) {
  const a = tidyTerm(en);
  const b = tidyTerm(zh);
  if (!a || !b) return false;
  if (a.length < 2 || b.length < 1) return false;      // drop "R" / "a" noise
  if (a === b) return false;
  if (a.length > 34 || b.length > 16) return false;
  if (!/[A-Za-z]/.test(a)) return false;

  // Reject the shapes that only look like terms: redacted personnel lines,
  // list bullets, and whole clauses that happen to be bold.
  if (a.includes('\u2588') || b.includes('\u2588')) return false;
  if (/^[-*+>#\s]/.test(a)) return false;
  if (/[,;，；、]/.test(a) || /[,;，；]/.test(b)) return false;
  if (/\s{2,}/.test(a)) return false;
  if (a.split(/\s+/).filter(Boolean).length > 4) return false;
  if (/[.!?。！？]/.test(a.replace(/\.$/, ''))) return false;

  // the Chinese side is either translated or kept as a latin term
  if (!/[\u4e00-\u9fff]/.test(b) && !/[A-Za-z]/.test(b)) return false;
  return true;
}

const terms = new Map();     // en(lower) -> record
const report = [];

function addTerm(en, zh, source) {
  if (!isUsefulPair(en, zh)) return false;
  const a = tidyTerm(en);
  const b = tidyTerm(zh);
  const key = a.toLowerCase();
  const cur = terms.get(key);
  if (cur) {
    if (cur.zh !== b) cur.variants.add(b);
    cur.sources.add(source);
  } else {
    terms.set(key, { en: a, zh: b, variants: new Set(), sources: new Set([source]) });
  }
  return true;
}

for (const [enSlug, cnSlug] of PAGES) {
  let enHtml;
  let cnHtml;
  try {
    enHtml = await get(`${EN}/${enSlug}`);
    cnHtml = await get(`${CN}/${cnSlug}`);
  } catch (err) {
    report.push(`  ${enSlug}: FETCH FAILED (${err.message})`);
    continue;
  }

  const enLinks = linksBySlug(enHtml);
  const cnLinks = linksBySlug(cnHtml);
  let byLink = 0;
  for (const [slug, enTitle] of enLinks) {
    const zhTitle = cnLinks.get(slug);
    if (!zhTitle) continue;
    if (enTitle.length > 48 || zhTitle.length > 24) continue;
    if (addTerm(enTitle, zhTitle, enSlug)) byLink += 1;
  }

  const enSections = strongSections(enHtml);
  const cnSections = strongSections(cnHtml);
  let byStrong = 0;
  let skipped = 0;
  for (let k = 0; k < Math.min(enSections.length, cnSections.length); k++) {
    const a = enSections[k];
    const b = cnSections[k];
    if (a.length !== b.length) { skipped += a.length; continue; }
    for (let n = 0; n < a.length; n++) if (addTerm(a[n], b[n], enSlug)) byStrong += 1;
  }

  const enCount = enSections.reduce((n, s) => n + s.length, 0);
  const cnCount = cnSections.reduce((n, s) => n + s.length, 0);
  report.push(`  ${enSlug.padEnd(34)} links=${String(enLinks.size).padStart(3)}/${String(cnLinks.size).padStart(3)}`
    + ` -> ${String(byLink).padStart(3)}   strong=${String(enCount).padStart(3)}/${String(cnCount).padStart(3)}`
    + ` -> ${String(byStrong).padStart(3)}${skipped ? ` (skipped ${skipped})` : ''}`);
}

const list = [...terms.values()]
  .map((t) => ({
    en: t.en,
    zh: t.zh,
    variants: [...t.variants],
    sources: [...t.sources].sort(),
  }))
  .sort((a, b) => a.en.localeCompare(b.en));

const payload = {
  note: 'Curated terminology harvested from the RPC Authority wiki index pages. '
    + 'Link titles are paired by target slug, so the pairing is the translators\' own. '
    + 'Edit freely — npm run make-glossary merges this with terms mined from the '
    + 'translation memory.',
  generatedBy: 'scripts/harvest-terms.mjs',
  sources: PAGES.map(([e, c]) => ({ en: `${EN}/${e}`, zh: `${CN}/${c}` })),
  count: list.length,
  terms: list,
};

writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

console.log(report.join('\n'));
console.log(`\ncurated terms : ${list.length}`);
console.log(`wrote         : ${relative(ROOT, OUT)}`);
