import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidDate,
  nySalesTaxQuarter,
  recentNySalesTaxQuarters,
  calendarQuarterRange,
  monthRange,
  yearToDateRange,
  addDays,
  weekday,
  parseLooseDate,
} from '../src/shared/dates.js';

test('isValidDate checks real calendar dates', () => {
  assert.ok(isValidDate('2026-02-28'));
  assert.ok(isValidDate('2028-02-29'));
  assert.ok(!isValidDate('2026-02-29'));
  assert.ok(!isValidDate('2026-13-01'));
  assert.ok(!isValidDate('2026-1-5'));
  assert.ok(!isValidDate('11/25/2026'));
  assert.ok(!isValidDate(''));
  assert.ok(!isValidDate(null));
});

test('NY sales tax quarters: Mar–May, Jun–Aug, Sep–Nov, Dec–Feb', () => {
  const q = (d) => {
    const r = nySalesTaxQuarter(d);
    return `${r.start}..${r.end}`;
  };
  assert.equal(q('2026-03-01'), '2026-03-01..2026-05-31');
  assert.equal(q('2026-05-31'), '2026-03-01..2026-05-31');
  assert.equal(q('2026-06-01'), '2026-06-01..2026-08-31');
  assert.equal(q('2026-08-31'), '2026-06-01..2026-08-31');
  assert.equal(q('2026-09-01'), '2026-09-01..2026-11-30');
  assert.equal(q('2026-11-30'), '2026-09-01..2026-11-30');
  // Dec–Feb crosses the year boundary.
  assert.equal(q('2026-12-01'), '2026-12-01..2027-02-28');
  assert.equal(q('2027-01-15'), '2026-12-01..2027-02-28');
  assert.equal(q('2027-02-28'), '2026-12-01..2027-02-28');
  // Leap year February.
  assert.equal(q('2028-02-29'), '2027-12-01..2028-02-29');
  assert.equal(q('2027-12-31'), '2027-12-01..2028-02-29');
});

test('NY quarter due dates are the 20th, moved past weekends', () => {
  const sepNov = nySalesTaxQuarter('2026-10-10');
  assert.equal(sepNov.statutoryDue, '2026-12-20'); // a Sunday
  assert.equal(sepNov.due, '2026-12-21');
  assert.match(sepNov.dueNote, /Sunday/);
  const decFeb = nySalesTaxQuarter('2026-01-10');
  assert.equal(decFeb.due, '2026-03-20'); // a Friday
  for (const qq of recentNySalesTaxQuarters('2026-11-25', 40)) {
    assert.ok(weekday(qq.due) !== 0 && weekday(qq.due) !== 6, `${qq.due} is a weekend`);
    assert.ok(qq.due >= qq.statutoryDue);
  }
});

test('recent NY quarters are contiguous with no gaps or overlaps', () => {
  const list = recentNySalesTaxQuarters('2026-11-25', 12);
  assert.equal(list.length, 12);
  assert.equal(list[0].start, '2026-09-01');
  for (let i = 0; i < list.length - 1; i++) {
    assert.equal(addDays(list[i + 1].end, 1), list[i].start);
  }
});

test('calendar periods', () => {
  assert.deepEqual(
    [calendarQuarterRange('2026-11-25').start, calendarQuarterRange('2026-11-25').end],
    ['2026-10-01', '2026-12-31'],
  );
  assert.equal(calendarQuarterRange('2026-03-31').end, '2026-03-31');
  assert.equal(monthRange('2028-02-10').end, '2028-02-29');
  assert.equal(monthRange('2026-02-10').end, '2026-02-28');
  assert.deepEqual([yearToDateRange('2026-11-25').start, yearToDateRange('2026-11-25').end], ['2026-01-01', '2026-11-25']);
});

test('parseLooseDate reads Shopify timestamps by their written calendar date', () => {
  assert.equal(parseLooseDate('2026-03-14 10:22:01 -0400'), '2026-03-14');
  assert.equal(parseLooseDate('2026-03-14 23:59:59 -0500'), '2026-03-14');
  assert.equal(parseLooseDate('2026-03-14T01:00:00Z'), '2026-03-14');
  assert.equal(parseLooseDate('3/4/2026'), '2026-03-04');
  assert.equal(parseLooseDate('2026-02-30 10:00:00'), null);
  assert.equal(parseLooseDate('yesterday'), null);
  assert.equal(parseLooseDate(''), null);
});
