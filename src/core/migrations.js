// Schema migrations, tracked with PRAGMA user_version. Each migration runs in
// a transaction; never edit a released migration — add a new one instead.

export const APPLICATION_ID = 0x4d4d4142; // "MMAB" — identifies our database files

const TS = `created_at TEXT NOT NULL, updated_at TEXT NOT NULL`;
const TSD = `${TS}, deleted_at TEXT`;
const DATE_OK = (col) => `CHECK (${col} = date(${col}))`;

const SCHEMA_V1 = `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  ${TS}
) STRICT;

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  email TEXT,
  phone TEXT,
  address TEXT,
  notes TEXT,
  ${TSD}
) STRICT;
CREATE INDEX idx_customers_email ON customers(lower(email)) WHERE email IS NOT NULL;
CREATE INDEX idx_customers_name ON customers(lower(name));

CREATE TABLE payment_methods (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  is_owner_funds INTEGER NOT NULL DEFAULT 0 CHECK (is_owner_funds IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  ${TSD}
) STRICT;
CREATE UNIQUE INDEX uq_payment_methods_name ON payment_methods(lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE expense_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  schedule_c_line TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  ${TSD}
) STRICT;
CREATE UNIQUE INDEX uq_expense_categories_name ON expense_categories(lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  rows_read INTEGER NOT NULL,
  orders_read INTEGER NOT NULL,
  sales_created INTEGER NOT NULL,
  refunds_created INTEGER NOT NULL,
  orders_skipped INTEGER NOT NULL,
  mapping_json TEXT NOT NULL,
  ${TSD}
) STRICT;

CREATE TABLE sales (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('sale', 'refund')),
  original_sale_id INTEGER REFERENCES sales(id),
  sale_date TEXT NOT NULL ${DATE_OK('sale_date')},
  customer_id INTEGER REFERENCES customers(id),
  channel TEXT NOT NULL CHECK (channel IN ('shopify', 'direct', 'other')),
  order_number TEXT,
  description TEXT NOT NULL DEFAULT '',
  is_custom INTEGER NOT NULL DEFAULT 0 CHECK (is_custom IN (0, 1)),
  subtotal_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  taxable_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER GENERATED ALWAYS AS (subtotal_cents + shipping_cents + tax_cents) VIRTUAL,
  ship_state TEXT NOT NULL CHECK (length(ship_state) BETWEEN 2 AND 4),
  ship_county TEXT NOT NULL DEFAULT '',
  ship_locality TEXT NOT NULL DEFAULT '',
  payment_method_id INTEGER REFERENCES payment_methods(id),
  notes TEXT NOT NULL DEFAULT '',
  needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
  review_note TEXT NOT NULL DEFAULT '',
  import_batch_id INTEGER REFERENCES import_batches(id),
  ${TSD},
  CHECK (
    (kind = 'sale' AND original_sale_id IS NULL
      AND subtotal_cents >= 0 AND shipping_cents >= 0 AND tax_cents >= 0 AND taxable_cents >= 0)
    OR
    (kind = 'refund' AND original_sale_id IS NOT NULL AND order_number IS NULL
      AND subtotal_cents <= 0 AND shipping_cents <= 0 AND tax_cents <= 0 AND taxable_cents <= 0
      AND (subtotal_cents + shipping_cents + tax_cents) < 0)
  ),
  CHECK (abs(taxable_cents) <= abs(subtotal_cents + shipping_cents))
) STRICT;
CREATE UNIQUE INDEX uq_sales_order_number ON sales(channel, lower(order_number))
  WHERE kind = 'sale' AND order_number IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_sales_date ON sales(sale_date);
CREATE INDEX idx_sales_original ON sales(original_sale_id);
CREATE INDEX idx_sales_batch ON sales(import_batch_id);
CREATE INDEX idx_sales_customer ON sales(customer_id);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY,
  expense_date TEXT NOT NULL ${DATE_OK('expense_date')},
  vendor TEXT NOT NULL CHECK (length(trim(vendor)) > 0),
  category_id INTEGER NOT NULL REFERENCES expense_categories(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id),
  notes TEXT NOT NULL DEFAULT '',
  ${TSD}
) STRICT;
CREATE INDEX idx_expenses_date ON expenses(expense_date);
CREATE INDEX idx_expenses_category ON expenses(category_id);
CREATE INDEX idx_expenses_payment ON expenses(payment_method_id);

CREATE TABLE expense_receipts (
  id INTEGER PRIMARY KEY,
  expense_id INTEGER NOT NULL REFERENCES expenses(id),
  rel_path TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  ${TSD}
) STRICT;
CREATE INDEX idx_receipts_expense ON expense_receipts(expense_id);

CREATE TABLE set_aside_entries (
  id INTEGER PRIMARY KEY,
  entry_date TEXT NOT NULL ${DATE_OK('entry_date')},
  tax_year INTEGER NOT NULL CHECK (tax_year BETWEEN 1900 AND 2200),
  bucket TEXT NOT NULL CHECK (bucket IN ('income_tax', 'sales_tax')),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('deposit', 'withdrawal', 'tax_payment')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  notes TEXT NOT NULL DEFAULT '',
  ${TSD}
) STRICT;
CREATE INDEX idx_set_aside_year ON set_aside_entries(tax_year);

CREATE TABLE owner_reimbursements (
  id INTEGER PRIMARY KEY,
  reimbursement_date TEXT NOT NULL ${DATE_OK('reimbursement_date')},
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  notes TEXT NOT NULL DEFAULT '',
  ${TSD}
) STRICT;

CREATE TABLE zip_county_map (
  zip TEXT PRIMARY KEY CHECK (length(zip) = 5),
  state TEXT NOT NULL,
  county TEXT NOT NULL,
  locality TEXT NOT NULL DEFAULT '',
  ${TS}
) STRICT;
`;

