#!/usr/bin/env node
// merge-report.mjs — post a product report for every new `main` commit, exactly once.
//
// ── Why this exists (the gap, stated plainly) ─────────────────────────────────────────────────
// The `notify-telegram.yml` workflow in each app repo posts the commit header, the author and a diff
// link on every push to main. That is the "regular notification" — machine facts, no prose.
//
// The exec-prose-rail epic gave the daily standup and the weekly recap a CPO voice, but it never
// covered THIS surface. That was a scoping error: golden-beans' prose rail exists for deployment
// notifications, the ask was to do the same here *and* extend it to the scheduled reports, and only
// the second half got built. So merges have been arriving as bare commit headers.
//
// ── Why local, and why a state file ───────────────────────────────────────────────────────────
// Prose needs devin/agy, which have no headless auth — so this cannot live in the GitHub Actions
// notifier (which is also out of quota). It runs on the machine that pulled the merge, driven by a
// git hook.
//
// Hooks over-fire by design: `git pull` with nothing to fetch, a second pull, a rebase, a branch
// checkout. Reporting HEAD unconditionally is how a channel gets the same message five times. The
// state file makes "already reported" a fact on disk rather than an inference, and it advances ONLY
// for commits whose post actually succeeded — so a failed send retries next run instead of being
// silently skipped, and a success is never repeated.
//
//   node scripts/merge-report.mjs              # report anything unreported, then post
//   node scripts/merge-report.mjs --dry-run    # show what WOULD post, write nothing, send nothing
//   node scripts/merge-report.mjs --limit 3    # bound a large catch-up
//   node scripts/merge-report.mjs --mark-only  # accept current main as reported, post nothing
//
// Reuse, don't rebuild: writeProse (devin→agy + the shared pure guard), the CPO persona, the
// accumulated lessons, and the same Telegram sendMessage shape standup.mjs already uses.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { die, loadPromptBody, hasCmd } from './lib/cross-agent-cli.mjs';
import { writeProse, buildWriterPrompt, loadLessons } from './lib/prose-writer.mjs';
import { loadReportingConfig, chatIdFor, ReportingConfigError } from './lib/reporting-config.mjs';
import { isMain } from './lib/is-main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The repo being REPORTED is whichever one the hook fired in — not the one this script lives in.
// All three repos (root, storefront, commerce engine) merge to their own `main`, and the app repos
// are the ones that actually deploy, so one script serves all three: the hook calls it from its own
// working directory and this resolves that repo's toplevel. Prose assets stay relative to the script.
function resolveRepoRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status === 0 && (r.stdout || '').trim()) return r.stdout.trim();
  return join(__dirname, '..');
}
const REPO_ROOT = resolveRepoRoot();

// Lives in the git dir, not the work tree: per-CLONE state, never shared, never committed — and
// therefore naturally isolated per repo, which is what makes one script safe across all three.
//
// `--git-common-dir`, NOT `<root>/.git` (fixed 2026-07-27). In a LINKED WORKTREE `.git` is a FILE,
// not a directory, so the old join produced `<worktree>/.git/merge-reported-commits` and every
// write died with ENOTDIR — silently, because the hook backgrounds this and swallows failures.
// This repo runs five worktrees at a time, so that was a large share of the reports that never
// appeared. `--git-common-dir` resolves to the MAIN clone's git dir from inside any worktree,
// which also keeps the once-per-commit guarantee honest: all worktrees of one clone share the
// state file, so checking out the same merge in a second worktree cannot re-report it.
function resolveGitDir() {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const out = r.status === 0 ? (r.stdout || '').trim() : '';
  if (!out) return join(REPO_ROOT, '.git');
  // `--git-common-dir` may answer relatively (plain `.git` in a normal checkout).
  return out.startsWith('/') ? out : join(REPO_ROOT, out);
}
const STATE_PATH = join(resolveGitDir(), 'merge-reported-commits');

// A merge notification is a chat message under a commit header.
const MAX_WORDS = 60;
// A catch-up after a long absence should not spray the channel.
const DEFAULT_LIMIT = 5;

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

export function readState(deps = {}) {
  const { read = readFileSync, exists = existsSync, path = STATE_PATH } = deps;
  if (!exists(path)) return null;
  const raw = String(read(path, 'utf8')).trim();
  return /^[0-9a-f]{7,40}$/i.test(raw) ? raw : null;
}

export function writeState(sha, deps = {}) {
  const { write = writeFileSync, mkdir = mkdirSync, path = STATE_PATH } = deps;
  mkdir(dirname(path), { recursive: true });
  write(path, `${sha}\n`, 'utf8');
}

