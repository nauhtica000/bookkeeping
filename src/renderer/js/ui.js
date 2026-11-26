// Reusable UI pieces: toasts (with Undo), modals, confirm dialogs, form
// fields with inline errors, and the date-range picker.
import { h, clear } from './dom.js';
import { parseMoney, centsToDecimal } from '../../shared/money.js';
import {
  monthRange,
  calendarQuarterRange,
  yearToDateRange,
  yearRange,
  addDays,
  parseDate,
  isValidDate,
  nySalesTaxQuarter,
} from '../../shared/dates.js';

// ---------------- toasts ----------------

export function toast(message, { type = 'info', actionLabel, onAction, timeout = type === 'success' ? 3500 : 6000 } = {}) {
  const root = document.getElementById('toasts');
  // Keep at most three on screen; drop the oldest plain ones first.
  while (root.children.length >= 3) {
    const old = [...root.children].find((t) => !t.querySelector('.toast-action')) || root.firstElementChild;
    old.remove();
  }
  let timer;
  const close = () => {
    clearTimeout(timer);
    el.remove();
  };
  const el = h(
    'div',
    { class: ['toast', type], role: type === 'error' ? 'alert' : 'status' },
    h('span', null, message),
    actionLabel &&
      h(
        'button',
        {
          class: 'toast-action',
          onclick: async () => {
            close();
            try {
              await onAction();
            } catch (e) {
              showError(e);
            }
          },
        },
        actionLabel,
      ),
    h('button', { class: 'toast-close', 'aria-label': 'Dismiss', onclick: close }, '×'),
  );
  root.append(el);
  if (timeout) timer = setTimeout(close, timeout);
  return close;
}

export function showError(e) {
  console.error(e);
  toast(e?.message || String(e), { type: 'error', timeout: 10000 });
}

// "Deleted X." with an Undo button that calls `undo` and then `after`.
export function undoToast(message, undo, after) {
  toast(message, {
    actionLabel: 'Undo',
    timeout: 12000,
    onAction: async () => {
      await undo();
      toast('Restored.', { type: 'success', timeout: 3000 });
      await after?.();
    },
  });
}

// ---------------- busy overlay ----------------

let busyDepth = 0;
export async function withBusy(text, fn) {
  const el = document.getElementById('busy');
  document.getElementById('busy-text').textContent = text;
  busyDepth++;
  el.hidden = false;
  try {
    return await fn();
  } finally {
    busyDepth--;
    if (busyDepth === 0) el.hidden = true;
  }
}
export function showBusy(text) {
  document.getElementById('busy-text').textContent = text;
  document.getElementById('busy').hidden = false;
}

// ---------------- modals ----------------

const openModals = [];

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openModals.length) {
    const top = openModals[openModals.length - 1];
    if (!top.busy) top.close();
  }
});

// actions: [{ label, primary, danger, left, onClick(modal) }]
// onClick may return false to keep the modal open.
export function openModal({ title, content, actions = [], wide = false, onClose }) {
  const root = document.getElementById('modal-root');
  const body = h('div', { class: 'modal-body' }, content);
  const foot = h('div', { class: 'modal-foot' });
  const left = h('div', { class: 'left' });
  foot.append(left);
  const modal = {
    busy: false,
    body,
    close() {
      const i = openModals.indexOf(modal);
      if (i >= 0) openModals.splice(i, 1);
      backdrop.remove();
      onClose?.();
    },
    setContent(node) {
      clear(body).append(node);
    },
  };
  const buttons = actions.map((a) => {
    const b = h('button', { class: ['btn', a.primary && 'primary', a.danger && 'danger'], type: 'button' }, a.label);
    b.addEventListener('click', async () => {
      if (modal.busy) return;
      modal.busy = true;
      buttons.forEach((x) => (x.disabled = true));
      try {
        const keep = a.onClick ? await a.onClick(modal) : undefined;
        if (keep !== false) modal.close();
      } catch (e) {
        showError(e);
      } finally {
        modal.busy = false;
        buttons.forEach((x) => (x.disabled = false));
      }
    });
    (a.left ? left : foot).append(b);
    return b;
  });
  const dialog = h(
    'div',
    { class: ['modal', wide && 'wide'], role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => modal.close() }, '×')),
    body,
    actions.length ? foot : null,
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  root.append(backdrop);
  openModals.push(modal);
  // Submit with Enter in single-line inputs → first primary action.
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && !e.target.list) {
      const primary = buttons.find((b, i) => actions[i].primary);
      if (primary) {
        e.preventDefault();
        primary.click();
      }
    }
  });
  setTimeout(() => {
    const first = body.querySelector('input:not([type=hidden]):not([disabled]), select, textarea');
    (first || dialog).focus?.();
  }, 0);
  return modal;
}

