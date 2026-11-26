// Tax set-aside tracker. Two buckets, tracked per tax year:
//   income_tax — net profit × the set-aside percentage
//   sales_tax  — 100% of net sales tax collected (tax collected − tax refunded)
// Entry types:
//   deposit     — moved money into the tax savings account
//   withdrawal  — moved money back out (not for taxes) — reduces progress
//   tax_payment — paid a tax bill from the savings account — does NOT reduce
//                 progress toward the target, only the expected balance
import { FieldErrors, ValidationError } from './errors.js';
import { cleanText, toId, mustGet, softDelete, restoreRow } from './util.js';
import { validDateOrThrow } from './sales.js';
import { periodTotals } from './reports.js';
import { getSetting } from './settings.js';
import { yearRange } from '../shared/dates.js';
import { applyBasisPoints, parseMoney } from '../shared/money.js';

export const BUCKETS = { income_tax: 'Income tax', sales_tax: 'Sales tax' };
export const ENTRY_TYPES = {
  deposit: 'Moved into tax savings',
  withdrawal: 'Moved back out of tax savings',
  tax_payment: 'Paid tax from tax savings',
};

function checkYear(year) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2200) throw new ValidationError('Invalid tax year.');
  return y;
}

function bucketProgress(db, year, bucket) {
  const r = db
    .prepare(
      `SELECT
        coalesce(sum(CASE WHEN entry_type = 'deposit' THEN amount_cents ELSE 0 END), 0) AS deposits,
        coalesce(sum(CASE WHEN entry_type = 'withdrawal' THEN amount_cents ELSE 0 END), 0) AS withdrawals,
        coalesce(sum(CASE WHEN entry_type = 'tax_payment' THEN amount_cents ELSE 0 END), 0) AS tax_payments
       FROM set_aside_entries WHERE deleted_at IS NULL AND tax_year = ? AND bucket = ?`,
    )
    .get(year, bucket);
  const moved = r.deposits - r.withdrawals;
  return { ...r, moved, expected_balance: moved - r.tax_payments };
}

export function setAsideSummary(db, year) {
  year = checkYear(year);
  const range = yearRange(year);
  const totals = periodTotals(db, range.start, range.end);
  const bp = Number(getSetting(db, 'set_aside_bp'));

  const incomeTarget = totals.net_profit > 0 ? applyBasisPoints(totals.net_profit, bp) : 0;
  const salesTaxTarget = Math.max(0, totals.sales_tax);

  const income = { ...bucketProgress(db, year, 'income_tax'), basis_cents: totals.net_profit, basis_points: bp, target: incomeTarget };
  income.remaining = income.target - income.moved;
  const salesTax = { ...bucketProgress(db, year, 'sales_tax'), basis_cents: totals.sales_tax, target: salesTaxTarget };
  salesTax.remaining = salesTax.target - salesTax.moved;

  const combined = {
    target: income.target + salesTax.target,
    moved: income.moved + salesTax.moved,
    tax_payments: income.tax_payments + salesTax.tax_payments,
    expected_balance: income.expected_balance + salesTax.expected_balance,
  };
  // Positive = move this much more; negative = ahead by this much.
  combined.remaining = combined.target - combined.moved;
  return { year, income, salesTax, combined, totals };
}

export function listSetAsideEntries(db, year) {
  year = checkYear(year);
  return db
    .prepare('SELECT * FROM set_aside_entries WHERE deleted_at IS NULL AND tax_year = ? ORDER BY entry_date DESC, id DESC')
    .all(year);
}

function normalizeEntry(input) {
  const errs = new FieldErrors();
  const entry_date = errs.capture('entry_date', () => validDateOrThrow(input.entry_date, 'Date'));
  let tax_year = Number(String(input.tax_year ?? '').trim() || (entry_date ? entry_date.slice(0, 4) : NaN));
  if (!Number.isInteger(tax_year) || tax_year < 2000 || tax_year > 2200) {
    errs.add('tax_year', 'Tax year must be a 4-digit year.');
    tax_year = null;
  }
  const bucket = String(input.bucket ?? '');
  if (!BUCKETS[bucket]) errs.add('bucket', 'Choose income tax or sales tax.');
  const entry_type = String(input.entry_type ?? '');
  if (!ENTRY_TYPES[entry_type]) errs.add('entry_type', 'Choose what kind of entry this is.');
  const amount_cents = errs.capture('amount', () => parseMoney(input.amount, { allowNegative: false, label: 'Amount' }));
  if (amount_cents === 0) errs.add('amount', 'Amount must be more than $0.00.');
  const notes = errs.capture('notes', () => cleanText(input.notes, { label: 'Notes', max: 1000 }), '');
  errs.throwIfAny();
  return { entry_date, tax_year, bucket, entry_type, amount_cents, notes };
}

export function createSetAsideEntry(db, input, now) {
  const e = normalizeEntry(input);
  return Number(
    db
      .prepare(
        `INSERT INTO set_aside_entries (entry_date, tax_year, bucket, entry_type, amount_cents, notes, created_at, updated_at)
         VALUES (@entry_date, @tax_year, @bucket, @entry_type, @amount_cents, @notes, @now, @now)`,
      )
      .run({ ...e, now }).lastInsertRowid,
  );
}

export function updateSetAsideEntry(db, id, input, now) {
  id = toId(id, 'Entry');
  mustGet(db, 'SELECT id FROM set_aside_entries WHERE id = ? AND deleted_at IS NULL', id, 'Entry not found.');
  const e = normalizeEntry(input);
  db.prepare(
    `UPDATE set_aside_entries SET entry_date = @entry_date, tax_year = @tax_year, bucket = @bucket,
      entry_type = @entry_type, amount_cents = @amount_cents, notes = @notes, updated_at = @now WHERE id = @id`,
  ).run({ ...e, now, id });
  return id;
}

export function deleteSetAsideEntry(db, id, now) {
  return softDelete(db, 'set_aside_entries', toId(id, 'Entry'), now, 'Entry');
}

export function restoreSetAsideEntry(db, id, now) {
  restoreRow(db, 'set_aside_entries', toId(id, 'Entry'), now, 'Entry');
}
