/**
 * document.js — structure-preserving document model.
 *
 * The rest of the app works on sentences, which is right for a translation
 * memory but wrong for a Wikidot source file: flattening the text and splitting
 * it loses line breaks, blank lines, tables and code blocks, so the output can
 * never be pasted back.
 *
 * This module parses a document into blocks that remember their exact original
 * form, and can rebuild the file with translations substituted in.
 *
 *   Block = {
 *     kind : 'prose' | 'code' | 'table' | 'markup' | 'blank',
 *     eol  : the line ending that followed the block ('\n' or ''),
 *     parts: [ {type:'literal', text}
 *            | {type:'text', src, sentences:[{src,tgt}], seps:[...]} ]
 *   }
 *
 * Reconstruction is `parts.map(literal ? text : join(translations, seps))` plus
 * `eol`, so an untouched document round-trips byte for byte.
 */

import { splitSentences } from './segment.js';

export const KIND = {
  PROSE: 'prose',
  CODE: 'code',
  TABLE: 'table',
  MARKUP: 'markup',
  BLANK: 'blank',
};

/* ------------------------------------------------------------- masking */

/**
 * Inline constructs that must never be split across sentences.  Each one is
 * replaced by same-length sentinels from the private use area, so sentence
 * offsets stay valid in the original text.
 */
const MASK_RES = [
  /https?:\/\/[^\s\]|}]+/g,                                    // URLs (before //italic//)
  /\[\[\[[\s\S]*?\]\]\]/g,                                     // [[[link]]]
  /\[\[\$[\s\S]*?\$\]\]/g,                                     // [[$ math $]]
  /\[\[\/?(?:code|html|module|include|collapsible|collapsible-button|footnote|span|div|size|color|math|embed|iframe|tabview|tab|table|row|cell|f>|f<|==|=|\*|>|<)[^\]]*\]\]/gi,
  /@@[\s\S]*?@@/g,                                             // @@inline code@@
  /\{\$[\w:.-]+\}/g,                                           // {$template-var}
  /\*\*[\s\S]*?\*\*/g,
  /(?<!:)\/\/[\s\S]*?\/\//g,                                   // //italic//
  /__[\s\S]*?__/g,
  /##[\s\S]*?##/g,
  /\^\^[\s\S]*?\^\^/g,
  /~~[\s\S]*?~~/g,
  /\{\{[\s\S]*?\}\}/g,
  /<[a-z/][^>]*>/gi,                                           // stray HTML tags
];

const SENTINEL = '\uE000';

export function maskPlaceholders(text) {
  let out = text;
  for (const re of MASK_RES) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => SENTINEL.repeat(m.length));
  }
  return out;
}

/* ------------------------------------------------------------- parsing */

