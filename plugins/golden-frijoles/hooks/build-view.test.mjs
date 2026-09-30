// build-view.test.mjs — the mod's pure half (build-visualization-claude-mods S4).
// The hook file itself is four calls on `$`; everything decidable without `$` is here, and tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import * as view from './build-view.mjs';

const { repoFactsFrom, shouldRefresh, statusTextFrom, MAX_AGE_MS } = view;

test('repoFactsFrom: branch@sha and the repo ROOT, else nulls', () => {
  assert.deepEqual(repoFactsFrom('abc123\nfeat/foo-s2\n/repo\n'), { key: 'feat/foo-s2@abc123', root: '/repo' });
  assert.deepEqual(repoFactsFrom('abc123\nfeat/foo-s2\n/repo\n', 128), { key: null, root: null }, 'a failed git');
  for (const bad of ['', 'abc123\n', null, undefined, '\n\n']) assert.equal(repoFactsFrom(bad).key, null, String(bad));
});

test('shouldRefresh: no cache, a moved branch/HEAD, or an aged view — otherwise the cache holds', () => {
  const now = 1_000_000;
  const fresh = { key: 'b@1', at: now - 1, text: 'lines' };
  assert.equal(shouldRefresh(fresh, 'b@1', now), false, 'a second turn on the same branch does no work');
  assert.equal(shouldRefresh(fresh, 'b@2', now), true, 'a commit refreshes it');
  assert.equal(shouldRefresh(fresh, 'other@1', now), true, 'a branch change refreshes it');
  assert.equal(shouldRefresh({ ...fresh, at: now - MAX_AGE_MS }, 'b@1', now), true, 'an aged view refreshes');
  assert.equal(shouldRefresh(undefined, 'b@1', now), true);
  assert.equal(shouldRefresh({ key: 'b@1', at: now, text: 42 }, 'b@1', now), true, 'a junk entry refreshes');
  // A FAILED resolve is cached like any other answer: a project with the plugin but no resolver must not
  // spawn a doomed `node` every turn (fresh reviewer, #32).
  const failed = { key: 'b@1', at: now - 1, text: null };
  assert.equal(shouldRefresh(failed, 'b@1', now), false, 'a cached failure holds for the window');
  assert.equal(shouldRefresh(failed, 'b@1', now + MAX_AGE_MS), true, 'and is retried after it');
  assert.equal(shouldRefresh(fresh, null, now), true, 'no key (git unreadable) always refreshes');
});

test('statusTextFrom: build-state’s OWN lines, joined — and nothing at all on any doubt', () => {
  const state = { lines: ['Currently building', '  Epic     X', '  Status   Building'] };
  assert.equal(statusTextFrom(JSON.stringify(state)), 'Currently building\n  Epic     X\n  Status   Building');
  assert.equal(statusTextFrom(JSON.stringify(state), 1), null, 'a non-zero exit renders nothing');
  assert.equal(statusTextFrom('not json'), null);
  assert.equal(statusTextFrom(JSON.stringify({ lines: [] })), null);
  assert.equal(statusTextFrom(JSON.stringify({ in_flight: false })), null);
  assert.equal(statusTextFrom(''), null);
});

test('the renderer invents nothing: the text is exactly the resolver’s lines', () => {
  const lines = ['No epic in flight — on main — not an epic branch (feat/<slug>…), so no epic in flight'];
  assert.equal(statusTextFrom(JSON.stringify({ in_flight: false, lines })), lines[0]);
});

test('the contract with the resolver holds: build-state.mjs really emits a `lines` array', () => {
  // The other tests pin a fixture; this one runs the REAL resolver, so renaming `lines` there cannot
  // leave this suite green while the view silently goes blank (fresh reviewer, #32).
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const stdout = execFileSync('node', [join(repo, 'scripts', 'build-state.mjs'), '--json', '--offline'], {
    cwd: repo,
    encoding: 'utf8',
  });
  const state = JSON.parse(stdout);
  assert.ok(Array.isArray(state.lines) && state.lines.length, 'build-state --json must carry a non-empty `lines`');
  assert.ok(state.lines.every((l) => typeof l === 'string'));
  assert.equal(statusTextFrom(stdout, 0), state.lines.join('\n'));
});

// ── D5: automatic behaviour never runs repo-supplied code (distribute-what-we-use S2.2) ──────────────
// The hook runs on every turn in whatever repo is open. It used to execute `<repo>/scripts/build-state.mjs`,
// a file any repo can own. It now always runs the copy bundled beside it, whether or not the repo has one.
const HERE = dirname(fileURLToPath(import.meta.url));

test('the resolver the hook runs is the bundled copy, never a file the open repo owns', () => {
  assert.equal(typeof view.buildStateArgv, 'function', 'build-view.mjs must export buildStateArgv');
  for (const root of ['/repo', '/some/stranger', null]) {
    const argv = view.buildStateArgv(root);
    assert.equal(argv[0], 'node');
    assert.equal(argv[1], join(HERE, 'vendor', 'build-state.mjs'));
    assert.ok(!argv.some((a) => /(^|\/)scripts\/build-state\.mjs$/.test(a)), `no repo scripts/ path in ${argv}`);
    assert.deepEqual(argv.slice(2), ['--json', '--offline', '--repo-root', root || '.']);
  }
});

test('index.ts builds its command from buildStateArgv, not from the repo root', () => {
  const src = readFileSync(join(HERE, 'index.ts'), 'utf8');
  assert.match(src, /buildStateArgv\(/);
  assert.doesNotMatch(src, /\/scripts\/build-state\.mjs/, 'the hook must not name a repo-relative resolver');
});

test('the bundle exists and is the real resolver: it emits `lines` for this repo', () => {
  const bundled = join(HERE, 'vendor', 'build-state.mjs');
  assert.ok(existsSync(bundled), 'run `node scripts/render-hook-vendor.mjs` from skills/');
  const repo = join(HERE, '..', '..', '..');
  const stdout = execFileSync('node', [bundled, '--json', '--offline', '--repo-root', repo], { encoding: 'utf8' });
  const state = JSON.parse(stdout);
  assert.ok(Array.isArray(state.lines) && state.lines.length);
});
