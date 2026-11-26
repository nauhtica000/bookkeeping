import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBooks, saleInput } from './helpers.js';
import { parseCsv } from '../src/core/csv.js';
import { nySalesTaxQuarter } from '../src/shared/dates.js';

// Sep 1 – Nov 30, 2026 filing period.
const Q = nySalesTaxQuarter('2026-10-15');

function seed(b) {
  const ids = {};
  // Suffolk: two taxable sales (one with a partial refund in the same period).
  ids.suffolk1 = b.call('sales.create', saleInput({ sale_date: '2026-09-02', subtotal: '200.00', shipping: '15.00', tax: '18.54' }));
  ids.suffolk2 = b.call('sales.create', saleInput({ sale_date: '2026-11-30', subtotal: '50.00', shipping: '0', tax: '4.31' }));
  b.call('refunds.create', { original_sale_id: ids.suffolk1, sale_date: '2026-10-01', subtotal: '100.00', tax: '8.63' });
  // Nassau, exempt sale with a resale certificate (no tax, nothing taxable).
  b.call('sales.create', saleInput({ sale_date: '2026-10-10', ship_county: 'Nassau', subtotal: '300.00', shipping: '20.00', tax: '0' }));
  // Kings county inside NYC (locality set) vs. Kings with no locality: separate rows.
  b.call('sales.create', saleInput({ sale_date: '2026-10-11', ship_county: 'Kings', ship_locality: 'New York City', subtotal: '80.00', shipping: '8.00', tax: '7.81' }));
  b.call('sales.create', saleInput({ sale_date: '2026-10-12', ship_county: 'Kings', ship_locality: 'new york city', subtotal: '20.00', shipping: '0', tax: '1.78' }));
  b.call('sales.create', saleInput({ sale_date: '2026-10-12', ship_county: 'Kings', subtotal: '10.00', shipping: '0', tax: '0.89' }));
  // Partially taxable (override).
  b.call('sales.create', saleInput({ sale_date: '2026-10-13', ship_county: 'Erie', subtotal: '100.00', shipping: '0', tax: '4.38', taxable_override: true, taxable: '50.00' }));
  // Out of state: New Jersey (two spellings of the county group together) and outside the US.
  b.call('sales.create', saleInput({ sale_date: '2026-10-14', ship_state: 'NJ', ship_county: 'Bergen', subtotal: '40.00', tax: '0', shipping: '5.00' }));
  b.call('sales.create', saleInput({ sale_date: '2026-10-15', ship_state: 'NJ', ship_county: 'bergen', subtotal: '60.00', tax: '0', shipping: '0' }));
  b.call('sales.create', saleInput({ sale_date: '2026-10-16', ship_state: 'INTL', subtotal: '500.00', tax: '0', shipping: '75.00' }));
  // Outside the period: excluded.
  ids.august = b.call('sales.create', saleInput({ sale_date: '2026-08-31', subtotal: '999.00', tax: '86.16' }));
  b.call('sales.create', saleInput({ sale_date: '2026-12-01', subtotal: '999.00', tax: '86.16' }));
  // Refund this period of a sale made last period: credit lands here, in Suffolk.
  b.call('refunds.create', { original_sale_id: ids.august, sale_date: '2026-09-15', subtotal: '99.00', shipping: '10.00', tax: '9.40' });
  // Deleted sale: excluded.
  const del = b.call('sales.create', saleInput({ sale_date: '2026-10-20', subtotal: '777.00', tax: '67.02' }));
  b.call('sales.delete', { id: del });
  return ids;
}

const row = (report, state, county, locality = '') =>
  report.rows.find((r) => r.ship_state === state && r.ship_county.toLowerCase() === county.toLowerCase() && r.ship_locality.toLowerCase() === locality.toLowerCase());

