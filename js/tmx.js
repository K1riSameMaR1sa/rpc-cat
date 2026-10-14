/**
 * tmx.js — TMX 1.4 reader / writer.
 *
 * Deliberately dependency-free: a small tag scanner rather than DOMParser, so
 * the exact same code runs in the browser and under Node in the tests (Node has
 * no DOMParser).  Handles the TMX subset produced by CAT tools and by this app:
 * header props, tu/tuid/props, tuv/xml:lang, seg including CDATA, XML entities
 * and inline tag pairs.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function unescapeXml(s) {
  if (!s || s.indexOf('&') === -1) return s || '';
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = ENTITIES[body];
    return v === undefined ? m : v;
  });
}

export function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeAttr(s) {
  return escapeXml(s).replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ parsing */

/** Decode one run of character data, honouring CDATA sections. */
function decodeChunk(raw) {
  if (!raw) return '';
  let out = '';
  let i = 0;
  for (;;) {
    const s = raw.indexOf('<![CDATA[', i);
    if (s === -1) { out += unescapeXml(raw.slice(i)); break; }
    out += unescapeXml(raw.slice(i, s));
    const e = raw.indexOf(']]>', s + 9);
    if (e === -1) { out += raw.slice(s + 9); break; }
    out += raw.slice(s + 9, e);   // CDATA content stays literal
    i = e + 3;
  }
  return out;
}

const ATTR_RE = /([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(raw) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw))) {
    attrs[m[1]] = unescapeXml(m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

// A start/end/self-closing tag. `!` and `?` (comments, DOCTYPE, XML decl) never
// match, so they are skipped as plain text and then discarded.
const TAG_RE = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;

const TEXT_CONTAINERS = new Set(['seg', 'prop', 'note']);

/**
 * Parse a TMX string.
 * @returns {{header: Object, units: Array}}
 */
export function parseTmx(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw new Error('TMX 内容为空');

  const header = { props: {} };
  const units = [];
  const stack = [];
  let curTu = null;
  let curTuv = null;

  // innermost element that owns character data (so inline <ph>/<it> nest fine)
  const textOwner = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (TEXT_CONTAINERS.has(stack[i].name)) return stack[i];
    }
    return null;
  };

  const onText = (raw) => {
    if (!raw) return;
    const owner = textOwner();
    if (!owner) return;
    const t = decodeChunk(raw);
    if (!t) return;
    if (owner.name === 'seg') { if (curTuv) curTuv.text += t; }
    else owner.text = (owner.text || '') + t;
  };

  let last = 0;
  let m;
  TAG_RE.lastIndex = 0;

  while ((m = TAG_RE.exec(xml))) {
    onText(xml.slice(last, m.index));
    last = TAG_RE.lastIndex;

    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    let attrRaw = m[3] || '';
    const selfClose = /\/\s*$/.test(attrRaw);
    if (selfClose) attrRaw = attrRaw.replace(/\/\s*$/, '');
    const attrs = parseAttrs(attrRaw);

    if (closing) {
      const open = stack.pop();
      if (name === 'seg') {
        // nothing extra: text already accumulated on curTuv
      } else if (name === 'prop') {
        const type = attrs.type || (open && open.attrs ? open.attrs.type : '') || '';
        const val = (open && open.text) || '';
        if (curTu) curTu.props[type] = val;
        else header.props[type] = val;
      } else if (name === 'note') {
        if (curTu) curTu.note = ((open && open.text) || '').trim();
      } else if (name === 'tuv') {
        if (curTu && curTuv && curTuv.lang) {
          curTu.tuvs.push({ lang: curTuv.lang, text: curTuv.text.trim() });
        }
        curTuv = null;
      } else if (name === 'tu') {
        if (curTu) {
          units.push({
            tuid: curTu.tuid,
            props: curTu.props,
            note: curTu.note,
            tuvs: curTu.tuvs,
            src: curTu.tuvs[0] || { lang: '', text: '' },
            tgt: curTu.tuvs[1] || { lang: '', text: '' },
          });
          curTu = null;
        }
      }
      continue;
    }

    // ---- start tag ----
    const entry = { name, attrs, text: '' };
    if (!selfClose) stack.push(entry);

    if (name === 'tmx') header.version = attrs.version || '1.4';
    else if (name === 'header') Object.assign(header, attrs);
    else if (name === 'tu') curTu = { tuid: attrs.tuid || '', props: {}, note: '', tuvs: [] };
    else if (name === 'tuv') curTuv = { lang: attrs['xml:lang'] || attrs.lang || '', text: '' };

    // a self-closing <prop/> still has to be recorded
    if (selfClose) {
      if (name === 'prop') {
        if (curTu) curTu.props[attrs.type || ''] = '';
        else header.props[attrs.type || ''] = '';
      }
      if (name === 'tuv' && curTu && (attrs['xml:lang'] || attrs.lang)) {
        curTu.tuvs.push({ lang: attrs['xml:lang'] || attrs.lang, text: '' });
        curTuv = null;
      }
    }
  }
  onText(xml.slice(last));

  return { header, units };
}