export function confirmDialog({ title = 'Are you sure?', message, confirmLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      title,
      content: h('p', { style: { margin: 0, whiteSpace: 'pre-wrap' } }, message),
      actions: [
        { label: 'Cancel', onClick: () => { answered = true; resolve(false); } },
        { label: confirmLabel, primary: !danger, danger, onClick: () => { answered = true; resolve(true); } },
      ],
      onClose: () => {
        if (!answered) resolve(false);
      },
    });
  });
}

// ---------------- form fields ----------------

let idSeq = 0;

// type: text | date | money | select | textarea | checkbox | search
export function field({ label, name, type = 'text', value, required, help, options, span = 2, attrs = {}, list, placeholder }) {
  const id = `f${++idSeq}`;
  let input;
  if (type === 'select') {
    input = h(
      'select',
      { id, name, ...attrs },
      (options || []).map((o) => h('option', { value: String(o.value ?? ''), disabled: o.disabled }, o.label)),
    );
    input.value = value === undefined || value === null ? '' : String(value);
  } else if (type === 'textarea') {
    input = h('textarea', { id, name, rows: attrs.rows || 2, placeholder, ...attrs });
    input.value = value ?? '';
  } else if (type === 'checkbox') {
    input = h('input', { id, name, type: 'checkbox', ...attrs });
    input.checked = !!value;
    const wrap = h('div', { class: ['field', `span-${span}`], dataset: { field: name } }, h('label', { class: 'check', for: id }, input, label), help && h('div', { class: 'help' }, help), h('div', { class: 'err', hidden: true }));
    wrap.input = input;
    return wrap;
  } else {
    const isMoney = type === 'money';
    input = h('input', {
      id,
      name,
      type: isMoney ? 'text' : type,
      class: isMoney ? 'money' : null,
      inputmode: isMoney ? 'decimal' : null,
      autocomplete: 'off',
      spellcheck: isMoney || type === 'date' ? 'false' : null,
      placeholder: placeholder ?? (isMoney ? '0.00' : null),
      list: list || null,
      ...attrs,
    });
    input.value = value ?? '';
    if (isMoney) {
      input.addEventListener('blur', () => {
        if (input.value.trim() === '') return;
        try {
          input.value = centsToDecimal(parseMoney(input.value));
        } catch {
          /* leave as typed; the save shows the error */
        }
      });
    }
  }
  const wrap = h(
    'div',
    { class: ['field', `span-${span}`], dataset: { field: name } },
    h('label', { for: id }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true' }, '*') : null),
    input,
    help ? h('div', { class: 'help' }, help) : null,
    h('div', { class: 'err', hidden: true }),
  );
  if (required) input.setAttribute('aria-required', 'true');
  // Clear this field's error as soon as it's being corrected.
  const clearOwnError = () => {
    if (!wrap.classList.contains('has-error')) return;
    wrap.classList.remove('has-error');
    const e = wrap.querySelector('.err');
    e.hidden = true;
    e.textContent = '';
  };
  input.addEventListener('input', clearOwnError);
  input.addEventListener('change', clearOwnError);
  wrap.input = input;
  return wrap;
}

export function formValues(form) {
  const out = {};
  for (const el of form.querySelectorAll('input[name], select[name], textarea[name]')) {
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

export function clearErrors(form) {
  form.querySelectorAll('.field.has-error').forEach((f) => {
    f.classList.remove('has-error');
    const e = f.querySelector('.err');
    if (e) {
      e.hidden = true;
      e.textContent = '';
    }
  });
  form.querySelector('.form-error-summary')?.remove();
}

// Show an ApiError on a form: per-field messages inline, the rest on top.
export function showFormError(form, err) {
  clearErrors(form);
  const fields = err?.fields || {};
  const unplaced = [];
  let first = null;
  for (const [name, msg] of Object.entries(fields)) {
    const f = form.querySelector(`.field[data-field="${CSS.escape(name)}"]`);
    if (!f) {
      unplaced.push(msg);
      continue;
    }
    f.classList.add('has-error');
    const e = f.querySelector('.err');
    e.textContent = msg;
    e.hidden = false;
    first ??= f.querySelector('input, select, textarea');
  }
  const placedAll = Object.keys(fields).length > 0 && unplaced.length === 0;
  if (!placedAll) {
    const msgs = unplaced.length ? unplaced : [err?.message || 'Something went wrong.'];
    form.prepend(
      h('div', { class: 'banner error form-error-summary', role: 'alert' }, h('span', { class: 'banner-icon' }, '!'), h('div', { class: 'grow' }, msgs.map((m) => h('div', null, m)))),
    );
  }
  first?.focus();
}

export function selectOptions(items, { valueKey = 'id', labelKey = 'name', blank } = {}) {
  const opts = items.map((i) => ({ value: i[valueKey], label: i[labelKey] }));
  return blank !== undefined ? [{ value: '', label: blank }, ...opts] : opts;
}

export function datalist(id, values) {
  return h('datalist', { id }, values.map((v) => h('option', { value: v })));
}

// ---------------- date range picker ----------------

export const RANGE_PRESETS = [
  ['this-month', 'This month'],
  ['last-month', 'Last month'],
  ['this-quarter', 'This quarter'],
  ['last-quarter', 'Last quarter'],
  ['ny-quarter', 'NY sales tax period'],
  ['ytd', 'Year to date'],
  ['this-year', 'This year'],
  ['last-year', 'Last year'],
  ['all', 'All dates'],
  ['custom', 'Custom…'],
];

export function rangeFor(preset, today, custom = {}) {
  const y = parseDate(today).y;
  switch (preset) {
    case 'this-month':
      return monthRange(today);
    case 'last-month':
      return monthRange(addDays(monthRange(today).start, -1));
    case 'this-quarter':
      return calendarQuarterRange(today);
    case 'last-quarter':
      return calendarQuarterRange(addDays(calendarQuarterRange(today).start, -1));
    case 'ny-quarter':
      return nySalesTaxQuarter(today);
    case 'ytd':
      return yearToDateRange(today);
    case 'this-year':
      return yearRange(y);
    case 'last-year':
      return yearRange(y - 1);
    case 'all':
      return { start: '', end: '' };
    default:
      return { start: custom.from || '', end: custom.to || '' };
  }
}

// Returns an element; calls onChange({ preset, from, to }) when it changes.
export function rangePicker({ value, today, onChange, label = 'Dates' }) {
  const state = { preset: value?.preset || 'ytd', from: value?.from || '', to: value?.to || '' };
  const sel = h('select', { 'aria-label': label }, RANGE_PRESETS.map(([v, l]) => h('option', { value: v }, l)));
  sel.value = state.preset;
  const from = h('input', { type: 'date', 'aria-label': 'From' });
  const to = h('input', { type: 'date', 'aria-label': 'To' });
  const customBox = h('div', { class: 'row tight' }, from, h('span', { class: 'muted' }, 'to'), to);
  const sync = () => {
    const r = rangeFor(state.preset, today, state);
    if (state.preset !== 'custom') {
      state.from = r.start;
      state.to = r.end;
    }
    from.value = state.from;
    to.value = state.to;
    customBox.classList.toggle('hidden', state.preset !== 'custom');
  };
  sel.addEventListener('change', () => {
    state.preset = sel.value;
    if (state.preset === 'custom' && !state.from) {
      const r = rangeFor('ytd', today);
      state.from = r.start;
      state.to = r.end;
    }
    sync();
    onChange({ ...state });
  });
  const onDate = () => {
    if (from.value && !isValidDate(from.value)) return;
    if (to.value && !isValidDate(to.value)) return;
    state.from = from.value;
    state.to = to.value;
    onChange({ ...state });
  };
  from.addEventListener('change', onDate);
  to.addEventListener('change', onDate);
  sync();
  const el = h('div', { class: 'field' }, h('label', null, label), h('div', { class: 'row tight' }, sel, customBox));
  el.current = () => ({ ...state });
  return el;
}

export function pageHead(title, sub, ...actions) {
  return h(
    'div',
    { class: 'page-head' },
    h('div', null, h('h1', null, title), sub ? h('div', { class: 'sub' }, sub) : null),
    actions.length ? h('div', { class: 'actions' }, actions) : null,
  );
}

export function button(label, onClick, { primary, danger, small, ghost, title, link } = {}) {
  const b = h('button', { class: ['btn', primary && 'primary', danger && 'danger', small && 'small', ghost && 'ghost', link && 'link'], type: 'button', title }, label);
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (b.dataset.running) return;
    b.dataset.running = '1';
    try {
      await onClick(e);
    } catch (err) {
      showError(err);
    } finally {
      delete b.dataset.running;
    }
  });
  return b;
}
