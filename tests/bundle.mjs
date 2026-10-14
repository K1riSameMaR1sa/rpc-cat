/**
 * tests/bundle.mjs — boot the single-file build and click its buttons.
 *
 * This exists because "all the buttons do nothing" is the failure the bundle is
 * meant to prevent, and the only convincing check is to actually run the file
 * and press things.  IndexedDB is faked, the DOM is shimmed, and the real
 * rpc-cat.html script is evaluated.
 *
 * Run: node tests/bundle.mjs
 */

import { installDom } from './dom-shim.mjs';
import { installFakeIndexedDB } from './idb-shim.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const BUNDLE = join(ROOT, 'rpc-cat.html');

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

const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 1));
};

/** Poll until the predicate holds — much steadier than fixed sleeps. */
async function waitFor(fn, ms = 90000) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = fn(); } catch { v = false; }
    if (v) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/* ------------------------------------------------------------------ setup */

const { document: doc, FakeElement } = installDom();
installFakeIndexedDB();

const NAV_VIEWS = ['workbench', 'align', 'memory', 'corpus', 'settings'];
const navButtons = NAV_VIEWS.map((v) => {
  const b = new FakeElement('button');
  b.className = 'nav-item';
  b.dataset.view = v;
  return b;
});
doc.querySelectorAll = (sel) => (sel === '.nav-item' ? navButtons : []);
doc.querySelector = () => null;

function findAll(node, pred, out = []) {
  if (!node || node.nodeType !== 1) return out;
  if (pred(node)) out.push(node);
  for (const c of node.childNodes) findAll(c, pred, out);
  return out;
}
function textOf(node, depth = 0) {
  if (!node || depth > 60) return '';
  if (node.nodeType === 3) return node.textContent;
  return node.childNodes.map((c) => textOf(c, depth + 1)).join('');
}
const buttonsIn = (node) => findAll(node, (n) => n.tagName === 'BUTTON');
const inputsIn = (node) => findAll(node, (n) => n.tagName === 'INPUT');
const byText = (node, needle) => buttonsIn(node).find((b) => textOf(b).includes(needle));
const view = () => doc.getElementById('view');
const modalRoot = () => doc.getElementById('modalRoot');
const storageText = () => textOf(doc.getElementById('storageStat'));
const goTo = async (name) => {
  const i = NAV_VIEWS.indexOf(name);
  navButtons[i].dispatch('click');
  await settle(8);
};

/* ------------------------------------------------------------------- load */

section('single-file build');

if (!existsSync(BUNDLE)) {
  ok('rpc-cat.html exists', false, 'run: node scripts/bundle.mjs');
  report();
}

const html = readFileSync(BUNDLE, 'utf8');
ok('no ES module script tag', !html.includes('<script type="module"'));
ok('no external stylesheet link', !html.includes('href="css/style.css"'));
ok('demo memory embedded', html.includes('__RPC_CAT_DEMO_TMX'));
ok('gate config embedded', html.includes('__RPC_CAT_CONFIG'));

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
eq('two inline scripts (data + app)', scripts.length, 2);

// evaluate the data script, then hand master.js the real gzipped memory so the
// gate can be exercised without a network
// eslint-disable-next-line no-new-func
new Function(scripts[0])();
const gzPath = join(ROOT, 'data', 'rpc-memory.tmx.gz');
ok('master memory file present', existsSync(gzPath), gzPath);
if (existsSync(gzPath)) {
  globalThis.__RPC_CAT_MASTER_GZ = readFileSync(gzPath).toString('base64');
}
// eslint-disable-next-line no-new-func
new Function(scripts[1])();
await settle(10);

section('app boots');

eq('boot flag set', globalThis.__rpcCatBooted, true);
ok('view has content', view().childNodes.length > 0, `children=${view().childNodes.length}`);
ok('workbench start screen rendered', textOf(view()).includes('工作台'),
  textOf(view()).slice(0, 120));

section('nav buttons actually switch views');

const expectations = {
  workbench: '工作台', align: '对齐制作', memory: '记忆库', corpus: '语料库', settings: '设置',
};
for (const btn of navButtons) {
  btn.dispatch('click');
  await settle(6);
  ok(`clicking "${btn.dataset.view}" renders that view`,
    textOf(view()).includes(expectations[btn.dataset.view]),
    `view text: ${textOf(view()).slice(0, 70)}`);
}
await goTo('workbench');

/* ------------------------------------------------------- demo memory import */

section('first run: importing the demo memory');

