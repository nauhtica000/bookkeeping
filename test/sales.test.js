import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBooks, saleInput } from './helpers.js';
import { ValidationError, ConflictError } from '../src/core/errors.js';

const fieldsOf = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ValidationError, `expected ValidationError, got ${e.name}: ${e.message}`);
    return e.fields;
  }
  assert.fail('expected a ValidationError');
};

test('creating a sale stores integer cents and the default taxable amount', () => {
  const b = makeBooks();
  const id = b.call('sales.create', saleInput({ subtotal: '$1,200.50', shipping: '25', tax: '105.73' }));
  const { sale } = b.call('sales.get', { id });
  assert.equal(sale.subtotal_cents, 120050);
  assert.equal(sale.shipping_cents, 2500);
  assert.equal(sale.tax_cents, 10573);
  assert.equal(sale.total_cents, 120050 + 2500 + 10573);
  assert.equal(sale.taxable_cents, 120050 + 2500); // tax collected → subtotal + shipping
  assert.equal(sale.customer_name, 'Test Customer');
  assert.ok(sale.created_at && sale.updated_at);
  const untaxed = b.call('sales.create', saleInput({ ship_state: 'NJ', ship_county: '', tax: '' }));
  assert.equal(b.call('sales.get', { id: untaxed }).sale.taxable_cents, 0);
  b.cleanup();
});

test('taxable amount can be overridden within limits', () => {
  const b = makeBooks();
  const id = b.call('sales.create', saleInput({ taxable_override: true, taxable: '50.00' }));
  assert.equal(b.call('sales.get', { id }).sale.taxable_cents, 5000);
  assert.ok(fieldsOf(() => b.call('sales.create', saleInput({ taxable_override: true, taxable: '200.00' }))).taxable);
  assert.ok(fieldsOf(() => b.call('sales.create', saleInput({ taxable_override: true, taxable: '0' }))).taxable);
  b.cleanup();
});

test('sale validation reports every bad field', () => {
  const b = makeBooks();
  const f = fieldsOf(() =>
    b.call('sales.create', {
      sale_date: '2026-02-30',
      channel: 'ebay',
      subtotal: '12.345',
      shipping: '-1',
      tax: 'abc',
      ship_state: 'ZZ',
    }),
  );
  for (const k of ['sale_date', 'channel', 'subtotal', 'shipping', 'tax', 'ship_state']) assert.ok(f[k], `missing error for ${k}`);
  assert.match(fieldsOf(() => b.call('sales.create', saleInput({ ship_county: '' }))).ship_county, /required for New York/);
  assert.match(fieldsOf(() => b.call('sales.create', saleInput({ ship_county: 'Gotham' }))).ship_county, /not a New York county/);
  assert.ok(fieldsOf(() => b.call('sales.create', saleInput({ subtotal: '0', shipping: '0', tax: '0' }))).subtotal);
  assert.ok(fieldsOf(() => b.call('sales.create', saleInput({ ship_state: '' }))).ship_state);
  b.cleanup();
});

test('NY county names are normalized; outside-US sales have no county', () => {
  const b = makeBooks();
  const a = b.call('sales.create', saleInput({ ship_county: 'suffolk county' }));
  assert.equal(b.call('sales.get', { id: a }).sale.ship_county, 'Suffolk');
  const c = b.call('sales.create', saleInput({ ship_county: 'Brooklyn', ship_locality: 'New York City' }));
  assert.equal(b.call('sales.get', { id: c }).sale.ship_county, 'Kings');
  const d = b.call('sales.create', saleInput({ ship_state: 'INTL', ship_county: 'Ontario', tax: '0' }));
  assert.equal(b.call('sales.get', { id: d }).sale.ship_county, '');
  b.cleanup();
});

test('order numbers are unique per channel among active sales', () => {
  const b = makeBooks();
  const first = b.call('sales.create', saleInput({ order_number: 'INV-100' }));
  b.call('sales.create', saleInput({ order_number: 'INV-100', channel: 'shopify' })); // other channel is fine
  assert.match(fieldsOf(() => b.call('sales.create', saleInput({ order_number: 'inv-100' }))).order_number, /already used/);
  b.call('sales.delete', { id: first });
  const second = b.call('sales.create', saleInput({ order_number: 'INV-100' })); // allowed once the first is in the Trash
  assert.throws(() => b.call('sales.restore', { id: first }), ConflictError);
  b.call('sales.delete', { id: second });
  b.call('sales.restore', { id: first });
  b.cleanup();
});

test('typed customer names match existing customers case-insensitively', () => {
  const b = makeBooks();
  b.call('sales.create', saleInput({ customer_name: 'Port Jeff Marine' }));
  b.call('sales.create', saleInput({ customer_name: 'port jeff marine' }));
  b.call('sales.create', saleInput({ customer_name: 'Someone Else' }));
  const list = b.call('customers.list');
  assert.equal(list.length, 3 - 1);
  assert.equal(list.find((c) => c.name === 'Port Jeff Marine').sale_count, 2);
  b.cleanup();
});