test('tax report groups by state + county + locality for a NY quarter', () => {
  const b = makeBooks();
  seed(b);
  const r = b.call('reports.salesTax', { from: Q.start, to: Q.end });
  assert.ok(r.nyQuarter, 'recognized as a NY filing period');
  assert.equal(r.nyQuarter.due, '2026-12-21');

  const labels = r.rows.map((x) => [x.ship_state, x.ship_county, x.ship_locality].join('/'));
  // NY first, then other states, then outside the US.
  assert.deepEqual(labels, ['NY/Erie/', 'NY/Kings/', 'NY/Kings/New York City', 'NY/Nassau/', 'NY/Suffolk/', 'NJ/Bergen/', 'INTL//']);

  const suffolk = row(r, 'NY', 'Suffolk');
  // Sales: 215.00 + 50.00; refunds: −100.00 (Oct) and −109.00 (refund of the August sale)
  assert.equal(suffolk.gross_sales, 21500 + 5000);
  assert.equal(suffolk.refunds, -10000 - 10900);
  assert.equal(suffolk.net_sales, 26500 - 20900);
  assert.equal(suffolk.tax_collected, 1854 + 431);
  assert.equal(suffolk.tax_refunded, -863 - 940);
  assert.equal(suffolk.net_tax, 1854 + 431 - 863 - 940);
  // Taxable: 215 + 50 − 100 − (109 → the August sale was fully taxable, so 109)
  assert.equal(suffolk.taxable, 21500 + 5000 - 10000 - 10900);
  assert.equal(suffolk.nontaxable, suffolk.net_sales - suffolk.taxable);
  assert.equal(suffolk.sale_count, 2);
  assert.equal(suffolk.refund_count, 2);

  const nyc = row(r, 'NY', 'Kings', 'New York City');
  assert.equal(nyc.gross_sales, 8800 + 2000);
  assert.equal(nyc.tax_collected, 781 + 178);
  assert.equal(row(r, 'NY', 'Kings').tax_collected, 89);

  const nassau = row(r, 'NY', 'Nassau');
  assert.equal(nassau.taxable, 0);
  assert.equal(nassau.nontaxable, 32000);

  const erie = row(r, 'NY', 'Erie');
  assert.equal(erie.taxable, 5000);
  assert.equal(erie.nontaxable, 5000);

  const nj = row(r, 'NJ', 'Bergen');
  assert.equal(nj.gross_sales, 4500 + 6000);
  assert.equal(nj.sale_count, 2);

  // Totals add up.
  const sum = (rows, k) => rows.reduce((a, x) => a + x[k], 0);
  const nyRows = r.rows.filter((x) => x.ship_state === 'NY');
  for (const k of ['gross_sales', 'refunds', 'net_sales', 'taxable', 'nontaxable', 'tax_collected', 'tax_refunded', 'net_tax']) {
    assert.equal(r.totals.ny[k], sum(nyRows, k), `NY total ${k}`);
    assert.equal(r.totals.all[k], sum(r.rows, k), `grand total ${k}`);
    assert.equal(r.totals.all[k], r.totals.ny[k] + r.totals.outsideNy[k]);
  }
  assert.equal(r.totals.outsideNy.net_tax, 0);
  b.cleanup();
});

test('tax report for a custom range is not labeled as a NY quarter', () => {
  const b = makeBooks();
  seed(b);
  const r = b.call('reports.salesTax', { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(r.nyQuarter, null);
  assert.equal(row(r, 'NY', 'Suffolk').refunds, -10000);
  assert.throws(() => b.call('reports.salesTax', { from: '2026-10-31', to: '2026-10-01' }), /after the end/);
  assert.throws(() => b.call('reports.salesTax', { from: 'bad', to: '2026-10-01' }), /valid date range/);
  b.cleanup();
});

test('tax report CSV export matches the report', () => {
  const b = makeBooks();
  seed(b);
  const csv = b.internal.taxReportCsv({ from: Q.start, to: Q.end });
  const { records } = parseCsv(csv);
  const suffolk = records.find((x) => x.values.Jurisdiction === 'Suffolk County, NY').values;
  assert.equal(suffolk['Net tax'], ((1854 + 431 - 863 - 940) / 100).toFixed(2));
  assert.equal(suffolk['Refunds'], '-209.00');
  const total = records.find((x) => x.values.Jurisdiction === 'TOTAL — all jurisdictions');
  assert.ok(total);
  b.cleanup();
});

test('dashboard: revenue excludes sales tax; NY quarter tax shown separately', () => {
  const b = makeBooks({ today: '2026-11-25' });
  seed(b);
  b.call('expenses.create', {
    expense_date: '2026-11-03',
    vendor: 'Acme Plastics',
    category_id: b.cat('Materials'),
    amount: '125.00',
    payment_method_id: b.pm('Business credit card'),
  });
  const d = b.call('dashboard.get');
  // November: only the Nov 30 Suffolk sale (50.00, tax 4.31) and the expense.
  assert.equal(d.periods.month.revenue, 5000);
  assert.equal(d.periods.month.sales_tax, 431);
  assert.equal(d.periods.month.expenses, 12500);
  assert.equal(d.periods.month.net_profit, 5000 - 12500);
  // NY quarter (Sep–Nov) tax equals the report's net tax for the same period.
  const r = b.call('reports.salesTax', { from: Q.start, to: Q.end });
  assert.equal(d.periods.nyQuarter.sales_tax, r.totals.all.net_tax);
  // Chart months add up to the whole year's sales list totals.
  const chartRevenue = d.months.reduce((a, m) => a + m.revenue, 0);
  const t = b.call('sales.list', { from: '2026-01-01', to: '2026-12-31' }).totals;
  assert.equal(chartRevenue, t.subtotal + t.shipping);
  // YTD stops at today (Nov 25), so the Nov 30 sale is in the month but not YTD.
  assert.equal(d.periods.ytd.end, '2026-11-25');
  assert.equal(chartRevenue - d.periods.ytd.revenue, 5000 + 99900 + 1000);
  b.cleanup();
});
