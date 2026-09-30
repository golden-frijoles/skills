// pre-push-hook.test.mjs — the SCOPE computation in .githooks/pre-push.
//
// Why this file exists: on 2026-08-25 the hook blocked `session-note.mjs` from appending to
// `claude/session-journal`. The hook derived its scope from the CHECKED-OUT BRANCH
// (`HEAD~1...HEAD`) while git was telling it, on stdin, that the ref being pushed was a log branch
// carrying one flat file. So a Roadmap-touching commit on `main` made it run `build-order --check`
// against the working tree, and a stale board — caused by ANOTHER agent's untracked file in this
// shared checkout — blocked the push. `session-note` fails soft by design, so the journal silently
// stopped recording the one thing that cannot be re-derived: intent.
//
// It stayed invisible because for an ordinary push of the checked-out branch the two agree. Only a
// push whose ref is NOT the current branch separates them — which is exactly what the log branches do.
//
// These tests run the real hook against a throwaway git repo built with plumbing: no network, no
// fixtures, and no dependence on this repo's own state.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '.githooks', 'pre-push');

// ⚠️ SEALED against the repository this file runs in. `.githooks/pre-push` runs this suite, and git
// exports GIT_DIR (and friends) into hooks — from a LINKED WORKTREE it points at the real repo's
// gitdir. GIT_DIR overrides `cwd`, so the fixture's `git init` / `git config user.*` below rewrote the
// REAL repository: on 2026-09-16 a worktree push flipped the origin project's `core.bare` to `true` (every
// agent's checkout stopped working) and replaced its user identity with `t <t@t>`. A sibling project hit
// the same leak on 2026-09-09 (design-coverage.test.mjs) and sealed it the same way.
const GIT_ENV_TO_CLEAR = [
  'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX',
];
export function sealedEnv(base = process.env) {
  const env = { ...base };
  for (const k of GIT_ENV_TO_CLEAR) delete env[k];
  return env;
}

