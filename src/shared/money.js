// Money helpers. All amounts are integer cents. No floating-point math is
// ever used on money: parsing works on the digit string, and anything that
// multiplies (percentages, proportional splits) goes through BigInt.
//
// This module is shared by the main process and the renderer, so it must not
// import anything Node-specific.

export class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MoneyError';
  }
}

const MAX_CENTS = 99_999_999_999_99; // $99,999,999,999.99 — far above anything real

export function assertCents(value, label = 'Amount') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a whole number of cents (got ${String(value)}).`);
  }
  if (Math.abs(value) > MAX_CENTS) {
    throw new MoneyError(`${label} is too large.`);
  }
  return value;
}

// Parse what a person types (or what a CSV contains) into cents.
// Accepts: 12  12.5  12.50  $1,234.56  -12.00  (12.00)  -$5  $-5  " 3.10 "
// Rejects: more than 2 decimal places, letters, misplaced commas, empty input.
// Returns an integer. Throws MoneyError with a human-readable message.
export function parseMoney(input, { allowNegative = true, label = 'Amount' } = {}) {
  if (typeof input === 'number') {
    // Only accept numbers that are already exact to the cent when written out.
    if (!Number.isFinite(input)) throw new MoneyError(`${label} is not a valid number.`);
    input = String(input);
    if (/e/i.test(input)) throw new MoneyError(`${label} is not a valid amount.`);
  }
  if (typeof input !== 'string') throw new MoneyError(`${label} is required.`);
  let s = input.trim();
  if (s === '') throw new MoneyError(`${label} is required.`);

  let negatives = 0;
  if (s.startsWith('(') && s.endsWith(')')) {
    negatives++;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    negatives++;
    s = s.slice(1).trim();
  }
  if (s.startsWith('$')) s = s.slice(1).trim();
  if (s.startsWith('-')) {
    negatives++;
    s = s.slice(1).trim();
  }
  if (negatives > 1) throw new MoneyError(`${label} "${input.trim()}" is not a valid dollar amount.`);
  const negative = negatives === 1;

  const m = /^(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === undefined && (m[2] === undefined || m[2] === ''))) {
    throw new MoneyError(`${label} "${input.trim()}" is not a valid dollar amount.`);
  }
  const whole = (m[1] || '0').replace(/,/g, '');
  const frac = m[2] ?? '';
  if (frac.length > 2) {
    throw new MoneyError(`${label} "${input.trim()}" has more than 2 decimal places.`);
  }
  const cents = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  if (cents > BigInt(MAX_CENTS)) throw new MoneyError(`${label} is too large.`);
  let result = Number(cents);
  if (negative && result !== 0) result = -result;
  if (!allowNegative && result < 0) throw new MoneyError(`${label} can't be negative.`);
  return result;
}

// Like parseMoney but treats blank as zero.
export function parseMoneyOrZero(input, opts) {
  if (input === undefined || input === null) return 0;
  if (typeof input === 'string' && input.trim() === '') return 0;
  return parseMoney(input, opts);
}

function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 123456 -> "$1,234.56", -500 -> "-$5.00"
export function formatMoney(cents, { sign = false } = {}) {
  assertCents(cents);
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const body = `$${groupThousands(String(dollars))}.${String(rem).padStart(2, '0')}`;
  if (neg) return `-${body}`;
  if (sign && cents > 0) return `+${body}`;
  return body;
}

// 123456 -> "1234.56" (for CSV exports and form fields: no $ or commas)
export function centsToDecimal(cents) {
  assertCents(cents);
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

export function sumCents(values) {
  let total = 0;
  for (const v of values) {
    assertCents(v);
    total += v;
    if (!Number.isSafeInteger(total)) throw new MoneyError('Total is too large.');
  }
  return total;
}

// Round a BigInt fraction num/den to the nearest integer, halves away from zero.
function roundHalfAwayFromZero(num, den) {
  if (den <= 0n) throw new MoneyError('Invalid divisor.');
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = (a * 2n + den) / (den * 2n);
  return neg ? -q : q;
}

// Apply a percentage expressed in basis points (2500 = 25.00%) to an amount.
// Rounds to the nearest cent, halves away from zero.
export function applyBasisPoints(cents, basisPoints) {
  assertCents(cents);
  if (!Number.isSafeInteger(basisPoints)) throw new MoneyError('Percentage must be whole basis points.');
  return Number(roundHalfAwayFromZero(BigInt(cents) * BigInt(basisPoints), 10000n));
}

// cents * numerator / denominator, rounded to the nearest cent.
export function scaleCents(cents, numerator, denominator) {
  assertCents(cents);
  assertCents(numerator, 'Numerator');
  assertCents(denominator, 'Denominator');
  if (denominator === 0) throw new MoneyError('Cannot scale by zero.');
  let num = BigInt(cents) * BigInt(numerator);
  let den = BigInt(denominator);
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  return Number(roundHalfAwayFromZero(num, den));
}

// Split `total` cents into parts proportional to `weights` so the parts add up
// to exactly `total` (largest-remainder method). Weights must be >= 0.
// If every weight is zero, the whole amount goes to the first part.
export function allocateProportionally(total, weights) {
  assertCents(total, 'Total');
  if (!Array.isArray(weights) || weights.length === 0) throw new MoneyError('Nothing to split across.');
  weights.forEach((w) => {
    assertCents(w, 'Weight');
    if (w < 0) throw new MoneyError('Weights must not be negative.');
  });
  const sumW = weights.reduce((a, b) => a + BigInt(b), 0n);
  if (sumW === 0n) return weights.map((_, i) => (i === 0 ? total : 0));

  const neg = total < 0;
  const T = BigInt(Math.abs(total));
  const parts = weights.map((w) => {
    const exact = T * BigInt(w);
    return { floor: exact / sumW, rem: exact % sumW };
  });
  let leftover = T - parts.reduce((a, p) => a + p.floor, 0n);
  const order = parts
    .map((p, i) => ({ i, rem: p.rem }))
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const { i } of order) {
    if (leftover === 0n) break;
    parts[i].floor += 1n;
    leftover -= 1n;
  }
  return parts.map((p) => {
    const n = Number(p.floor);
    return neg && n !== 0 ? -n : n;
  });
}

// "25" -> 2500, "25.5" -> 2550, "7.25%" -> 725. 0..100 inclusive.
export function parsePercentToBasisPoints(input, { label = 'Percentage' } = {}) {
  const s = String(input ?? '').trim().replace(/%$/, '').trim();
  const m = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) throw new MoneyError(`${label} must be a number like 25 or 27.5 (up to 2 decimals).`);
  const bp = Number(m[1]) * 100 + Number(((m[2] || '') + '00').slice(0, 2));
  if (bp > 10000) throw new MoneyError(`${label} can't be more than 100%.`);
  return bp;
}

// 2500 -> "25", 2550 -> "25.5", 725 -> "7.25"
export function formatBasisPoints(bp) {
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}
