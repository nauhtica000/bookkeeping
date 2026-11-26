import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBooks } from './helpers.js';
import { csvField } from '../src/core/csv.js';
import { autoMapping, cleanZip, jurisdictionFromTaxNames } from '../src/core/shopify.js';

// The column layout of Shopify's "Export orders" CSV.
const HEADERS = [
  'Name', 'Email', 'Financial Status', 'Paid at', 'Fulfillment Status', 'Fulfilled at', 'Accepts Marketing', 'Currency',
  'Subtotal', 'Shipping', 'Taxes', 'Total', 'Discount Code', 'Discount Amount', 'Shipping Method', 'Created at',
  'Lineitem quantity', 'Lineitem name', 'Lineitem price', 'Lineitem compare at price', 'Lineitem sku',
  'Lineitem requires shipping', 'Lineitem taxable', 'Lineitem fulfillment status', 'Billing Name', 'Billing Street',
  'Billing Address1', 'Billing Address2', 'Billing Company', 'Billing City', 'Billing Zip', 'Billing Province',
  'Billing Country', 'Billing Phone', 'Shipping Name', 'Shipping Street', 'Shipping Address1', 'Shipping Address2',
  'Shipping Company', 'Shipping City', 'Shipping Zip', 'Shipping Province', 'Shipping Country', 'Shipping Phone',
  'Notes', 'Note Attributes', 'Cancelled at', 'Payment Method', 'Payment Reference', 'Refunded Amount', 'Vendor',
  'Outstanding Balance', 'Employee', 'Location', 'Device ID', 'Id', 'Tags', 'Risk Level', 'Source', 'Lineitem discount',
  'Tax 1 Name', 'Tax 1 Value', 'Tax 2 Name', 'Tax 2 Value',
];

