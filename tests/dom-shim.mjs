/**
 * tests/dom-shim.mjs — the smallest DOM that lets the view modules run.
 *
 * Purpose: catch import-time and render-time errors (a missing export, a typo
 * in a property name, a null dereference) without a browser or a dependency.
 * It is not a spec-compliant DOM — only what this app actually touches.
 */

class FakeNode {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get isConnected() { return !!this.parentNode; }
}

class FakeText extends FakeNode {
  constructor(text) {
    super();
    this.nodeType = 3;
    this._text = String(text);
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.className = '';
    this.id = '';
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.innerHTML = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.selected = false;
    this.rows = 0;
    this.placeholder = '';
    this.href = '';
    this.download = '';
    this.type = '';
    this.files = [];
    this._listeners = {};
    this._classes = new Set();
    const self = this;
    this.classList = {
      add: (...n) => { for (const x of n) self._classes.add(x); self._syncClass(); },
      remove: (...n) => { for (const x of n) self._classes.delete(x); self._syncClass(); },
      contains: (n) => self._classes.has(n),
      toggle: (n, force) => {
        const on = force === undefined ? !self._classes.has(n) : !!force;
        if (on) self._classes.add(n); else self._classes.delete(n);
        self._syncClass();
        return on;
      },
    };
  }
  _syncClass() { this.className = [...this._classes].join(' '); }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  append(...nodes) {
    for (const n of nodes) {
      const node = n instanceof FakeNode ? n : new FakeText(n);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  appendChild(n) { this.append(n); return n; }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) { this.childNodes.splice(i, 1); n.parentNode = null; }
    return n;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  before() {}
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const l = this._listeners[type];
    if (l) this._listeners[type] = l.filter((x) => x !== fn);
  }
  dispatch(type, ev = {}) {
    for (const fn of this._listeners[type] || []) fn({ target: this, preventDefault() {}, ...ev });
  }
  click() { this.dispatch('click'); }
  setAttribute(k, v) { this.attributes[k] = v; if (k === 'class') { this.className = v; this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); } }
  getAttribute(k) { return this.attributes[k] ?? null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
  blur() {}
  scrollIntoView() {}
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.childNodes = [];
    if (v != null && v !== '') this.append(String(v));
  }
  get outerHTML() { return `<${this.tagName.toLowerCase()}>${this.textContent}</${this.tagName.toLowerCase()}>`; }
}

export function installDom() {
  const registry = new Map();

  const doc = {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (t) => new FakeText(t),
    createDocumentFragment: () => new FakeElement('#fragment'),
    getElementById(id) {
      if (!registry.has(id)) {
        const el = new FakeElement('div');
        el.id = id;
        registry.set(id, el);
      }
      return registry.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    _registry: registry,
  };

  globalThis.Node = FakeNode;
  globalThis.document = doc;
  globalThis.window = globalThis;
  globalThis.HTMLElement = FakeElement;

  // Node >= 21 exposes a read-only `navigator`; only fill it in when absent.
  try {
    if (!globalThis.navigator) globalThis.navigator = {};
  } catch { /* read-only getter: leave the built-in alone */ }

  try {
    if (!globalThis.URL) globalThis.URL = {};
    if (typeof globalThis.URL.createObjectURL !== 'function') {
      globalThis.URL.createObjectURL = () => 'blob:stub';
      globalThis.URL.revokeObjectURL = () => {};
    }
  } catch { /* ignore */ }

  globalThis.DOMParser = class {
    parseFromString() {
      return {
        body: new FakeElement('body'),
        querySelector: () => null,
        querySelectorAll: () => [],
      };
    }
  };
  globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
  globalThis.FileReader = class {
    readAsText() { this.onerror && this.onerror(new Error('not available in shim')); }
  };
  globalThis.fetch = async () => { throw new Error('no network in shim'); };
  return { document: doc, FakeElement, FakeNode, FakeText };
}
