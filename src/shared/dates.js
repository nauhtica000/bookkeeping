// Calendar-date helpers. Dates are plain 'YYYY-MM-DD' strings (no time of day,
// no time zone), which sort and compare correctly as strings.
// Shared by the main process and the renderer.

export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad2 = (n) => String(n).padStart(2, '0');

export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y, m) {
  // m is 1-12
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

export function makeDate(y, m, d) {
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

export function isValidDate(s) {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2200) return false;
  if (mo < 1 || mo > 12) return false;
  return d >= 1 && d <= daysInMonth(y, mo);
}

export function parseDate(s) {
  if (!isValidDate(s)) throw new Error(`Invalid date: ${s}`);
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)), d: Number(s.slice(8, 10)) };
}

// Today's date on the user's own clock.
export function todayLocal(now = new Date()) {
  return makeDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

// Convert a JS Date to the local calendar date string.
export function dateToLocalString(dt) {
  return makeDate(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

export function addDays(s, n) {
  const { y, m, d } = parseDate(s);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return makeDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function weekday(s) {
  const { y, m, d } = parseDate(s);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function formatDateLong(s) {
  const { y, m, d } = parseDate(s);
  return `${MONTH_SHORT[m - 1]} ${d}, ${y}`;
}

// "2026-11-25" -> "11/25/2026"
export function formatDateUS(s) {
  if (!isValidDate(s)) return s ?? '';
  const { y, m, d } = parseDate(s);
  return `${pad2(m)}/${pad2(d)}/${y}`;
}

export function monthRange(s) {
  const { y, m } = parseDate(s);
  return { start: makeDate(y, m, 1), end: makeDate(y, m, daysInMonth(y, m)), label: `${MONTH_SHORT[m - 1]} ${y}` };
}

// Calendar quarter: Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec.
export function calendarQuarterRange(s) {
  const { y, m } = parseDate(s);
  const q = Math.floor((m - 1) / 3);
  const sm = q * 3 + 1;
  const em = sm + 2;
  return {
    start: makeDate(y, sm, 1),
    end: makeDate(y, em, daysInMonth(y, em)),
    label: `Q${q + 1} ${y} (${MONTH_SHORT[sm - 1]}–${MONTH_SHORT[em - 1]})`,
  };
}

export function yearToDateRange(s) {
  const { y } = parseDate(s);
  return { start: makeDate(y, 1, 1), end: s, label: `${y} year to date` };
}

export function yearRange(y) {
  return { start: makeDate(y, 1, 1), end: makeDate(y, 12, 31), label: String(y) };
}

// New York State sales tax quarterly filing periods:
//   Mar 1 – May 31   (due Jun 20)
//   Jun 1 – Aug 31   (due Sep 20)
//   Sep 1 – Nov 30   (due Dec 20)
//   Dec 1 – Feb 28/29 of the following year (due Mar 20)
// The "period year" used for naming is the year the period starts in.
function nyQuarterFromStart(startYear, startMonth) {
  let endYear = startYear;
  let endMonth = startMonth + 2;
  if (endMonth > 12) {
    endMonth -= 12;
    endYear += 1;
  }
  const start = makeDate(startYear, startMonth, 1);
  const end = makeDate(endYear, endMonth, daysInMonth(endYear, endMonth));
  let dueMonth = endMonth + 1;
  let dueYear = endYear;
  if (dueMonth > 12) {
    dueMonth = 1;
    dueYear += 1;
  }
  const statutoryDue = makeDate(dueYear, dueMonth, 20);
  // If the 20th falls on a weekend the return is due the next business day.
  // (Legal holidays can push it further; those aren't tracked here.)
  let due = statutoryDue;
  while (weekday(due) === 0 || weekday(due) === 6) due = addDays(due, 1);
  const label = `${MONTH_SHORT[startMonth - 1]} 1, ${startYear} – ${MONTH_SHORT[endMonth - 1]} ${daysInMonth(endYear, endMonth)}, ${endYear}`;
  return {
    id: `ny-${start}`,
    start,
    end,
    label,
    shortLabel: `${MONTH_SHORT[startMonth - 1]}–${MONTH_SHORT[endMonth - 1]} ${startYear === endYear ? startYear : `${startYear}/${String(endYear).slice(2)}`}`,
    statutoryDue,
    due,
    dueNote:
      due === statutoryDue
        ? `Due ${formatDateLong(due)}`
        : `Due ${formatDateLong(due)} (the 20th is a ${WEEKDAY[weekday(statutoryDue)]})`,
  };
}

export function nySalesTaxQuarter(s) {
  const { y, m } = parseDate(s);
  if (m === 12) return nyQuarterFromStart(y, 12);
  if (m <= 2) return nyQuarterFromStart(y - 1, 12);
  if (m <= 5) return nyQuarterFromStart(y, 3);
  if (m <= 8) return nyQuarterFromStart(y, 6);
  return nyQuarterFromStart(y, 9);
}

// List NY quarters, most recent first, starting from the quarter containing
// `asOf` and going back `count` quarters.
export function recentNySalesTaxQuarters(asOf, count = 12) {
  const out = [];
  let q = nySalesTaxQuarter(asOf);
  for (let i = 0; i < count; i++) {
    out.push(q);
    q = nySalesTaxQuarter(addDays(q.start, -1));
  }
  return out;
}

// Months of a year as [{ month: 1..12, start, end, label }]
export function monthsOfYear(y) {
  return MONTH_SHORT.map((label, i) => ({
    month: i + 1,
    start: makeDate(y, i + 1, 1),
    end: makeDate(y, i + 1, daysInMonth(y, i + 1)),
    label,
  }));
}

// Parse a date/time as Shopify writes it ("2026-03-14 10:22:01 -0400") or a
// plain US date ("3/14/2026") into a 'YYYY-MM-DD' string. Uses the calendar
// date as written (the store's local date), never converting time zones.
export function parseLooseDate(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) {
    const out = makeDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return isValidDate(out) ? out : null;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s.*)?$/.exec(s);
  if (m) {
    const out = makeDate(Number(m[3]), Number(m[1]), Number(m[2]));
    return isValidDate(out) ? out : null;
  }
  return null;
}
