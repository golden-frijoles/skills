#!/usr/bin/env node
// build-order-sync.mjs — regenerate Roadmap/00-ideas/BUILD-ORDER.md when it's drifted from the SSOT,
// and open a `claude/` DOCS PR with the fix. Never hand-edits the board (SSOT = each epic README's
// frontmatter `status:`, per scripts/build-order.mjs).
//
// Usage:
//   node scripts/build-order-sync.mjs             # check → regen → branch → commit → push → gh pr create
//   node scripts/build-order-sync.mjs --dry-run   # check → regen → print `git diff --stat` → restore the
//                                                  # file (`git checkout --`), leaving the working tree
//                                                  # exactly as found — no branch/commit/push/PR, and no
//                                                  # lingering file mutation either
//
// The branch stays `claude/`-prefixed on purpose — that's a routine's DEFAULT push scope (see
// scripts/routines/README.md's two standing rules), unlike standup.mjs which needed push enabled
// BEYOND that default to land its log commit on `main` directly. Don't over-grant push for this one.
//
// Reuse, don't rebuild: scripts/build-order.mjs (the regenerator + --check), ensureGh()/die()
// (scripts/lib/cross-agent-cli.mjs). Zero new npm deps — Node 18+.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureGh, die } from './lib/cross-agent-cli.mjs';
import { createPullRequest } from './lib/gh-rest.mjs';
import { projectRoot } from './lib/project-root.mjs';
import { isMain } from './lib/is-main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = projectRoot(); // D2: the user's project, wherever this set runs from
const BOARD_PATH = 'Roadmap/00-ideas/BUILD-ORDER.md';
const BANNER =
  "> **Advisory — docs-only.** Auto-regenerated from the SSOT (each epic README's frontmatter " +
  '`status:`). This PR only refreshes the derived board; it never touches the doc that caused the drift.';

const DRY_RUN = process.argv.includes('--dry-run');

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

// Pure — the date-stamped branch name. Exported for the co-located test.
export function branchName(date = new Date()) {
  return `claude/build-order-sync-${date.toISOString().slice(0, 10)}`;
}

// Pure — the PR title + body. Exported for the co-located test.
export function buildPrBody() {
  return [
    BANNER,
    '',
    `\`${BOARD_PATH}\` was stale — regenerated via \`node scripts/build-order.mjs\` and committed as-is,`,
    'no hand edits.',
    '',
    'Advisory only — not a gate. Review the diff and merge by hand.',
  ].join('\n');
}
export const PR_TITLE = 'chore(build-order): regenerate stale board';

// Pure — parses "owner/repo" from either remote URL form git produces (HTTPS or SSH). Exported for the
// co-located test. `(?:^|[/@])` requires "github.com" to be preceded by the start of the string, `/`, or
// `@` — not just any substring match — so a host like `notgithub.com` doesn't false-positive. The repo
// group allows dots (GitHub permits dotted repo names); it's non-greedy so a trailing `.git` still gets
// stripped rather than swallowed into the name.
export function repoSlugFromRemoteUrl(url) {
  const m = /(?:^|[/@])github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec((url || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function isDrifted() {
  const r = run(process.execPath, [join(__dirname, 'build-order.mjs'), '--check']); // a sibling, never the project's copy
  return r.status !== 0;
}

function regenerate() {
  const r = run(process.execPath, [join(__dirname, 'build-order.mjs')]);
  if (r.status !== 0) die(`build-order.mjs regen failed: ${(r.stderr || r.stdout || '').trim()}`);
}

function boardActuallyChanged() {
  const r = run('git', ['status', '--porcelain', '--', BOARD_PATH]);
  return !!(r.stdout || '').trim();
}

function main() {
  if (!isDrifted()) {
    console.log('BUILD-ORDER.md is up to date — no PR needed.');
    return;
  }

  regenerate();
  if (!boardActuallyChanged()) {
    console.log(
      'build-order.mjs --check reported drift, but regen produced no file diff — nothing to commit.'
    );
    return;
  }

  if (DRY_RUN) {
    const diff = run('git', ['diff', '--stat', '--', BOARD_PATH]);
    console.log('DRY-RUN — board would be regenerated (no branch/commit/push/PR):');
    console.log((diff.stdout || '').trim());
    // regenerate() already wrote the file to disk to compute this diff — restore it so --dry-run leaves
    // the working tree exactly as it found it (a real "would do this" preview, not a partial mutation).
    const restore = run('git', ['checkout', '--', BOARD_PATH]);
    if (restore.status !== 0) {
      console.error(
        `build-order-sync: could not restore ${BOARD_PATH} after --dry-run (${(restore.stderr || '').trim()}) — the working tree is left with the regenerated file; revert it manually if needed.`
      );
    }
    return;
  }

  ensureGh();

  const branch = branchName();
  const checkout = run('git', ['checkout', '-b', branch]);
  if (checkout.status !== 0) die(`git checkout -b ${branch} failed: ${(checkout.stderr || '').trim()}`);

  const add = run('git', ['add', BOARD_PATH]);
  if (add.status !== 0) die(`git add failed: ${(add.stderr || '').trim()}`);

  const commit = run('git', ['commit', '-m', 'chore(build-order): regenerate stale board', '--', BOARD_PATH]);
  if (commit.status !== 0) die(`git commit failed: ${(commit.stderr || '').trim()}`);

  const push = run('git', ['push', '-u', 'origin', branch]);
  if (push.status !== 0) die(`git push failed: ${(push.stderr || '').trim()}`);

  // REST-only (scripts/lib/gh-rest.mjs) — `gh pr create` hits GraphQL internally, which is blocked in at
  // least one live routine sandbox (confirmed 2026-07-02, ops-nightly). createPullRequest() is a plain
  // REST POST instead, so this needs the owner/repo slug explicitly (gh CLI normally infers it from the
  // current directory's git remote — parsed here from `git remote get-url origin` instead).
  const remoteUrl = (run('git', ['remote', 'get-url', 'origin']).stdout || '').trim();
  const repo = repoSlugFromRemoteUrl(remoteUrl);
  if (!repo) die(`could not parse an owner/repo slug from the origin remote URL: ${remoteUrl || '(empty)'}`);

  const pr = createPullRequest({ repo, head: branch, base: 'main', title: PR_TITLE, body: buildPrBody() });
  if (!pr) die('creating the build-order docs PR failed.');
  console.log(pr.url);
}

if (isMain(import.meta.url)) main();
