// screensaver.mjs — WHEN the screensaver runs (screensaver D1–D2). What it draws, and at what size, is
// scene-player.mjs (the ascii.rest scenes, rendered by scene-render.mjs).
//
// Pure, like build-view.mjs: no engine, no clock of its own (`now` is passed in), tested with node:test. index.tsx
// wires it to events; this file decides nothing about epics — "nothing in flight" is the resolver's own `○` header
// (build-state.mjs STATE_SYMBOLS.none), read the way the band reads it (D3: the mod never computes a fact).
//
// The rule (screensaver D1, set 2026-10-19): it plays when the person has been away — no typing, no submit, no turn
// running, no question waiting — for `minutes` (3 by default) while nothing is in flight, and for three times that
// while an epic is: the band is the useful thing then, so it waits longer. `/screensaver now` plays at once either way
// (S2, D7): the person asked, and the first key brings the band back.
// A turn is never "away": an agent's long turn streams output the person is reading. The first sign of the person
// ends it. Outside a Golden Frijoles repo — no view at all — counts as nothing in flight, so it plays anywhere the
// plugin is installed (the standalone install, D6).
import { headerOf } from './build-view.mjs';

export const IDLE_MINUTES = 3;
export const IN_FLIGHT_FACTOR = 3; // an epic in flight waits 3 × the minutes
export const CHECK_MS = 10_000; // how often the clock asks "has it been quiet long enough?"
const LABEL = 13; // the band's label column (build-view-one-story D1)

/** The view text → 'idle' (nothing in flight, or no view at all), 'flight' (an epic, idea or fix in flight). */
export function viewMode(text) {
  if (typeof text !== 'string' || !text.trim()) return 'idle';
  const h = headerOf(text.split('\n')[0]);
  return h && h.symbol === '○' ? 'idle' : 'flight';
}

/** True when nothing is in flight — no view at all included. */
export const isIdleView = (text) => viewMode(text) === 'idle';

const cells = (t) => [...String(t ?? '')].length;
const wrapped = (n, room) => Math.max(1, Math.ceil(n / Math.max(10, room)));

/**
 * How many terminal rows the band's rows take at `columns` — each wrapped the way index.tsx wraps it: a field's value
 * at the label column, a story under it, everything else on one row. An estimate the layout is made against: it can be
 * a row short (word wrap breaks early), which is what scene-player.mjs's SLACK_ROWS is for.
 */
export function bandHeight(rows, columns) {
  const body = (Number.isFinite(columns) ? columns : 100) - 2;
  return (rows || []).reduce((n, r) => {
    if (r.kind === 'field' || r.kind === 'story') return n + wrapped(cells(r.value), body - LABEL);
    if (r.kind === 'link' || r.kind === 'flag') return n + wrapped(cells(r.value) + 2, body - 2);
    if (r.kind === 'header') return n + (r.right ? 2 : 1);
    return n + 1;
  }, 0);
}

/**
 * The state machine. Every method returns whether `active` CHANGED, so the caller redraws only then.
 *   touch()          the person did something (typed, submitted, a turn began or ended, answered a question)
 *   onView(text)     the build view changed (or was cleared)
 *   tick({busy})     the clock: start if quiet long enough
 *   start()/stop()   /screensaver now, /screensaver stop
 *   configure(...)   /screensaver on|off|<minutes>, and the saved setting
 */
export function createSaver({ now = Date.now, random = Math.random } = {}) {
  const s = { enabled: true, idleMs: IDLE_MINUTES * 60_000, last: now(), active: false, mode: 'idle', seed: 0 };
  const wait = () => (s.mode === 'flight' ? s.idleMs * IN_FLIGHT_FACTOR : s.idleMs);
  const begin = () => {
    s.active = true;
    s.seed = Math.floor(random() * 1_000_000);
    return true;
  };
  const end = () => {
    const was = s.active;
    s.active = false;
    return was;
  };
  return {
    touch() {
      s.last = now();
      return end();
    },
    onView(text) {
      const was = s.mode;
      s.mode = viewMode(text);
      if (s.mode === was) return false;
      // The work changed under it (an epic went in flight, or ended): a change in the band is something to look at, so
      // the picture goes and a fresh quiet window starts.
      s.last = now();
      return end();
    },
    tick({ busy = false } = {}) {
      if (!s.enabled || s.active || busy) return false;
      return now() - s.last >= wait() ? begin() : false;
    },
    start() {
      if (!s.enabled) return { ok: false, reason: 'off' };
      begin();
      return { ok: true };
    },
    stop: end,
    configure({ enabled, minutes } = {}) {
      let changed = false;
      if (typeof enabled === 'boolean') {
        s.enabled = enabled;
        if (!enabled) changed = end();
      }
      if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 240) {
        s.idleMs = Math.round(minutes) * 60_000;
        s.last = now(); // a new threshold starts counting from now
      }
      return changed;
    },
    /** Draw it now? `isWorking` is the band's own prop: a turn is running. */
    visible({ isWorking = false, hasSurvey = false } = {}) {
      return s.enabled && s.active && !isWorking && !hasSurvey;
    },
    get state() {
      return {
        enabled: s.enabled,
        minutes: Math.round(s.idleMs / 60_000),
        active: s.active,
        mode: s.mode,
        seed: s.seed,
      };
    },
  };
}

/** `/screensaver` with no argument, and after each change: one line saying how it stands. */
export function statusText({ enabled, minutes, active, mode }) {
  if (!enabled) return 'screensaver: off. `/screensaver on` turns it back on.';
  const when = active
    ? 'playing now'
    : mode === 'flight'
      ? `starts after ${minutes * IN_FLIGHT_FACTOR} min away (an epic is in flight; ${minutes} min when nothing is)`
      : `starts after ${minutes} min away`;
  return `screensaver: on · ${when} · \`/screensaver now\` · \`off\` · \`<minutes>\``;
}

/** Parses the argument of `/screensaver` into one shape: `{ action, minutes, error }`, the unused fields null. */
export function parseArgs(args) {
  const a = String(args ?? '').trim().toLowerCase();
  const out = (action, minutes = null, error = null) => ({ action, minutes, error });
  if (!a || a === 'status') return out('status');
  if (['on', 'off', 'now', 'stop'].includes(a)) return out(a);
  if (/^\d+$/.test(a)) {
    const minutes = Number(a);
    return minutes >= 1 && minutes <= 240 ? out('minutes', minutes) : out(null, null, `screensaver: minutes must be 1–240, not ${a}.`);
  }
  return out(null, null, `screensaver: "${a}" — try on, off, now, stop or a number of minutes.`);
}
