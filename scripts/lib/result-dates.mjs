// result-dates.mjs — the result record's date arithmetic, written once (result-record D5). Pure: zero I/O, zero deps.
//
// An epic that carries a target (`target_metric`) is read on its `read_date`. When none was written, the read falls
// 30 days after shipping; a verdict written more than 90 days after shipping is late (it is kept, and it does not count
// for the North Star). Those two numbers are `Roadmap/00-strategy/north-star.md`'s rule. Extract, `epic-read` and
// `session-resume` import them from here; `apps/web/lib/roadmap-result.ts` holds a copy a spec pins to this one.
//
// Every date is a calendar day, `YYYY-MM-DD`, read and written in UTC so a reader's timezone never moves a read. The
// day check itself is the contract's (`isDay`), which stays dependency-free.

export const READ_DEFAULT_DAYS = 30;
export const READ_CAP_DAYS = 90;

import { isDay } from './roadmap-contract.mjs';

export { isDay };

const MS_PER_DAY = 86_400_000;

/** The calendar day part of a date or date-time string, or null. `2026-10-04T12:00:00Z` → `2026-10-04`. */
export function dayOf(v) {
  if (typeof v !== 'string') return null;
  const day = v.slice(0, 10);
  return isDay(day) ? day : null;
}

/** `day` + `n` days, as `YYYY-MM-DD`. Null when `day` is not a day. */
export function addDays(day, n) {
  const d = dayOf(day);
  if (!d) return null;
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when `b` is later). Null when either is not a day. */
export function daysBetween(a, b) {
  const x = dayOf(a);
  const y = dayOf(b);
  if (!x || !y) return null;
  return Math.round((Date.parse(`${y}T00:00:00Z`) - Date.parse(`${x}T00:00:00Z`)) / MS_PER_DAY);
}

/** Today in UTC, `YYYY-MM-DD`. */
export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * The read date an epic is held to: the one written (or ship day, if it passed before shipping), else — only for a SHIPPED epic that HAS a target — 30 days after
 * shipping, marked derived. An epic with no target has no read date (it can still be read by hand), so the 54 epics
 * shipped before the result record existed are never due (the no-backfill rule).
 */
export function readDateOf({ readDate, targetMetric, shippedAt }) {
  // A day written at grooming that passes before the epic ships is read on ship day (codex review, #290): there was
  // nothing out there to read before then, and "overdue since before release" would be a false alarm.
  const shipped = dayOf(shippedAt);
  if (isDay(readDate))
    return { readDate: shipped && readDate < shipped ? shipped : readDate, derived: false };
  if (!targetMetric || !dayOf(shippedAt)) return { readDate: null, derived: false };
  return { readDate: addDays(shippedAt, READ_DEFAULT_DAYS), derived: true };
}

/** Whether a verdict written on `verdictAt` is late: more than 90 days after shipping. False when either is unknown. */
export function isLate({ verdictAt, shippedAt }) {
  const days = daysBetween(shippedAt, verdictAt);
  return days !== null && days > READ_CAP_DAYS;
}

/**
 * Whether a read is due today: a shipped epic with a target, no verdict yet, and a read date that has arrived. An epic
 * not yet shipped is never due, even past a read date written at grooming: there is nothing out there to read.
 */
export function isReadDue({ targetMetric, verdict, readDate, shipped }, today = todayUtc()) {
  if (!shipped || !targetMetric || verdict || !isDay(readDate)) return false;
  return today >= readDate;
}
