// session-journal.mjs — pure builder/parser for the session-continuity intent journal (README.md D2).
// Shared by scripts/session-note.mjs (writer) and scripts/session-resume.mjs (reader) so the line format
// has exactly one definition. Zero I/O in this file on purpose — it's the pure seam both scripts unit-test
// against without touching git/gh/a branch.
//
// The journal is APPEND-ONLY and intent-only (D2): timestamp, session label, kind, one line of text,
// optional refs. No status field, no "done" marker, no update/delete — the history is the point. It lives
// on `claude/session-journal` via scripts/lib/log-branch.mjs (reused unchanged), one JSON object per line
// (JSONL, matching standup.mjs's standups.log convention already on the same kind of `claude/`-branch log).
//
// JOURNAL_PATH is a flat filename — log-branch.mjs's writeLogToBranch requires this (git mktree only
// builds a single-level tree; a nested path fails loud there, not here).

export const JOURNAL_BRANCH = 'claude/session-journal';
export const JOURNAL_PATH = 'session-journal.jsonl';

export const VALID_KINDS = ['decision', 'doing', 'next', 'blocked', 'declined'];

export function isValidKind(kind) {
  return VALID_KINDS.includes(kind);
}

// A stable per-day label so entries from the same calendar day (UTC) group without an agent having to
// invent or remember one. `now` is injectable for tests.
export function defaultSessionLabel(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// "PR#312,D4" → ["PR#312", "D4"]. Accepts an array too (already-split callers), undefined/empty → [].
export function parseRefs(refs) {
  if (!refs) return [];
  if (Array.isArray(refs)) return refs.map((r) => String(r).trim()).filter(Boolean);
  return String(refs)
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
}

// Pure line-builder — THE unit under test, no I/O (D1's "pure line-builder unit-tested separately from
// the I/O" acceptance). Throws on a bad kind or empty text — those are usage errors the CLI turns into a
// loud exit 1, distinct from D1's "failed append" soft-fail (that's about the I/O call, not this).
export function buildJournalEntry({ kind, text, session, refs, ts, now } = {}) {
  if (!isValidKind(kind)) {
    throw new Error(`invalid --kind "${kind}" — must be one of: ${VALID_KINDS.join(' | ')}`);
  }
  // Normalise embedded line breaks to a single space. JSON.stringify escapes them so the FILE stays
  // one-line-per-entry, but the rendered report prints `text` verbatim — so `$'decision A\nfake entry'`
  // displayed as two journal lines, one of which never happened. A journal that can be made to show
  // fabricated entries is worse than no journal, and this is an intent record a later agent trusts.
  const trimmed = (text || '').replace(/[\r\n]+/g, ' ').trim();
  if (!trimmed) {
    throw new Error('journal text must not be empty');
  }
  return {
    ts: ts || (now || new Date()).toISOString(),
    session: session || defaultSessionLabel(now),
    kind,
    text: trimmed,
    refs: parseRefs(refs),
  };
}

// One JSON line + trailing newline — the exact bytes appended to the journal file.
export function serializeEntry(entry) {
  return `${JSON.stringify(entry)}\n`;
}

// Parses journal file content into entries, oldest→newest. A single corrupt/partial line is DROPPED, not
// fatal — an append-only log must survive a bad line (e.g. a torn write) rather than making the whole
// journal unreadable. Returns [] for empty/null content (the "no journal yet" case).
export function parseJournal(content) {
  if (!content) return [];
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && typeof e === 'object');
}

// The last N entries, still in chronological (oldest→newest) order — D3's "then the last N journal
// lines" section reads top-to-bottom as a mini-timeline, not most-recent-first.
export function lastNEntries(entries, n) {
  if (!Array.isArray(entries) || n <= 0) return [];
  return entries.slice(Math.max(0, entries.length - n));
}

// One human-readable line per entry, for resume's "last N" section and any console echo.
export function formatEntry(entry) {
  const refs = entry.refs && entry.refs.length ? ` [${entry.refs.join(', ')}]` : '';
  const session = entry.session ? ` (${entry.session})` : '';
  return `[${entry.kind}] ${entry.ts}${session} — ${entry.text}${refs}`;
}
