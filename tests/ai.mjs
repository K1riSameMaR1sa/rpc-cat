/**
 * tests/ai.mjs — DeepSeek client: prompt construction, SSE parsing, errors.
 *
 * The network is stubbed, so this exercises the real code paths — request
 * shape, stream assembly, abort, and the clinical-tone prompt's content —
 * without spending anything.
 *
 * Run: node tests/ai.mjs
 */

import { installDom } from './dom-shim.mjs';

installDom();

const ai = await import('../js/ai.js');

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

/** A Response-like stub whose body streams the given SSE lines. */
function sseResponse(lines, { ok: isOk = true, status = 200 } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: isOk,
    status,
    body: {
      getReader() {
        return {
          read: async () => (i < lines.length
            ? { done: false, value: encoder.encode(lines[i++]) }
            : { done: true, value: undefined }),
          cancel: async () => {},
        };
      },
    },
    text: async () => lines.join(''),
  };
}

/** Records the request and answers with a canned stream. */
function mockFetch(lines, opts) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return sseResponse(lines, opts);
  };
  fn.calls = calls;
  return fn;
}

function delta(content) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;
}

/* --------------------------------------------------------------- prompts */

section('the clinical-tone prompt');

{
  const sp = ai.SYSTEM_PROMPT;
  ok('names the register', sp.includes('临床腔'));
  ok('demands the archive register', sp.includes('RPC 管理局') && sp.includes('收容档案'));
  ok('asks for impersonal/passive phrasing', /无主句|被动/.test(sp));
  ok('lists the fixed section vocabulary', sp.includes('收容措施') && sp.includes('项目分级'));
  ok('requires glossary obedience', /术语表/.test(sp));
  ok('protects redaction marks', sp.includes('███') && sp.includes('[数据删除]'));
  ok('protects inline wiki markup', sp.includes('[[...]]') && sp.includes('@@...@@'));
  ok('forbids translator notes', /不要添加解释/.test(sp));
  ok('forbids literary flourishes', /不做文学渲染|不带情绪/.test(sp));
  ok('forbids colloquialisms', /不要口语/.test(sp));
  ok('is in Chinese', /[\u4e00-\u9fff]/.test(sp));

  ok('output rule is terse and in Chinese', ai.OUTPUT_RULE.includes('只输出译文本身'));
}

section('buildUserPrompt');

{
  const p = ai.buildUserPrompt({
    source: 'The Authority is here.',
    terms: [{ en: 'Authority', zh: '管理局' }, { en: 'RPC-691', zh: 'RPC-691' }],
    matches: [{ src: 'The Authority', tgt: '管理局' }],
    prev: 'Previous sentence.',
    next: 'Next sentence.',
    extra: '本句是访谈对白。',
  });

  ok('carries the glossary', p.includes('Authority = 管理局') && p.includes('术语表'));
  ok('marks the glossary as mandatory', /必须使用/.test(p));
  ok('carries memory references', p.includes('EN: The Authority') && p.includes('ZH: 管理局'));
  ok('warns not to copy irrelevant references', /不要照搬/.test(p));
  ok('carries context', p.includes('上一句：Previous sentence.') && p.includes('下一句：Next sentence.'));
  ok('marks context as not-to-translate', /不要.*翻译它/.test(p));
  ok('carries extra instructions', p.includes('本句是访谈对白。'));
  ok('ends with the source', p.includes('【原文】\nThe Authority is here.'));
  ok('ends with the output rule', p.trim().endsWith(ai.OUTPUT_RULE));

  const bare = ai.buildUserPrompt({ source: 'Just this.' });
  ok('omits empty sections', !bare.includes('术语表') && !bare.includes('记忆库参考')
    && !bare.includes('上下文'), bare);
  ok('still includes the source', bare.includes('Just this.'));
}

section('buildMessages');

