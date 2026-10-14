/**
 * scripts/bundle.mjs — build rpc-cat.html, a single self-contained page.
 *
 * Why this exists: browsers refuse to load ES modules from file://, so
 * double-clicking index.html leaves every button dead.  This inlines the
 * modules (converted to a tiny registry-based loader), the stylesheet and the
 * demo memory into one classic-script HTML file that works from file://, from
 * a static server, and from GitHub Pages alike.
 *
 * The ES modules in js/ remain the source of truth; this is a build artifact.
 *
 *   node scripts/bundle.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JS_DIR = join(ROOT, 'js');
const OUT = join(ROOT, 'rpc-cat.html');
const ENTRY = 'js/app.js';

/* ------------------------------------------------------------- module list */

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

function moduleId(absPath) {
  return relative(ROOT, absPath).split('\\').join('/');
}

/** Resolve a relative specifier against the importing module id. */
function resolveId(fromId, spec) {
  if (!spec.startsWith('.')) return spec;               // bare specifier: none used
  const base = posix.dirname(fromId);
  return posix.normalize(posix.join(base, spec));
}

/* --------------------------------------------------------------- transform */

const IMPORT_NS = /^import\s+\*\s+as\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm;
const IMPORT_NAMED = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/gm;
const EXPORT_LIST = /^export\s*\{([^}]*)\}\s*;?\s*$/gm;
const EXPORT_DECL = /^export\s+(async\s+function|function|const|let|var|class)\s+([\w$]+)/gm;

function transform(id, src) {
  const exported = new Set();
  let code = src;

  // --- imports -> __require ---
  code = code.replace(IMPORT_NS, (_m, name, spec) =>
    `const ${name} = __require(${JSON.stringify(resolveId(id, spec))});`);
  code = code.replace(IMPORT_NAMED, (_m, names, spec) => {
    const list = names.split(',').map((s) => s.trim()).filter(Boolean).join(', ');
    return `const { ${list} } = __require(${JSON.stringify(resolveId(id, spec))});`;
  });

  // --- export { a, b } ---
  code = code.replace(EXPORT_LIST, (_m, names) => {
    for (const n of names.split(',').map((s) => s.trim()).filter(Boolean)) {
      // tolerate "x as y"
      const parts = n.split(/\s+as\s+/);
      exported.add((parts[1] || parts[0]).trim());
    }
    return '';
  });

  // --- export <declaration> ---
  code = code.replace(EXPORT_DECL, (_m, kind, name) => {
    exported.add(name);
    return `${kind} ${name}`;
  });

  if (/^\s*export\s/m.test(code)) {
    const bad = code.split('\n').filter((l) => /^\s*export\s/.test(l)).slice(0, 3);
    throw new Error(`unhandled export syntax in ${id}:\n  ${bad.join('\n  ')}`);
  }
  if (/^\s*import\s/m.test(code)) {
    const bad = code.split('\n').filter((l) => /^\s*import\s/.test(l)).slice(0, 3);
    throw new Error(`unhandled import syntax in ${id}:\n  ${bad.join('\n  ')}`);
  }

  const tail = [...exported].map((n) => `__exports.${n} = ${n};`).join('\n');
  return { code: `${code}\n${tail}\n`, exported };
}

/* ------------------------------------------------------------------ build */

const files = walk(JS_DIR).map(moduleId).sort();
const modules = new Map();
const exportMap = new Map();

for (const id of files) {
  const src = readFileSync(join(ROOT, id), 'utf8');
  const { code, exported } = transform(id, src);
  modules.set(id, code);
  exportMap.set(id, exported);
}

// verify every named import actually exists as an export
const problems = [];
for (const id of files) {
  const src = readFileSync(join(ROOT, id), 'utf8');
  let m;
  IMPORT_NAMED.lastIndex = 0;
  while ((m = IMPORT_NAMED.exec(src))) {
    const target = resolveId(id, m[2]);
    const avail = exportMap.get(target);
    if (!avail) { problems.push(`${id}: missing module ${target}`); continue; }
    for (const raw of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const name = raw.split(/\s+as\s+/)[0].trim();
      if (!avail.has(name)) problems.push(`${id}: '${name}' is not exported by ${target}`);
    }
  }
  IMPORT_NS.lastIndex = 0;
  while ((m = IMPORT_NS.exec(src))) {
    const target = resolveId(id, m[2]);
    if (!exportMap.has(target)) problems.push(`${id}: missing module ${target}`);
  }
}
if (problems.length) {
  console.error('bundle aborted — unresolved imports:');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

// dependency order: entry last, everything else first (registry defers execution
// anyway, so order is not strictly required — but it keeps the output readable)
const ordered = [...modules.keys()].filter((id) => id !== ENTRY).concat([ENTRY]);

const runtime = `(function () {
  'use strict';
  var __modules = {};
  var __cache = {};
  function __require(id) {
    if (__cache[id]) return __cache[id];
    var mod = { exports: {} };
    if (!__modules[id]) throw new Error('module not found: ' + id);
    __cache[id] = mod.exports;
    __modules[id](mod.exports, __require);
    return mod.exports;
  }
`;

let bundle = runtime;
for (const id of ordered) {
  bundle += `\n__modules[${JSON.stringify(id)}] = function (__exports, __require) {\n`;
  bundle += modules.get(id);
  bundle += `\n};\n`;
}
bundle += `\n__require(${JSON.stringify(ENTRY)});\n})();\n`;

// Guardrail: the bundle must parse as a classic script.
try {
  // eslint-disable-next-line no-new-func
  new Function(bundle);
} catch (err) {
  console.error('bundle aborted — generated script does not parse:\n  ' + err.message);
  process.exit(1);
}

/* ------------------------------------------------------------- assemble HTML */

let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const css = readFileSync(join(ROOT, 'css', 'style.css'), 'utf8');
const demo = readFileSync(join(ROOT, 'data', 'demo-tm.tmx'), 'utf8');

// strip the file:// warning: a classic script cannot hit that failure mode
html = html.replace(/<!--BOOT-WARN-START[\s\S]*?<!--BOOT-WARN-END-->\s*/, '');

html = html.replace(
  /<link rel="stylesheet" href="css\/style\.css">/,
  `<style>\n${css}\n</style>`
);

const demoScript = `<script>\n// Embedded so the demo memory works from file:// too.\n`
  + `window.__RPC_CAT_DEMO_TMX = ${JSON.stringify(demo)};\n</script>\n`;

html = html.replace(
  /<script type="module" src="js\/app\.js"><\/script>/,
  `${demoScript}<script>\n${bundle}</script>`
);

html = html.replace(
  '<title>RPC CAT · 管理局翻译工作台</title>',
  '<title>RPC CAT · 管理局翻译工作台（单文件版）</title>'
);

// Guardrail: no external references may survive. Check the actual tags — the
// bundle itself legitimately contains the string "js/app.js" as a module key.
if (html.includes('<script type="module"') || html.includes('href="css/style.css"')) {
  console.error('bundle aborted — external references survived inlining');
  process.exit(1);
}

writeFileSync(OUT, html, 'utf8');

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log(`modules bundled : ${modules.size}`);
console.log(`bundle size     : ${kb(Buffer.byteLength(bundle))}`);
console.log(`demo memory     : ${kb(Buffer.byteLength(demo))}`);
console.log(`wrote           : ${relative(ROOT, OUT)} (${kb(Buffer.byteLength(html))})`);
