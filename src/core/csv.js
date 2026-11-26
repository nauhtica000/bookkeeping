// RFC 4180 CSV parsing and writing, written by hand (no dependency).
// Handles: quoted fields, "" escapes, commas and newlines inside quotes,
// CRLF / LF / CR line endings, a UTF-8 byte-order mark, and a trailing newline.

export class CsvError extends Error {
  constructor(message, line) {
    super(line ? `${message} (line ${line})` : message);
    this.name = 'CsvError';
    this.line = line;
  }
}

// Returns an array of rows; each row is an array of strings with a `line`
// property giving the physical line number the row starts on.
export function parseCsvRows(text) {
  if (typeof text !== 'string') throw new CsvError('CSV input must be text.');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let line = 1;
  let inQuotes = false;
  let quoteStartLine = 0;
  let fieldWasQuoted = false;
  let rowStartLine = 1;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = '';
    fieldWasQuoted = false;
  };
  const endRow = () => {
    endField();
    Object.defineProperty(row, 'line', { value: rowStartLine, enumerable: false });
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        // After a closing quote only a delimiter or line end may follow.
        const next = text[i];
        if (i < n && next !== ',' && next !== '\n' && next !== '\r') {
          throw new CsvError('Unexpected character after a closing quote', line);
        }
        continue;
      }
      if (c === '\n') line++;
      if (c === '\r' && text[i + 1] !== '\n') line++;
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      if (field.length > 0 || fieldWasQuoted) {
        throw new CsvError('A quote appeared in the middle of an unquoted field', line);
      }
      inQuotes = true;
      fieldWasQuoted = true;
      quoteStartLine = line;
      i++;
      continue;
    }
    if (c === ',') {
      endField();
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      endRow();
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++;
      line++;
      rowStartLine = line;
      continue;
    }
    field += c;
    i++;
  }
  if (inQuotes) throw new CsvError('A quoted field was never closed', quoteStartLine);
  // Last row (no trailing newline), but ignore a completely empty final line.
  if (field.length > 0 || row.length > 0 || fieldWasQuoted) endRow();

  // Drop fully blank lines.
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// Parse with a header row. Returns { headers, records } where each record is
// { line, values: { [header]: string } }. Duplicate headers get " (2)" etc.
export function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) throw new CsvError('The file is empty.');
  const seen = new Map();
  const headers = rows[0].map((h) => {
    const base = h.trim();
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
  const records = rows.slice(1).map((r, idx) => {
    const values = {};
    headers.forEach((h, j) => {
      values[h] = r[j] ?? '';
    });
    return { line: r.line ?? idx + 2, values, extra: r.length > headers.length ? r.slice(headers.length) : null };
  });
  return { headers, records };
}

const FORMULA_START = /^[=+\-@\t\r]/;

// Quote a value for CSV output. `text` fields that look like spreadsheet
// formulas get a leading apostrophe so Excel won't execute them (customer
// names and notes can come from outside, e.g. Shopify orders).
export function csvField(value, { text = true } = {}) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (text && FORMULA_START.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// columns: [{ header, key | get(row), numeric?: true }]
export function toCsv(columns, rows) {
  const out = [columns.map((c) => csvField(c.header)).join(',')];
  for (const row of rows) {
    out.push(
      columns
        .map((c) => {
          const v = c.get ? c.get(row) : row[c.key];
          return csvField(v, { text: !c.numeric });
        })
        .join(','),
    );
  }
  // CRLF + BOM so Excel on Windows opens it cleanly as UTF-8.
  return '﻿' + out.join('\r\n') + '\r\n';
}
