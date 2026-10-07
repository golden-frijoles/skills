// result-dates.test.mjs — the result record's date rule (result-record D5): 30 days by default, 90 is late.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  READ_CAP_DAYS,
  READ_DEFAULT_DAYS,
  addDays,
  dayOf,
  daysBetween,
  isDay,
  isLate,
  isReadDue,
  readDateOf,
} from './result-dates.mjs';

test('the numbers are the North Star rule', () => {
  assert.equal(READ_DEFAULT_DAYS, 30);
  assert.equal(READ_CAP_DAYS, 90);
});

test('days are real calendar days, in UTC', () => {
  assert.equal(isDay('2026-10-06'), true);
  assert.equal(isDay('2026-02-30'), false);
  assert.equal(isDay('2026-10-6'), false);
  assert.equal(dayOf('2026-10-04T23:59:00Z'), '2026-10-04');
  assert.equal(addDays('2026-10-04', 30), '2026-11-03');
  assert.equal(addDays('2026-12-15', 30), '2027-01-14');
  assert.equal(daysBetween('2026-10-04', '2027-01-02'), 90);
  assert.equal(addDays('nope', 1), null);
});

test('the default read date: only a shipped epic with a target gets one, marked derived', () => {
  assert.deepEqual(readDateOf({ readDate: '2026-11-04', targetMetric: 'x', shippedAt: '2026-10-01' }), {
    readDate: '2026-11-04',
    derived: false,
  });
  assert.deepEqual(
    readDateOf({ readDate: '2026-09-01', targetMetric: 'x', shippedAt: '2026-10-04' }),
    { readDate: '2026-10-04', derived: false },
    'a written day that passed before shipping is read on ship day'
  );
  assert.deepEqual(readDateOf({ readDate: null, targetMetric: 'x', shippedAt: '2026-10-04' }), {
    readDate: '2026-11-03',
    derived: true,
  });
  assert.deepEqual(
    readDateOf({ readDate: null, targetMetric: null, shippedAt: '2026-10-04' }),
    { readDate: null, derived: false },
    'no target, no read date: the epics shipped before the record are never due'
  );
  assert.deepEqual(readDateOf({ readDate: null, targetMetric: 'x', shippedAt: null }), {
    readDate: null,
    derived: false,
  });
});

test('late is more than 90 days after shipping', () => {
  assert.equal(isLate({ shippedAt: '2026-10-04', verdictAt: '2027-01-02' }), false, 'day 90 is on time');
  assert.equal(isLate({ shippedAt: '2026-10-04', verdictAt: '2027-01-03' }), true);
  assert.equal(isLate({ shippedAt: null, verdictAt: '2027-01-03' }), false);
});

test('a read is due on its date, until the verdict is written', () => {
  const e = { targetMetric: 'x', verdict: null, readDate: '2026-11-03', shipped: true };
  assert.equal(isReadDue(e, '2026-11-02'), false);
  assert.equal(isReadDue(e, '2026-11-03'), true);
  assert.equal(isReadDue({ ...e, verdict: 'proven' }, '2026-12-01'), false);
  assert.equal(isReadDue({ ...e, targetMetric: null }, '2026-12-01'), false);
  assert.equal(isReadDue({ ...e, shipped: false }, '2026-12-01'), false, 'not shipped, nothing to read');
});
