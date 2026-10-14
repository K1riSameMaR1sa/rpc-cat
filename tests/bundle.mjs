/**
 * tests/bundle.mjs — boot the single-file build and click its buttons.
 *
 * This exists because "all the buttons do nothing" is the failure the bundle is
 * meant to prevent, and the only convincing check is to actually run the file
 * and press things. IndexedDB is faked, the DOM is shimmed, and the real
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

const NAV_VIEWS = ['workbench', 'ai', 'align', 'memory', 'corpus', 'settings'];
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
const byClass = (node, cls) => findAll(node, (n) => String(n.className).split(/\s+/).includes(cls));
const view = () => doc.getElementById('view');
const modalRoot = () => doc.getElementById('modalRoot');
const storageText = () => textOf(doc.getElementById('storageStat'));
const goTo = async (name) => { navButtons[NAV_VIEWS.indexOf(name)].dispatch('click'); await settle(8); };

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
ok('term base embedded', html.includes('__RPC_CAT_GLOSSARY_GZ'));

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
eq('two inline scripts (data + app)', scripts.length, 2);

// eslint-disable-next-line no-new-func
new Function(scripts[0])();
const gzPath = join(ROOT, 'data', 'rpc-memory.tmx.gz');
ok('master memory file present', existsSync(gzPath), gzPath);
if (existsSync(gzPath)) globalThis.__RPC_CAT_MASTER_GZ = readFileSync(gzPath).toString('base64');

// eslint-disable-next-line no-new-func
new Function(scripts[1])();
await waitFor(() => globalThis.__rpcCatBooted === true, 20000);
await settle(10);

section('app boots');

eq('boot flag set', globalThis.__rpcCatBooted, true);
ok('view has content', view().childNodes.length > 0, `children=${view().childNodes.length}`);
ok('workbench start screen rendered', textOf(view()).includes('工作台'),
  textOf(view()).slice(0, 120));

section('nav buttons actually switch views');

const expectations = {
  workbench: '工作台', ai: 'AI 翻译', align: '对齐制作',
  memory: '记忆库', corpus: '语料库', settings: '设置',
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

section('workbench: formats, matches and terms');

{
  await goTo('workbench');
  const areas = findAll(view(), (n) => n.tagName === 'TEXTAREA');
  const start = byText(view(), '开始翻译');
  ok('workbench has a source box', areas.length >= 1);
  ok('workbench has a start button', !!start);

  const { parseTmx, toPairs } = await import('../js/tmx.js');
  const pairs = toPairs(parseTmx(globalThis.__RPC_CAT_DEMO_TMX), { srcLang: 'en-US', tgtLang: 'zh-CN' })
    .filter((p) => p.src.length > 40 && p.src.length < 160);

  if (areas.length && start && pairs.length) {
    // include a code block, a table row, and a sentence containing glossary terms
    areas[0].value = `${pairs[0].src}\n\n[[code]]\nx();\n[[/code]]\n\n||~ A||~ B||\n||c1||c2||\n\n`
      + 'Containment Protocols require that the Authority Security Force escort the anomaly.';
    areas[0].dispatch('input');
    start.dispatch('click');
    await settle(30);

    ok('blocks were created', byClass(view(), 'seg').length >= 3,
      `found ${byClass(view(), 'seg').length}`);
    ok('code block is rendered read-only', byClass(view(), 'block-code').length === 1);
    ok('raw structure is visible', byClass(view(), 'block-raw').length >= 2);

    const matches = byClass(view(), 'match');
    ok('TM matches were offered', matches.length >= 1, `matches=${matches.length}`);

    // ---- the term base is wired into the workbench ----
    const chips = byClass(view(), 'term-chip');
    ok('term chips are shown for a sentence', chips.length >= 1, `chips=${chips.length}`);
    const chipText = chips.map((c) => textOf(c)).join(' | ');
    ok('chips name the English term', /Containment Protocols|Authority/.test(chipText), chipText);
    ok('chips carry the Chinese rendering', /[\u4e00-\u9fff]/.test(chipText), chipText);

    // clicking a chip inserts the translation into that sentence's box
    const sentences = byClass(view(), 'sentence');
    const withChip = sentences.find((s) => byClass(s, 'term-chip').length > 0);
    ok('a sentence owns the chips', !!withChip);
    if (withChip) {
      const ta = findAll(withChip, (n) => n.tagName === 'TEXTAREA')[0];
      const chip = byClass(withChip, 'term-chip')[0];
      ok('that sentence has a target box', !!ta);
      if (ta && chip) {
        const before = ta.value;
        chip.dispatch('click');
        ok('clicking a term inserts its translation',
          ta.value.length > before.length && /[\u4e00-\u9fff]/.test(ta.value),
          JSON.stringify(ta.value));
      }
    }

    // ---- formatting survives ----
    const { parseDocument, reconstruct } = await import('../js/document.js');
    const src = `${pairs[0].src}\n\n[[code]]\nx();\n[[/code]]\n\n||~ A||~ B||\n||c1||c2||\n`;
    eq('format round-trips', reconstruct(parseDocument(src, 'en-US'), { useTarget: false }), src);
  }
}

/* ---------------------------------------------------- master memory gate */

