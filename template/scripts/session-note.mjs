#!/usr/bin/env node
// session-note.mjs — append ONE intent-only line to the session journal (README.md D1, D2). This is
// deliberately the cheap half of session continuity (D1): no gh calls, no git status, no derivation at
// all — just scripts/lib/log-branch.mjs's appendLineToBranch, reused unchanged, on the dedicated
// `claude/session-journal` branch (never the working tree, never `main`).
//
// Usage:
//   node scripts/session-note.mjs --kind decision "text" [--refs PR#312,D4] [--session label]
//
// Kinds: decision | doing | next | blocked | declined. Append-only — no update, no delete, no status
// field (D2); the history is the point, a mutable journal would invite an agent to overwrite it instead.
//
// Fails SOFT (D1): a failed append (network/auth/push race) prints a warning and exits 0 — losing a
// journal line must never break the work the agent was actually doing. A USAGE error (bad --kind, no
// text) is different: that's the caller's bug, so it exits 1 loudly instead of silently no-op'ing.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appendLineToBranch } from './lib/log-branch.mjs';
import {
  buildJournalEntry,
  serializeEntry,
  VALID_KINDS,
  JOURNAL_BRANCH,
  JOURNAL_PATH,
} from './lib/session-journal.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function help() {
  return [
    'Usage: node scripts/session-note.mjs --kind <kind> "<text>" [--refs a,b] [--session label]',
    `Kinds: ${VALID_KINDS.join(' | ')}`,
    '',
    'Appends one JSON line to claude/session-journal via scripts/lib/log-branch.mjs. Append-only —',
    'no update, no delete, no status field. Fails soft: a failed append warns and still exits 0.',
  ].join('\n');
}

// Exported for scripts/session-note.test.mjs — a small hand-rolled parser (no npm dep), same style as
// scripts/babysit-pr.mjs's parseArgs. The positional (non-flag) argument is the note text.
export function parseArgs(argv) {
  const out = { kind: null, text: null, refs: null, session: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--kind') out.kind = argv[++i];
    else if (a === '--refs') out.refs = argv[++i];
    else if (a === '--session') out.session = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-') && out.text === null) out.text = a;
    else throw new Error(`unknown argument '${a}'`);
  }
  return out;
}

// `deps` injectable so scripts/session-note.test.mjs can drive this with no real git/network I/O — the
// same pattern cross-agent-cli.mjs's runWithCodexFallback uses. Returns the process exit code it decided
// on (never calls process.exit itself), so tests can assert on it directly.
export async function main(argv = process.argv.slice(2), deps = {}) {
  const { append = appendLineToBranch, log = console.log, warn = console.error, cwd = ROOT, now } = deps;

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    warn(`✗ ${e.message}\n\n${help()}`);
    return 1;
  }
  if (args.help) {
    log(help());
    return 0;
  }

  let entry;
  try {
    entry = buildJournalEntry({
      kind: args.kind,
      text: args.text,
      session: args.session,
      refs: args.refs,
      now,
    });
  } catch (e) {
    warn(`✗ ${e.message}\n\n${help()}`);
    return 1;
  }

  const ok = append({
    cwd,
    branch: JOURNAL_BRANCH,
    path: JOURNAL_PATH,
    line: serializeEntry(entry),
    message: `chore(session-note): ${entry.kind} — ${entry.text.slice(0, 60)}`,
  });

  if (!ok) {
    // D1: fails soft — this decision was NOT journalled, but that must never be treated as a reason to
    // stop or retry the caller's actual work.
    warn(
      `⚠ session-note: failed to append to ${JOURNAL_BRANCH} — this ${entry.kind} was NOT journalled. ` +
        'Continuing anyway (session-note fails soft by design).'
    );
    return 0;
  }

  log(`✓ journalled [${entry.kind}] to ${JOURNAL_BRANCH}: ${entry.text}`);
  return 0;
}

// realpath on both sides: through a symlinked path a plain compare is false and the script exits 0 having
// done nothing (#189 review).
const isMain = (() => {
  try {
    return (
      !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  });
}
