import { h, clear, add, money, moneyCell, date, plural, debounce, formatTimestamp, formatBytes } from '../dom.js';
import { call, lookups, invalidateLookups } from '../api.js';
import { pageHead, button, field, formValues, showFormError, openModal, undoToast, toast, rangePicker, rangeFor, selectOptions, datalist, showError } from '../ui.js';
import { centsToDecimal } from '../../../shared/money.js';

const filters = { preset: 'ytd', from: '', to: '', categoryId: '', paymentMethodId: '', search: '', ownerFundsOnly: false, missingReceipt: false };

function basename(p) {
  return String(p).split(/[\\/]/).pop();
}

export async function openExpenseForm({ id, onSaved } = {}) {
  const L = await lookups();
  const exp = id ? await call('expenses.get', { id }) : null;
  const v = exp
    ? {
        expense_date: exp.expense_date,
        vendor: exp.vendor,
        category_id: exp.category_id,
        amount: centsToDecimal(exp.amount_cents),
        payment_method_id: exp.payment_method_id,
        notes: exp.notes,
      }
    : { expense_date: L.today, vendor: '', category_id: '', amount: '', payment_method_id: '', notes: '' };

  const cats = L.categories.filter((c) => c.active || c.id === v.category_id);
  const pms = L.paymentMethods.filter((p) => p.active || p.id === v.payment_method_id);
  const form = h('form', { class: 'form-grid', onsubmit: (e) => e.preventDefault() });
  const vendor = field({ label: 'Vendor', name: 'vendor', value: v.vendor, required: true, span: 4, list: 'dl-vendors' });
  const cat = field({ label: 'Category', name: 'category_id', type: 'select', value: v.category_id, required: true, span: 3, options: selectOptions(cats, { blank: 'Choose…' }) });
  const catHelp = h('div', { class: 'help' });
  cat.append(catHelp);
  const pm = field({ label: 'Paid with', name: 'payment_method_id', type: 'select', value: v.payment_method_id, required: true, span: 3, options: selectOptions(pms, { blank: 'Choose…' }) });
  const pmHelp = h('div', { class: 'help' });
  pm.append(pmHelp);
  const updateHelp = () => {
    const c = L.categories.find((x) => String(x.id) === cat.input.value);
    catHelp.textContent = c?.schedule_c_line ? `Schedule C: ${c.schedule_c_line}` : '';
    const p = L.paymentMethods.find((x) => String(x.id) === pm.input.value);
    pmHelp.textContent = p?.is_owner_funds ? 'Paid personally — tracked as owed to you (Owner funds).' : '';
  };
  cat.input.addEventListener('change', updateHelp);
  pm.input.addEventListener('change', updateHelp);
  if (!exp) {
    vendor.input.addEventListener('change', async () => {
      if (cat.input.value && pm.input.value) return;
      try {
        const d = await call('expenses.vendorDefaults', { vendor: vendor.input.value });
        if (d) {
          if (!cat.input.value && cats.some((c) => c.id === d.category_id)) cat.input.value = String(d.category_id);
          if (!pm.input.value && pms.some((p) => p.id === d.payment_method_id)) pm.input.value = String(d.payment_method_id);
          updateHelp();
        }
      } catch {
        /* suggestions are optional */
      }
    });
  }

  // Receipts
  const existing = exp ? exp.receipts.map((r) => ({ ...r, remove: false })) : [];
  const pending = [];
  const fileList = h('ul', { class: 'file-list' });
  const renderFiles = () => {
    clear(fileList);
    for (const r of existing) {
      fileList.append(
        h(
          'li',
          null,
          h('span', { class: ['name', r.remove && 'faint'], title: r.rel_path }, r.remove ? h('s', null, r.original_name) : r.original_name),
          h('span', { class: 'small faint' }, formatBytes(r.size_bytes)),
          r.remove ? null : button('Open', () => call('app.openReceipt', { id: r.id }), { small: true, ghost: true }),
          r.remove ? null : button('Show in folder', () => call('app.showReceipt', { id: r.id }), { small: true, ghost: true }),
          button(r.remove ? 'Keep' : 'Remove', () => {
            r.remove = !r.remove;
            renderFiles();
          }, { small: true, ghost: true }),
        ),
      );
    }
    for (const p of pending) {
      fileList.append(
        h('li', null, h('span', { class: 'name', title: p }, basename(p)), h('span', { class: 'badge accent' }, 'new'), button('Remove', () => {
          pending.splice(pending.indexOf(p), 1);
          renderFiles();
        }, { small: true, ghost: true })),
      );
    }
    if (!existing.length && !pending.length) fileList.append(h('li', { class: 'faint' }, 'No receipt attached.'));
  };
  const addPaths = (paths) => {
    for (const p of paths) if (p && !pending.includes(p)) pending.push(p);
    renderFiles();
  };
  const drop = h('div', { class: 'dropzone' }, 'Drop receipt files here (PDF or image), or ', button('choose files…', async () => addPaths(await call('app.pickReceiptFiles')), { link: true }));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    addPaths([...e.dataTransfer.files].map((f) => window.mma.pathForFile(f)));
  });
  renderFiles();

  add(form,
    datalist('dl-vendors', L.vendors),
    field({ label: 'Date', name: 'expense_date', type: 'date', value: v.expense_date, required: true }),
    vendor,
    cat,
    field({ label: 'Amount', name: 'amount', type: 'money', value: v.amount, required: true, help: 'Negative for a vendor credit or return' }),
    h('div', { class: 'span-1' }),
    pm,
    field({ label: 'Notes', name: 'notes', type: 'textarea', value: v.notes, span: 6, attrs: { rows: 2 }, placeholder: 'e.g. 4 sheets 1/4 in. clear cast acrylic, 48 in. x 96 in.' }),
    h('div', { class: 'field span-6', dataset: { field: 'receipts' } }, h('div', { class: 'label' }, 'Receipts'), drop, fileList, h('div', { class: 'err', hidden: true })),
    exp ? h('div', { class: 'span-6 meta' }, `Created ${formatTimestamp(exp.created_at)} · Updated ${formatTimestamp(exp.updated_at)}`) : null,
  );
  updateHelp();

  const save = async () => {
    const values = formValues(form);
    try {
      if (exp) {
        await call('expenses.update', {
          id: exp.id,
          ...values,
          add_receipt_paths: pending,
          remove_receipt_ids: existing.filter((r) => r.remove).map((r) => r.id),
        });
      } else {
        await call('expenses.create', { ...values, receipt_paths: pending });
      }
    } catch (e) {
      showFormError(form, e);
      return false;
    }
    invalidateLookups();
    toast(exp ? 'Expense updated.' : 'Expense saved.', { type: 'success', timeout: 2500 });
    await onSaved?.();
  };
  const actions = [];
  if (exp) actions.push({ label: 'Delete', danger: true, left: true, onClick: () => deleteExpense(exp, onSaved) });
  actions.push({ label: 'Cancel' }, { label: exp ? 'Save changes' : 'Save expense', primary: true, onClick: save });
  if (!exp) {
    actions.splice(actions.length - 1, 0, {
      label: 'Save and add another',
      onClick: async (modal) => {
        const ok = await save();
        if (ok === false) return false;
        setTimeout(() => openExpenseForm({ onSaved }), 0);
      },
    });
  }
  openModal({ title: exp ? 'Edit expense' : 'New expense', content: form, actions, wide: true });
}

