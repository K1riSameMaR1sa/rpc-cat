/**
 * segment.js — text segmentation.
 *
 * Two jobs:
 *   1. split a document into blocks (paragraphs, list items, table rows, …)
 *   2. split a block into sentences, in a way that AGREES between English and
 *      Chinese, because a single disagreement shifts every later sentence.
 *
 * Also extracts "anchors": the language-independent tokens (codes, dates,
 * numbers) used to align two languages, and marks up inline placeholders.
 */

/* ------------------------------------------------------------------ language */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const CJK_ONE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN_TOK_RE = /[A-Za-z0-9]+/g;

export function cjkCount(s) {
  const m = String(s || '').match(CJK_RE);
  return m ? m.length : 0;
}

export function hasCjk(s) { return CJK_ONE.test(String(s || '')); }

export function cjkRatio(s) {
  const t = String(s || '');
  return t ? cjkCount(t) / t.length : 0;
}

export function enWords(s) {
  const m = String(s || '').match(LATIN_TOK_RE);
  return m ? m.length : 0;
}

/** Chinese "word" estimate: CJK chars + latin tokens (codes, names). */
export function cnUnits(s) {
  const t = String(s || '');
  return cjkCount(t) + (t.match(LATIN_TOK_RE) || []).length;
}

export function detectLang(text) {
  return cjkRatio(text) > 0.15 ? 'zh-CN' : 'en-US';
}

/* ------------------------------------------------------------------ anchors */

const MONTHS =
  'January|February|March|April|May|June|July|August|September|October|' +
  'November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';

// Digits must be bounded by an explicit LATIN class: JavaScript's \w and \b are
// ASCII-only, but a naive [^A-Za-z0-9] boundary still breaks "RPC-015" and
// "Site-002", so numbers glued to '-' are excluded and the code patterns below
// pick those up instead.
const NOT_LAT = '(?<![A-Za-z0-9_.\\-])';
const NOT_LAT_A = '(?![A-Za-z0-9_.\\-])';

const CODE_RE = /\b(?:RPC|GRP|ARC|CIA|MST|ACS|EIC|AOI|GOI|UNAAC)[-\s]?(?:CN-|PL-|JP-|KO-|FR-|PT-|ES-|DE-|RU-|SV-)?\d{2,4}\b/gi;
const SITE_RE = /\bSite[-\s]?(\d{1,4})\b/gi;
const AREA_RE = /\bArea[-\s]?(\d{1,4})\b/gi;

/**
 * Language-independent anchor tokens.
 * Dates are normalised to DATE-<year> so that "5/12/2017", "12 May 2017" and
 * "2017年5月12日" all produce the same token.
 */
export function getAnchors(text) {
  const t = String(text || '');
  const out = [];
  const push = (v) => { if (v) out.push(v); };

  for (const m of t.matchAll(CODE_RE)) push(m[0].replace(/\s+/g, '').toUpperCase());
  for (const m of t.matchAll(SITE_RE)) push('SITE-' + m[1]);
  for (const m of t.matchAll(AREA_RE)) push('AREA-' + m[1]);
  if (t.includes('\u2588')) push('REDACT');

  let m;
  const reIso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = reIso.exec(t))) push('DATE-' + m[1]);

  const reSlash = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g;
  while ((m = reSlash.exec(t))) push('DATE-' + m[3]);

  const reDmy = new RegExp(`\\b(\\d{1,2})\\s+(?:${MONTHS})[a-z]*\\.?,?\\s*(\\d{3,4})`, 'gi');
  while ((m = reDmy.exec(t))) push('DATE-' + m[2]);

  const reMdy = new RegExp(`(?:${MONTHS})[a-z]*\\.?\\s+(\\d{1,2}),?\\s*(\\d{3,4})`, 'gi');
  while ((m = reMdy.exec(t))) push('DATE-' + m[2]);

  const reCnYear = /(\d{3,4})\s*\u5e74/g;
  while ((m = reCnYear.exec(t))) push('DATE-' + m[1]);

  const reDec = new RegExp(NOT_LAT + '(\\d+(?:[.,]\\d+)+)' + NOT_LAT_A, 'g');
  while ((m = reDec.exec(t))) push('D' + m[1].replace(',', '.'));

  const rePct = /(\d+(?:[.,]\d+)?)\s*%/g;
  while ((m = rePct.exec(t))) push('PCT' + m[1].replace(',', '.'));

  const reOrd = /\b(\d{1,4})(?:st|nd|rd|th)\b/gi;
  while ((m = reOrd.exec(t))) push('N' + m[1]);

  const reNum = new RegExp(NOT_LAT + '(\\d{2,4})' + NOT_LAT_A, 'g');
  while ((m = reNum.exec(t))) push('N' + m[1]);

  return out;
}

