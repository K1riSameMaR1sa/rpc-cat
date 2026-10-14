/**
 * db.js — IndexedDB storage.
 *
 * Stores
 *   memories  : {id, name, srcLang, tgtLang, note, createdAt}
 *   units     : {id, memoryId, src, tgt, srcNorm, doc, props}   indexed by memory + srcNorm
 *   documents : {id, name, srcLang, tgtLang, segments[], createdAt, updatedAt}
 *   settings  : {key, value}
 *
 * Everything lives in the browser: no server, nothing uploaded.  Bulk inserts
 * are chunked into separate transactions so a 30k-unit TMX neither blocks the
 * UI nor blows the transaction lifetime limit.
 */

const DB_NAME = 'rpc-cat';
const DB_VERSION = 1;
const CHUNK = 1500;

let _db = null;

export function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('此浏览器不支持 IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('memories')) {
        const s = db.createObjectStore('memories', { keyPath: 'id', autoIncrement: true });
        s.createIndex('name', 'name', { unique: false });
      }
      if (!db.objectStoreNames.contains('units')) {
        const s = db.createObjectStore('units', { keyPath: 'id', autoIncrement: true });
        s.createIndex('memoryId', 'memoryId', { unique: false });
        s.createIndex('srcNorm', 'srcNorm', { unique: false });
        s.createIndex('memSrc', ['memoryId', 'srcNorm'], { unique: false });
        s.createIndex('doc', 'doc', { unique: false });
      }
      if (!db.objectStoreNames.contains('documents')) {
        const s = db.createObjectStore('documents', { keyPath: 'id', autoIncrement: true });
        s.createIndex('name', 'name', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      void ev;
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error || new Error('无法打开数据库'));
  });
}

function tx(db, stores, mode) {
  const t = db.transaction(stores, mode);
  return t;
}

function reqP(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务被中止'));
  });
}

/* --------------------------------------------------------------- memories */

export async function listMemories() {
  const db = await openDb();
  const t = tx(db, ['memories', 'units'], 'readonly');
  const memories = await reqP(t.objectStore('memories').getAll());
  const unitStore = t.objectStore('units');
  const counts = await Promise.all(memories.map((m) => reqP(
    unitStore.index('memoryId').count(IDBKeyRange.only(m.id))
  )));
  // language pairs, for a friendlier list
  return memories.map((m, i) => ({ ...m, count: counts[i] })).sort((a, b) => a.id - b.id);
}

export async function createMemory({ name, srcLang, tgtLang, note = '' }) {
  const db = await openDb();
  const t = tx(db, ['memories'], 'readwrite');
  const id = await reqP(t.objectStore('memories').add({
    name: name || '未命名记忆库',
    srcLang: srcLang || 'en-US',
    tgtLang: tgtLang || 'zh-CN',
    note,
    createdAt: Date.now(),
  }));
  await txDone(t);
  return id;
}

export async function updateMemory(id, patch) {
  const db = await openDb();
  const t = tx(db, ['memories'], 'readwrite');
  const store = t.objectStore('memories');
  const cur = await reqP(store.get(id));
  if (cur) await reqP(store.put({ ...cur, ...patch, id }));
  await txDone(t);
}

export async function deleteMemory(id) {
  const db = await openDb();
  const t = tx(db, ['memories', 'units'], 'readwrite');
  await reqP(t.objectStore('memories').delete(id));
  await deleteUnitsByMemory(t, id);
  await txDone(t);
}

