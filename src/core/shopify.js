// Shopify "Export orders" CSV import.
//
// Shopify writes one row per line item. Order-level columns (Subtotal,
// Shipping, Taxes, Total, addresses...) are filled in only on the order's
// first row. We group rows by the order "Name" (e.g. #1042), build a plan
// the user previews, then commit it in one transaction.
import crypto from 'node:crypto';
import { parseCsv } from './csv.js';
import { ValidationError } from './errors.js';
import { createSale, createRefund, refundableRemaining } from './sales.js';
import { createCustomer, findCustomerByEmail, findCustomerByName } from './customers.js';
import { getSetting, setSetting } from './settings.js';
import { parseMoney, parseMoneyOrZero, allocateProportionally, centsToDecimal, formatMoney, scaleCents } from '../shared/money.js';
import { parseLooseDate, todayLocal } from '../shared/dates.js';
import { normalizeState, normalizeNyCounty, OUTSIDE_US, NY_COUNTIES } from '../shared/geo.js';

export const SHOPIFY_FIELDS = [
  { key: 'order_number', label: 'Order number', defaults: ['Name'], required: true },
  { key: 'financial_status', label: 'Financial status', defaults: ['Financial Status'], required: true },
  { key: 'created_at', label: 'Order date (Created at)', defaults: ['Created at'], required: true },
  { key: 'paid_at', label: 'Paid at', defaults: ['Paid at'] },
  { key: 'cancelled_at', label: 'Cancelled at', defaults: ['Cancelled at'] },
  { key: 'subtotal', label: 'Subtotal', defaults: ['Subtotal'], required: true },
  { key: 'shipping', label: 'Shipping', defaults: ['Shipping'], required: true },
  { key: 'taxes', label: 'Taxes', defaults: ['Taxes'], required: true },
  { key: 'total', label: 'Total', defaults: ['Total'], required: true },
  { key: 'refunded_amount', label: 'Refunded amount', defaults: ['Refunded Amount'] },
  { key: 'currency', label: 'Currency', defaults: ['Currency'] },
  { key: 'payment_method', label: 'Payment method', defaults: ['Payment Method'] },
  { key: 'email', label: 'Customer email', defaults: ['Email'] },
  { key: 'lineitem_quantity', label: 'Line item quantity', defaults: ['Lineitem quantity'] },
  { key: 'lineitem_name', label: 'Line item name', defaults: ['Lineitem name'] },
  { key: 'lineitem_sku', label: 'Line item SKU', defaults: ['Lineitem sku'] },
  { key: 'billing_name', label: 'Billing name', defaults: ['Billing Name'] },
  { key: 'billing_address1', label: 'Billing address 1', defaults: ['Billing Address1', 'Billing Street'] },
  { key: 'billing_address2', label: 'Billing address 2', defaults: ['Billing Address2'] },
  { key: 'billing_city', label: 'Billing city', defaults: ['Billing City'] },
  { key: 'billing_province', label: 'Billing state', defaults: ['Billing Province'] },
  { key: 'billing_zip', label: 'Billing ZIP', defaults: ['Billing Zip'] },
  { key: 'billing_country', label: 'Billing country', defaults: ['Billing Country'] },
  { key: 'billing_phone', label: 'Billing phone', defaults: ['Billing Phone', 'Phone'] },
  { key: 'shipping_name', label: 'Ship-to name', defaults: ['Shipping Name'] },
  { key: 'shipping_city', label: 'Ship-to city', defaults: ['Shipping City'] },
  { key: 'shipping_province', label: 'Ship-to state', defaults: ['Shipping Province'] },
  { key: 'shipping_zip', label: 'Ship-to ZIP', defaults: ['Shipping Zip'] },
  { key: 'shipping_country', label: 'Ship-to country', defaults: ['Shipping Country'] },
  { key: 'notes', label: 'Order notes', defaults: ['Notes'] },
];

const IMPORTABLE_STATUSES = new Set(['paid', 'partially_refunded', 'refunded', 'partially_paid']);

