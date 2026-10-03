// build-view.test.mjs — the mod's pure half (build-visualization-claude-mods S4).
// The hook file only calls `$` and draws; everything decidable without `$` is here, and tested.
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

test('index.tsx builds its command from buildStateArgv, not from the repo root', () => {
  const src = readFileSync(join(HERE, 'index.tsx'), 'utf8');
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

// ── The band (fix/build-view-band): a status row cut the view off at the right edge and drew its newlines
// as U+FFFD. The band decorates the resolver's lines; these pin that it never adds or drops a fact.
const { bandRowsFrom, progressOf, toneOf } = view;

test('bandRowsFrom: one row per resolver line, every fact kept', () => {
  const lines = [
    'Currently building',
    '  Epic     Semantic lint — Jev judges    09-platform-infra · risk LOW',
    '  Story    S1.2 — the rule',
    '           As a PM, I want X, so that Y.',
    '  Progress Story 2 of 5 · Sprint 1 of 2',
    '  Status   Building',
    '  Also     1 more in other worktrees: feat/y',
  ];
  const rows = bandRowsFrom(lines.join('\n'));
  assert.equal(rows.length, lines.length);
  assert.deepEqual(rows.map((r) => r.kind), ['heading', 'field', 'field', 'note', 'field', 'field', 'field']);
  for (const [i, row] of rows.entries()) {
    const shown = row.kind === 'field' ? `${row.label} ${row.value}` : row.value;
    assert.equal(shown.replace(/\s+/g, ' '), lines[i].trim().replace(/\s+/g, ' '), `row ${i} is its line`);
  }
  assert.equal(rows[1].main, 'Semantic lint — Jev judges');
  assert.equal(rows[1].meta, '09-platform-infra · risk LOW');
  assert.equal(rows[1].risk, 'LOW');
  assert.equal(rows[5].tone, 'busy');
});

test('bandRowsFrom: the idle view, and nothing for no text', () => {
  const rows = bandRowsFrom('No epic in flight — on main\n  Open     X · Verifying · 09-platform-infra');
  assert.equal(rows[0].glyph, '◇');
  assert.equal(rows[1].label, 'Open');
  assert.equal(rows[1].tone, 'info');
  for (const none of [null, undefined, '', '  \n']) assert.deepEqual(bandRowsFrom(none), []);
});

test('progressOf / toneOf: colour and bar hints only', () => {
  assert.deepEqual(progressOf('Story 2 of 5 · Sprint 1 of 2'), { done: 1, total: 5 });
  assert.equal(progressOf('Story ? of 5'), null);
  assert.equal(toneOf('unknown — no README'), 'bad');
  assert.equal(toneOf('Shipped'), 'good');
  assert.equal(toneOf('Something else'), 'plain');
});

// ── attempt: the guard every `$.state` call goes through (fix/build-view-no-state-at-start) ─────────────
// On an engine without `$.state` (2.1.278), `$.state.get` throws SYNCHRONOUSLY (a TypeError on undefined), and a
// render hook that throws is skipped with an error line on every draw. These pin the guard itself; the engine
// cannot be made to drop its own `state` noun inside `claude plugin test`.
test('attempt resolves what fn resolves, and never calls onFail on success', async () => {
  let failed = 0;
  assert.deepEqual(await view.attempt(async () => ({ value: 'x', version: 1 }), () => failed++), { value: 'x', version: 1 });
  assert.equal(failed, 0);
});

test('attempt turns a SYNCHRONOUS throw (a missing noun) into the fallback and reports it', async () => {
  const state = undefined; // what 2.1.278 hands a hook as `$.state`
  const seen = [];
  const got = await view.attempt(() => state.get({}), (err) => seen.push(err));
  assert.equal(got, null);
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof TypeError);
});

test('attempt turns a rejection into the fallback, and a failing onFail cannot undo the guard', async () => {
  assert.equal(await view.attempt(() => Promise.reject(new Error('refused')), () => {}), null);
  assert.equal(
    await view.attempt(
      () => Promise.reject(new Error('refused')),
      () => {
        throw new Error('logger broke');
      },
      'fallback',
    ),
    'fallback',
  );
});

// ── finops S1.3 ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('finops 1.3: the Spend row is a field with the $ glyph, plain tone, words untouched', () => {
  const rows = view.bandRowsFrom('Currently building\n  Spend    ≈$38 · 1.9M tok · 4 sessions · this machine');
  assert.deepEqual(rows[1], {
    kind: 'field',
    glyph: '$',
    label: 'Spend',
    value: '≈$38 · 1.9M tok · 4 sessions · this machine',
    main: '≈$38 · 1.9M tok · 4 sessions · this machine',
    meta: null,
    risk: null,
    tone: 'plain',
  });
});

test('finops 1.3 (D24): the usage refresh runs the BUNDLED script, at most once a minute, only with a repo', () => {
  assert.deepEqual(view.epicActualsArgv('/r', '/plugin/vendor/epic-actuals.mjs'), [
    'node',
    '/plugin/vendor/epic-actuals.mjs',
    '--refresh',
    '--repo-root',
    '/r',
  ]);
  assert.match(view.VENDOR_EPIC_ACTUALS, /hooks\/vendor\/epic-actuals\.mjs$/);
  assert.equal(existsSync(view.VENDOR_EPIC_ACTUALS), true, 'the bundle carries it');
  assert.equal(view.shouldRefreshUsage(null, '/r', 1_000_000), true);
  assert.equal(view.shouldRefreshUsage(1_000_000 - 30_000, '/r', 1_000_000), false);
  assert.equal(view.shouldRefreshUsage(1_000_000 - 61_000, '/r', 1_000_000), true);
  assert.equal(view.shouldRefreshUsage(null, null, 1_000_000), false, 'no repo root, nothing to refresh');
});

test('finops 2.4: the Spend bar and tone come from the resolver’s own words', () => {
  assert.deepEqual(view.spendOf('≈$38 of quote $30–55 (M) · 1.9M tok · 4 sessions'), { tone: 'good', bar: { filled: 7, width: 10 } });
  assert.deepEqual(view.spendOf('≈$71 · 29% over quote $30–55 (M) · 3.4M tok'), { tone: 'bad', bar: { filled: 10, width: 10 } });
  assert.deepEqual(view.spendOf('≈$22 · no quote · 1.1M tok · 2 sessions'), { tone: 'plain', bar: null });
  assert.deepEqual(view.spendOf('≈$9 of quote $25–90 (M · 2 past epics, wide) · 0.4M tok'), { tone: 'good', bar: { filled: 1, width: 10 } });
  assert.equal(view.bandRowsFrom('Currently building\n  Spend    ≈$71 · 29% over quote $30–55 (M) · 3.4M tok')[1].tone, 'bad');
  assert.deepEqual(view.spendOf('≈$55 · <1% over quote $30–55 (M) · 1M tok'), { tone: 'bad', bar: { filled: 10, width: 10 } });
});
