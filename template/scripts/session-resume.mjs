#!/usr/bin/env node
// session-resume.mjs — the expensive half of session continuity (README.md D1): derive the TRUE state,
// live, across the project's repos + the intent journal, and lead with what's surprising (D3). Never trust a
// stale doc or a resumed agent's pre-kill memory — this opens with real git/gh/DB reads.
//
// Usage:
//   node scripts/session-resume.mjs [--json] [--root <path>] [--journal-limit N] [--all-migrations]
//
// WHICH repos: the project's one repo list — reporting.config.json's `repos` — plus its optional
// `checkouts` map (`{ "owner/name": "apps/web" }`, relative to --root) naming where each is checked out
// locally. A repo with a checkout gets the full git read; one without gets the gh read only, and the brief
// says so. With no reporting.config.json at all this degrades (D4) to the repo it runs in. Ported into the
// dobby-foundation template by plugin-audit-and-extraction S2 (story 2.3); the logic is the origin's.
//
// --root defaults to this script's own repo root, so checkouts nested inside it (e.g. apps/<name>, each
// its OWN git repo) resolve as siblings. Pass --root explicitly when running from a worktree of the root
// repo: a `git worktree add` does NOT populate gitignored nested checkouts, so without --root those repos
// correctly degrade to "path not found" — itself one of D4's named degradation classes.
//
// Derives (D3's "full derived state"): current branch, ahead/behind origin/main, dirty/untracked files,
// `git worktree list` + each worktree's own dirty state, open PRs with mergeability + CI rollup, recently
// merged PRs — across the SAME repos standup.mjs reads (reporting.config.json). Plus migration drift
// (D5): repo migration files vs the live `supabase_migrations.schema_migrations`, both directions, via
// `supabase migration list --linked` (a read-only CLI call — this script NEVER applies a migration, never
// `db push`). That check only runs against a repo that actually owns a non-empty `supabase/migrations`
// directory — a checkout with no migrations of its own is skipped uneventfully (not flagged as 100%
// drift) rather than compared against migration files that simply don't live there. A project that does
// not use supabase never triggers this check at all.
//
// Anomalies first (D3): a non-main branch with no open PR (in the origin project, a backend checkout
// left on a feature branch nobody had opened — the case that motivated this script), a dirty tree (main or any worktree), an open PR with red CI or a
// conflict, migration drift in EITHER direction. Then the last N journal lines
// (scripts/lib/session-journal.mjs, read from claude/session-journal via scripts/lib/log-branch.mjs,
// reused unchanged). Then the full derived state.
//
// Degrades, never dies (D4): every gather step below returns `{ available: false, reason }` on failure
// instead of throwing — an unauthenticated gh, a missing/unreachable repo, an empty/unfetchable journal,
// or an unavailable migration check each produce a partial brief that NAMES the gap, never a stack trace.
//
// Reuse, don't rebuild: scripts/lib/gh-rest.mjs (listPulls/getPullMergeability/getStatusRollup) — REST-
// only on purpose (GraphQL is blocked in at least one routine sandbox); scripts/lib/log-branch.mjs
// (readLogFromBranch) unchanged. Zero new npm deps — Node >=18 (spawnSync).

import { spawnSync } from 'node:child_process';

// The session read limit for MEMORY.md, and the working budget that keeps a session's
// worth of edits from crossing it. Both in bytes; see decideMemoryBudgetAnomaly.
export const MEMORY_HARD_LIMIT_BYTES = 25_000;
export const MEMORY_BUDGET_BYTES = 23_552;
import { existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { listPulls, getPullMergeability, getStatusRollup } from './lib/gh-rest.mjs';
import { readLogFromBranch } from './lib/log-branch.mjs';
import { gatherFacts } from './lib/stage-facts.mjs';
import {
  parseJournal,
  lastNEntries,
  formatEntry,
  JOURNAL_BRANCH,
  JOURNAL_PATH,
} from './lib/session-journal.mjs';
import { loadReportingConfig, ReportingConfigError } from './lib/reporting-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');

/**
 * The repos to derive state for, as `{ repo, dir }` (`dir` relative to --root; null = no local checkout).
 * From reporting.config.json — the same list the standup reads — and its optional `checkouts` map. The
 * repo whose `origin` remote this checkout points at is `.` unless the map says otherwise. No config →
 * just this repo (D4: degrade, never die), with the reason returned so the brief can name the gap.
 */
export function resolveRepos({
  root = DEFAULT_ROOT,
  loadConfig = loadReportingConfig,
  spawn = spawnSync,
} = {}) {
  const origin = originRepo({ root, spawn });
  let config;
  try {
    config = loadConfig({ root });
  } catch (e) {
    if (!(e instanceof ReportingConfigError)) throw e;
    return {
      repos: origin ? [{ repo: origin, dir: '.' }] : [],
      note: `no usable reporting.config.json (${e.message.split('\n')[0]}) — reading only this repo`,
    };
  }
  const checkouts = config.checkouts || {};
  return {
    repos: config.repos.map((repo) => ({
      repo,
      dir: checkouts[repo] ?? (repo === origin ? '.' : null),
    })),
    note: null,
  };
}