{
  ok('a modal was shown on first run', buttonsIn(modalRoot()).length >= 1);
  const loadDemo = byText(modalRoot(), '载入示例');
  ok('modal offers the demo memory', !!loadDemo);
  if (loadDemo) {
    loadDemo.dispatch('click');
    await settle(25);
    const importBtn = buttonsIn(modalRoot()).find((b) => textOf(b).trim() === '导入');
    ok('import dialog asks for confirmation', !!importBtn,
      buttonsIn(modalRoot()).map((b) => textOf(b)).join(' | '));
    if (importBtn) importBtn.dispatch('click');
    await waitFor(() => storageText().includes('660'), 60000);
    ok('660 demo units were stored', storageText().includes('660'), storageText());
    ok('one memory now exists', storageText().includes('1 个记忆库'), storageText());
  }
}

/* ------------------------------------------------------------ workbench */

section('workbench translates with the imported memory');

{
  await goTo('workbench');
  const areas = findAll(view(), (n) => n.tagName === 'TEXTAREA');
  const start = byText(view(), '开始翻译');
  ok('workbench has a source box', areas.length >= 1);
  ok('workbench has a start button', !!start);

  const { parseTmx, toPairs } = await import('../js/tmx.js');
  const pairs = toPairs(parseTmx(globalThis.__RPC_CAT_DEMO_TMX), { srcLang: 'en-US', tgtLang: 'zh-CN' })
    .filter((p) => p.src.length > 40 && p.src.length < 160);
  eq('found probe sentences', pairs.length >= 2, true);

  if (areas.length && start && pairs.length) {
    // include a code block and a table row, to prove formatting is preserved
    areas[0].value = `${pairs[0].src}\n\n[[code]]\nx();\n[[/code]]\n\n||~ A||~ B||\n||c1||c2||\n`;
    areas[0].dispatch('input');
    start.dispatch('click');
    await settle(30);

    const blocks = findAll(view(), (n) => String(n.className).split(/\s+/).includes('seg'));
    ok('blocks were created', blocks.length >= 3, `found ${blocks.length}`);
    ok('code block is rendered read-only',
      findAll(view(), (n) => String(n.className).includes('block-code')).length === 1);
    ok('markup/table structure is visible',
      findAll(view(), (n) => String(n.className).includes('block-raw')).length >= 2);

    const matches = findAll(view(), (n) => String(n.className).split(/\s+/).includes('match'));
    ok('TM matches were offered', matches.length >= 1, `matches=${matches.length}`);

    const pills = findAll(view(), (n) => String(n.className).includes('pill'));
    const pcts = pills.map((p) => textOf(p)).filter((t) => /%$/.test(t));
    ok('match percentages are rendered', pcts.length >= 1, pcts.join(' '));

    // clicking a suggestion fills the translation box
    const sentences = findAll(view(), (n) => String(n.className).split(/\s+/).includes('sentence'));
    const targetArea = sentences.length ? findAll(sentences[0], (n) => n.tagName === 'TEXTAREA')[0] : null;
    ok('sentence has a target box', !!targetArea);
    if (targetArea && matches.length) {
      matches[0].dispatch('click');
      ok('clicking a suggestion fills the target box', targetArea.value.length > 0);
    }

    // export must keep the code block and the table delimiters
    const { parseDocument, reconstruct } = await import('../js/document.js');
    const src = `${pairs[0].src}\n\n[[code]]\nx();\n[[/code]]\n\n||~ A||~ B||\n||c1||c2||\n`;
    const parsed = parseDocument(src, 'en-US');
    eq('format round-trips through the workbench path', reconstruct(parsed, { useTarget: false }), src);
  }
}

/* ---------------------------------------------------- master memory gate */

section('master memory gate');