/* --------------------------------------------------------------- labels */

/**
 * Structural section labels. Used as strong alignment anchors.
 * Longest key wins, so bare prefixes are safe to include.
 */
export const LABELS = {
  'registered phenomena code': 'item', 'phenomena code': 'item',
  'item #': 'item', 'item#': 'item',
  '现象注册码': 'item', '現象註冊碼': 'item', '注册码': 'item', '註冊碼': 'item',
  '现象识别码': 'item', '项目编号': 'item', '項目編號': 'item',

  'object class': 'class', objectclass: 'class',
  '项目分级': 'class', '項目分級': 'class', '项目等级': 'class',
  '項目等級': 'class', '分级': 'class', '等級': 'class',

  'containment protocols': 'containment', 'containment protocol': 'containment',
  'special containment procedures': 'containment',
  '收容协议': 'containment', '收容協議': 'containment',
  '收容措施': 'containment', '特殊收容措施': 'containment',

  description: 'description', '描述': 'description',

  'hazard types': 'hazard', 'threat types': 'hazard', 'hazard type': 'hazard',
  'threat level': 'threat',
  '危害类型': 'hazard', '危害類型': 'hazard', '威胁类型': 'hazard',
  '威胁等级': 'threat', '威脅等級': 'threat', '危害': 'hazard',

  'discovery log': 'discovery', 'recovery log': 'discovery',
  'exploration log': 'discovery', 'test log': 'discovery',
  'incident log': 'discovery', 'experiment log': 'discovery',
  discovery: 'discovery',
  '发现记录': 'discovery', '發現記錄': 'discovery', '发现日志': 'discovery',
  '探索记录': 'discovery', '回收记录': 'discovery', '回收日志': 'discovery',
  '测试记录': 'discovery', '实验记录': 'discovery', '事件记录': 'discovery',
  '事故报告': 'discovery', '发现': 'discovery', '發現': 'discovery',

  addendum: 'addendum', appendix: 'addendum', '附录': 'addendum', '附錄': 'addendum',
  foreword: 'foreword', preamble: 'foreword', '前言': 'foreword',
  clearance: 'clearance', '权限': 'clearance', '權限': 'clearance',
  site: 'site', '设施': 'site', '設施': 'site',
  update: 'update', '更新': 'update',
  note: 'note', memo: 'note', '备注': 'note', '備註': 'note',
  '注释': 'note', '註釋': 'note', '备忘录': 'note',
  reference: 'ref', '参考': 'ref', '參考': 'ref',
  author: 'author', '作者': 'author',
  translator: 'translator', '译者': 'translator', '譯者': 'translator',
  original: 'original', '原文': 'original',
};

const LABEL_KEYS = Object.keys(LABELS).sort((a, b) => b.length - a.length);

