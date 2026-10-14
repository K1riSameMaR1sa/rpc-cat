/**
 * views/settings.js — import/export everything, storage info, danger zone.
 */

import * as db from '../db.js';
import { parseTmx, toPairs, buildTmx } from '../tmx.js';
import {
  h, mount, toast, modal, confirmDialog, downloadText, pickFile, readText,
  fmtNum, fmtBytes,
} from '../ui.js';

export function render(ctx) {
  const wrap = h('div');
  wrap.append(h('h1', '设置'));
  wrap.append(h('p.sub', '数据全部保存在当前浏览器中。清除浏览器数据会一并删除，请定期导出备份。'));

  wrap.append(h('div.card',
    h('h2', { style: { marginTop: 0 } }, '总记忆库'),
    renderMasterCard(ctx),
  ));

  wrap.append(h('div.card',
    h('h2', { style: { marginTop: 0 } }, '导入 / 导出'),
    h('div.row',
      h('button.btn.primary', {
        onclick: async () => {
          const f = await pickFile({ accept: '.tmx,.xml,.gz' });
          if (!f) return;
          await ctx.importTmxFile(f);
        },
      }, '导入 TMX / TMX.GZ'),
      h('button.btn', {
        onclick: async () => {
          const f = await pickFile({ accept: '.json' });
          if (!f) return;
          const text = await readText(f);
          let data;
          try { data = JSON.parse(text); } catch (e) { toast('JSON 解析失败', 'err'); return; }
          if (!Array.isArray(data)) { toast('JSON 结构不正确', 'err'); return; }
          const pairs = data
            .filter((d) => d && d.src && d.tgt)
            .map((d) => ({ src: d.src, tgt: d.tgt, props: d.props || {} }));
          if (!pairs.length) { toast('没有可导入的条目', 'err'); return; }
          await ctx.importPairs(pairs, { defaultName: f.name.replace(/\.json$/i, ''), srcLang: 'en-US', tgtLang: 'zh-CN' });
        },
      }, '导入 JSON'),
      h('button.btn', {
        onclick: async () => {
          const f = await pickFile({ accept: '.csv' });
          if (!f) return;
          const text = await readText(f);
          const rows = parseCsv(text);
          if (!rows.length) { toast('没有解析到数据', 'err'); return; }
          const header = rows[0].map((s) => s.toLowerCase());
          const si = header.findIndex((x) => x === 'source' || x === 'src' || x === 'en');
          const ti = header.findIndex((x) => x === 'target' || x === 'tgt' || x === 'zh');
          if (si < 0 || ti < 0) { toast('CSV 需要包含 source 与 target 两列', 'err'); return; }
          const pairs = rows.slice(1)
            .map((r) => ({ src: (r[si] || '').trim(), tgt: (r[ti] || '').trim() }))
            .filter((p) => p.src && p.tgt);
          if (!pairs.length) { toast('没有可导入的条目', 'err'); return; }
          await ctx.importPairs(pairs, { defaultName: f.name.replace(/\.csv$/i, ''), srcLang: 'en-US', tgtLang: 'zh-CN' });
        },
      }, '导入 CSV'),
    ),
    h('p.tiny', { style: { marginTop: '10px' } },
      'CSV 需为 UTF-8 编码，并包含 source / target 两列（表头名可用 src/en 与 tgt/zh）。'),
  ));

  wrap.append(h('div.card',
    h('h2', { style: { marginTop: 0 } }, '全部导出'),
    h('p.dim', '把所有记忆库合并成一个 TMX 或 JSON 文件。'),
    h('div.row',
      h('button.btn', { onclick: () => exportAll(ctx, 'tmx') }, '导出全部为 TMX'),
      h('button.btn', { onclick: () => exportAll(ctx, 'json') }, '导出全部为 JSON'),
    ),
  ));

  const store = h('div');
  wrap.append(h('div.card', h('h2', { style: { marginTop: 0 } }, '存储'), store));
  renderStorage(store);

  wrap.append(h('div.card',
    h('h2', { style: { marginTop: 0 } }, '危险操作'),
    h('p.dim', '删除本机保存的全部记忆库、项目与设置。请务必先导出备份。'),
    h('button.btn.danger', {
      onclick: async () => {
        const ok = await confirmDialog(
          '将永久删除本机所有记忆库、语料与设置，且无法撤销。确定继续？',
          { danger: true, okLabel: '全部删除' });
        if (!ok) return;
        const again = await confirmDialog('最后确认：真的要清空所有数据吗？', { danger: true, okLabel: '清空' });
        if (!again) return;
        await db.wipeAll();
        await ctx.refreshMemories();
        toast('已清空', 'ok');
        ctx.refresh();
      },
    }, '清空所有本地数据'),
  ));

  wrap.append(h('div.card',
    h('h2', { style: { marginTop: 0 } }, '关于'),
    h('p.dim', 'RPC CAT —— RPC 管理局翻译辅助工作台。'),
    h('ul', { style: { paddingLeft: '20px', color: 'var(--text-dim)' } },
      h('li', '对齐算法与离线构建 RPC Authority 中英记忆库的流程一致：段落级单调动态规划，'
        + '块内再按句子对齐，以编号、日期、结构标签为锚点。'),
      h('li', '纯静态前端，无后端、无上传；可直接托管在 GitHub Pages。'),
      h('li', '记忆库语料来自 RPC Authority 英文主站与 RPC 管理局中文分站，'
        + '两者均为 CC BY-SA 3.0，导出时署名信息会写入 TMX 头部。'),
    ),
    h('p.tiny', '快捷键：Ctrl+Enter 确认并下一句 · Alt+↑/↓ 切换句子 · Esc 关闭弹窗'),
  ));

  return wrap;
}

