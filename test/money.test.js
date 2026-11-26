import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMoney,
  parseMoneyOrZero,
  formatMoney,
  centsToDecimal,
  sumCents,
  applyBasisPoints,
  scaleCents,
  allocateProportionally,
  parsePercentToBasisPoints,
  formatBasisPoints,
  MoneyError,
} from '../src/shared/money.js';

test('parseMoney accepts the ways people write dollar amounts', () => {
  const cases = {
    '12': 1200,
    '12.5': 1250,
    '12.50': 1250,
    '12.05': 1205,
    '0.01': 1,
    '.5': 50,
    '0': 0,
    '$1,234.56': 123456,
    '1,234': 123400,
    '1,234,567.89': 123456789,
    '-12.00': -1200,
    '(12.00)': -1200,
    '($12.00)': -1200,
    '-$5': -500,
    '$-5': -500,
    ' 3.10 ': 310,
    '12.': 1200,
  };
  for (const [input, cents] of Object.entries(cases)) {
    assert.equal(parseMoney(input), cents, `parseMoney(${JSON.stringify(input)})`);
  }
});

test('parseMoney accepts numbers only when they are exact to the cent', () => {
  assert.equal(parseMoney(19.99), 1999);
  assert.equal(parseMoney(1234), 123400);
  assert.throws(() => parseMoney(0.1 + 0.2), MoneyError); // 0.30000000000000004
  assert.throws(() => parseMoney(1e21), MoneyError);
  assert.throws(() => parseMoney(NaN), MoneyError);
});

test('parseMoney rejects malformed input instead of guessing', () => {
  for (const bad of ['', '   ', 'abc', '12.345', '1.2.3', '1,23', '12,34.00', '--5', '$', '1e5', '12 34', '5-', '$$5', '(-5)']) {
    assert.throws(() => parseMoney(bad), MoneyError, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseMoney(undefined), MoneyError);
  assert.throws(() => parseMoney(null), MoneyError);
  assert.throws(() => parseMoney('-1.00', { allowNegative: false }), /can't be negative/);
  assert.throws(() => parseMoney('999999999999999.00'), /too large/);
});

test('parseMoney error messages name the field', () => {
  assert.throws(() => parseMoney('1.234', { label: 'Shipping' }), /^MoneyError: Shipping "1.234" has more than 2 decimal places/);
});

test('parseMoneyOrZero treats blank as zero but still validates', () => {
  assert.equal(parseMoneyOrZero(''), 0);
  assert.equal(parseMoneyOrZero(null), 0);
  assert.equal(parseMoneyOrZero(undefined), 0);
  assert.equal(parseMoneyOrZero('4.20'), 420);
  assert.throws(() => parseMoneyOrZero('x'), MoneyError);
});

test('formatMoney and centsToDecimal', () => {
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(5), '$0.05');
  assert.equal(formatMoney(100), '$1.00');
  assert.equal(formatMoney(123456789), '$1,234,567.89');
  assert.equal(formatMoney(-1), '-$0.01');
  assert.equal(formatMoney(250, { sign: true }), '+$2.50');
  assert.throws(() => formatMoney(1.5), MoneyError);
  assert.throws(() => formatMoney('100'), MoneyError);
  assert.equal(centsToDecimal(123456), '1234.56');
  assert.equal(centsToDecimal(-5), '-0.05');
  assert.equal(centsToDecimal(0), '0.00');
});

test('round trip: parse(format(x)) === x', () => {
  for (const c of [0, 1, 99, 100, 101, 123456, -987654, 99999999999]) {
    assert.equal(parseMoney(formatMoney(c)), c);
    assert.equal(parseMoney(centsToDecimal(c)), c);
  }
});

test('sumCents refuses non-integer cents', () => {
  assert.equal(sumCents([1, 2, 3, -4]), 2);
  assert.equal(sumCents([]), 0);
  assert.throws(() => sumCents([1, 0.5]), MoneyError);
});

test('applyBasisPoints rounds half away from zero', () => {
  assert.equal(applyBasisPoints(1_000_000, 2500), 250_000); // 25% of $10,000
  assert.equal(applyBasisPoints(1, 2500), 0); // 0.25 cents
  assert.equal(applyBasisPoints(2, 2500), 1); // 0.5 → 1
  assert.equal(applyBasisPoints(3, 2500), 1); // 0.75 → 1
  assert.equal(applyBasisPoints(-2, 2500), -1); // -0.5 → -1
  assert.equal(applyBasisPoints(12345, 2750), 3395); // 3394.875 → 3395
  assert.equal(applyBasisPoints(12345, 0), 0);
  assert.equal(applyBasisPoints(12345, 10000), 12345);
  // No precision loss on large amounts (cents × bp exceeds 2^53).
  assert.equal(applyBasisPoints(9_000_000_000_001, 3333), 2_999_700_000_000);
});

test('scaleCents', () => {
  assert.equal(scaleCents(11000, 1, 2), 5500);
  assert.equal(scaleCents(100, 1, 3), 33);
  assert.equal(scaleCents(200, 1, 3), 67);
  assert.equal(scaleCents(100, -1, 3), -33);
  assert.throws(() => scaleCents(100, 1, 0), MoneyError);
});

test('allocateProportionally always adds up exactly', () => {
  assert.deepEqual(allocateProportionally(1000, [1, 1, 1]), [334, 333, 333]);
  assert.deepEqual(allocateProportionally(-1000, [1, 1, 1]), [-334, -333, -333]);
  assert.deepEqual(allocateProportionally(100, [0, 0, 0]), [100, 0, 0]);
  assert.deepEqual(allocateProportionally(0, [5, 5]), [0, 0]);
  assert.deepEqual(allocateProportionally(5432, [10000, 1000, 863]), [4579, 458, 395]);
  assert.throws(() => allocateProportionally(100, []), MoneyError);
  assert.throws(() => allocateProportionally(100, [1, -1]), MoneyError);

  // Property check with a deterministic pseudo-random sequence.
  let seed = 42;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let i = 0; i < 2000; i++) {
    const weights = Array.from({ length: 1 + rand(4) }, () => rand(100000));
    const total = rand(10_000_000) - 5_000_000;
    const parts = allocateProportionally(total, weights);
    assert.equal(parts.reduce((a, b) => a + b, 0), total);
    const sumW = weights.reduce((a, b) => a + b, 0);
    if (sumW > 0) {
      parts.forEach((p, j) => {
        const exact = (total * weights[j]) / sumW;
        assert.ok(Math.abs(p - exact) < 1.000001, `part ${p} too far from ${exact}`);
        assert.ok(Number.isInteger(p));
      });
    }
  }
});

test('percent parsing to basis points', () => {
  assert.equal(parsePercentToBasisPoints('25'), 2500);
  assert.equal(parsePercentToBasisPoints('27.5'), 2750);
  assert.equal(parsePercentToBasisPoints('7.25%'), 725);
  assert.equal(parsePercentToBasisPoints(' 0 '), 0);
  assert.equal(parsePercentToBasisPoints('100'), 10000);
  for (const bad of ['101', '-5', '25.555', 'abc', '', '1e2']) {
    assert.throws(() => parsePercentToBasisPoints(bad), MoneyError, bad);
  }
  assert.equal(formatBasisPoints(2500), '25');
  assert.equal(formatBasisPoints(2550), '25.5');
  assert.equal(formatBasisPoints(725), '7.25');
});
