// session-budget.mjs — the session budget line's PURE half (session-budget D3).
//
// "One deep ask per approval gate; keep going while the budget line says so." This file is the line: a
// verdict (keep going / checkpoint / hand off) from the figures a session can actually see. Two callers
// import it and nothing else decides: the build-view mod (`hooks/index.tsx`, Claude Code, which has the
// engine's measured context and rate-limit figures) and `session-line.mjs` (Cowork, which has only what
// groom can count). One function, one threshold table, so the two surfaces can never disagree.
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
 * Time to a window's reset (D5): `-40m` under an hour, `-2h` up to 24 hours, `-3d` beyond — whole units, rounded down,
 * never `-0` (the last minute reads `-1m`). A reset that is unknown or already past → null, and nothing is shown.
 */
export function resetIn(at, now = Date.now()) {
  if (!known(at) || !known(now) || at <= now) return null;
  const minutes = Math.max(1, Math.floor((at - now) / 60_000));
  if (minutes < 60) return `-${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours <= 24) return `-${hours}h`;
  return `-${Math.floor(hours / 24)}d`;
}

/**
 * The Claude Code line in parts, each with its colour (D5): `[{ text: 'Session 48%', tone: 'good' }, { text: '5h 78%
 * (-2h)', tone: 'warn' }, …]`, the verdict last (tone null). Unknown figures are dropped (D4); nothing known → [].
 */
export function sessionParts(figures, verdict = sessionVerdict(figures), now = Date.now()) {
  const f = figures || {};
  const parts = [];
  const reset = (at) => {
    const r = resetIn(at, now);
    return r ? ` (${r})` : '';
  };
  if (known(f.contextPct)) parts.push({ text: `Session ${pct(f.contextPct)}`, tone: toneOf('contextPct', f.contextPct) });
  if (known(f.fiveHourPct))
    parts.push({ text: `5h ${pct(f.fiveHourPct)}${reset(f.fiveHourResetsAt)}`, tone: toneOf('fiveHourPct', f.fiveHourPct) });
  if (known(f.sevenDayPct))
    parts.push({ text: `7d ${pct(f.sevenDayPct)}${reset(f.sevenDayResetsAt)}`, tone: toneOf('sevenDayPct', f.sevenDayPct) });
  if (known(f.questionsWaiting) && f.questionsWaiting > 0)
    parts.push({ text: plural(f.questionsWaiting, 'question waiting', 'questions waiting'), tone: null });
  if (!parts.length) return [];
  return [...parts, { text: verdict.verdict, tone: null, verdict: true }];
}

/**
 * The Claude Code line as plain text: `Session 48% · 5h 23% (-2h) · 7d 9% (-3d) → keep going` — sessionParts, joined.
 * With nothing known at all there is no line — `null`, not `Session ? → keep going`.
 */
export function sessionLine(figures, verdict = sessionVerdict(figures), now = Date.now()) {
  const parts = sessionParts(figures, verdict, now);
  if (!parts.length) return null;
  return `${parts.slice(0, -1).map((p) => p.text).join(' · ')} → ${verdict.verdict}`;
}

/**
 * The Cowork line, printed by groom at each approval gate (D6). Cowork cannot see its own context fill, so
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