// Builds a repo with two commits, the second touching exactly `path`. Returns both shas.
function repoTouching(path) {
  const dir = mkdtempSync(join(tmpdir(), 'prepush-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: sealedEnv() }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git('add', 'seed.txt'); git('commit', '-qm', 'seed');
  const before = git('rev-parse', 'HEAD');
  mkdirSync(join(dir, dirname(path)), { recursive: true });
  writeFileSync(join(dir, path), 'x\n');
  git('add', path); git('commit', '-qm', 'change');
  return { dir, before, after: git('rev-parse', 'HEAD') };
}

// Runs the hook the way git does: refs on stdin, cwd = the repo being pushed from.
function runHook({ dir, stdin }) {
  try {
    const out = execFileSync('sh', [HOOK, 'origin', 'https://example.invalid/x'], {
      cwd: dir, input: stdin, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: sealedEnv(),
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

test('pre-push: a log-branch push carrying one flat file runs NO gate', () => {
  // This is the session-journal shape: the pushed commit touches a flat log file and nothing else.
  const { dir, before, after } = repoTouching('session-journal.log');
  const r = runHook({ dir, stdin: `refs/heads/x ${after} refs/heads/claude/session-journal ${before}\n` });
  assert.equal(r.code, 0, `hook blocked a log push:\n${r.out}`);
  assert.doesNotMatch(r.out, /BUILD-ORDER/, 'the Roadmap gate must not fire for a log-only push');
  rmSync(dir, { recursive: true, force: true });
});

test('pre-push: a Roadmap-touching push DOES fire the board gate — the guard still guards', () => {
  // The negative control. Without it, the test above would pass just as well against a hook that
  // checks nothing at all, which is the failure this repo cares about most.
  const { dir, before, after } = repoTouching('Roadmap/00-ideas/seeds/x.md');
  const r = runHook({ dir, stdin: `refs/heads/main ${after} refs/heads/main ${before}\n` });
  assert.match(r.out, /BUILD-ORDER/, `the Roadmap gate did not fire:\n${r.out}`);
  assert.equal(r.code, 1, 'a failing board check must block the push');
  rmSync(dir, { recursive: true, force: true });
});

test('pre-push: scope comes from the PUSHED refs, not the checked-out branch', () => {
  // THE BUG ITSELF, in its real shape. The log branches are a SEPARATE lineage (log-branch.mjs builds
  // them with plumbing and pushes `<sha>:refs/heads/claude/<log>`), while the working tree sits on
  // `main` whose tip touches Roadmap/. A hook deriving scope from HEAD measures the Roadmap commit and
  // fires the board gate; a hook reading stdin measures the log range and stays quiet.
  //
  // The first draft of this test built the log commit ON TOP of main, so HEAD~1...HEAD was the log
  // file and the buggy fallback passed too — it proved nothing. The two lineages must be disjoint.
  const { dir, after } = repoTouching('Roadmap/00-ideas/seeds/x.md');   // main tip = a Roadmap commit
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: sealedEnv() }).trim();

  // An orphan log branch, exactly like claude/weekly-recap-log: its own root, one flat file.
  git('checkout', '-q', '--orphan', 'logs');
  git('rm', '-q', '-rf', '.');
  writeFileSync(join(dir, 'weekly-recaps.log'), 'one\n');
  git('add', 'weekly-recaps.log'); git('commit', '-qm', 'log 1');
  const logBefore = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'weekly-recaps.log'), 'one\ntwo\n');
  git('add', 'weekly-recaps.log'); git('commit', '-qm', 'log 2');
  const logAfter = git('rev-parse', 'HEAD');

  git('checkout', '-q', 'main');                                        // pushing FROM main, as the routines do
  assert.match(git('diff', '--name-only', 'HEAD~1...HEAD'), /Roadmap\//,
    'precondition: HEAD-derived scope must look like Roadmap, or this proves nothing');

  const r = runHook({ dir, stdin: `refs/heads/x ${logAfter} refs/heads/claude/weekly-recap-log ${logBefore}\n` });
  assert.equal(r.code, 0, `hook blocked a log push while sitting on a Roadmap commit:\n${r.out}`);
  assert.doesNotMatch(r.out, /BUILD-ORDER/, 'the Roadmap gate fired on a push carrying no Roadmap paths');
  assert.ok(after, 'sanity: fixture built');
  rmSync(dir, { recursive: true, force: true });
});

test('pre-push: a branch DELETION carries no paths and gates nothing', () => {
  const zero = '0'.repeat(40);
  const { dir, after } = repoTouching('Roadmap/00-ideas/seeds/x.md');
  const r = runHook({ dir, stdin: `refs/heads/x ${zero} refs/heads/gone ${after}\n` });
  assert.equal(r.code, 0, `a deletion must not be gated:\n${r.out}`);
  assert.doesNotMatch(r.out, /BUILD-ORDER/);
  rmSync(dir, { recursive: true, force: true });
});

// semantic-lint D5/C6. The stub is written AFTER the pushed commit and left untracked: the hook runs what is in the
// working tree, and keeping scripts/ out of the pushed range keeps the BLOCKING scripts/ tests out of scope, so the
// only thing that can fail here is the lint itself.
function withLintStub(dir) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(
    join(dir, 'scripts', 'semantic-lint.mjs'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('lint-args.json', JSON.stringify(process.argv.slice(2)));\nprocess.exit(3);\n"
  );
  return () => JSON.parse(readFileSync(join(dir, 'lint-args.json'), 'utf8'));
}

test('pre-push: semantic-lint gets exactly the pushed range, and a failing lint never fails the push', () => {
  const { dir, before, after } = repoTouching('apps/web/app/api/x/route.ts');
  const args = withLintStub(dir);
  const r = runHook({ dir, stdin: `refs/heads/x ${after} refs/heads/x ${before}\n` });
  assert.equal(r.code, 0, `a lint that exits 3 blocked the push:\n${r.out}`);
  assert.deepEqual(args(), ['--range', `${before}...${after}`]);
  rmSync(dir, { recursive: true, force: true });
});

test('pre-push: a NEW branch is linted from origin/main, the same range the gate uses', () => {
  const zero = '0'.repeat(40);
  const { dir, after } = repoTouching('apps/web/x.ts');
  const args = withLintStub(dir);
  assert.equal(runHook({ dir, stdin: `refs/heads/x ${after} refs/heads/x ${zero}\n` }).code, 0);
  assert.deepEqual(args(), ['--range', `origin/main...${after}`]);
  rmSync(dir, { recursive: true, force: true });
});

test('pre-push: a deletion-only push lints NOTHING — no fallback to a branch nobody pushed', () => {
  const zero = '0'.repeat(40);
  const { dir, after } = repoTouching('apps/web/x.ts');
  withLintStub(dir);
  assert.equal(runHook({ dir, stdin: `refs/heads/x ${zero} refs/heads/gone ${after}\n` }).code, 0);
  assert.throws(() => readFileSync(join(dir, 'lint-args.json')), /ENOENT/, 'the lint ran on a deletion-only push');
  rmSync(dir, { recursive: true, force: true });
});

test('sealedEnv strips every git location variable a hook exports (else fixtures rewrite the real repo)', () => {
  const env = sealedEnv({ GIT_DIR: '/real/.git/worktrees/x', GIT_INDEX_FILE: 'i', GIT_WORK_TREE: 'w', GIT_COMMON_DIR: 'c', PATH: '/bin' });
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) assert.equal(env[k], undefined, k);
  assert.equal(env.PATH, '/bin');
});
