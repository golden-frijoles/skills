#!/usr/bin/env node
// weekly-recap.mjs — gathers the week's merged PRs (every repo in reporting.config.json) + shipped/closed
// epics (README frontmatter status: flips) + a short retro digest, and posts a formatted weekly Telegram recap.
//
// Project values (repo list, deploy repos, chat) come from reporting.config.json via
// scripts/lib/reporting-config.mjs — see that module for why there is no default. Ported into the
// dobby-foundation template by plugin-audit-and-extraction S1; the logic is unchanged from the origin.
//
// "Deploys" = merged-PR counts on the configured deploy repos, not a live hosting-platform API read.
// Per WAYS-OF-WORKING.md, "merging to main IS the production deploy" — so this is exactly the number a
// human would get by manually tallying merges for the week (the sprint's own acceptance bar), and it
// avoids a new external API dependency this script would need real credentials for.
//
// "Shipped/closed epics" = epic README frontmatter status: flips to `shipped` or `archived` this window,
// detected by scanning `git log -p` diff hunks for an added `+status: shipped`/`+status: archived` line
// (the epic-close flip; SSOT per scripts/build-order.mjs). For each one found, pulls a short excerpt from
// its sibling RETROSPECTIVE.md (if present) as the "retro digest".
//
// Window: unlike standup.mjs's delta-snapshot diffing, this keeps a WINDOW tracker
// (scripts/weekly-recaps.log, JSONL) — next run's `since` = last logged `windowEnd` (falls back to
// now-7d on first run / missing log), so back-to-back runs don't double-count regardless of exact
// cadence drift. After a successful Telegram post, commits + pushes the updated log to `main`
// (path-scoped) — same push-beyond-`claude/`-prefix requirement standup.mjs already documents.
//
// Usage:
//   node scripts/weekly-recap.mjs             # gather, post to Telegram, commit+push the log
//   node scripts/weekly-recap.mjs --dry-run   # gather + print the message only — fully read-only
//   node scripts/weekly-recap.mjs --since 2026-06-25T00:00:00Z   # override the window start
//   node scripts/weekly-recap.mjs --since 2026-06-01T00:00:00Z --until 2026-06-30T23:59:59Z   # a bounded backfill window
//
// Reuse, don't rebuild: ensureGh()/die() (scripts/lib/cross-agent-cli.mjs), the same Telegram
// sendMessage shape scripts/standup.mjs already reimplements standalone (no access to the app's
// node_modules/TS build here). Zero npm deps — Node >=20 (global fetch, spawnSync).

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { ensureGh, die } from './lib/cross-agent-cli.mjs';
import { loadReportingConfig, chatIdFor, shortRepo, ReportingConfigError } from './lib/reporting-config.mjs';
import { searchMergedPrs } from './lib/gh-rest.mjs';
import { formatPrList, truncateForTelegram } from './lib/telegram-format.mjs';
import { readLogFromBranch, appendLineToBranch } from './lib/log-branch.mjs';
import { findingsToRevisionNote, judgeProse } from './lib/prose-guard.mjs';
import {
  buildEvidencePack,
  buildQuietBrief,
  buildBrief,
  deriveEvidenceFlags,
  loadOwedLedger,
} from './lib/prose-brief.mjs';
import { projectRoot } from './lib/project-root.mjs';
import { isMain } from './lib/is-main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = projectRoot(); // D2

// The window-tracking log lives on a dedicated `claude/`-prefixed branch, not committed to `main` — a
// routine's DEFAULT push scope already covers `claude/`-prefixed branches, so this needs no extra
// permission (see scripts/lib/log-branch.mjs for why: the "Allow unrestricted branch pushes" toggle
// failed to save live, 2026-07-02/03).
const LOG_BRANCH = 'claude/weekly-recap-log';
const LOG_BRANCH_PATH = 'weekly-recaps.log'; // flat filename — git mktree needs a single-level tree

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

