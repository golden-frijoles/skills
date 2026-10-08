// init.test.mjs — `frijoles-kit init` writes the Roadmap skeleton and never overwrites (golden-frijoles-plugin S3.2).
// Run: node --test template/scripts/init.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { initSkeleton, isHomeDirectory, SKELETON, skeletonRoot } from './init.mjs';

// git exports GIT_DIR & co. into hooks, and from a worktree they point at the REAL repo (LEARNINGS, 2026-09-23).
function sealedEnv(overrides) {
  const env = { ...process.env, ...overrides };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
}

/** A skeleton "source" dir carrying each SKELETON path with distinctive, path-derived content. */
function sourceFixture(files = SKELETON) {
  const dir = mkdtempSync(join(tmpdir(), 'init-source-'));
  for (const rel of files) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), `source: ${rel}\n`);
  }
  return dir;
}

test('a fresh repo gets every skeleton file, byte-identical to the source', () => {
  const source = sourceFixture();
  const project = mkdtempSync(join(tmpdir(), 'init-fresh-'));
  const { wrote, skipped } = initSkeleton({ project, source });
  assert.deepEqual(wrote.sort(), [...SKELETON].sort());
  assert.deepEqual(skipped, []);
  for (const rel of SKELETON) {
    assert.equal(readFileSync(join(project, rel), 'utf8'), `source: ${rel}\n`);
  }
});

test('a partially-present repo gets only what is missing, and keeps what is already there', () => {
  const source = sourceFixture();
  const project = mkdtempSync(join(tmpdir(), 'init-partial-'));
  mkdirSync(join(project, 'Roadmap'), { recursive: true });
  writeFileSync(join(project, 'Roadmap', 'README.md'), 'the project’s own words, not the template’s\n');

  const { wrote, skipped } = initSkeleton({ project, source });
  assert.deepEqual(skipped, ['Roadmap/README.md']);
  assert.deepEqual(wrote.sort(), SKELETON.filter((f) => f !== 'Roadmap/README.md').sort());
  assert.equal(readFileSync(join(project, 'Roadmap', 'README.md'), 'utf8'), 'the project’s own words, not the template’s\n');
});

test('a fully-adopted repo: every file is skipped, nothing is written, exit is still success', () => {
  const source = sourceFixture();
  const project = mkdtempSync(join(tmpdir(), 'init-full-'));
  initSkeleton({ project, source }); // first pass writes everything
  const before = SKELETON.map((rel) => readFileSync(join(project, rel), 'utf8'));

  const { wrote, skipped } = initSkeleton({ project, source }); // second pass: idempotent
  assert.deepEqual(wrote, []);
  assert.deepEqual(skipped.sort(), [...SKELETON].sort());
  const after = SKELETON.map((rel) => readFileSync(join(project, rel), 'utf8'));
  assert.deepEqual(after, before, 'a re-run must not touch bytes it already skipped');
});

test('it is idempotent end to end: source A, then source B, keeps A’s bytes everywhere', () => {
  const sourceA = sourceFixture();
  const project = mkdtempSync(join(tmpdir(), 'init-idempotent-'));
  initSkeleton({ project, source: sourceA });

  const sourceB = mkdtempSync(join(tmpdir(), 'init-source-b-'));
  for (const rel of SKELETON) {
    mkdirSync(join(sourceB, rel, '..'), { recursive: true });
    writeFileSync(join(sourceB, rel), `DIFFERENT: ${rel}\n`);
  }
  const { wrote, skipped } = initSkeleton({ project, source: sourceB });
  assert.deepEqual(wrote, []);
  assert.deepEqual(skipped.sort(), [...SKELETON].sort());
  for (const rel of SKELETON) {
    assert.equal(readFileSync(join(project, rel), 'utf8'), `source: ${rel}\n`, `${rel} must keep its FIRST bytes`);
  }
});

