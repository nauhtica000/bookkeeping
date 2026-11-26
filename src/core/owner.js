// Owner funds: expenses paid with a payment method flagged "owner funds"
// (e.g. "Personal funds") are money the owner put into the business. Logged
// reimbursements are the business paying the owner back. The difference is
// what the business still owes the owner.
import { FieldErrors, ValidationError } from './errors.js';
import { cleanText, toId, mustGet, softDelete, restoreRow } from './util.js';
import { validDateOrThrow } from './sales.js';
import { parseMoney, formatMoney } from '../shared/money.js';
import { yearRange } from '../shared/dates.js';

function contributions(db, start, end) {
  return db
    .prepare(
      `SELECT coalesce(sum(e.amount_cents), 0) AS total, count(*) AS count
       FROM expenses e JOIN payment_methods pm ON pm.id = e.payment_method_id
       WHERE e.deleted_at IS NULL AND pm.is_owner_funds = 1 AND e.expense_date BETWEEN ? AND ?`,
    )
    .get(start, end);
}

function reimbursements(db, start, end, excludeId = null) {
  return db
    .prepare(
      `SELECT coalesce(sum(amount_cents), 0) AS total, count(*) AS count FROM owner_reimbursements
       WHERE deleted_at IS NULL AND reimbursement_date BETWEEN ? AND ? AND id IS NOT ?`,
    )
    .get(start, end, excludeId);
}

const ALL = ['0000-01-01', '9999-12-31'];

export function ownerFundsSummary(db, year) {
  const y = yearRange(Number(year));
  const allC = contributions(db, ...ALL);
  const allR = reimbursements(db, ...ALL);
  const yC = contributions(db, y.start, y.end);
  const yR = reimbursements(db, y.start, y.end);
  return {
    year: Number(year),
    contributed_all: allC.total,
    contributed_count_all: allC.count,
    reimbursed_all: allR.total,
    owed_to_owner: allC.total - allR.total,
    contributed_year: yC.total,
    reimbursed_year: yR.total,
  };
}

export function listReimbursements(db) {
  return db
    .prepare('SELECT * FROM owner_reimbursements WHERE deleted_at IS NULL ORDER BY reimbursement_date DESC, id DESC')
    .all();
}

function normalize(db, input, excludeId) {
  const errs = new FieldErrors();
  const reimbursement_date = errs.capture('reimbursement_date', () => validDateOrThrow(input.reimbursement_date, 'Date'));
  const amount_cents = errs.capture('amount', () => parseMoney(input.amount, { allowNegative: false, label: 'Amount' }));
  if (amount_cents === 0) errs.add('amount', 'Amount must be more than $0.00.');
  const notes = errs.capture('notes', () => cleanText(input.notes, { label: 'Notes', max: 1000 }), '');
  errs.throwIfAny();
  const owed = contributions(db, ...ALL).total - reimbursements(db, ...ALL, excludeId).total;
  if (amount_cents > owed) {
    throw new ValidationError(
      `That's more than the business owes you (${formatMoney(Math.max(0, owed))}). Only record repayments of expenses you paid personally.`,
      { amount: 'More than the amount owed to you.' },
    );
  }
  return { reimbursement_date, amount_cents, notes };
}

export function createReimbursement(db, input, now) {
  const r = normalize(db, input, null);
  return Number(
    db
      .prepare(
        `INSERT INTO owner_reimbursements (reimbursement_date, amount_cents, notes, created_at, updated_at)
         VALUES (@reimbursement_date, @amount_cents, @notes, @now, @now)`,
      )
      .run({ ...r, now }).lastInsertRowid,
  );
}

export function updateReimbursement(db, id, input, now) {
  id = toId(id, 'Reimbursement');
  mustGet(db, 'SELECT id FROM owner_reimbursements WHERE id = ? AND deleted_at IS NULL', id, 'Reimbursement not found.');
  const r = normalize(db, input, id);
  db.prepare(
    `UPDATE owner_reimbursements SET reimbursement_date = @reimbursement_date, amount_cents = @amount_cents,
      notes = @notes, updated_at = @now WHERE id = @id`,
  ).run({ ...r, now, id });
  return id;
}

export function deleteReimbursement(db, id, now) {
  return softDelete(db, 'owner_reimbursements', toId(id, 'Reimbursement'), now, 'Reimbursement');
}

export function restoreReimbursement(db, id, now) {
  restoreRow(db, 'owner_reimbursements', toId(id, 'Reimbursement'), now, 'Reimbursement');
}
