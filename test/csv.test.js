import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvRows, parseCsv, toCsv, csvField, CsvError } from '../src/core/csv.js';

test('parses plain and quoted fields', () => {
  assert.deepEqual(parseCsvRows('a,b,c\n1,2,3\n'), [
    ['a', 'b', 'c'],
    ['1', '2', '3'],
  ]);
  assert.deepEqual(parseCsvRows('"a,1","say ""hi""",c'), [['a,1', 'say "hi"', 'c']]);
  assert.deepEqual(parseCsvRows('x,,z\n'), [['x', '', 'z']]);
  assert.deepEqual(parseCsvRows('"",""'), [['', '']]);
});

test('handles newlines inside quotes and all line-ending styles', () => {
  assert.deepEqual(parseCsvRows('a,"line1\nline2",c\r\nd,e,f'), [
    ['a', 'line1\nline2', 'c'],
    ['d', 'e', 'f'],
  ]);
  assert.deepEqual(parseCsvRows('a\rb\r\nc\n'), [['a'], ['b'], ['c']]);
});

test('strips a UTF-8 byte-order mark and drops blank lines', () => {
  const { headers, records } = parseCsv('﻿Name,Total\n#1001,10.00\n\n#1002,5.00\n');
  assert.deepEqual(headers, ['Name', 'Total']);
  assert.equal(records.length, 2);
  assert.equal(records[1].values.Name, '#1002');
  assert.equal(records[1].line, 4);
});

test('short rows get blank values; duplicate headers are renamed', () => {
  const { headers, records } = parseCsv('A,B,A\n1\n');
  assert.deepEqual(headers, ['A', 'B', 'A (2)']);
  assert.deepEqual(records[0].values, { A: '1', B: '', 'A (2)': '' });
});

test('reports malformed CSV with a line number', () => {
  assert.throws(() => parseCsvRows('a,b\n"unterminated,c\n'), (e) => e instanceof CsvError && e.line === 2);
  assert.throws(() => parseCsvRows('a,b"c"\n'), CsvError);
  assert.throws(() => parseCsvRows('"a"b\n'), CsvError);
  assert.throws(() => parseCsv(''), /empty/);
});

test('csvField quotes when needed and defuses spreadsheet formulas in text', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('two\nlines'), '"two\nlines"');
  assert.equal(csvField(' padded'), '" padded"');
  assert.equal(csvField('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvField('+1 555'), "'+1 555");
  assert.equal(csvField('@cmd'), "'@cmd");
  // Numeric columns are left alone so negatives stay numbers.
  assert.equal(csvField('-12.50', { text: false }), '-12.50');
  assert.equal(csvField(null), '');
});

test('toCsv writes BOM + CRLF and round-trips through the parser', () => {
  const rows = [
    { name: 'Acme, Inc.', note: 'line1\nline2', amt: '-5.00' },
    { name: 'Bob "B"', note: '', amt: '12.00' },
  ];
  const out = toCsv(
    [
      { header: 'Name', key: 'name' },
      { header: 'Note', key: 'note' },
      { header: 'Amount', key: 'amt', numeric: true },
    ],
    rows,
  );
  assert.ok(out.startsWith('﻿Name,Note,Amount\r\n'));
  const back = parseCsv(out);
  assert.deepEqual(
    back.records.map((r) => r.values),
    [
      { Name: 'Acme, Inc.', Note: 'line1\nline2', Amount: '-5.00' },
      { Name: 'Bob "B"', Note: '', Amount: '12.00' },
    ],
  );
});