function originRepo({ root, spawn }) {
  const r = spawn('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const m = String(r.stdout)
    .trim()
    .match(/github\.com[:/]([^/]+\/[^/.\s]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

const JOURNAL_LIMIT_DEFAULT = 10;
const RECENT_MERGED_LIMIT = 8;
// 7 days. Delivery here is measured in hours and dependabot's cadence is weekly, so a non-draft PR
// still open after a week has stopped being in-flight work and started being a decision nobody made.
// Deliberately not lower: a threshold that fires on healthy PRs gets skimmed past, and a skimmed
// anomaly line is worth less than no line at all.
const STALE_PR_DAYS = 7;
const MIGRATION_TIMEOUT_MS = 60000;

function lastLine(s) {
  return (s || '').trim().split('\n').filter(Boolean).pop() || 'unknown error';
}

// ============================================================================================
// PURE derive/format seam — unit-tested without gh/git/a database (scripts/session-resume.test.mjs).
// Every function below takes already-gathered facts and makes no I/O call of its own.
// ============================================================================================

// `git worktree list --porcelain` → an array of { path, branch, detached, locked, bare }. Blocks are
// separated by a blank line; `branch refs/heads/X` → X (bare ref name, no `refs/heads/` prefix).
export function parseWorktreeListPorcelain(text) {
  const blocks = (text || '').trim().split(/\n\n+/).filter(Boolean);
  return blocks.map((block) => {
    const out = { path: null, branch: null, detached: false, locked: false, bare: false };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) out.path = line.slice('worktree '.length).trim();
      else if (line.startsWith('branch '))
        out.branch = line.slice('branch '.length).replace('refs/heads/', '').trim();
      else if (line === 'detached') out.detached = true;
      else if (line.startsWith('locked')) out.locked = true;
      else if (line === 'bare') out.bare = true;
    }
    return out;
  });
}

// `supabase migration list --linked` prints a 3-column ASCII table (Local | Remote | Time), NOT
// machine-readable JSON even with `-o json` (confirmed live, CLI 2.98.1 — the flag is accepted but
// ignored for this subcommand), so this parses the pretty table directly. A blank Local column means
// "applied remotely, no local file"; a blank Remote column means "local file, not applied remotely" — D5
// wants BOTH directions. Header/separator rows (`Local | Remote | ...`, `---|---|---`) are skipped; a
// data row needs at least one 14-digit timestamp version in either column.
export function parseMigrationListTable(text) {
  const rows = [];
  for (const raw of (text || '').split('\n')) {
    if (!raw.includes('|')) continue;
    const parts = raw.split('|').map((s) => s.trim());
    if (parts.length < 2) continue;
    const [local, remote] = parts;
    if (/^local$/i.test(local) || /^-+$/.test(local.replace(/\s/g, ''))) continue;
    const localVer = /^\d{14}$/.test(local) ? local : null;
    const remoteVer = /^\d{14}$/.test(remote) ? remote : null;
    if (!localVer && !remoteVer) continue;
    rows.push({ local: localVer, remote: remoteVer });
  }
  // A version is APPLIED if it appears in the remote column of ANY row — not merely of its own row.
  // Two local files may share one timestamp (we have exactly that: 20260711120000 is used by both
  // `..._migrations_connector_enabled_flag.sql` and `..._seller_shell_on_sell_enabled_flag.sql`).
  // `schema_migrations` is keyed by version, so it can only ever record ONE of them, and the CLI then
  // prints the pair as two rows: `local|remote` for the recorded one and `local|<blank>` for the other.
  //
  // Reading that blank row naively as "unapplied" is FALSE — verified live 2026-07-26: the version is in
  // schema_migrations and both flag rows exist in the project's own tables. Worse, it is false on the one signal
  // that has to be trustworthy: it would send someone to re-apply an already-applied migration. So a
  // version present anywhere in the remote column is applied, and the duplicate is reported as what it
  // actually is — a version collision, which is a real (if minor) repo defect worth naming once.
  const appliedVersions = new Set(rows.map((r) => r.remote).filter(Boolean));
  const localVersions = rows.map((r) => r.local).filter(Boolean);
  const localSet = new Set(localVersions);

  const seen = new Set();
  const duplicateLocalVersions = [];
  for (const v of localVersions) {
    if (seen.has(v) && !duplicateLocalVersions.includes(v)) duplicateLocalVersions.push(v);
    seen.add(v);
  }

  return {
    rows,
    unappliedLocal: [...new Set(localVersions.filter((v) => !appliedVersions.has(v)))],
    appliedNoFile: [...new Set(rows.map((r) => r.remote).filter((v) => v && !localSet.has(v)))],
    duplicateLocalVersions,
  };
}

// A statusCheckRollup (scripts/lib/gh-rest.mjs's buildStatusRollup shape) has at least one hard failure —
// same predicate babysit-pr.mjs's decideBabysitActions uses for "failingChecks".
export function rollupHasFailure(rollup) {
  return (
    Array.isArray(rollup) &&
    rollup.some((c) => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR' || c.state === 'FAILURE')
  );
}

export function rollupHasPending(rollup) {
  return (
    Array.isArray(rollup) &&
    rollup.some(
      (c) => !c.conclusion && (c.status === 'IN_PROGRESS' || c.status === 'QUEUED' || c.status === 'PENDING')
    )
  );
}

// THE motivating anomaly (README.md, epic Why): a non-main, non-detached branch with no open PR pointing
// at it. `openPrs` is a TRI-STATE: an array (gh reachable — even empty is a confirmed "no PRs"), or
// anything else (gh unavailable — we genuinely don't know, so this must NOT claim a false positive; that
// case is surfaced as a GAP instead, never as a confirmed anomaly).
export function decideStrayBranch({ branch, detached, openPrs }) {
  if (!branch || detached || branch === 'main') return null;
  if (!Array.isArray(openPrs)) return null;
  const hasPr = openPrs.some((pr) => pr.headRefName === branch);
  if (hasPr) return null;
  return {
    type: 'stray-branch',
    detail: `on branch \`${branch}\` with no open PR — leftover state from an earlier session (the case that motivated this check).`,
  };
}

export function decideDirtyTree({ label, dirtyFiles }) {
  if (!dirtyFiles) return null;
  return {
    type: 'dirty-tree',
    detail: `${label}: ${dirtyFiles} uncommitted/untracked file${dirtyFiles === 1 ? '' : 's'}.`,
  };
}

export function decideWorktreeAnomalies(worktrees) {
  return (worktrees || [])
    .filter((w) => w.dirty)
    .map((w) => ({
      type: 'dirty-tree',
      detail: `worktree ${w.path} (branch ${w.branch || 'detached'}): uncommitted changes.`,
    }));
}

// A PR nobody has closed the loop on is the single most repeated failure this report exists to catch,
// and until now it was invisible here: `open PRs: 4` reads identically whether they were opened this
// morning or five weeks ago. On 2026-08-24 the backend carried four dependabot PRs aged 10–17 days and
// this repo had four advisory audit PRs stranded since 08-03 — the audit series had simply stopped
// being harvested, and nothing in any session ever said so out loud.
//
// THREE states, not two, because "I could not work out the age" is a different fact from "it is fresh":
//   • a parseable createdAt older than the threshold  → stale, with the age named
//   • a parseable createdAt inside the threshold      → nothing (the overwhelmingly common case)
//   • createdAt absent or unparseable                 → an explicit unknown-age anomaly, never silence
//
// Drafts are EXCLUDED. A draft is open on purpose — flagging it would train the reader to skim past
// this line, which is the failure mode that made the stale PRs invisible in the first place.
export function decideStalePrAnomalies(open, { nowISO, thresholdDays = STALE_PR_DAYS } = {}) {
  const now = Date.parse(nowISO);
  if (!Number.isFinite(now)) return []; // no trustworthy clock ⇒ assert nothing, rather than assert wrongly
  const out = [];
  for (const pr of open || []) {
    const created = Date.parse(pr.createdAt ?? '');
    if (!Number.isFinite(created)) {
      out.push({
        type: 'pr-age-unknown',
        detail: `PR #${pr.number} "${pr.title}" (${pr.url}) — open, but its creation date could not be read, so its age is UNKNOWN.`,
      });
      continue;
    }
    const days = Math.floor((now - created) / 86400000);
    if (days < thresholdDays) continue;

    // A draft needs a SHARPER test than age, not an exemption. The first cut of this guard skipped
    // every draft on the reasoning that "a draft is open on purpose" — and that reasoning is exactly
    // wrong for the failure this repo has already recorded: nightly smoke-fix routines open DRAFTS,
    // and they pile up (4 stacked by 2026-08-02; six red nights were unmerged fixes, not quota).
    // Proven again 2026-08-25 — frontend #404 sat a green, finished, 5-day-old draft that this guard
    // skipped by design, and merging it was the fix for a nightly red.
    //
    // So the question is not "is it a draft" but "does it look FINISHED": a draft whose CI is green
    // and which GitHub says is mergeable is done work nobody landed. A draft still red, still
    // pending, or conflicting is genuinely in progress and stays silent — that is the negation this
    // guard must keep allowing, or it goes back to crying wolf.
    if (pr.isDraft) {
      const looksFinished = pr.ciAvailable && !pr.ciFailing && !pr.ciPending && pr.mergeable === 'MERGEABLE';
      if (looksFinished) {
        out.push({
          type: 'pr-draft-finished',
          detail: `PR #${pr.number} "${pr.title}" (${pr.url}) is a DRAFT that has been green and mergeable for ${days} days — finished work nobody landed. Mark it ready or close it.`,
        });
      }
      continue;
    }

    out.push({
      type: 'pr-stale',
      detail: `PR #${pr.number} "${pr.title}" (${pr.url}) has been open ${days} days — decide it or close it.`,
    });
  }
  return out;
}

// Renders an age for the full-state listing. Returns 'unknown' rather than a plausible-looking 0 when
// the date cannot be read — the same three-state discipline decideStalePrAnomalies applies.
export function prAgeLabel(pr, nowISO = new Date().toISOString()) {
  const now = Date.parse(nowISO);
  const created = Date.parse(pr?.createdAt ?? '');
  if (!Number.isFinite(now) || !Number.isFinite(created)) return 'unknown';
  return `${Math.floor((now - created) / 86400000)}d`;
}

// Every anomaly is rendered as `[${a.type}] ${a.detail}`, so a decider returning any other shape prints
// "[undefined] undefined" — a line that looks like a bug in the reader's terminal rather than the fact it
// is carrying. That is not hypothetical: decideMemoryBudgetAnomaly returned {kind, text} from the day it
// was added (#160), so the ONE anomaly whose entire job is to say "MEMORY.md is silently truncating" was
// itself silently unreadable, and it printed that way at the top of every report for weeks. Found
// 2026-08-24 with the index 0.3 KB over budget and the warning live.
//
// Normalising the shape is the fix; this is the guard that keeps it normalised. It asserts on the
// POPULATION every run rather than on the one decider that was wrong.
export function assertRenderableAnomalies(anomalies) {
  const bad = (anomalies || []).filter(
    (a) => !a || typeof a.type !== 'string' || typeof a.detail !== 'string'
  );
  if (bad.length) {
    throw new Error(
      `${bad.length} anomaly/anomalies lack a string \`type\`+\`detail\` and would render as ` +
        `"[undefined] undefined": ${JSON.stringify(bad).slice(0, 400)}`
    );
  }
  return anomalies;
}

export function decidePrAnomalies(open) {
  const out = [];
  for (const pr of open || []) {
    if (pr.mergeable === 'CONFLICTING') {
      out.push({
        type: 'pr-conflict',
        detail: `PR #${pr.number} "${pr.title}" (${pr.url}) has a merge conflict.`,
      });
    }
    if (pr.ciFailing) {
      out.push({ type: 'pr-ci-red', detail: `PR #${pr.number} "${pr.title}" (${pr.url}) has red CI.` });
    }
  }
  return out;
}

// The two directions of migration drift are NOT equally urgent, and treating them as equal broke this
// report's whole purpose on its first real run (2026-07-26): 36 orphans buried the 3 genuinely
// actionable anomalies, which is precisely the attention failure D3 exists to prevent.
//
//   unappliedLocal — a file exists, the live table has no such version. DANGEROUS and per-item: code
//     that reads a new column against an unmigrated table breaks a live path. Every one is listed.
//
//   appliedNoFile ("orphans") — the live table has a version with no local file. This is the EXPECTED
//     residue of our documented workflow, not a defect: WAYS-OF-WORKING records that the Supabase MCP
//     `apply_migration` stamps its OWN timestamp as the version, so the row and the filename diverge
//     unless someone realigns `schema_migrations` by hand afterwards. Most orphans are therefore old
//     applies nobody realigned — real, but historical and never actionable at session-resume time.
//     Collapsed to ONE counted line that still names the versions, so the information is kept and the
//     signal is not drowned. `--all-migrations` restores the per-item listing when that is the task.
export function decideMigrationAnomalies({
  repo,
  unappliedLocal,
  appliedNoFile,
  duplicateLocalVersions,
  expandOrphans = false,
}) {
  const out = [];
  for (const v of unappliedLocal || []) {
    out.push({
      repo,
      type: 'migration-unapplied',
      detail: `migration ${v} has a file but is NOT in the live schema_migrations table.`,
    });
  }
  for (const v of duplicateLocalVersions || []) {
    out.push({
      repo,
      type: 'migration-duplicate-version',
      detail:
        `two or more local migration files share version ${v}. schema_migrations is keyed by version, ` +
        `so only one can ever be recorded — the others are permanently unrecordable. The effect may still ` +
        `be applied; check before re-running anything.`,
    });
  }
  const orphans = appliedNoFile || [];
  if (expandOrphans) {
    for (const v of orphans) {
      out.push({
        repo,
        type: 'migration-orphan',
        detail: `schema_migrations has version ${v} applied live with no matching local file.`,
      });
    }
  } else if (orphans.length) {
    const shown = orphans.slice(0, 5).join(', ');
    const more = orphans.length > 5 ? `, +${orphans.length - 5} more` : '';
    out.push({
      repo,
      type: 'migration-orphan-summary',
      detail:
        `${orphans.length} applied version(s) have no matching local file (${shown}${more}). ` +
        `Usually the known MCP-timestamp/filename divergence, not unshipped work — re-run with --all-migrations to list them.`,
    });
  }
  return out;
}

// Aggregates every anomaly category, across all repos + the migration check, in D3's "anomalies first"
// intent. Order: per-repo (stray branch, dirty tree, worktree dirt, PR conflict, PR CI-red), then
// migration drift. `repoStates`/`migrationResults` are the already-gathered facts (this function does no
// I/O of its own — the pure seam the contract requires).
/**
 * D-mem: the session memory index has a READ LIMIT, and going over it fails silently.
 *
 * `~/.claude/projects/<slug>/memory/MEMORY.md` is loaded into every session, but only the
 * first ~24.4 KB of it. Past that the tail is TRUNCATED with no error anywhere — and the
 * tail is where the "Open items owed to the product owner" section and the epic lists live, so the
 * failure mode is an agent that cannot see what it owes and has no way to know. It reached
 * 29.7 KB on 2026-08-19 and had been truncating for an unknown number of sessions; the only
 * reason it surfaced was a warning appended to the file's own loaded prefix.
 *
 * A byte count is the whole check. It runs at session start, where the answer can still
 * change what the session does.
 *
 * Three states on purpose: over budget, within budget, and UNREADABLE. A memory directory
 * that cannot be read must never be reported as "fine" — that is the same collapse this
 * repo bans everywhere else (AGENTS.md rule 5).
 */
export function decideMemoryBudgetAnomaly({
  available,
  bytes,
  limitBytes = MEMORY_HARD_LIMIT_BYTES,
  budgetBytes = MEMORY_BUDGET_BYTES,
  path,
}) {
  if (!available) {
    return {
      type: 'memory-index-unavailable',
      detail: `Could not read the session memory index${path ? ` (${path})` : ''} — its size is UNKNOWN, not fine. If it is over ~${Math.round(limitBytes / 1024)} KB it is being silently truncated.`,
    };
  }
  // `available: true` with a non-numeric size is a malformed reading, and letting it
  // fall through would return null — "no anomaly" — from a size nobody actually knows.
  // That is the exact collapse the three states exist to prevent, so it reports as
  // unavailable rather than as fine.
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) {
    return {
      type: 'memory-index-unavailable',
      detail: `The session memory index reported a size of \`${String(bytes)}\`${path ? ` (${path})` : ''} — UNKNOWN, not fine.`,
    };
  }
  if (bytes > limitBytes) {
    return {
      type: 'memory-index-truncating',
      detail: `MEMORY.md is ${(bytes / 1024).toFixed(1)} KB, over the ~${(limitBytes / 1024).toFixed(1)} KB session read limit — it IS being truncated right now, and the tail (owed items, epic lists) is not reaching this session. Tighten index lines; move detail into topic files.`,
    };
  }
  if (bytes > budgetBytes) {
    return {
      type: 'memory-index-near-limit',
      detail: `MEMORY.md is ${(bytes / 1024).toFixed(1)} KB, over its ${(budgetBytes / 1024).toFixed(0)} KB working budget (hard truncation at ~${(limitBytes / 1024).toFixed(1)} KB). Tighten one line before adding another.`,
    };
  }
  return null;
}

/**
 * Reads the size of this project's MEMORY.md. I/O shell only — the DECISION is
 * `decideMemoryBudgetAnomaly`, which is what the tests exercise.
 *
 * `deps.stat` is injected so a test never touches a real home directory. A read that
 * throws returns `available: false`, never a zero size: "I could not check" is its own
 * answer here, and the anomaly text says so.
 */
export function readMemoryIndex(cwd = process.cwd(), deps = {}) {
  const stat = deps.stat || statSync;
  const home = deps.home || process.env.HOME || '';
  // Claude derives the project slug from the absolute path with every separator replaced
  // by a dash — mirrored here rather than restated as a constant, so a moved checkout
  // resolves on its own instead of silently pointing at a stale directory.
  // The PATH DERIVATION is inside the guard too, not just the stat. `resolve(cwd)`
  // throws a TypeError on a non-string, which would crash the whole session brief
  // instead of degrading — and "degrade, never die" is the rule this script is built on.
  let path = null;
  try {
    const slug = resolve(cwd).replace(/\//g, '-');
    path = join(home, '.claude', 'projects', slug, 'memory', 'MEMORY.md');
    return { available: true, bytes: stat(path).size, path };
  } catch {
    return { available: false, bytes: null, path };
  }
}

export function buildAnomalies({ repoStates, migrationResults, expandOrphans = false, memoryIndex }) {
  const anomalies = [];
  // First, because it is the one anomaly that changes what the rest of this report is
  // worth: if the index is truncating, the session is missing facts it does not know it
  // is missing. Absent `memoryIndex` means the caller did not look — not that it is fine.
  if (memoryIndex) {
    const mem = decideMemoryBudgetAnomaly(memoryIndex);
    if (mem) anomalies.push(mem);
  }
  for (const rs of repoStates || []) {
    if (rs.git?.available) {
      const openPrs = rs.gh?.available ? rs.gh.open : undefined; // undefined → decideStrayBranch treats as "unknown"
      const stray = decideStrayBranch({ branch: rs.git.branch, detached: rs.git.detached, openPrs });
      if (stray) anomalies.push({ repo: rs.repo, ...stray });
      const dirty = decideDirtyTree({ label: rs.dir, dirtyFiles: rs.git.dirtyFiles });
      if (dirty) anomalies.push({ repo: rs.repo, ...dirty });
      for (const wt of decideWorktreeAnomalies(rs.git.worktrees)) anomalies.push({ repo: rs.repo, ...wt });
    }
    if (rs.gh?.available) {
      for (const a of decidePrAnomalies(rs.gh.open)) anomalies.push({ repo: rs.repo, ...a });
      for (const a of decideStalePrAnomalies(rs.gh.open, { nowISO: new Date().toISOString() })) {
        anomalies.push({ repo: rs.repo, ...a });
      }
    }
  }
  for (const m of migrationResults || []) {
    if (m.available) {
      for (const a of decideMigrationAnomalies({ ...m, expandOrphans })) anomalies.push(a);
    }
  }
  return assertRenderableAnomalies(anomalies);
}

// D4: names every degraded source instead of silently dropping it. A missing repo path, an
// unauthenticated/unreachable gh, an unavailable migration check, and an empty/unfetchable journal all
// land here — distinct from `buildAnomalies`, which only reports CONFIRMED surprising states.
export function buildGaps({ repoStates, migrationResults, journalAvailable, journalReason }) {
  const gaps = [];
  for (const rs of repoStates || []) {
    if (!rs.git?.available)
      gaps.push(`${rs.repo}: git state unavailable — ${rs.git?.reason || 'unknown reason'}.`);
    // A failed dirty-probe is UNKNOWN, not clean. Without this the report renders no dirty-tree
    // anomaly and no gap — indistinguishable from a clean tree.
    else if (rs.git.dirtyProbeFailed) {
      gaps.push(`${rs.repo}: could not read working-tree status — dirty/clean is UNKNOWN, not clean.`);
    }
    if (!rs.gh?.available) {
      gaps.push(
        `${rs.repo}: PR/CI state unavailable — ${rs.gh?.reason || 'gh unavailable'}. Stray-branch/CI/conflict checks skipped.`
      );
    }
  }
  for (const m of migrationResults || []) {
    if (!m.available)
      gaps.push(`${m.repo}: migration drift check unavailable — ${m.reason || 'unknown reason'}.`);
  }
  if (!journalAvailable) {
    gaps.push(
      `journal unavailable — ${journalReason || 'claude/session-journal has no entries yet, or could not be fetched'}.`
    );
  }
  return gaps;
}

// Assembles the full report object — the SAME shape feeds both --json and the human renderer below, so
// neither can drift from the other.
export function buildReport({
  repoStates,
  migrationResults,
  journalEntries,
  journalAvailable,
  journalReason,
  journalLimit = JOURNAL_LIMIT_DEFAULT,
  expandOrphans = false,
  memoryIndex,
  generatedAt,
}) {
  return {
    generatedAt: generatedAt || new Date().toISOString(),
    anomalies: buildAnomalies({ repoStates, migrationResults, expandOrphans, memoryIndex }),
    gaps: buildGaps({ repoStates, migrationResults, journalAvailable, journalReason }),
    journal: {
      available: journalAvailable,
      reason: journalAvailable ? null : journalReason || null,
      totalEntries: (journalEntries || []).length,
      recent: lastNEntries(journalEntries || [], journalLimit),
    },
    repos: repoStates,
    migrations: migrationResults,
  };
}

// D3's exact order: (1) anomalies, (2) last N journal lines, (3) full derived state. Gaps ride right
// after anomalies — both are "read this before you trust anything below" content.
export function renderHumanReport(report) {
  const lines = [];
  lines.push(`Session resume — ${report.generatedAt}`);
  lines.push('');
  lines.push(
    report.anomalies.length ? `⚠ ANOMALIES (${report.anomalies.length})` : '✓ No anomalies detected.'
  );
  for (const a of report.anomalies) {
    lines.push(`  - [${a.type}]${a.repo ? ` ${a.repo}:` : ''} ${a.detail}`);
  }

  if (report.gaps.length) {
    lines.push('');
    lines.push(`Degraded sources (${report.gaps.length}) — named, not silently dropped (D4):`);
    for (const g of report.gaps) lines.push(`  - ${g}`);
  }

  lines.push('');
  lines.push(
    `Journal — last ${report.journal.recent.length} of ${report.journal.totalEntries}${
      report.journal.available ? '' : ' (unavailable)'
    }:`
  );
  if (!report.journal.recent.length) {
    lines.push(
      `  (none${report.journal.available ? ' yet' : `: ${report.journal.reason || 'unavailable'}`})`
    );
  } else {
    for (const e of report.journal.recent) lines.push(`  ${formatEntry(e)}`);
  }

  lines.push('');
  lines.push('Full derived state:');
  for (const rs of report.repos) {
    lines.push(`- ${rs.repo} (${rs.dir}):`);
    if (rs.git?.available) {
      lines.push(
        `    branch: ${rs.git.branch}${rs.git.detached ? ' (detached)' : ''}; ` +
          `ahead ${rs.git.ahead ?? '?'} / behind ${rs.git.behind ?? '?'} vs origin/main; ` +
          `dirty files: ${rs.git.dirtyFiles ?? '?'}`
      );
      for (const w of rs.git.worktrees || []) {
        lines.push(`    worktree: ${w.path} (${w.branch || 'detached'})${w.dirty ? ' [dirty]' : ''}`);
      }
    } else {
      lines.push(`    git: unavailable (${rs.git?.reason || 'unknown'})`);
    }
    if (rs.gh?.available) {
      lines.push(
        `    open PRs: ${(rs.gh.open || []).length}; recently merged: ${(rs.gh.recentMerged || []).length}`
      );
      for (const pr of rs.gh.open || []) {
        lines.push(
          `      #${pr.number} ${pr.title} [${pr.headRefName}] age=${prAgeLabel(pr)} mergeable=${pr.mergeable} ` +
            `ciFailing=${pr.ciFailing} ciPending=${pr.ciPending}`
        );
      }
    } else {
      lines.push(`    gh: unavailable (${rs.gh?.reason || 'unknown'})`);
    }
  }

  if (report.migrations?.length) {
    lines.push('');
    lines.push('Migration drift (D5, read-only):');
    for (const m of report.migrations) {
      if (m.available) {
        lines.push(
          `  - ${m.repo}: ${m.unappliedLocal.length} unapplied local file(s); ${m.appliedNoFile.length} applied-with-no-file.`
        );
      } else {
        lines.push(`  - ${m.repo}: unavailable (${m.reason})`);
      }
    }
  }

  return lines.join('\n');
}

// ============================================================================================
// I/O gather layer — every function degrades to `{ available: false, reason }` on failure (D4);
// none of these throw. `deps` is injectable throughout so scripts/session-resume.test.mjs can drive every
// degradation path with no real git/gh/network/DB.
// ============================================================================================

function git(args, cwd, spawn) {
  return spawn('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function gatherRepoGit({ dir, root, existsSyncFn, spawn }) {
  const path = join(root, dir);
  if (!existsSyncFn(path)) return { available: false, reason: `path not found: ${path}` };
  if (!existsSyncFn(join(path, '.git'))) return { available: false, reason: `not a git repo: ${path}` };

  const branchRes = git(['rev-parse', '--abbrev-ref', 'HEAD'], path, spawn);
  if (branchRes.error || branchRes.status !== 0) {
    return { available: false, reason: `git rev-parse failed: ${lastLine(branchRes.stderr)}` };
  }
  const branch = branchRes.stdout.trim();
  const detached = branch === 'HEAD';

  const statusRes = git(['status', '--porcelain'], path, spawn);
  // `null` here means the probe FAILED, which is not the same fact as "the tree is clean" — and
  // decideDirtyTree treats any falsy value as "no anomaly". Cross-review caught that a failed
  // `git status` therefore rendered as silence. The flag below turns it into a named gap, which is
  // D4's whole point and the "unknown is not none" rule this repo already learned once.
  const dirtyProbeFailed = statusRes.status !== 0;
  const dirtyFiles = dirtyProbeFailed ? null : statusRes.stdout.split('\n').filter(Boolean).length;

  // Best-effort, local-refs-only (no fetch — a read-only resume must not have a network side effect on
  // every invocation); a stale origin/main tracking ref just means a stale ahead/behind count, reported
  // as `?` below rather than guessed at.
  let ahead = null;
  let behind = null;
  const abRes = git(['rev-list', '--left-right', '--count', 'origin/main...HEAD'], path, spawn);
  if (abRes.status === 0) {
    const parts = abRes.stdout.trim().split(/\s+/).map(Number);
    if (parts.length === 2 && parts.every(Number.isFinite)) [behind, ahead] = parts;
  }

  const wtRes = git(['worktree', 'list', '--porcelain'], path, spawn);
  let worktrees = [];
  if (wtRes.status === 0) {
    worktrees = parseWorktreeListPorcelain(wtRes.stdout)
      .filter((w) => w.path && resolve(w.path) !== resolve(path))
      .map((w) => {
        const stRes = existsSyncFn(w.path) ? git(['status', '--porcelain'], w.path, spawn) : null;
        const dirty = stRes && stRes.status === 0 ? stRes.stdout.trim().length > 0 : null;
        return { path: w.path, branch: w.branch, detached: w.detached, dirty };
      });
  }

  return { available: true, path, branch, detached, ahead, behind, dirtyFiles, dirtyProbeFailed, worktrees };
}

function gatherRepoGh({ repo, listPullsFn, mergeFn, rollupFn }) {
  const all = listPullsFn({ repo, state: 'all', perPage: 50 });
  if (all === null)
    return { available: false, reason: 'gh unavailable, unauthenticated, or the repo could not be reached' };

  const open = all.filter((p) => p.state === 'OPEN');
  const recentMerged = all.filter((p) => p.state === 'MERGED').slice(0, RECENT_MERGED_LIMIT);

  const openDetailed = open.map((p) => {
    const mergeable = mergeFn({ repo, number: p.number });
    const rollup = p.headSha ? rollupFn({ repo, sha: p.headSha }) : null;
    return {
      number: p.number,
      title: p.title,
      url: p.url,
      headRefName: p.headRefName,
      createdAt: p.createdAt,
      isDraft: p.isDraft,
      mergeable,
      ciAvailable: rollup !== null,
      ciFailing: rollupHasFailure(rollup),
      ciPending: rollupHasPending(rollup),
    };
  });

  return { available: true, open: openDetailed, recentMerged };
}

function gatherMigrationDrift({ repos, root, existsSyncFn, readdirSyncFn, spawn }) {
  const results = [];
  for (const r of repos) {
    if (r.dir == null) continue; // no local checkout — nothing to compare
    const migDir = join(root, r.dir, 'supabase', 'migrations');
    if (!existsSyncFn(migDir)) continue; // no migration files owned here — not this repo's concern
    let files;
    try {
      files = readdirSyncFn(migDir).filter((f) => f.endsWith('.sql'));
    } catch {
      files = [];
    }
    if (!files.length) continue;

    const cwd = join(root, r.dir);
    const res = spawn('supabase', ['migration', 'list', '--linked'], {
      cwd,
      encoding: 'utf8',
      timeout: MIGRATION_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (res.error || res.status !== 0) {
      results.push({
        repo: r.repo,
        available: false,
        reason: res.error ? res.error.message : `supabase migration list failed: ${lastLine(res.stderr)}`,
      });
      continue;
    }
    results.push({
      repo: r.repo,
      available: true,
      fileCount: files.length,
      ...parseMigrationListTable(res.stdout),
    });
  }
  return results;
}

function gatherJournal({ root, readLogFromBranchFn }) {
  const content = readLogFromBranchFn({ cwd: root, branch: JOURNAL_BRANCH, path: JOURNAL_PATH });
  if (!content) {
    return {
      available: false,
      reason: 'claude/session-journal has no entries yet, or could not be fetched (network/auth)',
      entries: [],
    };
  }
  return { available: true, reason: null, entries: parseJournal(content) };
}

// ============================================================================================
// CLI wiring
// ============================================================================================

export function parseArgs(argv) {
  const out = {
    json: false,
    root: DEFAULT_ROOT,
    journalLimit: JOURNAL_LIMIT_DEFAULT,
    expandOrphans: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--root') out.root = resolve(argv[++i]);
    else if (a === '--journal-limit') out.journalLimit = Number(argv[++i]);
    else if (a === '--all-migrations') out.expandOrphans = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument '${a}'`);
  }
  return out;
}

function help() {
  return [
    'Usage: node scripts/session-resume.mjs [--json] [--root <path>] [--journal-limit N] [--all-migrations]',
    '',
    'Derives live state across the project repos (git/gh/migrations) and the session journal; leads with',
    'anomalies (D3). Degrades, never dies (D4): an unauthenticated gh, a missing repo, an empty',
    'journal, or an unavailable DB read each produce a partial brief naming the gap, never a crash.',
  ].join('\n');
}

// `deps` fully injectable (mirrors cross-agent-cli.mjs's runWithCodexFallback pattern) — every gather
// function above already degrades internally, so main() itself needs no extra try/catch to satisfy D4;
// the outer try/catch below is a last-resort net for a truly unexpected throw (e.g. a permissions error
// on a repo path), which still must produce a partial brief, never an uncaught stack trace.
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    log = console.log,
    warn = console.error,
    existsSyncFn = existsSync,
    readdirSyncFn = readdirSync,
    spawn = spawnSync,
    listPullsFn = listPulls,
    mergeFn = getPullMergeability,
    rollupFn = getStatusRollup,
    readLogFromBranchFn = readLogFromBranch,
    // Injected for the same reason as every other dependency in this list: a `main()`
    // test must not stat a real home directory. Named `statFn`/`homeDir` rather than
    // passed through as an opaque bag so the seam is visible in this one list.
    statFn = statSync,
    homeDir = process.env.HOME,
    now,
    resolveReposFn = resolveRepos,
    gatherFactsFn = gatherFacts,
  } = deps;

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

  try {
    const { repos, note: reposNote } = resolveReposFn({ root: args.root, spawn });
    if (reposNote) warn(`⚠ session-resume: ${reposNote}`);
    // board-sinks-and-scrumban S3.1 — refresh the board snapshot (.golden-frijoles/board.json) once per session start.
    // The build view's hook never goes online, so this is what keeps the age it prints short. Best-effort: a failed
    // gather keeps the old snapshot, and the build view says how old that one is.
    try {
      const facts = gatherFactsFn({ root: args.root, mode: 'live', run: spawn });
      if (facts.note) warn(`⚠ session-resume: board snapshot not refreshed — ${facts.note}`);
    } catch {
      // never block a resume on the board
    }
    const repoStates = repos.map((r) => ({
      repo: r.repo,
      dir: r.dir,
      git:
        r.dir == null
          ? { available: false, reason: 'no local checkout configured (reporting.config.json → checkouts)' }
          : gatherRepoGit({ dir: r.dir, root: args.root, existsSyncFn, spawn }),
      gh: gatherRepoGh({ repo: r.repo, listPullsFn, mergeFn, rollupFn }),
    }));

    const migrationResults = gatherMigrationDrift({
      repos,
      root: args.root,
      existsSyncFn,
      readdirSyncFn,
      spawn,
    });
    const journal = gatherJournal({ root: args.root, readLogFromBranchFn });

    const report = buildReport({
      repoStates,
      migrationResults,
      journalEntries: journal.entries,
      journalAvailable: journal.available,
      journalReason: journal.reason,
      journalLimit: args.journalLimit,
      expandOrphans: args.expandOrphans,
      memoryIndex: readMemoryIndex(args.root, { stat: statFn, home: homeDir }),
      generatedAt: (now || new Date()).toISOString(),
    });

    log(args.json ? JSON.stringify(report, null, 2) : renderHumanReport(report));
    return 0;
  } catch (e) {
    // Last-resort net (D4: degrade, never die) — should be unreachable given every gather function above
    // already catches its own failure mode, but a resume tool must never stack-trace on a bad day.
    warn(
      `⚠ session-resume: unexpected error, showing a partial/empty brief instead of crashing: ${e.message}`
    );
    // Honour --json even here. Cross-review caught that this path emitted the HUMAN report
    // unconditionally, so a machine consumer asking for JSON received prose on stdout with exit 0 —
    // it would parse-fail or, worse, be treated as an empty result.
    const fallback = buildReport({
      repoStates: [],
      migrationResults: [],
      journalEntries: [],
      journalAvailable: false,
      journalReason: `session-resume crashed before the journal could be read: ${e.message}`,
      // Reported on the CRASH path too. A truncating memory index is exactly the fact
      // you still want on the worst day — it is cheap (one stat), it is independent of
      // everything that just failed, and an empty brief that also silently drops it
      // leaves the session blind twice over. Its own failure is already swallowed by
      // readMemoryIndex, so this cannot re-enter the catch.
      memoryIndex: readMemoryIndex(args?.root, { stat: statFn, home: homeDir }),
    });
    log(args?.json ? JSON.stringify(fallback, null, 2) : renderHumanReport(fallback));
    return 0;
  }
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
