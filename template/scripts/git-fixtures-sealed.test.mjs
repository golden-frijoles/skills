// git-fixtures-sealed.test.mjs — every spec that builds a git fixture must seal it against the real repo.
//
// git exports GIT_DIR (and friends) into hooks; from a LINKED WORKTREE they point at the real repository's
// gitdir, and GIT_DIR overrides `cwd`. A fixture that runs `git init` / `git config user.*` / `git commit`
// in a temp dir therefore rewrites the REAL repo when the suite runs from a pre-push hook: `core.bare` flips
// to true (every checkout stops working), the identity becomes `t <t@t>`, fixture commits land on real refs.
// It happened three times before this check existed — 2026-09-09 (a sibling project), 2026-09-16 (the origin
// project, pre-push-hook.test.mjs) and 2026-09-23 (a consumer, build-state.test.mjs) — each time fixed in
// the one file that bit, never as a class. This is the class: a spec that spawns `git init` must also strip
// the GIT_* environment (the `sealedEnv()` pattern). Static and cheap; it reads files, it runs no git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const specsIn = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.test.mjs'))
        .map((f) => join(dir, f))
    : [];
const specs = [...specsIn(here), ...specsIn(join(here, 'lib'))];

/** Does this source build a git repository in a fixture? (`git('init'` / `['init'` passed to git.) */
// The optional leading identifier is the cwd-first helper shape, `git(root, 'init', …)` — the one that
// slipped past this guard and flipped core.bare on 2026-10-06 (scripts/lib/log-branch.test.mjs).
export const initsRepo = (src) =>
  /\bgit\w*\(\s*(?:[\w.]+\s*,\s*)?['"]init['"]|['"]git['"]\s*,\s*\[\s*['"]init['"]/.test(src);
/** Does it seal the environment it hands git? Either the named pattern or a GIT_DIR deletion. */
export const sealsEnv = (src) =>
  /sealedEnv\s*\(|GIT_ENV_TO_CLEAR|delete\s+env\[\s*['"]GIT_DIR['"]\s*\]/.test(src);

test('the detector sees the shapes it must see', () => {
  assert.equal(initsRepo("git('init', '-q')"), true);
  assert.equal(initsRepo("execFileSync('git', ['init', '-q'])"), true);
  assert.equal(initsRepo("git(root, 'init', '-q', '--bare', origin)"), true);
  assert.equal(initsRepo("const x = 'init';"), false);
  assert.equal(sealsEnv('env: sealedEnv()'), true);
  assert.equal(sealsEnv('env: { ...process.env }'), false);
});

test('every spec that runs `git init` seals GIT_DIR and friends out of its environment', () => {
  const unsealed = specs
    .filter((p) => !p.endsWith('git-fixtures-sealed.test.mjs'))
    .filter((p) => {
      const src = readFileSync(p, 'utf8');
      return initsRepo(src) && !sealsEnv(src);
    });
  assert.deepEqual(
    unsealed.map((p) => p.slice(here.length + 1)),
    [],
    'these specs build a git fixture without sealing GIT_DIR — from a worktree hook they rewrite the real repo'
  );
});
