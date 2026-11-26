import { h, add, money, formatTimestamp } from '../dom.js';
import { call } from '../api.js';
import { pageHead, button, showError } from '../ui.js';
import { monthlyChart } from '../chart.js';
import { formatDateLong } from '../../../shared/dates.js';
import { formatBasisPoints } from '../../../shared/money.js';

function statCard(title, hero, heroLabel, rows, { negative } = {}) {
  return h(
    'div',
    { class: 'card stat-card' },
    h('div', { class: 'stat-title' }, title),
    h('div', { class: ['stat-hero', negative && 'neg'] }, hero),
    h('div', { class: 'small muted' }, heroLabel),
    h(
      'div',
      { class: 'stat-rows' },
      rows.map(([label, value, neg]) => h('div', { class: 'stat-row' }, h('span', { class: 'label' }, label), h('span', { class: ['value', neg && 'neg'] }, value))),
    ),
  );
}

export async function render(page, params, ctx) {
  const chartYear = params.year ? Number(params.year) : undefined;
  const d = await call('dashboard.get', { chartYear });
  const status = ctx.status || (await call('app.status'));
  const p = d.periods;

  const banners = [];
  const lb = status.lastBackup;
  if (!status.backupFolder) {
    banners.push(
      h('div', { class: 'banner' }, h('span', { class: 'banner-icon' }, '⚠'), h('div', { class: 'grow' }, 'No backup folder is set. Automatic backups are only being kept on this computer.'), button('Set backup folder', () => ctx.navigate('backup'), { small: true })),
    );
  }
  if (lb && !lb.ok) {
    const errs = (lb.results || []).filter((r) => !r.ok).map((r) => r.error);
    banners.push(
      h('div', { class: 'banner error' }, h('span', { class: 'banner-icon' }, '!'), h('div', { class: 'grow' }, `The last backup (${formatTimestamp(lb.at)}) had a problem: ${errs.join('; ') || 'unknown error'}`), button('Back up now', () => ctx.navigate('backup'), { small: true })),
    );
  }
  if (d.reviewCount) {
    banners.push(
      h('div', { class: 'banner info' }, h('span', { class: 'banner-icon' }, 'ℹ'), h('div', { class: 'grow' }, `${d.reviewCount} imported record${d.reviewCount === 1 ? ' is' : 's are'} flagged for review (for example, estimated Shopify refund splits).`), button('Review', () => ctx.navigate('sales', { review: '1', preset: 'all' }), { small: true })),
    );
  }

  const nyq = p.nyQuarter;
  const cards = h(
    'div',
    { class: 'grid-4' },
    statCard('Revenue', money(p.ytd.revenue), 'Year to date', [
      [`This month (${p.month.label})`, money(p.month.revenue), p.month.revenue < 0],
      [`This quarter (${p.quarter.label.split(' (')[0]})`, money(p.quarter.revenue), p.quarter.revenue < 0],
    ]),
    statCard('Expenses', money(p.ytd.expenses), 'Year to date', [
      [`This month`, money(p.month.expenses)],
      [`This quarter`, money(p.quarter.expenses)],
    ]),
    statCard('Net profit', money(p.ytd.net_profit), 'Year to date', [
      [`This month`, money(p.month.net_profit), p.month.net_profit < 0],
      [`This quarter`, money(p.quarter.net_profit), p.quarter.net_profit < 0],
    ], { negative: p.ytd.net_profit < 0 }),
    statCard('Sales tax collected', money(p.ytd.sales_tax), 'Year to date (net of refunds)', [
      [`This month`, money(p.month.sales_tax)],
      [`NY period ${nyq.shortLabel}`, money(nyq.sales_tax)],
    ]),
  );

  const sa = d.setAside.combined;
  const setAsideCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, `Tax set-aside (${d.setAside.year})`), h('div', { class: 'actions' }, button('Open', () => ctx.navigate('setaside'), { small: true }))),
    h('div', { class: 'big-callout' }, sa.remaining > 0 ? `Move ${money(sa.remaining)} more` : sa.remaining < 0 ? `Ahead by ${money(-sa.remaining)}` : 'All caught up'),
    h('div', { class: 'callout-sub' }, 'to the tax savings account'),
    h(
      'div',
      { class: 'stat-rows' },
      h('div', { class: 'stat-row' }, h('span', { class: 'label' }, `Income tax (${formatBasisPoints(d.setAside.income.basis_points)}% of net profit)`), h('span', { class: 'value' }, `${money(d.setAside.income.moved)} of ${money(d.setAside.income.target)}`)),
      h('div', { class: 'stat-row' }, h('span', { class: 'label' }, 'Sales tax (100% of net collected)'), h('span', { class: 'value' }, `${money(d.setAside.salesTax.moved)} of ${money(d.setAside.salesTax.target)}`)),
    ),
  );
  const o = d.owner;
  const ownerCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Owed to owner'), h('div', { class: 'actions' }, button('Open', () => ctx.navigate('owner'), { small: true }))),
    h('div', { class: ['big-callout', o.owed_to_owner < 0 && 'neg'] }, money(o.owed_to_owner)),
    h('div', { class: 'callout-sub' }, 'running total of business expenses paid with personal funds, less reimbursements'),
    h(
      'div',
      { class: 'stat-rows' },
      h('div', { class: 'stat-row' }, h('span', { class: 'label' }, `Paid personally in ${o.year}`), h('span', { class: 'value' }, money(o.contributed_year))),
      h('div', { class: 'stat-row' }, h('span', { class: 'label' }, `Reimbursed in ${o.year}`), h('span', { class: 'value' }, money(o.reimbursed_year))),
    ),
  );

  const years = [];
  const lo = Math.min(d.years.min ?? d.chartYear, d.chartYear);
  const hi = Math.max(d.years.max ?? d.chartYear, Number(d.periods.asOf.slice(0, 4)));
  for (let yv = hi; yv >= lo; yv--) years.push(yv);
  const yearSel = h('select', { 'aria-label': 'Chart year', onchange: (e) => ctx.navigate('dashboard', { year: e.target.value }) }, years.map((yv) => h('option', { value: yv }, String(yv))));
  yearSel.value = String(d.chartYear);
  const chartCard = h(
    'div',
    { class: 'card section' },
    h('div', { class: 'card-head' }, h('h2', null, 'Revenue and expenses by month'), h('div', { class: 'actions' }, yearSel)),
    monthlyChart(d.months, { year: d.chartYear }),
  );

  add(page,
    pageHead('Dashboard', `As of ${formatDateLong(p.asOf)}`, button('+ Sale', () => ctx.navigate('sales', { new: '1' })), button('+ Expense', () => ctx.navigate('expenses', { new: '1' }), { primary: true })),
    ...banners,
    cards,
    h('div', { class: 'grid-2 section' }, setAsideCard, ownerCard),
    chartCard,
    h('p', { class: 'small faint section' }, `Revenue is subtotal + shipping charged, net of refunds; sales tax is not revenue. Expenses are counted when paid (equipment included in full — depreciation is your CPA's call). "This quarter" is the calendar quarter (${p.quarter.label.split('(')[1]?.replace(')', '') || ''}); the sales tax figure uses NY's filing period ${nyq.label}, ${nyq.dueNote.toLowerCase()}.`),
  );
}

export { showError };
