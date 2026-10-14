/**
 * master.js — the bundled master memory and the gate in front of it.
 *
 * Two things the demo memory does not need but the full 29k-unit memory does:
 *
 *   1. It ships gzipped (21 MB -> 2.9 MB) and is fetched only when asked for.
 *   2. Importing it requires an explicit licence acknowledgement and the
 *      administrator code.
 *
 * The gate is a workflow barrier, not security: the page is static, so the hash
 * below is checkable by anyone who reads the source, and the data itself is a
 * public file on the same server. What it guarantees is that the full memory is
 * never written into someone's local database by accident, and that the site
 * owner decides who gets the code.
 */

import { parseTmx, toPairs } from './tmx.js';
import { h, toast, modal, fmtNum, fmtBytes, pickFile } from './ui.js';

/* ------------------------------------------------------------------ config */

let _config = null;

/**
 * Read data/config.json, or the copy the single-file build inlined.
 * @returns {Promise<Object>}
 */
export async function loadConfig() {
  if (_config) return _config;
  if (globalThis.__RPC_CAT_CONFIG && typeof globalThis.__RPC_CAT_CONFIG === 'object') {
    _config = globalThis.__RPC_CAT_CONFIG;
    return _config;
  }
  try {
    const res = await fetch('data/config.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _config = await res.json();
  } catch {
    // no config file: fall back to sensible defaults rather than breaking
    _config = {
      gate: { requireConsent: true, consentPoints: [], notice: '' },
      adminCodeHash: '',
      adminCodeIsDefault: false,
      master: null,
    };
  }
  return _config;
}

/* ----------------------------------------------------------------- hashing */

export async function sha256Hex(text) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) {
    throw new Error('此浏览器不支持 Web Crypto，无法校验口令。请改用较新的浏览器，'
      + '或通过 https 打开本页。');
  }
  const data = new TextEncoder().encode(text);
  const digest = await subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* -------------------------------------------------------------- decompress */

const GZIP_MAGIC = [0x1f, 0x8b];

function looksGzip(buf) {
  const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  return b.length === 2 && b[0] === GZIP_MAGIC[0] && b[1] === GZIP_MAGIC[1];
}

/**
 * Turn a File or ArrayBuffer into text, transparently gunzipping when needed.
 * A .tmx file works too, so someone can hand a translator either one.
 */
