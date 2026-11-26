import { FieldErrors, ConflictError } from './errors.js';
import { cleanText, requiredText, toId, mustGet, softDelete, restoreRow, likePattern } from './util.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function listCustomers(db, { search = '' } = {}) {
  const where = ['c.deleted_at IS NULL'];
  const params = {};
  if (search && search.trim()) {
    where.push("(c.name LIKE @q ESCAPE '\\' OR c.email LIKE @q ESCAPE '\\' OR c.phone LIKE @q ESCAPE '\\')");
    params.q = likePattern(search.trim());
  }
  return db
    .prepare(
      `SELECT c.*,
        (SELECT count(*) FROM sales s WHERE s.customer_id = c.id AND s.kind = 'sale' AND s.deleted_at IS NULL) AS sale_count,
        (SELECT coalesce(sum(s.subtotal_cents + s.shipping_cents), 0) FROM sales s WHERE s.customer_id = c.id AND s.deleted_at IS NULL) AS revenue_cents,
        (SELECT max(s.sale_date) FROM sales s WHERE s.customer_id = c.id AND s.deleted_at IS NULL) AS last_sale_date
       FROM customers c WHERE ${where.join(' AND ')}
       ORDER BY lower(c.name)`,
    )
    .all(params);
}

export function customerNames(db) {
  return db.prepare('SELECT id, name, email FROM customers WHERE deleted_at IS NULL ORDER BY lower(name)').all();
}

export function getCustomer(db, id) {
  return mustGet(db, 'SELECT * FROM customers WHERE id = ?', toId(id, 'Customer'), 'Customer not found.');
}

function normalizeCustomer(input) {
  const errs = new FieldErrors();
  const out = {
    name: errs.capture('name', () => requiredText(input.name, { label: 'Customer name', max: 120 })),
    email: errs.capture('email', () => cleanText(input.email, { label: 'Email', max: 200 }), ''),
    phone: errs.capture('phone', () => cleanText(input.phone, { label: 'Phone', max: 40 }), ''),
    address: errs.capture('address', () => cleanText(input.address, { label: 'Address', max: 500 }), ''),
    notes: errs.capture('notes', () => cleanText(input.notes, { label: 'Notes', max: 2000 }), ''),
  };
  if (out.email && !EMAIL_RE.test(out.email)) errs.add('email', 'That email address doesn\'t look right.');
  errs.throwIfAny();
  return {
    name: out.name,
    email: out.email || null,
    phone: out.phone || null,
    address: out.address || null,
    notes: out.notes || null,
  };
}

export function createCustomer(db, input, now) {
  const c = normalizeCustomer(input);
  const info = db
    .prepare(
      `INSERT INTO customers (name, email, phone, address, notes, created_at, updated_at)
       VALUES (@name, @email, @phone, @address, @notes, @now, @now)`,
    )
    .run({ ...c, now });
  return Number(info.lastInsertRowid);
}

export function updateCustomer(db, id, input, now) {
  id = toId(id, 'Customer');
  mustGet(db, 'SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL', id, 'Customer not found.');
  const c = normalizeCustomer(input);
  db.prepare(
    `UPDATE customers SET name = @name, email = @email, phone = @phone, address = @address, notes = @notes, updated_at = @now
     WHERE id = @id`,
  ).run({ ...c, now, id });
  return id;
}

export function deleteCustomer(db, id, now) {
  id = toId(id, 'Customer');
  const c = mustGet(db, 'SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL', id, 'Customer not found.');
  const n = db.prepare('SELECT count(*) AS n FROM sales WHERE customer_id = ? AND deleted_at IS NULL').get(id).n;
  if (n > 0) throw new ConflictError(`${c.name} has ${n} sale(s) on record, so they can't be deleted.`);
  return softDelete(db, 'customers', id, now, 'Customer');
}

export function restoreCustomer(db, id, now) {
  restoreRow(db, 'customers', toId(id, 'Customer'), now, 'Customer');
}

export function findCustomerByName(db, name) {
  return db.prepare('SELECT * FROM customers WHERE lower(name) = lower(?) AND deleted_at IS NULL ORDER BY id LIMIT 1').get(name);
}

export function findCustomerByEmail(db, email) {
  if (!email) return undefined;
  return db.prepare('SELECT * FROM customers WHERE lower(email) = lower(?) AND deleted_at IS NULL ORDER BY id LIMIT 1').get(email);
}

// Used by the sale form: a typed name matches an existing customer or creates one.
export function resolveCustomerByName(db, name, now) {
  const clean = cleanText(name, { label: 'Customer', max: 120 });
  if (!clean) return null;
  const existing = findCustomerByName(db, clean);
  if (existing) return existing.id;
  return createCustomer(db, { name: clean }, now);
}
