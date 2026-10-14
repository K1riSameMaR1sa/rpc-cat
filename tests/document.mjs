/**
 * tests/document.mjs — structure preservation.
 *
 * The contract that matters: parsing then reconstructing WITHOUT translations
 * must reproduce the input byte for byte.  Anything less and the tool silently
 * corrupts the author's file.
 */

import {
  parseDocument, reconstruct, documentStats, collectPairs, iterTextParts,
  makeTextPart, maskPlaceholders, KIND,
} from '../js/document.js';

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { passed += 1; return; }
  failed += 1;
  failures.push(name + (extra ? `\n      ${extra}` : ''));
}
function eq(name, a, b) {
  ok(name, JSON.stringify(a) === JSON.stringify(b),
    `expected ${JSON.stringify(b)}\n      actual   ${JSON.stringify(a)}`);
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

/* ------------------------------------------------------------- round trip */

section('byte-exact round trip');

const DOCS = {
  'plain paragraphs': 'First paragraph.\n\nSecond paragraph.\n',
  'no trailing newline': 'Only one line, no newline at end.',
  'blank lines preserved': 'A\n\n\n\nB\n',
  'indentation preserved': '    indented line\n\ttab indented\n',
  'wikidot headings and lists': '+ Title\n++ Subtitle\n* bullet one\n* bullet two\n# numbered\n> quoted\n',
  'table': '||~ Header A||~ Header B||\n||cell 1||cell 2||\n||a||b||c||\n',
  'wikidot code block': 'Before.\n\n[[code]]\nfunction f() {\n  return 1;\n}\n[[/code]]\n\nAfter.\n',
  'typed code block': '[[code type="python"]]\nprint("hi")\n[[/code]]\n',
  'markdown fence': 'Text.\n\n```js\nconst a = 1;\n```\n\nMore.\n',
  'markup-only lines': '[[collapsible show="+ open" hide="- close"]]\nInside text.\n[[/collapsible]]\n',
  'inline markup': 'A **bold** and //italic// and @@inline code@@ mixed in.\n',
  'urls with dots': 'See https://rpc-wiki.net/rpc-691 for details.\n',
  'crlf input': 'Line one.\r\nLine two.\r\n',
  'chinese prose': '第一句。第二句！\n\n第三段。\n',
  'mixed everything':
    '+ 附录\n\n'
    + '这是一段说明文字，包含 RPC-691 与 Site-002。\n\n'
    + '||~ 项目||~ 值||\n||分级||Alpha-橙||\n\n'
    + '[[code]]\nSMAP-1: OK\nSMAP-2: FAIL\n[[/code]]\n\n'
    + '最后一段。\n',
};

for (const [name, doc] of Object.entries(DOCS)) {
  const blocks = parseDocument(doc, /[\u4e00-\u9fff]/.test(doc) ? 'zh-CN' : 'en-US');
  const back = reconstruct(blocks, { useTarget: false });
  // CRLF is normalised to LF by design; everything else must be identical
  const expected = doc.replace(/\r\n?/g, '\n');
  eq(`round trip: ${name}`, back, expected);
}

/* --------------------------------------------------------- classification */

section('block classification');

{
  const doc = 'Prose line.\n\n[[code]]\ncode();\n[[/code]]\n\n----\n[[/collapsible]]\n';
  const blocks = parseDocument(doc, 'en-US');
  const kinds = blocks.map((b) => b.kind);
  eq('kinds', kinds, [
    KIND.PROSE, KIND.BLANK, KIND.CODE, KIND.BLANK, KIND.MARKUP, KIND.MARKUP,
  ]);
  ok('code block is sealed', blocks[2].sealed === true);
  ok('code block keeps its body',
    blocks[2].parts[0].text.includes('code();'), blocks[2].parts[0].text);
}

{
  const blocks = parseDocument('||~ 项目||~ 值||\n||分级||Alpha-橙||\n', 'zh-CN');
  eq('table rows detected', blocks.filter((b) => b.kind === KIND.TABLE).length, 2);
  const texts = [];
  for (const { part } of iterTextParts(blocks)) for (const s of part.sentences) texts.push(s.src);
  ok('table cells became translatable text', texts.includes('项目') && texts.includes('Alpha-橙'),
    JSON.stringify(texts));
  ok('table header marker ~ is not translated',
    !texts.some((t) => t.includes('~')), JSON.stringify(texts));
}

{
  const blocks = parseDocument('* bullet text here\n', 'en-US');
  const parts = blocks[0].parts;
  eq('list marker is literal', parts[0], { type: 'literal', text: '* ' });
  eq('list content is the text part', parts[1].sentences[0].src, 'bullet text here');
  // and the marker must survive translation
  parts[1].sentences[0].tgt = '项目符号文本';
  eq('translation keeps the marker', reconstruct(blocks), '* 项目符号文本\n');
}

/* ------------------------------------------------------- inline integrity */

section('inline markup is never split');

{
  const masked = maskPlaceholders('See [[[the link|the link]]] now.');
  ok('link masked', !masked.includes('[['), JSON.stringify(masked));
  ok('masking preserves length',
    masked.length === 'See [[[the link|the link]]] now.'.length);

  const p = makeTextPart('A **bold. sentence** follows. Done.', 'en-US');
  ok('a period inside ** ** does not split',
    !p.sentences.some((s) => s.src.trim() === 'A **bold.'),
    JSON.stringify(p.sentences.map((s) => s.src)));
  ok('so the run splits into fewer pieces', p.sentences.length <= 2,
    JSON.stringify(p.sentences.map((s) => s.src)));

  const p2 = makeTextPart('Visit https://example.com/a.b.html today. Then stop.', 'en-US');
  eq('a dot inside a URL does not split', p2.sentences.length, 2);
  eq('URL stays whole', p2.sentences[0].src, 'Visit https://example.com/a.b.html today.');
}

section('sentence separators are preserved');

{
  const p = makeTextPart('One.  Two.\nThree.', 'en-US');
  eq('three sentences', p.sentences.length, 3);
  eq('src rebuilds exactly', p.sentences.map((s, i) => s.src + p.seps[i]).join(''), 'One.  Two.\nThree.');
  eq('double space kept in sep', p.seps[0], '  ');
  eq('newline kept in sep', p.seps[1], '\n');
}

section('translation substitution');

{
  const doc = 'Hello world. Goodbye moon.\n\n[[code]]\nkeep();\n[[/code]]\n';
  const blocks = parseDocument(doc, 'en-US');
  const sent = [];
  for (const { part } of iterTextParts(blocks)) sent.push(...part.sentences);
  eq('two sentences found', sent.length, 2);
  sent[0].tgt = '你好，世界。';
  sent[1].tgt = '再见，月亮。';
  eq('translated output',
    reconstruct(blocks),
    '你好，世界。 再见，月亮。\n\n[[code]]\nkeep();\n[[/code]]\n');
}

section('partial translation falls back to source');

{
  const blocks = parseDocument('Keep this. Translate this.\n', 'en-US');
  const sent = [];
  for (const { part } of iterTextParts(blocks)) sent.push(...part.sentences);
  sent[1].tgt = '翻译这句。';
  eq('untranslated sentence keeps its source',
    reconstruct(blocks), 'Keep this. 翻译这句。\n');
}

section('stats and pair collection');

{
  // realistic words, because "A." is treated as an initial by the splitter
  const blocks = parseDocument('Alpha. Beta.\n\n[[code]]\nx();\n[[/code]]\n\nGamma.\n', 'en-US');
  const st = documentStats(blocks);
  eq('sentence count', st.sentences, 3);
  eq('code blocks counted', st.kinds.code, 1);
  eq('nothing translated yet', st.translated, 0);
  eq('no pairs yet', collectPairs(blocks).length, 0);

  const sent = [];
  for (const { part } of iterTextParts(blocks)) sent.push(...part.sentences);
  sent[0].tgt = '甲。';
  eq('one pair after translating one sentence', collectPairs(blocks).length, 1);
  eq('stats see the translation', documentStats(blocks).translated, 1);
}

section('empty and degenerate input');

for (const [name, input] of [
  ['empty string', ''],
  ['only newlines', '\n\n\n'],
  ['only a code block', '[[code]]\nx\n[[/code]]\n'],
  ['unclosed code block', '[[code]]\nnever closed\n'],
  ['single space', ' '],
]) {
  const blocks = parseDocument(input, 'en-US');
  const back = reconstruct(blocks, { useTarget: false });
  eq(`round trip: ${name}`, back, input.replace(/\r\n?/g, '\n'));
}

/* -------------------------------------------------------------------- end */

console.log(`\n${'─'.repeat(58)}`);
if (failed === 0) {
  console.log(`\x1b[32m✓ all ${passed} document checks passed\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m✗ ${failed} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
