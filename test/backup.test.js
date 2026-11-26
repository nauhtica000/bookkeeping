import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir, saleInput } from './helpers.js';
import { openDatabase, inspectDatabaseFile, DB_FILE_NAME } from '../src/core/db.js';
import { createBooks } from '../src/core/books.js';
import { runBackup, rotateAutoBackups, restoreDatabaseFile, listBackupFiles, missingReceiptFiles, AUTO_KEEP } from '../src/core/backup.js';

function setup() {
  const dataDir = tempDir();
  const dbPath = path.join(dataDir, DB_FILE_NAME);
  let db = openDatabase(dbPath);
  const books = () => createBooks({ db, dataDir });
  return {
    dataDir,
    dbPath,
    get db() {
      return db;
    },
    reopen() {
      db.close();
      db = openDatabase(dbPath);
    },
    close() {
      db.close();
    },
    books,
  };
}

test('automatic backup snapshots the database and mirrors receipts to the backup folder', async () => {
  const s = setup();
  const share = tempDir();
  const b = s.books();
  b.api['sales.create'](saleInput());
  fs.mkdirSync(path.join(s.dataDir, 'receipts', '2026'), { recursive: true });
  fs.writeFileSync(path.join(s.dataDir, 'receipts', '2026', 'r1.pdf'), 'receipt');

  const res = await runBackup(s.db, s.dataDir, { kind: 'auto', externalFolder: share });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results.length, 2);
  const local = listBackupFiles(path.join(s.dataDir, 'backups', 'auto'));
  const remote = listBackupFiles(path.join(share, 'auto'));
  assert.equal(local.length, 1);
  assert.equal(remote.length, 1);
  assert.ok(inspectDatabaseFile(remote[0].path).ok);
  assert.equal(fs.readFileSync(path.join(share, 'receipts', '2026', 'r1.pdf'), 'utf8'), 'receipt');
  assert.ok(!fs.readdirSync(path.join(share, 'auto')).some((f) => f.endsWith('.partial')));

  // The backup really contains the data.
  const copy = openDatabase(remote[0].path, { readonly: true });
  assert.equal(copy.prepare('SELECT count(*) AS n FROM sales').get().n, 1);
  copy.close();
  s.close();
});

test('only the newest 30 automatic backups are kept', () => {
  const dir = tempDir();
  for (let i = 1; i <= 35; i++) fs.writeFileSync(path.join(dir, `mma-books-auto-2026-01-${String(i % 28 + 1).padStart(2, '0')}_${String(100000 + i)}.db`), '');
  fs.writeFileSync(path.join(dir, 'mma-books-2026-01-01_000000.db'), ''); // a manual backup: never rotated
  fs.writeFileSync(path.join(dir, 'notes.txt'), '');
  const removed = rotateAutoBackups(dir);
  assert.equal(removed.length, 35 - AUTO_KEEP);
  const left = fs.readdirSync(dir);
  assert.equal(left.filter((f) => f.startsWith('mma-books-auto-')).length, AUTO_KEEP);
  assert.ok(left.includes('mma-books-2026-01-01_000000.db'));
  assert.ok(left.includes('notes.txt'));
  // The oldest names were the ones removed.
  const kept = left.filter((f) => f.startsWith('mma-books-auto-')).sort();
  assert.ok(removed.every((r) => r < kept[0]));
});

test('an unreachable backup folder is reported, and the local backup still happens', async () => {
  const s = setup();
  const res = await runBackup(s.db, s.dataDir, { kind: 'auto', externalFolder: path.join(s.dataDir, 'no', 'such', 'share') });
  assert.equal(res.ok, false);
  assert.equal(res.results[0].ok, true);
  assert.equal(res.results[1].ok, false);
  assert.match(res.results[1].error, /not found/);
  await assert.rejects(runBackup(s.db, s.dataDir, { kind: 'manual' }), /Choose a backup folder/);
  s.close();
});

test('manual backup goes to <folder>/manual and leaves no temp file', async () => {
  const s = setup();
  const share = tempDir();
  const res = await runBackup(s.db, s.dataDir, { kind: 'manual', externalFolder: share });
  assert.equal(res.ok, true);
  assert.equal(listBackupFiles(path.join(share, 'manual')).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(s.dataDir, 'backups', 'tmp')), []);
  s.close();
});

test('restore replaces the database, keeps a pre-restore copy, and brings receipts back', async () => {
  const s = setup();
  const share = tempDir();
  s.books().api['sales.create'](saleInput({ description: 'before backup' }));
  fs.mkdirSync(path.join(s.dataDir, 'receipts', '2026'), { recursive: true });
  fs.writeFileSync(path.join(s.dataDir, 'receipts', '2026', 'r1.pdf'), 'receipt');
  s.db.prepare(
    "INSERT INTO expense_receipts (expense_id, rel_path, original_name, mime, size_bytes, sha256, created_at, updated_at) VALUES (?, 'receipts/2026/r1.pdf', 'r1.pdf', 'application/pdf', 7, 'x', 'now', 'now')",
  ).run(
    s.books().api['expenses.create']({
      expense_date: '2026-10-01',
      vendor: 'Acme',
      category_id: 1,
      amount: '5',
      payment_method_id: 1,
    }),
  );
  const res = await runBackup(s.db, s.dataDir, { kind: 'manual', externalFolder: share });
  const backupFile = res.results[0].file;

  s.books().api['sales.create'](saleInput({ description: 'after backup' }));
  fs.rmSync(path.join(s.dataDir, 'receipts'), { recursive: true, force: true }); // lose the receipts
  s.close();

  const r = await restoreDatabaseFile({ dbPath: s.dbPath, dataDir: s.dataDir, backupFile });
  assert.ok(r.preRestoreFile && fs.existsSync(r.preRestoreFile));
  assert.equal(r.receiptsCopied, 1);
  const db = openDatabase(s.dbPath);
  const descs = db.prepare('SELECT description FROM sales').all().map((x) => x.description);
  assert.deepEqual(descs, ['before backup']);
  assert.deepEqual(missingReceiptFiles(db, s.dataDir), []);
  db.close();
  // The pre-restore copy has the newer data.
  const pre = openDatabase(r.preRestoreFile, { readonly: true });
  assert.equal(pre.prepare('SELECT count(*) AS n FROM sales').get().n, 2);
  pre.close();
});

test('restore refuses files that are not MMA Books databases', async () => {
  const s = setup();
  const bogus = path.join(tempDir(), 'bogus.db');
  fs.writeFileSync(bogus, 'this is not sqlite');
  await assert.rejects(restoreDatabaseFile({ dbPath: s.dbPath, dataDir: s.dataDir, backupFile: bogus }), /Could not read|not an MMA Books/);
  // A real SQLite file that isn't ours.
  const other = path.join(tempDir(), 'other.db');
  const { default: Database } = await import('better-sqlite3');
  const o = new Database(other);
  o.exec('CREATE TABLE t (x)');
  o.close();
  assert.match(inspectDatabaseFile(other).message, /not an MMA Books database/);
  assert.throws(() => openDatabase(other), /not an MMA Books database/);
  s.close();
});
