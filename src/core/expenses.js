// Expenses and their receipt files. Receipt files are copied into
// <data folder>/receipts/YYYY/ and referenced by a relative path, so the whole
// data folder can be moved or restored as a unit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FieldErrors, ValidationError, NotFoundError, ConflictError } from './errors.js';
import { cleanText, requiredText, toId, toBool, likePattern, mustGet } from './util.js';
import { validDateOrThrow } from './sales.js';
import { parseMoney } from '../shared/money.js';

export const RECEIPT_TYPES = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};
export const MAX_RECEIPT_BYTES = 50 * 1024 * 1024;

const SELECT = `
  SELECT e.*, ec.name AS category_name, ec.schedule_c_line, pm.name AS payment_method_name,
    pm.is_owner_funds,
    (SELECT count(*) FROM expense_receipts r WHERE r.expense_id = e.id AND r.deleted_at IS NULL) AS receipt_count
  FROM expenses e
  JOIN expense_categories ec ON ec.id = e.category_id
  JOIN payment_methods pm ON pm.id = e.payment_method_id`;

function slug(s) {
  return (
    String(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'receipt'
  );
}

// Resolve a stored relative path inside the data folder, refusing anything
// that would escape it.
export function resolveDataPath(dataDir, relPath) {
  const root = path.resolve(dataDir);
  const abs = path.resolve(root, ...String(relPath).split('/'));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new ValidationError('Invalid file location.');
  return abs;
}

// Check a file the user picked, before copying anything.
export function checkReceiptSource(srcPath) {
  if (typeof srcPath !== 'string' || !srcPath) throw new ValidationError('No receipt file was given.');
  let st;
  try {
    st = fs.statSync(srcPath);
  } catch {
    throw new ValidationError(`Receipt file not found: ${srcPath}`);
  }
  if (!st.isFile()) throw new ValidationError(`Not a file: ${srcPath}`);
  const ext = path.extname(srcPath).toLowerCase();
  if (!RECEIPT_TYPES[ext]) {
    throw new ValidationError(`"${path.basename(srcPath)}" isn't a supported receipt type. Use PDF, JPG, PNG, GIF, WEBP, HEIC, or TIFF.`);
  }
  if (st.size > MAX_RECEIPT_BYTES) throw new ValidationError(`"${path.basename(srcPath)}" is larger than 50 MB.`);
  if (st.size === 0) throw new ValidationError(`"${path.basename(srcPath)}" is empty.`);
  return { ext, size: st.size };
}

// Copy a receipt into the data folder. Returns the metadata to store.
export function copyReceiptIntoDataFolder(db, dataDir, srcPath, expenseDate, vendor) {
  const { ext, size } = checkReceiptSource(srcPath);
  const buf = fs.readFileSync(srcPath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const year = expenseDate.slice(0, 4);
  const dir = resolveDataPath(dataDir, `receipts/${year}`);
  fs.mkdirSync(dir, { recursive: true });
  const base = `${expenseDate}_${slug(vendor)}_${sha256.slice(0, 8)}`;
  let name = `${base}${ext}`;
  let n = 2;
  const inDb = db.prepare('SELECT 1 FROM expense_receipts WHERE rel_path = ?');
  while (fs.existsSync(path.join(dir, name)) || inDb.get(`receipts/${year}/${name}`)) {
    name = `${base}-${n++}${ext}`;
  }
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, buf, { flag: 'wx' });
  // Read back and verify so a bad copy never goes unnoticed.
  const check = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  if (check !== sha256) {
    fs.rmSync(abs, { force: true });
    throw new Error(`Copying "${path.basename(srcPath)}" failed verification. Nothing was saved.`);
  }
  return {
    rel_path: `receipts/${year}/${name}`,
    abs_path: abs,
    original_name: path.basename(srcPath),
    mime: RECEIPT_TYPES[ext],
    size_bytes: size,
    sha256,
  };
}

function normalizeExpense(db, input, errs, existing) {
  const expense_date = errs.capture('expense_date', () => validDateOrThrow(input.expense_date, 'Date'));
  const vendor = errs.capture('vendor', () => requiredText(input.vendor, { label: 'Vendor', max: 120 }));
  const amount_cents = errs.capture('amount', () => parseMoney(input.amount, { label: 'Amount' }));
  if (amount_cents === 0) errs.add('amount', 'Amount can\'t be $0.00. (Use a negative amount for a vendor credit or return.)');
  const notes = errs.capture('notes', () => cleanText(input.notes, { label: 'Notes', max: 2000 }), '');
  const category_id = errs.capture('category_id', () => toId(input.category_id, 'Category'));
  if (category_id) {
    const c = db.prepare('SELECT active FROM expense_categories WHERE id = ? AND deleted_at IS NULL').get(category_id);
    if (!c) errs.add('category_id', 'Choose a category.');
    else if (!c.active && existing?.category_id !== category_id) errs.add('category_id', 'That category is archived.');
  }
  const payment_method_id = errs.capture('payment_method_id', () => toId(input.payment_method_id, 'Payment method'));
  if (payment_method_id) {
    const p = db.prepare('SELECT active FROM payment_methods WHERE id = ? AND deleted_at IS NULL').get(payment_method_id);
    if (!p) errs.add('payment_method_id', 'Choose a payment method.');
    else if (!p.active && existing?.payment_method_id !== payment_method_id) errs.add('payment_method_id', 'That payment method is archived.');
  }
  return { expense_date, vendor, amount_cents, notes, category_id, payment_method_id };
}

function attachReceipts(db, dataDir, expenseId, paths, expenseDate, vendor, now, copied) {
  const ins = db.prepare(
    `INSERT INTO expense_receipts (expense_id, rel_path, original_name, mime, size_bytes, sha256, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of paths) {
    const r = copyReceiptIntoDataFolder(db, dataDir, p, expenseDate, vendor);
    copied.push(r.abs_path);
    ins.run(expenseId, r.rel_path, r.original_name, r.mime, r.size_bytes, r.sha256, now, now);
  }
}

function receiptPathList(v) {
  if (!v) return [];
  if (!Array.isArray(v)) throw new ValidationError('Receipt list is invalid.');
  return v;
}

export function createExpense(db, dataDir, input, now) {
  const errs = new FieldErrors();
  const e = normalizeExpense(db, input, errs, null);
  const paths = receiptPathList(input.receipt_paths);
  for (const p of paths) errs.capture('receipts', () => checkReceiptSource(p));
  errs.throwIfAny();
  const copied = [];
  try {
    return db.transaction(() => {
      const id = Number(
        db
          .prepare(
            `INSERT INTO expenses (expense_date, vendor, category_id, amount_cents, payment_method_id, notes, created_at, updated_at)
             VALUES (@expense_date, @vendor, @category_id, @amount_cents, @payment_method_id, @notes, @now, @now)`,
          )
          .run({ ...e, now }).lastInsertRowid,
      );
      attachReceipts(db, dataDir, id, paths, e.expense_date, e.vendor, now, copied);
      return id;
    })();
  } catch (err) {
    for (const f of copied) fs.rmSync(f, { force: true });
    throw err;
  }
}

export function updateExpense(db, dataDir, id, input, now) {
  id = toId(id, 'Expense');
  const existing = mustGet(db, 'SELECT * FROM expenses WHERE id = ? AND deleted_at IS NULL', id, 'Expense not found.');
  const errs = new FieldErrors();
  const e = normalizeExpense(db, input, errs, existing);
  const paths = receiptPathList(input.add_receipt_paths);
  for (const p of paths) errs.capture('receipts', () => checkReceiptSource(p));
  const removeIds = (input.remove_receipt_ids || []).map((r) => toId(r, 'Receipt'));
  errs.throwIfAny();
  const copied = [];
  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE expenses SET expense_date = @expense_date, vendor = @vendor, category_id = @category_id,
          amount_cents = @amount_cents, payment_method_id = @payment_method_id, notes = @notes, updated_at = @now
         WHERE id = @id`,
      ).run({ ...e, now, id });
      for (const rid of removeIds) {
        const info = db
          .prepare('UPDATE expense_receipts SET deleted_at = ?, updated_at = ? WHERE id = ? AND expense_id = ? AND deleted_at IS NULL')
          .run(now, now, rid, id);
        if (info.changes === 0) throw new NotFoundError('A receipt to remove was not found.');
      }
      attachReceipts(db, dataDir, id, paths, e.expense_date, e.vendor, now, copied);
    })();
  } catch (err) {
    for (const f of copied) fs.rmSync(f, { force: true });
    throw err;
  }
  return id;
}

