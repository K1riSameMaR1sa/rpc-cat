/**
 * tests/idb-shim.mjs — a small in-memory IndexedDB good enough for db.js.
 *
 * Indexes are computed by scanning on demand rather than maintained, which
 * keeps the shim short and removes a whole class of shim bugs.  Transactions
 * complete on a macrotask once no operation is still pending, matching the
 * "set the handler, then await" pattern db.js uses.
 */

function keyId(k) {
  return Array.isArray(k) ? 'A:' + JSON.stringify(k) : 'V:' + JSON.stringify(k);
}

class FakeRequest {
  constructor() { this.onsuccess = null; this.onerror = null; this.result = undefined; }
  _ok(v) {
    this.result = v;
    const h = this.onsuccess;
    if (h) queueMicrotask(() => h({ target: this }));
  }
  _fail(e) {
    const h = this.onerror;
    if (h) queueMicrotask(() => h({ target: this, error: e }));
  }
}

class FakeIndex {
  constructor(store, name, keyPath) {
    this.store = store;
    this.name = name;
    this.keyPath = keyPath;
  }
  _keyOf(rec) {
    if (Array.isArray(this.keyPath)) return this.keyPath.map((k) => rec[k]);
    return rec[this.keyPath];
  }
  _match(range) {
    const out = [];
    for (const rec of this.store.data.values()) {
      const k = this._keyOf(rec);
      if (k === undefined || k === null) continue;
      if (!range || keyId(k) === keyId(range.__only)) out.push({ rec, k });
    }
    return out;
  }
  count(range) {
    const r = new FakeRequest();
    this.store.tx._pending += 1;
    // resolve on a microtask: the caller attaches onsuccess after we return
    queueMicrotask(() => {
      r._ok(this._match(range).length);
      this.store.tx._release();
    });
    return r;
  }
  getAll(range) {
    const r = new FakeRequest();
    this.store.tx._pending += 1;
    queueMicrotask(() => {
      r._ok(this._match(range).map((x) => x.rec));
      this.store.tx._release();
    });
    return r;
  }
  openKeyCursor(range) {
    const r = new FakeRequest();
    const items = this._match(range);
    let i = 0;
    this.store.tx._pending += 1;
    const step = () => {
      if (i >= items.length) { r._ok(null); this.store.tx._release(); return; }
      const cur = items[i];
      i += 1;
      r.result = {
        primaryKey: this.store._primaryKeyOf(cur.rec),
        value: cur.rec,
        continue: () => queueMicrotask(step),
      };
      const h = r.onsuccess;
      if (h) queueMicrotask(() => h({ target: r }));
    };
    queueMicrotask(step);
    return r;
  }
  /** Same as openKeyCursor, but the cursor exposes the record as `value`. */
  openCursor(range) { return this.openKeyCursor(range); }
}

class FakeStore {
  constructor(name, opts, tx) {
    this.name = name;
    this.keyPath = opts.keyPath;
    this.autoIncrement = !!opts.autoIncrement;
    this.data = new Map();
    this.indexes = new Map();
    this.tx = tx;
    this._next = 1;
  }
  createIndex(name, keyPath) {
    this.indexes.set(name, new FakeIndex(this, name, keyPath));
    return this;
  }
  index(name) {
    const ix = this.indexes.get(name);
    if (!ix) throw new Error('no index ' + name);
    return ix;
  }
  _primaryKeyOf(rec) {
    return Array.isArray(this.keyPath)
      ? this.keyPath.map((k) => rec[k]).join('\u0000')
      : rec[this.keyPath];
  }
  _wrap(fn) {
    const r = new FakeRequest();
    this.tx._pending += 1;
    queueMicrotask(() => {
      try { r._ok(fn()); } catch (e) { r._fail(e); } finally { this.tx._release(); }
    });
    return r;
  }
  add(rec) {
    return this._wrap(() => {
      const copy = { ...rec };
      if (this.autoIncrement) {
        let k = this.keyPath ? copy[this.keyPath] : undefined;
        if (k === undefined) { k = this._next; this._next += 1; copy[this.keyPath] = k; }
        else this._next = Math.max(this._next, Number(k) + 1);
        this.data.set(k, copy);
        return k;
      }
      const k = this._primaryKeyOf(copy);
      this.data.set(k, copy);
      return k;
    });
  }
  put(rec) {
    return this._wrap(() => {
      const copy = { ...rec };
      let k;
      if (this.autoIncrement && copy[this.keyPath] === undefined) {
        k = this._next;
        this._next += 1;
        copy[this.keyPath] = k;
      } else {
        k = this._primaryKeyOf(copy);
      }
      this.data.set(k, copy);
      return k;
    });
  }
  get(key) { return this._wrap(() => this.data.get(key)); }
  delete(key) { return this._wrap(() => { this.data.delete(key); return undefined; }); }
  getAll() { return this._wrap(() => [...this.data.values()]); }
  count() { return this._wrap(() => this.data.size); }
  clear() { return this._wrap(() => { this.data.clear(); return undefined; }); }
  openCursor() {
    const r = new FakeRequest();
    const items = [...this.data.entries()];
    let i = 0;
    this.tx._pending += 1;
    const step = () => {
      if (i >= items.length) { r._ok(null); this.tx._release(); return; }
      const [k, v] = items[i];
      i += 1;
      r.result = { primaryKey: k, value: v, continue: () => queueMicrotask(step) };
      const h = r.onsuccess;
      if (h) queueMicrotask(() => h({ target: r }));
    };
    queueMicrotask(step);
    return r;
  }
}

class FakeTransaction {
  constructor(db, names) {
    this.db = db;
    this.names = names;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this._pending = 0;
    this._scheduled = false;
    this._finished = false;
  }
  objectStore(name) {
    const s = this.db._stores.get(name);
    if (!s) throw new Error('no store ' + name);
    s.tx = this;
    return s;
  }
  /** One pending operation finished. */
  _release() {
    this._pending -= 1;
    this._done();
  }
  _done() {
    if (this._finished || this._pending > 0 || this._scheduled) return;
    this._scheduled = true;
    setTimeout(() => {
      this._scheduled = false;
      if (this._pending === 0 && !this._finished) {
        this._finished = true;
        if (this.oncomplete) this.oncomplete({ target: this });
      }
    }, 0);
  }
}

class FakeDB {
  constructor() {
    this._stores = new Map();
    this.objectStoreNames = { contains: (n) => this._stores.has(n) };
  }
  createObjectStore(name, opts = {}) {
    const tx = new FakeTransaction(this, [name]);
    const s = new FakeStore(name, opts, tx);
    this._stores.set(name, s);
    return s;
  }
  transaction(names) {
    const list = Array.isArray(names) ? names : [names];
    return new FakeTransaction(this, list);
  }
}

export function installFakeIndexedDB() {
  const databases = new Map();
  globalThis.indexedDB = {
    open(name) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        let db = databases.get(name);
        const isNew = !db;
        if (!db) { db = new FakeDB(); databases.set(name, db); }
        req.result = db;
        if (isNew && req.onupgradeneeded) req.onupgradeneeded({ target: { result: db } });
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
  };
  globalThis.IDBKeyRange = {
    only: (v) => ({ __only: v, __kind: 'only' }),
  };
  return { databases };
}