async function deleteExpense(exp, after) {
  await call('expenses.delete', { id: exp.id });
  undoToast(`Expense from ${exp.vendor} deleted.`, () => call('expenses.restore', { id: exp.id }), after);
  await after?.();
}

export async function render(page, params, ctx) {
  const L = await lookups({ refresh: true });
  if (params.owner) {
    filters.ownerFundsOnly = true;
    filters.preset = params.preset || 'all';
  }
  const r0 = rangeFor(filters.preset, L.today, filters);
  if (filters.preset !== 'custom') Object.assign(filters, { from: r0.start, to: r0.end });

  const listBox = h('div');
  const refresh = async () => {
    const res = await call('expenses.list', {
      from: filters.from || undefined,
      to: filters.to || undefined,
      categoryId: filters.categoryId || undefined,
      paymentMethodId: filters.paymentMethodId || undefined,
      search: filters.search,
      ownerFundsOnly: filters.ownerFundsOnly,
      missingReceipt: filters.missingReceipt,
    });
    clear(listBox).append(renderTable(res, refresh));
  };
  const selectFilter = (key, items, label, blank) => {
    const s = h('select', { 'aria-label': label }, [h('option', { value: '' }, blank), ...items.map((i) => h('option', { value: i.id }, i.name + (i.active ? '' : ' (archived)')))]);
    s.value = filters[key];
    s.addEventListener('change', () => {
      filters[key] = s.value;
      refresh();
    });
    return h('div', { class: 'field' }, h('label', null, label), s);
  };
  const toggle = (key, label) => {
    const c = h('input', { type: 'checkbox', checked: filters[key] });
    c.addEventListener('change', () => {
      filters[key] = c.checked;
      refresh();
    });
    return h('label', { class: 'check', style: { marginBottom: '7px' } }, c, label);
  };
  const search = h('input', { type: 'search', placeholder: 'Vendor or notes…', value: filters.search, 'aria-label': 'Search expenses' });
  search.addEventListener('input', debounce(() => {
    filters.search = search.value;
    refresh();
  }));

  page.append(
    pageHead('Expenses', 'Business expenses with receipts. Click a row to edit it.', button('+ New expense', () => openExpenseForm({ onSaved: refresh }), { primary: true })),
    h(
      'div',
      { class: 'toolbar' },
      rangePicker({ value: filters, today: L.today, onChange: (r) => { Object.assign(filters, r); refresh(); } }),
      selectFilter('categoryId', L.categories, 'Category', 'All categories'),
      selectFilter('paymentMethodId', L.paymentMethods, 'Paid with', 'Any payment method'),
      h('div', { class: 'field' }, h('label', null, 'Search'), search),
      toggle('ownerFundsOnly', 'Paid personally'),
      toggle('missingReceipt', 'Missing receipt'),
    ),
    listBox,
  );
  await refresh();
  if (params.new) openExpenseForm({ onSaved: refresh });
}

