import { h, clear, add, money, moneyCell, date, plural, debounce, formatTimestamp } from '../dom.js';
import { call, lookups, invalidateLookups } from '../api.js';
import {
  pageHead, button, field, formValues, showFormError, openModal, undoToast, toast, confirmDialog,
  rangePicker, rangeFor, selectOptions, datalist,
} from '../ui.js';
import { parseMoneyOrZero, centsToDecimal, scaleCents } from '../../../shared/money.js';
import { STATE_OPTIONS, NY_COUNTIES, jurisdictionLabel } from '../../../shared/geo.js';

const CHANNELS = [
  { value: 'shopify', label: 'Shopify' },
  { value: 'direct', label: 'Direct' },
  { value: 'other', label: 'Other' },
];
const CHANNEL_LABEL = Object.fromEntries(CHANNELS.map((c) => [c.value, c.label]));

// Filters survive moving between screens.
const filters = { preset: 'ytd', from: '', to: '', channel: '', custom: '', kind: '', search: '', review: false };

function tryCents(v) {
  try {
    return parseMoneyOrZero(v);
  } catch {
    return null;
  }
}

// ---------------- sale form ----------------

function countyControl(state, value, localities) {
  if (state === 'INTL') return h('div', { class: 'computed muted' }, 'Not needed for sales outside the US');
  if (state === 'NY') {
    const f = field({
      label: 'County',
      name: 'ship_county',
      type: 'select',
      value: NY_COUNTIES.includes(value) ? value : '',
      required: true,
      options: [{ value: '', label: 'Choose county…' }, ...NY_COUNTIES.map((c) => ({ value: c, label: c }))],
      span: 6,
    });
    return f;
  }
  return field({ label: 'County', name: 'ship_county', value, span: 6, help: 'Optional outside New York' });
}