// ── Two-phase prose modes (exec-prose-rail S3) — mirrors standup.mjs exactly ─────────────────
// Same contract, higher altitude and a longer budget. Deliberately NOT a shared main(): the two
// scripts have genuinely different gather stages and window strategies (see the header note on why
// the window tracker here is not the standup's delta-snapshot diffing).
const BRIEF = argv.includes('--brief');
const POST = argv.includes('--post');
const FORCE_POST = argv.includes('--force-post');
const PROSE_FILE = argValue('--prose-file');
const QUIET = argv.includes('--quiet');

// A weekly is read at a desk, not on a lock screen — but the budget is still a budget, not a target.
const WEEKLY_MAX_WORDS = 160;
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
}
const SINCE_OVERRIDE = argValue('--since');
const UNTIL_OVERRIDE = argValue('--until');

const RETRO_DIGEST_MAX_CHARS = 320;
const DEFAULT_WINDOW_DAYS = 7;
const MAX_PRS_SHOWN_PER_REPO = 12; // caps a busy-week PR listing before it dominates the message
// Caps the epic listing the same way MAX_PRS_SHOWN_PER_REPO caps PRs. There was NO cap here, which is
// how the 2026-08-24 run died: a ~6-week catch-up window (the last successful post was 2026-07-13) found
// 52 shipped/archived epics and rendered every one with its retro digest — each up to
// RETRO_DIGEST_MAX_CHARS. A per-section cap is the PRIMARY control; truncateForTelegram is only the net.
const MAX_EPICS_SHOWN = 10;
const TELEGRAM_MAX_CHARS = 4096; // Telegram sendMessage's hard text limit — a safety net, not the primary control

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---- window / memory log (JSONL, one line per run — lives on a dedicated branch, see above) ----

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

// Pure — a window tracker (not a delta diff like standup.mjs). Next run picks up exactly where the
// last one left off; a first run (or a wiped log) falls back to a plain trailing 7 days. `overrideUntilISO`
// lets a manual backfill bound the window (e.g. "what shipped in June") — the normal nightly/weekly path
// never sets it, so `untilISO` is always "now" there.
export function computeWindow(lastLogLine, now, overrideSinceISO, overrideUntilISO) {
  const nowISO = now.toISOString();
  const untilISO = overrideUntilISO || nowISO;
  if (overrideSinceISO) return { sinceISO: overrideSinceISO, untilISO };
  if (lastLogLine?.windowEnd) return { sinceISO: lastLogLine.windowEnd, untilISO };
  const fallback = new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { sinceISO: fallback.toISOString(), untilISO };
}

// ---- gather: merged PRs per repo (REST-only — scripts/lib/gh-rest.mjs) ----
//
// `gh pr list --search` hits GraphQL internally, which is blocked in at least one live routine sandbox
// (confirmed 2026-07-02). searchMergedPrs() uses the REST-based /search/issues endpoint instead, which
// supports the same `merged:>=` day-granular qualifier and a `base:` filter.

// searchMergedPrs's own maxItems ceiling — set generously above what even a full-month backfill needs
// (the busiest repo here runs ~30-40 merged PRs/week, so a month is comfortably under 500) rather than a
// weekly-sized default, which a SKILL.md-documented month-long backfill could silently exceed with zero
// signal that it happened.
const MAX_PRS_FETCHED_PER_REPO = 500;

function gatherMergedPrs(repo, sinceISO, untilISO) {
  const sinceDate = sinceISO.slice(0, 10);
  const prs = searchMergedPrs({ repo, sinceDate, base: 'main', maxItems: MAX_PRS_FETCHED_PER_REPO });
  if (prs === null) return { repo, available: false, prs: [], capped: false };
  // The search's date qualifier is day-granular — filter to the real [sinceISO, untilISO) window so a
  // run near midnight UTC doesn't double-count a PR merged just outside the boundary day, and a bounded
  // backfill (--until) doesn't pull in PRs merged after it.
  const filtered = prs.filter((p) => p.mergedAt >= sinceISO && p.mergedAt < untilISO);
  // Hitting the fetch cap exactly is the one signal we get that the true count may be higher — the
  // search API gives no "there were more" flag beyond "we returned exactly maxItems results".
  return { repo, available: true, prs: filtered, capped: prs.length === MAX_PRS_FETCHED_PER_REPO };
}

