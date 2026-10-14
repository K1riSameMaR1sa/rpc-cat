/**
 * views/corpus.js — translation projects (bilingual documents).
 *
 * A project is a source document plus its per-segment translations.  Projects
 * can be reopened in the workbench, exported as TMX, exported as target-only
 * text, or pushed into a memory.
 */

import * as db from '../db.js';
import { buildTmx } from '../tmx.js';
import * as workbench from './workbench.js';
import {
  h, mount, toast, modal, confirmDialog, downloadText, pickFile, readText,
  fmtNum, fmtDate,
} from '../ui.js';

export function render(ctx) {
  const wrap = h('div');
  wrap.append(h('h1', '语料库'));
  wrap.append(h('p.sub', '保存下来的翻译项目与导入的对照文本。可继续翻译、导出 TMX 或纯译文。'));

  const body = h('div');
  wrap.append(h('div.row', { style: { marginBottom: '12px' } },
    h('button.btn.primary', {
      onclick: async () => {
        const f = await pickFile({ accept: '.txt,.md,.wikidot' });
        if (!f) return;
        const text = await readText(f);
        await db.saveDocument({
          name: f.name.replace(/\.[^.]+$/, ''),
          kind: 'source',
          srcLang: 'en-US',
          tgtLang: 'zh-CN',
          source: text,
          segments: text.split(/\n{2,}/).map((s) => ({ src: s.trim(), tgt: '' })).filter((s) => s.src),
        });
        toast('已导入语料', 'ok');
        ctx.refresh();
      },
    }, '导入原文文件'),
    h('button.btn', {
      onclick: () => { ctx.setView('workbench'); },
    }, '去工作台新建项目'),
  ));
  wrap.append(body);
  loadList(ctx, body);
  return wrap;
}

async function loadList(ctx, body) {
  mount(body, h('div.loading', '读取中'));
  let docs;
  try {
    docs = await db.listDocuments();
  } catch (err) {
    mount(body, h('div.card', '读取失败：' + err.message));
    return;
  }
  if (!docs.length) {
    mount(body, h('div.empty',
      h('p', '语料库还是空的。'),
      h('p.tiny', '在工作台翻译并「保存项目」后，就会出现在这里。')));
    return;
  }

  const tbody = h('tbody');
  for (const d of docs) {
    const pct = d.segments ? Math.round((d.done / d.segments) * 100) : 0;
    tbody.append(h('tr',
      h('td', h('strong', d.name),
        h('div.tiny.mute', `${d.srcLang} → ${d.tgtLang} · ${d.kind === 'project' ? '翻译项目' : '原文语料'}`)),
      h('td', `${fmtNum(d.done)} / ${fmtNum(d.segments)}`,
        h('div.progress-outer', { style: { width: '90px', marginTop: '4px' } },
          h('div.progress-inner', { style: { width: pct + '%' } }))),
      h('td.tiny.mute', fmtDate(d.updatedAt)),
      h('td', h('div.row.tight',
        h('button.btn.sm', { onclick: () => openInWorkbench(ctx, d) }, '继续翻译'),
        h('button.btn.sm', { onclick: () => exportProjectTmx(ctx, d) }, 'TMX'),
        h('button.btn.sm', { onclick: () => exportProjectTarget(ctx, d) }, '译文'),
        h('button.btn.sm', {
          onclick: async () => {
            const full = await db.getDocument(d.id);
            const pairs = (full.segments || [])
              .filter((s) => s.tgt && s.tgt.trim())
              .map((s, i) => ({ src: s.src, tgt: s.tgt, tuid: `${full.name}#${i}`, props: { 'x-doc': full.name } }));
            if (!pairs.length) { toast('这个项目还没有译文', 'err'); return; }
            await ctx.importPairs(pairs, { defaultName: full.name, srcLang: 'en-US', tgtLang: 'zh-CN' });
          },
        }, '存入记忆库'),
        h('button.btn.sm.danger', { onclick: () => removeDoc(ctx, d) }, '删除'),
      )),
    ));
  }

  mount(body, h('div.card', h('div.scroll-y', h('table.data',
    h('thead', h('tr',
      h('th', '名称'),
      h('th', { style: { width: '130px' } }, '进度'),
      h('th', { style: { width: '140px' } }, '更新时间'),
      h('th', { style: { width: '330px' } }, '操作'),
    )),
    tbody,
  ))));
}

async function openInWorkbench(ctx, meta) {
  const doc = await db.getDocument(meta.id);
  if (!doc) { toast('项目不存在', 'err'); return; }
  workbench.openProject(doc);
  ctx.setView('workbench');
  toast(`已打开「${doc.name}」`, 'ok');
}

async function exportProjectTmx(ctx, meta) {
  const doc = await db.getDocument(meta.id);
  const pairs = (doc.segments || []).filter((s) => s.tgt && s.tgt.trim());
  if (!pairs.length) { toast('这个项目还没有译文', 'err'); return; }
  const { xml } = buildTmx({
    units: pairs.map((s, i) => ({ src: s.src, tgt: s.tgt, tuid: `${doc.name}#${i}`, props: { 'x-doc': doc.name } })),
    srcLang: doc.srcLang || 'en-US',
    tgtLang: doc.tgtLang || 'zh-CN',
    headerProps: { Project: doc.name },
  });
  downloadText(`${safe(doc.name)}.tmx`, xml, 'application/xml;charset=utf-8');
  toast(`已导出 ${fmtNum(pairs.length)} 条`, 'ok');
  void ctx;
}

async function exportProjectTarget(ctx, meta) {
  const doc = await db.getDocument(meta.id);
  const pairs = (doc.segments || []).filter((s) => s.tgt && s.tgt.trim());
  if (!pairs.length) { toast('这个项目还没有译文', 'err'); return; }
  downloadText(`${safe(doc.name)}-zh.txt`, pairs.map((s) => s.tgt).join('\n'), 'text/plain;charset=utf-8');
  toast(`已导出 ${fmtNum(pairs.length)} 句`, 'ok');
  void ctx;
}

async function removeDoc(ctx, meta) {
  const ok = await confirmDialog(`删除「${meta.name}」？此操作不可撤销。`, { danger: true, okLabel: '删除' });
  if (!ok) return;
  await db.deleteDocument(meta.id);
  toast('已删除', 'ok');
  ctx.refresh();
}

function safe(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
}