test('skeletonRoot: installed mode reads from kitRoot()/skeleton, copied mode from kitRoot()/..', () => {
  assert.equal(skeletonRoot({ root: '/kit/dist', installed: true }), join('/kit/dist', 'skeleton'));
  assert.equal(skeletonRoot({ root: '/project/scripts', installed: false }), join('/project/scripts', '..'));
});

test('writes nothing outside Roadmap/', () => {
  const source = sourceFixture();
  const project = mkdtempSync(join(tmpdir(), 'init-scope-'));
  initSkeleton({ project, source });
  for (const rel of SKELETON) assert.ok(rel.startsWith('Roadmap/'), `${rel} is outside Roadmap/`);
  assert.equal(existsSync(join(project, 'scripts')), false, 'frijoles-kit init must not create a scripts/ dir');
});

// ── Cross-review of #47: copied mode's source can equal the destination ──────────────────────────
// `skeletonRoot()` in copied mode is `kitRoot()/..` — the SAME directory `projectRoot()` resolves to
// (exactly this repo's own dev checkout). Reproduced literally: one SKELETON file "deleted" from
// that shared directory used to make the copy throw ENOENT reading its own (also missing) source.
test('copied mode, source === destination: a file missing from the shared dir is skipped, never a crash', () => {
  const shared = mkdtempSync(join(tmpdir(), 'init-shared-'));
  const missing = 'Roadmap/00-ideas/seeds/.gitkeep';
  for (const rel of SKELETON) {
    if (rel === missing) continue; // the "deleted" file — absent from the shared dir entirely
    mkdirSync(join(shared, rel, '..'), { recursive: true });
    writeFileSync(join(shared, rel), `shared: ${rel}\n`);
  }
  const { wrote, skipped } = initSkeleton({ project: shared, source: shared });
  // Every file's source IS its destination here, so nothing is genuinely copyable — all skipped,
  // and critically, no throw.
  assert.deepEqual(wrote, []);
  assert.deepEqual(skipped.sort(), [...SKELETON].sort());
  assert.equal(existsSync(join(shared, missing)), false, 'a skip must not fabricate the missing file');
});

test('a source file that is genuinely absent (a different directory, not self-referential) is skipped', () => {
  const source = sourceFixture(SKELETON.filter((f) => f !== 'Roadmap/LEARNINGS.md'));
  const project = mkdtempSync(join(tmpdir(), 'init-missing-source-'));
  const { wrote, skipped } = initSkeleton({ project, source });
  assert.ok(skipped.includes('Roadmap/LEARNINGS.md'));
  assert.ok(!wrote.includes('Roadmap/LEARNINGS.md'));
  assert.equal(wrote.length, SKELETON.length - 1);
  assert.equal(existsSync(join(project, 'Roadmap/LEARNINGS.md')), false);
});

// ── Cross-review of #47: never write into $HOME ──────────────────────────────────────────────────
test('isHomeDirectory: true only when the resolved project root IS the home directory', () => {
  assert.equal(isHomeDirectory({ project: '/Users/someone', home: '/Users/someone' }), true);
  assert.equal(isHomeDirectory({ project: '/Users/someone/repo', home: '/Users/someone' }), false);
  assert.equal(isHomeDirectory({ project: '/Users/someone/', home: '/Users/someone' }), true);
  assert.equal(isHomeDirectory({ project: '/Users/someone', home: '/Users/other' }), false);
});

test('the CLI refuses (exit 2) rather than write Roadmap/ into $HOME', () => {
  const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'init-fakehome-')));
  const scriptPath = fileURLToPath(new URL('./init.mjs', import.meta.url));
  // GF_PROJECT_ROOT forces projectRoot() to resolve to exactly this dir — deterministic, without
  // depending on a real walk-up through an ancestor .git.
  const run = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: sealedEnv({ HOME: fakeHome, GF_PROJECT_ROOT: fakeHome }),
  });
  assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /refusing to run/);
  assert.equal(existsSync(join(fakeHome, 'Roadmap')), false, 'must not have written into $HOME');
});
