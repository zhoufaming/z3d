/** 极简 DOM 构造与提示工具，避免为几个面板引入完整框架 */

export function el(tag, props = null, children = null) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked') node.checked = !!v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (children != null) {
    const list = Array.isArray(children) ? children : [children];
    for (const c of list) {
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

let toastTimer = new Map();
export function toast(message, kind = 'info', ms = 2600) {
  const host = document.getElementById('toast-host');
  if (!host) return;
  const node = el('div', { class: `toast ${kind}`, text: message });
  host.append(node);
  const t = setTimeout(() => {
    node.style.transition = 'opacity .2s, transform .2s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 220);
    toastTimer.delete(node);
  }, ms);
  toastTimer.set(node, t);
}

export function setStatus(text, kind = '') {
  const node = document.getElementById('status-text');
  if (!node) return;
  node.textContent = text;
  node.className = kind;
}

export function setStatusMeta(text) {
  const node = document.getElementById('status-meta');
  if (node) node.textContent = text;
}

/** 数字输入框：失焦或回车时提交，避免每敲一个字符就重算场景 */
export function numberInput(value, onCommit, opts = {}) {
  const input = el('input', {
    type: 'text',
    inputmode: 'decimal',
    value: fmt(value, opts.digits ?? 2),
  });
  const commit = () => {
    const v = parseFloat(input.value.replace(/[^\d.eE+-]/g, ''));
    if (Number.isFinite(v)) onCommit(v);
    else input.value = fmt(value, opts.digits ?? 2);
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit();
      input.blur();
    } else if (e.key === 'Escape') {
      input.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // 方向键微调：默认 1，Shift 加速到 10，Alt 精调到 0.1
      e.preventDefault();
      const base = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      const cur = parseFloat(input.value) || 0;
      const next = cur + (e.key === 'ArrowUp' ? base : -base);
      input.value = fmt(next, opts.digits ?? 2);
      onCommit(next);
    }
  });
  return input;
}

export function fmt(n, digits = 2) {
  if (!Number.isFinite(n)) return '0';
  const r = Number(n.toFixed(digits));
  return String(r);
}

export function humanBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
