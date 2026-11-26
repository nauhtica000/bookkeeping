// Sales and refunds. A refund is a row in `sales` with kind = 'refund',
// negative amounts, and original_sale_id pointing at the sale it refunds.
import { FieldErrors, ValidationError, ConflictError, NotFoundError } from './errors.js';
import { cleanText, toBool, toId, optionalId, likePattern } from './util.js';
import { resolveCustomerByName } from './customers.js';
import { parseMoney, parseMoneyOrZero, scaleCents, formatMoney } from '../shared/money.js';
import { isValidDate, formatDateLong } from '../shared/dates.js';
import { isValidStateCode, normalizeNyCounty, OUTSIDE_US } from '../shared/geo.js';

export const CHANNELS = ['shopify', 'direct', 'other'];
export const CHANNEL_LABELS = { shopify: 'Shopify', direct: 'Direct', other: 'Other' };

const SELECT = `
  SELECT s.*, c.name AS customer_name, pm.name AS payment_method_name,
    o.order_number AS original_order_number, o.sale_date AS original_sale_date,
    o.description AS original_description
  FROM sales s
  LEFT JOIN customers c ON c.id = s.customer_id
  LEFT JOIN payment_methods pm ON pm.id = s.payment_method_id
  LEFT JOIN sales o ON o.id = s.original_sale_id`;

// The default "taxable" amount when the user doesn't override it:
// if tax was collected, the merchandise plus shipping (NY taxes shipping on
// taxable goods); if no tax was collected, nothing.
export function defaultTaxable(subtotal, shipping, tax) {
  return tax > 0 ? subtotal + shipping : 0;
}

export function validDateOrThrow(value, label = 'Date') {
  const s = String(value ?? '').trim();
  if (!s) throw new Error(`${label} is required.`);
  if (!isValidDate(s)) throw new Error(`${label} must be a real date (YYYY-MM-DD).`);
  if (s < '2000-01-01') throw new Error(`${label} is before 2000 — is that a typo?`);
  return s;
}

// Validate and normalize a tax jurisdiction. Returns
// { ship_state, ship_county, ship_locality }; records problems in `errs`.
export function normalizeJurisdiction(errs, state, county, locality) {
  const st = String(state ?? '').trim().toUpperCase();
  let co = '';
  let loc = '';
  if (!st) {
    errs.add('ship_state', 'Ship-to state is required (use your own state for pickups).');
  } else if (!isValidStateCode(st)) {
    errs.add('ship_state', `"${state}" is not a recognized state.`);
  }
  if (st !== OUTSIDE_US) {
    co = errs.capture('ship_county', () => cleanText(county, { label: 'County', max: 60 }), '');
    loc = errs.capture('ship_locality', () => cleanText(locality, { label: 'City / locality', max: 60 }), '');
    if (st === 'NY') {
      if (!co) errs.add('ship_county', 'County is required for New York sales.');
      else {
        const n = normalizeNyCounty(co);
        if (!n) errs.add('ship_county', `"${co}" is not a New York county.`);
        else co = n;
      }
    }
  }
  return { ship_state: st, ship_county: co, ship_locality: loc };
}

