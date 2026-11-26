// Dashboard numbers and the sales tax report.
//
// Definitions (used everywhere):
//   Revenue    = subtotal + shipping charged, net of refunds (sales tax excluded)
//   Expenses   = sum of expense amounts dated in the period (cash basis)
//   Net profit = revenue − expenses
//   Sales tax  = tax collected minus tax refunded
import {
  monthRange,
  calendarQuarterRange,
  yearToDateRange,
  nySalesTaxQuarter,
  monthsOfYear,
  parseDate,
  isValidDate,
} from '../shared/dates.js';
import { ValidationError } from './errors.js';
import { OUTSIDE_US } from '../shared/geo.js';

export function periodTotals(db, start, end) {
  const s = db
    .prepare(
      `SELECT
        coalesce(sum(CASE WHEN kind = 'sale' THEN subtotal_cents + shipping_cents ELSE 0 END), 0) AS gross_revenue,
        coalesce(sum(CASE WHEN kind = 'refund' THEN subtotal_cents + shipping_cents ELSE 0 END), 0) AS refunds,
        coalesce(sum(subtotal_cents + shipping_cents), 0) AS revenue,
        coalesce(sum(tax_cents), 0) AS sales_tax,
        coalesce(sum(CASE WHEN kind = 'sale' THEN 1 ELSE 0 END), 0) AS sale_count
       FROM sales WHERE deleted_at IS NULL AND sale_date BETWEEN ? AND ?`,
    )
    .get(start, end);
  const e = db
    .prepare('SELECT coalesce(sum(amount_cents), 0) AS expenses FROM expenses WHERE deleted_at IS NULL AND expense_date BETWEEN ? AND ?')
    .get(start, end);
  return { start, end, ...s, expenses: e.expenses, net_profit: s.revenue - e.expenses };
}

export function monthlyTotals(db, year) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1900 || y > 2200) throw new ValidationError('Invalid year.');
  const sales = new Map(
    db
      .prepare(
        `SELECT substr(sale_date, 6, 2) AS m, sum(subtotal_cents + shipping_cents) AS revenue, sum(tax_cents) AS tax
         FROM sales WHERE deleted_at IS NULL AND sale_date BETWEEN ? AND ? GROUP BY m`,
      )
      .all(`${y}-01-01`, `${y}-12-31`)
      .map((r) => [Number(r.m), r]),
  );
  const exp = new Map(
    db
      .prepare(
        `SELECT substr(expense_date, 6, 2) AS m, sum(amount_cents) AS expenses
         FROM expenses WHERE deleted_at IS NULL AND expense_date BETWEEN ? AND ? GROUP BY m`,
      )
      .all(`${y}-01-01`, `${y}-12-31`)
      .map((r) => [Number(r.m), r]),
  );
  return monthsOfYear(y).map((mo) => {
    const revenue = sales.get(mo.month)?.revenue ?? 0;
    const expenses = exp.get(mo.month)?.expenses ?? 0;
    return { month: mo.month, label: mo.label, revenue, expenses, net_profit: revenue - expenses, sales_tax: sales.get(mo.month)?.tax ?? 0 };
  });
}

export function dataYears(db) {
  const r = db
    .prepare(
      `SELECT min(y) AS lo, max(y) AS hi FROM (
        SELECT CAST(substr(sale_date, 1, 4) AS INTEGER) AS y FROM sales WHERE deleted_at IS NULL
        UNION ALL SELECT CAST(substr(expense_date, 1, 4) AS INTEGER) FROM expenses WHERE deleted_at IS NULL)`,
    )
    .get();
  return { min: r.lo, max: r.hi };
}

