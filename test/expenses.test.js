import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeBooks, saleInput, tempDir } from './helpers.js';
import { ValidationError, ConflictError } from '../src/core/errors.js';

function expense(b, over = {}) {
  return {
    expense_date: '2026-10-02',
    vendor: 'Acme Plastics',
    category_id: b.cat('Materials'),
    amount: '250.00',
    payment_method_id: b.pm('Business credit card'),
    ...over,
  };
}

test('expenses validate and store cents; vendor credits are negative', () => {
  const b = makeBooks();
  const id = b.call('expenses.create', expense(b, { amount: '$1,019.99' }));
  assert.equal(b.call('expenses.get', { id }).amount_cents, 101999);
  const credit = b.call('expenses.create', expense(b, { amount: '-25.00', notes: 'Returned damaged sheet' }));
  assert.equal(b.call('expenses.get', { id: credit }).amount_cents, -2500);
  assert.throws(() => b.call('expenses.create', expense(b, { amount: '0' })), ValidationError);
  assert.throws(() => b.call('expenses.create', expense(b, { vendor: '  ' })), ValidationError);
  assert.throws(() => b.call('expenses.create', expense(b, { category_id: 9999 })), ValidationError);
  assert.throws(() => b.call('expenses.create', expense(b, { payment_method_id: '' })), ValidationError);
  assert.equal(b.call('expenses.list').totals.amount, 101999 - 2500);
  b.cleanup();
});

test('receipts are copied into the data folder with a relative path', () => {
  const b = makeBooks();
  const src = tempDir();
  const pdf = path.join(src, 'invoice 123.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4 fake receipt');
  const id = b.call('expenses.create', expense(b, { receipt_paths: [pdf] }));
  const e = b.call('expenses.get', { id });
  assert.equal(e.receipts.length, 1);
  const r = e.receipts[0];
  assert.match(r.rel_path, /^receipts\/2026\/2026-10-02_acme-plastics_[0-9a-f]{8}\.pdf$/);
  assert.equal(r.original_name, 'invoice 123.pdf');
  const stored = b.call('receipts.path', { id: r.id });
  assert.equal(fs.readFileSync(stored, 'utf8'), '%PDF-1.4 fake receipt');
  assert.ok(stored.startsWith(b.dataDir));

  // Removing a receipt is a soft delete; the file stays for undo.
  b.call('expenses.update', { id, ...expense(b), remove_receipt_ids: [r.id] });
  assert.equal(b.call('expenses.get', { id }).receipts.length, 0);
  assert.ok(fs.existsSync(stored));
  b.call('trash.restore', { type: 'receipt', id: r.id });
  assert.equal(b.call('expenses.get', { id }).receipts.length, 1);

  // Unsupported or missing files are rejected before anything is saved.
  const exe = path.join(src, 'thing.exe');
  fs.writeFileSync(exe, 'MZ');
  assert.throws(() => b.call('expenses.create', expense(b, { receipt_paths: [exe] })), /supported receipt type/);
  assert.throws(() => b.call('expenses.create', expense(b, { receipt_paths: [path.join(src, 'nope.pdf')] })), /not found/);
  assert.equal(b.call('expenses.list').rows.length, 1);
  fs.rmSync(src, { recursive: true, force: true });
  b.cleanup();
});

test('categories in use are archived, not deleted; names stay unique', () => {
  const b = makeBooks();
  const cat = b.cat('Tooling');
  b.call('expenses.create', expense(b, { category_id: cat }));
  assert.throws(() => b.call('categories.delete', { id: cat }), ConflictError);
  b.call('categories.save', { id: cat, name: 'Tooling / bits', schedule_c_line: 'Line 22 — Supplies', active: false });
  assert.throws(() => b.call('expenses.create', expense(b, { category_id: cat })), /archived/);
  assert.throws(() => b.call('categories.save', { name: 'tooling / BITS' }), /already a category/);
  const newCat = b.call('categories.save', { name: 'Repairs & maintenance', schedule_c_line: 'Line 21' });
  b.call('categories.delete', { id: newCat });
  b.call('trash.restore', { type: 'category', id: newCat });
  b.cleanup();
});