/**
 * Commits to report, oldest first.
 *
 * With no state we do NOT walk all of history — that would spray the channel on first install. We
 * report only the current HEAD and record it, which is the same "a missing baseline is a bounded
 * no-op, never 'everything happened'" rule the standup learned the hard way.
 */
export function commitsToReport({ lastSha, head, listBetween }) {
  if (!head) return [];
  if (!lastSha) return [head];
  if (lastSha === head) return [];
  const between = listBetween(lastSha, head);
  // A force-push or rebase can make the old sha unreachable; fall back to HEAD alone rather than
  // replaying an unrelated range.
  return between === null || between.length === 0 ? [head] : between;
}

/** Facts for one commit. Merge commits are skipped by the caller — a squash already carries the story. */
export function gatherCommit(sha, run = git) {
  const raw = run(['show', '-s', '--format=%H%x00%s%x00%b%x00%an', sha]);
  if (!raw) return null;
  const [full, subject, body, author] = raw.split('\0');
  const files = (run(['show', '--name-only', '--format=', sha]) || '')
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
  return { sha: full, short: full.slice(0, 7), subject, body: body || '', author, files };
}

/** Shape only — the persona forbids naming files, so the writer gets areas, never paths. */
export function summarizeAreas(files) {
  const areas = new Set();
  for (const f of files) {
    if (f.startsWith('Roadmap/')) areas.add('product/roadmap docs');
    else if (f.startsWith('scripts/')) areas.add('internal delivery tooling');
    else if (f.startsWith('.github/')) areas.add('the build pipeline');
    else if (/(^|\/)e2e\//.test(f)) areas.add('the automated test suite');
    else if (/(^|\/)app\//.test(f)) areas.add('customer-facing pages');
    else if (/(^|\/)src\/api\//.test(f)) areas.add('commerce API routes');
    else if (/(^|\/)src\/modules\//.test(f)) areas.add('commerce engine modules');
    else if (/\.sql$/.test(f)) areas.add('the database schema');
    else areas.add('supporting code');
  }
  return [...areas];
}

export function buildTask(commit, areas) {
  const lines = [
    '## The merge to report',
    '',
    `Commit subject (already visible to the reader — do NOT restate it): ${commit.subject}`,
    '',
  ];
  if (commit.body.trim()) {
    lines.push(
      'Commit body — this is the richest input you have. It usually states WHY, and often names the',
      'decision behind the work. Use it; do not quote it.',
      '',
      commit.body.trim(),
      ''
    );
  }
  lines.push(
    'Where the work landed (shape only — never name a file in your report):',
    ...(areas.length ? areas.map((a) => `- ${a}`) : ['- (no files changed)'])
  );
  return lines.join('\n');
}

/**
 * Evidence flags, DERIVED from the commit — never assumed.
 *
 * Both permissions default closed, which is what makes the corresponding guard rules mean something.
 * A merge that ships dark must not be describable as live, and most merges here ship dark.
 */
export function deriveEvidence(commit, areas) {
  const text = `${commit.subject}\n${commit.body}`;
  return {
    allowsFixClaim: /^(?:fix|hotfix|revert)(?:\([^)]*\))?!?:/i.test(commit.subject),
    allowsBeneficiary: areas.some((a) => /customer-facing|commerce API|commerce engine/.test(a)),
    // A flag is only corroborated when the commit itself says it was turned ON.
    liveFlags: /\bflag(?:ped)?\s+(?:is\s+)?(?:flipped\s+)?on\b|\benabled\s*=\s*true\b/i.test(text)
      ? (text.match(/[a-z_]+\.[a-z_]+/gi) || []).slice(0, 5)
      : [],
    allowsMarkdown: false,
    maxWords: MAX_WORDS,
    minWords: 12,
  };
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The chat: reporting.config.json's `telegram.chatIds.merge`, then `telegram.chatId`, then
// TELEGRAM_CHAT_ID (the same seam the standup/recap/PMO report use). Config + prose assets live with the
// SCRIPT's repo, not with the repo being reported. No config and no env var → print instead of posting.
export function loadChatId({ load = loadReportingConfig, env = process.env } = {}) {
  try {
    return chatIdFor(load({ root: join(__dirname, '..') }), 'merge', env);
  } catch (e) {
    if (!(e instanceof ReportingConfigError)) throw e;
    return env.TELEGRAM_CHAT_ID || null;
  }
}

/**
 * Resolve the bot token.
 *
 * A git hook does NOT reliably inherit an interactive shell's environment — fired from an editor, a
 * GUI client or a background process it may see almost nothing. So the env var alone is not a
 * dependable source for an automatic rail, and the token falls back to a gitignored `.env.local`,
 * which is the same place golden-beans' rail reads it from. Never logged, never committed.
 */
function resolveBotToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  const envFile = join(__dirname, '..', '.env.local');
  if (!existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

async function sendTelegram(chatId, text) {
  const token = resolveBotToken();
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set and absent from .env.local' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `Telegram ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function buildMessage({ commit, prose, guardOk, writer, model, repoLabel }) {
  const attribution = guardOk ? `${writer}/${model}` : `${writer}/${model} · ⚠ FLAGGED`;
  return (
    `<b>${esc(commit.subject)}</b> · 📝 · <code>${commit.short}</code>${repoLabel ? ` · ${esc(repoLabel)}` : ''}\n\n` +
    `${esc(prose)}\n\n` +
    `<i>${esc(attribution)}</i>`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const markOnly = argv.includes('--mark-only');
  const li = argv.indexOf('--limit');
  const limit = li !== -1 ? Number(argv[li + 1]) : DEFAULT_LIMIT;

  const head = git(['rev-parse', 'HEAD']);
  if (!head) die('not a git repo, or HEAD is unreadable.');

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') {
    // Deliberately silent: the hook fires on every checkout, and a feature branch is not a deploy.
    return;
  }

  const lastSha = readState();

  if (markOnly) {
    writeState(head);
    writeSync(1, `merge-report: marked ${head.slice(0, 7)} as reported; nothing posted.\n`);
    return;
  }

  const listBetween = (from, to) => {
    const out = git(['rev-list', '--reverse', '--no-merges', `${from}..${to}`]);
    return out === null ? null : out.split('\n').filter(Boolean);
  };
  let todo = commitsToReport({ lastSha, head, listBetween });
  if (todo.length === 0) return; // silent — the common case on an over-firing hook

  if (todo.length > limit) {
    writeSync(1, `merge-report: ${todo.length} unreported commits; reporting the newest ${limit}.\n`);
    todo = todo.slice(-limit);
  }

  if (!dryRun && !hasCmd('devin') && !hasCmd('agy')) {
    // Do NOT advance the state — this is a transient local condition, and the commits should be
    // reported once a writer is available rather than silently lost.
    writeSync(1, 'merge-report: no prose writer available (devin/agy); leaving these commits unreported.\n');
    return;
  }

  const style = [
    loadPromptBody(join(__dirname, 'prose', 'cpo-persona.md')),
    loadPromptBody(join(__dirname, 'prose', 'merge.task.md')),
  ].join('\n\n');
  const lessons = loadLessons();
  const chatId = loadChatId();
  // No chat configured: stop BEFORE drafting. The template ships unconfigured, and post-merge AND
  // post-checkout fire this — without this line every pull and every branch switch in a fresh project
  // would spend a prose-writer call re-drafting the same report into a log nobody reads. `--dry-run`
  // still drafts (that is its job). Configure telegram.chatIds.merge / telegram.chatId or
  // TELEGRAM_CHAT_ID to turn the rail on.
  if (!chatId && !dryRun) {
    writeSync(1, 'merge-report: no chat configured (reporting.config.json telegram / TELEGRAM_CHAT_ID) — rail off, nothing drafted.\n');
    return;
  }

  for (const sha of todo) {
    const commit = gatherCommit(sha);
    if (!commit) continue;
    const areas = summarizeAreas(commit.files);
    const prompt = buildWriterPrompt({ style, lessons, task: buildTask(commit, areas) });

    if (dryRun) {
      writeSync(1, `\n──── ${commit.short} ${commit.subject}\n${prompt.slice(-700)}\n`);
      continue;
    }

    const result = await writeProse({ prompt, evidence: deriveEvidence(commit, areas) });
    if (result.guard?.decider) process.stderr.write(`prose guard: decided by ${result.guard.decider}\n`);
    if (!result.text) {
      writeSync(1, `merge-report: no draft for ${commit.short} (${result.error}); will retry next run.\n`);
      return; // stop and leave state unadvanced — order matters, and a gap would be worse than a delay
    }

    const message = buildMessage({
      commit,
      prose: result.text,
      guardOk: result.ok,
      writer: result.writer,
      model: result.model,
      repoLabel: REPO_ROOT.split('/').pop(),
    });

    if (!chatId) {
      writeSync(1, `merge-report: no chat id configured; printing instead.\n\n${message}\n`);
      return;
    }
    const sent = await sendTelegram(chatId, message);
    if (!sent.ok) {
      writeSync(1, `merge-report: send failed for ${commit.short} (${sent.error}); will retry next run.\n`);
      return; // state stays put — a failed post is retried, never silently skipped
    }
    // Advance ONLY after a confirmed send.
    writeState(commit.sha);
    writeSync(1, `merge-report: posted ${commit.short} (${result.writer}, guard ${result.ok ? 'clean' : 'FLAGGED'}).\n`);
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`merge-report: ${e.message}\n`);
    process.exit(1);
  });
}
