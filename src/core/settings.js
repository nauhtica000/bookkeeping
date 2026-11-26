import { DEFAULT_SETTINGS } from './migrations.js';
import { FieldErrors } from './errors.js';
import { cleanText, requiredText } from './util.js';
import { parsePercentToBasisPoints } from '../shared/money.js';
import { isValidStateCode, normalizeNyCounty, OUTSIDE_US } from '../shared/geo.js';

export function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : (DEFAULT_SETTINGS[key] ?? null);
}

export function setSetting(db, key, value, now) {
  db.prepare(
    `INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, String(value), now, now);
}

export function getAllSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return {
    business_name: out.business_name,
    set_aside_bp: Number(out.set_aside_bp),
    default_state: out.default_state,
    default_county: out.default_county,
    default_locality: out.default_locality,
    backup_folder: out.backup_folder,
  };
}

// Update the user-editable business settings.
export function updateBusinessSettings(db, input, now) {
  const errs = new FieldErrors();
  const name = errs.capture('business_name', () => requiredText(input.business_name, { label: 'Business name', max: 120 }));
  const bp = errs.capture('set_aside_percent', () =>
    parsePercentToBasisPoints(input.set_aside_percent, { label: 'Set-aside percentage' }),
  );
  const state = String(input.default_state || '').trim().toUpperCase();
  if (!isValidStateCode(state) || state === OUTSIDE_US) errs.add('default_state', 'Choose a US state.');
  let county = errs.capture('default_county', () => cleanText(input.default_county, { label: 'County', max: 60 }), '');
  if (state === 'NY') {
    const c = normalizeNyCounty(county);
    if (!c) errs.add('default_county', 'Choose a New York county.');
    else county = c;
  }
  const locality = errs.capture('default_locality', () => cleanText(input.default_locality, { label: 'Locality', max: 60 }), '');
  errs.throwIfAny();
  db.transaction(() => {
    setSetting(db, 'business_name', name, now);
    setSetting(db, 'set_aside_bp', bp, now);
    setSetting(db, 'default_state', state, now);
    setSetting(db, 'default_county', county, now);
    setSetting(db, 'default_locality', locality, now);
  })();
  return getAllSettings(db);
}
