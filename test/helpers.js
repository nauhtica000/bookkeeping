import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/core/db.js';
import { createBooks } from '../src/core/books.js';

export function tempDir(prefix = 'mma-books-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A fresh in-memory database with a fixed "today". The clock advances one
// millisecond per call so every timestamp is distinct.
export function makeBooks({ today = '2026-11-25', file = ':memory:' } = {}) {
  const dataDir = tempDir();
  const db = openDatabase(file === ':memory:' ? ':memory:' : path.join(dataDir, file));
  let t = new Date(`${today}T12:00:00`).getTime();
  const clock = () => new Date(t++);
  const books = createBooks({ db, dataDir, clock });
  const call = (method, args) => {
    const fn = books.api[method];
    if (!fn) throw new Error(`No such method: ${method}`);
    return fn(args);
  };
  return {
    ...books,
    call,
    pm: (name) => db.prepare('SELECT id FROM payment_methods WHERE name = ?').get(name).id,
    cat: (namePrefix) => db.prepare('SELECT id FROM expense_categories WHERE name LIKE ?').get(`${namePrefix}%`).id,
    cleanup() {
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// Minimal valid sale input; override what a test cares about.
export function saleInput(over = {}) {
  return {
    sale_date: '2026-10-01',
    channel: 'direct',
    customer_name: 'Test Customer',
    description: 'Hatch cover',
    subtotal: '100.00',
    shipping: '10.00',
    tax: '9.49',
    ship_state: 'NY',
    ship_county: 'Suffolk',
    ...over,
  };
}
