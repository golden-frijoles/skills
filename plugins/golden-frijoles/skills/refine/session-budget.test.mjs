// session-budget.test.mjs — every threshold edge, and unknown figures (session-budget D3, D4).
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  THRESHOLDS,
  budgetRow,
  coworkLine,
  figuresFromMeasure,
  sessionLine,
  sessionParts,
  resetIn,
  clockTime,
  toneOf,
  TONES,
  sessionVerdict,
} from './session-budget.mjs';

const v = (f) => sessionVerdict(f).verdict;

test('the thresholds are the locked ones (D3) — a change here is a deliberate re-tune', () => {
  assert.deepEqual(THRESHOLDS, {
    handOff: { contextPct: 80, fiveHourPct: 90 },
    checkpoint: { contextPct: 60, questionsWaiting: 3 },
  });
});

test('context edges: 59 keeps going, 60 checkpoints, 79 checkpoints, 80 hands off', () => {
  assert.equal(v({ contextPct: 59 }), 'keep going');
  assert.equal(v({ contextPct: 60 }), 'checkpoint');
  assert.equal(v({ contextPct: 79 }), 'checkpoint');
  assert.equal(v({ contextPct: 80 }), 'hand off');
  assert.equal(v({ contextPct: 100 }), 'hand off');
});

test('5-hour edges: 89 keeps going, 90 hands off', () => {
  assert.equal(v({ fiveHourPct: 89 }), 'keep going');
  assert.equal(v({ fiveHourPct: 89.9 }), 'keep going');
  assert.equal(v({ fiveHourPct: 90 }), 'hand off');
});

test('questions edges: 2 keeps going, 3 checkpoints — and questions alone never hand off', () => {
  assert.equal(v({ questionsWaiting: 2 }), 'keep going');
  assert.equal(v({ questionsWaiting: 3 }), 'checkpoint');
  assert.equal(v({ questionsWaiting: 40 }), 'checkpoint');
});

test('hand off wins over checkpoint, and every tripped reason is named', () => {
  const r = sessionVerdict({ contextPct: 85, fiveHourPct: 95, questionsWaiting: 5 });
  assert.equal(r.verdict, 'hand off');
  assert.deepEqual(r.reasons, ['context ≥ 80%', '5-hour limit ≥ 90%']);
  assert.deepEqual(sessionVerdict({ contextPct: 61, questionsWaiting: 3 }).reasons, ['context ≥ 60%', '3+ questions waiting']);
});

test('unknown is not zero (D4): null, undefined, NaN and strings are no reason either way', () => {
  for (const unknown of [null, undefined, NaN, '85', Infinity]) {
    assert.deepEqual(sessionVerdict({ contextPct: unknown, fiveHourPct: unknown, questionsWaiting: unknown }), {
      verdict: 'keep going',
      reasons: [],
    });
  }
  assert.equal(v({ contextPct: null, fiveHourPct: 92 }), 'hand off', 'a known figure still counts beside an unknown one');
  assert.equal(v(), 'keep going');
});

test('figuresFromMeasure reads the event payload and leaves absent figures null', () => {
  assert.deepEqual(
    figuresFromMeasure({
      context: { window: 200000, tokens: 96000, percent: 48 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23.5 },
        { kind: 'seven_day', percentUsed: 9 },
      ],
      changed: ['context'],
    }),
    { contextPct: 48, fiveHourPct: 23.5, sevenDayPct: 9, fiveHourResetsAt: null, sevenDayResetsAt: null },
  );
  assert.deepEqual(
    figuresFromMeasure({
      rateLimits: [
        { kind: 'five_hour', percentUsed: 78, resetsAt: '2026-10-08T03:00:00Z' },
        { kind: 'seven_day', percentUsed: 46, resetsAt: 'not a date' },
      ],
    }),
    {
      contextPct: null,
      fiveHourPct: 78,
      sevenDayPct: 46,
      fiveHourResetsAt: Date.UTC(2026, 9, 8, 3),
      sevenDayResetsAt: null,
    },
  );
  // Early in a session / after /compact, and off a subscription: nothing is invented.
  const none = { contextPct: null, fiveHourPct: null, sevenDayPct: null, fiveHourResetsAt: null, sevenDayResetsAt: null };
  assert.deepEqual(figuresFromMeasure({ context: { window: 200000 }, rateLimits: [] }), none);
  assert.deepEqual(figuresFromMeasure(undefined), none);
});

test('the Claude Code line drops unknown figures instead of showing 0%', () => {
  assert.equal(
    sessionLine({ contextPct: 48, fiveHourPct: 23.4, sevenDayPct: 9 }),
    'Session 48% · 5h ▰▰▱▱▱▱▱▱▱▱ 23% · 7d 9% → keep going'
  );
  assert.equal(sessionLine({ contextPct: null, fiveHourPct: 23 }), '5h ▰▰▱▱▱▱▱▱▱▱ 23% → keep going');
  assert.equal(sessionLine({ contextPct: 62, questionsWaiting: 1 }), 'Session 62% · 1 question waiting → checkpoint');
  assert.equal(sessionLine({ contextPct: 40, questionsWaiting: 0 }), 'Session 40% → keep going');
  assert.equal(sessionLine({ contextPct: null, fiveHourPct: null, sevenDayPct: null }), null, 'no figure, no line');
  assert.equal(sessionLine(null), null);
});