export function autoMapping(headers, saved = null) {
  const lower = new Map(headers.map((h) => [h.trim().toLowerCase(), h]));
  const mapping = {};
  for (const f of SHOPIFY_FIELDS) {
    if (saved && saved[f.key] && headers.includes(saved[f.key])) {
      mapping[f.key] = saved[f.key];
      continue;
    }
    mapping[f.key] = null;
    for (const d of f.defaults) {
      const h = lower.get(d.toLowerCase());
      if (h) {
        mapping[f.key] = h;
        break;
      }
    }
  }
  return mapping;
}

export function validateMapping(mapping, headers) {
  const errors = [];
  const used = new Map();
  for (const f of SHOPIFY_FIELDS) {
    const h = mapping?.[f.key];
    if (!h) {
      if (f.required) errors.push(`"${f.label}" must be mapped to a column.`);
      continue;
    }
    if (!headers.includes(h)) errors.push(`Column "${h}" (for ${f.label}) isn't in this file.`);
    if (used.has(h)) errors.push(`Column "${h}" is mapped to both ${used.get(h)} and ${f.label}.`);
    used.set(h, f.label);
  }
  return errors;
}

function taxLineColumns(headers) {
  return headers.filter((h) => /^Tax \d+ Name$/i.test(h));
}

// Shopify writes ZIPs with a leading apostrophe ('02108) to keep zeros.
export function cleanZip(z) {
  const m = /(\d{5})/.exec(String(z ?? '').replace(/'/g, ''));
  return m ? m[1] : '';
}

// Look for a county or city in Shopify's tax line names, e.g.
// "NY State Tax 4.0%", "Suffolk County Tax 4.625%", "New York City Tax 4.5%".
export function jurisdictionFromTaxNames(names) {
  let county = null;
  let locality = null;
  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const cm = /^(.+?)\s+County\b/i.exec(name);
    if (cm && !county) {
      const c = normalizeNyCounty(cm[1]);
      if (c) county = c;
    }
    if (!/county/i.test(name)) {
      const lm = /^(.+?\bCity)\b/i.exec(name);
      if (lm && !locality && !/state/i.test(lm[1])) locality = lm[1].trim();
    }
  }
  return { county, locality };
}

function val(rec, mapping, key) {
  const h = mapping[key];
  if (!h) return '';
  return String(rec.values[h] ?? '').trim();
}

// Group CSV records into orders.
export function groupOrders(records, mapping, headers) {
  const taxCols = taxLineColumns(headers);
  const orders = new Map();
  const problems = [];
  for (const rec of records) {
    const num = val(rec, mapping, 'order_number');
    if (!num) {
      problems.push({ line: rec.line, message: 'Row has no order number; skipped.' });
      continue;
    }
    let o = orders.get(num);
    if (!o) {
      o = { orderNumber: num, first: rec, lines: [], rowLines: [] };
      orders.set(num, o);
    }
    o.rowLines.push(rec.line);
    const name = val(rec, mapping, 'lineitem_name');
    if (name) {
      o.lines.push({
        name,
        qty: val(rec, mapping, 'lineitem_quantity') || '1',
        sku: val(rec, mapping, 'lineitem_sku'),
      });
    }
    // Some exports repeat order-level values on later rows; keep the first
    // row that actually has a subtotal as the source of order-level fields.
    if (!val(o.first, mapping, 'subtotal') && val(rec, mapping, 'subtotal')) o.first = rec;
    o.taxNames = o.taxNames || [];
    for (const col of taxCols) {
      const t = String(rec.values[col] ?? '').trim();
      if (t && !o.taxNames.includes(t)) o.taxNames.push(t);
    }
  }
  return { orders: [...orders.values()], problems };
}

function matchPaymentMethod(db, raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return null;
  const methods = db.prepare('SELECT id, name FROM payment_methods WHERE deleted_at IS NULL').all();
  const byName = (n) => methods.find((m) => m.name.toLowerCase() === n.toLowerCase())?.id ?? null;
  if (s.includes('shopify')) return byName('Shopify Payments');
  if (s.includes('paypal')) return byName('PayPal');
  if (s.includes('cash')) return byName('Cash');
  const exact = methods.find((m) => s === m.name.toLowerCase());
  return exact?.id ?? null;
}

function findExistingShopifySale(db, orderNumber) {
  const active = db
    .prepare("SELECT * FROM sales WHERE kind = 'sale' AND channel = 'shopify' AND lower(order_number) = lower(?) AND deleted_at IS NULL")
    .get(orderNumber);
  if (active) return { active };
  const trashed = db
    .prepare(
      "SELECT * FROM sales WHERE kind = 'sale' AND channel = 'shopify' AND lower(order_number) = lower(?) AND deleted_at IS NOT NULL ORDER BY id DESC LIMIT 1",
    )
    .get(orderNumber);
  return { trashed };
}

function describeLines(lines) {
  const text = lines.map((l) => `${l.qty} × ${l.name}${l.sku ? ` (${l.sku})` : ''}`).join('; ');
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Build the import plan. `decisions` carries the user's choices from the
// preview: { counties: { zip: { county, locality } }, custom: { orderNumber: bool },
//            exclude: { orderNumber: bool }, includeTrashed: bool }
export function buildImportPlan(db, csvText, { mapping = null, decisions = {}, fileName = 'orders.csv', today = todayLocal() } = {}) {
  const { headers, records } = parseCsv(csvText);
  let saved = null;
  try {
    saved = JSON.parse(getSetting(db, 'shopify_mapping') || 'null');
  } catch {
    saved = null;
  }
  const map = mapping || autoMapping(headers, saved);
  const mappingErrors = validateMapping(map, headers);
  const fileSha256 = crypto.createHash('sha256').update(csvText).digest('hex');
  const base = {
    fileName,
    fileSha256,
    headers,
    mapping: map,
    decisions,
    mappingErrors,
    rowsRead: records.length,
    previousImport: db
      .prepare('SELECT id, created_at FROM import_batches WHERE file_sha256 = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(fileSha256) ?? null,
  };
  if (mappingErrors.length) return { ...base, ordersRead: 0, orders: [], problems: [], counts: {}, needsCountyZips: [], canCommit: false };

  const { orders: grouped, problems } = groupOrders(records, map, headers);
  const counties = decisions.counties || {};
  const custom = decisions.custom || {};
  const exclude = decisions.exclude || {};
  const defaultState = getSetting(db, 'default_state');
  const defaultCounty = getSetting(db, 'default_county');
  const defaultLocality = getSetting(db, 'default_locality') || '';
  const zipLookup = db.prepare('SELECT * FROM zip_county_map WHERE zip = ?');

  const orders = grouped.map((g) => {
    const r = g.first;
    const o = {
      orderNumber: g.orderNumber,
      lines: g.rowLines,
      status: 'new',
      reasons: [],
      warnings: [],
      isCustom: !!custom[g.orderNumber],
    };
    const v = (k) => val(r, map, k);

    // Money
    const money = (key, label, required) => {
      try {
        return required ? parseMoney(v(key), { allowNegative: false, label }) : parseMoneyOrZero(v(key), { allowNegative: false, label });
      } catch (e) {
        o.reasons.push(e.message);
        return null;
      }
    };
    o.subtotal = money('subtotal', 'Subtotal', true);
    o.shipping = money('shipping', 'Shipping', false);
    o.tax = money('taxes', 'Taxes', false);
    o.total = money('total', 'Total', true);
    o.refunded = map.refunded_amount ? money('refunded_amount', 'Refunded amount', false) : 0;

    const currency = v('currency').toUpperCase();
    if (currency && currency !== 'USD') o.reasons.push(`Currency is ${currency}; only US dollars are supported.`);

    o.date = parseLooseDate(v('paid_at')) || parseLooseDate(v('created_at'));
    if (!o.date) o.reasons.push(`Couldn't read the order date "${v('paid_at') || v('created_at')}".`);
    o.cancelledDate = parseLooseDate(v('cancelled_at'));

    o.financialStatus = v('financial_status').toLowerCase().replace(/\s+/g, '_');

    // Customer
    o.email = v('email');
    if (o.email && !EMAIL_RE.test(o.email)) {
      o.warnings.push(`Email "${o.email}" looks invalid and was left off the customer.`);
      o.email = '';
    }
    o.customerName = v('billing_name') || v('shipping_name') || o.email || '';
    o.customerAddress = [
      v('billing_address1'),
      v('billing_address2'),
      [v('billing_city'), [v('billing_province'), cleanZip(v('billing_zip'))].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      v('billing_country') && v('billing_country').toUpperCase() !== 'US' ? v('billing_country') : '',
    ]
      .filter(Boolean)
      .join('\n');
    o.customerPhone = v('billing_phone').replace(/^'/, '');
    o.description = describeLines(g.lines) || `Shopify order ${g.orderNumber}`;
    o.notes = v('notes').slice(0, 2000);
    o.paymentMethodId = matchPaymentMethod(db, v('payment_method'));

    // Jurisdiction (ship-to)
    const country = (v('shipping_country') || '').toUpperCase();
    const province = v('shipping_province');
    o.zip = cleanZip(v('shipping_zip'));
    o.jurisdiction = null;
    if (!country && !province && !o.zip) {
      o.jurisdiction = { state: defaultState, county: defaultCounty, locality: defaultLocality, source: 'business location (no ship-to address)' };
    } else if (country && country !== 'US' && country !== 'USA' && country !== 'UNITED STATES') {
      o.jurisdiction = { state: OUTSIDE_US, county: '', locality: '', source: `ship-to country ${country}` };
    } else {
      const state = normalizeState(province);
      if (!state) {
        o.reasons.push(`Ship-to state "${province}" isn't recognized.`);
      } else {
        const fromTax = state === 'NY' ? jurisdictionFromTaxNames(g.taxNames || []) : { county: null, locality: null };
        const decided = o.zip && counties[o.zip];
        const mapped = o.zip ? zipLookup.get(o.zip) : null;
        let county = '';
        let locality = '';
        let source = '';
        if (fromTax.county) {
          county = fromTax.county;
          locality = fromTax.locality || '';
          source = "Shopify's tax lines";
        } else if (decided && decided.county) {
          county = decided.county;
          locality = decided.locality || '';
          source = 'your choice for this ZIP';
        } else if (mapped && mapped.state === state) {
          county = mapped.county;
          locality = mapped.locality || '';
          source = 'saved ZIP → county';
        }
        if (!locality && fromTax.locality) locality = fromTax.locality;
        if (state === 'NY' && county && !NY_COUNTIES.includes(county)) {
          const n = normalizeNyCounty(county);
          if (n) county = n;
          else county = '';
        }
        o.jurisdiction = { state, county, locality, source };
        if (state === 'NY' && !county) o.status = 'needs_county';
      }
    }

    // Amount sanity checks (warnings, not blockers)
    if (o.subtotal !== null && o.shipping !== null && o.tax !== null && o.total !== null) {
      const computed = o.subtotal + o.shipping + o.tax;
      if (computed !== o.total) {
        o.warnings.push(`Shopify's total ${formatMoney(o.total)} ≠ subtotal + shipping + tax (${formatMoney(computed)}).`);
      }
      if (o.subtotal + o.shipping + o.tax === 0) o.reasons.push('Order total is $0.00.');
    }
    if (o.financialStatus === 'partially_paid') o.warnings.push('Shopify says this order is only partially paid.');

    if (o.reasons.length) {
      o.status = 'error';
      return o;
    }
    if (!IMPORTABLE_STATUSES.has(o.financialStatus)) {
      o.status = 'skipped';
      o.reasons.push(`Not paid (status "${o.financialStatus || 'blank'}").`);
      return o;
    }

    // Duplicates
    const existing = findExistingShopifySale(db, g.orderNumber);
    if (existing.active) {
      o.existingSaleId = existing.active.id;
      const rem = refundableRemaining(db, existing.active.id);
      const alreadyRefunded = rem.refunded_subtotal + rem.refunded_shipping + rem.refunded_tax;
      const delta = (o.refunded || 0) - alreadyRefunded;
      if (delta > 0) {
        const remTotal = rem.subtotal + rem.shipping + rem.tax;
        const amount = Math.min(delta, remTotal);
        if (amount > 0) {
          o.status = 'new_refund';
          o.refund = planRefund(amount, [rem.subtotal, rem.shipping, rem.tax], existing.active, rem, o, existing.active.sale_date, {
            date: today >= existing.active.sale_date ? today : existing.active.sale_date,
            label: 'the import date',
          });
          if (exclude[g.orderNumber]) o.status = 'excluded';
          return o;
        }
      }
      o.status = 'duplicate';
      o.reasons.push(`Already imported (${existing.active.sale_date}).`);
      return o;
    }
    if (existing.trashed && !decisions.includeTrashed) {
      o.status = 'in_trash';
      o.reasons.push('This order is in the Trash. Restore it there, or tick "re-import orders that are in the Trash".');
      return o;
    }

    o.taxable = o.tax > 0 ? o.subtotal + o.shipping : 0;
    if (o.refunded > 0) {
      const total = o.subtotal + o.shipping + o.tax;
      let amount = o.refunded;
      if (amount > total) {
        o.warnings.push(`Refunded amount ${formatMoney(o.refunded)} is more than the order total; capped at ${formatMoney(total)}.`);
        amount = total;
      }
      const pseudoSale = {
        subtotal_cents: o.subtotal,
        shipping_cents: o.shipping,
        taxable_cents: o.taxable,
      };
      const rem = { subtotal: o.subtotal, shipping: o.shipping, tax: o.tax, taxable: o.taxable };
      o.refund = planRefund(amount, [o.subtotal, o.shipping, o.tax], pseudoSale, rem, o, o.date, { date: o.date, label: 'the order date' });
    }
    if ((o.status === 'new' || o.status === 'needs_county') && exclude[g.orderNumber]) o.status = 'excluded';
    return o;
  });

  const counts = {};
  for (const o of orders) counts[o.status] = (counts[o.status] || 0) + 1;
  const zipMap = new Map();
  for (const o of orders.filter((x) => x.status === 'needs_county')) {
    const key = o.zip || '(no ZIP)';
    if (!zipMap.has(key)) zipMap.set(key, { zip: o.zip, orders: [] });
    zipMap.get(key).orders.push(o.orderNumber);
  }
  return {
    ...base,
    ordersRead: orders.length,
    orders,
    problems,
    counts,
    needsCountyZips: [...zipMap.values()],
    canCommit: !counts.needs_county && (counts.new || 0) + (counts.new_refund || 0) > 0,
  };
}

// Split a refund total proportionally across subtotal / shipping / tax.
function planRefund(amount, weights, original, remaining, o, saleDate, fallback) {
  const [sub, ship, tax] = allocateProportionally(amount, weights);
  const full = sub === remaining.subtotal && ship === remaining.shipping && tax === remaining.tax;
  let taxable = 0;
  const base = original.subtotal_cents + original.shipping_cents;
  if (original.taxable_cents > 0 && base > 0) {
    taxable = full ? remaining.taxable : Math.min(scaleCents(original.taxable_cents, sub + ship, base), sub + ship, remaining.taxable);
  }
  const useCancelled = o.cancelledDate && o.cancelledDate >= saleDate;
  const date = useCancelled ? o.cancelledDate : fallback.date;
  return {
    amount,
    subtotal: sub,
    shipping: ship,
    tax,
    taxable: Math.max(0, taxable),
    date,
    reviewNote:
      "Shopify's export only gives the total refunded, so the split between merchandise, shipping and tax is estimated, " +
      `and the refund date (${date}) is ${useCancelled ? 'the cancellation date' : fallback.label}. Check both against Shopify.`,
  };
}

// Commit a plan (built with the same decisions the user saw). One transaction.
export function commitImportPlan(db, plan, now) {
  if (plan.mappingErrors?.length) throw new ValidationError(plan.mappingErrors[0]);
  if (plan.counts.needs_county) {
    throw new ValidationError(`${plan.counts.needs_county} New York order(s) still need a county before importing.`);
  }
  const toImport = plan.orders.filter((o) => o.status === 'new' || o.status === 'new_refund');
  if (toImport.length === 0) throw new ValidationError('There is nothing new to import in this file.');

  return db.transaction(() => {
    const batchId = Number(
      db
        .prepare(
          `INSERT INTO import_batches (source, file_name, file_sha256, rows_read, orders_read, sales_created, refunds_created,
            orders_skipped, mapping_json, created_at, updated_at)
           VALUES ('shopify_orders_csv', ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`,
        )
        .run(plan.fileName, plan.fileSha256, plan.rowsRead, plan.ordersRead, JSON.stringify(plan.mapping), now, now).lastInsertRowid,
    );
    let salesCreated = 0;
    let refundsCreated = 0;
    let flagged = 0;
    const createdCustomers = new Map();

    for (const o of toImport) {
      if (o.status === 'new') {
        // Re-check for a duplicate inside the transaction.
        const dup = findExistingShopifySale(db, o.orderNumber);
        if (dup.active) continue;
        let customerId = null;
        if (o.customerName) {
          const key = (o.email || o.customerName).toLowerCase();
          customerId =
            createdCustomers.get(key) ??
            (o.email ? findCustomerByEmail(db, o.email)?.id : null) ??
            findCustomerByName(db, o.customerName)?.id ??
            null;
          if (!customerId) {
            customerId = createCustomer(
              db,
              { name: o.customerName, email: o.email, phone: o.customerPhone, address: o.customerAddress },
              now,
            );
          }
          createdCustomers.set(key, customerId);
        }
        const reviewNotes = [...o.warnings];
        const saleId = createSale(
          db,
          {
            sale_date: o.date,
            customer_id: customerId,
            channel: 'shopify',
            order_number: o.orderNumber,
            description: o.description,
            is_custom: o.isCustom,
            subtotal: centsToDecimal(o.subtotal),
            shipping: centsToDecimal(o.shipping),
            tax: centsToDecimal(o.tax),
            taxable_override: true,
            taxable: centsToDecimal(o.taxable),
            ship_state: o.jurisdiction.state,
            ship_county: o.jurisdiction.county,
            ship_locality: o.jurisdiction.locality,
            payment_method_id: o.paymentMethodId,
            notes: o.notes,
          },
          now,
          { importBatchId: batchId, needsReview: reviewNotes.length > 0, reviewNote: reviewNotes.join(' ') },
        );
        salesCreated++;
        if (reviewNotes.length) flagged++;
        if (o.refund) {
          createPlannedRefund(db, saleId, o, now, batchId);
          refundsCreated++;
          flagged++;
        }
      } else if (o.status === 'new_refund') {
        createPlannedRefund(db, o.existingSaleId, o, now, batchId);
        refundsCreated++;
        flagged++;
      }
    }

    // Remember the user's ZIP → county answers for next time.
    const upsertZip = db.prepare(
      `INSERT INTO zip_county_map (zip, state, county, locality, created_at, updated_at) VALUES (?, 'NY', ?, ?, ?, ?)
       ON CONFLICT(zip) DO UPDATE SET state = excluded.state, county = excluded.county, locality = excluded.locality, updated_at = excluded.updated_at`,
    );
    for (const [zip, c] of Object.entries(plan.decisions?.counties || {})) {
      if (/^\d{5}$/.test(zip) && c?.county && normalizeNyCounty(c.county)) {
        upsertZip.run(zip, normalizeNyCounty(c.county), String(c.locality || '').trim().slice(0, 60), now, now);
      }
    }
    setSetting(db, 'shopify_mapping', JSON.stringify(plan.mapping), now);

    const skipped = plan.ordersRead - salesCreated - plan.orders.filter((o) => o.status === 'new_refund').length;
    db.prepare('UPDATE import_batches SET sales_created = ?, refunds_created = ?, orders_skipped = ? WHERE id = ?').run(
      salesCreated, refundsCreated, Math.max(0, skipped), batchId,
    );
    return { batchId, salesCreated, refundsCreated, flagged, skipped: Math.max(0, skipped) };
  })();
}

function createPlannedRefund(db, saleId, o, now, batchId) {
  const r = o.refund;
  return createRefund(
    db,
    {
      original_sale_id: saleId,
      sale_date: r.date,
      subtotal: centsToDecimal(r.subtotal),
      shipping: centsToDecimal(r.shipping),
      tax: centsToDecimal(r.tax),
      taxable_override: true,
      taxable: centsToDecimal(r.taxable),
      description: `Refund of Shopify order ${o.orderNumber}`,
    },
    now,
    { importBatchId: batchId, needsReview: true, reviewNote: r.reviewNote },
  );
}

export function listImportBatches(db) {
  return db.prepare('SELECT * FROM import_batches ORDER BY id DESC LIMIT 200').all();
}

// Undo an import: soft-delete everything it created (and refunds of those
// sales), sharing one deleted_at stamp so it can be restored as a unit.
export function undoImport(db, batchId, now) {
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId);
  if (!batch) throw new ValidationError('Import not found.');
  if (batch.deleted_at) throw new ValidationError('That import was already undone.');
  return db.transaction(() => {
    const n = db
      .prepare(
        `UPDATE sales SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL AND
          (import_batch_id = ? OR original_sale_id IN (SELECT id FROM sales WHERE import_batch_id = ?))`,
      )
      .run(now, now, batchId, batchId).changes;
    db.prepare('UPDATE import_batches SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, batchId);
    return { count: n, deleted_at: now };
  })();
}

export function restoreImport(db, batchId, now) {
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId);
  if (!batch) throw new ValidationError('Import not found.');
  if (!batch.deleted_at) throw new ValidationError('That import is not undone.');
  return db.transaction(() => {
    const stamp = batch.deleted_at;
    const rows = db
      .prepare(
        `SELECT * FROM sales WHERE deleted_at = ? AND
          (import_batch_id = ? OR original_sale_id IN (SELECT id FROM sales WHERE import_batch_id = ?))`,
      )
      .all(stamp, batchId, batchId);
    // Order numbers that were re-used while the import was undone.
    for (const s of rows) {
      if (s.kind === 'sale' && s.order_number) {
        const n = db
          .prepare(
            "SELECT count(*) AS n FROM sales WHERE kind = 'sale' AND channel = ? AND lower(order_number) = lower(?) AND deleted_at IS NULL",
          )
          .get(s.channel, s.order_number).n;
        if (n > 0) throw new ValidationError(`Order ${s.order_number} was entered again since the import was undone. Delete one copy first.`);
      }
    }
    db.prepare(
      `UPDATE sales SET deleted_at = NULL, updated_at = ? WHERE deleted_at = ? AND
        (import_batch_id = ? OR original_sale_id IN (SELECT id FROM sales WHERE import_batch_id = ?))`,
    ).run(now, stamp, batchId, batchId);
    // Verify refunds still make sense now that the rows are back.
    for (const s of rows) {
      if (s.kind === 'refund') {
        const orig = db.prepare('SELECT deleted_at FROM sales WHERE id = ?').get(s.original_sale_id);
        if (orig.deleted_at) throw new ValidationError('A refund in this import belongs to a sale that is in the Trash. Restore that sale first.');
        const rem = refundableRemaining(db, s.original_sale_id);
        if (rem.subtotal < 0 || rem.shipping < 0 || rem.tax < 0) {
          throw new ValidationError('Restoring this import would refund more than a sale was for.');
        }
      }
    }
    db.prepare('UPDATE import_batches SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, batchId);
    return { count: rows.length };
  })();
}
