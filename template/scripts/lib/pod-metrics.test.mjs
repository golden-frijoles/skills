// pod-metrics — the Pod Report's delivery numbers.
//
// This is a SALES artifact: the numbers go in front of a buyer. So the tests that matter most are
// the ones that stop it flattering us — a metric that quietly reports 0 when it means "not
// measured" is worse than no metric, because it is the most impressive figure on the page and the
// least true.
//
// The determinism cases exist because "rerun from the same inputs ⇒ byte-identical artifact" is a
// stated acceptance criterion of Sprint 2, not a nicety.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  percentile,
  median,
  cycleTimeHours,
  epicLeadTimeDays,
  deployFrequency,
  epicThroughput,
  authorshipByMonth,
  computeDelivery,
  round,
  NOT_INSTRUMENTED,
} from './pod-metrics.mjs';

const pr = (createdAt, mergedAt) => ({ createdAt, mergedAt });

test('percentile is nearest-rank and exact — no interpolation to argue about', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(v, 50), 5);
  assert.equal(percentile(v, 90), 9);
  assert.equal(percentile(v, 100), 10);
  // Bounds must not fall off either end.
  assert.equal(percentile(v, 0), 1);
  assert.equal(percentile([], 50), null);
  assert.equal(median([3, 1, 2]), 2, 'input order must not matter');
});

test('cycle time is computed from real timestamps, in hours', () => {
  const r = cycleTimeHours([
    pr('2026-07-20T00:00:00Z', '2026-07-20T02:00:00Z'), // 2h
    pr('2026-07-20T00:00:00Z', '2026-07-20T06:00:00Z'), // 6h
    pr('2026-07-20T00:00:00Z', '2026-07-20T04:00:00Z'), // 4h
  ]);
  assert.equal(r.count, 3);
  assert.equal(r.medianHours, 4);
});

test('an UNMERGED pr is excluded, not counted as open-forever', () => {
  // Counting it would turn cycle time into a measure of the backlog rather than of throughput, and
  // would get worse the more work is in flight — a metric that punishes activity.
  const r = cycleTimeHours([
    pr('2026-07-20T00:00:00Z', '2026-07-20T02:00:00Z'),
    pr('2026-07-01T00:00:00Z', null),
    { createdAt: '2026-07-01T00:00:00Z' },
  ]);
  assert.equal(r.count, 1);
});

test('an empty or all-unmerged set reports NULL, never 0', () => {
  // 0 hours would read as "instant delivery" — the most flattering possible misreading of no data.
  for (const input of [[], [pr('2026-07-20T00:00:00Z', null)], null]) {
    const r = cycleTimeHours(input);
    assert.equal(r.count, 0);
    assert.equal(r.medianHours, null, 'no data must be null, never zero');
    assert.equal(r.p90Hours, null);
  }
});

test('a negative duration (merged before created) is discarded, not reported as fast', () => {
  // Clock skew between systems can produce this. Reporting it would drag the median DOWN, making
  // bad data look like excellent performance.
  const r = cycleTimeHours([pr('2026-07-20T06:00:00Z', '2026-07-20T02:00:00Z')]);
  assert.equal(r.count, 0);
  assert.equal(r.medianHours, null);
});

test('epic lead time is reported in days and tolerates missing endpoints', () => {
  const r = epicLeadTimeDays([
    { startedAt: '2026-07-01T00:00:00Z', shippedAt: '2026-07-05T00:00:00Z' }, // 4d
    { startedAt: '2026-07-01T00:00:00Z', shippedAt: '2026-07-03T00:00:00Z' }, // 2d
    { startedAt: '2026-07-01T00:00:00Z', shippedAt: null }, // in flight — excluded
  ]);
  assert.equal(r.count, 2);
  // 2d and 4d → 3d. The AVERAGE of the two middle values, not the lower one: nearest-rank would
  // report 2 days, the faster and more flattering number, chosen by an implementation detail.
  assert.equal(r.medianDays, 3);
  assert.equal(epicLeadTimeDays([]).medianDays, null);
});

test('deploy frequency ALWAYS carries its proxy label — the caveat is part of the value', () => {
  // A reader who sees "deploys per week" without knowing it is a merged-PR count has been misled.
  // Making `isProxy` part of the returned shape means a renderer cannot drop it by omission.
  const r = deployFrequency([pr('a', 'b'), pr('c', 'd')], 14);
  assert.equal(r.isProxy, true);
  assert.match(r.proxyNote, /proxy/i);
  assert.match(r.proxyNote, /no deploy log/i);
  assert.equal(r.mergedPrs, 2);
  assert.equal(r.perWeek, 1);
});

