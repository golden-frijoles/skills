// kit-tarball.test.mjs — the PUBLISHED shape works: pack the kit, install it into a stranger's repo, run it
// from a subdirectory, and it writes THAT repo's files (golden-frijoles-plugin S2.1 QA, D2).
//
// It tests the tarball `npm publish` would upload, not the source tree, because "works from template/" and
// "works from node_modules/" are exactly the two modes D2 exists to reconcile. It SKIPS, loudly, when npm is
// absent — could not look is not a failure. Offline by construction: the kit has zero dependencies.
// Run: node --test scripts/kit-tarball.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { stageKit } from './build-kit.mjs';
import { OPTIMIZE_PATH } from './check-plugin-leaks.mjs';

// git exports GIT_DIR & co. into hooks, and from a worktree they point at the REAL repo (LEARNINGS, 2026-09-23).
function sealedEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
}

const npm = spawnSync('npm', ['--version'], { encoding: 'utf8' });
const hasNpm = !npm.error && npm.status === 0;

test('the packed kit, installed in a stranger repo, runs build-order from a subdir against that repo', { skip: !hasNpm && 'npm not found — could not look' }, () => {
  const kitDir = realpathSync(mkdtempSync(join(tmpdir(), 'kit-stage-')));
  stageKit(kitDir);
  const packDir = realpathSync(mkdtempSync(join(tmpdir(), 'kit-pack-')));
  const pack = spawnSync('npm', ['pack', '--pack-destination', packDir, kitDir], {
    encoding: 'utf8',
    env: sealedEnv(),
  });
  assert.equal(pack.status, 0, pack.stderr);
  const tgz = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  assert.ok(tgz, 'npm pack produced no tarball');

  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'kit-stranger-')));
  mkdirSync(join(repo, 'Roadmap', '00-ideas', 'seeds'), { recursive: true });
  mkdirSync(join(repo, 'apps', 'web', 'src'), { recursive: true });
  writeFileSync(
    join(repo, 'Roadmap', '00-ideas', 'seeds', 'a-seed.md'),
    '---\ntitle: "A seed"\nslug: a-seed\nstatus: raw\ntype: feature\nepic: null\n---\n# A seed\n'
  );
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'stranger', private: true }));
  const git = spawnSync('git', ['init', '-q'], { cwd: repo, env: sealedEnv() });
  assert.equal(git.status, 0, String(git.stderr));

  // Installed OUTSIDE the stranger repo, the way npx's cache is (~/.npm/_npx): a walk that started from the
  // package's own location instead of cwd would then find no project (fresh review of #45, nit 2).
  const tools = realpathSync(mkdtempSync(join(tmpdir(), 'kit-tools-')));
  const install = spawnSync('npm', ['install', '--offline', '--no-audit', '--no-fund', '--prefix', tools, join(packDir, tgz)], {
    encoding: 'utf8',
    env: sealedEnv(),
  });
  assert.equal(install.status, 0, install.stderr);

  const bin = join(tools, 'node_modules', '.bin', 'gf-kit');
  const run = spawnSync(bin, ['build-order'], { cwd: join(repo, 'apps', 'web', 'src'), encoding: 'utf8', env: sealedEnv() });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

  const board = join(repo, 'Roadmap', '00-ideas', 'BUILD-ORDER.md');
  assert.ok(existsSync(board), 'BUILD-ORDER.md was not written into the stranger repo');
  assert.match(readFileSync(board, 'utf8'), /\[A seed\]\(seeds\/a-seed\.md\)/, 'the board must list THIS repo’s seed');
  const pkgDir = join(tools, 'node_modules', '@golden-frijoles', 'kit');
  assert.equal(existsSync(join(pkgDir, 'Roadmap')), false, 'the kit wrote into its own package');
  assert.equal(existsSync(join(pkgDir, 'dist', 'Roadmap')), false, 'the kit wrote into its own dist/');
  assert.equal(existsSync(join(repo, 'scripts')), false, 'nothing may be copied into the stranger repo');

  const list = spawnSync(bin, ['--list'], { cwd: repo, encoding: 'utf8', env: sealedEnv() });
  assert.match(list.stdout, /^build-order$/m);

  // A RELATIVE --root must survive a script that spawns a sibling with `cwd: <project>` (fresh review of #45,
  // should-fix 1): build-order-sync's drift check is exactly that child. Commit a fresh board, then ask from the
  // parent directory. The right answer is "up to date"; the bug read the project at <project>/<project>.
  const git2 = (args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, env: sealedEnv() });
  assert.equal(git2(['add', '-A']).status, 0);
  assert.equal(git2(['commit', '-q', '-m', 'board']).status, 0);
  const sync = spawnSync(bin, ['--root', basename(repo), 'build-order-sync', '--dry-run'], {
    cwd: dirname(repo),
    encoding: 'utf8',
    env: sealedEnv(),
  });
  assert.equal(sync.status, 0, `${sync.stdout}\n${sync.stderr}`);
  assert.match(sync.stdout, /up to date/);

  const missing = spawnSync(bin, ['--root', join(repo, 'nope'), 'build-order'], { encoding: 'utf8', env: sealedEnv() });
  assert.equal(missing.status, 2, 'a --root that does not exist is refused, not guessed');
});

