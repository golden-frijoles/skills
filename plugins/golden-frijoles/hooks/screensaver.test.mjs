// screensaver.test.mjs — WHEN the screensaver runs and WHAT fits (screensaver D1–D6). node:test, no engine, no clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE_SYMBOLS } from './vendor/build-state.mjs';
import { bandRowsFrom } from './build-view.mjs';
import {
  IDLE_MINUTES, IN_FLIGHT_FACTOR, bandHeight, createSaver, isIdleView, parseArgs, statusText, viewMode,
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
