// pre-commit-hook.test.mjs — the pre-commit hook's BUDGET and its wiring, tested against the real hook.
//
// The budget is the survival rule (.githooks/README.md): pre-commit < 2s, staged files only. A hook that
// breaks it gets disabled — someone sets core.hooksPath back — and then nothing it guards is guarded. In
// the project this template came from, pre-commit grew to 119.7 SECONDS per commit before anyone
// measured it. So the budget is a test, not a comment: build a throwaway repo from this template's own
// hook + scripts, stage a synthetic change, and time the hook the way git runs it.
//
// It also pins the other half of story 2.2: the root package.json's `prepare` script is what wires the
// hooks, so a fresh clone gets them from `npm install` with no manual step.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_MS = 2000;

// Hooks export GIT_DIR & friends; from a linked worktree they point at the REAL repo, and a fixture's
// `git init`/`git config` would then rewrite it. Strip them (same seal as pre-push-hook.test.mjs).
function sealedEnv() {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX']) delete env[k];
  return env;
}

const README = `---
status: in-progress
slug: sample
title: Sample
area: 09-platform-infra
risk: low
type: chore
phase: Building
sprints_total: 0
stories_total: 0
---

# Epic: Sample

> **Area:** 09 · Platform & Infra · **Risk:** Low · **Class:** Chore · **Scope seed:** [\`00-ideas/seeds/sample.md\`](../../00-ideas/seeds/sample.md)

## Why
Reason.

## Definition of Done (epic)
- [ ] Done.
`;

function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'precommit-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: sealedEnv() }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  mkdirSync(join(dir, '.githooks'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join(TEMPLATE, '.githooks', 'pre-commit'), join(dir, '.githooks', 'pre-commit'));
  // Every lib module, not a hand list: a hand list breaks each time the closure grows (LEARNINGS, board-sinks-and-scrumban).
  const libs = readdirSync(join(TEMPLATE, 'scripts', 'lib'))
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .map((f) => `lib/${f}`);
  for (const f of ['doc-format.mjs', 'roadmap-extract.mjs', 'roadmap-push.mjs', 'doc-format.enforced.json', ...libs]) {
    copyFileSync(join(TEMPLATE, 'scripts', f), join(dir, 'scripts', f));
  }
  mkdirSync(join(dir, 'Roadmap', '00-ideas', 'seeds'), { recursive: true });
  writeFileSync(join(dir, 'Roadmap', '00-ideas', 'seeds', 'sample.md'), '---\nstatus: ready\n---\n# Sample\n');
  mkdirSync(join(dir, 'Roadmap', '09-platform-infra', 'sample'), { recursive: true });
  return { dir, git };
}

function runHook(dir) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync('sh', ['.githooks/pre-commit'], { cwd: dir, encoding: 'utf8', env: sealedEnv() });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

test('pre-commit: a staged canonical epic doc passes, inside the 2s budget', () => {
  const { dir, git } = fixtureRepo();
  writeFileSync(join(dir, 'Roadmap', '09-platform-infra', 'sample', 'README.md'), README);
  git('add', '-A');
  const r = runHook(dir);
  assert.equal(r.code, 0, `a canonical doc was blocked:\n${r.out}`);
  assert.match(r.out, /1 staged doc\(s\) clean/, 'the doc-format check must actually have run');
  assert.ok(r.ms < BUDGET_MS, `pre-commit took ${Math.round(r.ms)}ms — over its ${BUDGET_MS}ms budget`);
  rmSync(dir, { recursive: true, force: true });
});

test('pre-commit: a staged doc that drifted from the template BLOCKS the commit (the guard guards)', () => {
  const { dir, git } = fixtureRepo();
  writeFileSync(join(dir, 'Roadmap', '09-platform-infra', 'sample', 'README.md'), README.replace('## Definition of Done (epic)', '## Epic Definition of Done'));
  git('add', '-A');
  const r = runHook(dir);
  assert.equal(r.code, 1, `a drifted doc was not blocked:\n${r.out}`);
  assert.match(r.out, /dod-heading-legacy/);
  rmSync(dir, { recursive: true, force: true });
});

test('pre-commit: a commit with no Roadmap docs pays nothing', () => {
  const { dir, git } = fixtureRepo();
  writeFileSync(join(dir, 'notes.txt'), 'x\n');
  git('add', 'notes.txt');
  const r = runHook(dir);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /doc-format/);
  rmSync(dir, { recursive: true, force: true });
});

test('package.json: `prepare` wires core.hooksPath, so a fresh clone gets the hooks from npm install', () => {
  const pkg = JSON.parse(readFileSync(join(TEMPLATE, 'package.json'), 'utf8'));
  // Guarded: outside a git checkout (a Docker `COPY package.json && npm ci`, a tarball install) a bare
  // `git config` exits 128 and fails the whole install. Found by the fresh reviewer on PR #21.
  assert.match(pkg.scripts?.prepare, /git rev-parse --git-dir .*&& git config core\.hooksPath \.githooks \|\| true/);
  const noRepo = mkdtempSync(join(tmpdir(), 'no-git-'));
  execFileSync('sh', ['-c', pkg.scripts.prepare], { cwd: noRepo, env: { ...sealedEnv(), GIT_CEILING_DIRECTORIES: tmpdir() } });
  // Run the script's command the way npm would, in a fresh repo, and read the result back.
  const { dir, git } = fixtureRepo();
  execFileSync('sh', ['-c', pkg.scripts.prepare], { cwd: dir, env: sealedEnv() });
  assert.equal(git('config', 'core.hooksPath'), '.githooks');
  rmSync(dir, { recursive: true, force: true });
});

// "Green on today's known state, red on anything new" (build-visualization-claude-mods S2): a doc that was
// already committed with drift can be touched without sweeping it — only what the commit INTRODUCES blocks.
test('pre-commit: a touched legacy doc passes on its pre-existing drift, and blocks on new drift', () => {
  const { dir, git } = fixtureRepo();
  const path = join(dir, 'Roadmap', '09-platform-infra', 'sample', 'README.md');
  const legacy = README.replace('## Definition of Done (epic)', '## Epic Definition of Done');
  writeFileSync(path, legacy);
  git('add', '-A');
  git('commit', '-qm', 'legacy doc, committed before the hook existed');

  writeFileSync(path, legacy.replace('Reason.', 'Reason, now with more words.'));
  git('add', '-A');
  const touched = runHook(dir);
  assert.equal(touched.code, 0, `pre-existing drift blocked an unrelated edit:\n${touched.out}`);
  assert.match(touched.out, /1 pre-existing finding\(s\) in the staged docs were already committed/);

  writeFileSync(path, legacy.replace('**Class:** Chore', '**Class:** Something else'));
  git('add', '-A');
  const drifted = runHook(dir);
  assert.equal(drifted.code, 1, `new drift in a legacy doc was not blocked:\n${drifted.out}`);
  assert.match(drifted.out, /header-class-invalid/);
  assert.doesNotMatch(drifted.out, /\[dod-heading-legacy\]/, 'the pre-existing finding is not re-blamed on this commit');
  rmSync(dir, { recursive: true, force: true });
});