function renderMasterCard(ctx) {
  const cfg = ctx.state.config;
  const m = cfg && cfg.master;
  const session = ctx.state.session;

  if (!m || !m.units) {
    return h('div',
      h('p.dim', '这个版本没有内置总记忆库。'),
      h('p.tiny', '维护者可以用 npm run make-master 从完整 TMX 生成 data/rpc-memory.tmx.gz。'));
  }

  const alreadyWritten = ctx.state.memories.some(
    (x) => x.name === m.name || Math.abs((x.count || 0) - m.units) < 5);

  return h('div',
    h('div.stat-grid', { style: { marginBottom: '12px' } },
      h('div.stat', h('div.v', fmtNum(m.units)), h('div.k', '翻译单元')),
      h('div.stat', h('div.v', fmtBytes(m.bytes || 0)), h('div.k', '体积（压缩后）')),
      h('div.stat', h('div.v', `${m.srcLang} → ${m.tgtLang}`), h('div.k', '语言对')),
      h('div.stat', h('div.v', 'CC BY-SA 3.0'), h('div.k', '授权'))),
    h('p.dim', m.name),
    h('p.tiny.mute', m.attribution || ''),
    h('div.row', { style: { marginTop: '12px' } },
      h('button.btn.primary', {
        onclick: async () => { await ctx.openMasterGate(ctx); },
      }, alreadyWritten ? '重新载入总记忆库…' : '载入总记忆库…'),
      session
        ? h('button.btn', { onclick: () => { ctx.clearSessionMemory(); ctx.refresh(); } },
            `清除临时记忆库（${fmtNum(session.units.length)} 条）`)
        : null,
      alreadyWritten
        ? h('span.pill.ok', '本机已写入')
        : h('span.tiny.mute', '需要管理员口令与授权确认')),
    h('p.tiny', { style: { marginTop: '10px' } },
      '载入时可以选择「写入本机记忆库」（长期保留）或「只本次使用，不写入」'
      + '（仅放在内存里供本次查证）。'),
    cfg.adminCodeIsDefault
      ? h('p.tiny', { style: { color: 'var(--warn)', marginTop: '8px' } },
          '⚠ 站点仍在使用默认管理员口令，维护者请运行 npm run set-code -- <新口令> 更换。')
      : null,
  );
}

async function renderStorage(host) {  const mems = await db.listMemories();
  const docs = await db.listDocuments();
  const u = await db.usage();
  const total = mems.reduce((a, m) => a + (m.count || 0), 0);
  mount(host,
    h('div.stat-grid',
      h('div.stat', h('div.v', fmtNum(mems.length)), h('div.k', '记忆库')),
      h('div.stat', h('div.v', fmtNum(total)), h('div.k', '翻译单元')),
      h('div.stat', h('div.v', fmtNum(docs.length)), h('div.k', '语料项目')),
      h('div.stat', h('div.v', u ? fmtBytes(u.usage) : '—'), h('div.k', '已用空间')),
      h('div.stat', h('div.v', u && u.quota ? fmtBytes(u.quota) : '—'), h('div.k', '可用配额')),
    ),
    u && u.quota ? h('p.tiny', { style: { marginTop: '10px' } },
      `浏览器为本站点分配的存储已使用 ${(u.usage / u.quota * 100).toFixed(1)}%。`) : null,
  );
}

async function exportAll(ctx, format) {
  const mems = await db.listMemories();
  if (!mems.length) { toast('没有记忆库', 'err'); return; }
  toast('正在汇总…');
  let all = [];
  for (const m of mems) {
    const rows = await db.getAllUnits(m.id);
    all = all.concat(rows.map((r) => ({ ...r, memoryName: m.name })));
  }
  if (!all.length) { toast('没有数据', 'err'); return; }
  if (format === 'tmx') {
    const { xml } = buildTmx({
      units: all.map((r) => ({
        src: r.src, tgt: r.tgt, tuid: `${r.memoryName}#${r.id}`,
        props: { ...(r.props || {}), 'x-memory': r.memoryName },
      })),
      srcLang: 'en-US', tgtLang: 'zh-CN',
      headerProps: { Project: 'RPC CAT 全部记忆库导出' },
    });
    downloadText('rpc-cat-all.tmx', xml, 'application/xml;charset=utf-8');
  } else {
    downloadText('rpc-cat-all.json', JSON.stringify(
      all.map((r) => ({ src: r.src, tgt: r.tgt, doc: r.doc, memory: r.memoryName, props: r.props })),
      null, 1), 'application/json;charset=utf-8');
  }
  toast(`已导出 ${fmtNum(all.length)} 条`, 'ok');
  void ctx;
}

/** Minimal RFC4180-ish CSV reader (handles quotes and embedded newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text).replace(/^\ufeff/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

export { parseCsv };
