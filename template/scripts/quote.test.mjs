// quote.test.mjs — the calibrated range (finops S2.2, D7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WIDE_DEFAULT, actualsAt, calibrationReport, percentile, quoteFor } from './quote.mjs';

const epic = (appetite, actual_usd, extra = {}) => ({
  grain: 'Epic',
  status: 'Shipped',
  appetite,
  actual_usd,
  ...extra,
});

test('percentile: linear interpolation, and the edges', () => {
  assert.equal(percentile([], 0.25), null);
  assert.equal(percentile([10], 0.75), 10);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.25), 20);
  assert.equal(percentile([10, 20, 30, 40], 0.25), 17.5);
});

test('n >= 3: p25–p75 of shipped actuals at the appetite, floor/ceil to whole dollars', () => {
  const rows = [
    epic('M', 23.43),
    epic('M', 24.44),
    epic('M', 33.08),
    epic('M', 37.02),
    epic('M', 102),
    epic('S', 999),
  ];
  const q = quoteFor(rows, 'M');
  assert.deepEqual([q.low, q.high, q.n, q.kind], [24, 38, 5, 'p25–p75']);
  assert.equal(q.line, '$24–38 (M, n=5, p25–p75)');
});

test('n = 0 and n = 2: the wide default, labelled wide with its n — never a calibration (D4)', () => {
  assert.equal(quoteFor([], 'S').line, `$${WIDE_DEFAULT.S[0]}–${WIDE_DEFAULT.S[1]} (S, n=0, wide)`);
  const two = quoteFor([epic('L', 80), epic('L', 200)], 'L');
  assert.deepEqual([two.low, two.high, two.kind, two.basis], [...WIDE_DEFAULT.L, 'wide', 'L, n=2, wide']);
});

test('only shipped epics with a numeric actual count; a quote without an actual is ignored', () => {
  const rows = [
    epic('M', 10),
    epic('M', null, { quote_low_usd: 1, quote_high_usd: 2 }),
    { ...epic('M', 50), status: 'Building' },
    { ...epic('M', 70), grain: 'Sprint' },
  ];
  assert.deepEqual(actualsAt(rows, 'M'), [10]);
});

test('an unknown appetite is an error, not a quote', () => {
  assert.throws(() => quoteFor([], 'XL'), /appetite must be one of/);
});

test('--report: per appetite, how many actuals landed inside their quote', () => {
  const rows = [
    epic('M', 40, { quote_low_usd: 30, quote_high_usd: 55 }),
    epic('M', 71, { quote_low_usd: 30, quote_high_usd: 55 }),
    epic('M', 10, { quote_low_usd: 30, quote_high_usd: 55 }),
    epic('M', 33),
  ];
  const m = calibrationReport(rows).find((r) => r.appetite === 'M');
  assert.deepEqual([m.judged, m.inside, m.over, m.under], [3, 1, 1, 1]);
});

test('the boundary: n = 3 is calibrated, n = 2 is wide (MIN_HISTORY, fresh review #231)', () => {
  assert.equal(quoteFor([epic('S', 8.77), epic('S', 13.86), epic('S', 18.5)], 'S').kind, 'p25–p75');
  assert.equal(quoteFor([epic('S', 8.77), epic('S', 13.86)], 'S').kind, 'wide');
});