{
  await goTo('settings');
  ok('storage panel still shows the demo memory', storageText().includes('660'), storageText());

  const openBtn = byText(view(), '载入总记忆库');
  ok('settings offers the master memory', !!openBtn, textOf(view()).slice(0, 200));

  if (openBtn) {
    openBtn.dispatch('click');
    await settle(20);

    const consent = inputsIn(modalRoot()).find((i) => i.type === 'checkbox');
    const codeInput = inputsIn(modalRoot()).find((i) => i.type === 'password');
    const confirm = buttonsIn(modalRoot()).find((b) => textOf(b).trim() === '载入');
    ok('gate asks for licence consent', !!consent);
    ok('gate asks for the admin code', !!codeInput);
    ok('gate has a confirm button', !!confirm);
    ok('gate explains the licence', textOf(modalRoot()).includes('CC BY-SA'));
    ok('gate offers write vs no-write',
      textOf(modalRoot()).includes('写入本机记忆库') && textOf(modalRoot()).includes('不写入'));
    ok('gate says the no-write path needs no code',
      textOf(modalRoot()).includes('无需口令'));

    const modalOpen = () => modalRoot().childNodes.length > 0;
    const radios = () => inputsIn(modalRoot()).filter((i) => i.type === 'radio');

    if (consent && codeInput && confirm) {
      // 1) without consent it must refuse, even on the free path
      confirm.dispatch('click');
      await settle(20);
      ok('refuses to load without consent', modalOpen());

      // 2) READING IS FREE: consent + the no-write option, with NO code at all
      consent.checked = true;
      const tempRadio = radios().find((r) => r.value === 'temp');
      ok('there is a no-write option', !!tempRadio);
      if (tempRadio) tempRadio.dispatch('change');

      const toWrite = radios().find((r) => r.value === 'write');
      ok('there is a write option', !!toWrite);

      // switching to write must demand the code; switching back must not
      if (toWrite) toWrite.dispatch('change');
      await settle(4);
      confirm.dispatch('click');
      await settle(20);
      ok('write mode refuses an empty code', modalOpen());

      codeInput.value = 'not-the-code';
      confirm.dispatch('click');
      await settle(30);
      ok('write mode refuses a wrong code', modalOpen());

      // now the free path: no code entered at all
      codeInput.value = '';
      if (tempRadio) tempRadio.dispatch('change');
      await settle(4);
      confirm.dispatch('click');
      await settle(20);
      ok('gate closes on the no-write path without any code', !modalOpen());

      const loaded = await waitFor(() => storageText().includes('临时'), 120000);
      ok('session memory became active without a code', loaded, storageText());
      ok('session memory is labelled temporary', storageText().includes('临时'), storageText());

      // the decisive check: nothing was written to IndexedDB
      eq('no memory was written to the database', storageText().includes('1 个记忆库'), true);
      ok('unit count still 660 in the database', storageText().includes('660'), storageText());

      const picker = doc.getElementById('activeMemory');
      const options = findAll(picker, (n) => n.tagName === 'OPTION').map((o) => textOf(o));
      ok('picker lists the temporary memory', options.some((t) => t.includes('未写入')),
        options.join(' | '));
    }
  }
}

/* ------------------------------------------------- writing DOES need the code */

section('master memory: write path requires the code');

{
  await goTo('settings');
  const before = storageText();

  byText(view(), '载入总记忆库').dispatch('click');
  await settle(20);

  const consent = inputsIn(modalRoot()).find((i) => i.type === 'checkbox');
  const codeInput = inputsIn(modalRoot()).find((i) => i.type === 'password');
  const confirm = byText(modalRoot(), '载入');
  const writeRadio = inputsIn(modalRoot()).find((i) => i.type === 'radio' && i.value === 'write');

  ok('gate reopened', !!consent && !!confirm);
  if (consent && codeInput && confirm && writeRadio) {
    consent.checked = true;
    writeRadio.dispatch('change');
    await settle(4);

    // wrong code first
    codeInput.value = 'definitely-wrong';
    confirm.dispatch('click');
    await settle(30);
    ok('wrong code is rejected on the write path', modalRoot().childNodes.length > 0);
    eq('nothing was written after a bad code', storageText(), before);

    // then the real code
    codeInput.value = 'rpc-admin';
    confirm.dispatch('click');
    await settle(20);
    ok('gate closes with the right code', modalRoot().childNodes.length === 0);

    const wrote = await waitFor(() => storageText().includes('2 个记忆库'), 180000);
    ok('the memory was written to the database', wrote, storageText());
    ok('written memory holds all 29,271 units',
      /29,271/.test(storageText()) || /29271/.test(storageText()), storageText());
  }
}

/* ------------------------------------------------------------ alignment */

section('alignment view produces a TMX');

{
  await goTo('align');
  const areas = findAll(view(), (n) => n.tagName === 'TEXTAREA');
  const demoBtn = byText(view(), '载入示例');
  const alignBtn = byText(view(), '自动对齐');
  ok('align view has two text areas', areas.length >= 2, `areas=${areas.length}`);
  ok('align view has an auto-align button', !!alignBtn);

  if (demoBtn && alignBtn) {
    demoBtn.dispatch('click');
    await settle(10);
    alignBtn.dispatch('click');
    await settle(40);
    const rows = findAll(view(), (n) => n.tagName === 'TR');
    ok('alignment produced table rows', rows.length > 2, `rows=${rows.length}`);
    ok('alignment view offers TMX export', !!byText(view(), '导出 TMX'));
    ok('alignment reports paired rows', /对/.test(textOf(view())));
  }
}

report();

function report() {
  console.log(`\n${'─'.repeat(58)}`);
  if (failed === 0) {
    console.log(`\x1b[32m✓ all ${passed} bundle checks passed\x1b[0m`);
    process.exit(0);
  } else {
    console.log(`\x1b[31m✗ ${failed} failed\x1b[0m, ${passed} passed\n`);
    for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
    process.exit(1);
  }
}