function paymentMethodOrThrow(db, errs, value) {
  const id = errs.capture('payment_method_id', () => optionalId(value, 'Payment method'));
  if (id) {
    const pm = db.prepare('SELECT id FROM payment_methods WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!pm) errs.add('payment_method_id', 'That payment method no longer exists.');
  }
  return id;
}

export function getSale(db, id) {
  const row = db.prepare(`${SELECT} WHERE s.id = ?`).get(toId(id, 'Sale'));
  if (!row) throw new NotFoundError('Sale not found.');
  return row;
}

function getActiveSale(db, id) {
  const row = getSale(db, id);
  if (row.deleted_at) throw new NotFoundError('That sale is in the Trash.');
  return row;
}

export function refundsOf(db, saleId, { includeDeleted = false } = {}) {
  return db
    .prepare(`${SELECT} WHERE s.original_sale_id = ? ${includeDeleted ? '' : 'AND s.deleted_at IS NULL'} ORDER BY s.sale_date, s.id`)
    .all(saleId);
}

// How much of a sale is still refundable (positive cents per component).
export function refundableRemaining(db, saleId, { excludeRefundId = null } = {}) {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale || sale.kind !== 'sale') throw new NotFoundError('Original sale not found.');
  const r = db
    .prepare(
      `SELECT coalesce(sum(subtotal_cents), 0) AS sub, coalesce(sum(shipping_cents), 0) AS ship,
              coalesce(sum(tax_cents), 0) AS tax, coalesce(sum(taxable_cents), 0) AS taxable
       FROM sales WHERE original_sale_id = ? AND kind = 'refund' AND deleted_at IS NULL AND id IS NOT ?`,
    )
    .get(saleId, excludeRefundId);
  return {
    subtotal: sale.subtotal_cents + r.sub,
    shipping: sale.shipping_cents + r.ship,
    tax: sale.tax_cents + r.tax,
    taxable: sale.taxable_cents + r.taxable,
    refunded_subtotal: -r.sub,
    refunded_shipping: -r.ship,
    refunded_tax: -r.tax,
    refunded_taxable: -r.taxable,
  };
}

// ---------------- Sales ----------------

function normalizeSaleInput(db, input, errs) {
  const sale_date = errs.capture('sale_date', () => validDateOrThrow(input.sale_date, 'Sale date'));
  const channel = String(input.channel ?? '').trim();
  if (!CHANNELS.includes(channel)) errs.add('channel', 'Choose a channel (Shopify, direct, or other).');
  const order_number = errs.capture('order_number', () => cleanText(input.order_number, { label: 'Order / invoice #', max: 50 }), '');
  const description = errs.capture('description', () => cleanText(input.description, { label: 'Description', max: 1000 }), '');
  const notes = errs.capture('notes', () => cleanText(input.notes, { label: 'Notes', max: 2000 }), '');
  const subtotal = errs.capture('subtotal', () => parseMoney(input.subtotal, { allowNegative: false, label: 'Subtotal' }));
  const shipping = errs.capture('shipping', () => parseMoneyOrZero(input.shipping, { allowNegative: false, label: 'Shipping' }));
  const tax = errs.capture('tax', () => parseMoneyOrZero(input.tax, { allowNegative: false, label: 'Sales tax' }));
  let taxable = null;
  if (subtotal !== null && shipping !== null && tax !== null) {
    if (subtotal + shipping + tax === 0) errs.add('subtotal', 'A sale needs an amount greater than $0.00.');
    if (toBool(input.taxable_override)) {
      taxable = errs.capture('taxable', () => parseMoney(input.taxable, { allowNegative: false, label: 'Taxable amount' }));
      if (taxable !== null && taxable > subtotal + shipping) {
        errs.add('taxable', `Taxable amount can't be more than subtotal + shipping (${formatMoney(subtotal + shipping)}).`);
      }
      if (taxable === 0 && tax > 0) errs.add('taxable', 'Sales tax was collected, so the taxable amount can\'t be $0.00.');
    } else {
      taxable = defaultTaxable(subtotal, shipping, tax);
    }
  }
  const j = normalizeJurisdiction(errs, input.ship_state, input.ship_county, input.ship_locality);
  const payment_method_id = paymentMethodOrThrow(db, errs, input.payment_method_id);
  let customer_name = null;
  let customer_id = null;
  if (input.customer_id) customer_id = errs.capture('customer_name', () => toId(input.customer_id, 'Customer'));
  else customer_name = errs.capture('customer_name', () => cleanText(input.customer_name, { label: 'Customer', max: 120 }), '');
  if (customer_id) {
    const c = db.prepare('SELECT id FROM customers WHERE id = ?').get(customer_id);
    if (!c) errs.add('customer_name', 'That customer no longer exists.');
  }
  return {
    sale_date,
    channel,
    order_number: order_number || null,
    description,
    notes,
    is_custom: toBool(input.is_custom) ? 1 : 0,
    subtotal_cents: subtotal,
    shipping_cents: shipping,
    tax_cents: tax,
    taxable_cents: taxable,
    ...j,
    payment_method_id,
    customer_id,
    customer_name,
  };
}