export function detectLabel(text) {
  let head = String(text || '').slice(0, 70).trim().toLowerCase();
  head = head.replace(/^[*\s#]+/, '');
  for (const key of LABEL_KEYS) {
    if (head.startsWith(key)) {
      const rest = head.slice(key.length).replace(/^\s+/, '');
      const c = rest.slice(0, 1);
      if (c === ':' || c === '：' || c === '-' || c === '—' || c === '' ||
          c === '(' || c === '（') {
        return LABELS[key];
      }
    }
  }
  return null;
}

/* --------------------------------------------------------------- sentences */

// U+2026 (…) counts as an English terminator: the Chinese branch splits on ……,
// and if only one side splits there, every following sentence pair is wrong.
const EN_END = /([.!?\u2026]+["')\]\u201d\u2019]*)/g;
const ZH_END = /([\u3002\uff01\uff1f\uff1b\u2026]+["'\u300d\u300f\u3011\uff09]*)/g;

const EN_ABBREV = new Set((
  'mr mrs ms dr prof sr jr st vs etc eg ie cf al approx dept est fig no vol pp ' +
  'inc ltd co corp gov sen rep gen col capt lt sgt maj adm rev hon pres supt insp ' +
  'min max avg temp hr hrs sec secs yr yrs am pm bc ad ce bce mt ft lb oz kg ' +
  'km cm mm ml mg kw kwh hz khz mhz ghz'
).split(' '));

export function cleanText(s) {
  return String(s == null ? '' : s)
    .normalize('NFC')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\u00ad/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .trim();
}

export function splitSentencesEn(text) {
  const t = cleanText(text);
  if (!t) return [];
  const parts = [];
  let start = 0;
  EN_END.lastIndex = 0;
  let m;
  while ((m = EN_END.exec(t))) {
    const end = m.index + m[0].length;
    if (m[1].startsWith('.')) {
      const pre = t.slice(start, m.index);
      const word = (pre.split(/[\s("[“]/).pop() || '').toLowerCase().replace(/\.+$/, '');
      if (EN_ABBREV.has(word)) continue;
      if (word.length === 1 && /[a-z]/.test(word)) continue;
      const prevCh = m.index > 0 ? t[m.index - 1] : '';
      const nextCh = end < t.length ? t[end] : '';
      if (/[0-9]/.test(prevCh) && /[0-9]/.test(nextCh)) continue;   // 3.14
    }
    const rest = t.slice(end, end + 2);
    if (rest && !/^\s/.test(rest)) {
      const closing = /["'\u201d\u2019]$/.test(m[1]);
      if (!(closing && /^[A-Z]/.test(rest))) continue;
    }
    parts.push(t.slice(start, end).trim());
    start = end;
  }
  const tail = t.slice(start).trim();
  if (tail) parts.push(tail);
  return parts.filter(Boolean);
}

/** Split a Chinese block into sentences, keeping terminal punctuation. */
export function splitSentencesZh(text) {
  const t = cleanText(text);
  if (!t) return [];
  const parts = [];
  let start = 0;
  ZH_END.lastIndex = 0;
  let m;
  while ((m = ZH_END.exec(t))) {
    let end = m.index + m[0].length;
    while (end < t.length && /[\u300d\u300f\u3011\uff09"']/.test(t[end])) end += 1;
    const seg = t.slice(start, end).trim();
    if (seg) parts.push(seg);
    start = end;
    ZH_END.lastIndex = end;
  }
  const tail = t.slice(start).trim();
  if (tail) parts.push(tail);
  return parts.filter(Boolean);
}

export function splitSentences(text, lang) {
  return String(lang || '').toLowerCase().startsWith('zh')
    ? splitSentencesZh(text)
    : splitSentencesEn(text);
}

/* ------------------------------------------------------------------ blocks */

const WIKIDOT_STRUCT = /^(\*+\s|#+\s|\++\s|>+\s|\|\||----+|={4,})/;

/**
 * Split a plain-text / Wikidot document into aligned-able blocks.
 * Blank lines end a block; Wikidot list items, headings and table rows each
 * become their own block so structure survives into the alignment.
 */
export function splitBlocks(text) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const blocks = [];
  let buf = [];

  const flush = () => {
    const joined = buf.join('\n');
    const t = cleanText(joined);
    buf = [];
    if (t) blocks.push(t);
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) { flush(); continue; }
    if (WIKIDOT_STRUCT.test(line.trim())) { flush(); blocks.push(cleanText(line)); continue; }
    buf.push(line);
  }
  flush();
  return blocks;
}

/* ------------------------------------------------------- placeholder markup */

const PLACEHOLDER_RES = [
  /█+/g,
  /\[\[\[?\/?[^\]]*\]\]\]?/g,
  /\{\{[^}]*\}\}/g,
  /@@[^@]+@@/g,
  /\*\*[^*]+\*\*/g,
  /\/\/[^/]+\/\//g,
  /__(?:[^_]|_(?!_))+__/g,
  /\b(?:RPC|GRP|ARC|CIA|MST|ACS|EIC|AOI|GOI|UNAAC)[-\s]?(?:CN-|PL-|JP-|KO-)?\d{2,4}\b/gi,
  /\bSite[-\s]?\d{1,4}\b/gi,
  /\bArea[-\s]?\d{1,4}\b/gi,
  /\b\d+(?:[.,]\d+)+\b/g,
  /\b\d{2,4}\b/g,
];

/**
 * Escape HTML, then wrap placeholders that must survive translation verbatim.
 * Used only for display (`<mark>`), never for stored text.
 */
export function highlightPlaceholders(text) {
  const esc = String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const spans = [];
  for (const re of PLACEHOLDER_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(esc))) spans.push([m.index, m.index + m[0].length]);
  }
  if (!spans.length) return esc;
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  let out = '';
  let pos = 0;
  for (const [a, b] of merged) {
    out += esc.slice(pos, a) + '<mark>' + esc.slice(a, b) + '</mark>';
    pos = b;
  }
  out += esc.slice(pos);
  return out;
}

/** Placeholders present in a string, as a multiset signature for QA checks. */
export function placeholderSignature(text) {
  const t = String(text || '');
  const codes = (t.match(/\b(?:RPC|GRP|ARC|CIA|MST|ACS|EIC|AOI|GOI|UNAAC)[-\s]?(?:CN-|PL-|JP-|KO-)?\d{2,4}\b/gi) || [])
    .map((s) => s.replace(/\s+/g, '').toUpperCase());
  const nums = (t.match(/\d+(?:[.,]\d+)*/g) || []).map((s) => s.replace(',', '.'));
  const bars = (t.match(/█+/g) || []).length;
  return { codes: codes.sort(), nums: nums.sort(), bars };
}
