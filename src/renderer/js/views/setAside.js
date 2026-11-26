import { h, clear, money, moneyCell, date } from '../dom.js';
import { call, lookups } from '../api.js';
import { pageHead, button, field, formValues, showFormError, openModal, undoToast, toast } from '../ui.js';
import { formatBasisPoints, centsToDecimal } from '../../../shared/money.js';

const BUCKET = { income_tax: 'Income tax', sales_tax: 'Sales tax' };
const TYPE = {
  deposit: 'Moved into tax savings',
  withdrawal: 'Moved back out',
  tax_payment: 'Paid tax from savings',
};

let selectedYear = null;

function remainingText(n) {
  if (n > 0) return `Move ${money(n)} more`;
  if (n < 0) return `Ahead by ${money(-n)}`;
  return 'On target';
}

function openEntryForm({ entry, year, preset = {}, onSaved }) {
  const v = entry
    ? { ...entry, amount: centsToDecimal(entry.amount_cents) }
    : { entry_date: preset.today, tax_year: year, bucket: preset.bucket || 'income_tax', entry_type: preset.entry_type || 'deposit', amount: preset.amount || '', notes: '' };
  const form = h(
    'form',
    { class: 'form-grid', onsubmit: (e) => e.preventDefault() },
    field({ label: 'Date', name: 'entry_date', type: 'date', value: v.entry_date, required: true }),
    field({ label: 'Tax year', name: 'tax_year', value: String(v.tax_year), required: true, help: 'e.g. a January deposit for last year' }),
    field({ label: 'Amount', name: 'amount', type: 'money', value: v.amount, required: true }),
    field({ label: 'For', name: 'bucket', type: 'select', value: v.bucket, span: 3, options: Object.entries(BUCKET).map(([value, label]) => ({ value, label })) }),
    field({ label: 'What happened', name: 'entry_type', type: 'select', value: v.entry_type, span: 3, options: Object.entries(TYPE).map(([value, label]) => ({ value, label })), help: '"Paid tax" records an IRS/NY payment made from the savings account' }),
    field({ label: 'Notes', name: 'notes', type: 'textarea', value: v.notes, span: 6 }),
  );
  const actions = [];
  if (entry) {
    actions.push({
      label: 'Delete',
      danger: true,
      left: true,
      onClick: async () => {
        await call('setAside.delete', { id: entry.id });
        undoToast('Entry deleted.', () => call('setAside.restore', { id: entry.id }), onSaved);
        await onSaved();
      },
    });
  }
  actions.push({ label: 'Cancel' }, {
    label: 'Save',
    primary: true,
    onClick: async () => {
      try {
        const values = formValues(form);
        if (entry) await call('setAside.update', { id: entry.id, ...values });
        else await call('setAside.create', values);
      } catch (e) {
        showFormError(form, e);
        return false;
      }
      toast('Saved.', { type: 'success', timeout: 2000 });
      await onSaved();
    },
  });
  openModal({ title: entry ? 'Edit set-aside entry' : 'Log a set-aside entry', content: form, actions });
}

export async function render(page, params, ctx) {
  const L = await lookups({ refresh: true });
  const thisYear = Number(L.today.slice(0, 4));
  selectedYear = Number(params.year) || selectedYear || thisYear;
  const body = h('div');

  const load = async () => {
    const [sum, entries] = await Promise.all([call('setAside.summary', { year: selectedYear }), call('setAside.list', { year: selectedYear })]);
    clear(body).append(renderBody(sum, entries, L, load));
  };

  const yearSel = h('select', { 'aria-label': 'Tax year' });
  for (let y = thisYear + 1; y >= thisYear - 6; y--) yearSel.append(h('option', { value: y }, String(y)));
  yearSel.value = String(selectedYear);
  yearSel.addEventListener('change', () => {
    selectedYear = Number(yearSel.value);
    load();
  });

  page.append(
    pageHead('Tax set-aside', 'How much to keep in the tax savings account, and what you have moved.', yearSel, button('+ Log entry', () => openEntryForm({ year: selectedYear, preset: { today: L.today }, onSaved: load }), { primary: true })),
    body,
  );
  await load();
}