const RE_CODE_OPEN = /^\s*\[\[(code|html)\b[^\]]*\]\]/i;
const RE_CODE_CLOSE = /\[\[\/(?:code|html)\]\]\s*$/i;
const RE_FENCE = /^\s*(`{3,}|~{3,})/;

const RE_LIST = /^([*#]+\s+)/;
const RE_HEADING = /^(\++\s+)/;
const RE_QUOTE = /^(>+\s*)/;
const RE_TABLE_ROW = /^\s*\|\|/;

const RE_MARKUP_ONLY = /^\s*(?:\[\[[^\]]*\]\]|\[\[\[[^\]]*\]\]\]|-{4,}|={4,}|<[^>]*>|\s)*$/;

function splitLines(text) {
  const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const lines = [];
  let i = 0;
  while (i <= src.length - 1) {
    const j = src.indexOf('\n', i);
    if (j === -1) { lines.push({ text: src.slice(i), eol: '' }); break; }
    lines.push({ text: src.slice(i, j), eol: '\n' });
    i = j + 1;
  }
  if (src === '') lines.push({ text: '', eol: '' });
  return lines;
}

function literal(text) { return { type: 'literal', text }; }

/** Split leading/trailing whitespace off, keeping it as literal parts. */
function edgeParts(text, lang) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const [, lead, core, trail] = m;
  const parts = [];
  if (lead) parts.push(literal(lead));
  if (core) parts.push(makeTextPart(core, lang));
  if (trail) parts.push(literal(trail));
  return parts.length ? parts : [literal(text)];
}

/**
 * A translatable run of text, split into sentences while recording the exact
 * whitespace between them so the run can be rebuilt verbatim.
 */
export function makeTextPart(text, lang) {
  if (!text) return literal('');
  const masked = maskPlaceholders(text);
  const sents = splitSentences(masked, lang);
  if (sents.length <= 1) {
    // `text` is already edge-trimmed by the caller, so it is the single unit
    return { type: 'text', src: text, sentences: [{ src: text, tgt: '' }], seps: [''] };
  }

  const sentences = [];
  const seps = [];
  let cursor = 0;
  for (let k = 0; k < sents.length; k++) {
    let idx = masked.indexOf(sents[k], cursor);
    if (idx === -1) idx = cursor;
    const end = idx + sents[k].length;
    let next = text.length;
    if (k + 1 < sents.length) {
      const n = masked.indexOf(sents[k + 1], end);
      if (n !== -1) next = n;
    }
    // slice from the ORIGINAL text: masking preserved offsets
    sentences.push({ src: text.slice(idx, end), tgt: '' });
    seps.push(text.slice(end, next));
    cursor = end;
  }
  return { type: 'text', src: text, sentences, seps };
}

/** One `||`-delimited cell: a leading `~` marks a header cell and stays literal. */
function cellParts(chunk, lang) {
  const hm = /^(\s*~+\s*)([\s\S]*)$/.exec(chunk);
  if (hm && hm[2]) return [literal(hm[1]), ...edgeParts(hm[2], lang)];
  return edgeParts(chunk, lang);
}

function parseTableRow(line, lang) {
  const parts = [];
  let cursor = 0;
  const re = /\|\|/g;
  let m;
  while ((m = re.exec(line))) {
    const chunk = line.slice(cursor, m.index);
    if (chunk) parts.push(...cellParts(chunk, lang));
    parts.push(literal('||'));
    cursor = m.index + 2;
  }
  const tail = line.slice(cursor);
  if (tail) parts.push(...cellParts(tail, lang));
  return parts;
}

function parseLine(line, lang) {
  const raw = line.text;

  if (raw.trim() === '') {
    return { kind: KIND.BLANK, eol: line.eol, parts: [literal(raw)] };
  }

  if (RE_TABLE_ROW.test(raw)) {
    return { kind: KIND.TABLE, eol: line.eol, parts: parseTableRow(raw, lang) };
  }

  if (RE_MARKUP_ONLY.test(raw)) {
    return { kind: KIND.MARKUP, eol: line.eol, parts: [literal(raw)] };
  }

  // markers stay literal; only the content after them is translated
  let m;
  if ((m = RE_LIST.exec(raw))) {
    return { kind: KIND.PROSE, eol: line.eol, parts: [literal(m[1]), ...edgeParts(raw.slice(m[1].length), lang)] };
  }
  if ((m = RE_HEADING.exec(raw))) {
    return { kind: KIND.PROSE, eol: line.eol, parts: [literal(m[1]), ...edgeParts(raw.slice(m[1].length), lang)] };
  }
  if ((m = RE_QUOTE.exec(raw))) {
    return { kind: KIND.PROSE, eol: line.eol, parts: [literal(m[1]), ...edgeParts(raw.slice(m[1].length), lang)] };
  }

  return { kind: KIND.PROSE, eol: line.eol, parts: edgeParts(raw, lang) };
}

/**
 * Parse a document into structure-preserving blocks.
 * @param {string} text
 * @param {string} [lang] source language, for sentence splitting ('en-US'|'zh-CN')
 */
export function parseDocument(text, lang = 'en-US') {
  const lines = splitLines(text);
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const fence = RE_FENCE.exec(line.text);
    const isWikidotCode = RE_CODE_OPEN.test(line.text);
    const closedOnSameLine = isWikidotCode && RE_CODE_CLOSE.test(line.text);

    if ((fence || isWikidotCode) && !closedOnSameLine) {
      // consume the whole code block verbatim
      const body = [line.text];
      let eol = line.eol;
      i += 1;
      for (;;) {
        if (i >= lines.length) break;
        const cur = lines[i];
        body.push(cur.text);
        eol = cur.eol;
        i += 1;
        const done = fence
          ? new RegExp('^\\s*' + fence[1] + '\\s*$').test(cur.text) && body.length > 1
          : RE_CODE_CLOSE.test(cur.text);
        if (done) break;
      }
      blocks.push({
        kind: KIND.CODE,
        eol,
        parts: [literal(body.join('\n'))],
        sealed: true,
      });
      continue;
    }

    blocks.push(parseLine(line, lang));
    i += 1;
  }

  return blocks;
}

/* -------------------------------------------------------- reconstruction */

function joinSentences(part, useTarget) {
  let out = '';
  for (let k = 0; k < part.sentences.length; k++) {
    const s = part.sentences[k];
    const body = useTarget && s.tgt ? s.tgt : s.src;
    out += body + (part.seps[k] || '');
  }
  return out;
}

/**
 * Rebuild the document. With `useTarget` the translations are substituted;
 * untranslated text falls back to the source, so nothing is ever lost.
 */
export function reconstruct(blocks, { useTarget = true } = {}) {
  let out = '';
  for (const b of blocks) {
    if (b.kind === KIND.CODE) {
      out += b.parts[0].text;                 // verbatim, never translated
    } else {
      for (const p of b.parts) {
        out += p.type === 'literal' ? p.text : joinSentences(p, useTarget);
      }
    }
    out += b.eol || '';
  }
  return out;
}

/* ------------------------------------------------------------------ query */

/** Every translatable text part, in document order. */
export function* iterTextParts(blocks) {
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (b.kind === KIND.CODE || b.kind === KIND.MARKUP || b.kind === KIND.BLANK) continue;
    for (let pi = 0; pi < b.parts.length; pi++) {
      const p = b.parts[pi];
      if (p.type === 'text') yield { block: b, blockIndex: bi, part: p, partIndex: pi };
    }
  }
}

export function documentStats(blocks) {
  let sentences = 0;
  let translated = 0;
  let chars = 0;
  const kinds = { prose: 0, code: 0, table: 0, markup: 0, blank: 0 };
  for (const b of blocks) {
    kinds[b.kind] = (kinds[b.kind] || 0) + 1;
    if (b.kind === KIND.CODE) continue;
    for (const p of b.parts) {
      if (p.type !== 'text') continue;
      for (const s of p.sentences) {
        sentences += 1;
        chars += s.src.length;
        if (s.tgt && s.tgt.trim()) translated += 1;
      }
    }
  }
  return { blocks: blocks.length, sentences, translated, chars, kinds };
}

/** Flattened (source, target) pairs for the parts that have a translation. */
export function collectPairs(blocks) {
  const out = [];
  for (const { part } of iterTextParts(blocks)) {
    for (const s of part.sentences) {
      if (s.tgt && s.tgt.trim() && s.src.trim()) {
        out.push({ src: s.src, tgt: s.tgt });
      }
    }
  }
  return out;
}

/**
 * Plain text of every translatable block, in order — for the aligner, which
 * only cares about pairable prose and wants code blocks and markup excluded.
 */
export function translatableBlocks(text, lang = 'en-US') {
  const blocks = parseDocument(text, lang);
  const out = [];
  for (const b of blocks) {
    if (b.kind === KIND.CODE || b.kind === KIND.MARKUP || b.kind === KIND.BLANK) continue;
    const t = b.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.src)
      .join(' ')
      .trim();
    if (t) out.push(t);
  }
  return out;
}

/** Flattened index of every sentence, for keyboard navigation and progress. */
export function flattenSentences(blocks) {
  const flat = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (b.kind === KIND.CODE || b.kind === KIND.MARKUP || b.kind === KIND.BLANK) continue;
    for (let pi = 0; pi < b.parts.length; pi++) {
      const p = b.parts[pi];
      if (p.type !== 'text') continue;
      for (let si = 0; si < p.sentences.length; si++) {
        flat.push({ bi, pi, si, block: b, part: p, sentence: p.sentences[si] });
      }
    }
  }
  return flat;
}