function checkOrderNumberFree(db, channel, orderNumber, excludeId, errs) {
  if (!orderNumber) return;
  const dup = db
    .prepare(
      `SELECT id, sale_date FROM sales WHERE kind = 'sale' AND channel = ? AND lower(order_number) = lower(?)
       AND deleted_at IS NULL AND id IS NOT ?`,
    )
    .get(channel, orderNumber, excludeId ?? null);
  if (dup) {
    errs.add('order_number', `Order # ${orderNumber} is already used by another sale (${formatDateLong(dup.sale_date)}).`);
  }
}

export function createSale(db, input, now, { importBatchId = null, needsReview = false, reviewNote = '' } = {}) {
  const errs = new FieldErrors();
  const s = normalizeSaleInput(db, input, errs);
  if (!errs.any) checkOrderNumberFree(db, s.channel, s.order_number, null, errs);
  errs.throwIfAny();
  return db.transaction(() => {
    const customer_id = s.customer_id ?? (s.customer_name ? resolveCustomerByName(db, s.customer_name, now) : null);
    const info = db
      .prepare(
        `INSERT INTO sales (kind, sale_date, customer_id, channel, order_number, description, is_custom,
          subtotal_cents, shipping_cents, tax_cents, taxable_cents, ship_state, ship_county, ship_locality,
          payment_method_id, notes, needs_review, review_note, import_batch_id, created_at, updated_at)
         VALUES ('sale', @sale_date, @customer_id, @channel, @order_number, @description, @is_custom,
          @subtotal_cents, @shipping_cents, @tax_cents, @taxable_cents, @ship_state, @ship_county, @ship_locality,
          @payment_method_id, @notes, @needs_review, @review_note, @import_batch_id, @now, @now)`,
      )
      .run({
        ...s,
        customer_id,
        needs_review: needsReview ? 1 : 0,
        review_note: reviewNote || '',
        import_batch_id: importBatchId,
        now,
      });
    return Number(info.lastInsertRowid);
  })();
}

export function updateSale(db, id, input, now) {
  const existing = getActiveSale(db, id);
  if (existing.kind === 'refund') return updateRefund(db, existing, input, now);
  const errs = new FieldErrors();
  const s = normalizeSaleInput(db, input, errs);
  if (!errs.any) {
    checkOrderNumberFree(db, s.channel, s.order_number, existing.id, errs);
    const rem = refundableRemaining(db, existing.id);
    const checks = [
      ['subtotal', s.subtotal_cents, rem.refunded_subtotal, 'subtotal'],
      ['shipping', s.shipping_cents, rem.refunded_shipping, 'shipping'],
      ['tax', s.tax_cents, rem.refunded_tax, 'sales tax'],
    ];
    for (const [field, value, refunded, label] of checks) {
      if (value < refunded) errs.add(field, `Already refunded ${formatMoney(refunded)} of ${label}; the sale can't be less than that.`);
    }
    if (s.taxable_cents < rem.refunded_taxable) {
      errs.add('taxable', `Refunds already credit ${formatMoney(rem.refunded_taxable)} of taxable sales; the taxable amount can't be less.`);
    }
    const firstRefund = db
      .prepare("SELECT min(sale_date) AS d FROM sales WHERE original_sale_id = ? AND deleted_at IS NULL")
      .get(existing.id).d;
    if (firstRefund && s.sale_date > firstRefund) {
      errs.add('sale_date', `This sale has a refund dated ${formatDateLong(firstRefund)}; the sale date can't be after it.`);
    }
  }
  errs.throwIfAny();
  const clearReview = input.needs_review !== undefined && !toBool(input.needs_review);
  db.transaction(() => {
    const customer_id = s.customer_id ?? (s.customer_name ? resolveCustomerByName(db, s.customer_name, now) : null);
    db.prepare(
      `UPDATE sales SET sale_date = @sale_date, customer_id = @customer_id, channel = @channel, order_number = @order_number,
        description = @description, is_custom = @is_custom, subtotal_cents = @subtotal_cents, shipping_cents = @shipping_cents,
        tax_cents = @tax_cents, taxable_cents = @taxable_cents, ship_state = @ship_state, ship_county = @ship_county,
        ship_locality = @ship_locality, payment_method_id = @payment_method_id, notes = @notes,
        needs_review = CASE WHEN @clear_review THEN 0 ELSE needs_review END,
        review_note = CASE WHEN @clear_review THEN '' ELSE review_note END,
        updated_at = @now
       WHERE id = @id`,
    ).run({ ...s, customer_id, clear_review: clearReview ? 1 : 0, now, id: existing.id });
    // Refunds always share the original's customer, channel, and jurisdiction.
    db.prepare(
      `UPDATE sales SET customer_id = ?, channel = ?, is_custom = ?, ship_state = ?, ship_county = ?, ship_locality = ?, updated_at = ?
       WHERE original_sale_id = ? AND (customer_id IS NOT ? OR channel <> ? OR is_custom <> ? OR ship_state <> ? OR ship_county <> ? OR ship_locality <> ?)`,
    ).run(
      customer_id, s.channel, s.is_custom, s.ship_state, s.ship_county, s.ship_locality, now, existing.id,
      customer_id, s.channel, s.is_custom, s.ship_state, s.ship_county, s.ship_locality,
    );
  })();
  return existing.id;
}

