// log-branch.mjs — persist a single data file across separate routine sessions via a dedicated
// `claude/`-prefixed branch, using git PLUMBING only (hash-object/mktree/commit-tree/push). This never
// checks anything out and never touches the working tree, the index, or whatever branch is currently
// checked out — it only creates objects and moves one ref.
//
// Why this exists (not `git commit`/`git push` to `main` directly, as standup.mjs/weekly-recap.mjs
// originally did): a routine's DEFAULT push scope only covers `claude/`-prefixed branches; pushing a log
// commit straight to `main` needs "Allow unrestricted branch pushes" enabled on the routine — and live
// 2026-07-02/03, that toggle's Save button failed ("Failed to save changes") in the claude.ai Routines
// UI. Moving log persistence onto a `claude/`-prefixed branch removes the dependency on that toggle
// entirely — it's the routine's default scope, no extra permission needed, no UI bug to work around.

import { spawnSync } from 'node:child_process';

// Every log commit also carries this vercel.json. A log branch is an orphan with no package.json, and a
// repo whose Vercel project builds every pushed branch tried to build it as a preview and failed on each
// write ("No Next.js version detected", claude/session-journal, 2026-10-04). Vercel reads vercel.json from
// the commit it is about to build, so the branch itself has to say "don't".
export const LOG_BRANCH_VERCEL_JSON = `${JSON.stringify({ git: { deploymentEnabled: false } }, null, 2)}\n`;

function git(args, opts = {}) {
  return spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts });
}

// Reads `path`'s content from the tip of `branch` on `origin`, without any checkout. Returns null if the
// branch doesn't exist yet (first run) or the file isn't present on it. Only logs the fetch failure when
// it ISN'T the benign "branch doesn't exist yet" case (git's own "couldn't find remote ref" message) — an
// auth/network failure would otherwise look identical to a normal first run in routine transcripts.
export function readLogFromBranch({ cwd, branch, path }) {
  const fetch = git(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd });
  if (fetch.status !== 0) {
    const stderr = (fetch.stderr || '').trim();
    if (!/couldn't find remote ref/i.test(stderr)) {
      console.error(`log-branch: git fetch ${branch} failed (not just "doesn't exist yet"): ${stderr}`);
    }
    return null;
  }
  const show = git(['show', `origin/${branch}:${path}`], { cwd });
  return show.status === 0 ? show.stdout : null;
}

// Writes `content` to `path` on `branch`, creating the branch if it doesn't exist yet. Pure plumbing:
// hash-object (write a blob) → mktree (the file plus LOG_BRANCH_VERCEL_JSON) → commit-tree (parented on the branch's
// current tip, if any) → push the new commit straight to the branch ref. Returns true on success.
//
// `path` MUST be a flat filename (no `/`) — `git mktree` builds a single-level tree, and a slash needs a
// nested subtree this function doesn't build. Passing a nested path fails loud (logged below), not
// silently — confirmed live: an earlier version swallowed git's stderr entirely, turning "path contains
// slash" (a one-line, obvious fix) into an unexplained `false`.
export function writeLogToBranch({ cwd, branch, path, content, message }) {
  if (path.includes('/')) {
    console.error(
      `log-branch: writeLogToBranch path "${path}" must be a flat filename (no "/") — git mktree only builds single-level trees.`
    );
    return false;
  }

  git(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd }); // best-effort; branch may not exist yet

  const hashObj = git(['hash-object', '-w', '--stdin'], { cwd, input: content });
  if (hashObj.status !== 0) {
    console.error(`log-branch: git hash-object failed: ${(hashObj.stderr || '').trim()}`);
    return false;
  }
  const blobSha = hashObj.stdout.trim();

  let tree = `100644 blob ${blobSha}\t${path}\n`;
  if (path !== 'vercel.json') {
    const vercelObj = git(['hash-object', '-w', '--stdin'], { cwd, input: LOG_BRANCH_VERCEL_JSON });
    if (vercelObj.status !== 0) {
      console.error(`log-branch: git hash-object (vercel.json) failed: ${(vercelObj.stderr || '').trim()}`);
      return false;
    }
    tree += `100644 blob ${vercelObj.stdout.trim()}\tvercel.json\n`;
  }

  const mktree = git(['mktree'], { cwd, input: tree });
  if (mktree.status !== 0) {
    console.error(`log-branch: git mktree failed: ${(mktree.stderr || '').trim()}`);
    return false;
  }
  const treeSha = mktree.stdout.trim();

  const revParse = git(['rev-parse', '--verify', `origin/${branch}`], { cwd });
  const parent = revParse.status === 0 ? revParse.stdout.trim() : null;

  const commitArgs = ['commit-tree', treeSha, '-m', message];
  if (parent) commitArgs.push('-p', parent);
  const commitTree = git(commitArgs, { cwd });
  if (commitTree.status !== 0) {
    console.error(`log-branch: git commit-tree failed: ${(commitTree.stderr || '').trim()}`);
    return false;
  }
  const commitSha = commitTree.stdout.trim();

  const push = git(['push', 'origin', `${commitSha}:refs/heads/${branch}`], { cwd });
  if (push.status !== 0) {
    console.error(`log-branch: git push failed: ${(push.stderr || '').trim()}`);
    return false;
  }
  return true;
}

// Read-modify-write with a bounded retry-on-conflict: appends `line` to the file's current content,
// re-reading the branch's CURRENT tip fresh on each attempt. Without this, a concurrent write to the same
// branch between our read and our push (a non-fast-forward push failure) would silently drop this run's
// snapshot entirely — this system has no realistic concurrent-execution path today (nightly/weekly,
// single-fire cron triggers), but the fix is cheap and removes the risk outright rather than assuming it
// away. Returns true only if a write eventually succeeded.
export function appendLineToBranch({ cwd, branch, path, line, message, retries = 2 }) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const existing = readLogFromBranch({ cwd, branch, path }) || '';
    const updated = `${existing}${line}`;
    if (writeLogToBranch({ cwd, branch, path, content: updated, message })) return true;
    if (attempt < retries) {
      console.error(
        `log-branch: append attempt ${attempt + 1} failed for ${branch} — retrying with a fresh read.`
      );
    }
  }
  return false;
}
