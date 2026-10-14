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
const BUNDLE = join(here, '..', 'rpc-cat.html');

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { passed += 1; return; }
  failed += 1;
  failures.push(name + (extra ? `\n      ${extra}` : ''));
}
function eq(name, a, b) {
  ok(name, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}\n      actual   ${JSON.stringify(a)}`);
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

const settle = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
};

/* ------------------------------------------------------------------ setup */

const { document: doc, FakeElement } = installDom();
installFakeIndexedDB();

// index.html's nav buttons normally come from parsing HTML, which this shim
// does not do — create them so app.js can wire them up.
const NAV_VIEWS = ['workbench', 'align', 'memory', 'corpus', 'settings'];
const navButtons = NAV_VIEWS.map((v) => {
  const b = new FakeElement('button');
  b.className = 'nav-item';
  b.dataset.view = v;
  return b;
});
doc.querySelectorAll = (sel) => (sel === '.nav-item' ? navButtons : []);
doc.querySelector = () => null;

/** Depth-first search over the shim tree. */
function findAll(node, pred, out = []) {
  if (!node || node.nodeType !== 1) return out;
  if (pred(node)) out.push(node);
  for (const c of node.childNodes) findAll(c, pred, out);
  return out;
}
function textOf(node, depth = 0) {
  if (!node || depth > 40) return '';
  if (node.nodeType === 3) return node.textContent;
  return node.childNodes.map((c) => textOf(c, depth + 1)).join('');
}
const buttonsIn = (node) => findAll(node, (n) => n.tagName === 'BUTTON');

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

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
eq('two inline scripts (data + app)', scripts.length, 2);

for (const src of scripts) {
  // eslint-disable-next-line no-new-func
  new Function(src)();
}
await settle();

section('app boots');

eq('boot flag set', globalThis.__rpcCatBooted, true);

const view = doc.getElementById('view');
ok('view has content', view.childNodes.length > 0,
  `children=${view.childNodes.length}`);
ok('workbench start screen rendered', textOf(view).includes('工作台'),
  textOf(view).slice(0, 120));

section('nav buttons actually switch views');

const expectations = {
  workbench: '工作台',
  align: '对齐制作',
  memory: '记忆库',
  corpus: '语料库',
  settings: '设置',
};

for (const btn of navButtons) {
  btn.dispatch('click');
  await settle(4);
  const text = textOf(doc.getElementById('view'));
  ok(`clicking "${btn.dataset.view}" renders that view`,
    text.includes(expectations[btn.dataset.view]),
    `view text started with: ${text.slice(0, 80)}`);
}

// go back to the workbench for the flow tests
navButtons[0].dispatch('click');
await settle(4);

section('first-run modal offers the demo memory');

const modalRoot = doc.getElementById('modalRoot');
const modalButtons = buttonsIn(modalRoot);
ok('a modal was shown on first run', modalButtons.length >= 1,
  `buttons=${modalButtons.length}`);
const loadBtn = modalButtons.find((b) => textOf(b).includes('载入示例'));
ok('modal offers loading the demo memory', !!loadBtn,
  modalButtons.map((b) => textOf(b)).join(' | '));

section('importing the demo memory (真正的按钮点击)');

if (loadBtn) {
  loadBtn.dispatch('click');
  await settle(20);

  // choosing the demo opens the normal import dialog, which asks to confirm
  const importBtn = buttonsIn(doc.getElementById('modalRoot'))
    .find((b) => textOf(b).trim() === '导入');
  ok('import dialog asks for confirmation', !!importBtn,
    buttonsIn(doc.getElementById('modalRoot')).map((b) => textOf(b)).join(' | '));

  if (importBtn) {
    importBtn.dispatch('click');
    // 660 units through IndexedDB, then the fuzzy index build
    await settle(400);
  }

  const stat = textOf(doc.getElementById('storageStat'));
  ok('storage panel reports one memory', stat.includes('1 个记忆库'), stat);
  ok('storage panel reports 660 units', stat.includes('660 条单元'), stat);

  const picker = doc.getElementById('activeMemory');
  const options = findAll(picker, (n) => n.tagName === 'OPTION');
  eq('memory picker has one option', options.length, 1);
  ok('picker option is named', textOf(options[0] || new FakeElement('x')).includes('示例'),
    textOf(options[0] || new FakeElement('x')));
}

section('workbench translates with the imported memory');

{
  navButtons[0].dispatch('click');
  await settle(6);

  const viewNow = doc.getElementById('view');
  const areas = findAll(viewNow, (n) => n.tagName === 'TEXTAREA');
  const btns = buttonsIn(viewNow);
  const start = btns.find((b) => textOf(b).includes('开始翻译'));

  ok('workbench has a source box', areas.length >= 1);
  ok('workbench has a start button', !!start);

  // Take the probe sentences from the embedded memory itself, so this test does
  // not depend on which sentences the demo subset happens to contain.
  const { parseTmx, toPairs } = await import('../js/tmx.js');
  const embedded = parseTmx(globalThis.__RPC_CAT_DEMO_TMX);
  const probePairs = toPairs(embedded, { srcLang: 'en-US', tgtLang: 'zh-CN' })
    .filter((p) => p.src.length > 40 && p.src.length < 160)
    .slice(0, 2);
  eq('found probe sentences in the demo memory', probePairs.length, 2);
  const probeText = probePairs.map((p) => p.src).join('\n\n');

  if (areas.length && start) {
    areas[0].value = probeText;
    areas[0].dispatch('input');
    start.dispatch('click');
    await settle(30);

    const segs = findAll(doc.getElementById('view'),
      (n) => String(n.className).split(/\s+/).includes('seg'));
    ok('segments were created', segs.length >= 2, `found ${segs.length}`);

    const matches = findAll(doc.getElementById('view'),
      (n) => String(n.className).split(/\s+/).includes('match'));
    ok('TM matches were offered for stored segments', matches.length >= 2,
      `matches=${matches.length}`);

    const pills = findAll(doc.getElementById('view'),
      (n) => String(n.className).includes('pill'));
    const pcts = pills.map((p) => textOf(p)).filter((t) => /%$/.test(t));
    ok('match percentages are rendered', pcts.length >= 2, pcts.join(' '));
    ok('an exact 100% match is offered', pcts.some((t) => t === '100%'), pcts.join(' '));

    // clicking a suggestion must fill the translation box
    const firstMatch = matches[0];
    const targetArea = findAll(segs[0], (n) => n.tagName === 'TEXTAREA')[0];
    ok('first segment has a target box', !!targetArea);
    if (targetArea && firstMatch) {
      firstMatch.dispatch('click');
      ok('clicking a suggestion fills the target box',
        targetArea.value.length > 0, JSON.stringify(targetArea.value));
    }
  }
}

section('alignment view produces a TMX');

{
  navButtons[1].dispatch('click');
  await settle(6);

  const viewNow = doc.getElementById('view');
  const areas = findAll(viewNow, (n) => n.tagName === 'TEXTAREA');
  const btns = buttonsIn(viewNow);
  const demoBtn = btns.find((b) => textOf(b).includes('载入示例'));
  const alignBtn = btns.find((b) => textOf(b).includes('自动对齐'));

  ok('align view has two text areas', areas.length >= 2, `areas=${areas.length}`);
  ok('align view has an auto-align button', !!alignBtn);

  if (demoBtn && alignBtn) {
    demoBtn.dispatch('click');
    await settle(8);
    alignBtn.dispatch('click');
    await settle(30);

    const rows = findAll(doc.getElementById('view'), (n) => n.tagName === 'TR');
    ok('alignment produced table rows', rows.length > 2, `rows=${rows.length}`);

    const exportBtn = buttonsIn(doc.getElementById('view'))
      .find((b) => textOf(b).includes('导出 TMX'));
    ok('alignment view offers TMX export', !!exportBtn);

    const afterAlign = textOf(doc.getElementById('view'));
    ok('alignment reports paired rows', /对/.test(afterAlign));
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
