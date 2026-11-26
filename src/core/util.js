import { ValidationError, NotFoundError } from './errors.js';

// Trim a text input. Returns '' for null/undefined. Rejects overly long text.
export function cleanText(value, { max = 500, label = 'Text' } = {}) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${label} must be text.`);
  const s = String(value).replace(/\r\n?/g, '\n').trim();
  if (s.length > max) throw new Error(`${label} is too long (max ${max} characters).`);
  return s;
}

export function requiredText(value, opts = {}) {
  const s = cleanText(value, opts);
  if (!s) throw new Error(`${opts.label || 'This field'} is required.`);
  return s;
}

export function toBool(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

export function toId(value, label = 'Record') {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (!Number.isSafeInteger(n) || n <= 0) throw new ValidationError(`${label} id is missing or invalid.`);
  return n;
}

export function optionalId(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return toId(value, label);
}

export function mustGet(db, sql, params, message) {
  const row = db.prepare(sql).get(params);
  if (!row) throw new NotFoundError(message);
  return row;
}

// Soft delete / restore for simple tables.
export function softDelete(db, table, id, now, label = 'Record') {
  const info = db.prepare(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(now, now, id);
  if (info.changes === 0) throw new NotFoundError(`${label} not found (it may already be deleted).`);
  return { deleted_at: now };
}

export function restoreRow(db, table, id, now, label = 'Record') {
  const info = db.prepare(`UPDATE ${table} SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL`).run(now, id);
  if (info.changes === 0) throw new NotFoundError(`${label} not found in the Trash.`);
}

// Escape a user search string for LIKE ... ESCAPE '\'
export function likePattern(s) {
  return `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