export async function openSaleForm({ id, onSaved, presetCustomer } = {}) {
  const L = await lookups();
  let detail = null;
  if (id) {
    detail = await call('sales.get', { id });
    if (detail.sale.kind === 'refund') return openRefundForm({ refundId: id, onSaved });
  }
  const sale = detail?.sale;
  const st = L.settings;
  const v = sale
    ? {
        sale_date: sale.sale_date,
        channel: sale.channel,
        order_number: sale.order_number || '',
        customer_name: sale.customer_name || '',
        description: sale.description,
        is_custom: !!sale.is_custom,
        subtotal: centsToDecimal(sale.subtotal_cents),
        shipping: centsToDecimal(sale.shipping_cents),
        tax: centsToDecimal(sale.tax_cents),
        taxable: centsToDecimal(sale.taxable_cents),
        taxable_override: sale.taxable_cents !== (sale.tax_cents > 0 ? sale.subtotal_cents + sale.shipping_cents : 0),
        ship_state: sale.ship_state,
        ship_county: sale.ship_county,
        ship_locality: sale.ship_locality,
        payment_method_id: sale.payment_method_id || '',
        notes: sale.notes,
      }
    : {
        sale_date: L.today,
        channel: 'direct',
        customer_name: presetCustomer || '',
        ship_state: st.default_state,
        ship_county: st.default_county,
        ship_locality: st.default_locality,
        payment_method_id: '',
        taxable_override: false,
      };

  const form = h('form', { class: 'form-grid', onsubmit: (e) => e.preventDefault() });
  const customerHint = h('div', { class: 'help' });
  const custField = field({ label: 'Customer', name: 'customer_name', value: v.customer_name, span: 4, list: 'dl-customers', placeholder: 'Type a name — new names are added automatically' });
  custField.append(customerHint);
  const updateHint = () => {
    const n = custField.input.value.trim().toLowerCase();
    customerHint.textContent = !n ? '' : L.customers.some((c) => c.name.toLowerCase() === n) ? 'Existing customer' : 'New customer — will be added to your customer list';
  };
  custField.input.addEventListener('input', updateHint);
  updateHint();

  const sub = field({ label: 'Subtotal (after discounts)', name: 'subtotal', type: 'money', value: v.subtotal, required: true });
  const ship = field({ label: 'Shipping charged', name: 'shipping', type: 'money', value: v.shipping });
  const tax = field({ label: 'Sales tax collected', name: 'tax', type: 'money', value: v.tax });
  const totalLine = h('div', { class: 'computed span-6' });
  const override = field({ label: 'Override taxable amount', name: 'taxable_override', type: 'checkbox', value: v.taxable_override, span: 2 });
  const taxable = field({ label: 'Taxable amount', name: 'taxable', type: 'money', value: v.taxable, span: 2, help: 'e.g. part of the order was exempt' });
  const recompute = () => {
    const a = tryCents(sub.input.value);
    const b = tryCents(ship.input.value);
    const c = tryCents(tax.input.value);
    taxable.classList.toggle('hidden', !override.input.checked);
    if (a === null || b === null || c === null) {
      totalLine.textContent = 'Total: —';
      return;
    }
    const auto = c > 0 ? a + b : 0;
    clear(totalLine).append(
      'Total ',
      h('strong', null, money(a + b + c)),
      ' · Taxable ',
      h('strong', null, override.input.checked ? money(tryCents(taxable.input.value) ?? 0) : money(auto)),
      override.input.checked ? ' (overridden)' : c > 0 ? ' (subtotal + shipping, because tax was collected)' : ' (no tax collected)',
    );
    if (!override.input.checked) taxable.input.value = centsToDecimal(auto);
  };
  [sub, ship, tax, taxable].forEach((f) => f.input.addEventListener('input', recompute));
  override.input.addEventListener('change', recompute);

  const stateField = field({ label: 'Ship-to state', name: 'ship_state', type: 'select', value: v.ship_state, required: true, options: STATE_OPTIONS.map(([c, n]) => ({ value: c, label: `${n} (${c})` })).map((o) => (o.value === 'INTL' ? { ...o, label: 'Outside the US' } : o)), help: 'For pickups use your own location' });
  const countyBox = h('div', { class: 'span-2' });
  const renderCounty = (keep) => clear(countyBox).append(countyControl(stateField.input.value, keep, L.localities));
  stateField.input.addEventListener('change', () => renderCounty(''));
  renderCounty(v.ship_county);
  const locality = field({ label: 'City / locality', name: 'ship_locality', value: v.ship_locality, list: 'dl-localities', help: 'Only if the city has its own rate (e.g. New York City)' });

  const reviewBox = sale?.needs_review
    ? h('div', { class: 'span-6 banner' }, h('span', { class: 'banner-icon' }, '⚠'), h('div', { class: 'grow' }, h('strong', null, 'Flagged for review. '), sale.review_note), field({ label: 'Keep flagged', name: 'needs_review', type: 'checkbox', value: true, span: 1 }))
    : null;

  add(form,
    datalist('dl-customers', L.customers.map((c) => c.name)),
    datalist('dl-localities', L.localities),
    reviewBox,
    field({ label: 'Date', name: 'sale_date', type: 'date', value: v.sale_date, required: true }),
    field({ label: 'Channel', name: 'channel', type: 'select', value: v.channel, required: true, options: CHANNELS }),
    field({ label: 'Order / invoice #', name: 'order_number', value: v.order_number, placeholder: v.channel === 'shopify' ? '#1001' : 'INV-1001' }),
    custField,
    field({ label: 'Custom job (final sale)', name: 'is_custom', type: 'checkbox', value: v.is_custom, help: 'Unchecked = stock item' }),
    field({ label: 'Description', name: 'description', type: 'textarea', value: v.description, span: 6, attrs: { rows: 2 } }),
    sub,
    ship,
    tax,
    totalLine,
    h('div', { class: 'span-6 row', style: { alignItems: 'flex-start', gap: '16px' } }, override, taxable),
    stateField,
    countyBox,
    locality,
    field({ label: 'Payment method', name: 'payment_method_id', type: 'select', value: v.payment_method_id, options: selectOptions(L.paymentMethods.filter((p) => p.active || p.id === v.payment_method_id), { blank: '—' }), span: 3 }),
    field({ label: 'Notes', name: 'notes', type: 'textarea', value: v.notes, span: 6, attrs: { rows: 2 } }),
  );
  recompute();

  let extra = null;
  if (detail) {
    const r = detail.refunds;
    extra = h(
      'div',
      { class: 'section' },
      r.length
        ? h(
            'div',
            { class: 'note-box' },
            h('strong', null, `Refunds (${r.length}): `),
            r.map((x, i) => [i ? ' · ' : '', `${date(x.sale_date)} ${money(x.total_cents)}`]),
            h('div', null, `Left to refund: ${money(detail.remaining.subtotal + detail.remaining.shipping + detail.remaining.tax)}`),
          )
        : null,
      h('div', { class: 'meta section' }, `Created ${formatTimestamp(sale.created_at)} · Updated ${formatTimestamp(sale.updated_at)}${sale.import_batch_id ? ` · Imported from Shopify (import #${sale.import_batch_id})` : ''}`),
    );
  }

  const save = async () => {
    const values = formValues(form);
    try {
      if (sale) await call('sales.update', { id: sale.id, ...values });
      else await call('sales.create', values);
    } catch (e) {
      showFormError(form, e);
      return false;
    }
    invalidateLookups();
    toast(sale ? 'Sale updated.' : 'Sale saved.', { type: 'success', timeout: 2500 });
    await onSaved?.();
  };

  const actions = [];
  if (sale) {
    actions.push({
      label: 'Delete',
      danger: true,
      left: true,
      onClick: async () => {
        await deleteSale(sale, onSaved);
      },
    });
    actions.push({
      label: 'Record refund…',
      left: true,
      onClick: async () => {
        setTimeout(() => openRefundForm({ saleId: sale.id, onSaved }), 0);
      },
    });
  }
  actions.push({ label: 'Cancel' }, { label: sale ? 'Save changes' : 'Save sale', primary: true, onClick: save });
  openModal({ title: sale ? `Edit sale${sale.order_number ? ` ${sale.order_number}` : ''}` : 'New sale', content: h('div', null, form, extra), actions, wide: true });
}

async function deleteSale(row, after) {
  const res = await call('sales.delete', { id: row.id });
  const what = row.kind === 'refund' ? 'Refund deleted.' : res.count > 1 ? `Sale and ${plural(res.count - 1, 'refund')} deleted.` : 'Sale deleted.';
  undoToast(what, () => call('sales.restore', { id: row.id }), after);
  await after?.();
}

// ---------------- refund form ----------------

export async function openRefundForm({ saleId, refundId, onSaved }) {
  const L = await lookups();
  const detail = await call('sales.get', { id: refundId || saleId });
  const original = detail.original;
  const refund = refundId ? detail.sale : null;
  const rem = detail.remaining;
  const remTotal = rem.subtotal + rem.shipping + rem.tax;
  if (!refund && remTotal <= 0) {
    toast('This sale has already been fully refunded.', { type: 'error' });
    return;
  }
  const v = refund
    ? {
        sale_date: refund.sale_date,
        subtotal: centsToDecimal(-refund.subtotal_cents),
        shipping: centsToDecimal(-refund.shipping_cents),
        tax: centsToDecimal(-refund.tax_cents),
        taxable: centsToDecimal(-refund.taxable_cents),
        payment_method_id: refund.payment_method_id || '',
        description: refund.description,
        notes: refund.notes,
      }
    : { sale_date: L.today, payment_method_id: original.payment_method_id || '', description: '', notes: '' };

  const form = h('form', { class: 'form-grid', onsubmit: (e) => e.preventDefault() });
  const sub = field({ label: 'Subtotal refunded', name: 'subtotal', type: 'money', value: v.subtotal, help: `Up to ${money(rem.subtotal)}` });
  const ship = field({ label: 'Shipping refunded', name: 'shipping', type: 'money', value: v.shipping, help: `Up to ${money(rem.shipping)}` });
  const tax = field({ label: 'Sales tax refunded', name: 'tax', type: 'money', value: v.tax, help: `Up to ${money(rem.tax)}` });
  const override = field({ label: 'Override taxable amount', name: 'taxable_override', type: 'checkbox', value: false, span: 2 });
  const taxable = field({ label: 'Taxable amount refunded', name: 'taxable', type: 'money', value: v.taxable, span: 2 });
  const line = h('div', { class: 'computed span-6' });
  const recompute = () => {
    const a = tryCents(sub.input.value) ?? 0;
    const b = tryCents(ship.input.value) ?? 0;
    const c = tryCents(tax.input.value) ?? 0;
    taxable.classList.toggle('hidden', !override.input.checked);
    const base = original.subtotal_cents + original.shipping_cents;
    let auto = 0;
    if (original.taxable_cents > 0 && base > 0) {
      auto = a === rem.subtotal && b === rem.shipping && c === rem.tax ? rem.taxable : Math.min(scaleCents(original.taxable_cents, a + b, base), a + b, rem.taxable);
    }
    if (!override.input.checked) taxable.input.value = centsToDecimal(Math.max(0, auto));
    clear(line).append('Refund total ', h('strong', null, money(a + b + c)), ' · Taxable credit ', h('strong', null, money(override.input.checked ? tryCents(taxable.input.value) ?? 0 : Math.max(0, auto))));
  };
  [sub, ship, tax, taxable].forEach((f) => f.input.addEventListener('input', recompute));
  override.input.addEventListener('change', recompute);

  const fill = button('Refund everything remaining', () => {
    sub.input.value = centsToDecimal(rem.subtotal);
    ship.input.value = centsToDecimal(rem.shipping);
    tax.input.value = centsToDecimal(rem.tax);
    recompute();
  }, { small: true });

  add(form,
    h(
      'div',
      { class: 'span-6 note-box' },
      h('div', null, h('strong', null, `Original sale ${original.order_number || ''}`), ` · ${date(original.sale_date)} · ${original.customer_name || 'no customer'} · ${CHANNEL_LABEL[original.channel]}`),
      h('div', null, `Subtotal ${money(original.subtotal_cents)} · Shipping ${money(original.shipping_cents)} · Tax ${money(original.tax_cents)} · Total ${money(original.total_cents)}`),
      h('div', null, `Already refunded: ${money(rem.refunded_subtotal + rem.refunded_shipping + rem.refunded_tax)}${refund ? ' (not counting this refund)' : ''} · Left: ${money(remTotal)}`),
      original.is_custom ? h('div', { class: 'small', style: { marginTop: '4px', fontWeight: '600' } }, 'This was a custom job marked final sale.') : null,
    ),
    field({ label: 'Refund date', name: 'sale_date', type: 'date', value: v.sale_date, required: true }),
    h('div', { class: 'span-4 row', style: { alignItems: 'flex-end' } }, refund ? null : fill),
    sub,
    ship,
    tax,
    line,
    h('div', { class: 'span-6 row', style: { alignItems: 'flex-start', gap: '16px' } }, override, taxable),
    field({ label: 'Payment method', name: 'payment_method_id', type: 'select', value: v.payment_method_id, options: selectOptions(L.paymentMethods.filter((p) => p.active || p.id === v.payment_method_id), { blank: '—' }), span: 3 }),
    field({ label: 'Description', name: 'description', value: v.description, span: 3, placeholder: 'Refund' }),
    field({ label: 'Notes', name: 'notes', type: 'textarea', value: v.notes, span: 6 }),
    refund?.needs_review
      ? h('div', { class: 'span-6 banner' }, h('span', { class: 'banner-icon' }, '⚠'), h('div', { class: 'grow' }, refund.review_note), field({ label: 'Keep flagged', name: 'needs_review', type: 'checkbox', value: true, span: 1 }))
      : null,
  );
  if (refund) {
    // Show the override box ticked if the stored taxable credit isn't the automatic one.
    const stored = v.taxable;
    recompute();
    if (taxable.input.value !== stored) {
      override.input.checked = true;
      taxable.input.value = stored;
    }
  }
  recompute();

  const save = async () => {
    const values = formValues(form);
    if (!refund && original.is_custom) {
      const ok = await confirmDialog({ title: 'Refund a final-sale job?', message: 'This sale was a custom job marked final sale. Record a refund anyway?', confirmLabel: 'Record refund' });
      if (!ok) return false;
    }
    try {
      if (refund) await call('sales.update', { id: refund.id, ...values });
      else await call('refunds.create', { original_sale_id: original.id, ...values });
    } catch (e) {
      showFormError(form, e);
      return false;
    }
    toast(refund ? 'Refund updated.' : 'Refund recorded.', { type: 'success', timeout: 2500 });
    await onSaved?.();
  };
  const actions = [];
  if (refund) actions.push({ label: 'Delete', danger: true, left: true, onClick: () => deleteSale(refund, onSaved) });
  actions.push({ label: 'Cancel' }, { label: refund ? 'Save changes' : 'Record refund', primary: true, onClick: save });
  openModal({ title: refund ? 'Edit refund' : 'Record a refund', content: form, actions, wide: true });
}

// ---------------- list ----------------

export async function render(page, params, ctx) {
  const L = await lookups({ refresh: true });
  if (params.preset) filters.preset = params.preset;
  if (params.review) filters.review = true;
  if (params.search !== undefined) filters.search = params.search;
  const batch = params.batch || '';
  const customerId = params.customer || '';
  if (batch || customerId) filters.preset = 'all';
  const r0 = rangeFor(filters.preset, L.today, filters);
  if (filters.preset !== 'custom') Object.assign(filters, { from: r0.start, to: r0.end });

  const listBox = h('div');
  const refresh = async () => {
    const q = {
      from: filters.from || undefined,
      to: filters.to || undefined,
      channel: filters.channel,
      custom: filters.custom,
      kind: filters.kind,
      search: filters.search,
      needsReview: filters.review,
      importBatchId: batch || undefined,
      customerId: customerId || undefined,
    };
    const res = await call('sales.list', q);
    clear(listBox).append(renderTable(res, refresh));
    ctx.refreshSidebar();
  };

  const sel = (name, opts, label) => {
    const s = h('select', { 'aria-label': label }, opts.map(([v, l]) => h('option', { value: v }, l)));
    s.value = filters[name];
    s.addEventListener('change', () => {
      filters[name] = s.value;
      refresh();
    });
    return h('div', { class: 'field' }, h('label', null, label), s);
  };
  const search = h('input', { type: 'search', placeholder: 'Customer, order #, description…', value: filters.search, 'aria-label': 'Search sales' });
  search.addEventListener('input', debounce(() => {
    filters.search = search.value;
    refresh();
  }));
  const reviewToggle = h('input', { type: 'checkbox', checked: filters.review });
  reviewToggle.addEventListener('change', () => {
    filters.review = reviewToggle.checked;
    refresh();
  });

  const scopeNote = batch || customerId
    ? h('div', { class: 'banner info' }, h('span', { class: 'banner-icon' }, 'ℹ'), h('div', { class: 'grow' }, batch ? `Showing sales from Shopify import #${batch}.` : 'Showing one customer\'s sales.'), button('Show all sales', () => ctx.navigate('sales'), { small: true }))
    : null;

  add(page,
    pageHead(
      'Sales',
      'Sales and refunds. Click a row to edit it.',
      button('Import from Shopify', () => ctx.navigate('import')),
      button('+ New sale', () => openSaleForm({ onSaved: refresh }), { primary: true }),
    ),
    scopeNote,
    h(
      'div',
      { class: 'toolbar' },
      rangePicker({ value: filters, today: L.today, onChange: (r) => { Object.assign(filters, r); refresh(); } }),
      sel('channel', [['', 'All channels'], ['shopify', 'Shopify'], ['direct', 'Direct'], ['other', 'Other']], 'Channel'),
      sel('custom', [['', 'Custom and stock'], ['custom', 'Custom (final sale)'], ['stock', 'Stock items']], 'Type'),
      sel('kind', [['', 'Sales and refunds'], ['sale', 'Sales only'], ['refund', 'Refunds only']], 'Show'),
      h('div', { class: 'field' }, h('label', null, 'Search'), search),
      h('label', { class: 'check', style: { marginBottom: '7px' } }, reviewToggle, 'Flagged for review'),
    ),
    listBox,
  );
  await refresh();
  if (params.new) openSaleForm({ onSaved: refresh });
}

function renderTable(res, refresh) {
  const { rows, totals, truncated } = res;
  if (!rows.length) return h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, 'No sales match these filters.'));
  // Put refunds right under their original sale when both are listed.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childrenOf = new Map();
  const ordered = [];
  for (const r of rows) {
    if (r.kind === 'refund' && byId.has(r.original_sale_id)) {
      if (!childrenOf.has(r.original_sale_id)) childrenOf.set(r.original_sale_id, []);
      childrenOf.get(r.original_sale_id).push(r);
    }
  }
  for (const r of rows) {
    if (r.kind === 'refund' && byId.has(r.original_sale_id)) continue;
    ordered.push(r);
    for (const c of (childrenOf.get(r.id) || []).reverse()) ordered.push(c);
  }

  const tr = (r) => {
    const isRefund = r.kind === 'refund';
    const child = isRefund && byId.has(r.original_sale_id);
    const row = h(
      'tr',
      { class: ['clickable', child && 'child'], onclick: () => (isRefund ? openRefundForm({ refundId: r.id, onSaved: refresh }) : openSaleForm({ id: r.id, onSaved: refresh })) },
      h('td', { class: 'nowrap' }, date(r.sale_date)),
      h('td', { class: 'nowrap' }, isRefund ? h('span', { class: 'muted' }, `↳ Refund${child ? '' : ` of ${r.original_order_number || date(r.original_sale_date)}`}`) : r.order_number || h('span', { class: 'faint' }, '—'), h('span', { class: 'sub-line' }, CHANNEL_LABEL[r.channel])),
      h('td', null, r.customer_name || h('span', { class: 'faint' }, '—')),
      h('td', { class: 'desc', title: r.description }, r.description, ' ', r.is_custom && !isRefund ? h('span', { class: 'badge accent' }, 'Custom') : null, r.needs_review ? h('span', { class: 'badge warn', title: r.review_note }, 'Review') : null),
      moneyCell(r.subtotal_cents),
      moneyCell(r.shipping_cents),
      moneyCell(r.tax_cents),
      moneyCell(r.total_cents),
      h('td', { class: 'nowrap small' }, jurisdictionLabel(r.ship_state, r.ship_county, r.ship_locality)),
      h(
        'td',
        { class: 'actions-cell' },
        !isRefund ? button('Refund', () => openRefundForm({ saleId: r.id, onSaved: refresh }), { small: true, ghost: true, title: 'Record a refund' }) : null,
        button('Delete', () => deleteSale(r, refresh), { small: true, ghost: true, title: 'Delete (can be undone)' }),
      ),
    );
    return row;
  };

  return h(
    'div',
    null,
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'data' },
        h(
          'thead',
          null,
          h('tr', null, ['Date', 'Order #', 'Customer', 'Description'].map((t) => h('th', null, t)), ['Subtotal', 'Shipping', 'Sales tax', 'Total'].map((t) => h('th', { class: 'num' }, t)), h('th', null, 'Ship to'), h('th', null, '')),
        ),
        h('tbody', null, ordered.map(tr)),
        h(
          'tfoot',
          null,
          h('tr', null, h('td', { colspan: 4 }, `${plural(totals.count, 'record')} — totals`), moneyCell(totals.subtotal), moneyCell(totals.shipping), moneyCell(totals.tax), moneyCell(totals.total), h('td', { colspan: 2 }, h('span', { class: 'small muted' }, `Taxable ${money(totals.taxable)}`))),
        ),
      ),
    ),
    truncated ? h('div', { class: 'table-note' }, 'Showing the newest 5,000 records. Narrow the dates to see older ones.') : null,
  );
}
