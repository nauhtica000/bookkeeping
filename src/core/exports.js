// CSV exports. Money columns are plain decimals (1234.56) so spreadsheets
// treat them as numbers.
import { toCsv } from './csv.js';
import { listSales, CHANNEL_LABELS } from './sales.js';
import { listExpenses } from './expenses.js';
import { centsToDecimal } from '../shared/money.js';
import { jurisdictionLabel, stateName } from '../shared/geo.js';

const money = (header, key) => ({ header, numeric: true, get: (r) => centsToDecimal(r[key]) });

export function salesCsv(db, { from, to } = {}) {
  const { rows } = listSales(db, { from, to });
  rows.reverse(); // oldest first
  return toCsv(
    [
      { header: 'Date', key: 'sale_date' },
      { header: 'Type', get: (r) => (r.kind === 'refund' ? 'Refund' : 'Sale') },
      { header: 'Order/Invoice #', get: (r) => (r.kind === 'refund' ? r.original_order_number : r.order_number) },
      { header: 'Channel', get: (r) => CHANNEL_LABELS[r.channel] },
      { header: 'Customer', key: 'customer_name' },
      { header: 'Description', key: 'description' },
      { header: 'Custom (final sale)', get: (r) => (r.is_custom ? 'Yes' : 'No') },
      money('Subtotal', 'subtotal_cents'),
      money('Shipping', 'shipping_cents'),
      money('Sales tax', 'tax_cents'),
      money('Total', 'total_cents'),
      money('Taxable amount', 'taxable_cents'),
      { header: 'Ship-to state', key: 'ship_state' },
      { header: 'Ship-to county', key: 'ship_county' },
      { header: 'Locality', key: 'ship_locality' },
      { header: 'Payment method', key: 'payment_method_name' },
      { header: 'Notes', key: 'notes' },
      { header: 'Needs review', get: (r) => (r.needs_review ? r.review_note || 'Yes' : '') },
      { header: 'Record ID', numeric: true, key: 'id' },
      { header: 'Refund of record ID', numeric: true, key: 'original_sale_id' },
      { header: 'Created', key: 'created_at' },
      { header: 'Updated', key: 'updated_at' },
    ],
    rows,
  );
}

export function expensesCsv(db, { from, to } = {}) {
  const { rows } = listExpenses(db, { from, to });
  rows.reverse();
  const receipts = db.prepare('SELECT expense_id, rel_path FROM expense_receipts WHERE deleted_at IS NULL ORDER BY id').all();
  const byExpense = new Map();
  for (const r of receipts) {
    if (!byExpense.has(r.expense_id)) byExpense.set(r.expense_id, []);
    byExpense.get(r.expense_id).push(r.rel_path);
  }
  return toCsv(
    [
      { header: 'Date', key: 'expense_date' },
      { header: 'Vendor', key: 'vendor' },
      { header: 'Category', key: 'category_name' },
      { header: 'Schedule C line', key: 'schedule_c_line' },
      money('Amount', 'amount_cents'),
      { header: 'Payment method', key: 'payment_method_name' },
      { header: 'Paid with owner funds', get: (r) => (r.is_owner_funds ? 'Yes' : 'No') },
      { header: 'Notes', key: 'notes' },
      { header: 'Receipt files', get: (r) => (byExpense.get(r.id) || []).join(' | ') },
      { header: 'Record ID', numeric: true, key: 'id' },
      { header: 'Created', key: 'created_at' },
      { header: 'Updated', key: 'updated_at' },
    ],
    rows,
  );
}

export function taxReportCsv(report) {
  const rows = report.rows.map((r) => ({
    ...r,
    label: jurisdictionLabel(r.ship_state, r.ship_county, r.ship_locality),
    state_name: stateName(r.ship_state),
  }));
  const totalRow = (label, t) => ({ label, ship_state: '', state_name: '', ship_county: '', ship_locality: '', ...t });
  rows.push(totalRow('TOTAL — New York', report.totals.ny));
  rows.push(totalRow('TOTAL — outside New York', report.totals.outsideNy));
  rows.push(totalRow('TOTAL — all jurisdictions', report.totals.all));
  return toCsv(
    [
      { header: 'Period start', get: () => report.start },
      { header: 'Period end', get: () => report.end },
      { header: 'Jurisdiction', key: 'label' },
      { header: 'State', key: 'ship_state' },
      { header: 'County', key: 'ship_county' },
      { header: 'Locality', key: 'ship_locality' },
      money('Gross sales', 'gross_sales'),
      money('Refunds', 'refunds'),
      money('Net sales', 'net_sales'),
      money('Taxable sales', 'taxable'),
      money('Nontaxable sales', 'nontaxable'),
      money('Tax collected', 'tax_collected'),
      money('Tax refunded', 'tax_refunded'),
      money('Net tax', 'net_tax'),
      { header: 'Sales', numeric: true, key: 'sale_count' },
      { header: 'Refunds (count)', numeric: true, key: 'refund_count' },
      { header: 'Flagged for review', numeric: true, key: 'review_count' },
    ],
    rows,
  );
}
