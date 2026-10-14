/**
 * tests/run.mjs — dependency-free test runner for the RPC CAT logic modules.
 * Run: node tests/run.mjs   (or: npm test)
 */

import { parseTmx, buildTmx, toPairs, escapeXml, unescapeXml } from '../js/tmx.js';
import {
  splitSentencesEn, splitSentencesZh, getAnchors, detectLabel, splitBlocks,
  cjkCount, cnUnits, enWords, cleanText, placeholderSignature,
} from '../js/segment.js';
import { buildTUs, alignBlocks, makeBlocks, lengthSim } from '../js/align.js';
import { MemoryIndex, normalize, tokenize, editSimilarity } from '../js/match.js';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { passed += 1; return; }
  failed += 1;
  failures.push(name + (extra ? `\n      ${extra}` : ''));
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `expected ${e}\n      actual   ${a}`);
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/* ------------------------------------------------------------------ tmx.js */

section('tmx.js');

{
  const tmx = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tmx SYSTEM "tmx14.dtd">
<tmx version="1.4">
<header creationtool="x" segtype="sentence" srclang="en-US" o-tmf="x"
        adminlang="en-US" datatype="PlainText" creationdate="20260101T000000Z">
  <prop type="Project">unit test</prop>
</header>
<body>
  <tu tuid="a#0.0">
    <prop type="x-doc">a</prop>
    <tuv xml:lang="en-US"><seg>RPC-691 is an MP4 file.</seg></tuv>
    <tuv xml:lang="zh-CN"><seg>RPC-691 是一个 MP4 文件。</seg></tuv>
  </tu>
  <tu tuid="a#0.1">
    <tuv xml:lang="en-US"><seg>A &amp; B &lt;tag&gt; &#65;&#x42;</seg></tuv>
    <tuv xml:lang="zh-CN"><seg><![CDATA[字面 & <内容> 保留]]></seg></tuv>
  </tu>
  <tu tuid="a#0.2">
    <tuv xml:lang="en-US"><seg>plain</seg></tuv>
    <tuv xml:lang="zh-CN"><seg>普通</seg></tuv>
  </tu>
</body>
</tmx>`;
  const p = parseTmx(tmx);
  eq('tmx: header prop parsed', p.header.props.Project, 'unit test');
  eq('tmx: header attr parsed', p.header.srclang, 'en-US');
  eq('tmx: unit count', p.units.length, 3);
  eq('tmx: tuid', p.units[0].tuid, 'a#0.0');
  eq('tmx: tu prop', p.units[0].props['x-doc'], 'a');
  eq('tmx: src lang', p.units[0].src.lang, 'en-US');
  eq('tmx: src text', p.units[0].src.text, 'RPC-691 is an MP4 file.');
  eq('tmx: tgt text', p.units[0].tgt.text, 'RPC-691 是一个 MP4 文件。');
  eq('tmx: entities decoded', p.units[1].src.text, 'A & B <tag> AB');
  eq('tmx: CDATA kept literal', p.units[1].tgt.text, '字面 & <内容> 保留');

  const { xml, count } = buildTmx({
    units: [{ src: 'A & B <x>', tgt: '甲 & 乙 <y>', tuid: 't1', props: { 'x-doc': 'd' } }],
    srcLang: 'en-US', tgtLang: 'zh-CN',
  });
  eq('tmx: build count', count, 1);
  const rt = parseTmx(xml);
  eq('tmx: round-trip src', rt.units[0].src.text, 'A & B <x>');
  eq('tmx: round-trip tgt', rt.units[0].tgt.text, '甲 & 乙 <y>');
  eq('tmx: round-trip prop', rt.units[0].props['x-doc'], 'd');
  ok('tmx: header declares UTF-8', xml.includes('encoding="UTF-8"'));
  ok('tmx: DOCTYPE emitted', xml.includes('tmx14.dtd'));

  eq('tmx: escapeXml', escapeXml('a<b>&"c"'), 'a&lt;b&gt;&amp;"c"');
  eq('tmx: unescapeXml', unescapeXml('a&lt;b&gt;&amp;&#65;'), 'a<b>&A');

  const pairs = toPairs(p, { srcLang: 'en-US', tgtLang: 'zh-CN' });
  eq('tmx: toPairs', pairs.length, 3);
  // reversed declaration must still normalise by language
  const rev = parseTmx(`<tmx version="1.4"><header srclang="zh-CN"/><body>
    <tu><tuv xml:lang="zh-CN"><seg>甲</seg></tuv>
        <tuv xml:lang="en-US"><seg>A</seg></tuv></tu></body></tmx>`);
  const rp = toPairs(rev, { srcLang: 'en-US', tgtLang: 'zh-CN' });
  eq('tmx: toPairs normalises order', [rp[0].src, rp[0].tgt], ['A', '甲']);
}

/* -------------------------------------------------------------- segment.js */

section('segment.js — sentence splitting');

{
  const en = 'Today is my first day. Starting to feel something… I think it might be working! Will update.';
  const s = splitSentencesEn(en);
  eq('seg: ellipsis is an EN sentence break', s.length, 4);
  eq('seg: ellipsis segment text', s[1], 'Starting to feel something…');

  eq('seg: abbreviation not split',
    splitSentencesEn('Dr. Libson went to Site-007. He left.').length, 2);
  eq('seg: decimal not split',
    splitSentencesEn('The dose was 3.14 mg total.').length, 1);
  eq('seg: initials not split',
    splitSentencesEn('J. Smith arrived. It rained.').length, 2);

  const zh = '今天是我催眠之旅的第一天。我打开了一个视频。我听了一整天。开始感觉到什么了……我觉得可能有效！';
  const zs = splitSentencesZh(zh);
  eq('seg: ZH sentence count', zs.length, 5);
  eq('seg: ZH keeps terminal punctuation', zs[0], '今天是我催眠之旅的第一天。');
  eq('seg: ZH ellipsis break', zs[3], '开始感觉到什么了……');
}

section('segment.js — anchors');

{
  ok('anchor: CJK-adjacent year', getAnchors('1456年： 教宗').includes('DATE-1456'));
  ok('anchor: CJK-adjacent bare number', getAnchors('共12系列').includes('N12'));
  ok('anchor: EN slash date', getAnchors('5/12/2017').includes('DATE-2017'));
  ok('anchor: EN month date', getAnchors('12 May 2017').includes('DATE-2017'));
  ok('anchor: EN month-first date', getAnchors('May 12, 2017').includes('DATE-2017'));
  ok('anchor: CN date', getAnchors('2017年5月12日').includes('DATE-2017'));
  ok('anchor: RPC code', getAnchors('RPC-691 is here').includes('RPC-691'));
  ok('anchor: Site', getAnchors('at Site-002 today').includes('SITE-002'));
  ok('anchor: decimal', getAnchors('rated 4.4 stars').includes('D4.4'));
  ok('anchor: percent', getAnchors('about 15% of it').includes('PCT15'));
  ok('anchor: ordinal keeps number', getAnchors('17th and 18th century').includes('N17'));
  ok('anchor: redaction bar', getAnchors('at ███ site').includes('REDACT'));
  ok('anchor: no false site match', !getAnchors('nonsense').length);
  // "RPC-015" must not also emit a bare N015 (the '-' boundary suppresses it)
  ok('anchor: code does not double as bare number',
    !getAnchors('RPC-015').includes('N015'));
}

section('segment.js — labels, blocks, helpers');

{
  eq('label: EN object class', detectLabel('Object Class: Alpha-Orange'), 'class');
  eq('label: CN 项目分级', detectLabel('项目分级：Alpha-橙'), 'class');
  eq('label: CN 收容协议', detectLabel('收容协议：RPC-691的实例'), 'containment');
  eq('label: CN 现象注册码', detectLabel('现象注册码： 691'), 'item');
  eq('label: EN registered phenomena code',
    detectLabel('Registered Phenomena Code: 691'), 'item');
  eq('label: none', detectLabel('Just some prose here.'), null);
  // longest key wins: 危害类型 must beat 危害
  eq('label: longest key wins', detectLabel('危害类型：视觉危害'), 'hazard');

  const blocks = splitBlocks('Title\n\nFirst para.\nSecond line of same para.\n\n* bullet one\n* bullet two\n\n+ Heading');
  eq('blocks: count', blocks.length, 5);
  eq('blocks: paragraph joined', blocks[1], 'First para. Second line of same para.');
  eq('blocks: bullet separate', blocks[2], '* bullet one');
  eq('blocks: heading separate', blocks[4], '+ Heading');

  eq('helpers: cjkCount', cjkCount('RPC-691 是一个文件'), 5);
  eq('helpers: enWords', enWords('RPC-691 is an MP4 file.'), 6);
  eq('helpers: cnUnits counts latin tokens',
    cnUnits('RPC-691 是文件'), 5);
  eq('helpers: cleanText collapses whitespace', cleanText('  a\n\n  b  '), 'a b');

  const sig = placeholderSignature('RPC-691 has 4.4 stars and ███');
  eq('helpers: placeholder codes', sig.codes, ['RPC-691']);
  ok('helpers: placeholder numbers', sig.nums.includes('4.4'));
  eq('helpers: placeholder bars', sig.bars, 1);
}

/* ---------------------------------------------------------------- align.js */

section('align.js');

{
  const en = [
    'CHATLOGS RECOVERED FROM PHONES AT DISCOVERY SITE:',
    'Today is my first day on my hypnosis journey. I’ve pulled up a video called "Binaural beats to make you into a raptor" made by some channel named "Kittykawaii". I’ve been listening for the whole day today. Starting to feel something… I think it might be working! Might just be my imagination though :P. Will update in a few days.',
    '[REPLIES]',
  ];
  const zh = [
    '从发现现场手机中恢复的聊天记录：',
    '今天是我催眠之旅的第一天。我打开了一个叫“Kittykawaii”的频道制作的视频，标题是“让你变成迅猛龙的双耳节拍”。我听了一整天。开始感觉到什么了……我觉得可能有效！不过也许只是我的想象 :P。过几天再来更新。',
    '[回复]',
  ];
  const { units, stats } = buildTUs(en, zh);
  eq('align: three block pairs', stats.blockPairs, 3);
  eq('align: middle block yields 7 sentence units', 7,
    units.filter((u) => u.block === 1).length);
  const mid = units.filter((u) => u.block === 1);
  eq('align: sentence 1 correct', mid[0].tgt, '今天是我催眠之旅的第一天。');
  eq('align: ellipsis sentence correct', mid[3].tgt, '开始感觉到什么了……');
  eq('align: following sentence not shifted', mid[4].tgt, '我觉得可能有效！');
  eq('align: last sentence correct', mid[6].tgt, '过几天再来更新。');
  ok('align: all units are sentence level',
    units.every((u) => u.level === 'sentence'));
}

{
  // timeline: an extra Chinese block at the top must be skipped, not shift the run
  const en = [
    '1456: In the lead-up to the abortive 1456 Crusade, Pope Callixtus III created a branch.',
    '16-17 July, 1462: Agents of the Auctoritas accompanied Vlad III of Wallachia.',
    '1468: Plutarco do Biasio composes the first edition of the Lexicon.',
  ];
  const zh = [
    '本页面有另一早期预览版本可阅览。',
    '1456年： 在为流产的1456年十字军东征做准备时，教宗设立了分支。',
    '1462年7月16日-17日： 牧所的特工参与了瓦拉几亚的弗拉德三世的夜袭。',
    '1468年： 普鲁塔科·狄·比亚西欧编纂了第一版的《受诅咒者词典》。',
  ];
  const { units, stats } = buildTUs(en, zh);
  eq('align: extra ZH block skipped', stats.unpairedZh, 1);
  eq('align: timeline pairs aligned', stats.blockPairs, 3);
  eq('align: timeline unit count', units.length, 3);
  ok('align: timeline 1462 paired correctly',
    units[1].src.startsWith('16-17 July, 1462') && units[1].tgt.includes('1462年7月16日'),
    JSON.stringify(units[1], null, 1));
  ok('align: timeline 1468 paired correctly',
    units[2].src.startsWith('1468') && units[2].tgt.startsWith('1468年'));
}

{
  // unrelated documents must not be force-paired
  const a = makeBlocks(['RPC-691 is an MP4 video file distributed online.']);
  const b = makeBlocks(['管理局简史：分析与科学署，历史与伪史研究处。']);
  const pairs = alignBlocks(a, b);
  ok('align: unrelated blocks stay unpaired', pairs.length === 0,
    JSON.stringify(pairs));

  // ...but a shouted English header with no identifiers must still pair
  const c = makeBlocks(['CHATLOGS RECOVERED FROM PHONES AT DISCOVERY SITE:']);
  const d = makeBlocks(['从发现现场手机中恢复的聊天记录：']);
  ok('align: all-caps header still pairs',
    alignBlocks(c, d).length === 1);

  ok('align: lengthSim rewards plausible ratio',
    lengthSim('one two three four', '一二三四五六七') >
    lengthSim('one two three four', '一'));
}

/* ---------------------------------------------------------------- match.js */

section('match.js');

{
  const units = [
    { src: 'RPC-691 is an MP4 video file distributed through various websites.', tgt: 'RPC-691是一种在互联网各网站传播的MP4视频文件。' },
    { src: 'RPC-691 is an MP4 video file distributed through many websites.', tgt: 'RPC-691是一种在许多网站传播的MP4视频文件。' },
    { src: 'Containment Protocols: RPC-691 is contained within a physicalizer cell.', tgt: '收容协议：RPC-691被收容在实体化监笼内。' },
    { src: 'The boils are getting worse, guys.', tgt: '疮越来越严重了，各位。' },
  ];
  const idx = new MemoryIndex(units);

  eq('match: normalize', normalize('  Hello,  World!  '), 'hello, world');
  ok('match: tokenize indexes CJK bigrams', tokenize('管理局').includes('管理'));
  eq('match: editSimilarity identical', editSimilarity('abc', 'abc'), 1);
  ok('match: editSimilarity partial', editSimilarity('kitten', 'sitting') > 0.5);

  const ex = idx.search('RPC-691 is an MP4 video file distributed through various websites.');
  eq('match: exact hit score', ex[0].score, 100);
  eq('match: exact hit kind', ex[0].kind, 'exact');
  eq('match: exact hit target', ex[0].unit.tgt, units[0].tgt);

  const fz = idx.search('RPC-691 is an MP4 video file distributed through some websites.', { minScore: 50 });
  ok('match: fuzzy finds the near duplicate', fz.length >= 2, JSON.stringify(fz.map((m) => m.score)));
  ok('match: fuzzy score is high but below 100', fz[0].score > 70 && fz[0].score < 100,
    String(fz[0].score));
  eq('match: fuzzy kind', fz[0].kind, 'fuzzy');

  const none = idx.search('Completely unrelated sentence about marine biology.', { minScore: 60 });
  eq('match: unrelated query returns nothing', none.length, 0);

  const con = idx.concordance('physicalizer');
  eq('match: concordance finds one', con.length, 1);
  eq('match: concordance field flag', con[0].inSrc, true);
  eq('match: concordance on target', idx.concordance('监笼').length, 1);
  const regexCon = idx.concordance('MP4', { regex: true });
  eq('match: concordance regex', regexCon.length, 2);

  const st = idx.stats();
  eq('match: stats units', st.units, 4);
  eq('match: stats distinct sources', st.distinctSources, 4);
}

/* --------------------------------------------------- bundled demo memory */

section('data/demo-tm.tmx');

{
  const { readFileSync, existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const demoPath = join(here, '..', 'data', 'demo-tm.tmx');

  if (!existsSync(demoPath)) {
    ok('demo TMX present', false, `missing ${demoPath}`);
  } else {
    const text = readFileSync(demoPath, 'utf8');
    const parsed = parseTmx(text);
    ok('demo: parses', parsed.units.length > 100, `units=${parsed.units.length}`);

    const pairs = toPairs(parsed, { srcLang: 'en-US', tgtLang: 'zh-CN' });
    eq('demo: every unit normalises', pairs.length, parsed.units.length);

    const idx = new MemoryIndex(pairs.map((p) => ({ src: p.src, tgt: p.tgt })));
    const base = pairs.find((p) => p.src.length > 60).src;
    eq('demo: exact lookup scores 100', Math.round(idx.search(base)[0].score), 100);

    const variant = base.replace(/\bis\b/, 'was').replace(/\.$/, '!');
    const fz = idx.search(variant, { minScore: 40 });
    ok('demo: word-level variant still matches highly',
      fz.length > 0 && fz[0].score > 80, JSON.stringify(fz.map((h) => Math.round(h.score))));
    eq('demo: unrelated text finds nothing',
      idx.search('Completely unrelated text about marine biology and deep sea fish.', { minScore: 40 }).length, 0);

    // rebuild -> reparse must be lossless
    const round = parseTmx(buildTmx({ units: pairs, srcLang: 'en-US', tgtLang: 'zh-CN' }).xml);
    eq('demo: round-trip unit count', round.units.length, pairs.length);
    let mismatch = 0;
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i].src !== round.units[i].src.text) mismatch += 1;
      if (pairs[i].tgt !== round.units[i].tgt.text) mismatch += 1;
    }
    eq('demo: round-trip is lossless', mismatch, 0);
  }
}

/* -------------------------------------------------------------------- end */

console.log(`\n${'─'.repeat(58)}`);
if (failed === 0) {
  console.log(`\x1b[32m✓ all ${passed} assertions passed\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m✗ ${failed} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
