/**
 * ui.js — tiny DOM helpers shared by all views.
 * No framework: a hyperscript function, toasts, modals, file IO.
 */

/**
 * h('div.card#id', {onclick, class, ...}, child, child…)
 * Tag syntax: 'tag.class1.class2#id'.  Children may be nodes or strings.
 */
export function h(tag, props, ...children) {
  let name = 'div';
  let id = null;
  const classes = [];
  const m = String(tag).match(/^([a-zA-Z0-9]+)?((?:[.#][\w-]+)*)$/);
  if (m) {
    if (m[1]) name = m[1];
    const rest = m[2] || '';
    for (const part of rest.split(/(?=[.#])/)) {
      if (!part) continue;
      if (part[0] === '.') classes.push(part.slice(1));
      else if (part[0] === '#') id = part.slice(1);
    }
  } else {
    name = String(tag);
  }
  const node = document.createElement(name);
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');

  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') {
        node.className = (node.className ? node.className + ' ' : '') + v;
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(node.style, v);
      } else if (k === 'dataset' && typeof v === 'object') {
        Object.assign(node.dataset, v);
      } else if (k === 'html') {
        node.innerHTML = v;
      } else if (k === 'text') {
        node.textContent = v;
      } else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'value' && 'value' in node) {
        node.value = v;
      } else if (k === 'checked' || k === 'disabled' || k === 'selected') {
        node[k] = !!v;
      } else {
        node.setAttribute(k, v === true ? '' : v);
      }
    }
  } else if (props != null) {
    children.unshift(props);
  }

  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/* ------------------------------------------------------------------ toasts */

export function toast(message, kind = '') {
  const box = document.getElementById('toasts');
  const node = h('div.toast' + (kind ? '.' + kind : ''), message);
  box.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s, transform .3s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 320);
  }, kind === 'err' ? 7000 : 3600);
}

/* ------------------------------------------------------------------ modals */

/**
 * @param {Object} o {title, body (Node|string), actions:[{label, primary, onClick(close)}], wide}
 */
export function modal({ title, body, actions = [], wide = false }) {
  const root = document.getElementById('modalRoot');
  const close = () => back.remove();

  const content = h('div.modal', wide ? { style: { maxWidth: '1000px' } } : null);
  if (title) content.append(h('h2', title));
  if (typeof body === 'string') content.append(h('p', body));
  else if (body) content.append(body);

  if (actions.length) {
    const bar = h('div.row', { style: { marginTop: '18px', justifyContent: 'flex-end' } });
    for (const a of actions) {
      bar.append(h('button.btn' + (a.primary ? '.primary' : '') + (a.danger ? '.danger' : ''),
        { onclick: () => a.onClick ? a.onClick(close) : close() }, a.label));
    }
    content.append(bar);
  }

  const back = h('div.modal-back', {
    onclick: (e) => { if (e.target === back) close(); },
  }, content);
  root.append(back);

  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  return { close, content };
}

export function confirmDialog(message, { title = '确认', okLabel = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      body: message,
      actions: [
        { label: '取消', onClick: (close) => { close(); resolve(false); } },
        { label: okLabel, primary: !danger, danger, onClick: (close) => { close(); resolve(true); } },
      ],
    });
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', multiline = false }) {
  return new Promise((resolve) => {
    const input = multiline
      ? h('textarea', { rows: 4, placeholder, value })
      : h('input', { type: 'text', placeholder, value });
    const body = h('div', h('label.dim', { style: { display: 'block', marginBottom: '6px' } }, label), input);
    modal({
      title,
      body,
      actions: [
        { label: '取消', onClick: (close) => { close(); resolve(null); } },
        {
          label: '确定',
          primary: true,
          onClick: (close) => { close(); resolve(input.value); },
        },
      ],
    });
    setTimeout(() => input.focus(), 30);
  });
}

/* ------------------------------------------------------------------- files */

export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}

export function pickFile({ accept = '', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    document.body.append(input);
    input.addEventListener('change', () => {
      const files = [...(input.files || [])];
      input.remove();
      resolve(multiple ? files : (files[0] || null));
    });
    input.click();
  });
}

export function readText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file, 'utf-8');
  });
}

/* ------------------------------------------------------------------ format */

export function fmtNum(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function debounce(fn, ms = 200) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
}

export function scoreClass(score) {
  if (score >= 100) return 'exact';
  if (score >= 75) return 'ok';
  if (score >= 50) return 'fuzzy';
  return 'new';
}
