// screensaver.test.mjs — WHEN the screensaver runs and WHAT fits (screensaver D1–D6). node:test, no engine, no clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE_SYMBOLS } from './vendor/build-state.mjs';
import { bandRowsFrom } from './build-view.mjs';
import {
  CAPTION_ROWS, IDLE_MINUTES, IN_FLIGHT_FACTOR, MIN_CROP, SLACK_ROWS,
  bandHeight, createSaver, fitPieces, isIdleView, parseArgs, statusText, viewMode,
} from './screensaver.mjs';

const MIN = 60_000;
const IDLE = 'golden-frijoles ○ No epic on this branch · main'; // build-state.mjs --json --offline on main, verbatim
const BUILDING = 'golden-frijoles ▶ Epic: Launch: the first landing A/B · L · ▲ risk HIGH';

// A clock the test moves by hand.
function world(opts) {
  const w = { t: 1_000_000 };
  const saver = createSaver({ now: () => w.t, random: () => 0.5, ...opts });
  return { w, saver, advance: (ms) => (w.t += ms) };
}

test('viewMode: the resolver\'s own `none` symbol, or no view at all, is idle; any other header is in flight', () => {
  assert.equal(viewMode(IDLE), 'idle');
  assert.equal(viewMode(`${IDLE}\n  → Next     /golden-frijoles:setup`), 'idle', 'only the first line is read');
  for (const [stage, symbol] of Object.entries(STATE_SYMBOLS))
    assert.equal(viewMode(`repo ${symbol} Epic: x`), stage === 'none' ? 'idle' : 'flight', `${stage} (${symbol})`);
  assert.equal(viewMode(BUILDING), 'flight');
  // D6 — the standalone install: a folder with no git, a repo with no view, a failed check. It plays anywhere.
  for (const v of [null, undefined, '', '   ']) assert.equal(viewMode(v), 'idle', String(v));
  assert.equal(isIdleView(null), true);
});

test('away long enough, nothing in flight: the clock starts it', () => {
  const { saver, advance } = world();
  saver.onView(IDLE);
  assert.equal(saver.tick(), false, 'not yet');
  advance(IDLE_MINUTES * MIN - 1);
  assert.equal(saver.tick(), false, 'one ms short');
  advance(1);
  assert.equal(saver.tick(), true);
  assert.equal(saver.visible(), true);
  assert.equal(saver.tick(), false, 'already on: no second start, no redraw');
});

test('D1: an epic in flight waits three times as long — the band is the useful thing then', () => {
  const { saver, advance } = world();
  saver.onView(BUILDING);
  advance(IDLE_MINUTES * MIN);
  assert.equal(saver.tick(), false, 'the idle wait is not enough in flight');
  advance(IDLE_MINUTES * (IN_FLIGHT_FACTOR - 1) * MIN - 1);
  assert.equal(saver.tick(), false);
  advance(1);
  assert.equal(saver.tick(), true);
  assert.equal(saver.visible(), true, 'and it plays under the band');
});

test('activity ends it, and the quiet window starts over', () => {
  const { saver, advance } = world();
  saver.onView(IDLE);
  advance(IDLE_MINUTES * MIN);
  saver.tick();
  assert.equal(saver.touch(), true, 'it was up, so the caller redraws');
  assert.equal(saver.visible(), false);
  assert.equal(saver.touch(), false, 'a keystroke with it down changes nothing');
  advance(IDLE_MINUTES * MIN - 1);
  assert.equal(saver.tick(), false);
  advance(1);
  assert.equal(saver.tick(), true);
});

test('never under a running turn or a waiting question: busy only delays it', () => {
  const { saver, advance } = world();
  saver.onView(IDLE);
  advance(60 * MIN);
  assert.equal(saver.tick({ busy: true }), false, 'busy: a turn or a question');
  assert.equal(saver.tick({ busy: false }), true, 'once it clears, the quiet time already counted');
});

