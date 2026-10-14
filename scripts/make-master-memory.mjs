/**
 * scripts/make-master-memory.mjs — build data/rpc-memory.tmx.gz from the full
 * TMX and refresh the master-memory block in data/config.json.
 *
 *   node scripts/make-master-memory.mjs [path/to/RPC_Authority_EN-ZH.tmx]
 *
 * gzip takes ~21 MB down to ~2.9 MB, which is small enough to ship in the repo
 * and serve from GitHub Pages.
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SRC = join(ROOT, '..', 'rpc-tm', 'out', 'RPC_Authority_EN-ZH.tmx');
const SRC = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_SRC;
const OUT_GZ = join(ROOT, 'data', 'rpc-memory.tmx.gz');
const CONFIG = join(ROOT, 'data', 'config.json');

const raw = readFileSync(SRC);
const units = (raw.toString('utf8').match(/<tu\b/g) || []).length;

// mtime pinned to 0 so rebuilding produces byte-identical output
const gz = gzipSync(raw, { level: 9, mtime: 0 });
writeFileSync(OUT_GZ, gz);

const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
cfg.master = {
  ...(cfg.master || {}),
  file: 'data/rpc-memory.tmx.gz',
  name: 'RPC Authority 中英总记忆库',
  units,
  srcLang: 'en-US',
  tgtLang: 'zh-CN',
  bytes: gz.length,
  rawBytes: raw.length,
  license: 'CC BY-SA 3.0 Unported',
  attribution: 'RPC Authority Wiki (rpc-wiki.net) 与 RPC 管理局中文分站 '
    + '(rpc-wiki-cn.wikidot.com) 的贡献者',
  builtFrom: relative(ROOT, SRC).split('\\').join('/'),
};
writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
console.log(`source        : ${SRC}`);
console.log(`translation units: ${units.toLocaleString('en-US')}`);
console.log(`raw           : ${mb(raw.length)}`);
console.log(`gzip          : ${mb(gz.length)}  (${(gz.length / raw.length * 100).toFixed(1)}%)`);
console.log(`wrote         : ${relative(ROOT, OUT_GZ)}`);
console.log(`config.master : updated in ${relative(ROOT, CONFIG)}`);
void statSync;