// ---------------- Refunds ----------------

// Refund form input uses positive amounts ("how much was refunded").
function normalizeRefundInput(db, original, input, errs, excludeRefundId) {
  const sale_date = errs.capture('sale_date', () => validDateOrThrow(input.sale_date, 'Refund date'));
  if (sale_date && sale_date < original.sale_date) {
    errs.add('sale_date', `A refund can't be dated before the sale (${formatDateLong(original.sale_date)}).`);
  }
  const sub = errs.capture('subtotal', () => parseMoneyOrZero(input.subtotal, { allowNegative: false, label: 'Subtotal refunded' }));
  const ship = errs.capture('shipping', () => parseMoneyOrZero(input.shipping, { allowNegative: false, label: 'Shipping refunded' }));
  const tax = errs.capture('tax', () => parseMoneyOrZero(input.tax, { allowNegative: false, label: 'Sales tax refunded' }));
  const description = errs.capture('description', () => cleanText(input.description, { label: 'Description', max: 1000 }), '');
  const notes = errs.capture('notes', () => cleanText(input.notes, { label: 'Notes', max: 2000 }), '');
  const payment_method_id = paymentMethodOrThrow(db, errs, input.payment_method_id ?? original.payment_method_id);
  let taxable = null;
  if (sub !== null && ship !== null && tax !== null) {
    const rem = refundableRemaining(db, original.id, { excludeRefundId });
    if (sub + ship + tax === 0) errs.add('subtotal', 'Enter how much was refunded.');
    if (sub > rem.subtotal) errs.add('subtotal', `Only ${formatMoney(rem.subtotal)} of the subtotal is left to refund.`);
    if (ship > rem.shipping) errs.add('shipping', `Only ${formatMoney(rem.shipping)} of shipping is left to refund.`);
    if (tax > rem.tax) errs.add('tax', `Only ${formatMoney(rem.tax)} of sales tax is left to refund.`);
    const maxTaxable = Math.min(sub + ship, rem.taxable);
    if (toBool(input.taxable_override)) {
      taxable = errs.capture('taxable', () => parseMoney(input.taxable, { allowNegative: false, label: 'Taxable amount refunded' }));
      if (taxable !== null && taxable > maxTaxable) {
        errs.add('taxable', `Taxable amount refunded can't be more than ${formatMoney(Math.max(0, maxTaxable))}.`);
      }
    } else {
      taxable = defaultRefundTaxable(original, sub, ship, tax, rem);
    }
  }
  return {
    sale_date,
    description: description || `Refund${original.order_number ? ` of ${original.order_number}` : ''}`,
    notes,
    payment_method_id,
    subtotal_cents: sub === null ? null : -sub,
    shipping_cents: ship === null ? null : -ship,
    tax_cents: tax === null ? null : -tax,
    taxable_cents: taxable === null ? null : -taxable,
  };
}