export const DEFAULT_SETTINGS = {
  business_name: 'MMA Milling LLC',
  set_aside_bp: '2500',
  default_state: 'NY',
  default_county: 'Suffolk',
  default_locality: '',
  backup_folder: '',
  shopify_mapping: '',
};

export const DEFAULT_PAYMENT_METHODS = [
  { name: 'Shopify Payments' },
  { name: 'Credit/debit card' },
  { name: 'Cash' },
  { name: 'Check' },
  { name: 'Zelle' },
  { name: 'Venmo' },
  { name: 'PayPal' },
  { name: 'Bank transfer' },
  { name: 'Business credit card' },
  { name: 'Business checking' },
  { name: 'Personal funds', is_owner_funds: 1 },
];

export const DEFAULT_CATEGORIES = [
  { name: 'Materials & supplies (acrylic sheet)', schedule_c_line: 'Part III, line 38 — Materials and supplies (cost of goods sold)' },
  { name: 'Tooling / bits', schedule_c_line: 'Line 22 — Supplies' },
  { name: 'Shipping / postage', schedule_c_line: 'Line 27a — Other expenses' },
  { name: 'Software / subscriptions', schedule_c_line: 'Line 27a — Other expenses' },
  { name: 'Equipment', schedule_c_line: 'Line 13 — Depreciation and section 179 (Form 4562)' },
  { name: 'Advertising', schedule_c_line: 'Line 8 — Advertising' },
  { name: 'Fees (Shopify / payment processing)', schedule_c_line: 'Line 10 — Commissions and fees' },
  { name: 'Other', schedule_c_line: 'Line 27a — Other expenses' },
];

function seedV1(db, now) {
  const setting = db.prepare('INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setting.run(k, v, now, now);

  const pm = db.prepare(
    'INSERT INTO payment_methods (name, is_owner_funds, sort_order, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  );
  DEFAULT_PAYMENT_METHODS.forEach((p, i) => pm.run(p.name, p.is_owner_funds ?? 0, (i + 1) * 10, now, now));

  const cat = db.prepare(
    'INSERT INTO expense_categories (name, schedule_c_line, sort_order, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  );
  DEFAULT_CATEGORIES.forEach((c, i) => cat.run(c.name, c.schedule_c_line, (i + 1) * 10, now, now));
}

export const MIGRATIONS = [
  // v1 — initial schema
  (db, now) => {
    db.exec(SCHEMA_V1);
    seedV1(db, now);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db, now = new Date().toISOString()) {
  const current = db.pragma('user_version', { simple: true });
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `This data file was created by a newer version of MMA Books (schema ${current}; this app knows ${SCHEMA_VERSION}). Update the app before opening it.`,
    );
  }
  if (current === 0) {
    const appId = db.pragma('application_id', { simple: true });
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
    if (tables > 0 && appId !== APPLICATION_ID) {
      throw new Error('This file is not an MMA Books database.');
    }
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db, now);
      db.pragma(`user_version = ${v + 1}`);
      if (v === 0) db.pragma(`application_id = ${APPLICATION_ID}`);
    })();
  }
}