// ---- gather: shipped/closed epics (git log -p on epic READMEs) ----

// Pure — parses `git log --date=iso-strict -p -- 'Roadmap/*/*/README.md'` output for added
// `+status: shipped|archived` lines, pairing each with the file its diff hunk belongs to (tracked via
// the preceding `diff --git` header) and the ISO date of the commit that made it (tracked via the
// preceding `Date:` header). Dedupes to the LAST flip per file in the window (in case a file flipped
// more than once). The date lets the caller enforce an exact [sinceISO, untilISO) bound in JS — `git
// log --since/--until` are themselves INCLUSIVE on both ends, not half-open, so relying on them alone
// (as an earlier version of this function did) could double-count a commit landing exactly on a window
// boundary second across two consecutive runs.
export function parseStatusFlipsFromLog(diffText) {
  const flips = new Map(); // file -> {status, date} (insertion order = chronological, oldest→newest from git log)
  let currentFile = null;
  let currentDate = null;
  const dateRe = /^Date:\s+(.+)$/;
  const fileRe = /^diff --git a\/(.+?) b\/.+$/;
  const statusRe = /^\+status:\s*(shipped|archived)\b/;
  for (const line of diffText.split('\n')) {
    const dm = dateRe.exec(line);
    if (dm) {
      currentDate = dm[1].trim();
      continue;
    }
    const fm = fileRe.exec(line);
    if (fm) {
      currentFile = fm[1];
      continue;
    }
    const sm = statusRe.exec(line);
    if (sm && currentFile) {
      flips.set(currentFile, { status: sm[1], date: currentDate }); // last write wins (chronological — see note below)
    }
  }
  return [...flips.entries()].map(([file, v]) => ({ file, status: v.status, date: v.date }));
}

// Pure — pulls the epic's display name from its README's first `# Epic...`/`# Epic:` heading, else the
// slug derived from the path.
export function epicNameFromReadme(markdown, filePath) {
  const m = /^#\s+(.+)$/m.exec(markdown);
  if (m) return m[1].replace(/^Epic:?\s*/i, '').trim();
  const parts = filePath.split('/');
  return parts[parts.length - 2] || filePath;
}

// Pure — the exact [sinceISO, untilISO) bound, matching gatherMergedPrs's `p.mergedAt >= sinceISO &&
// p.mergedAt < untilISO` convention. `git log --since/--until` are themselves INCLUSIVE on both ends, so
// they're only a coarse pre-filter (passed to git for efficiency) — this is what actually enforces the
// window and stops a commit landing exactly on a boundary second from double-counting across two
// consecutive runs.
export function filterFlipsToWindow(flips, sinceISO, untilISO) {
  const sinceMs = new Date(sinceISO).getTime();
  const untilMs = new Date(untilISO).getTime();
  return flips.filter((f) => {
    const t = new Date(f.date).getTime();
    return t >= sinceMs && t < untilMs;
  });
}