// Taxable portion of a refund, in proportion to how the original sale was taxed.
export function defaultRefundTaxable(original, sub, ship, tax, remaining) {
  const origBase = original.subtotal_cents + original.shipping_cents;
  if (original.taxable_cents === 0 || origBase === 0) return 0;
  // A refund that leaves nothing behind gets whatever taxable amount is left,
  // so rounding never strands a cent.
  if (sub === remaining.subtotal && ship === remaining.shipping && tax === remaining.tax) {
    return Math.max(0, remaining.taxable);
  }
  const t = scaleCents(original.taxable_cents, sub + ship, origBase);
  return Math.max(0, Math.min(t, sub + ship, remaining.taxable));
}

export function createRefund(db, input, now, { importBatchId = null, needsReview = false, reviewNote = '' } = {}) {
  const errs = new FieldErrors();
  const originalId = toId(input.original_sale_id, 'Original sale');
  const original = getActiveSale(db, originalId);
  if (original.kind !== 'sale') throw new ValidationError("You can't refund a refund — refund the original sale instead.");
  const r = normalizeRefundInput(db, original, input, errs, null);
  errs.throwIfAny();
  const info = db
    .prepare(
      `INSERT INTO sales (kind, original_sale_id, sale_date, customer_id, channel, order_number, description, is_custom,
        subtotal_cents, shipping_cents, tax_cents, taxable_cents, ship_state, ship_county, ship_locality,
        payment_method_id, notes, needs_review, review_note, import_batch_id, created_at, updated_at)
       VALUES ('refund', @original_sale_id, @sale_date, @customer_id, @channel, NULL, @description, @is_custom,
        @subtotal_cents, @shipping_cents, @tax_cents, @taxable_cents, @ship_state, @ship_county, @ship_locality,
        @payment_method_id, @notes, @needs_review, @review_note, @import_batch_id, @now, @now)`,
    )
    .run({
      ...r,
      original_sale_id: original.id,
      customer_id: original.customer_id,
      channel: original.channel,
      is_custom: original.is_custom,
      ship_state: original.ship_state,
      ship_county: original.ship_county,
      ship_locality: original.ship_locality,
      needs_review: needsReview ? 1 : 0,
      review_note: reviewNote || '',
      import_batch_id: importBatchId,
      now,
    });
  return Number(info.lastInsertRowid);
}

function updateRefund(db, existing, input, now) {
  const original = getActiveSale(db, existing.original_sale_id);
  const errs = new FieldErrors();
  const r = normalizeRefundInput(db, original, input, errs, existing.id);
  errs.throwIfAny();
  const clearReview = input.needs_review !== undefined && !toBool(input.needs_review);
  db.prepare(
    `UPDATE sales SET sale_date = @sale_date, description = @description, notes = @notes, payment_method_id = @payment_method_id,
      subtotal_cents = @subtotal_cents, shipping_cents = @shipping_cents, tax_cents = @tax_cents, taxable_cents = @taxable_cents,
      needs_review = CASE WHEN @clear_review THEN 0 ELSE needs_review END,
      review_note = CASE WHEN @clear_review THEN '' ELSE review_note END,
      updated_at = @now
     WHERE id = @id`,
  ).run({ ...r, clear_review: clearReview ? 1 : 0, now, id: existing.id });
  return existing.id;
}

// ---------------- Delete / restore ----------------