section('master memory gate (no password)');

{
  await goTo('settings');
  const openBtn = byText(view(), '载入总记忆库');
  ok('settings offers the master memory', !!openBtn, textOf(view()).slice(0, 200));

  if (openBtn) {
    openBtn.dispatch('click');
    await settle(20);

    const consent = inputsIn(modalRoot()).find((i) => i.type === 'checkbox');
    const confirm = buttonsIn(modalRoot()).find((b) => textOf(b).trim() === '载入');
    const password = inputsIn(modalRoot()).find((i) => i.type === 'password');

    ok('gate asks for licence consent', !!consent);
    ok('gate has a confirm button', !!confirm);
    ok('gate asks for NO password', !password);
    ok('gate explains the licence', textOf(modalRoot()).includes('CC BY-SA'));
    ok('gate offers write vs no-write',
      textOf(modalRoot()).includes('写入本机记忆库') && textOf(modalRoot()).includes('不写入'));

    const modalOpen = () => modalRoot().childNodes.length > 0;
    const radios = () => inputsIn(modalRoot()).filter((i) => i.type === 'radio');
    const before = storageText();

    if (consent && confirm) {
      // 1) without consent it must refuse
      confirm.dispatch('click');
      await settle(20);
      ok('refuses to load without consent', modalOpen());

      // 2) consent + the default (no-write) option, with nothing else entered
      consent.checked = true;
      const tempRadio = radios().find((r) => r.value === 'temp');
      ok('there is a no-write option', !!tempRadio);
      if (tempRadio) tempRadio.dispatch('change');
      await settle(4);

      confirm.dispatch('click');
      await settle(20);
      ok('gate closes on the no-write path', !modalOpen());

      const loaded = await waitFor(() => storageText().includes('临时'), 120000);
      ok('session memory became active', loaded, storageText());
      eq('nothing was written to the database', storageText().includes('1 个记忆库'), true);
      ok('unit count still 660 in the database', storageText().includes('660'), storageText());

      const options = findAll(doc.getElementById('activeMemory'),
        (n) => n.tagName === 'OPTION').map((o) => textOf(o));
      ok('picker lists the temporary memory', options.some((t) => t.includes('未写入')),
        options.join(' | '));

      // the temporary memory must be browsable, not reported as empty
      await goTo('memory');
      const body = textOf(view());
      ok('temporary memory is browsable (not "empty")',
        !body.includes('这个记忆库还是空的'), body.slice(0, 300));
      ok('temporary memory shows its units',
        body.includes('Containment') || body.includes('管理局') || body.includes('RPC'),
        body.slice(0, 300));
      ok('temporary memory is marked read-only',
        body.includes('只读') || body.includes('临时'), body.slice(0, 400));
    }
  }
}

section('master memory: write path');

{
  await goTo('settings');
  byText(view(), '载入总记忆库').dispatch('click');
  await settle(20);

  const consent = inputsIn(modalRoot()).find((i) => i.type === 'checkbox');
  const confirm = buttonsIn(modalRoot()).find((b) => textOf(b).trim() === '载入');
  const writeRadio = inputsIn(modalRoot()).find((i) => i.type === 'radio' && i.value === 'write');

  ok('gate reopened', !!consent && !!confirm && !!writeRadio);
  if (consent && confirm && writeRadio) {
    consent.checked = true;
    writeRadio.dispatch('change');
    await settle(4);
    confirm.dispatch('click');
    await settle(20);
    ok('gate closes on the write path', modalRoot().childNodes.length === 0);

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
    ok('alignment produced table rows', findAll(view(), (n) => n.tagName === 'TR').length > 2);
    ok('alignment view offers TMX export', !!byText(view(), '导出 TMX'));
    ok('alignment reports paired rows', /对/.test(textOf(view())));
  }
}

/* -------------------------------------------------------------- glossary UI */

section('glossary in settings');

{
  await goTo('settings');
  const body = textOf(view());
  ok('settings shows a term base panel', body.includes('术语库'));
  ok('settings reports a term count', /\d/.test(body));
  const input = inputsIn(view()).find((i) => String(i.placeholder || '').includes('术语'));
  ok('settings has a term search box', !!input);
  if (input) {
    input.value = '管理局';
    input.dispatch('input');
    await settle(20);
    ok('term search returns rows', findAll(view(), (n) => n.tagName === 'TD').length > 2,
      textOf(view()).slice(0, 200));
  }
  ok('settings offers a term export', !!byText(view(), '导出术语表'));
}

/* ------------------------------------------------------------- AI translate */

section('AI 翻译：DeepSeek 接入（打桩，不产生费用）');

