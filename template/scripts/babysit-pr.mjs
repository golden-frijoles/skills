#!/usr/bin/env node
// babysit-pr.mjs — ADVISORY PR watch for a single open PR: retries flaky CI (re-runs failed workflow
// runs), surfaces merge conflicts, and posts ONE advisory comment summarizing what it did — never
// merges, never rebases, never touches commit-status/check-run APIs. A green/clean PR gets NO comment
// (silent no-op — same "green → no noise" discipline as smoke-triage/roadmap-hygiene).
//
// Usage:
//   node scripts/babysit-pr.mjs <PR#> --repo owner/repo [--dry-run]
//
// --dry-run is fully read-only: no `gh run rerun`, no `gh pr comment` — prints what it WOULD do.
//
// Reuse, don't rebuild: ensureGh()/die() (scripts/lib/cross-agent-cli.mjs). Zero new npm deps — Node 18+.

import { spawnSync } from 'node:child_process';
import { ensureGh, die } from './lib/cross-agent-cli.mjs';
import { getPull, getStatusRollup, postIssueComment } from './lib/gh-rest.mjs';
import { isMain } from './lib/is-main.mjs';

const BANNER =
  '🤖 **babysit-pr — advisory PR watch (Claude).** Never merges; never a required check — a plain ' +
  "comment structurally can't become one.";

function parseArgs(argv) {
  const out = { pr: null, repo: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--repo') out.repo = argv[++i];
    else if (a.startsWith('--repo=')) out.repo = a.slice('--repo='.length);
    else if (!a.startsWith('-') && out.pr === null) out.pr = a;
    else die(`unknown argument '${a}'`);
  }
  if (out.pr === null) die('usage: node scripts/babysit-pr.mjs <PR#> --repo owner/repo [--dry-run]');
  if (!out.repo)
    die('--repo owner/repo is required (babysit-pr watches PRs across 3 repos, none is a default).');
  return out;
}

// `gh run rerun` uses the REST Actions API regardless (confirmed live, unaffected by GraphQL being
// blocked) — kept as a direct `gh` shell-out, no need to route it through gh-rest.mjs.
function gh(args, opts = {}) {
  return spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts });
}

// Pure — the unit under test. No I/O. Classifies what babysit-pr should do for this PR's current state.
// checks: array of statusCheckRollup entries — either a GitHub Actions check run (`conclusion`) or a
// legacy/external commit status context (`state`, no `conclusion`); `standup.mjs` checks both shapes
// for the same reason, mirrored here. Returns { conflict, failingChecks, pendingChecks, allClean }.
export function decideBabysitActions({ mergeable, checks }) {
  const list = Array.isArray(checks) ? checks : [];
  const conflict = mergeable === 'CONFLICTING';
  const failingChecks = list.filter(
    (c) =>
      c.conclusion === 'FAILURE' ||
      c.conclusion === 'ERROR' ||
      c.conclusion === 'TIMED_OUT' ||
      c.state === 'FAILURE'
  );
  const pendingChecks = list.filter(
    (c) => !c.conclusion && (c.status === 'IN_PROGRESS' || c.status === 'QUEUED' || c.status === 'PENDING')
  );
  return {
    conflict,
    failingChecks,
    pendingChecks,
    allClean: !conflict && failingChecks.length === 0,
  };
}

// Pure — extracts the GitHub Actions run id from a check's detailsUrl
// (".../actions/runs/<id>/job/<jobId>"). Returns null for a check with no such URL (a legacy/external
// status context, e.g. non-Actions CI) — those aren't rerunnable via `gh run rerun` at all.
export function actionsRunIdFromDetailsUrl(url) {
  const m = /\/actions\/runs\/(\d+)/.exec(url || '');
  return m ? m[1] : null;
}

// REST-only (scripts/lib/gh-rest.mjs) — `gh pr view --json` hits GraphQL internally, which is blocked in
// at least one live routine sandbox (confirmed 2026-07-02). getPull() + getStatusRollup() reconstruct the
// same {state, mergeable, statusCheckRollup} shape from two REST calls instead.
function fetchPr(pr, repo) {
  const info = getPull({ repo, number: pr });
  if (!info) return null;
  const statusCheckRollup = info.headSha ? getStatusRollup({ repo, sha: info.headSha }) || [] : [];
  return { ...info, statusCheckRollup };
}

function rerun(repo, runId) {
  const r = gh(['run', 'rerun', String(runId), '--failed', '--repo', repo]);
  return {
    ok: r.status === 0,
    error: r.status === 0 ? null : (r.stderr || r.stdout || '').trim().split('\n')[0],
  };
}

