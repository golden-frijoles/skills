// session-budget.mjs — the session budget line's PURE half (session-budget D3).
//
// "One deep ask per approval gate; keep going while the budget line says so." This file is the line: a
// verdict (keep going / checkpoint / hand off) from the figures a session can actually see. Two callers
// import it and nothing else decides: the build-view mod (`hooks/index.tsx`, Claude Code, which has the
// engine's measured context and rate-limit figures) and `session-line.mjs` (Cowork, which has only what
// refine can count). One function, one threshold table, so the two surfaces can never disagree.
//
// NO Node imports, on purpose: the mod's module environment has no Node, and it imports this file.
//
// The rules that shape it:
//   • Unknown is not zero (D4). `context.percent` is absent early in a session and after /compact; rate
//     limits exist only on a subscription, after the first response. A missing figure is left out of the
//     line AND out of the verdict — never read as 0%, which would say "keep going" about nothing.
//   • Advise, never act (D5). Nothing here, or in either caller, compacts, clears or ends a session.
//   • The thresholds are provisional. They live in THRESHOLDS and nowhere else, and every verdict is logged
//     (`.golden-frijoles/session-budget.jsonl`, D7) so they can be fitted from real sessions later.

/** The one table. `atLeast` is inclusive: context 60 is a checkpoint, 59 is not. Hand off wins. */
export const THRESHOLDS = Object.freeze({
  handOff: Object.freeze({ contextPct: 80, fiveHourPct: 90 }),
  checkpoint: Object.freeze({ contextPct: 60, questionsWaiting: 3 }),
});

export const VERDICTS = Object.freeze(['keep going', 'checkpoint', 'hand off']);

/**
 * Each figure's colour on the Claude Code line (build-view-upgrade D5): good below `warn`, warn from it, bad from
 * `bad`. `bad` IS the hand-off line where one exists (context, 5 h), so red means "this figure says hand off"; the
 * 7-day window has no hand-off and borrows the 5-hour one. A colour advises like the verdict does, and changes nothing.
 */
export const TONES = Object.freeze({
  contextPct: Object.freeze({ warn: THRESHOLDS.checkpoint.contextPct, bad: THRESHOLDS.handOff.contextPct }),
  fiveHourPct: Object.freeze({ warn: 60, bad: THRESHOLDS.handOff.fiveHourPct }),
  sevenDayPct: Object.freeze({ warn: 60, bad: THRESHOLDS.handOff.fiveHourPct }),
});

export const LOG_DIR = '.golden-frijoles';
export const LOG_FILE = `${LOG_DIR}/session-budget.jsonl`;
/** Written beside the log so the folder is ignored in ANY project, without touching its root .gitignore. */
export const LOG_GITIGNORE = { path: `${LOG_DIR}/.gitignore`, text: '# session-budget D7: local figures, never committed\n*\n' };

const known = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * The verdict for one set of figures. Each figure may be null/undefined (unknown): an unknown figure can
 * neither trip a threshold nor clear one — it is simply not a reason.
 *
 * @returns {{ verdict: 'keep going'|'checkpoint'|'hand off', reasons: string[] }}
 */
export function sessionVerdict(figures) {
  const { contextPct, fiveHourPct, questionsWaiting } = figures || {};
  const hand = [];
  if (known(contextPct) && contextPct >= THRESHOLDS.handOff.contextPct) hand.push(`context ≥ ${THRESHOLDS.handOff.contextPct}%`);
  if (known(fiveHourPct) && fiveHourPct >= THRESHOLDS.handOff.fiveHourPct) hand.push(`5-hour limit ≥ ${THRESHOLDS.handOff.fiveHourPct}%`);
  if (hand.length) return { verdict: 'hand off', reasons: hand };

  const check = [];
  if (known(contextPct) && contextPct >= THRESHOLDS.checkpoint.contextPct) check.push(`context ≥ ${THRESHOLDS.checkpoint.contextPct}%`);
  if (known(questionsWaiting) && questionsWaiting >= THRESHOLDS.checkpoint.questionsWaiting) {
    check.push(`${THRESHOLDS.checkpoint.questionsWaiting}+ questions waiting`);
  }
  if (check.length) return { verdict: 'checkpoint', reasons: check };
  return { verdict: 'keep going', reasons: [] };
}

/**
 * The figures in a `session.measure` event (or a `$.session.usage()` answer — same shape, D2). Anything
 * absent comes back null, never 0.
 */
export function figuresFromMeasure(e) {
  const ctx = e && e.context;
  const limits = Array.isArray(e && e.rateLimits) ? e.rateLimits : [];
  const windowOf = (kind) => limits.find((l) => l && l.kind === kind);
  const windowPct = (kind) => {
    const w = windowOf(kind);
    return w && known(w.percentUsed) ? w.percentUsed : null;
  };
  // build-view-upgrade D5 — when each window resets, as epoch ms (the engine sends ISO 8601); unparseable → null.
  const resetsAt = (kind) => {
    const at = Date.parse(windowOf(kind)?.resetsAt ?? '');
    return known(at) ? at : null;
  };
  return {
    contextPct: ctx && known(ctx.percent) ? ctx.percent : null,
    fiveHourPct: windowPct('five_hour'),
    sevenDayPct: windowPct('seven_day'),
    fiveHourResetsAt: resetsAt('five_hour'),
    sevenDayResetsAt: resetsAt('seven_day'),
  };
}

