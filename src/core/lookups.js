// Editable lookup lists: payment methods and expense categories.
import { FieldErrors, ValidationError, ConflictError } from './errors.js';
import { cleanText, requiredText, toBool, toId, mustGet, softDelete, restoreRow } from './util.js';

// ---------- Payment methods ----------

export function listPaymentMethods(db, { includeInactive = true } = {}) {
  return db
    .prepare(
      `SELECT pm.*,
        (SELECT count(*) FROM expenses e WHERE e.payment_method_id = pm.id AND e.deleted_at IS NULL) AS expense_count,
        (SELECT count(*) FROM sales s WHERE s.payment_method_id = pm.id AND s.deleted_at IS NULL) AS sale_count
       FROM payment_methods pm
       WHERE pm.deleted_at IS NULL ${includeInactive ? '' : 'AND pm.active = 1'}
       ORDER BY pm.sort_order, lower(pm.name)`,
    )
    .all();
}

function checkUniqueName(db, table, name, excludeId, label) {
  const row = db
    .prepare(`SELECT id FROM ${table} WHERE lower(name) = lower(?) AND deleted_at IS NULL AND id IS NOT ?`)
    .get(name, excludeId ?? null);
  if (row) throw new ValidationError(`There's already a ${label} called "${name}".`, { name: `Name already in use.` });
}