export function getExpense(db, id) {
  id = toId(id, 'Expense');
  const row = db.prepare(`${SELECT} WHERE e.id = ?`).get(id);
  if (!row) throw new NotFoundError('Expense not found.');
  row.receipts = db
    .prepare('SELECT * FROM expense_receipts WHERE expense_id = ? AND deleted_at IS NULL ORDER BY id')
    .all(id);
  return row;
}

export function deleteExpense(db, id, now) {
  id = toId(id, 'Expense');
  const info = db.prepare('UPDATE expenses SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, now, id);
  if (info.changes === 0) throw new NotFoundError('Expense not found (it may already be deleted).');
  return { id, deleted_at: now };
}

export function restoreExpense(db, id, now) {
  id = toId(id, 'Expense');
  const e = mustGet(db, 'SELECT * FROM expenses WHERE id = ?', id, 'Expense not found.');
  if (!e.deleted_at) throw new ValidationError('That expense is not in the Trash.');
  const cat = db.prepare('SELECT deleted_at FROM expense_categories WHERE id = ?').get(e.category_id);
  if (cat?.deleted_at) throw new ConflictError("This expense's category was deleted. Restore the category first.");
  const pm = db.prepare('SELECT deleted_at FROM payment_methods WHERE id = ?').get(e.payment_method_id);
  if (pm?.deleted_at) throw new ConflictError("This expense's payment method was deleted. Restore it first.");
  db.prepare('UPDATE expenses SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, id);
}

export function restoreReceipt(db, id, now) {
  id = toId(id, 'Receipt');
  const r = mustGet(db, 'SELECT * FROM expense_receipts WHERE id = ?', id, 'Receipt not found.');
  if (!r.deleted_at) throw new ValidationError('That receipt is not in the Trash.');
  const e = db.prepare('SELECT deleted_at FROM expenses WHERE id = ?').get(r.expense_id);
  if (e?.deleted_at) throw new ConflictError('Restore the expense first.');
  db.prepare('UPDATE expense_receipts SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, id);
}

export function receiptFilePath(db, dataDir, receiptId) {
  const r = mustGet(db, 'SELECT * FROM expense_receipts WHERE id = ?', toId(receiptId, 'Receipt'), 'Receipt not found.');
  const abs = resolveDataPath(dataDir, r.rel_path);
  if (!fs.existsSync(abs)) throw new NotFoundError(`The receipt file is missing from the data folder: ${r.rel_path}`);
  return abs;
}

export function listExpenses(db, filters = {}) {
  const where = ['e.deleted_at IS NULL'];
  const p = {};
  if (filters.from) {
    where.push('e.expense_date >= @from');
    p.from = filters.from;
  }
  if (filters.to) {
    where.push('e.expense_date <= @to');
    p.to = filters.to;
  }
  if (filters.categoryId) {
    where.push('e.category_id = @cat');
    p.cat = toId(filters.categoryId, 'Category');
  }
  if (filters.paymentMethodId) {
    where.push('e.payment_method_id = @pm');
    p.pm = toId(filters.paymentMethodId, 'Payment method');
  }
  if (toBool(filters.ownerFundsOnly)) where.push('pm.is_owner_funds = 1');
  if (toBool(filters.missingReceipt)) {
    where.push('NOT EXISTS (SELECT 1 FROM expense_receipts r WHERE r.expense_id = e.id AND r.deleted_at IS NULL)');
  }
  if (filters.search && String(filters.search).trim()) {
    where.push("(e.vendor LIKE @q ESCAPE '\\' OR e.notes LIKE @q ESCAPE '\\')");
    p.q = likePattern(String(filters.search).trim());
  }
  const limit = 5000;
  const rows = db
    .prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY e.expense_date DESC, e.id DESC LIMIT ${limit + 1}`)
    .all(p);
  const truncated = rows.length > limit;
  if (truncated) rows.pop();
  const totals = db
    .prepare(
      `SELECT count(*) AS count, coalesce(sum(e.amount_cents), 0) AS amount
       FROM expenses e JOIN payment_methods pm ON pm.id = e.payment_method_id WHERE ${where.join(' AND ')}`,
    )
    .get(p);
  return { rows, totals, truncated };
}

export function vendorSuggestions(db) {
  return db
    .prepare(
      `SELECT vendor AS v, max(expense_date) AS last FROM expenses WHERE deleted_at IS NULL
       GROUP BY lower(vendor) ORDER BY last DESC LIMIT 500`,
    )
    .all()
    .map((r) => r.v);
}

// For a vendor, suggest the category and payment method used most recently.
export function lastExpenseForVendor(db, vendor) {
  return db
    .prepare(
      `SELECT category_id, payment_method_id FROM expenses WHERE lower(vendor) = lower(?) AND deleted_at IS NULL
       ORDER BY expense_date DESC, id DESC LIMIT 1`,
    )
    .get(String(vendor || '').trim()) ?? null;
}