test('expenses paid with personal funds count as owed to the owner', () => {
  const b = makeBooks({ today: '2026-11-25' });
  const personal = b.pm('Personal funds');
  b.call('expenses.create', expense(b, { payment_method_id: personal, amount: '300.00' }));
  b.call('expenses.create', expense(b, { payment_method_id: personal, amount: '200.00', expense_date: '2025-12-15' }));
  b.call('expenses.create', expense(b, { amount: '999.00' })); // business card — not owner funds
  let s = b.call('owner.summary');
  assert.equal(s.contributed_all, 50000);
  assert.equal(s.contributed_year, 30000);
  assert.equal(s.owed_to_owner, 50000);

  const r = b.call('owner.createReimbursement', { reimbursement_date: '2026-11-01', amount: '150.00' });
  s = b.call('owner.summary');
  assert.equal(s.reimbursed_all, 15000);
  assert.equal(s.owed_to_owner, 35000);
  assert.throws(() => b.call('owner.createReimbursement', { reimbursement_date: '2026-11-02', amount: '350.01' }), /more than the business owes/);
  b.call('owner.updateReimbursement', { id: r, reimbursement_date: '2026-11-01', amount: '500.00' }); // editing excludes itself
  assert.equal(b.call('owner.summary').owed_to_owner, 0);
  // Any payment method can be flagged as owner funds.
  b.call('paymentMethods.save', { name: 'Personal Amex', is_owner_funds: true });
  b.call('expenses.create', expense(b, { payment_method_id: b.pm('Personal Amex'), amount: '20.00' }));
  assert.equal(b.call('owner.summary').owed_to_owner, 2000);
  assert.equal(b.call('dashboard.get').owner.owed_to_owner, 2000);
  b.cleanup();
});

test('set-aside: income tax at the % of net profit, sales tax at 100% of net tax', () => {
  const b = makeBooks({ today: '2026-11-25' });
  // Revenue 10,000.00 (+ 600.00 tax collected); expenses 2,000.00 → profit 8,000.00
  const s = b.call('sales.create', saleInput({ sale_date: '2026-03-01', subtotal: '10000.00', shipping: '0', tax: '862.50' }));
  b.call('refunds.create', { original_sale_id: s, sale_date: '2026-03-05', subtotal: '0', tax: '262.50' });
  b.call('expenses.create', expense(b, { amount: '2000.00' }));
  let sum = b.call('setAside.summary', { year: 2026 });
  assert.equal(sum.income.basis_cents, 800000);
  assert.equal(sum.income.target, 200000); // 25%
  assert.equal(sum.salesTax.target, 60000); // 862.50 − 262.50
  assert.equal(sum.combined.target, 260000);
  assert.equal(sum.combined.remaining, 260000);

  b.call('setAside.create', { entry_date: '2026-04-01', bucket: 'income_tax', entry_type: 'deposit', amount: '1500.00' });
  b.call('setAside.create', { entry_date: '2026-04-01', bucket: 'sales_tax', entry_type: 'deposit', amount: '600.00' });
  b.call('setAside.create', { entry_date: '2026-05-01', bucket: 'income_tax', entry_type: 'withdrawal', amount: '100.00' });
  // Paying NY from savings doesn't count against progress, only the balance.
  b.call('setAside.create', { entry_date: '2026-06-20', bucket: 'sales_tax', entry_type: 'tax_payment', amount: '600.00' });
  // A January deposit can be credited to the prior tax year.
  b.call('setAside.create', { entry_date: '2027-01-10', tax_year: '2026', bucket: 'income_tax', entry_type: 'deposit', amount: '50.00' });

  sum = b.call('setAside.summary', { year: 2026 });
  assert.equal(sum.income.moved, 150000 - 10000 + 5000);
  assert.equal(sum.income.remaining, 200000 - 145000);
  assert.equal(sum.salesTax.moved, 60000);
  assert.equal(sum.salesTax.remaining, 0);
  assert.equal(sum.salesTax.expected_balance, 0);
  assert.equal(sum.combined.remaining, 55000); // "move $550.00 more"
  assert.equal(sum.combined.expected_balance, 145000);

  // Changing the % recomputes the year.
  b.call('settings.update', { business_name: 'MMA Milling LLC', set_aside_percent: '30', default_state: 'NY', default_county: 'Suffolk' });
  assert.equal(b.call('setAside.summary', { year: 2026 }).income.target, 240000);

  // A losing year has no income-tax target.
  b.call('expenses.create', expense(b, { amount: '20000.00' }));
  assert.equal(b.call('setAside.summary', { year: 2026 }).income.target, 0);

  assert.throws(() => b.call('setAside.create', { entry_date: '2026-04-01', bucket: 'other', entry_type: 'deposit', amount: '5' }), ValidationError);
  assert.throws(() => b.call('setAside.create', { entry_date: '2026-04-01', bucket: 'sales_tax', entry_type: 'deposit', amount: '-5' }), ValidationError);
  b.cleanup();
});