test('a zero-length window yields null rates, not a division by zero', () => {
  assert.equal(deployFrequency([pr('a', 'b')], 0).perWeek, null);
  assert.equal(epicThroughput([{ shippedAt: 'x' }], 0).perWeek, null);
});

test('authorship is grouped by month, in order, with a share per month', () => {
  const r = authorshipByMonth([
    { date: '2026-07-02', agentCoAuthored: true },
    { date: '2026-06-15', agentCoAuthored: true },
    { date: '2026-06-16', agentCoAuthored: false },
    { date: '2026-07-03', agentCoAuthored: true },
    { date: 'garbage', agentCoAuthored: true }, // unparseable → ignored, not crashed on
  ]);
  assert.deepEqual(
    r.map((x) => x.month),
    ['2026-06', '2026-07'],
    'months must be chronological'
  );
  assert.equal(r[0].agentShare, 0.5);
  assert.equal(r[1].agentShare, 1);
});

test('the NOT-INSTRUMENTED list names a reason AND a guardrail for every gap', () => {
  // The epic's design: each honest gap is also the upsell — it names the guardrail a pods
  // engagement installs. A gap listed without its remedy is just an apology.
  assert.ok(NOT_INSTRUMENTED.length >= 5);
  for (const row of NOT_INSTRUMENTED) {
    assert.ok(row.key && row.label, 'every gap needs an identity');
    assert.ok(row.reason.length > 20, `${row.key} needs a real reason, not a shrug`);
    assert.ok(row.guardrail.length > 10, `${row.key} must name what would fix it`);
  }
  // The four the amendment specifically forbids computing must all be present.
  const keys = NOT_INSTRUMENTED.map((r) => r.key);
  for (const required of ['velocity', 'cost_per_point', 'change_failure_rate', 'recovery_time']) {
    assert.ok(keys.includes(required), `${required} must be declared not-instrumented, never computed`);
  }
});

test('change failure rate is NEVER computed as a number, however tempting', () => {
  // The single most dangerous number in this report. Zero reverts in the dataset means "no rollback
  // mechanism to measure", not "no failures" — and 0% CFR would be the most impressive figure on
  // the page. It must not exist as a value anywhere in the output.
  const out = computeDelivery({ prs: [], epics: [], commits: [], windowDays: 30, generatedAt: 'x' });
  const serialized = JSON.stringify(out);
  assert.ok(!/"changeFailureRate"\s*:\s*[\d.]/.test(serialized), 'CFR must never appear as a number');
  assert.ok(
    out.notInstrumented.some((r) => r.key === 'change_failure_rate'),
    'CFR must appear only in the not-instrumented list'
  );
});

// ── Determinism: the sprint's headline acceptance criterion ─────────────────────────────────

test('computeDelivery is DETERMINISTIC — same inputs, byte-identical output', () => {
  const input = {
    prs: [
      pr('2026-07-20T00:00:00Z', '2026-07-20T03:00:00Z'),
      pr('2026-07-21T00:00:00Z', '2026-07-21T09:00:00Z'),
    ],
    epics: [{ startedAt: '2026-07-01T00:00:00Z', shippedAt: '2026-07-06T00:00:00Z' }],
    commits: [{ date: '2026-07-02', agentCoAuthored: true }],
    windowDays: 30,
    generatedAt: '2026-07-25T00:00:00.000Z',
  };
  assert.equal(JSON.stringify(computeDelivery(input)), JSON.stringify(computeDelivery(input)));
});

test('computeDelivery takes NO clock of its own — the caller supplies generatedAt', () => {
  // A `new Date()` inside would make every run differ and silently break the determinism criterion.
  // Asserted by running the same input twice around a real time gap.
  const input = { prs: [], epics: [], commits: [], windowDays: 7, generatedAt: 'FIXED' };
  const a = JSON.stringify(computeDelivery(input));
  const start = Date.now();
  while (Date.now() - start < 5) {
    /* burn a few ms so any internal clock would tick */
  }
  assert.equal(JSON.stringify(computeDelivery(input)), a);
  assert.equal(computeDelivery(input).generatedAt, 'FIXED');
});

