#!/usr/bin/env node
// standup.mjs — gathers overnight signals across the project's repos and posts a DELTA-ONLY Telegram standup.
//
// Project values (repos, smoke workflow, stale-preview age, live-flag source, chat, doc viewer) come
// from reporting.config.json via scripts/lib/reporting-config.mjs. An absent optional section turns
// that signal OFF rather than borrowing a default. Ported into the dobby-foundation template by
// plugin-audit-and-extraction S1; the gathering and delta logic are unchanged from the origin.
//
// Signals: opened/merged PRs + CI status + merge-conflict state (gh, every configured repo), the latest
// run of the configured browser-smoke workflow (`smoke`), BUILD-ORDER.md drift
// (`node scripts/build-order.mjs --check`), open-PR state, and the stale-preview count
// (`node scripts/vercel-prune-previews.mjs --project <vercelProject> --age <stalePreviewAgeDays>`, dry-run — never `--apply`). The CI-red and
// conflict signals are this standup's OWN independent read — taken after babysit-pr has had a chance
// to act (it runs earlier in the same ops-nightly routine), so a "still red" line reflects state
// post-retry, not pre-retry.
//
// Delta-only: keeps scripts/standups.log (JSONL, one snapshot per run) and diffs the current gather
// against the LAST logged snapshot. Nothing changed → posts a one-line "quiet night" message instead of
// re-dumping everything. After a successful Telegram post, commits + pushes the updated log directly to
// `main` (path-scoped) so the next run — including a fresh nightly-routine session — has yesterday's
// state to diff against.
//
// Usage:
//   node scripts/standup.mjs             # gather, diff, post to Telegram, commit+push the log
//   node scripts/standup.mjs --dry-run   # gather + print the message only — fully read-only (does NOT
//                                         # append to standups.log, does not touch Telegram or git, and
//                                         # does NOT write to the report registry — S1.3,
//                                         # scripts/lib/report-registry.mjs's upgradeArtifactLinks is
//                                         # called with dryRun: true, which logs the would-be /r/<slug>
//                                         # link but performs no upload; the printed message still shows
//                                         # the existing URL-hash fallback link in that case).
//
// Reuse, don't rebuild: ensureGh()/die() (scripts/lib/cross-agent-cli.mjs), build-order.mjs --check,
// vercel-prune-previews.mjs dry-run, and the api.telegram.org sendMessage shape (reimplemented standalone —
// this script has no access to the app's node_modules/TS build). Zero npm deps — Node >=20 (global fetch, spawnSync).

import { spawnSync } from 'node:child_process';
import { readFileSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { ensureGh, die } from './lib/cross-agent-cli.mjs';
import { loadReportingConfig, chatIdFor, shortRepo, ReportingConfigError } from './lib/reporting-config.mjs';
import { listPulls, getPullMergeability, getStatusRollup } from './lib/gh-rest.mjs';
import { formatPrList, telegramHtmlToConsoleText } from './lib/telegram-format.mjs';
import { readLogFromBranch, appendLineToBranch } from './lib/log-branch.mjs';
import { appendStandupArtifactsToMessage, buildStandupArtifacts } from './lib/standup-deck.mjs';
import { upgradeArtifactLinks } from './lib/report-registry.mjs';
import { findingsToRevisionNote, judgeProse } from './lib/prose-guard.mjs';
import {
  buildEvidencePack,
  buildQuietBrief,
  buildBrief,
  deriveEvidenceFlags,
  loadOwedLedger,
} from './lib/prose-brief.mjs';
import { parseStatusFlipsFromLog } from './weekly-recap.mjs';
import { projectRoot } from './lib/project-root.mjs';
import { isMain } from './lib/is-main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = projectRoot(); // D2

// The delta log lives on a dedicated `claude/`-prefixed branch, not committed to `main` — a routine's
// DEFAULT push scope already covers `claude/`-prefixed branches, so this needs no extra permission (see
// scripts/lib/log-branch.mjs for why: the "Allow unrestricted branch pushes" toggle failed to save live,
// 2026-07-02/03).
const LOG_BRANCH = 'claude/standup-log';
// Flat filename (no directory) — git mktree builds a single-level tree, and this branch holds nothing
// else, so there's no reason to nest it under scripts/.
const LOG_BRANCH_PATH = 'standups.log';

const DRY_RUN = process.argv.includes('--dry-run');

// ── Two-phase prose modes (exec-prose-rail S2; README D2) ────────────────────────────────────
// `--brief` prints the persona + lessons + evidence pack and EXITS — writes nothing, sends nothing,
// touches no git. `--post --prose-file <p>` guards a routine-written draft and posts it.
const BRIEF = process.argv.includes('--brief');
const POST = process.argv.includes('--post');
const FORCE_POST = process.argv.includes('--force-post');
function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}
const PROSE_FILE = argAfter('--prose-file');
const QUIET = process.argv.includes('--quiet');