function deleteUnitsByMemory(t, memoryId) {
  return new Promise((resolve, reject) => {
    const idx = t.objectStore('units').index('memoryId');
    const req = idx.openKeyCursor(IDBKeyRange.only(memoryId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      t.objectStore('units').delete(cursor.primaryKey);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/* ------------------------------------------------------------------ units */

export async function countUnits(memoryId) {
  const db = await openDb();
  const t = tx(db, ['units'], 'readonly');
  return reqP(t.objectStore('units').index('memoryId').count(IDBKeyRange.only(memoryId)));
}

/**
 * Bulk insert, chunked and yielding between chunks.
 * @param {(done:number,total:number)=>void} [onProgress]
 */
export async function addUnits(memoryId, units, onProgress) {
  const db = await openDb();
  let done = 0;
  const total = units.length;
  for (let i = 0; i < total; i += CHUNK) {
    const slice = units.slice(i, i + CHUNK);
    const t = tx(db, ['units'], 'readwrite');
    const store = t.objectStore('units');
    for (const u of slice) {
      store.add({
        memoryId,
        src: u.src,
        tgt: u.tgt,
        srcNorm: u.srcNorm != null ? u.srcNorm : normSrc(u.src),
        doc: u.doc || '',
        props: u.props || {},
      });
    }
    await txDone(t);
    done += slice.length;
    if (onProgress) onProgress(done, total);
    // let the UI paint between chunks
    await new Promise((r) => setTimeout(r, 0));
  }
  return done;
}

export function normSrc(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,;:!?、。，；：！？]+|[\s.,;:!?、。，；：！？]+$/g, '')
    .trim();
}

/**
 * Page through units of one memory.
 * @param {Object} [opts] { offset, limit, doc }
 */
export async function getUnits(memoryId, opts = {}) {
  const db = await openDb();
  const t = tx(db, ['units'], 'readonly');
  const idx = t.objectStore('units').index('memoryId');
  const range = IDBKeyRange.only(memoryId);
  const out = [];
  const offset = opts.offset || 0;
  const limit = opts.limit == null ? 200 : opts.limit;
  const docFilter = opts.doc || null;

  return new Promise((resolve, reject) => {
    let skipped = 0;
    const req = idx.openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(out); return; }
      const v = cursor.value;
      if (docFilter && v.doc !== docFilter) { cursor.continue(); return; }
      if (skipped < offset) { skipped += 1; cursor.continue(); return; }
      out.push(v);
      if (out.length >= limit) { resolve(out); return; }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getAllUnits(memoryId, onProgress) {
  const db = await openDb();
  const t = tx(db, ['units'], 'readonly');
  const idx = t.objectStore('units').index('memoryId');
  const out = [];
  return new Promise((resolve, reject) => {
    const req = idx.openCursor(IDBKeyRange.only(memoryId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(out); return; }
      out.push(cursor.value);
      if (onProgress && out.length % 5000 === 0) onProgress(out.length);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function updateUnit(id, patch) {
  const db = await openDb();
  const t = tx(db, ['units'], 'readwrite');
  const store = t.objectStore('units');
  const cur = await reqP(store.get(id));
  if (cur) {
    const next = { ...cur, ...patch };
    if (patch.src !== undefined) next.srcNorm = normSrc(patch.src);
    await reqP(store.put(next));
  }
  await txDone(t);
}

export async function deleteUnit(id) {
  const db = await openDb();
  const t = tx(db, ['units'], 'readwrite');
  await reqP(t.objectStore('units').delete(id));
  await txDone(t);
}

export async function deleteUnits(ids) {
  const db = await openDb();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const t = tx(db, ['units'], 'readwrite');
    const store = t.objectStore('units');
    for (const id of slice) store.delete(id);
    await txDone(t);
  }
}

/** Look up existing translations for a source string (import-time dedupe). */
export async function findBySource(memoryId, src) {
  const db = await openDb();
  const t = tx(db, ['units'], 'readonly');
  const idx = t.objectStore('units').index('memSrc');
  return reqP(idx.getAll(IDBKeyRange.only([memoryId, normSrc(src)])));
}

/* -------------------------------------------------------------- documents */

export async function listDocuments() {
  const db = await openDb();
  const t = tx(db, ['documents'], 'readonly');
  const docs = await reqP(t.objectStore('documents').getAll());
  return docs
    .map((d) => ({
      id: d.id, name: d.name, srcLang: d.srcLang, tgtLang: d.tgtLang,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
      segments: d.segments ? d.segments.length : 0,
      done: d.segments ? d.segments.filter((s) => s.tgt && s.tgt.trim()).length : 0,
      kind: d.kind || 'project',
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function saveDocument(doc) {
  const db = await openDb();
  const t = tx(db, ['documents'], 'readwrite');
  const store = t.objectStore('documents');
  const payload = { ...doc, updatedAt: Date.now() };
  if (!payload.createdAt) payload.createdAt = payload.updatedAt;
  const id = await reqP(store.put(payload));
  await txDone(t);
  return id;
}

export async function getDocument(id) {
  const db = await openDb();
  const t = tx(db, ['documents'], 'readonly');
  return reqP(t.objectStore('documents').get(id));
}

export async function deleteDocument(id) {
  const db = await openDb();
  const t = tx(db, ['documents'], 'readwrite');
  await reqP(t.objectStore('documents').delete(id));
  await txDone(t);
}

/* --------------------------------------------------------------- settings */

export async function getSetting(key, dflt = null) {
  const db = await openDb();
  const t = tx(db, ['settings'], 'readonly');
  const row = await reqP(t.objectStore('settings').get(key));
  return row ? row.value : dflt;
}

export async function setSetting(key, value) {
  const db = await openDb();
  const t = tx(db, ['settings'], 'readwrite');
  await reqP(t.objectStore('settings').put({ key, value }));
  await txDone(t);
}

/* ------------------------------------------------------------------ admin */

export async function usage() {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    } catch { /* ignore */ }
  }
  return null;
}

export async function wipeAll() {
  const db = await openDb();
  const t = tx(db, ['memories', 'units', 'documents', 'settings'], 'readwrite');
  await Promise.all([
    reqP(t.objectStore('memories').clear()),
    reqP(t.objectStore('units').clear()),
    reqP(t.objectStore('documents').clear()),
    reqP(t.objectStore('settings').clear()),
  ]);
  await txDone(t);
}