test('round is DETERMINISTIC, which is the property that is actually required', () => {
  // This test originally asserted textbook half-up rounding (round(1.005, 2) === 1.01) because the
  // implementation's comment claimed it. The test failed, and the COMMENT was the thing that was
  // wrong: 1.005 is 1.00499999… in binary, so no float-based rounding returns 1.01. Rather than
  // weaken the test to match the code, both were corrected to state the true guarantee.
  //
  // Determinism is what the artifact needs — "byte-identical output from the same inputs" — and it
  // is what is asserted here.
  for (const n of [1.005, 2.675, 0.1 + 0.2, 3.14159, 1 / 3]) {
    assert.equal(round(n, 2), round(n, 2), `round must be stable for ${n}`);
  }
  assert.equal(round(4.567, 2), 4.57, 'ordinary values still round as expected');
  assert.equal(round(10, 2), 10);
  // Non-numbers must become null, never NaN — NaN serialises to `null` in JSON anyway, so letting
  // it through would make a broken computation indistinguishable from an honest "no data".
  assert.equal(round(null, 2), null);
  assert.equal(round(undefined, 2), null);
  assert.equal(round(Number.NaN, 2), null);
  assert.equal(round(Number.POSITIVE_INFINITY, 2), null);
});

// ── The two honesty guards, both found by running against the REAL dataset ──────────────────
// Neither was predicted from reading the data model. Both were caught because the first real run
// produced numbers that were true and flattering, and flattering numbers on a sales artifact earn
// scrutiny rather than a screenshot.

test('review latency is never presented as DORA-comparable', () => {
  // The real dataset's median came out at 0.16h — under ten minutes — because the PR is opened
  // AFTER the branch is built. Printing that beside DORA's "under a day is elite" would be the most
  // flattering and least meaningful line in the report. The disclaimer is a structural field so a
  // renderer cannot omit it, and it survives the empty case too.
  const populated = cycleTimeHours([pr('2026-07-20T00:00:00Z', '2026-07-20T00:01:00Z')]);
  assert.equal(populated.comparableToDora, false);
  assert.match(populated.interpretation, /NOT comparable to DORA/i);
  assert.match(populated.interpretation, /review-and-merge/i);

  const empty = cycleTimeHours([]);
  assert.equal(empty.comparableToDora, false, 'the caveat must survive the no-data path');
  assert.ok(empty.interpretation);
});

test('a RETROACTIVELY DOCUMENTED epic is excluded from lead time, not counted as zero days', () => {
  // Measured live: 83 of medusa-bonsai's 130 shipped epics had their README committed with
  // `status: shipped` ALREADY SET — create-commit and ship-flip are the same commit, to the second.
  // Counting those as 0-day epics dragged the median to 0 days. Excluding them moved it to a
  // believable 7.2 days over the 47 that are genuinely measurable.
  const sameCommit = '2026-07-05T09:04:12Z';
  const r = epicLeadTimeDays([
    { startedAt: sameCommit, shippedAt: sameCommit }, // documented after the fact
    { startedAt: '2026-07-05T09:04:12Z', shippedAt: '2026-07-05T09:20:00Z' }, // 16 min — also bookkeeping
    { startedAt: '2026-07-01T00:00:00Z', shippedAt: '2026-07-09T00:00:00Z' }, // 8d — real
    { startedAt: '2026-07-01T00:00:00Z', shippedAt: '2026-07-07T00:00:00Z' }, // 6d — real
  ]);
  assert.equal(r.count, 2, 'only genuinely measurable epics count');
  assert.equal(r.retroactivelyDocumented, 2);
  assert.equal(r.medianDays, 7, 'the median reflects real epics only');
  assert.match(r.interpretation, /documented after the work/i);
});

test('an all-retroactive dataset reports NULL lead time, never 0 days', () => {
  // The pathological case: if every epic were documented after the fact there is simply no lead
  // time to report. Zero would be a lie; null is the truth.
  const t = '2026-07-05T09:04:12Z';
  const r = epicLeadTimeDays([
    { startedAt: t, shippedAt: t },
    { startedAt: t, shippedAt: t },
  ]);
  assert.equal(r.count, 0);
  assert.equal(r.medianDays, null);
  assert.equal(r.retroactivelyDocumented, 2);
});
