#!/usr/bin/env node
// story-check.mjs — the commit-msg check: on an epic branch, a feat/fix/perf/refactor commit names exactly ONE story
// (live-build-view S2.1). Called by `.githooks/commit-msg` with git's message file:
//
//   node scripts/story-check.mjs .git/COMMIT_EDITMSG       # exit 0 pass, 1 refused
//   GF_SKIP_STORY_CHECK=1 git commit …                     # the bypass: the commit goes through, nothing else changes
//
// The decision is `storyCheck()` in build-state.mjs — beside the resolver it must agree with, reading the branch through
// the same resolveTarget (no second parser). This file only reads the message and the branch, and prints the verdict.
// It fails OPEN: anything it cannot read (no git, no roadmap) lets the commit through — a broken check must not block
// work, and CI still reads every commit the band reads.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// git exports GIT_DIR (and friends) into hooks; they would point the calls below at the hook's repository however
// `cwd` is set. The hook runs at the worktree top, so plain `git` from here is the repository being committed to.
const GIT_ENV_TO_CLEAR = [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
];
function git(args) {
  const env = { ...process.env };
  for (const k of GIT_ENV_TO_CLEAR) delete env[k];
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env }).trim();
  } catch {
    return null;
  }
}

/** The subject git will record: the first line that is neither blank nor a `#` comment. */
export function subjectOf(message) {
  return (
    String(message || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#')) ?? ''
  );
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('story-check: usage: node scripts/story-check.mjs <commit message file>\n');
    process.exit(2);
  }
  let message;
  try {
    message = readFileSync(file, 'utf8');
  } catch {
    process.exit(0); // no message to read — nothing to judge
  }
  const root = git(['rev-parse', '--show-toplevel']);
  if (!root) process.exit(0);
  const branch = git(['symbolic-ref', '-q', '--short', 'HEAD']);
  // Imported HERE, not at the top: a repo whose copy of the resolver's closure is incomplete (a file it imports is
  // missing) must not have every commit refused by a crash — the check fails open and says why, once per commit.
  let mod;
  try {
    mod = await import('./build-state.mjs');
  } catch (err) {
    process.stderr.write(
      `commit-msg: story check skipped — scripts/build-state.mjs could not load (${String(err?.message ?? err).split('\n')[0]})\n`
    );
    process.exit(0);
  }
  const { storyCheck, storyCheckMessage } = mod;
  const verdict = storyCheck({ root, branch, subject: subjectOf(message), env: process.env });
  if (verdict.ok) process.exit(0);
  process.stderr.write(`${storyCheckMessage(verdict, branch)}\n`);
  process.exit(1);
}

const isMain = (() => {
  try {
    return (
      !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (isMain) await main();