// compiled-prompts D9 + S1.4: the Jev questions are DATA the guards read at import time (not an import edge, so
// declared by hand), and `optimize/` is dev-only Python a plugin user must never receive. Both are properties of
// the TARBALL, so both are asserted on the packed file list — and the guards are loaded from the INSTALLED package,
// the one place a missing JSON would throw.

test('the packed kit carries the Jev question files and nothing from optimize/ or Python', { skip: !hasNpm && 'npm not found — could not look' }, () => {
  const kitDir = realpathSync(mkdtempSync(join(tmpdir(), 'kit-stage-')));
  stageKit(kitDir);
  const packDir = realpathSync(mkdtempSync(join(tmpdir(), 'kit-pack-')));
  const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', packDir, kitDir], { encoding: 'utf8', env: sealedEnv() });
  assert.equal(pack.status, 0, pack.stderr);
  const files = JSON.parse(pack.stdout)[0].files.map((f) => f.path);
  for (const f of ['lib/jev-questions.mjs', 'lib/jev-questions/review.json', 'lib/jev-questions/prose.json', 'lib/jev-questions/intent.json'])
    assert.ok(files.includes(`dist/${f}`), `the packed kit lacks dist/${f}`);
  assert.deepEqual(files.filter((f) => OPTIMIZE_PATH.test(f)), [], 'optimize/ or Python reached the kit');

  const tools = realpathSync(mkdtempSync(join(tmpdir(), 'kit-tools-')));
  const tgz = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  const install = spawnSync('npm', ['install', '--offline', '--no-audit', '--no-fund', '--prefix', tools, join(packDir, tgz)], { encoding: 'utf8', env: sealedEnv() });
  assert.equal(install.status, 0, install.stderr);
  const lib = join(tools, 'node_modules', '@golden-frijoles', 'kit', 'dist', 'lib');
  const load = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `const p = await import(${JSON.stringify(join(lib, 'prose-guard.mjs'))}); const r = await import(${JSON.stringify(join(lib, 'review-guard.mjs'))}); console.log(p.PROSE_FAMILIES.length, Object.keys(r.REVIEW_QUESTIONS).join())`],
    { encoding: 'utf8', env: sealedEnv() }
  );
  assert.equal(load.status, 0, load.stderr);
  assert.equal(load.stdout.trim(), '4 is_real_review,severity');
});

test('OPTIMIZE_PATH names the paths a Python workspace would leave, and not the kit\'s own names', () => {
  for (const bad of ['dist/optimize/refit.py', 'optimize/README.md', 'dist/x.py', 'dist/x.pyc', 'dist/requirements.lock'])
    assert.ok(OPTIMIZE_PATH.test(bad), bad);
  for (const ok of ['dist/lib/jev-questions/prose.json', 'dist/jev-eval.mjs', 'dist/optimizer-notes.md'])
    assert.ok(!OPTIMIZE_PATH.test(ok), ok);
});