// The standup is a chat message read on a phone. This is the length budget the guard enforces.
const STANDUP_MAX_WORDS = 90;

// Written by epic B story 3 when it lands. Absent is normal and must degrade cleanly — neither epic
// may hard-depend on the other's merge order.
const OWED_LEDGER_PATH = join(ROOT, 'Roadmap/00-ideas/OWED-LEDGER.json');

const MAX_PRS_SHOWN_PER_REPO = 12; // caps a busy-night delta listing before it dominates the message
const TELEGRAM_MAX_CHARS = 4096; // Telegram sendMessage's hard text limit — a safety net, not the primary control

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---- gather: gh-backed signals (each degrades to `available: false` on any gh error — one repo being
// unreachable/unauthed never kills the whole run) ----

function ghJson(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout || 'null');
  } catch {
    return null;
  }
}

// REST-only (scripts/lib/gh-rest.mjs) — `gh pr list --json` hits GraphQL internally, which is blocked in
// at least one live routine sandbox (confirmed 2026-07-02). The list endpoint alone doesn't carry
// mergeable/check-status, so those are one extra pair of REST calls per OPEN PR only (bounded — typically
// a handful, never the full 50-item history list).
function gatherRepoPrs(repo) {
  const prs = listPulls({ repo, state: 'all', perPage: 50 });
  if (prs === null) return { repo, available: false };

  const open = prs.filter((p) => p.state === 'OPEN');
  const merged = prs.filter((p) => p.state === 'MERGED');

  const failingOpenNumbers = [];
  const conflictingOpenNumbers = [];
  for (const p of open) {
    const mergeable = getPullMergeability({ repo, number: p.number });
    if (mergeable === 'CONFLICTING') conflictingOpenNumbers.push(p.number);
    if (p.headSha) {
      const rollup = getStatusRollup({ repo, sha: p.headSha }) || [];
      const failing = rollup.some(
        (c) => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR' || c.state === 'FAILURE'
      );
      if (failing) failingOpenNumbers.push(p.number);
    }
  }

  return {
    repo,
    available: true,
    openNumbers: open.map((p) => p.number),
    mergedNumbers: merged.map((p) => p.number),
    failingOpenNumbers,
    // Surfaced by babysit-pr's own advisory comment too — this is the standup's independent read of the
    // same fact, taken AFTER babysit-pr has had a chance to act (it runs earlier in the ops-nightly routine).
    conflictingOpenNumbers,
    // small lookup for rendering human-readable delta lines
    byNumber: Object.fromEntries(prs.map((p) => [p.number, { title: p.title, url: p.url }])),
  };
}

function gatherSmoke(smokeConfig) {
  if (!smokeConfig) return { available: false };
  const runs = ghJson([
    'run',
    'list',
    '--repo',
    smokeConfig.repo,
    '--workflow',
    smokeConfig.workflow,
    '-L',
    '1',
    '--json',
    'conclusion,status,createdAt,url',
  ]);
  if (runs === null || !runs.length) return { available: false };
  const r = runs[0];
  return { available: true, conclusion: r.conclusion, status: r.status, createdAt: r.createdAt, url: r.url };
}

// ---- gather: local scripts ----

