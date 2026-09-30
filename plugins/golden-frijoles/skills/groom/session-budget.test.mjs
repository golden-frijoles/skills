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
    { contextPct: 48, fiveHourPct: 23.5, sevenDayPct: 9 },
  );
  // Early in a session / after /compact, and off a subscription: nothing is invented.
  assert.deepEqual(figuresFromMeasure({ context: { window: 200000 }, rateLimits: [] }), {
    contextPct: null,
    fiveHourPct: null,
    sevenDayPct: null,
  });
  assert.deepEqual(figuresFromMeasure(undefined), { contextPct: null, fiveHourPct: null, sevenDayPct: null });
});

test('the Claude Code line drops unknown figures instead of showing 0%', () => {
  assert.equal(sessionLine({ contextPct: 48, fiveHourPct: 23.4, sevenDayPct: 9 }), 'Session 48% · 5h 23% · 7d 9% → keep going');
  assert.equal(sessionLine({ contextPct: null, fiveHourPct: 23 }), '5h 23% → keep going');
  assert.equal(sessionLine({ contextPct: 62, questionsWaiting: 1 }), 'Session 62% · 1 question waiting → checkpoint');
  assert.equal(sessionLine({ contextPct: 40, questionsWaiting: 0 }), 'Session 40% → keep going');
  assert.equal(sessionLine({ contextPct: null, fiveHourPct: null, sevenDayPct: null }), null, 'no figure, no line');
  assert.equal(sessionLine(null), null);
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
      figures: { contextPct: 81, fiveHourPct: null, sevenDayPct: 9 },
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