function csv(rows, headers = HEADERS) {
  const lines = [headers.map((h) => csvField(h)).join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvField(r[h] ?? '', { text: false })).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

const ny = (zip, extra = {}) => ({ 'Shipping Province': 'NY', 'Shipping Country': 'US', 'Shipping Zip': `'${zip}`, ...extra });

function order(num, over = {}) {
  return {
    Name: num,
    Email: 'pat@example.com',
    'Financial Status': 'paid',
    'Paid at': '2026-10-03 10:15:00 -0400',
    'Created at': '2026-10-03 10:14:00 -0400',
    Currency: 'USD',
    'Lineitem quantity': '1',
    'Lineitem name': 'Hatch cover 12 in. x 18 in.',
    'Lineitem sku': 'HC-1218',
    'Billing Name': 'Pat Boater',
    'Billing Address1': '1 Harbor Rd',
    'Billing City': 'Northport',
    'Billing Zip': "'11768",
    'Billing Province': 'NY',
    'Billing Country': 'US',
    'Payment Method': 'Shopify Payments',
    'Refunded Amount': '0.00',
    ...over,
  };
}

const SUFFOLK_TAX = { 'Tax 1 Name': 'NY State Tax 4.0%', 'Tax 2 Name': 'Suffolk County Tax 4.625%' };

function fixtureRows() {
  return [
    order('#1001', {
      Subtotal: '120.00', Shipping: '12.00', Taxes: '11.39', Total: '143.39',
      ...ny('11787'), ...SUFFOLK_TAX, 'Tax 1 Value': '5.28', 'Tax 2 Value': '6.11',
      Notes: 'Please ship, ASAP\nThanks!',
    }),
    // Second line item of #1001: order-level columns are blank, as Shopify writes them.
    { Name: '#1001', 'Lineitem quantity': '2', 'Lineitem name': 'Drain plug', 'Lineitem sku': 'DP-1' },
    order('#1002', {
      Subtotal: '45.00', Shipping: '8.00', Taxes: '0.00', Total: '53.00',
      'Shipping Province': 'NJ', 'Shipping Country': 'US', 'Shipping Zip': "'07601",
    }),
    order('#1003', {
      Email: 'sam@example.com', 'Billing Name': 'Sam Skipper', 'Financial Status': 'partially_refunded',
      Subtotal: '80.00', Shipping: '10.00', Taxes: '7.76', Total: '97.76', 'Refunded Amount': '48.88',
      ...ny('11550'), 'Tax 1 Name': 'NY State Tax 4.0%', 'Tax 2 Name': 'Nassau County Tax 4.625%',
    }),
    order('#1004', { 'Financial Status': 'pending', Subtotal: '10.00', Shipping: '0', Taxes: '0', Total: '10.00', ...ny('11787') }),
    order('#1005', { Subtotal: '100.00', Shipping: '0.00', Taxes: '8.88', Total: '108.88', ...ny('10001') }),
    order('#1006', { Currency: 'CAD', Subtotal: '10.00', Shipping: '0', Taxes: '0', Total: '10.00', 'Shipping Country': 'CA', 'Shipping Province': 'ON' }),
    order('#1007', { 'Financial Status': 'voided', Subtotal: '10.00', Shipping: '0', Taxes: '0', Total: '10.00', ...ny('11787') }),
    order('#1008', { Subtotal: '200.00', Shipping: '40.00', Taxes: '0.00', Total: '240.00', 'Shipping Country': 'CA', 'Shipping Province': 'ON', 'Shipping Zip': 'K1A 0B1' }),
    order('#1009', { Subtotal: '50.00', Shipping: '0.00', Taxes: '4.31', Total: '54.31', 'Shipping Method': 'Local pickup' }),
    order('#1010', { Subtotal: '10.00', Shipping: '0.00', Taxes: '0.00', Total: '12.00', 'Shipping Province': 'NJ', 'Shipping Country': 'US', 'Shipping Zip': "'07601" }),
    order('#1011', {
      'Financial Status': 'refunded', Subtotal: '30.00', Shipping: '5.00', Taxes: '3.02', Total: '38.02',
      'Refunded Amount': '38.02', 'Cancelled at': '2026-10-20 09:00:00 -0400', ...ny('11787'), ...SUFFOLK_TAX,
    }),
    order('#1012', { Subtotal: 'abc', Shipping: '0', Taxes: '0', Total: '1.00', ...ny('11787') }),
  ];
}

const salesByOrder = (b) => {
  const rows = b.db.prepare("SELECT * FROM sales WHERE kind = 'sale' AND deleted_at IS NULL").all();
  return new Map(rows.map((r) => [r.order_number, r]));
};

test('helpers: ZIP cleanup and tax-line jurisdiction', () => {
  assert.equal(cleanZip("'02108"), '02108');
  assert.equal(cleanZip('11787-1234'), '11787');
  assert.equal(cleanZip('K1A 0B1'), '');
  assert.deepEqual(jurisdictionFromTaxNames(['NY State Tax 4.0%', 'Suffolk County Tax 4.625%']), { county: 'Suffolk', locality: null });
  assert.deepEqual(jurisdictionFromTaxNames(['New York State Tax', 'New York City Tax 4.5%']), { county: null, locality: 'New York City' });
  assert.deepEqual(jurisdictionFromTaxNames(['Metropolitan Commuter Transportation District']), { county: null, locality: null });
  assert.equal(jurisdictionFromTaxNames(['St. Lawrence County Tax']).county, 'St. Lawrence');
});

test('column auto-mapping finds the standard Shopify headers', () => {
  const m = autoMapping(HEADERS);
  assert.equal(m.order_number, 'Name');
  assert.equal(m.taxes, 'Taxes');
  assert.equal(m.billing_address1, 'Billing Address1');
  assert.equal(m.refunded_amount, 'Refunded Amount');
  assert.equal(autoMapping(['name', 'TOTAL']).order_number, 'name'); // case-insensitive
});

test('preview classifies every order, and NY orders need a county before commit', () => {
  const b = makeBooks();
  const plan = b.internal.buildImportPlan(csv(fixtureRows()), { fileName: 'orders_export.csv' });
  assert.deepEqual(plan.mappingErrors, []);
  assert.equal(plan.rowsRead, 13);
  assert.equal(plan.ordersRead, 12);
  const status = Object.fromEntries(plan.orders.map((o) => [o.orderNumber, o.status]));
  assert.deepEqual(status, {
    '#1001': 'new', '#1002': 'new', '#1003': 'new', '#1004': 'skipped', '#1005': 'needs_county', '#1006': 'error',
    '#1007': 'skipped', '#1008': 'new', '#1009': 'new', '#1010': 'new', '#1011': 'new', '#1012': 'error',
  });
  assert.equal(plan.canCommit, false);
  assert.deepEqual(plan.needsCountyZips, [{ zip: '10001', orders: ['#1005'] }]);
  const o1001 = plan.orders.find((o) => o.orderNumber === '#1001');
  assert.equal(o1001.jurisdiction.county, 'Suffolk');
  assert.equal(o1001.description, '1 × Hatch cover 12 in. x 18 in. (HC-1218); 2 × Drain plug (DP-1)');
  assert.match(plan.orders.find((o) => o.orderNumber === '#1006').reasons.join(), /CAD/);
  assert.match(plan.orders.find((o) => o.orderNumber === '#1012').reasons.join(), /Subtotal/);
  assert.match(plan.orders.find((o) => o.orderNumber === '#1010').warnings.join(), /total \$12\.00/);
  assert.throws(() => b.internal.commitImportPlan(plan), /still need a county/);
  b.cleanup();
});

test('commit imports sales, linked refunds, customers, and remembers ZIP counties', () => {
  const b = makeBooks();
  const decisions = {
    counties: { 10001: { county: 'New York', locality: 'New York City' } },
    custom: { '#1001': true },
  };
  const plan = b.internal.buildImportPlan(csv(fixtureRows()), { decisions, fileName: 'orders_export.csv' });
  assert.equal(plan.canCommit, true);
  const res = b.internal.commitImportPlan(plan);
  assert.equal(res.salesCreated, 8);
  assert.equal(res.refundsCreated, 2);

  const sales = salesByOrder(b);
  const s1 = sales.get('#1001');
  assert.equal(s1.channel, 'shopify');
  assert.equal(s1.sale_date, '2026-10-03');
  assert.deepEqual([s1.subtotal_cents, s1.shipping_cents, s1.tax_cents, s1.taxable_cents], [12000, 1200, 1139, 13200]);
  assert.equal(s1.ship_county, 'Suffolk');
  assert.equal(s1.is_custom, 1);
  assert.equal(s1.notes, 'Please ship, ASAP\nThanks!');
  assert.equal(s1.import_batch_id, res.batchId);
  assert.equal(b.db.prepare('SELECT name FROM payment_methods WHERE id = ?').get(s1.payment_method_id).name, 'Shopify Payments');

  assert.equal(sales.get('#1005').ship_county, 'New York');
  assert.equal(sales.get('#1005').ship_locality, 'New York City');
  assert.equal(sales.get('#1008').ship_state, 'INTL');
  assert.equal(sales.get('#1009').ship_county, 'Suffolk'); // pickup → business location
  assert.equal(sales.get('#1010').needs_review, 1);
  assert.equal(sales.get('#1002').taxable_cents, 0);

  // One customer for two orders with the same email.
  const pat = b.db.prepare("SELECT * FROM customers WHERE email = 'pat@example.com'").all();
  assert.equal(pat.length, 1);
  assert.equal(pat[0].name, 'Pat Boater');
  assert.match(pat[0].address, /1 Harbor Rd\nNorthport, NY 11768/);

  // Partial refund split proportionally (48.88 of 97.76 = exactly half).
  const r3 = b.db.prepare('SELECT * FROM sales WHERE original_sale_id = ?').get(sales.get('#1003').id);
  assert.deepEqual([r3.subtotal_cents, r3.shipping_cents, r3.tax_cents, r3.taxable_cents], [-4000, -500, -388, -4500]);
  assert.equal(r3.total_cents, -4888);
  assert.equal(r3.ship_county, 'Nassau');
  assert.equal(r3.needs_review, 1);
  assert.equal(r3.sale_date, '2026-10-03');

  // Full refund: exact negative of the sale, dated the cancellation day.
  const s11 = sales.get('#1011');
  const r11 = b.db.prepare('SELECT * FROM sales WHERE original_sale_id = ?').get(s11.id);
  assert.deepEqual(
    [r11.subtotal_cents, r11.shipping_cents, r11.tax_cents, r11.taxable_cents],
    [-s11.subtotal_cents, -s11.shipping_cents, -s11.tax_cents, -s11.taxable_cents],
  );
  assert.equal(r11.sale_date, '2026-10-20');

  assert.equal(b.db.prepare("SELECT county FROM zip_county_map WHERE zip = '10001'").get().county, 'New York');
  assert.ok(JSON.parse(b.internal.getSetting('shopify_mapping')).order_number === 'Name');
  b.cleanup();
});

test('re-importing skips duplicates and picks up refunds issued later', () => {
  const b = makeBooks({ today: '2026-11-25' });
  const decisions = { counties: { 10001: { county: 'New York', locality: 'New York City' } } };
  const rows = fixtureRows();
  b.internal.commitImportPlan(b.internal.buildImportPlan(csv(rows), { decisions }));

  const again = b.internal.buildImportPlan(csv(rows));
  assert.ok(again.previousImport, 'warns the same file was imported');
  assert.equal(again.counts.duplicate, 8);
  assert.equal(again.counts.new ?? 0, 0);
  assert.equal(again.canCommit, false);
  assert.throws(() => b.internal.commitImportPlan(again), /nothing new/);

  // Later export: #1003 now fully refunded, and a new order to the same NYC ZIP.
  const later = fixtureRows();
  later.find((r) => r.Name === '#1003')['Refunded Amount'] = '97.76';
  later.push(order('#1013', { Subtotal: '20.00', Shipping: '0', Taxes: '1.78', Total: '21.78', ...ny('10001') }));
  const plan = b.internal.buildImportPlan(csv(later));
  const by = Object.fromEntries(plan.orders.map((o) => [o.orderNumber, o]));
  assert.equal(by['#1003'].status, 'new_refund');
  assert.equal(by['#1003'].refund.amount, 4888);
  assert.equal(by['#1003'].refund.date, '2026-11-25');
  assert.equal(by['#1013'].status, 'new');
  assert.equal(by['#1013'].jurisdiction.county, 'New York'); // from the saved ZIP map
  assert.equal(by['#1013'].jurisdiction.source, 'saved ZIP → county');
  const res = b.internal.commitImportPlan(plan);
  assert.equal(res.salesCreated, 1);
  assert.equal(res.refundsCreated, 1);
  const s3 = salesByOrder(b).get('#1003');
  const rem = b.call('sales.get', { id: s3.id }).remaining;
  assert.deepEqual([rem.subtotal, rem.shipping, rem.tax, rem.taxable], [0, 0, 0, 0]);
  b.cleanup();
});

test('excluded orders are left out; Trash and undo-import behave', () => {
  const b = makeBooks();
  const decisions = { counties: { 10001: { county: 'New York' } }, exclude: { '#1002': true } };
  const plan = b.internal.buildImportPlan(csv(fixtureRows()), { decisions });
  assert.equal(plan.orders.find((o) => o.orderNumber === '#1002').status, 'excluded');
  const res = b.internal.commitImportPlan(plan);
  assert.equal(res.salesCreated, 7);
  assert.ok(!salesByOrder(b).has('#1002'));

  // Undo the whole import.
  const undo = b.call('import.undo', { id: res.batchId });
  assert.equal(undo.count, 7 + 2);
  assert.equal(b.call('sales.list').rows.length, 0);
  const trash = b.call('trash.list');
  assert.equal(trash.imports.length, 1);
  assert.equal(trash.sales.length, 0, 'undone rows are restored with the import, not one by one');

  // Re-importing finds them in the Trash unless asked to re-import.
  const p2 = b.internal.buildImportPlan(csv(fixtureRows()), { decisions });
  assert.equal(p2.orders.find((o) => o.orderNumber === '#1001').status, 'in_trash');
  b.call('trash.restore', { type: 'import', id: res.batchId });
  assert.equal(b.call('sales.list').rows.length, 9);

  // If an order was re-imported meanwhile, restoring the old import is refused.
  b.call('import.undo', { id: res.batchId });
  const p3 = b.internal.buildImportPlan(csv(fixtureRows()), { decisions: { ...decisions, includeTrashed: true } });
  assert.equal(p3.orders.find((o) => o.orderNumber === '#1001').status, 'new');
  b.internal.commitImportPlan(p3);
  assert.throws(() => b.call('trash.restore', { type: 'import', id: res.batchId }), /entered again/);
  b.cleanup();
});

test('missing required columns are reported, not guessed', () => {
  const b = makeBooks();
  const headers = HEADERS.filter((h) => h !== 'Taxes' && h !== 'Financial Status');
  const plan = b.internal.buildImportPlan(csv(fixtureRows(), headers));
  assert.equal(plan.canCommit, false);
  assert.ok(plan.mappingErrors.some((e) => /Taxes/.test(e)));
  assert.ok(plan.mappingErrors.some((e) => /Financial status/.test(e)));
  assert.throws(() => b.internal.commitImportPlan(plan), /must be mapped/);

  // A user-supplied mapping can point at differently named columns.
  const renamed = csv(
    [{ Order: '#2001', Status: 'paid', Date: '2026-09-09', Sub: '10.00', Ship: '0', Tax: '0', Tot: '10.00', 'Shipping Province': 'NJ', 'Shipping Country': 'US' }],
    ['Order', 'Status', 'Date', 'Sub', 'Ship', 'Tax', 'Tot', 'Shipping Province', 'Shipping Country'],
  );
  const mapping = {
    order_number: 'Order', financial_status: 'Status', created_at: 'Date', subtotal: 'Sub', shipping: 'Ship',
    taxes: 'Tax', total: 'Tot', shipping_province: 'Shipping Province', shipping_country: 'Shipping Country',
  };
  const p2 = b.internal.buildImportPlan(renamed, { mapping });
  assert.deepEqual(p2.mappingErrors, []);
  assert.equal(p2.orders[0].status, 'new');
  assert.equal(b.internal.commitImportPlan(p2).salesCreated, 1);
  // The same column can't feed two fields.
  const p3 = b.internal.buildImportPlan(renamed, { mapping: { ...mapping, shipping: 'Sub' } });
  assert.ok(p3.mappingErrors.some((e) => /mapped to both/.test(e)));
  b.cleanup();
});

test('a malformed CSV file fails with a line number', () => {
  const b = makeBooks();
  assert.throws(() => b.internal.buildImportPlan('Name,Total\n"#1001,5.00\n'), /never closed \(line 2\)/);
  b.cleanup();
});