// distribute-what-we-use S2.1: the kickoff's review/session commands run from the PACKED kit, not a
// source checkout. PATH holds only node and HOME is blank, so no gh or reviewer CLI can accidentally make
// the happy path pass. A missing observation must render DARK / could-not-look, never a stack trace.
test('the packed kit degrades review routing and session resume without gh or reviewer CLIs', { skip: !hasNpm && 'npm not found — could not look' }, () => {
  const kitDir = realpathSync(mkdtempSync(join(tmpdir(), 'kit-stage-review-')));
  stageKit(kitDir);
  const packDir = realpathSync(mkdtempSync(join(tmpdir(), 'kit-pack-review-')));
  const pack = spawnSync('npm', ['pack', '--pack-destination', packDir, kitDir], { encoding: 'utf8', env: sealedEnv() });
  assert.equal(pack.status, 0, pack.stderr);
  const tgz = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  assert.ok(tgz, 'npm pack produced no tarball');

  const tools = realpathSync(mkdtempSync(join(tmpdir(), 'kit-tools-review-')));
  const install = spawnSync(
    'npm',
    ['install', '--offline', '--no-audit', '--no-fund', '--prefix', tools, join(packDir, tgz)],
    { encoding: 'utf8', env: sealedEnv() }
  );
  assert.equal(install.status, 0, install.stderr);

  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'kit-stranger-review-')));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'stranger-review', private: true }));
  // A project section must beat dist/review-config.json: this proves the installed reader still finds the
  // project's config while its fallback prompt/config assets are loaded from dist/ beside the scripts.
  writeFileSync(
    join(repo, 'golden-frijoles.config.json'),
    JSON.stringify({ review: { reviewScope: 'security-paths-only', securityPaths: ['src/**'] } })
  );
  const isolatedHome = realpathSync(mkdtempSync(join(tmpdir(), 'kit-home-review-')));
  // A bin dir holding ONLY node: node's own directory is not enough — under nvm it also holds globally
  // installed CLIs (codex, claude), and the DARK state would then go unproven (#189 review).
  const onlyNode = realpathSync(mkdtempSync(join(tmpdir(), 'kit-bin-review-')));
  symlinkSync(process.execPath, join(onlyNode, 'node'));
  const noCliEnv = { ...sealedEnv(), HOME: isolatedHome, PATH: onlyNode };
  const pkgDir = join(tools, 'node_modules', '@golden-frijoles', 'kit');

  const review = spawnSync(process.execPath, [join(pkgDir, 'dist', 'review-route.mjs'), '--builder', 'claude', '1'], {
    cwd: repo,
    encoding: 'utf8',
    env: noCliEnv,
  });
  const reviewOutput = `${review.stdout}\n${review.stderr}`;
  assert.equal(review.status, 0, reviewOutput);
  assert.match(reviewOutput, /could not look/i);
  // No reviewer CLI is on PATH, so the layer must be reported DARK — not merely the gh message.
  assert.match(reviewOutput, /NONE AVAILABLE|DARK/);
  assert.match(reviewOutput, /install GitHub CLI/);
  assert.match(reviewOutput, /review scope:\s+security-paths-only/);
  assert.doesNotMatch(reviewOutput, /^ {4}at /m);

  const resume = spawnSync(process.execPath, [join(pkgDir, 'dist', 'session-resume.mjs'), '--root', repo], {
    cwd: repo,
    encoding: 'utf8',
    env: noCliEnv,
  });
  const resumeOutput = `${resume.stdout}\n${resume.stderr}`;
  assert.equal(resume.status, 0, resumeOutput);
  assert.match(resumeOutput, /Degraded sources/i);
  assert.doesNotMatch(resumeOutput, /^ {4}at /m);
});

// golden-frijoles-plugin S3.2: `gf-kit init` adopts a repo that has NOTHING yet — no Roadmap/, no .git even,
// the true "stranger pasted the prompt into an empty folder" case the epic's whole promise rests on.
test('the packed kit runs `gf-kit init` in an EMPTY temp repo and writes the Roadmap/ skeleton, nothing else', { skip: !hasNpm && 'npm not found — could not look' }, () => {
  const kitDir = realpathSync(mkdtempSync(join(tmpdir(), 'kit-stage-init-')));
  stageKit(kitDir);
  const packDir = realpathSync(mkdtempSync(join(tmpdir(), 'kit-pack-init-')));
  const pack = spawnSync('npm', ['pack', '--pack-destination', packDir, kitDir], { encoding: 'utf8', env: sealedEnv() });
  assert.equal(pack.status, 0, pack.stderr);
  const tgz = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  assert.ok(tgz, 'npm pack produced no tarball');

  const tools = realpathSync(mkdtempSync(join(tmpdir(), 'kit-tools-init-')));
  const install = spawnSync(
    'npm',
    ['install', '--offline', '--no-audit', '--no-fund', '--prefix', tools, join(packDir, tgz)],
    { encoding: 'utf8', env: sealedEnv() }
  );
  assert.equal(install.status, 0, install.stderr);
  const bin = join(tools, 'node_modules', '.bin', 'gf-kit');

  // A truly empty folder — no Roadmap/, no .git, no package.json — the projectRoot() fallback for
  // "installed, and no marker directory found anywhere above cwd" (D2: falls back to cwd itself).
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'kit-stranger-empty-')));
  const run = spawnSync(bin, ['--root', repo, 'init'], { encoding: 'utf8', env: sealedEnv() });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /wrote Roadmap\/README\.md/);

  for (const rel of [
    'Roadmap/README.md',
    'Roadmap/WAYS-OF-WORKING.md',
    'Roadmap/LEARNINGS.md',
    'Roadmap/00-ideas/README.md',
    'Roadmap/00-ideas/seeds/.gitkeep',
    'Roadmap/00-ideas/audits/.gitkeep',
  ]) {
    assert.ok(existsSync(join(repo, rel)), `gf-kit init did not write ${rel}`);
  }
  assert.equal(existsSync(join(repo, 'scripts')), false, 'gf-kit init must not create a scripts/ dir');
  const pkgDir = join(tools, 'node_modules', '@golden-frijoles', 'kit');
  assert.equal(existsSync(join(pkgDir, 'dist', 'skeleton', 'Roadmap')), true, 'the kit must carry its own skeleton source');

  // Idempotent: a second run against the now-adopted repo skips every file, writes nothing new.
  const again = spawnSync(bin, ['--root', repo, 'init'], { encoding: 'utf8', env: sealedEnv() });
  assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
  assert.match(again.stdout, /skipped Roadmap\/README\.md \(exists\)/);
  assert.doesNotMatch(again.stdout, /^wrote /m);
});
