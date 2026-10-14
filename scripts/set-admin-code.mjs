/**
 * scripts/set-admin-code.mjs — set the administrator code required to import
 * the master memory.
 *
 *   node scripts/set-admin-code.mjs <new-code>
 *   npm run set-code -- <new-code>
 *
 * Only the SHA-256 is stored, and only the hash is shipped to the browser. This
 * is a workflow gate, not real security: the page is static, so anyone who reads
 * the source can see that a hash comparison is all that happens. What it does
 * buy you is that the master memory cannot be pulled into someone's local
 * database by accident, and that you decide who gets the code.
 *
 * The code itself is never written to disk.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'data', 'config.json');

const code = process.argv.slice(2).join(' ').trim();

if (!code) {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  console.log('用法：node scripts/set-admin-code.mjs <新口令>');
  console.log('');
  console.log(`当前状态：${cfg.adminCodeIsDefault ? '⚠ 仍是默认口令' : '已自定义'}`);
  console.log(`提示信息：${cfg.adminHint || '(无)'}`);
  console.log(`口令哈希：${cfg.adminCodeHash}`);
  process.exit(1);
}

if (code.length < 6) {
  console.error('口令太短：至少 6 个字符。');
  process.exit(1);
}

const hash = createHash('sha256').update(code, 'utf8').digest('hex');
const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
cfg.adminCodeHash = hash;
cfg.adminCodeIsDefault = false;
cfg.adminHint = '口令由站点管理员分发。';
writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

console.log(`已更新 ${relative(ROOT, CONFIG)}`);
console.log(`口令哈希：${hash}`);
console.log('');
console.log('把新口令分发给你信任的译者；口令本身没有写进任何文件。');
console.log('记得重新构建单文件版：npm run build');
