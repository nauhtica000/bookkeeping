// The Trash: everything that has been soft-deleted, and restoring it.
import { ValidationError } from './errors.js';
import { toId } from './util.js';
import { restoreSale } from './sales.js';
import { restoreExpense, restoreReceipt } from './expenses.js';
import { restoreCustomer } from './customers.js';
import { restoreSetAsideEntry } from './setAside.js';
import { restoreReimbursement } from './owner.js';
import { restoreCategory, restorePaymentMethod } from './lookups.js';
import { restoreImport } from './shopify.js';

export function listTrash(db) {
  return {
    sales: db
      .prepare(
        `SELECT s.id, s.kind, s.sale_date, s.order_number, s.total_cents, s.description, s.deleted_at, s.channel,
          c.name AS customer_name, o.order_number AS original_order_number, o.deleted_at AS original_deleted_at,
          s.import_batch_id, b.deleted_at AS batch_deleted_at
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN sales o ON o.id = s.original_sale_id
         LEFT JOIN import_batches b ON b.id = s.import_batch_id
         WHERE s.deleted_at IS NOT NULL
           -- refunds deleted together with their sale are restored with it
           AND NOT (s.kind = 'refund' AND o.deleted_at IS NOT NULL AND o.deleted_at = s.deleted_at)
           -- rows removed by "undo import" are restored with the import
           AND NOT (b.deleted_at IS NOT NULL AND b.deleted_at = s.deleted_at)
         ORDER BY s.deleted_at DESC LIMIT 1000`,
      )
      .all(),
    expenses: db
      .prepare(
        `SELECT e.id, e.expense_date, e.vendor, e.amount_cents, e.deleted_at, ec.name AS category_name
         FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
         WHERE e.deleted_at IS NOT NULL ORDER BY e.deleted_at DESC LIMIT 1000`,
      )
      .all(),
    receipts: db
      .prepare(
        `SELECT r.id, r.original_name, r.deleted_at, e.vendor, e.expense_date
         FROM expense_receipts r JOIN expenses e ON e.id = r.expense_id
         WHERE r.deleted_at IS NOT NULL AND e.deleted_at IS NULL ORDER BY r.deleted_at DESC LIMIT 1000`,
      )
      .all(),
    customers: db.prepare('SELECT id, name, email, deleted_at FROM customers WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all(),
    setAside: db
      .prepare('SELECT id, entry_date, tax_year, bucket, entry_type, amount_cents, deleted_at FROM set_aside_entries WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')
      .all(),
    reimbursements: db
      .prepare('SELECT id, reimbursement_date, amount_cents, notes, deleted_at FROM owner_reimbursements WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')
      .all(),
    categories: db.prepare('SELECT id, name, deleted_at FROM expense_categories WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all(),
    paymentMethods: db.prepare('SELECT id, name, deleted_at FROM payment_methods WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all(),
    imports: db.prepare('SELECT * FROM import_batches WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all(),
  };
}

const RESTORERS = {
  sale: restoreSale,
  expense: restoreExpense,
  receipt: restoreReceipt,
  customer: restoreCustomer,
  setAside: restoreSetAsideEntry,
  reimbursement: restoreReimbursement,
  category: restoreCategory,
  paymentMethod: restorePaymentMethod,
  import: (db, id, now) => restoreImport(db, toId(id, 'Import'), now),
};

export function restoreFromTrash(db, type, id, now) {
  const fn = RESTORERS[type];
  if (!fn) throw new ValidationError(`Unknown item type: ${type}`);
  return fn(db, id, now) ?? { ok: true };
}

export function trashCount(db) {
  const t = listTrash(db);
  return Object.values(t).reduce((a, list) => a + list.length, 0);
}