test('refunds are negative, linked, and limited to what is left', () => {
  const b = makeBooks();
  const id = b.call('sales.create', saleInput()); // 100.00 + 10.00 + 9.49
  const r1 = b.call('refunds.create', { original_sale_id: id, sale_date: '2026-10-05', subtotal: '40.00', tax: '3.45' });
  const got = b.call('sales.get', { id: r1 });
  assert.equal(got.sale.kind, 'refund');
  assert.equal(got.sale.original_sale_id, id);
  assert.equal(got.sale.subtotal_cents, -4000);
  assert.equal(got.sale.tax_cents, -345);
  assert.equal(got.sale.taxable_cents, -4000); // 40/110 of the 110.00 taxable
  assert.equal(got.sale.ship_county, 'Suffolk'); // copied from the original
  const rem = b.call('sales.get', { id }).remaining;
  assert.deepEqual([rem.subtotal, rem.shipping, rem.tax, rem.taxable], [6000, 1000, 604, 7000]);

  assert.match(
    fieldsOf(() => b.call('refunds.create', { original_sale_id: id, sale_date: '2026-10-05', subtotal: '60.01' })).subtotal,
    /Only \$60\.00/,
  );
  assert.ok(fieldsOf(() => b.call('refunds.create', { original_sale_id: id, sale_date: '2026-09-30', subtotal: '1' })).sale_date);
  assert.ok(fieldsOf(() => b.call('refunds.create', { original_sale_id: id, sale_date: '2026-10-05' })).subtotal);
  assert.throws(() => b.call('refunds.create', { original_sale_id: r1, sale_date: '2026-10-05', subtotal: '1' }), /refund a refund/);

  // Refunding everything that's left zeroes the sale out exactly.
  b.call('refunds.create', { original_sale_id: id, sale_date: '2026-10-06', subtotal: '60.00', shipping: '10.00', tax: '6.04' });
  const after = b.call('sales.get', { id }).remaining;
  assert.deepEqual([after.subtotal, after.shipping, after.tax, after.taxable], [0, 0, 0, 0]);
  b.cleanup();
});

test('a sale cannot be edited below what has been refunded', () => {
  const b = makeBooks();
  const id = b.call('sales.create', saleInput());
  b.call('refunds.create', { original_sale_id: id, sale_date: '2026-10-05', subtotal: '80.00' });
  assert.ok(fieldsOf(() => b.call('sales.update', { id, ...saleInput({ subtotal: '79.99' }) })).subtotal);
  assert.ok(fieldsOf(() => b.call('sales.update', { id, ...saleInput({ sale_date: '2026-10-10' }) })).sale_date);
  // Changing the jurisdiction moves the refund with it.
  b.call('sales.update', { id, ...saleInput({ ship_county: 'Nassau' }) });
  const { refunds } = b.call('sales.get', { id });
  assert.equal(refunds[0].ship_county, 'Nassau');
  b.cleanup();
});

test('deleting a sale also deletes its refunds; undo restores both', () => {
  const b = makeBooks();
  const id = b.call('sales.create', saleInput());
  const r1 = b.call('refunds.create', { original_sale_id: id, sale_date: '2026-10-05', subtotal: '10.00' });
  const r2 = b.call('refunds.create', { original_sale_id: id, sale_date: '2026-10-06', subtotal: '10.00' });
  b.call('sales.delete', { id: r2 }); // deleted on its own first
  const res = b.call('sales.delete', { id });
  assert.equal(res.count, 2);
  assert.equal(b.call('sales.list').rows.length, 0);
  // A refund can't come back without its sale.
  assert.throws(() => b.call('sales.restore', { id: r1 }), /original sale first/);
  b.call('sales.restore', { id });
  const rows = b.call('sales.list').rows.map((r) => r.id).sort();
  assert.deepEqual(rows, [id, r1].sort()); // r2 stays deleted — it was deleted separately
  // Trash lists r2 but not the refund that travels with its sale.
  const t = b.call('trash.list');
  assert.deepEqual(t.sales.map((s) => s.id), [r2]);
  b.cleanup();
});

test('restoring a refund that would over-refund is refused', () => {
  const b = makeBooks();
  const id = b.call('sales.create', saleInput());
  const r1 = b.call('refunds.create', { original_sale_id: id, sale_date: '2026-10-05', subtotal: '100.00' });
  b.call('sales.delete', { id: r1 });
  b.call('refunds.create', { original_sale_id: id, sale_date: '2026-10-05', subtotal: '100.00' });
  assert.throws(() => b.call('trash.restore', { type: 'sale', id: r1 }), ConflictError);
  b.cleanup();
});

test('listing filters and totals', () => {
  const b = makeBooks();
  b.call('sales.create', saleInput({ sale_date: '2026-01-10', is_custom: true, description: 'Custom console panel' }));
  b.call('sales.create', saleInput({ sale_date: '2026-02-10', channel: 'shopify', order_number: '#1001' }));
  const s3 = b.call('sales.create', saleInput({ sale_date: '2026-03-10' }));
  b.call('refunds.create', { original_sale_id: s3, sale_date: '2026-03-11', subtotal: '100.00' });
  assert.equal(b.call('sales.list', { custom: 'custom' }).rows.length, 1);
  assert.equal(b.call('sales.list', { channel: 'shopify' }).rows.length, 1);
  assert.equal(b.call('sales.list', { search: 'console' }).rows.length, 1);
  assert.equal(b.call('sales.list', { search: '1001' }).rows.length, 1);
  const feb = b.call('sales.list', { from: '2026-02-01', to: '2026-03-31' });
  assert.equal(feb.rows.length, 3);
  assert.equal(feb.totals.subtotal, 10000 + 10000 - 10000);
  assert.throws(() => b.call('sales.list', { from: '2026-05-01', to: '2026-04-01' }), ValidationError);
  // SQL wildcard characters in a search are taken literally.
  assert.equal(b.call('sales.list', { search: '%' }).rows.length, 0);
  b.cleanup();
});