export async function readMaybeGzip(input) {
  let buf;
  if (input instanceof ArrayBuffer) buf = input;
  else buf = await input.arrayBuffer();

  if (!looksGzip(buf)) return new TextDecoder('utf-8').decode(buf);

  if (typeof DecompressionStream !== 'function') {
    throw new Error('这个文件是 gzip 压缩的，但当前浏览器不支持解压（DecompressionStream）。'
      + '请改用较新的 Chrome / Edge / Firefox / Safari，或使用未压缩的 .tmx 文件。');
  }
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/* ------------------------------------------------------------ master fetch */

/** Fetch the master memory file, returning its text. */
export async function fetchMasterText(config) {
  const m = config.master;
  if (!m || !m.file) throw new Error('配置里没有总记忆库的信息');
  if (globalThis.__RPC_CAT_MASTER_GZ) {
    // single-file build with the memory inlined
    const bin = atob(globalThis.__RPC_CAT_MASTER_GZ);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return readMaybeGzip(bytes.buffer);
  }
  const res = await fetch(m.file, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`无法读取 ${m.file}（HTTP ${res.status}）`);
  return readMaybeGzip(await res.arrayBuffer());
}

export function masterAvailable(config) {
  if (globalThis.__RPC_CAT_MASTER_GZ) return true;
  return !!(config && config.master && config.master.file);
}

/* --------------------------------------------------------------- the gate */

function radioRow(name, value, label, hint, checked, onPick) {
  const input = h('input', {
    type: 'radio', name, value, checked, style: { width: 'auto' },
    onchange: () => onPick(value),
  });
  return h('label.row', { style: { alignItems: 'flex-start', marginBottom: '7px' } },
    input, h('span', h('div', label), hint ? h('div.tiny.mute', hint) : null));
}

/**
 * Ask for licence consent, and for the administrator code only when the memory
 * is actually going to be WRITTEN into the local database.
 *
 * Reading is free: holding the memory in the page for this session costs
 * nothing and commits nothing, so it needs no permission. Persisting a copy is
 * the privileged action, and that is what the code gates.
 *
 * @param {Object} ctx        view context ({ state, importPairs, loadSessionMemory })
 * @param {Object} [opts]     { file } to read a local file instead of fetching
 */
export async function openMasterGate(ctx, opts = {}) {
  const config = await loadConfig();
  const m = config.master;
  if (!m) { toast('这个版本没有内置总记忆库', 'err'); return; }

  // default to the friction-free path, so the dialog can be completed by
  // someone who has no code at all
  let choice = opts.write === true ? 'write' : 'temp';
  const consentBox = h('input', { type: 'checkbox', style: { width: 'auto' } });
  const codeInput = h('input', {
    type: 'password', autocomplete: 'off',
    placeholder: '管理员口令', style: { maxWidth: '280px' },
  });
  const fileNote = h('div.tiny.mute');

  const codeBlock = h('div',
    h('h3', '管理员口令'),
    h('div.row', codeInput,
      h('button.btn.sm', {
        onclick: async () => {
          const f = await pickFile({ accept: '.gz,.tmx,.xml' });
          if (!f) return;
          opts.file = f;
          fileNote.textContent = `已选择本地文件：${f.name}（${fmtBytes(f.size)}）`;
        },
      }, '或选择本地文件')),
    h('p.tiny.mute', { style: { marginTop: '8px' } },
      config.adminCodeIsDefault
        ? '⚠ 站点仍在用默认口令，管理员应尽快更换。'
        : (config.adminHint || '口令由站点管理员分发。')),
  );

  const sync = () => {
    codeBlock.hidden = choice !== 'write';
    modeHint.textContent = choice === 'write'
      ? '写入后长期保留，不必每次重新载入。需要管理员口令。'
      : '无需口令。只放在内存里供本次查证，关掉页面即消失。';
  };
  const modeHint = h('p.tiny.mute');

  const points = (config.gate && config.gate.consentPoints) || [];
  const body = h('div',
    h('div.stat-grid', { style: { marginBottom: '14px' } },
      h('div.stat', h('div.v', fmtNum(m.units)), h('div.k', '翻译单元')),
      h('div.stat', h('div.v', fmtBytes(m.bytes || 0)), h('div.k', '体积（压缩后）')),
      h('div.stat', h('div.v', `${m.srcLang} → ${m.tgtLang}`), h('div.k', '语言对')),
      h('div.stat', h('div.v', 'CC BY-SA 3.0'), h('div.k', '授权'))),

    h('h3', { style: { marginTop: 0 } }, '使用方式'),
    radioRow('masterMode', 'temp', '只本次使用，不写入', null,
      choice === 'temp', (v) => { choice = v; sync(); }),
    radioRow('masterMode', 'write', '写入本机记忆库', null,
      choice === 'write', (v) => { choice = v; sync(); }),
    modeHint,

    h('h3', '授权确认'),
    points.length
      ? h('ul', { style: { paddingLeft: '20px', color: 'var(--text-dim)', fontSize: '13px' } },
          ...points.map((p) => h('li', p)))
      : null,
    h('p.tiny.mute', { style: { marginTop: '8px' } }, m.attribution || ''),
    h('label.row', { style: { alignItems: 'flex-start', margin: '10px 0 4px' } },
      consentBox,
      h('span', (config.gate && config.gate.consentTitle) || '我已阅读并同意上述授权条款',
        h('div.tiny.mute', '未勾选则无法载入'))),

    codeBlock,
    config.gate && config.gate.notice ? h('p.tiny.mute', config.gate.notice) : null,
    fileNote,
  );
  sync();

  return new Promise((resolve) => {
    modal({
      title: '载入总记忆库',
      wide: true,
      body,
      actions: [
        { label: '取消', onClick: (close) => { close(); resolve(false); } },
        {
          label: '载入',
          primary: true,
          onClick: async (close) => {
            if (config.gate && config.gate.requireConsent && !consentBox.checked) {
              toast('请先勾选授权条款', 'err');
              return;
            }

            const write = choice === 'write';
            if (write) {
              const code = codeInput.value;
              if (!code.trim()) { toast('写入本机记忆库需要管理员口令', 'err'); return; }
              if (!config.adminCodeHash) {
                toast('配置里没有设置管理员口令，请先运行 npm run set-code', 'err');
                return;
              }
              let hash = '';
              try { hash = await sha256Hex(code); }
              catch (err) { toast(err.message, 'err'); return; }
              if (hash !== String(config.adminCodeHash).toLowerCase()) {
                toast('口令不正确', 'err');
                return;
              }
            }

            close();
            resolve(true);
            await applyMaster(ctx, config, { file: opts.file, write });
          },
        },
      ],
    });
  });
}

/** Read, parse and install the master memory (used after the gate passes). */
export async function applyMaster(ctx, config, { file = null, write = true } = {}) {
  const m = config.master;
  let text;
  try {
    toast(`正在读取总记忆库（${fmtBytes(m.bytes || 0)}）…`);
    text = file ? await readMaybeGzip(file) : await fetchMasterText(config);
  } catch (err) {
    toast(`读取失败：${err.message}`, 'err');
    return;
  }

  let pairs;
  try {
    pairs = toPairs(parseTmx(text), { srcLang: m.srcLang, tgtLang: m.tgtLang });
  } catch (err) {
    toast(`解析失败：${err.message}`, 'err');
    return;
  }
  if (!pairs.length) { toast('总记忆库里没有可用的翻译单元', 'err'); return; }

  const meta = {
    name: m.name,
    srcLang: m.srcLang,
    tgtLang: m.tgtLang,
    note: `总记忆库 · ${m.license}`,
  };

  if (write) {
    await ctx.importPairs(pairs, {
      defaultName: meta.name,
      srcLang: meta.srcLang,
      tgtLang: meta.tgtLang,
      // the gate already collected consent, the code and the write/no-write
      // choice; a second import dialog would just be friction
      autoConfirm: true,
    });
  } else {
    await ctx.loadSessionMemory(pairs, meta);
  }
}