const pct = (n) => `${Math.round(n)}%`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** A figure's colour per TONES: 'good' | 'warn' | 'bad'. */
export function toneOf(key, value) {
  const t = TONES[key];
  if (!t || !known(value)) return null;
  return value >= t.bad ? 'bad' : value >= t.warn ? 'warn' : 'good';
}

/**
 * Time to a window's reset, to the minute (build-view-one-story D9): `in 40m` under an hour, `in 1h 29m` under a day,
 * `in 3d 4h` beyond — floored, a zero unit left out, never `in 0m` (the last minute reads `in 1m`). It replaced `-1h`,
 * which read as "an hour ago" for a reset 1 h 29 m away (seen 2026-10-10). Unknown or already past → null.
 */
export function resetIn(at, now = Date.now()) {
  if (!known(at) || !known(now) || at <= now) return null;
  const minutes = Math.max(1, Math.floor((at - now) / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  return `in ${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
}

/** The wall-clock time of a reset in the runtime's local time, `9:20 pm` / `12:05 am` (D9). Unknown → null. */
export function clockTime(at) {
  if (!known(at)) return null;
  const d = new Date(at);
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

export const METER_WIDTH = 10;

/**
 * The Claude Code line in parts, each with its colour (D5): `[{ text: 'Session 48%', tone: 'good' }, { text: '5h ▰▰▰▰▰▰▰▰▱▱
 * 78% · resets 3:30 am (in 2h 30m)', tone: 'warn', meter: {…} }, …]`, the verdict last (tone null). The 5-hour part is a
 * meter (D9): `meter` splits its text so the band can draw the empty cells dim. Unknown figures are dropped (D4);
 * nothing known → [].
 */
export function sessionParts(figures, verdict = sessionVerdict(figures), now = Date.now()) {
  const f = figures || {};
  const parts = [];
  if (known(f.contextPct)) parts.push({ text: `Session ${pct(f.contextPct)}`, tone: toneOf('contextPct', f.contextPct) });
  if (known(f.fiveHourPct)) {
    // Floored, like the stories bar: the meter is never drawn full before the budget is (#396 verifier: 95% read full).
    const filled = Math.max(0, Math.min(METER_WIDTH, Math.floor((f.fiveHourPct / 100) * METER_WIDTH)));
    const r = resetIn(f.fiveHourResetsAt, now);
    const meter = {
      head: '5h ',
      filled: '▰'.repeat(filled),
      empty: '▱'.repeat(METER_WIDTH - filled),
      tail: ` ${pct(f.fiveHourPct)}${r ? ` · resets ${clockTime(f.fiveHourResetsAt)} (${r})` : ''}`,
    };
    parts.push({
      text: `${meter.head}${meter.filled}${meter.empty}${meter.tail}`,
      tone: toneOf('fiveHourPct', f.fiveHourPct),
      meter,
    });
  }
  if (known(f.sevenDayPct)) {
    const r = resetIn(f.sevenDayResetsAt, now);
    parts.push({ text: `7d ${pct(f.sevenDayPct)}${r ? ` (${r})` : ''}`, tone: toneOf('sevenDayPct', f.sevenDayPct) });
  }
  if (known(f.questionsWaiting) && f.questionsWaiting > 0)
    parts.push({ text: plural(f.questionsWaiting, 'question waiting', 'questions waiting'), tone: null });
  if (!parts.length) return [];
  return [...parts, { text: verdict.verdict, tone: null, verdict: true }];
}

/**
 * The Claude Code line as plain text: `Session 48% · 5h ▰▰▱▱▱▱▱▱▱▱ 23% · resets 9:20 pm (in 1h 29m) · 7d 9% (in 3d 4h)
 * → keep going` — sessionParts, joined.
 * With nothing known at all there is no line — `null`, not `Session ? → keep going`.
 */
export function sessionLine(figures, verdict = sessionVerdict(figures), now = Date.now()) {
  const parts = sessionParts(figures, verdict, now);
  if (!parts.length) return null;
  return `${parts.slice(0, -1).map((p) => p.text).join(' · ')} → ${verdict.verdict}`;
}

/**
 * The Cowork line, printed by refine at each approval gate (D6). Cowork cannot see its own context fill, so
 * the line says so instead of guessing.
 */
export function coworkLine({ asksOpen, questionsWaiting, gatesPassed } = {}, verdict = sessionVerdict({ questionsWaiting })) {
  const parts = [];
  if (known(asksOpen)) parts.push(plural(asksOpen, 'ask open', 'asks open'));
  if (known(questionsWaiting)) parts.push(plural(questionsWaiting, 'question waiting', 'questions waiting'));
  if (known(gatesPassed)) parts.push(plural(gatesPassed, 'gate passed', 'gates passed'));
  parts.push('context: not measured here');
  return `${parts.join(' · ')} → ${verdict.verdict}`;
}

/** One `.golden-frijoles/session-budget.jsonl` row: the figures, the verdict and where it was measured. */
export function budgetRow({ at, surface, figures = {}, verdict }) {
  const row = { at: new Date(at).toISOString(), surface, verdict: verdict.verdict, reasons: verdict.reasons };
  // The budget figures only: when a window resets is not a reading of the session (build-view-upgrade D5).
  for (const [k, v] of Object.entries(figures)) if (known(v) && !k.endsWith('ResetsAt')) row[k] = v;
  return JSON.stringify(row);
}