function renderBody(sum, entries, L, reload) {
  const inc = sum.income;
  const st = sum.salesTax;
  const c = sum.combined;
  const quickMove = (bucket, remaining) =>
    remaining > 0 ? button(`Log ${money(remaining)} moved`, () => openEntryForm({ year: sum.year, preset: { today: L.today, bucket, amount: centsToDecimal(remaining) }, onSaved: reload }), { small: true }) : null;

  const bucketCard = (title, b, formula, bucket, extra) =>
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, title), h('div', { class: 'actions' }, quickMove(bucket, b.remaining))),
      h('div', { class: 'formula' }, formula),
      h(
        'div',
        { class: 'stat-rows' },
        h('div', { class: 'stat-row' }, h('span', { class: 'label' }, 'Target'), h('span', { class: 'value' }, money(b.target))),
        h('div', { class: 'stat-row' }, h('span', { class: 'label' }, 'Moved in (less moved back out)'), h('span', { class: 'value' }, money(b.moved))),
        h('div', { class: 'stat-row' }, h('span', { class: 'label' }, 'Paid from savings'), h('span', { class: 'value' }, money(b.tax_payments))),
        h('div', { class: 'stat-row' }, h('span', { class: 'label' }, h('strong', null, remainingText(b.remaining)))),
        extra,
      ),
    );

  const combined = h(
    'div',
    { class: 'card' },
    h('div', { class: 'muted small' }, `Combined for ${sum.year}`),
    h('div', { class: 'big-callout' }, remainingText(c.remaining)),
    h('div', { class: 'callout-sub' }, `Target ${money(c.target)} · moved ${money(c.moved)} · expected savings balance ${money(c.expected_balance)} (after ${money(c.tax_payments)} of tax paid from it)`),
  );

  const table = entries.length
    ? h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'data' },
          h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'For'), h('th', null, 'What happened'), h('th', { class: 'num' }, 'Amount'), h('th', null, 'Tax year'), h('th', null, 'Notes'))),
          h(
            'tbody',
            null,
            entries.map((e) =>
              h(
                'tr',
                { class: 'clickable', onclick: () => openEntryForm({ entry: e, year: sum.year, preset: { today: L.today }, onSaved: reload }) },
                h('td', null, date(e.entry_date)),
                h('td', null, BUCKET[e.bucket]),
                h('td', null, TYPE[e.entry_type]),
                moneyCell(e.entry_type === 'deposit' ? e.amount_cents : -e.amount_cents),
                h('td', null, String(e.tax_year)),
                h('td', { class: 'desc' }, e.notes),
              ),
            ),
          ),
        ),
      )
    : h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, `Nothing logged for ${sum.year} yet. When you move money to the tax savings account, log it here.`));

  return h(
    'div',
    null,
    combined,
    h(
      'div',
      { class: 'grid-2 section' },
      bucketCard('Income tax', inc, `Net profit ${money(inc.basis_cents)} × ${formatBasisPoints(inc.basis_points)}% = ${money(inc.target)}${inc.basis_cents <= 0 ? ' (no profit yet, so no target)' : ''}`, 'income_tax', h('div', { class: 'small faint', style: { marginTop: '6px' } }, 'Change the percentage in Settings.')),
      bucketCard('Sales tax', st, `Tax collected minus tax refunded = ${money(st.basis_cents)} (100% is owed to New York)`, 'sales_tax'),
    ),
    h('div', { class: 'section' }, h('h2', null, `Entries for ${sum.year}`), table),
    h('p', { class: 'small faint section' }, 'The income-tax target is a savings guide based on this year\'s net profit, not a tax calculation. Your CPA determines what you actually owe.'),
  );
}
