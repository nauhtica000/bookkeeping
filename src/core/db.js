import Database from 'better-sqlite3';
import { migrate, APPLICATION_ID, SCHEMA_VERSION } from './migrations.js';

export const DB_FILE_NAME = 'mma-books.db';

export function nowIso() {
  return new Date().toISOString();
}

// Open (and if needed create + migrate) the bookkeeping database.
export function openDatabase(file, { readonly = false } = {}) {
  const db = new Database(file, { readonly, fileMustExist: readonly });
  try {
    db.pragma('foreign_keys = ON');
    if (!readonly) {
      // Rollback journal (not WAL) keeps everything in the one .db file.
      db.pragma('journal_mode = DELETE');
      db.pragma('synchronous = FULL');
      migrate(db);
    }
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

// Check a file is a readable, intact MMA Books database without modifying it.
// Returns { ok, version, message }.
export function inspectDatabaseFile(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const appId = db.pragma('application_id', { simple: true });
    if (appId !== APPLICATION_ID) return { ok: false, message: 'That file is not an MMA Books database.' };
    const version = db.pragma('user_version', { simple: true });
    if (version > SCHEMA_VERSION) {
      return { ok: false, version, message: 'That backup was made by a newer version of MMA Books. Update the app first.' };
    }
    const check = db.pragma('quick_check', { simple: true });
    if (check !== 'ok') return { ok: false, version, message: `The database file is damaged (${check}).` };
    return { ok: true, version };
  } catch (e) {
    return { ok: false, message: `Could not read the database file: ${e.message}` };
  } finally {
    db?.close();
  }
}