{
  await goTo('ai');
  const body0 = textOf(view());
  ok('AI view renders', body0.includes('AI 翻译'));
  ok('AI view explains the clinical register', body0.includes('临床腔'));
  ok('AI view warns where the key is stored', /只保存在本机浏览器|不会上传/.test(body0),
    body0.slice(0, 200));

  const inputs = inputsIn(view());
  const keyInput = inputs.find((i) => i.type === 'password');
  const tempInput = inputs.find((i) => i.type === 'number');
  ok('there is an API key field', !!keyInput);
  ok('there is a temperature control', !!tempInput);
  ok('there is a model selector', findAll(view(), (n) => n.tagName === 'SELECT').length >= 1);

  // the temperature field must explain itself — a bare number box is useless
  // to anyone who has not met the concept before
  {
    const hint = textOf(view());
    ok('temperature carries an inline hint',
      hint.includes('每次结果相同') && hint.includes('偏离术语表'),
      hint.slice(0, 200));
    const helpBtn = buttonsIn(view()).find((b) => textOf(b).trim() === '?');
    ok('temperature has a help button', !!helpBtn);
    if (helpBtn) {
      helpBtn.dispatch('click');
      await settle(14);
      const help = textOf(modalRoot());
      ok('help explains the concept', help.includes('概率'), help.slice(0, 160));
      ok('help gives concrete values', help.includes('1.0') && help.includes('1.5'));
      ok('help corrects the "lower = more clinical" misreading',
        help.includes('临床') && /不控制|并不是/.test(help), help.slice(0, 400));
      ok('help warns that 0 makes 重译 a no-op', help.includes('重译'));
      ok('help offers a one-click recommended value',
        !!buttonsIn(modalRoot()).find((b) => textOf(b).includes('0.3')));
      const closeBtn = buttonsIn(modalRoot()).find((b) => textOf(b).trim() === '关闭');
      if (closeBtn) { closeBtn.dispatch('click'); await settle(8); }
    }
  }

  if (keyInput) {
    keyInput.value = 'sk-stub-key';
    keyInput.dispatch('input');
  }
  const saveBtn = byText(view(), '保存');
  ok('there is a save button', !!saveBtn);
  if (saveBtn) { saveBtn.dispatch('click'); await settle(20); }

  const area = findAll(view(), (n) => n.tagName === 'TEXTAREA')
    .find((t) => String(t.placeholder || '').includes('粘贴英文原文'));
  ok('there is a source box', !!area);

  // stub the API: any request answers with a canned SSE stream
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const enc = new TextEncoder();
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '管理局' } }] })}\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '已收容该项目。' } }] })}\n`,
      'data: [DONE]\n',
    ];
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => (i < lines.length
            ? { done: false, value: enc.encode(lines[i++]) }
            : { done: true, value: undefined }),
        }),
      },
      text: async () => lines.join(''),
    };
  };

  if (area) {
    area.value = 'Containment Protocols: the Authority has contained the anomaly.\n\n'
      + 'The anomaly requires weekly inspection.';
    area.dispatch('input');

    const runBtn = byText(view(), '全部翻译');
    ok('there is a translate button', !!runBtn);
    if (runBtn) {
      runBtn.dispatch('click');
      const done = await waitFor(() => textOf(view()).includes('管理局已收容该项目。'), 30000);
      ok('a stubbed translation appears in the view', done, textOf(view()).slice(0, 300));
    }

    ok('the request went to the DeepSeek endpoint',
      calls.length > 0 && calls[0].url.includes('api.deepseek.com/chat/completions'),
      JSON.stringify(calls.map((c) => c.url)));
    ok('the request carried the bearer token',
      calls.length > 0 && calls[0].init.headers.Authorization === 'Bearer sk-stub-key');

    const sent = calls.length ? JSON.parse(calls[0].init.body) : {};
    ok('the system prompt asks for 临床腔',
      JSON.stringify(sent).includes('临床腔'), JSON.stringify(sent).slice(0, 200));
    ok('the glossary was injected into the prompt',
      JSON.stringify(sent).includes('术语表'), JSON.stringify(sent).slice(0, 400));
    ok('the source sentence is in the prompt',
      JSON.stringify(sent).includes('Containment Protocols'));
    ok('streaming was requested', sent.stream === true);
    ok('one request per sentence', calls.length === 2, `calls=${calls.length}`);
  }

  // the key must persist across a view switch (stored in IndexedDB)
  await goTo('workbench');
  await goTo('ai');
  const keyAfter = inputsIn(view()).find((i) => i.type === 'password');
  ok('the API key was persisted locally', !!keyAfter && keyAfter.value === 'sk-stub-key',
    keyAfter ? JSON.stringify(keyAfter.value) : 'no field');

  // and the workbench should now offer a per-sentence AI button
  await goTo('workbench');
  const wbArea = findAll(view(), (n) => n.tagName === 'TEXTAREA')[0];
  const wbStart = byText(view(), '开始翻译');
  if (wbArea && wbStart) {
    wbArea.value = 'The Authority maintains containment.';
    wbArea.dispatch('input');
    wbStart.dispatch('click');
    await settle(20);
    const aiBtns = buttonsIn(view()).filter((b) => textOf(b).includes('AI 译'));
    ok('workbench offers a per-sentence AI button now that a key exists',
      aiBtns.length >= 1, `found ${aiBtns.length}`);
  }

  globalThis.fetch = realFetch;
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