test('the work changing under it (an epic going in flight, or ending) ends it and starts a fresh window', () => {
  const { saver, advance } = world();
  saver.onView(IDLE);
  advance(IDLE_MINUTES * MIN);
  saver.tick();
  assert.equal(saver.onView(BUILDING), true, 'redraw: the picture goes');
  assert.equal(saver.visible(), false);
  assert.equal(saver.onView(BUILDING), false, 'the same mode again is not a change');
  advance(IDLE_MINUTES * IN_FLIGHT_FACTOR * MIN);
  assert.equal(saver.onView(IDLE), false, 'nothing was playing');
  assert.equal(saver.tick(), false, 'a fresh quiet window, not an instant start');
  advance(IDLE_MINUTES * MIN);
  assert.equal(saver.tick(), true);
  assert.equal(saver.onView(null), false, 'a cleared view is still nothing in flight: it keeps playing');
  assert.equal(saver.visible(), true);
});

test('visible: not under a turn (isWorking) or a survey, even when armed', () => {
  const { saver, advance } = world();
  saver.onView(IDLE);
  advance(IDLE_MINUTES * MIN);
  saver.tick();
  assert.equal(saver.visible({ isWorking: true }), false);
  assert.equal(saver.visible({ hasSurvey: true }), false);
  assert.equal(saver.visible({ isWorking: false, hasSurvey: false }), true);
});

test('start() (/screensaver now): plays at once in or out of flight; refuses when off', () => {
  const { saver } = world();
  saver.onView(BUILDING);
  assert.deepEqual(saver.start(), { ok: true }, 'the person asked: in flight too (the screenshot case)');
  saver.stop();
  saver.configure({ enabled: false });
  assert.deepEqual(saver.start(), { ok: false, reason: 'off' });
  saver.configure({ enabled: true });
  assert.deepEqual(saver.start(), { ok: true });
  assert.equal(saver.visible(), true);
  assert.equal(saver.state.seed, 500_000, 'the seed comes from the injected random');
});

test('configure: off ends a running saver; minutes move the threshold and restart the count', () => {
  const { saver, advance } = world();
  saver.onView(IDLE);
  saver.start();
  assert.equal(saver.configure({ enabled: false }), true);
  assert.equal(saver.visible(), false);
  assert.equal(saver.tick(), false, 'off never starts');
  saver.configure({ enabled: true, minutes: 1 });
  advance(MIN - 1);
  assert.equal(saver.tick(), false);
  advance(1);
  assert.equal(saver.tick(), true);
  saver.configure({ minutes: 0 });
  saver.configure({ minutes: 9999 });
  saver.configure({ minutes: NaN });
  assert.equal(saver.state.minutes, 1, 'out-of-range minutes are ignored');
});

test('saved settings with junk in them are ignored field by field', () => {
  const { saver } = world();
  saver.configure({ enabled: 'yes', minutes: '5' });
  assert.deepEqual([saver.state.enabled, saver.state.minutes], [true, IDLE_MINUTES]);
});

const CATALOG = [
  { id: 'tall', meta: { rows: 25, cols: 60 } },
  { id: 'cat', meta: { rows: 15, cols: 56 } },
  { id: 'wide', meta: { rows: 14, cols: 90 } },
  { id: 'fire', meta: { rows: 18, cols: 60 }, anchor: 'bottom' },
];
const ids = (fits) => fits.map((f) => f.id);

test('fitPieces D3: whole when it fits, cropped to at most a quarter from its anchored side, never too wide, never scaled', () => {
  // A 30-row band holding 6 rows of view: room = 30 - 6 - CAPTION_ROWS - SLACK_ROWS = 22.
  assert.equal(30 - 6 - CAPTION_ROWS - SLACK_ROWS, 22);
  const fits = fitPieces(CATALOG, { maxRows: 30, bandRows: 6, columns: 100 });
  assert.deepEqual(ids(fits), ['tall', 'cat', 'wide', 'fire'], 'tall (25) crops to 22, within a quarter');
  assert.deepEqual(fits[0], { id: 'tall', rows: 22, anchor: 'middle' });
  assert.deepEqual(fits[3], { id: 'fire', rows: 18, anchor: 'bottom' }, 'whole: its own rows');
  assert.deepEqual(ids(fitPieces(CATALOG, { maxRows: 30, bandRows: 6, columns: 80 })), ['tall', 'cat', 'fire'], 'wide: never cut at the sides');
  // room 14: the 18-row fire crops to 14 (≥ 75% of 18 = 13.5 → 14); the 25-row piece would lose too much.
  assert.deepEqual(fitPieces(CATALOG, { maxRows: 22, bandRows: 6, columns: 100 }), [
    { id: 'cat', rows: 14, anchor: 'middle' },
    { id: 'wide', rows: 14, anchor: 'middle' },
    { id: 'fire', rows: 14, anchor: 'bottom' },
  ]);
  assert.equal(Math.ceil(18 * MIN_CROP), 14);
});

