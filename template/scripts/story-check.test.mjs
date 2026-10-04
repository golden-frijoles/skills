// story-check.test.mjs — the commit-msg story check (live-build-view S2.1, D7/D8).
// The decision (storyCheck) is pure over the epic's docs, so most cases need only a Roadmap/ on disk; the last test
// commits through the REAL hook in a sealed fixture repo, which is what proves the wiring and the < 2 s budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storyCheck, storyCheckMessage, storyIdsIn, storyIdsInWithContinuations } from './build-state.mjs';
import { subjectOf } from './story-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const README = `---
status: in-progress
slug: arranged-only
title: Arranged-only delivery
area: 04-shipping
risk: high
type: feature
phase: Building
sprints_total: 2
stories_total: 4
---
# Epic: Arranged-only delivery
`;
const SPRINT = (n, ids) => `---
epic: arranged-only
sprint: ${n}
title: Sprint ${n}
risk: high
phase: Building
stories_total: ${ids.length}
stories:
${ids.map((id) => `  - id: ${id}\n    title: Story ${id}\n    risk: low\n    status: planned`).join('\n')}
---
# Sprint ${n}
`;

function roadmap() {
  const root = mkdtempSync(join(tmpdir(), 'story-check-'));
  const dir = join(root, 'Roadmap', '04-shipping', 'arranged-only');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), README);
  writeFileSync(join(dir, 'sprint-1.md'), SPRINT(1, ['S1.1', 'S1.2']));
  writeFileSync(join(dir, 'sprint-2.md'), SPRINT(2, ['S2.1', 'S2.2']));
  mkdirSync(join(root, 'Roadmap', '00-ideas', 'seeds'), { recursive: true });
  writeFileSync(
    join(root, 'Roadmap', '00-ideas', 'seeds', 'tidy-up.md'),
    '---\ntitle: Tidy up\ntype: chore\nstatus: ready\n---\n'
  );
  return root;
}
const ROOT = roadmap();
const check = (branch, subject, env = {}) => storyCheck({ root: ROOT, branch, subject, env });

test('continuations: a list or range names every id in it; storyIdsIn (the view D2 rule) is unchanged', () => {
  assert.deepEqual(storyIdsInWithContinuations('feat(x): S1.1/1.2 two'), ['S1.1', 'S1.2']);
  assert.deepEqual(storyIdsInWithContinuations('feat: S2.2-2.4 three'), ['S2.2', 'S2.4']);
  assert.deepEqual(storyIdsInWithContinuations('fix: Story 2.2/2.4 removed'), ['S2.2', 'S2.4']);
  assert.deepEqual(storyIdsInWithContinuations('S1.1, 1.3 and 1.4'), ['S1.1', 'S1.3', 'S1.4']);
  assert.deepEqual(storyIdsInWithContinuations('feat: S1.1 bump to 0.25.0'), ['S1.1']);
  assert.deepEqual(storyIdsIn('S1.1/1.2'), ['S1.1']);
});

test('one story of this epic passes, on the epic branch and on its sprint branch', () => {
  assert.equal(check('feat/arranged-only', 'feat(x): S1.2 one story').ok, true);
  assert.equal(check('feat/arranged-only-s2', 'fix(x): S2.1 one story').ok, true);
  assert.equal(check('feat/arranged-only-s2-extra-words', 'perf: Story 2.2 faster').ok, true);
});

test('refused: no story, two stories, another sprint, an id the epic does not list', () => {
  const none = check('feat/arranged-only', 'feat(x): no story');
  assert.equal(none.ok, false);
  assert.match(none.why, /names no story/);
  assert.deepEqual(
    none.valid.map((s) => s.id),
    ['S1.1', 'S1.2', 'S2.1', 'S2.2']
  );
  assert.equal(check('feat/arranged-only', 'feat(x): S1.1/1.2 two').ok, false);
  assert.match(check('feat/arranged-only', 'feat(x): S1.1 and S2.1').why, /names 2 stories/);
  const other = check('feat/arranged-only-s2', 'feat(x): S1.1 last sprint');
  assert.equal(other.ok, false);
  assert.match(other.why, /S1\.1 is not a story of epic arranged-only, sprint 2/);
  assert.deepEqual(
    other.valid.map((s) => s.id),
    ['S2.1', 'S2.2']
  );
  assert.match(check('feat/arranged-only', 'refactor: S9.9 stranger').why, /S9\.9 is not a story/);
  assert.equal(
    check('feat/arranged-only', 'untyped subject with no story').ok,
    false,
    'untyped is gated, not a bypass'
  );
  // #241 review: a version number or a count is not a second story; a bare id the epic does not list is prose.
  for (const s of [
    'feat(x): S2.1, 2.1.288 bump',
    'feat(x): S2.1 + 0.26.0 release',
    'feat(x): S2.1 and 2.0 support',
    'feat(x): S2.1, 3.4 GB budget',
  ])
    assert.equal(check('feat/arranged-only-s2', s).ok, true, s);
  assert.equal(
    check('feat/arranged-only-s2', 'feat(x): S2.1 & 2.2').ok,
    false,
    'a listed bare id still counts'
  );
  assert.equal(
    check('feat/arranged-only-s2', 'feat(x): finish S2.1.').ok,
    true,
    "a sentence's full stop ends the id"
  );
  assert.equal(
    check('feat/arranged-only-s2', 'feat(x): S2.1, S2.2.').ok,
    false,
    'a full stop never hides the second id'
  );
  assert.equal(check('feat/arranged-only-s2', 'feat(x): S2.1/2.2.').ok, false);
  assert.equal(check('feat/arranged-only-s2', 'feat(x): S2.1: the hook').ok, true);
  assert.equal(
    check('feat/arranged-only-s2', 'feat(x): S2.1 and S9.9').ok,
    false,
    'an S-spelled stranger still counts'
  );
});

test('passes untouched: exempt types, merges, reverts, fixups, non-epic branches, the bypass', () => {
  for (const type of ['docs', 'chore', 'test', 'ci', 'build', 'style'])
    assert.equal(check('feat/arranged-only', `${type}(x): no story`).ok, true, type);
  assert.equal(check('feat/arranged-only', 'docs:typo').ok, true, 'a type without the space after the colon');
  for (const s of [
    "Merge branch 'main' into feat/arranged-only",
    'Revert "feat(x): S1.1 y"',
    'fixup! feat: x',
    'squash! x',
    'amend! x',
    'Squashed commit of the following:',
  ])
    assert.equal(check('feat/arranged-only', s).ok, true, s);
  assert.equal(check('main', 'feat: no story').ok, true);
  assert.equal(check('feat/not-an-epic', 'feat: no story').ok, true);
  assert.equal(check('chore/tidy-up', 'feat: no story').ok, true, 'a seed branch is not an epic');
  assert.equal(check(null, 'feat: no story').ok, true, 'detached HEAD');
  const bypass = check('feat/arranged-only', 'feat: no story', { GF_SKIP_STORY_CHECK: '1' });
  assert.deepEqual(bypass, { ok: true, why: 'GF_SKIP_STORY_CHECK=1' });
  assert.equal(check('feat/arranged-only', 'feat: no story', { GF_SKIP_STORY_CHECK: '0' }).ok, false);
});

test('the refusal names the valid ids and the bypass', () => {
  const msg = storyCheckMessage(check('feat/arranged-only-s2', 'feat: nothing'), 'feat/arranged-only-s2');
  assert.match(msg, /S2\.1 {2}Story S2\.1/);
  assert.doesNotMatch(msg, /S1\.1/);
  assert.match(msg, /GF_SKIP_STORY_CHECK=1 git commit/);
});

test('subjectOf: the first non-comment line, as git records it', () => {
  assert.equal(subjectOf('# Please enter\n\nfeat: S1.1 x\n\nbody'), 'feat: S1.1 x');
  assert.equal(subjectOf(''), '');
});

// Sealed like build-state.test.mjs: git exports GIT_DIR into hooks, and an unsealed fixture once rewrote a real repo.
const SEAL = [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX',
];
function sealedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of SEAL) delete env[k];
  return env;
}

test('through the real hook: a fixture repo refuses, accepts, and stays inside the pre-commit budget', () => {
  const root = roadmap();
  const git = (...a) =>
    execFileSync('git', a, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sealedEnv(),
    });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(root, '.githooks'), { recursive: true });
  // The hook runs the repo's own scripts/: copy the closure build-state.mjs imports (from disk — an uncommitted file
  // must count, or this test would pass on the hook's fail-open path when story-check.mjs is missing).
  for (const f of ['build-state.mjs', 'story-check.mjs', 'roadmap-extract.mjs', 'roadmap-push.mjs'])
    copyFileSync(join(HERE, f), join(root, 'scripts', f));
  cpSync(join(HERE, 'lib'), join(root, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join(HERE, '..', '.githooks', 'commit-msg'), join(root, '.githooks', 'commit-msg'));
  chmodSync(join(root, '.githooks', 'commit-msg'), 0o755);
  git('config', 'core.hooksPath', '.githooks');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: seed');
  git('switch', '-q', '-c', 'feat/arranged-only-s2');
  const commit = (subject, env = {}) => {
    const t0 = Date.now();
    const r = spawnSync('git', ['commit', '--allow-empty', '-q', '-m', subject], {
      cwd: root,
      encoding: 'utf8',
      env: sealedEnv(env),
    });
    return { status: r.status, stderr: r.stderr, ms: Date.now() - t0 };
  };
  const refused = commit('feat(x): no story');
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /S2\.1/);
  assert.equal(commit('feat(x): S2.1/2.2 two').status, 1);
  assert.equal(commit('docs(x): notes').status, 0);
  const ok = commit('feat(x): S2.1 one story');
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(ok.ms < 2000, `the hook took ${ok.ms} ms (budget 2000)`);
  assert.equal(commit('feat(x): nothing', { GF_SKIP_STORY_CHECK: '1' }).status, 0);
  // Fail open: a closure the resolver cannot load must never refuse every commit (found building this — the first
  // fixture lacked roadmap-push.mjs and even `chore: seed` was refused by node's crash).
  rmSync(join(root, 'scripts', 'roadmap-push.mjs'));
  const open = commit('feat(x): no story');
  assert.equal(open.status, 0, open.stderr);
  assert.match(open.stderr, /story check skipped — scripts\/build-state\.mjs could not load/);
});
