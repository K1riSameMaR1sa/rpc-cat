/**
 * ai.js — DeepSeek API client and prompt construction.
 *
 * The site is static and DeepSeek's endpoint sends CORS headers (it echoes the
 * request Origin, including `null` for file://), so the browser can call it
 * directly — there is no proxy. The API key therefore lives in this browser
 * only: it is never committed, never sent anywhere except api.deepseek.com, and
 * anyone with access to this browser profile can read it.
 *
 * The prompts are the point of this module. The register RPC/SCP documents are
 * written in — 「临床腔」, the detached bureaucratic-clinical voice — is not
 * something a model produces by default, and it is what separates a usable
 * translation from one that has to be rewritten by hand.
 */

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const MODELS = ['deepseek-chat', 'deepseek-reasoner'];

/* ------------------------------------------------------------ the prompts */

/**
 * The house style. Written as hard rules rather than adjectives because
 * "clinical" alone produces generic formal Chinese, not archive Chinese.
 */
export const SYSTEM_PROMPT = `你是 RPC 管理局（RPC Authority）档案的专职中英翻译，把英文原文译成中文维基档案体。

【文体：临床腔】
译文必须符合 RPC 管理局／SCP 基金会档案的「临床腔」，判据如下：
- 客观、冷静、程式化，像官方技术报告或收容档案；不带情绪、不做文学渲染。
- 多用无主句与被动式：「已被收容」「应予以销毁」「不得接触」「经由……确认」。
- 固定套语照用：项目编号、项目分级、收容措施、描述、发现记录、附录、机动专项组、权限等级。
- 数字、日期、单位用阿拉伯数字与标准写法（2017年5月12日、3.75G、2km/h、██% ）。
- 不要口语、网络用语、感叹式表达；不要「的」字堆积的冗赘长句。
- 专有名词、机构名、职务名严格采用下方术语表给出的译法；术语表没给的人名地名按通行音译。
- 涂黑与删节标记原样保留：███、[已编辑]、[数据删除]、[需要权限]、[已删节]。
- 行内标记原样保留：[[...]]、@@...@@、**...**、//...//、{{...}}、列表符号与换行。
- 代码块、编号、无实义的技术符号（如 SMAP-1: OK、<<ERROR>>）原样输出，不要翻译。
- 不要添加解释、译者注、括号补充、原文回译或任何元信息。`;

export const OUTPUT_RULE = `只输出译文本身。不要写「译文：」之类的引导语，不要用引号包裹整段，不要分点说明，不要复述原文。`;

/**
 * Build the user message: the source plus the evidence the model should honour.
 *
 * @param {Object} o
 * @param {string} o.source
 * @param {Array<{en:string,zh:string}>} [o.terms]    glossary hits
 * @param {Array<{src:string,tgt:string,score:number}>} [o.matches]  TM hits
 * @param {string} [o.prev]     previous sentence, for coherence only
 * @param {string} [o.next]     next sentence, for coherence only
 * @param {string} [o.extra]    free-form instructions from the user
 */
export function buildUserPrompt({ source, terms = [], matches = [], prev = '', next = '', extra = '' }) {
  const parts = [];

  if (terms.length) {
    parts.push(
      '【术语表（必须使用下列译法）】\n'
      + terms.map((t) => `${t.en} = ${t.zh}`).join('\n'));
  }

  if (matches.length) {
    parts.push(
      '【记忆库参考（以往确认过的译法，仅作风格与用词参考；与原文不符就不要照搬）】\n'
      + matches.map((m) => `EN: ${m.src}\nZH: ${m.tgt}`).join('\n'));
  }

  if (prev || next) {
    const ctx = [];
    if (prev) ctx.push(`上一句：${prev}`);
    if (next) ctx.push(`下一句：${next}`);
    parts.push(`【上下文（仅供理解语气与指代，不要去翻译它）】\n${ctx.join('\n')}`);
  }

  if (extra && extra.trim()) parts.push(`【附加要求】\n${extra.trim()}`);

  parts.push(`【原文】\n${source}`);
  parts.push(OUTPUT_RULE);

  return parts.join('\n\n');
}

export function buildMessages(opts) {
  return [
    { role: 'system', content: opts.system || SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(opts) },
  ];
}

/* --------------------------------------------------------------- the call */