function renderTable(res, refresh) {
  const { rows, totals, truncated } = res;
  if (!rows.length) return h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, 'No expenses match these filters.'));
  const byCat = new Map();
  for (const r of rows) {
    const k = r.category_id;
    if (!byCat.has(k)) byCat.set(k, { name: r.category_name, line: r.schedule_c_line, total: 0, count: 0 });
    const c = byCat.get(k);
    c.total += r.amount_cents;
    c.count++;
  }
  const table = h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Vendor'), h('th', null, 'Category'), h('th', null, 'Paid with'), h('th', { class: 'num' }, 'Amount'), h('th', null, 'Receipt'), h('th', null, 'Notes'), h('th', null, ''))),
      h(
        'tbody',
        null,
        rows.map((r) =>
          h(
            'tr',
            { class: 'clickable', onclick: () => openExpenseForm({ id: r.id, onSaved: refresh }) },
            h('td', { class: 'nowrap' }, date(r.expense_date)),
            h('td', null, r.vendor),
            h('td', null, r.category_name),
            h('td', null, r.payment_method_name, r.is_owner_funds ? [' ', h('span', { class: 'badge warn', title: 'Owed to owner' }, 'Personal')] : null),
            moneyCell(r.amount_cents),
            h('td', null, r.receipt_count ? h('span', { class: 'badge good' }, `${r.receipt_count} file${r.receipt_count > 1 ? 's' : ''}`) : h('span', { class: 'badge' }, 'none')),
            h('td', { class: 'desc', title: r.notes }, r.notes),
            h('td', { class: 'actions-cell' }, button('Delete', () => deleteExpense(r, refresh), { small: true, ghost: true, title: 'Delete (can be undone)' })),
          ),
        ),
      ),
      h('tfoot', null, h('tr', null, h('td', { colspan: 4 }, `${plural(totals.count, 'expense')} — total`), moneyCell(totals.amount), h('td', { colspan: 3 }))),
    ),
  );
  const summary = h(
    'div',
    { class: 'card section' },
    h('h2', null, 'By category (these filters)'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'Category'), h('th', null, 'Schedule C line'), h('th', { class: 'num' }, 'Count'), h('th', { class: 'num' }, 'Total'))),
        h('tbody', null, [...byCat.values()].sort((a, b) => b.total - a.total).map((c) => h('tr', null, h('td', null, c.name), h('td', { class: 'muted small' }, c.line), h('td', { class: 'num' }, String(c.count)), moneyCell(c.total)))),
      ),
    ),
  );
  return h('div', null, table, truncated ? h('div', { class: 'table-note' }, 'Showing the newest 5,000 expenses.') : null, summary);
}

export { showError };