{
  const m = ai.buildMessages({ source: 'x' });
  eq('two messages', m.length, 2);
  eq('system first', m[0].role, 'system');
  eq('user second', m[1].role, 'user');
  ok('system is the clinical prompt by default', m[0].content === ai.SYSTEM_PROMPT);
  const custom = ai.buildMessages({ source: 'x', system: 'CUSTOM' });
  eq('a custom system prompt overrides', custom[0].content, 'CUSTOM');
}

/* ----------------------------------------------------------- SSE parsing */

section('extractDelta');

{
  eq('plain content', ai.extractDelta(JSON.stringify({ choices: [{ delta: { content: '你好' } }] })), '你好');
  eq('empty delta', ai.extractDelta(JSON.stringify({ choices: [{ delta: {} }] })), '');
  eq('malformed json is ignored', ai.extractDelta('{not json'), '');
  eq('missing choices is ignored', ai.extractDelta('{"x":1}'), '');
  // deepseek-reasoner streams chain-of-thought separately — it must never leak
  eq('reasoning content is dropped',
    ai.extractDelta(JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking…', content: 'ok' } }] })),
    'ok');
  eq('reasoning-only delta yields nothing',
    ai.extractDelta(JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking…' } }] })), '');
}

section('extractContent');

{
  eq('non-streamed body',
    ai.extractContent(JSON.stringify({ choices: [{ message: { content: '结果' } }] })), '结果');
  eq('garbage yields empty', ai.extractContent('<html>'), '');
}

/* -------------------------------------------------------------- the call */

section('streamChat request shape');

{
  const f = mockFetch([delta('甲'), delta('乙'), 'data: [DONE]\n']);
  let out = '';
  for await (const d of ai.streamChat({
    apiKey: 'sk-test', model: 'deepseek-chat', temperature: 1.2,
    messages: [{ role: 'user', content: 'hi' }], fetchImpl: f,
  })) out += d;

  eq('deltas are concatenated', out, '甲乙');
  eq('one request was made', f.calls.length, 1);
  eq('posts to the right URL', f.calls[0].url, 'https://api.deepseek.com/chat/completions');
  eq('uses POST', f.calls[0].init.method, 'POST');
  eq('sends the bearer token', f.calls[0].init.headers.Authorization, 'Bearer sk-test');
  eq('asks for JSON', f.calls[0].init.headers['Content-Type'], 'application/json');

  const body = JSON.parse(f.calls[0].init.body);
  eq('model is forwarded', body.model, 'deepseek-chat');
  eq('temperature is forwarded', body.temperature, 1.2);
  eq('streaming is requested', body.stream, true);
  ok('messages are forwarded', Array.isArray(body.messages) && body.messages.length === 1);
  ok('no API key leaks into the body', !JSON.stringify(body).includes('sk-test'));
}

section('streamChat edge cases');

{
  // a custom base URL is honoured and trailing slashes trimmed
  const f1 = mockFetch([delta('x'), 'data: [DONE]\n']);
  for await (const _ of ai.streamChat({
    apiKey: 'k', baseUrl: 'https://example.com/v1/', messages: [], fetchImpl: f1,
  })) { /* drain */ }
  eq('base URL is normalised', f1.calls[0].url, 'https://example.com/v1/chat/completions');

  // [DONE] must stop the loop even if more lines follow
  const f2 = mockFetch([delta('a'), 'data: [DONE]\n', delta('b')]);
  let out2 = '';
  for await (const d of ai.streamChat({ apiKey: 'k', messages: [], fetchImpl: f2 })) out2 += d;
  eq('[DONE] terminates the stream', out2, 'a');

  // comments, blank lines and non-data lines are skipped
  const f3 = mockFetch([': keepalive\n', '\n', 'event: ping\n', delta('c'), 'data: [DONE]\n']);
  let out3 = '';
  for await (const d of ai.streamChat({ apiKey: 'k', messages: [], fetchImpl: f3 })) out3 += d;
  eq('non-data lines are ignored', out3, 'c');

  // a delta split across two reads must still parse
  const raw = delta('拆分');
  const half = Math.floor(raw.length / 2);
  const f4 = mockFetch([raw.slice(0, half), raw.slice(half), 'data: [DONE]\n']);
  let out4 = '';
  for await (const d of ai.streamChat({ apiKey: 'k', messages: [], fetchImpl: f4 })) out4 += d;
  eq('a chunk split mid-line is reassembled', out4, '拆分');

  // missing key
  let threw = '';
  try { for await (const _ of ai.streamChat({ apiKey: '', messages: [], fetchImpl: mockFetch([]) })) { /* */ } }
  catch (e) { threw = e.message; }
  ok('a missing key is refused before any request', /API Key/.test(threw), threw);

  // network failure
  let netErr = '';
  try {
    for await (const _ of ai.streamChat({
      apiKey: 'k', messages: [],
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    })) { /* */ }
  } catch (e) { netErr = e.message; }
  ok('a network failure gives an actionable message', /无法连接/.test(netErr), netErr);

  // abort is quiet, not an error
  const ac = new AbortController();
  ac.abort();
  let aborted = false;
  try {
    for await (const _ of ai.streamChat({
      apiKey: 'k', messages: [], signal: ac.signal,
      fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
    })) { /* */ }
  } catch { aborted = true; }
  ok('an abort does not throw', aborted === false);
}

section('describeError');

{
  ok('401', /API Key 无效/.test(ai.describeError(401, '')));
  ok('402', /余额不足/.test(ai.describeError(402, '')));
  ok('429', /速率|频繁/.test(ai.describeError(429, '')));
  ok('500', /服务端错误/.test(ai.describeError(503, '')));
  ok('server message is surfaced',
    ai.describeError(422, JSON.stringify({ error: { message: 'bad param' } })).includes('bad param'));
  ok('unknown status still reports', /请求失败（418）/.test(ai.describeError(418, '')));
}

section('translateOnce');

{
  const f = mockFetch([delta('管'), delta('理局'), 'data: [DONE]\n']);
  eq('collects the whole stream',
    await ai.translateOnce({ apiKey: 'k', messages: [], fetchImpl: f }), '管理局');
}

/* ---------------------------------------------------------- postprocess */

section('cleanTranslation');

{
  eq('strips a 译文： label', ai.cleanTranslation('译文：管理局已收容该项目。'), '管理局已收容该项目。');
  eq('strips an English label', ai.cleanTranslation('Translation: The Authority'), 'The Authority');
  eq('strips a code fence', ai.cleanTranslation('```\n管理局\n```'), '管理局');
  eq('unwraps a full-string quote', ai.cleanTranslation('「管理局已收容该项目。」'), '管理局已收容该项目。');
  eq('keeps inner quotes', ai.cleanTranslation('他说「不」。「好吧。」'), '他说「不」。「好吧。」');
  eq('trims whitespace', ai.cleanTranslation('  管理局  '), '管理局');
  eq('handles empty', ai.cleanTranslation(''), '');
  eq('handles null', ai.cleanTranslation(null), '');
  eq('leaves plain text alone', ai.cleanTranslation('RPC-691 是一个 MP4 文件。'), 'RPC-691 是一个 MP4 文件。');
}

section('estimateBatch');

{
  const e = ai.estimateBatch(['a'.repeat(400), 'b'.repeat(400)]);
  eq('counts characters', e.chars, 800);
  ok('produces plausible token counts', e.inTokens > 0 && e.outTokens > 0,
    JSON.stringify(e));
  eq('empty input', ai.estimateBatch([]).chars, 0);
}

/* -------------------------------------------------------------------- end */

console.log(`\n${'─'.repeat(58)}`);
if (failed === 0) {
  console.log(`\x1b[32m✓ all ${passed} AI checks passed\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m✗ ${failed} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(1);
}