test('build-view-upgrade D5: each figure is coloured by its own table, with the time to its reset', () => {
  const now = Date.UTC(2026, 9, 8, 1, 0);
  const H = 3_600_000;
  const parts = sessionParts(
    { contextPct: 48, fiveHourPct: 78, sevenDayPct: 46, fiveHourResetsAt: now + 2.5 * H, sevenDayResetsAt: now + 75 * H },
    undefined,
    now,
  );
  assert.deepEqual(
    parts.map(({ text, tone, verdict }) => ({ text, tone, ...(verdict ? { verdict } : {}) })),
    [
      { text: 'Session 48%', tone: 'good' },
      { text: `5h ▰▰▰▰▰▰▰▰▱▱ 78% · resets ${clockTime(now + 2.5 * H)} (in 2h 30m)`, tone: 'warn' },
      { text: '7d 46% (in 3d 3h)', tone: 'good' },
      { text: 'keep going', tone: null, verdict: true },
    ],
  );
  assert.deepEqual(parts[1].meter, { head: '5h ', filled: '▰▰▰▰▰▰▰▰', empty: '▱▱', tail: ` 78% · resets ${clockTime(now + 2.5 * H)} (in 2h 30m)` });
  assert.equal(
    sessionLine({ fiveHourPct: 91, sevenDayPct: 62, fiveHourResetsAt: now + 40 * 60_000, sevenDayResetsAt: now + 24 * H }, undefined, now),
    `5h ▰▰▰▰▰▰▰▰▰▱ 91% · resets ${clockTime(now + 40 * 60_000)} (in 40m) · 7d 62% (in 1d) → hand off`,
  );
  for (const [key, cases] of Object.entries({
    contextPct: [[59, 'good'], [60, 'warn'], [79, 'warn'], [80, 'bad']],
    fiveHourPct: [[59.9, 'good'], [60, 'warn'], [89, 'warn'], [90, 'bad']],
    sevenDayPct: [[0, 'good'], [60, 'warn'], [90, 'bad'], [100, 'bad']],
  }))
    for (const [value, tone] of cases) assert.equal(toneOf(key, value), tone, `${key} ${value}`);
  assert.equal(TONES.contextPct.bad, THRESHOLDS.handOff.contextPct, 'red is the hand-off line, not a second number');
  assert.equal(TONES.fiveHourPct.bad, THRESHOLDS.handOff.fiveHourPct);
  assert.equal(resetIn(now + 30_000, now), 'in 1m', 'never in 0m');
  assert.equal(resetIn(now + 59 * 60_000, now), 'in 59m');
  assert.equal(resetIn(now + H, now), 'in 1h');
  assert.equal(resetIn(now + 25 * H, now), 'in 1d 1h');
  assert.equal(resetIn(now - 1, now), null, 'a past reset shows nothing');
  assert.equal(resetIn(null, now), null);
  assert.equal(sessionLine({ fiveHourPct: 20, fiveHourResetsAt: null }, undefined, now), '5h ▰▰▱▱▱▱▱▱▱▱ 20% → keep going');
});

test('build-view-one-story D9: the reset seen as "-1h" on 2026-10-10 reads to the minute, and under an hour has no hours', () => {
  // Reproduced before the change: at 7:51 pm with a 9:20 pm reset, resetIn said `-1h` (floored hours, and the minus
  // read as "an hour ago"). The line now says when, and how long until then.
  const seen = new Date(2026, 9, 10, 19, 51).getTime();
  const reset = new Date(2026, 9, 10, 21, 20).getTime();
  assert.equal(sessionLine({ fiveHourPct: 62, fiveHourResetsAt: reset }, undefined, seen), '5h ▰▰▰▰▰▰▱▱▱▱ 62% · resets 9:20 pm (in 1h 29m) → keep going');
  assert.equal(resetIn(reset, new Date(2026, 9, 10, 20, 31).getTime()), 'in 49m', 'under an hour: minutes alone, never "in 0h 49m" or "-1h"');
  assert.equal(clockTime(new Date(2026, 9, 10, 0, 5).getTime()), '12:05 am');
  assert.equal(clockTime(new Date(2026, 9, 10, 12, 0).getTime()), '12:00 pm');
  assert.equal(clockTime(null), null);
  assert.ok(!/-\d/.test(sessionLine({ fiveHourPct: 5, fiveHourResetsAt: seen + 1 }, undefined, seen)), 'no minus sign, ever');
});

test('the Cowork line says context is not measured and uses the same verdict', () => {
  assert.equal(
    coworkLine({ asksOpen: 2, questionsWaiting: 1, gatesPassed: 1 }),
    '2 asks open · 1 question waiting · 1 gate passed · context: not measured here → keep going',
  );
  assert.equal(
    coworkLine({ asksOpen: 1, questionsWaiting: 3, gatesPassed: 4 }),
    '1 ask open · 3 questions waiting · 4 gates passed · context: not measured here → checkpoint',
  );
  assert.equal(coworkLine({}), 'context: not measured here → keep going');
});

test('a log row keeps known figures only, with the verdict and its reasons', () => {
  const row = JSON.parse(
    budgetRow({
      at: Date.UTC(2026, 8, 30, 12),
      surface: 'claude-code',
      figures: { contextPct: 81, fiveHourPct: null, sevenDayPct: 9, sevenDayResetsAt: Date.UTC(2026, 9, 1) },
      verdict: sessionVerdict({ contextPct: 81 }),
    }),
  );
  assert.deepEqual(row, {
    at: '2026-09-30T12:00:00.000Z',
    surface: 'claude-code',
    verdict: 'hand off',
    reasons: ['context ≥ 80%'],
    contextPct: 81,
    sevenDayPct: 9,
  });
});

test('no imports at all — the mod imports this file and its environment has no Node (D3)', () => {
  const src = readFileSync(new URL('./session-budget.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\b/m);
  assert.doesNotMatch(src, /\brequire\(|\bimport\(/);
});