// A failing-check run whose rerun attempt ITSELF errored (e.g. "already running", a permissions issue)
// is a DIFFERENT fact than "nothing needed a retry" — conflating them under one "no failing CI runs
// needed a retry" line is actively misleading (confirmed live, 2026-07-02/03: PR #23's rerun attempt
// errored, but the surfaced signal didn't distinguish that from "clean"). `retryFailures` is
// `[{runId, error}]` for exactly this case.
export function buildComment({
  conflict,
  retried,
  retryFailures,
  dryRun,
  noAutoRetryNames,
  stillPendingNames,
}) {
  const lines = [BANNER, ''];
  lines.push(
    conflict
      ? '⚠️ Merge conflict detected — needs a human rebase/resolve; not something this tool does.'
      : '✅ No merge conflict.'
  );
  if (retried.length) {
    const verb = dryRun ? 'Would retry' : 'Retried';
    lines.push(`🔁 ${verb} failing Actions run(s): ${retried.map((id) => `#${id}`).join(', ')}.`);
  } else if (!retryFailures.length) {
    lines.push('🔁 No failing CI runs needed a retry.');
  }
  if (retryFailures.length) {
    const detail = retryFailures
      .map(({ runId, error }) => `#${runId} (${error || 'unknown error'})`)
      .join(', ');
    lines.push(
      `❗ Retry attempt itself failed for: ${detail} — worth a manual look, this tool won't retry it again tonight.`
    );
  }
  if (noAutoRetryNames.length) {
    lines.push(`🛑 No automated retry available (not a GitHub Actions run): ${noAutoRetryNames.join(', ')}.`);
  }
  if (stillPendingNames.length) {
    lines.push(`⏳ Still pending: ${stillPendingNames.join(', ')}.`);
  }
  return lines.join('\n');
}

// REST-only (scripts/lib/gh-rest.mjs) — `gh pr comment` hits GraphQL internally, same reason as fetchPr.
function postComment(pr, repo, body) {
  const result = postIssueComment({ repo, number: pr, body });
  if (!result) die(`posting the advisory comment failed for #${pr} (${repo}).`);
  return result.url;
}

function main() {
  const { pr, repo, dryRun } = parseArgs(process.argv.slice(2));
  ensureGh();

  const info = fetchPr(pr, repo);
  if (!info) die(`gh pr view failed for #${pr} in ${repo}.`);
  if (info.state !== 'OPEN') {
    console.log(`PR #${pr} (${repo}) is ${info.state}, not OPEN — nothing to babysit.`);
    return;
  }

  const decision = decideBabysitActions({ mergeable: info.mergeable, checks: info.statusCheckRollup || [] });

  if (decision.allClean) {
    console.log(`PR #${pr} (${repo}) is clean (no conflict, no failing checks) — no comment posted.`);
    return;
  }

  // Target ONLY the Actions runs backing the checks that are actually failing right now (parsed from
  // each check's own detailsUrl) — never a branch-wide "list the last 20 runs and retry whatever's red"
  // sweep, which can retry a stale, unrelated failed run and report a misleading "retried" comment.
  const runIds = [
    ...new Set(decision.failingChecks.map((c) => actionsRunIdFromDetailsUrl(c.detailsUrl)).filter(Boolean)),
  ];
  const noAutoRetryNames = decision.failingChecks
    .filter((c) => !actionsRunIdFromDetailsUrl(c.detailsUrl))
    .map((c) => c.name)
    .filter(Boolean);

  const retried = [];
  const retryFailures = [];
  for (const runId of runIds) {
    if (dryRun) {
      console.log(`DRY-RUN — would rerun failed run #${runId} in ${repo}.`);
      retried.push(runId);
      continue;
    }
    const { ok, error } = rerun(repo, runId);
    if (ok) {
      retried.push(runId);
    } else {
      console.error(`babysit-pr: rerun failed for run #${runId} in ${repo} — continuing. (${error})`);
      retryFailures.push({ runId, error });
    }
  }

  const stillPendingNames = decision.pendingChecks.map((c) => c.name).filter(Boolean);
  const body = buildComment({
    conflict: decision.conflict,
    retried,
    retryFailures,
    dryRun,
    noAutoRetryNames,
    stillPendingNames,
  });

  if (dryRun) {
    console.log('DRY-RUN — would post this advisory comment:\n');
    console.log(body);
    return;
  }

  const url = postComment(pr, repo, body);
  console.log(`✓ Advisory comment posted on #${pr} (${repo})${url ? `: ${url}` : ''}`);
}

if (isMain(import.meta.url)) main();