/* ------------------------------------------------------------------ writing */

/**
 * Build a TMX 1.4 document.
 * @param {Object} o
 * @param {Array}  o.units  [{src,tgt,tuid?,props?}] or objects with `tuvs`
 */
export function buildTmx({ units, srcLang, tgtLang, headerProps = {}, tool = 'RPC-CAT' }) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<!DOCTYPE tmx SYSTEM "tmx14.dtd">');
  out.push('<tmx version="1.4">');
  out.push(
    `<header creationtool="${escapeAttr(tool)}" creationtoolversion="1.0" `
    + `datatype="PlainText" segtype="${escapeAttr(headerProps.segtype || 'sentence')}" `
    + `adminlang="${escapeAttr(headerProps.adminlang || 'en-US')}" `
    + `srclang="${escapeAttr(srcLang)}" o-tmf="${escapeAttr(tool)}" `
    + `creationdate="${now}">`
  );
  const merged = {
    Project: 'RPC CAT translation memory',
    License: 'CC BY-SA 3.0 Unported (https://creativecommons.org/licenses/by-sa/3.0/)',
    ...headerProps,
  };
  for (const [k, v] of Object.entries(merged)) {
    if (k === 'segtype' || k === 'adminlang' || v == null || v === '') continue;
    out.push(`  <prop type="${escapeAttr(k)}">${escapeXml(v)}</prop>`);
  }
  out.push('</header>');
  out.push('<body>');

  let n = 0;
  for (const u of units) {
    let src, tgt, tuid, props;
    if (u.tuvs) {
      tuid = u.tuid; props = u.props || {};
      src = u.tuvs[0] ? u.tuvs[0].text : '';
      tgt = u.tuvs[1] ? u.tuvs[1].text : '';
    } else {
      src = u.src; tgt = u.tgt; tuid = u.tuid; props = u.props || {};
    }
    if (src == null && tgt == null) continue;
    n += 1;
    out.push(`  <tu${tuid ? ` tuid="${escapeAttr(tuid)}"` : ''}>`);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === '') continue;
      out.push(`    <prop type="${escapeAttr(k)}">${escapeXml(v)}</prop>`);
    }
    out.push(`    <tuv xml:lang="${escapeAttr(srcLang)}"><seg>${escapeXml(src)}</seg></tuv>`);
    out.push(`    <tuv xml:lang="${escapeAttr(tgtLang)}"><seg>${escapeXml(tgt)}</seg></tuv>`);
    out.push('  </tu>');
  }
  out.push('</body>');
  out.push('</tmx>');
  return { xml: out.join('\n') + '\n', count: n };
}

export function sameLang(a, b) {
  const x = String(a || '').toLowerCase().replace(/_/g, '-');
  const y = String(b || '').toLowerCase().replace(/_/g, '-');
  if (!x || !y) return false;
  if (x === y) return true;
  return x.split('-')[0] === y.split('-')[0];
}

/** Normalise parsed units into {src,tgt} in the requested direction. */
export function toPairs(parsed, { srcLang, tgtLang } = {}) {
  const pairs = [];
  for (const u of parsed.units) {
    const tuvs = u.tuvs || [];
    if (tuvs.length < 2) continue;
    let a = tuvs[0];
    let b = tuvs[1];
    if (srcLang && tgtLang) {
      // put the requested source language first, whichever order the file used
      const aIsSrc = sameLang(a.lang, srcLang);
      const bIsSrc = sameLang(b.lang, srcLang);
      if (!aIsSrc && bIsSrc) { const t = a; a = b; b = t; }
    }
    if (!a.text || !b.text) continue;
    pairs.push({ src: a.text, tgt: b.text, srcLang: a.lang, tgtLang: b.lang, props: u.props || {}, tuid: u.tuid });
  }
  return pairs;
}