export function savePaymentMethod(db, input, now) {
  const errs = new FieldErrors();
  const name = errs.capture('name', () => requiredText(input.name, { label: 'Name', max: 60 }));
  errs.throwIfAny();
  const isOwner = toBool(input.is_owner_funds) ? 1 : 0;
  const active = input.active === undefined ? 1 : toBool(input.active) ? 1 : 0;
  return db.transaction(() => {
    if (input.id) {
      const id = toId(input.id, 'Payment method');
      mustGet(db, 'SELECT id FROM payment_methods WHERE id = ? AND deleted_at IS NULL', id, 'Payment method not found.');
      checkUniqueName(db, 'payment_methods', name, id, 'payment method');
      db.prepare('UPDATE payment_methods SET name = ?, is_owner_funds = ?, active = ?, updated_at = ? WHERE id = ?').run(
        name, isOwner, active, now, id,
      );
      return id;
    }
    checkUniqueName(db, 'payment_methods', name, null, 'payment method');
    const max = db.prepare('SELECT coalesce(max(sort_order), 0) AS m FROM payment_methods').get().m;
    return Number(
      db
        .prepare(
          'INSERT INTO payment_methods (name, is_owner_funds, sort_order, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(name, isOwner, max + 10, active, now, now).lastInsertRowid,
    );
  })();
}

export function deletePaymentMethod(db, id, now) {
  id = toId(id, 'Payment method');
  const pm = mustGet(db, 'SELECT * FROM payment_methods WHERE id = ? AND deleted_at IS NULL', id, 'Payment method not found.');
  const used =
    db.prepare('SELECT count(*) AS n FROM expenses WHERE payment_method_id = ? AND deleted_at IS NULL').get(id).n +
    db.prepare('SELECT count(*) AS n FROM sales WHERE payment_method_id = ? AND deleted_at IS NULL').get(id).n;
  if (used > 0) {
    throw new ConflictError(`"${pm.name}" is used by ${used} record(s). Archive it instead so it stops appearing in new entries.`);
  }
  return softDelete(db, 'payment_methods', id, now, 'Payment method');
}

export function restorePaymentMethod(db, id, now) {
  id = toId(id, 'Payment method');
  const pm = mustGet(db, 'SELECT * FROM payment_methods WHERE id = ?', id, 'Payment method not found.');
  checkUniqueName(db, 'payment_methods', pm.name, id, 'payment method');
  restoreRow(db, 'payment_methods', id, now, 'Payment method');
}

export function movePaymentMethod(db, id, direction, now) {
  return moveRow(db, 'payment_methods', toId(id, 'Payment method'), direction, now);
}

// ---------- Expense categories ----------

export function listCategories(db, { includeInactive = true } = {}) {
  return db
    .prepare(
      `SELECT ec.*,
        (SELECT count(*) FROM expenses e WHERE e.category_id = ec.id AND e.deleted_at IS NULL) AS expense_count
       FROM expense_categories ec
       WHERE ec.deleted_at IS NULL ${includeInactive ? '' : 'AND ec.active = 1'}
       ORDER BY ec.sort_order, lower(ec.name)`,
    )
    .all();
}

export function saveCategory(db, input, now) {
  const errs = new FieldErrors();
  const name = errs.capture('name', () => requiredText(input.name, { label: 'Category name', max: 80 }));
  const line = errs.capture('schedule_c_line', () => cleanText(input.schedule_c_line, { label: 'Schedule C line', max: 120 }), '');
  errs.throwIfAny();
  const active = input.active === undefined ? 1 : toBool(input.active) ? 1 : 0;
  return db.transaction(() => {
    if (input.id) {
      const id = toId(input.id, 'Category');
      mustGet(db, 'SELECT id FROM expense_categories WHERE id = ? AND deleted_at IS NULL', id, 'Category not found.');
      checkUniqueName(db, 'expense_categories', name, id, 'category');
      db.prepare('UPDATE expense_categories SET name = ?, schedule_c_line = ?, active = ?, updated_at = ? WHERE id = ?').run(
        name, line, active, now, id,
      );
      return id;
    }
    checkUniqueName(db, 'expense_categories', name, null, 'category');
    const max = db.prepare('SELECT coalesce(max(sort_order), 0) AS m FROM expense_categories').get().m;
    return Number(
      db
        .prepare(
          'INSERT INTO expense_categories (name, schedule_c_line, sort_order, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(name, line, max + 10, active, now, now).lastInsertRowid,
    );
  })();
}

export function deleteCategory(db, id, now) {
  id = toId(id, 'Category');
  const cat = mustGet(db, 'SELECT * FROM expense_categories WHERE id = ? AND deleted_at IS NULL', id, 'Category not found.');
  const used = db.prepare('SELECT count(*) AS n FROM expenses WHERE category_id = ? AND deleted_at IS NULL').get(id).n;
  if (used > 0) {
    throw new ConflictError(`"${cat.name}" is used by ${used} expense(s). Archive it instead, or move those expenses first.`);
  }
  return softDelete(db, 'expense_categories', id, now, 'Category');
}

export function restoreCategory(db, id, now) {
  id = toId(id, 'Category');
  const cat = mustGet(db, 'SELECT * FROM expense_categories WHERE id = ?', id, 'Category not found.');
  checkUniqueName(db, 'expense_categories', cat.name, id, 'category');
  restoreRow(db, 'expense_categories', id, now, 'Category');
}

export function moveCategory(db, id, direction, now) {
  return moveRow(db, 'expense_categories', toId(id, 'Category'), direction, now);
}

// Swap sort order with the neighbour above (-1) or below (+1).
function moveRow(db, table, id, direction, now) {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id, sort_order FROM ${table} WHERE deleted_at IS NULL ORDER BY sort_order, id`).all();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) throw new ValidationError('Item not found.');
    const j = idx + (direction < 0 ? -1 : 1);
    if (j < 0 || j >= rows.length) return;
    // Renumber everything to keep order values distinct, then swap.
    rows.forEach((r, i) => (r.sort_order = (i + 1) * 10));
    [rows[idx].sort_order, rows[j].sort_order] = [rows[j].sort_order, rows[idx].sort_order];
    const upd = db.prepare(`UPDATE ${table} SET sort_order = ?, updated_at = ? WHERE id = ?`);
    rows.forEach((r) => upd.run(r.sort_order, now, r.id));
  })();
}
