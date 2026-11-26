// Tiny DOM helpers. User data only ever goes in as text nodes or properties,
// never as HTML, so nothing typed or imported can inject markup.
import { formatMoney } from '../../shared/money.js';
import { formatDateUS } from '../../shared/dates.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyProps(el, props, isSvg) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (!isSvg && (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden' || k === 'textContent')) el[k] = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}

function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props instanceof Node || typeof props !== 'object' || Array.isArray(props)) {
    children.unshift(props);
    props = null;
  }
  applyProps(el, props, false);
  appendChildren(el, children);
  return el;
}

export function s(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props, true);
  appendChildren(el, children);
  return el;
}

// Like el.append(), but skips null/undefined/false (native append would
// render them as the text "null").
export function add(el, ...children) {
  appendChildren(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function money(cents, opts) {
  return formatMoney(cents ?? 0, opts);
}

// A <td class="num"> with negative values marked.
export function moneyCell(cents, extraClass) {
  return h('td', { class: ['num', cents < 0 && 'neg', extraClass] }, money(cents));
}

export function date(d) {
  return formatDateUS(d);
}

export function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