export function dashboardPeriods(db, asOf) {
  const month = monthRange(asOf);
  const quarter = calendarQuarterRange(asOf);
  const ytd = yearToDateRange(asOf);
  const nyq = nySalesTaxQuarter(asOf);
  const m = periodTotals(db, month.start, month.end);
  const q = periodTotals(db, quarter.start, quarter.end);
  const y = periodTotals(db, ytd.start, ytd.end);
  const nyqTotals = periodTotals(db, nyq.start, nyq.end);
  return {
    asOf,
    month: { ...month, ...m },
    quarter: { ...quarter, ...q },
    ytd: { ...ytd, ...y },
    nyQuarter: { ...nyq, sales_tax: nyqTotals.sales_tax },
  };
}

function sortKey(row) {
  const group = row.ship_state === 'NY' ? 0 : row.ship_state === OUTSIDE_US ? 2 : 1;
  return [group, row.ship_state, row.ship_county.toLowerCase(), row.ship_locality.toLowerCase()];
}

function cmp(a, b) {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

const SUM_FIELDS = [
  'gross_sales', 'refunds', 'net_sales', 'taxable', 'nontaxable',
  'tax_collected', 'tax_refunded', 'net_tax', 'sale_count', 'refund_count', 'review_count',
];

function sumRows(rows) {
  const out = Object.fromEntries(SUM_FIELDS.map((f) => [f, 0]));
  for (const r of rows) for (const f of SUM_FIELDS) out[f] += r[f];
  return out;
}

// Sales tax report for a date range, one row per jurisdiction: state + county,
// split further by locality when a locality (e.g. a NY city with its own
// rate) is set. All amounts in cents. Refunds appear in the period they were
// issued, as credits against the jurisdiction of the original sale.
export function salesTaxReport(db, start, end) {
  if (!isValidDate(start) || !isValidDate(end)) throw new ValidationError('Choose a valid date range.');
  if (start > end) throw new ValidationError('The start date is after the end date.');
  const rows = db
    .prepare(
      `SELECT ship_state,
        min(ship_county) AS ship_county,
        min(ship_locality) AS ship_locality,
        coalesce(sum(CASE WHEN kind = 'sale' THEN subtotal_cents + shipping_cents ELSE 0 END), 0) AS gross_sales,
        coalesce(sum(CASE WHEN kind = 'refund' THEN subtotal_cents + shipping_cents ELSE 0 END), 0) AS refunds,
        coalesce(sum(subtotal_cents + shipping_cents), 0) AS net_sales,
        coalesce(sum(taxable_cents), 0) AS taxable,
        coalesce(sum(CASE WHEN kind = 'sale' THEN tax_cents ELSE 0 END), 0) AS tax_collected,
        coalesce(sum(CASE WHEN kind = 'refund' THEN tax_cents ELSE 0 END), 0) AS tax_refunded,
        coalesce(sum(tax_cents), 0) AS net_tax,
        coalesce(sum(CASE WHEN kind = 'sale' THEN 1 ELSE 0 END), 0) AS sale_count,
        coalesce(sum(CASE WHEN kind = 'refund' THEN 1 ELSE 0 END), 0) AS refund_count,
        coalesce(sum(needs_review), 0) AS review_count
       FROM sales
       WHERE deleted_at IS NULL AND sale_date BETWEEN ? AND ?
       GROUP BY ship_state, lower(ship_county), lower(ship_locality)`,
    )
    .all(start, end)
    .map((r) => ({ ...r, nontaxable: r.net_sales - r.taxable }))
    .sort(cmp);

  const ny = rows.filter((r) => r.ship_state === 'NY');
  const other = rows.filter((r) => r.ship_state !== 'NY');
  const range = { start, end };
  const nyQ = nySalesTaxQuarter(start);
  const matchesNyQuarter = nyQ.start === start && nyQ.end === end;
  return {
    ...range,
    nyQuarter: matchesNyQuarter ? nyQ : null,
    rows,
    totals: { ny: sumRows(ny), outsideNy: sumRows(other), all: sumRows(rows) },
  };
}

export function yearOf(dateStr) {
  return parseDate(dateStr).y;
}
