// Backups and restore.
//
// A backup is a consistent snapshot of the database made with SQLite's online
// backup API (safe while the app is open), verified with quick_check, plus a
// mirror of the receipts folder. Files are written under a ".partial" name and
// renamed when complete, so an interrupted copy never looks like a backup.
//
// Layout of a backup folder (e.g. a network share):
//   <folder>/manual/mma-books-2026-11-25_153012.db       (kept forever)
//   <folder>/auto/mma-books-auto-2026-11-25_180501.db    (newest 30 kept)
//   <folder>/receipts/...                                (mirror; only adds)
// Automatic backups are also kept inside the data folder:
//   <data>/backups/auto/mma-books-auto-*.db              (newest 30 kept)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { inspectDatabaseFile } from './db.js';

export const AUTO_KEEP = 30;
const AUTO_RE = /^mma-books-auto-\d{4}-\d{2}-\d{2}_\d{6}(?:-\d+)?\.db$/;
const ANY_BACKUP_RE = /^mma-books-.*\.db$/;

const pad = (n) => String(n).padStart(2, '0');

export function backupStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function uniqueFile(dir, base, ext = '.db') {
  let name = `${base}${ext}`;
  let n = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${base}-${n++}${ext}`;
  return path.join(dir, name);
}

export function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Snapshot the open database to destFile and verify it.
export async function snapshotDatabase(db, destFile) {
  const tmp = `${destFile}.partial`;
  await fsp.mkdir(path.dirname(destFile), { recursive: true });
  try {
    await db.backup(tmp);
    const check = inspectDatabaseFile(tmp);
    if (!check.ok) throw new Error(`Backup verification failed: ${check.message}`);
    await fsp.rename(tmp, destFile);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  return destFile;
}

export async function copyFileVerified(src, dest) {
  const tmp = `${dest}.partial`;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.copyFile(src, tmp);
    const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(tmp)]);
    if (a.size !== b.size) throw new Error(`Copy of ${path.basename(src)} is incomplete.`);
    await fsp.rename(tmp, dest);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return dest;
}

// Keep the newest `keep` automatic backups in a folder; delete older ones.
export function rotateAutoBackups(dir, keep = AUTO_KEEP) {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => AUTO_RE.test(f))
    .sort(); // timestamped names sort chronologically
  const remove = files.slice(0, Math.max(0, files.length - keep));
  for (const f of remove) fs.rmSync(path.join(dir, f), { force: true });
  return remove;
}

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return out;
    throw e;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile() && !e.name.endsWith('.partial')) out.push(p);
  }
  return out;
}

// Copy receipt files that are missing (or a different size) at the
// destination. Never deletes anything at the destination.
export async function mirrorReceipts(fromRoot, toRoot) {
  const src = path.join(fromRoot, 'receipts');
  const files = await walk(src);
  let copied = 0;
  for (const f of files) {
    const rel = path.relative(src, f);
    const dest = path.join(toRoot, 'receipts', rel);
    let needs = true;
    try {
      const [a, b] = await Promise.all([fsp.stat(f), fsp.stat(dest)]);
      needs = a.size !== b.size;
    } catch {
      needs = true;
    }
    if (needs) {
      await copyFileVerified(f, dest);
      copied++;
    }
  }
  return { copied, total: files.length };
}

// Run a backup.
//   kind 'auto'   — snapshot into <data>/backups/auto (keep 30), then copy to
//                   <externalFolder>/auto (keep 30) and mirror receipts.
//   kind 'manual' — snapshot, then copy to <externalFolder>/manual and mirror
//                   receipts. Requires externalFolder.
// Never throws for a destination failure; each destination reports ok/error.
export async function runBackup(db, dataDir, { kind = 'auto', externalFolder = '', timeoutMs = 60000 } = {}) {
  const at = new Date();
  const stamp = backupStamp(at);
  const results = [];
  let localFile = null;

  if (kind === 'auto') {
    const dir = path.join(dataDir, 'backups', 'auto');
    try {
      localFile = await snapshotDatabase(db, uniqueFile(dir, `mma-books-auto-${stamp}`));
      rotateAutoBackups(dir);
      results.push({ dest: dir, ok: true, file: localFile });
    } catch (e) {
      results.push({ dest: dir, ok: false, error: e.message });
    }
  } else {
    if (!externalFolder) throw new Error('Choose a backup folder first.');
    const tmpDir = path.join(dataDir, 'backups', 'tmp');
    try {
      localFile = await snapshotDatabase(db, uniqueFile(tmpDir, `mma-books-${stamp}`));
    } catch (e) {
      results.push({ dest: externalFolder, ok: false, error: e.message });
    }
  }

  if (externalFolder && localFile) {
    const sub = kind === 'auto' ? 'auto' : 'manual';
    const destDir = path.join(externalFolder, sub);
    try {
      const work = (async () => {
        await fsp.access(externalFolder);
        const base = kind === 'auto' ? `mma-books-auto-${stamp}` : `mma-books-${stamp}`;
        const dest = uniqueFile(destDir, base);
        await copyFileVerified(localFile, dest);
        if (kind === 'auto') rotateAutoBackups(destDir);
        const r = await mirrorReceipts(dataDir, externalFolder);
        return { dest, receipts: r };
      })();
      const { dest, receipts } = await withTimeout(
        work,
        timeoutMs,
        `Timed out after ${Math.round(timeoutMs / 1000)} seconds. Is the backup folder reachable?`,
      );
      results.push({ dest: destDir, ok: true, file: dest, receiptsCopied: receipts.copied });
    } catch (e) {
      const msg = e.code === 'ENOENT' ? `Backup folder not found: ${externalFolder}` : e.message;
      results.push({ dest: destDir, ok: false, error: msg });
    }
  }

  if (kind === 'manual' && localFile) await fsp.rm(localFile, { force: true });
  return { at: at.toISOString(), kind, ok: results.length > 0 && results.every((r) => r.ok), results };
}

export function listBackupFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => ANY_BACKUP_RE.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, path: path.join(dir, f), size: st.size, modified: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

// The receipts mirror that sits next to a backup file, if any.
export function receiptsMirrorFor(backupFile) {
  const candidates = [path.join(path.dirname(backupFile), '..', 'receipts'), path.join(path.dirname(backupFile), 'receipts')];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isDirectory()) ?? null;
}

// Replace the data folder's database with a backup. The caller must close
// the database first and reopen it afterwards.
export async function restoreDatabaseFile({ dbPath, dataDir, backupFile }) {
  const check = inspectDatabaseFile(backupFile);
  if (!check.ok) throw new Error(check.message);
  if (path.resolve(backupFile) === path.resolve(dbPath)) throw new Error("That's the database currently in use.");

  let preRestoreFile = null;
  if (fs.existsSync(dbPath)) {
    const preDir = path.join(dataDir, 'backups', 'pre-restore');
    preRestoreFile = await copyFileVerified(dbPath, uniqueFile(preDir, `mma-books-pre-restore-${backupStamp()}`));
  }
  const incoming = `${dbPath}.restoring`;
  await copyFileVerified(backupFile, incoming);
  // A leftover journal from the old database must not be applied to the new one.
  for (const suffix of ['-journal', '-wal', '-shm']) await fsp.rm(dbPath + suffix, { force: true });
  await fsp.rename(incoming, dbPath);

  let receiptsCopied = 0;
  const mirror = receiptsMirrorFor(backupFile);
  if (mirror) {
    const r = await mirrorReceipts(path.dirname(mirror), dataDir);
    receiptsCopied = r.copied;
  }
  return { preRestoreFile, receiptsCopied, receiptsMirror: mirror };
}

// Receipt records whose files are missing from the data folder.
export function missingReceiptFiles(db, dataDir) {
  const rows = db.prepare('SELECT id, rel_path FROM expense_receipts WHERE deleted_at IS NULL').all();
  return rows.filter((r) => !fs.existsSync(path.join(dataDir, ...r.rel_path.split('/'))));
}