// Deleting a sale also deletes its refunds; they share one deleted_at stamp
// so a single Undo brings them all back.
export function deleteSale(db, id, now) {
  const s = getActiveSale(db, id);
  return db.transaction(() => {
    let count = 1;
    db.prepare('UPDATE sales SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, s.id);
    if (s.kind === 'sale') {
      count += db
        .prepare('UPDATE sales SET deleted_at = ?, updated_at = ? WHERE original_sale_id = ? AND deleted_at IS NULL')
        .run(now, now, s.id).changes;
    }
    return { id: s.id, kind: s.kind, count, deleted_at: now };
  })();
}

export function restoreSale(db, id, now) {
  const s = getSale(db, id);
  if (!s.deleted_at) throw new ValidationError('That sale is not in the Trash.');
  return db.transaction(() => {
    if (s.kind === 'refund') {
      const original = db.prepare('SELECT * FROM sales WHERE id = ?').get(s.original_sale_id);
      if (!original || original.deleted_at) throw new ConflictError('Restore the original sale first.');
      const rem = refundableRemaining(db, original.id);
      if (-s.subtotal_cents > rem.subtotal || -s.shipping_cents > rem.shipping || -s.tax_cents > rem.tax) {
        throw new ConflictError('Restoring this refund would refund more than the sale. Other refunds were recorded since it was deleted.');
      }
      db.prepare('UPDATE sales SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, s.id);
      return { count: 1 };
    }
    if (s.order_number) {
      const dup = db
        .prepare(
          `SELECT id FROM sales WHERE kind = 'sale' AND channel = ? AND lower(order_number) = lower(?) AND deleted_at IS NULL AND id <> ?`,
        )
        .get(s.channel, s.order_number, s.id);
      if (dup) throw new ConflictError(`Another sale already uses order # ${s.order_number}. Change or delete it first.`);
    }
    const stamp = s.deleted_at;
    db.prepare('UPDATE sales SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, s.id);
    const n = db
      .prepare('UPDATE sales SET deleted_at = NULL, updated_at = ? WHERE original_sale_id = ? AND deleted_at = ?')
      .run(now, s.id, stamp).changes;
    return { count: 1 + n };
  })();
}

export function markReviewed(db, id, now) {
  const s = getActiveSale(db, id);
  db.prepare("UPDATE sales SET needs_review = 0, review_note = '', updated_at = ? WHERE id = ?").run(now, s.id);
}

// ---------------- Listing ----------------

export function listSales(db, filters = {}) {
  const where = ['s.deleted_at IS NULL'];
  const p = {};
  if (filters.from) {
    where.push('s.sale_date >= @from');
    p.from = filters.from;
  }
  if (filters.to) {
    where.push('s.sale_date <= @to');
    p.to = filters.to;
  }
  if (filters.channel && CHANNELS.includes(filters.channel)) {
    where.push('s.channel = @channel');
    p.channel = filters.channel;
  }
  if (filters.custom === 'custom') where.push('s.is_custom = 1');
  if (filters.custom === 'stock') where.push('s.is_custom = 0');
  if (filters.kind === 'sale' || filters.kind === 'refund') {
    where.push('s.kind = @kind');
    p.kind = filters.kind;
  }
  if (filters.needsReview) where.push('s.needs_review = 1');
  if (filters.customerId) {
    where.push('s.customer_id = @customerId');
    p.customerId = toId(filters.customerId, 'Customer');
  }
  if (filters.importBatchId) {
    where.push('s.import_batch_id = @batch');
    p.batch = toId(filters.importBatchId, 'Import');
  }
  if (filters.search && String(filters.search).trim()) {
    where.push(
      `(c.name LIKE @q ESCAPE '\\' OR s.order_number LIKE @q ESCAPE '\\' OR o.order_number LIKE @q ESCAPE '\\'
        OR s.description LIKE @q ESCAPE '\\' OR s.notes LIKE @q ESCAPE '\\')`,
    );
    p.q = likePattern(String(filters.search).trim());
  }
  const limit = 5000;
  const rows = db
    .prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY s.sale_date DESC, s.id DESC LIMIT ${limit + 1}`)
    .all(p);
  const truncated = rows.length > limit;
  if (truncated) rows.pop();
  const totals = db
    .prepare(
      `SELECT count(*) AS count,
        coalesce(sum(s.subtotal_cents), 0) AS subtotal, coalesce(sum(s.shipping_cents), 0) AS shipping,
        coalesce(sum(s.tax_cents), 0) AS tax, coalesce(sum(s.taxable_cents), 0) AS taxable,
        coalesce(sum(s.total_cents), 0) AS total
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN sales o ON o.id = s.original_sale_id
       WHERE ${where.join(' AND ')}`,
    )
    .get(p);
  return { rows, totals, truncated };
}

export function localitySuggestions(db) {
  return db
    .prepare("SELECT DISTINCT ship_locality AS v FROM sales WHERE ship_locality <> '' AND deleted_at IS NULL ORDER BY 1")
    .all()
    .map((r) => r.v);
}

export function reviewCount(db) {
  return db.prepare('SELECT count(*) AS n FROM sales WHERE needs_review = 1 AND deleted_at IS NULL').get().n;
}