function gatherBuildOrderDrift() {
  const r = spawnSync(process.execPath, [join(__dirname, 'build-order.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
  return { drifted: r.status !== 0 };
}

function gatherStalePreviews(ageDays, project) {
  if (!ageDays || !project) return { available: false };
  const r = spawnSync(
    process.execPath,
    [join(__dirname, 'vercel-prune-previews.mjs'), '--project', project, '--age', String(ageDays)],
    {
      cwd: ROOT,
      encoding: 'utf8',
    }
  );
  if (r.status !== 0 && !r.stdout) return { available: false };
  const m = (r.stdout || '').match(/Preview deployments to remove[^:]*:\s*(\d+)/);
  return { available: m != null, count: m ? Number(m[1]) : null };
}

// ---- gather: roadmap deltas (D4 — the product-language input that LEADS the evidence pack) ----

// Epic README `status:` frontmatter flips + sprint `**Status:**` line changes in the window. Reuses
// weekly-recap.mjs's `parseStatusFlipsFromLog` rather than writing a second parser for the same
// format (the epic-status SSOT is that frontmatter key — see scripts/build-order.mjs).
export function gatherRoadmapDeltas(sinceExpr = '1 day ago', deps = {}) {
  const {
    run = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }),
  } = deps;

  const epicLog = run([
    'log',
    `--since=${sinceExpr}`,
    '--date=iso-strict',
    '-p',
    '--',
    'Roadmap/*/*/README.md',
  ]);
  const flips = epicLog.status === 0 ? parseStatusFlipsFromLog(epicLog.stdout || '') : [];

  const deltas = flips.map((f) => {
    const slug = f.file.split('/').slice(-2)[0];
    return `Epic "${slug}" moved to ${f.status}.`;
  });

  // Sprint docs that changed at all in the window — named in product terms, not as file paths.
  const sprintLog = run([
    'log',
    `--since=${sinceExpr}`,
    '--name-only',
    '--format=',
    '--',
    'Roadmap/*/*/sprint-*.md',
  ]);
  if (sprintLog.status === 0) {
    const touched = [
      ...new Set(
        (sprintLog.stdout || '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      ),
    ];
    for (const f of touched.slice(0, 8)) {
      const parts = f.split('/');
      const slug = parts[parts.length - 2];
      const sprint = (parts[parts.length - 1] || '').replace(/\.md$/, '');
      deltas.push(`Sprint doc updated: ${slug} / ${sprint}.`);
    }
  }
  return deltas;
}

// Flags currently ON — real input for the guard's `flag-state-claim` rule (README D6).
//
// Source is the project's own flag store, read by the argv in reporting.config.json → liveFlags.command
// (run from liveFlags.cwd). It must print one flag key per line; a `key` header line is ignored, so a
// CSV query result works as-is. No command configured → unavailable, never "none are on".
//
// Returns `{ available, flags }`, and the distinction is load-bearing: "no flags are on" and "I could
// not check" are different facts, and collapsing them to an empty array would let the brief tell the
// writer nothing is live when the truth is unknown. Unavailable is the expected case in a routine
// sandbox with no database credentials, so it must read as unknown, not as a negative finding.
export function gatherLiveFlags(liveFlagsConfig, deps = {}) {
  const {
    run = () =>
      spawnSync(liveFlagsConfig.command[0], liveFlagsConfig.command.slice(1), {
        cwd: join(ROOT, liveFlagsConfig.cwd || '.'),
        encoding: 'utf8',
        timeout: 60000,
      }),
  } = deps;
  if (!liveFlagsConfig && !deps.run) return { available: false, flags: [] };
  try {
    const r = run();
    if (!r || r.status !== 0) return { available: false, flags: [] };
    const rows = (r.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => l.toLowerCase() !== 'key');
    return { available: true, flags: rows };
  } catch {
    return { available: false, flags: [] };
  }
}

// Commit subjects + touched areas for the window — the inputs `deriveEvidenceFlags` needs to decide
// whether a fix claim or a customer mention is legitimate. Degrades to empty (the closed, safe
// default) rather than failing the post.
export function gatherWindowFacts(sinceExpr = '1 day ago', deps = {}) {
  const {
    run = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }),
  } = deps;
  const log = run(['log', '--no-merges', `--since=${sinceExpr}`, '--format=%s']);
  const subjects =
    log.status === 0
      ? (log.stdout || '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
  const names = run(['log', '--no-merges', `--since=${sinceExpr}`, '--name-only', '--format=']);
  const paths =
    names.status === 0
      ? (names.stdout || '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
  const areas = [
    ...new Set(
      paths.map((p) => {
        if (p.startsWith('Roadmap/')) return 'roadmap docs';
        if (p.startsWith('scripts/')) return 'internal tooling';
        if (p.includes('/app/')) return 'customer-facing pages';
        if (p.includes('/e2e/')) return 'test suite';
        return p.split('/')[0] || 'other';
      })
    ),
  ];
  return { subjects, areas };
}

// ---- delta log (JSONL, one line per run — lives on a dedicated branch, see below) ----

function loadLastRun() {
  const content = readLogFromBranch({ cwd: ROOT, branch: LOG_BRANCH, path: LOG_BRANCH_PATH });
  if (!content) return null;
  const lines = content.trim().split('\n').filter(Boolean);
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function buildSnapshot({ repoSignals, smoke, buildOrder, previews }) {
  return {
    ts: new Date().toISOString(),
    repos: Object.fromEntries(
      repoSignals.map((r) => [
        r.repo,
        r.available
          ? {
              openNumbers: r.openNumbers,
              mergedNumbers: r.mergedNumbers,
              failingOpenNumbers: r.failingOpenNumbers,
              conflictingOpenNumbers: r.conflictingOpenNumbers,
            }
          : null,
      ])
    ),
    smoke: smoke.available
      ? { conclusion: smoke.conclusion, status: smoke.status, createdAt: smoke.createdAt }
      : null,
    buildOrderDrifted: buildOrder.drifted,
    stalePreviews: previews.available ? previews.count : null,
  };
}

// Pure — the unit that matters for "run twice, second run says no change". No I/O.
//
// A missing/wiped `prevRepo` baseline is NOT the same as "everything happened last night" — enumerating
// gh's entire recent-PR window as "new" overflows Telegram's 4096-char limit and crashes before ever
// posting or persisting a log (confirmed live, 2026-07-02/03: standups.log had never been committed, so
// every run re-derived a from-scratch "merged: <100+ PR titles>" dump and died). On a missing baseline,
// emit ONE bounded summary line per repo (counts only, no per-PR title enumeration) instead.
export function diffSnapshots(prev, cur, repoSignals, { stalePreviewAgeDays = null } = {}) {
  const lines = [];
  const byNumberByRepo = Object.fromEntries(repoSignals.map((r) => [r.repo, r.byNumber || {}]));

  for (const [repo, curRepo] of Object.entries(cur.repos)) {
    if (!curRepo) continue; // this repo was unavailable this run
    const label = esc(shortRepo(repo));
    const prevRepo = prev?.repos?.[repo] || null;
    const byNumber = byNumberByRepo[repo] || {};

    if (!prevRepo) {
      lines.push(
        `📋 <b>${label}</b> baseline established (${curRepo.openNumbers.length} open, ` +
          `${curRepo.mergedNumbers.length} recently merged) — deltas start next run.`
      );
      continue;
    }

    const prevMerged = new Set(prevRepo.mergedNumbers || []);
    const newMerged = curRepo.mergedNumbers.filter((n) => !prevMerged.has(n));
    if (newMerged.length) {
      const titled = newMerged.map((n) => ({ number: n, title: byNumber[n]?.title || '' }));
      lines.push(`✅ <b>${label}</b> merged: ${formatPrList(titled, MAX_PRS_SHOWN_PER_REPO)}`);
    }

    const prevOpenSet = new Set(prevRepo.openNumbers || []);
    const newOpened = curRepo.openNumbers.filter((n) => !prevOpenSet.has(n));
    if (newOpened.length) {
      const titled = newOpened.map((n) => ({ number: n, title: byNumber[n]?.title || '' }));
      lines.push(`🆕 <b>${label}</b> opened: ${formatPrList(titled, MAX_PRS_SHOWN_PER_REPO)}`);
    }

    const prevFailing = new Set(prevRepo.failingOpenNumbers || []);
    const newFailing = curRepo.failingOpenNumbers.filter((n) => !prevFailing.has(n));
    if (newFailing.length)
      lines.push(`🔴 <b>${label}</b> CI red on open PR: ${newFailing.map((n) => `#${n}`).join(', ')}`);

    const prevConflicting = new Set(prevRepo.conflictingOpenNumbers || []);
    const newConflicting = (curRepo.conflictingOpenNumbers || []).filter((n) => !prevConflicting.has(n));
    if (newConflicting.length)
      lines.push(
        `⚠️ <b>${label}</b> merge conflict on open PR: ${newConflicting.map((n) => `#${n}`).join(', ')}`
      );

    if (prevRepo.openNumbers?.length !== curRepo.openNumbers.length) {
      lines.push(`📋 <b>${label}</b> open PRs: ${curRepo.openNumbers.length}`);
    }
  }

  const prevSmokeKey = prev?.smoke ? `${prev.smoke.conclusion}|${prev.smoke.createdAt}` : null;
  const curSmokeKey = cur.smoke ? `${cur.smoke.conclusion}|${cur.smoke.createdAt}` : null;
  if (prevSmokeKey !== curSmokeKey) {
    lines.push(
      cur.smoke
        ? `🧪 Browser smoke: ${cur.smoke.conclusion || cur.smoke.status || 'unknown'}`
        : '🧪 Browser smoke: unavailable'
    );
  }

  if (!prev || prev.buildOrderDrifted !== cur.buildOrderDrifted) {
    lines.push(
      cur.buildOrderDrifted
        ? '⚠️ BUILD-ORDER.md is stale — run node scripts/build-order.mjs'
        : '✅ BUILD-ORDER.md up to date'
    );
  }

  // Only when the project turned the signal on (stalePreviewAgeDays) — an unconfigured signal is silent,
  // not a nightly "unavailable" line nobody can act on.
  if (stalePreviewAgeDays && (!prev || prev.stalePreviews !== cur.stalePreviews)) {
    lines.push(
      cur.stalePreviews == null
        ? '🧹 Stale previews: unavailable'
        : `🧹 Stale previews (>${stalePreviewAgeDays}d): ${cur.stalePreviews}`
    );
  }

  return lines;
}

// ---- Telegram ----

async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) die('TELEGRAM_BOT_TOKEN is not set — export it before running standup.mjs.');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10000),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) die(`Telegram sendMessage failed: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
}

// ---- log persistence (scripts/lib/log-branch.mjs — a dedicated claude/-prefixed branch) ----

function appendRunAndPush(snapshot) {
  const ok = appendLineToBranch({
    cwd: ROOT,
    branch: LOG_BRANCH,
    path: LOG_BRANCH_PATH,
    line: `${JSON.stringify(snapshot)}\n`,
    message: `chore(standup): log ${new Date().toISOString().slice(0, 10)}`,
  });
  if (!ok) {
    console.error(
      `standup: writing the updated log to ${LOG_BRANCH} failed — the next run (esp. a fresh routine ` +
        `session) won't see today's snapshot and will re-derive its baseline.`
    );
  }
}

// ---- main ----

async function main() {
  let config;
  try {
    config = loadReportingConfig({ root: ROOT });
  } catch (e) {
    if (e instanceof ReportingConfigError) die(e.message);
    throw e;
  }
  ensureGh();

  const repoSignals = config.repos.map(gatherRepoPrs);
  const smoke = gatherSmoke(config.smoke);
  const buildOrder = gatherBuildOrderDrift();
  const previews = gatherStalePreviews(config.stalePreviewAgeDays, config.vercelProject);

  const cur = buildSnapshot({ repoSignals, smoke, buildOrder, previews });
  const prev = loadLastRun();
  const deltaLines = diffSnapshots(prev, cur, repoSignals, {
    stalePreviewAgeDays: config.stalePreviewAgeDays,
  });

  const header = `<b>Standup · ${cur.ts.slice(0, 10)}</b>`;

  // ── Phase 1: --brief ───────────────────────────────────────────────────────────────────────
  // Prints persona + lessons + evidence and exits. Fully read-only: no log append, no git, no
  // Telegram, no registry write — the same guarantee --dry-run carries.
  if (BRIEF) {
    const roadmapDeltas = gatherRoadmapDeltas();
    const windowLabel = `since the last standup (${cur.ts.slice(0, 10)})`;
    // D7: an empty window must never produce a writable brief. Roadmap movement AND repo movement
    // both absent is the only case that counts as quiet.
    if (!roadmapDeltas.length && !deltaLines.length) {
      writeSync(1, `${buildQuietBrief(windowLabel)}\n`);
      return;
    }
    const pack = buildEvidencePack({
      windowLabel,
      roadmapDeltas,
      owed: loadOwedLedger(OWED_LEDGER_PATH),
      repoSignals: deltaLines.map((l) => telegramHtmlToConsoleText(l)),
      liveFlags: gatherLiveFlags(config.liveFlags),
      smoke: smoke.available ? smoke.conclusion || smoke.status : null,
    });
    writeSync(1, `${buildBrief({ scriptsDir: __dirname, surface: 'standup', pack })}\n`);
    return;
  }

  // ── Phase 3: --post --prose-file ───────────────────────────────────────────────────────────
  // Guards a routine-written draft with the SAME pure module the local rail uses, then posts.
  // `--post` REQUIRES an explicit mode. Cross-review caught that `--post` alone fell through to the
  // legacy unguarded send, so a typo could publish a report with no guard and no error at all.
  if (POST && !PROSE_FILE && !QUIET) {
    die(
      '--post needs either --prose-file <path> (a guarded prose post) or --quiet (the one-line\n' +
        '  quiet-window message). Refusing to fall through to an unguarded send.'
    );
  }

  let prose = null;
  if (POST && PROSE_FILE) {
    const draft = readFileSync(resolve(ROOT, PROSE_FILE), 'utf8').trim();
    // Evidence is DERIVED from the window, never hardcoded. Cross-review caught that these were
    // fixed empty arrays, which made `allowsFixClaim`/`allowsBeneficiary` permanently false — so a
    // genuine `fix:` in the window, or real customer-facing work, had its compliant prose rejected.
    const windowFacts = gatherWindowFacts();
    const evidence = deriveEvidenceFlags({
      subjects: windowFacts.subjects,
      areas: windowFacts.areas,
      liveFlags: gatherLiveFlags(config.liveFlags).flags,
      maxWords: STANDUP_MAX_WORDS,
    });
    // jev-semantic-guards S3.2: the semantic families are judged by Jev per jev.config.json → rails.prose.mode;
    // `checkProse` is the fallback and, with the rail off, the whole of it. The decider is on the result.
    const verdict = await judgeProse(draft, {
      ...evidence,
      extraBannedToolNames: config.prose.extraBannedToolNames,
    });
    const found = verdict.findings.map((f) => f.code).join(', ');
    process.stderr.write(`prose guard: decided by ${verdict.decider} (${verdict.mode}) — ${found || 'clean'}\n`);
    if (!verdict.ok && !FORCE_POST) {
      // Non-zero exit + the numbered revision note. The routine revises once and re-runs with
      // --force-post (D3: a labelled imperfect report beats a missing one).
      process.stderr.write(`${findingsToRevisionNote(verdict.findings)}\n`);
      process.exit(2);
    }
    prose = verdict.ok
      ? draft
      : `${draft}\n\n<i>⚠ flagged draft — ${verdict.findings.map((f) => f.code).join(', ')}</i>`;
  }

  // D8: prose leads, compact signals below. The guard forbids naming specifics, so a red CI cannot
  // survive the paragraph — the signal block is where the actionable pointers live, not decoration.
  const rawMessage = prose
    ? [
        header,
        '',
        esc(prose)
          .replace(/&lt;i&gt;/g, '<i>')
          .replace(/&lt;\/i&gt;/g, '</i>'),
        '',
        ...deltaLines,
      ].join('\n')
    : deltaLines.length
      ? [header, ...deltaLines].join('\n')
      : `${header}\n🌙 Quiet night — nothing new since the last standup.`;
  const artifacts = buildStandupArtifacts({
    docViewerUrl: config.artifacts.docViewerUrl,
    snapshot: cur,
    deltaLines,
    generatedAt: new Date(cur.ts),
  });
  // reporthub-as-notion S1.3: try to upgrade the standup deck's URL-hash link to a short gs://-backed
  // /r/<slug> link (scripts/lib/report-registry.mjs). `--dry-run` must stay fully read-only, so it's
  // passed straight through as `dryRun` — a dry run logs the would-be slug/link but performs no upload.
  // On any real-run upload failure the artifact keeps the URL-hash link it already had.
  await upgradeArtifactLinks(artifacts, {
    date: new Date(cur.ts),
    dryRun: DRY_RUN,
    baseUrl: config.artifacts.registry?.resolverBaseUrl,
    bucket: process.env.REPORT_REGISTRY_BUCKET || config.artifacts.registry?.bucket,
  });
  // Last-resort safety net for Telegram's hard 4096-char limit — the per-repo caps above (baseline
  // summary lines, formatPrList) should already keep any normal night well under this.
  const message = appendStandupArtifactsToMessage(rawMessage, artifacts, TELEGRAM_MAX_CHARS);

  console.log(telegramHtmlToConsoleText(message));

  if (!DRY_RUN) {
    const chatId = chatIdFor(config, 'standup');
    if (!chatId) {
      die(
        'No Telegram chat id configured — set "telegram.chatIds.standup" or "telegram.chatId" in ' +
          'reporting.config.json, or export TELEGRAM_CHAT_ID.'
      );
    }
    await sendTelegram(chatId, message);
  }

  if (!DRY_RUN) {
    appendRunAndPush(cur);
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