test('fitPieces: boundaries — a short or narrow terminal gets none', () => {
  const one = [{ id: 'p', meta: { rows: 16, cols: 64 } }];
  const fit = (m, b, c = 80) => fitPieces(one, { maxRows: m, bandRows: b, columns: c }).length;
  assert.equal(fit(12 + CAPTION_ROWS + SLACK_ROWS + 1, 1), 1, '12 rows of 16 is exactly three quarters');
  assert.equal(fit(12 + CAPTION_ROWS + SLACK_ROWS, 1), 0, 'one row short');
  assert.equal(fit(40, 1, 39), 0, 'under 40 columns: none');
  assert.equal(fit(5, 30), 0, 'a band taller than the room: none, never a negative crop');
  assert.equal(fitPieces(one, { maxRows: undefined, bandRows: 1, columns: undefined }).length, 1, 'an older engine: the fallbacks');
  assert.equal(fitPieces([], { maxRows: 40, bandRows: 1, columns: 80 }).length, 0);
});

test('bandHeight: the band\'s rows as the terminal wraps them — the Why takes as many rows as it wraps to', () => {
  const view = [
    'r ▶ Epic: X · L · ▲ risk HIGH',
    `  ❝ Why      ${'word '.repeat(60).trim()}`,
    '  ' + '─'.repeat(98),
    '  ◆ Status   Refining ─ Ready ─ ◉ Building ─ QA ─ Shipped',
  ].join('\n');
  const rows = bandRowsFrom(view);
  // 299 cells of Why at 100 columns: the value column is 100 - 2 - 13 = 85 wide → 4 rows.
  assert.equal(bandHeight(rows, 100), 1 + 4 + 1 + 1);
  assert.ok(bandHeight(rows, 60) > bandHeight(rows, 100), 'narrower wraps more');
  assert.equal(bandHeight([], 100), 0);
});

test('parseArgs and statusText', () => {
  assert.equal(parseArgs('').action, 'status');
  assert.equal(parseArgs('  NOW ').action, 'now');
  assert.deepEqual(parseArgs('12'), { action: 'minutes', minutes: 12, error: null });
  for (const bad of ['0', '241', 'soon', '5 min', '-3']) assert.ok(parseArgs(bad).error, bad);
  const base = { enabled: true, minutes: 3, active: false, mode: 'idle' };
  assert.match(statusText({ ...base, enabled: false }), /off/);
  assert.match(statusText({ ...base, mode: 'flight' }), /after 9 min away \(an epic is in flight; 3 min when nothing is\)/);
  assert.match(statusText({ ...base, active: true }), /playing now/);
  assert.match(statusText(base), /after 3 min away/);
});

// The real catalog is TypeScript: CI's Node 20 cannot import it, a Node that strips types can (22.18+, 24). Where it
// can, every piece is checked against the contract fitPieces relies on — each frame exactly `rows` lines of `cols`.
test('the real catalog: every frame is its declared size, and a crop keeps its anchored side', async (t) => {
  let pieces;
  try {
    ({ pieces } = await import('./ascii/index.ts'));
  } catch {
    return t.skip('this Node cannot import TypeScript');
  }
  const { cropLines } = await import('./screensaver-view-core.mjs');
  assert.equal(pieces.length, 10);
  for (const p of pieces) {
    const frame = p.make();
    for (const at of [0, 1.7, 33]) {
      const lines = frame(at, { paper: false }).split('\n');
      assert.equal(lines.length, p.meta.rows, `${p.id} rows at ${at}`);
      for (const l of lines) assert.ok([...l].length <= p.meta.cols, `${p.id} cols at ${at}`);
    }
    assert.ok(p.meta.cols <= 80, `${p.id} fits an 80-column terminal`);
  }
  const lines = ['a', 'b', 'c', 'd'];
  assert.deepEqual(cropLines(lines, 2, 'bottom'), ['c', 'd']);
  assert.deepEqual(cropLines(lines, 2, 'top'), ['a', 'b']);
  assert.deepEqual(cropLines(lines, 2, 'middle'), ['b', 'c']);
  assert.deepEqual(cropLines(lines, 9), lines);
});