/** Turn an HTTP failure into something a human can act on. */
export function describeError(status, body) {
  let msg = '';
  try {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    msg = (j && j.error && (j.error.message || j.error.type)) || '';
  } catch { msg = typeof body === 'string' ? body.slice(0, 200) : ''; }

  if (status === 401) return 'API Key 无效或已失效（401）。请检查密钥是否填写正确。';
  if (status === 402) return '账户余额不足（402）。请到 DeepSeek 平台充值。';
  if (status === 422) return `请求参数有问题（422）：${msg}`;
  if (status === 429) return '请求过于频繁或已达速率上限（429），请稍后再试。';
  if (status >= 500) return `DeepSeek 服务端错误（${status}），请稍后重试。`;
  return `请求失败（${status}）${msg ? '：' + msg : ''}`;
}

function normaliseBase(base) {
  const b = String(base || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  return b || DEFAULT_BASE_URL;
}

/**
 * Stream a chat completion, yielding text deltas.
 *
 * @param {Object} o
 * @param {string} o.apiKey
 * @param {string} [o.baseUrl]
 * @param {string} [o.model]
 * @param {number} [o.temperature]
 * @param {Array}  o.messages
 * @param {Function} [o.fetchImpl]  injectable for tests
 * @param {AbortSignal} [o.signal]
 */
export async function* streamChat({
  apiKey, baseUrl, model = 'deepseek-chat', temperature = 1,
  messages, fetchImpl, signal, maxTokens,
}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('当前环境不支持 fetch');
  if (!apiKey) throw new Error('还没有填写 DeepSeek API Key');

  let res;
  try {
    res = await doFetch(`${normaliseBase(baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        stream: true,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      }),
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    // A CORS or DNS failure surfaces as an opaque TypeError in the browser.
    throw new Error('无法连接 DeepSeek 接口。请检查网络，'
      + '或确认当前页面是以 http(s) 打开（file:// 在部分浏览器会被拦）。');
  }

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    throw new Error(describeError(res.status, body));
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    // no streaming support: fall back to a single JSON response
    const text = await res.text();
    const out = extractContent(text);
    if (out) yield out;
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      throw err;
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });

    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      const delta = extractDelta(payload);
      if (delta) yield delta;
    }
  }
}

/** Pull `choices[0].delta.content` out of one SSE payload, ignoring reasoning. */
export function extractDelta(payload) {
  try {
    const j = JSON.parse(payload);
    const d = j && j.choices && j.choices[0] && j.choices[0].delta;
    if (!d) return '';
    // deepseek-reasoner streams chain-of-thought separately; never emit it
    return typeof d.content === 'string' ? d.content : '';
  } catch {
    return '';
  }
}

/** Pull the message out of a non-streamed response body. */
export function extractContent(raw) {
  try {
    const j = JSON.parse(raw);
    const c = j && j.choices && j.choices[0];
    if (!c) return '';
    return (c.message && c.message.content) || '';
  } catch {
    return '';
  }
}

/** Convenience: collect a stream into one string. */
export async function translateOnce(opts) {
  let out = '';
  for await (const d of streamChat(opts)) out += d;
  return out.trim();
}

/* ------------------------------------------------------------- postprocess */

/**
 * Models like to wrap the answer in quotes or prefix it with a label despite
 * being told not to. Strip that, but never touch the inside of the text.
 */
export function cleanTranslation(text) {
  let s = String(text == null ? '' : text).trim();
  s = s.replace(/^(?:译文|翻译|Translation|译文如下)\s*[:：]\s*/i, '');
  s = s.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
  if (s.length > 1
      && ((s.startsWith('「') && s.endsWith('」')) || (s.startsWith('“') && s.endsWith('”')))) {
    const inner = s.slice(1, -1);
    // only unwrap when the quotes are not part of the sentence itself
    if (!inner.includes('「') && !inner.includes('“')) s = inner;
  }
  return s.trim();
}

/** Rough token/cost estimate so the user knows what a batch will cost. */
export function estimateBatch(sentences) {
  let chars = 0;
  for (const s of sentences) chars += String(s || '').length;
  // ~4 chars per token for English, plus prompt overhead per sentence
  const outTokens = Math.round(chars / 1.6);
  const inTokens = Math.round(chars / 4) + sentences.length * 120;
  return { chars, inTokens, outTokens };
}
