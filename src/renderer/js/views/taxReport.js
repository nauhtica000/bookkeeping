import { h, clear, money, moneyCell, plural } from '../dom.js';
import { call, lookups } from '../api.js';
import { pageHead, button, toast } from '../ui.js';
import { recentNySalesTaxQuarters, nySalesTaxQuarter, formatDateLong, isValidDate } from '../../../shared/dates.js';
import { jurisdictionLabel } from '../../../shared/geo.js';

const COLS = [
  ['gross_sales', 'Gross sales'],
  ['refunds', 'Refunds'],
  ['net_sales', 'Net sales'],
  ['taxable', 'Taxable sales'],
  ['nontaxable', 'Nontaxable sales'],
  ['tax_collected', 'Tax collected'],
  ['tax_refunded', 'Tax refunded'],
  ['net_tax', 'Net tax'],
];

let last = null;

export async function render(page, params, ctx) {
  const L = await lookups();
  const quarters = recentNySalesTaxQuarters(L.today, 16);
  let from = params.from || last?.from || quarters[0].start;
  let to = params.to || last?.to || quarters[0].end;
  if (!isValidDate(from) || !isValidDate(to)) {
    from = quarters[0].start;
    to = quarters[0].end;
  }

  const body = h('div');
  const periodSel = h('select', { 'aria-label': 'Filing period' });
  quarters.forEach((q, i) => periodSel.append(h('option', { value: `${q.start}|${q.end}` }, `${q.label}${i === 0 ? ' (current)' : ''}`)));
  periodSel.append(h('option', { value: 'custom' }, 'Custom date range…'));
  const fromIn = h('input', { type: 'date', value: from, 'aria-label': 'From' });
  const toIn = h('input', { type: 'date', value: to, 'aria-label': 'To' });
  const custom = h('div', { class: 'row tight' }, fromIn, h('span', { class: 'muted' }, 'to'), toIn);
  const match = quarters.find((q) => q.start === from && q.end === to);
  periodSel.value = match ? `${from}|${to}` : 'custom';
  custom.classList.toggle('hidden', !!match);

  const load = async () => {
    last = { from, to };
    let report;
    try {
      report = await call('reports.salesTax', { from, to });
    } catch (e) {
      clear(body).append(h('div', { class: 'banner error' }, h('span', { class: 'banner-icon' }, '!'), h('div', null, e.message)));
      return;
    }
    clear(body).append(renderReport(report, ctx));
  };
  periodSel.addEventListener('change', () => {
    if (periodSel.value === 'custom') {
      custom.classList.remove('hidden');
      return;
    }
    custom.classList.add('hidden');
    [from, to] = periodSel.value.split('|');
    fromIn.value = from;
    toIn.value = to;
    load();
  });
  const onDates = () => {
    if (!isValidDate(fromIn.value) || !isValidDate(toIn.value)) return;
    from = fromIn.value;
    to = toIn.value;
    load();
  };
  fromIn.addEventListener('change', onDates);
  toIn.addEventListener('change', onDates);

  page.append(
    pageHead(
      'Sales tax report',
      "Taxable sales and tax collected per jurisdiction. Rates aren't stored — these are the amounts you recorded.",
      button('Print', () => call('app.print')),
      button('Export CSV', async () => {
        const r = await call('app.exportCsv', { kind: 'taxReport', from, to });
        if (!r.canceled) toast(`Saved ${r.path}`, { type: 'success', actionLabel: 'Show', onAction: () => call('app.showFile', { path: r.path }) });
      }, { primary: true }),
    ),
    h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', null, 'NY filing period'), h('div', { class: 'row tight' }, periodSel, custom))),
    body,
  );
  await load();
}

function renderReport(r, ctx) {
  const nyq = r.nyQuarter;
  const head = h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'row' },
      h('div', null, h('h2', { style: { margin: 0 } }, `${formatDateLong(r.start)} – ${formatDateLong(r.end)}`), h('div', { class: 'muted small' }, nyq ? `NY quarterly sales tax period · ${nyq.dueNote}` : 'Custom date range (not a NY filing period)')),
      h('div', { class: 'spacer' }),
      h('div', { class: 'num' }, h('div', { class: 'muted small' }, 'Net New York tax'), h('div', { class: 'stat-hero' }, money(r.totals.ny.net_tax))),
    ),
  );
  const reviews = r.totals.all.review_count;
  const banner = reviews
    ? h(
        'div',
        { class: 'banner section' },
        h('span', { class: 'banner-icon' }, '⚠'),
        h('div', { class: 'grow' }, `${plural(reviews, 'record')} in this period ${reviews === 1 ? 'is' : 'are'} flagged for review (usually estimated Shopify refund splits). Check ${reviews === 1 ? 'it' : 'them'} before filing.`),
        button('Review', () => ctx.navigate('sales', { review: '1', preset: 'all' }), { small: true }),
      )
    : null;

  if (!r.rows.length) {
    return h('div', null, head, h('div', { class: 'table-wrap section' }, h('div', { class: 'empty' }, 'No sales or refunds in this period.')));
  }
  const rowEl = (label, t, cls) =>
    h('tr', { class: cls }, h('td', null, label), h('td', { class: 'num' }, cls ? '' : `${t.sale_count}${t.refund_count ? ` / ${t.refund_count}` : ''}`), COLS.map(([k]) => moneyCell(t[k])));
  const ny = r.rows.filter((x) => x.ship_state === 'NY');
  const other = r.rows.filter((x) => x.ship_state !== 'NY');
  const tbody = h('tbody');
  ny.forEach((x) => tbody.append(rowEl(jurisdictionLabel(x.ship_state, x.ship_county, x.ship_locality), x)));
  if (ny.length) tbody.append(rowEl('New York total', r.totals.ny, 'subtotal'));
  other.forEach((x) => tbody.append(rowEl(jurisdictionLabel(x.ship_state, x.ship_county, x.ship_locality), x)));
  if (other.length) tbody.append(rowEl('Outside New York total', r.totals.outsideNy, 'subtotal'));
  tbody.append(rowEl('All jurisdictions', r.totals.all, 'grand'));

  return h(
    'div',
    null,
    head,
    banner,
    h(
      'div',
      { class: 'table-wrap section' },
      h(
        'table',
        { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'Jurisdiction'), h('th', { class: 'num', title: 'Sales / refunds' }, 'Sales / refunds'), COLS.map(([, l]) => h('th', { class: 'num' }, l)))),
        tbody,
      ),
    ),
    h(
      'div',
      { class: 'note-box section' },
      h('div', null, 'Gross and net sales include shipping charged. Taxable sales are what you marked taxable on each sale (by default subtotal + shipping when tax was collected). Refunds count in the period they were issued, as credits to the original sale\'s jurisdiction.'),
      h('div', { style: { marginTop: '6px' } }, 'Rows split by city/locality only when one was entered (for example New York City). Compare these totals with your NY return (ST-100 / ST-101) before filing.'),
    ),
  );
}

export { nySalesTaxQuarter };