// Returns `{ available: false }` on a git failure (so the caller can distinguish "couldn't read git
// history" from "genuinely zero epics shipped") — never a bare [] that looks identical to "quiet".
function gatherShippedEpics(sinceISO, untilISO) {
  // git log defaults to newest-first; -p in that order still gives each flip's LATEST value first per
  // file, so reverse iteration order (oldest first) before building the map so "last write wins" means
  // chronologically last, not textually last in output.
  const r = spawnSync(
    'git',
    [
      'log',
      '--since',
      sinceISO,
      '--until',
      untilISO,
      '--date=iso-strict',
      '-p',
      '--reverse',
      '--',
      'Roadmap/*/*/README.md',
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  if (r.status !== 0) return { available: false, epics: [] };
  const flips = filterFlipsToWindow(parseStatusFlipsFromLog(r.stdout || ''), sinceISO, untilISO);
  const epics = flips.map(({ file, status }) => {
    const abs = join(ROOT, file);
    let name = file;
    let retroDigest = null;
    if (existsSync(abs)) {
      name = epicNameFromReadme(readFileSync(abs, 'utf8'), file);
    }
    const retroPath = join(dirname(abs), 'RETROSPECTIVE.md');
    if (existsSync(retroPath)) {
      retroDigest = extractRetroDigest(readFileSync(retroPath, 'utf8'), RETRO_DIGEST_MAX_CHARS);
    }
    return { file, status, name, retroDigest };
  });
  return { available: true, epics };
}

// Pure — pulls a short excerpt from a RETROSPECTIVE.md's "## What shipped" section (the first
// paragraph), capped at maxChars. Degrades to null if the section isn't found — the caller then just
// shows the epic name/link with no digest, rather than failing.
export function extractRetroDigest(markdown, maxChars) {
  const m = /^##\s+What shipped\s*\n+([\s\S]+?)(?=\n##\s|\n*$)/m.exec(markdown);
  if (!m) return null;
  const firstBlock = m[1]
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ')
    .trim();
  if (!firstBlock) return null;
  return firstBlock.length > maxChars ? `${firstBlock.slice(0, maxChars).trim()}…` : firstBlock;
}

// ---- message ----
// formatPrList/truncateForTelegram now live in scripts/lib/telegram-format.mjs (shared with
// standup.mjs, which hit the exact same message-length failure mode live).

// Pure — builds the Telegram message from already-gathered data. No I/O.
// `shippedEpics` is `{ available, epics }` — `available: false` (a git-log read failure) must render as
// "unavailable", never fold into "none this week"/the quiet-week collapse (that's a different fact).
export function buildMessage({
  sinceISO,
  untilISO,
  repoResults,
  shippedEpics,
  deployRepos = [],
  prose = null,
}) {
  const since = sinceISO.slice(0, 10);
  const until = untilISO.slice(0, 10);
  const lines = [`<b>Weekly recap · ${since} – ${until}</b>`];

  lines.push('');
  lines.push('<b>🚀 Merged PRs</b>');
  let totalPrs = 0;
  for (const r of repoResults) {
    const label = esc(shortRepo(r.repo));
    if (!r.available) {
      lines.push(`${label}: unavailable`);
      continue;
    }
    totalPrs += r.prs.length;
    if (!r.prs.length) {
      lines.push(`${label}: none this week`);
      continue;
    }
    const cappedNote = r.capped ? ' ⚠️ hit the fetch cap — count may be incomplete' : '';
    lines.push(`${label} (${r.prs.length}${cappedNote}): ${formatPrList(r.prs, MAX_PRS_SHOWN_PER_REPO)}`);
  }

  // Only when the project names its deploy repos — "merging to main IS the deploy" is a per-repo fact,
  // and guessing which repos deploy would print a number that means nothing.
  if (deployRepos.length) {
    lines.push('');
    lines.push('<b>📦 Deploys</b> (merges to main)');
    lines.push(
      deployRepos
        .map(({ label, repo }) => {
          const r = repoResults.find((x) => x.repo === repo);
          return `${esc(label)}: ${r?.available ? r.prs.length : 'unavailable'}`;
        })
        .join(' · ')
    );
  }

  lines.push('');
  // The count goes in the HEADER, not only in the "…and N more" tail, because the tail is the first
  // thing the 4096-char net eats: a 6-week catch-up renders long enough that truncation lands INSIDE
  // the epic list, taking the tail — and with it the only remaining evidence of how many epics there
  // were — while the header survives. Same shape the PR section has always had: `repo (84): …`.
  const epicCount = shippedEpics.available ? shippedEpics.epics.length : null;
  lines.push(`<b>✅ Shipped / closed epics</b>${epicCount ? ` (${epicCount})` : ''}`);
  if (!shippedEpics.available) {
    lines.push('unavailable (git log read failed)');
  } else if (!shippedEpics.epics.length) {
    lines.push('none this week');
  } else {
    for (const e of shippedEpics.epics.slice(0, MAX_EPICS_SHOWN)) {
      lines.push(`${e.status === 'shipped' ? '✅' : '🗄️'} <b>${esc(e.name)}</b>`);
      if (e.retroDigest) lines.push(esc(e.retroDigest));
    }
    // The count above the fold stays TRUE even when the list is cut — a reader must not read a capped
    // list as the whole week. Same contract as formatPrList's "…and N more".
    const rest = shippedEpics.epics.length - MAX_EPICS_SHOWN;
    if (rest > 0) lines.push(`…and ${rest} more`);
  }

  // Only collapse to the quiet-week one-liner when every signal actually reported in — an unavailable
  // repo or an unavailable epic read must never be silently swallowed into the upbeat "nothing happened"
  // framing (those are different facts a reader needs distinguished).
  const allAvailable = repoResults.every((r) => r.available) && shippedEpics.available;
  if (allAvailable && totalPrs === 0 && !shippedEpics.epics.length) {
    const quiet = `<b>Weekly recap · ${since} – ${until}</b>\n🌙 Quiet week — nothing merged or shipped since the last recap.`;
    return truncateForTelegram(spliceProse(quiet, prose), TELEGRAM_MAX_CHARS);
  }

  // The prose is spliced in HERE, before the cap — not by the caller afterwards. It used to be
  // `buildMessage(...).replace(/\n/, prose)` in main(), which meant the safety net was applied one layer
  // BELOW the message that actually got sent: buildMessage returned exactly <=4096, then main() grew it
  // by the length of the prose. That is why the 2026-08-24 run died on "message too long" despite a
  // correct, unit-tested truncator — the pure core was right and the assembly it did not own was wrong.
  return truncateForTelegram(spliceProse(lines.join('\n'), prose), TELEGRAM_MAX_CHARS);
}

// Prose leads, the existing tallies follow (the standup makes the same shape decision). Prose going
// FIRST also decides what survives the cap: the hand-written recap is the point of the message, so a
// truncation eats the tallies, never the prose.
function spliceProse(base, prose) {
  return prose ? base.replace(/\n/, `\n\n${prose}\n`) : base;
}

// ---- Telegram (same shape standup.mjs reimplements standalone) ----

async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) die('TELEGRAM_BOT_TOKEN is not set — export it before running weekly-recap.mjs.');
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

function appendRunAndPush(entry) {
  const ok = appendLineToBranch({
    cwd: ROOT,
    branch: LOG_BRANCH,
    path: LOG_BRANCH_PATH,
    line: `${JSON.stringify(entry)}\n`,
    message: `chore(weekly-recap): log ${new Date().toISOString().slice(0, 10)}`,
  });
  if (!ok) {
    console.error(
      `weekly-recap: writing the updated log to ${LOG_BRANCH} failed — the next run (esp. a fresh ` +
        `routine session) won't see it and will re-derive its window from a stale/missing log.`
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

  const now = new Date();
  const lastRun = loadLastRun();
  const { sinceISO, untilISO } = computeWindow(lastRun, now, SINCE_OVERRIDE, UNTIL_OVERRIDE);

  const repoResults = config.repos.map((repo) => gatherMergedPrs(repo, sinceISO, untilISO));
  const shippedEpics = gatherShippedEpics(sinceISO, untilISO);

  // ── Phase 1: --brief ──────────────────────────────────────────────────────────────────────
  if (BRIEF) {
    const windowLabel = `the week of ${sinceISO.slice(0, 10)} to ${untilISO.slice(0, 10)}`;
    const prCount = repoResults.reduce((n, r) => n + (r.available ? r.prs.length : 0), 0);
    const epics = shippedEpics.available ? shippedEpics.epics : [];

    // D7: nothing shipped AND nothing merged is the only genuinely quiet week.
    if (!epics.length && prCount === 0) {
      writeSync(1, `${buildQuietBrief(windowLabel)}\n`);
      return;
    }

    // Shipped/closed epics lead — the highest-altitude product input we own, written in product
    // language by the people who did the work, with their retro digests attached.
    const roadmapDeltas = epics.map(
      (e) =>
        `Epic "${e.name}" moved to ${e.status}${e.retroDigest ? ` — from its retrospective: ${e.retroDigest}` : ''}`
    );

    const pack = buildEvidencePack({
      windowLabel,
      roadmapDeltas,
      owed: loadOwedLedger(join(ROOT, 'Roadmap/00-ideas/OWED-LEDGER.json')),
      repoSignals: [
        `${prCount} pull request(s) merged across ${config.repos.length} repositor${config.repos.length === 1 ? 'y' : 'ies'} this week.`,
      ],
      liveFlags: { available: false, flags: [] },
    });
    writeSync(1, `${buildBrief({ scriptsDir: __dirname, surface: 'weekly', pack })}\n`);
    return;
  }

  // ── Phase 3: --post --prose-file ──────────────────────────────────────────────────────────
  // `--post` requires an explicit mode — see standup.mjs. A quiet WEEK matters more here than a quiet
  // night: this script tracks a WINDOW, so if the routine stops without posting, `windowEnd` never
  // advances and the next run re-counts the same period. Cross-review caught exactly that.
  if (POST && !PROSE_FILE && !QUIET) {
    die(
      '--post needs either --prose-file <path> (a guarded prose post) or --quiet (the one-line\n' +
        '  quiet-week message, which also ADVANCES the window log). Refusing an unguarded send.'
    );
  }

  let prose = null;
  if (POST && PROSE_FILE) {
    const draft = readFileSync(resolve(ROOT, PROSE_FILE), 'utf8').trim();
    // Derived from the window, not hardcoded — see standup.mjs.
    const subjects = repoResults.flatMap((r) => (r.available ? r.prs.map((p) => p.title || '') : []));
    const areas = shippedEpics.available && shippedEpics.epics.length ? ['customer-facing pages'] : [];
    const evidence = deriveEvidenceFlags({ subjects, areas, liveFlags: [], maxWords: WEEKLY_MAX_WORDS });
    // jev-semantic-guards S3.2: the semantic families are judged by Jev per jev.config.json → rails.prose.mode;
    // `checkProse` is the fallback and, with the rail off, the whole of it. The decider is on the result.
    const verdict = await judgeProse(draft, {
      ...evidence,
      extraBannedToolNames: config.prose.extraBannedToolNames,
    });
    const found = verdict.findings.map((f) => f.code).join(', ');
    process.stderr.write(`prose guard: decided by ${verdict.decider} (${verdict.mode}) — ${found || 'clean'}\n`);
    if (!verdict.ok && !FORCE_POST) {
      process.stderr.write(`${findingsToRevisionNote(verdict.findings)}\n`);
      process.exit(2);
    }
    prose = verdict.ok
      ? draft
      : `${draft}\n\n<i>⚠ flagged draft — ${verdict.findings.map((f) => f.code).join(', ')}</i>`;
  }

  const message = buildMessage({
    sinceISO,
    untilISO,
    repoResults,
    shippedEpics,
    deployRepos: config.deployRepos,
    prose,
  });
  console.log(message.replace(/<\/?[^>]+>/g, ''));

  if (!DRY_RUN) {
    const chatId = chatIdFor(config, 'weekly');
    if (!chatId) {
      die(
        'No Telegram chat id configured — set "telegram.chatIds.weekly" or "telegram.chatId" in ' +
          'reporting.config.json, or export TELEGRAM_CHAT_ID.'
      );
    }
    await sendTelegram(chatId, message);

    appendRunAndPush({
      ts: now.toISOString(),
      windowStart: sinceISO,
      windowEnd: untilISO,
      prCount: repoResults.reduce((n, r) => n + (r.available ? r.prs.length : 0), 0),
      shippedCount: shippedEpics.available ? shippedEpics.epics.length : null,
    });
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
