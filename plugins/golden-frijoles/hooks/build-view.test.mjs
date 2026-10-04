// build-view.test.mjs — the mod's pure half (build-visualization-claude-mods S4).
// The hook file only calls `$` and draws; everything decidable without `$` is here, and tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test('index.tsx resolves only through createViewer, whose every resolver run is the bundled copy', async () => {
  const src = readFileSync(join(HERE, 'index.tsx'), 'utf8');
  assert.match(src, /createViewer\(/);
  assert.doesNotMatch(src, /\/scripts\/build-state\.mjs/, 'the hook must not name a repo-relative resolver');
  // live-build-view S1 moved the call into createViewer: drive it with its DEFAULT script, offline and online.
  const ran = [];
  const v = view.createViewer({
    run: async (argv) => {
      ran.push(argv);
      if (argv[0] === 'git' && argv[1] === 'rev-parse') return { exitCode: 0, stdout: 'sha\nmain\n/stranger\n' };
      if (argv[0] === 'git') return { exitCode: 0, stdout: 'worktree /stranger\nHEAD sha\nbranch refs/heads/main\n' };
      return { exitCode: 0, stdout: '{"lines":["x"],"facts_mode":"live"}' };
    },
    list: async () => [],
    getCached: async () => null,
    setCached: async () => {},
    show: async () => {},
    log: () => {},
    now: () => 0,
  });
  await v.check('turn');
  await v.refreshOnline('timer');
  const node = ran.filter((a) => a[0] !== 'git');
  assert.equal(node.length, 3);
  for (const argv of node) {
    assert.deepEqual(argv.slice(0, 2), ['node', join(HERE, 'vendor', 'build-state.mjs')]);
    assert.ok(!argv.some((a) => /(^|\/)scripts\/build-state\.mjs$/.test(a)), `no repo scripts/ path in ${argv}`);
  }
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
    '  Progress 1 of 5 stories have commits · in flight S1.2 · Sprint 1 of 2',
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
  assert.deepEqual(progressOf('3 of 7 stories have commits · in flight S1.4 · Sprint 1 of 2'), { done: 3, total: 7 });
  assert.deepEqual(progressOf('0 of 3 stories have commits · Sprint ? of 2'), { done: 0, total: 3 });
  assert.equal(progressOf('Story 2 of 5 · Sprint 1 of 2'), null, 'the old ordinal is not progress');
  assert.equal(progressOf('0 of 0 stories have commits'), null);
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

// ── live-build-view S1 ──────────────────────────────────────────────────────────────────────────────────────
const PORCELAIN = [
  'worktree /repo',
  'HEAD aaa',
  'branch refs/heads/main',
  '',
  'worktree /repo-wt',
  'HEAD bbb',
  'branch refs/heads/feat/x-s2',
  'prunable gitdir file points to non-existent location',
  '',
].join('\n');

test('keyFrom: every worktree HEAD + branch and the newest Roadmap mtime; prunable notes ignored', () => {
  const k = view.keyFrom(PORCELAIN, 100);
  assert.notEqual(k, null);
  assert.equal(view.keyFrom(PORCELAIN.replace('prunable gitdir file points to non-existent location', ''), 100), k);
  assert.notEqual(view.keyFrom(PORCELAIN.replace('HEAD bbb', 'HEAD ccc'), 100), k, "ANOTHER worktree's commit moves it");
  assert.notEqual(view.keyFrom(PORCELAIN.replace('refs/heads/main', 'refs/heads/feat/y'), 100), k, 'a branch switch');
  assert.notEqual(view.keyFrom(PORCELAIN, 101), k, 'a doc edit moves it');
  assert.equal(view.keyFrom('', 100), null, 'no git, nothing to key on');
  assert.match(view.keyFrom(PORCELAIN, null), /roadmap@none$/);
  assert.notEqual(view.keyFrom(PORCELAIN, 100, '/repo'), view.keyFrom(PORCELAIN, 100, '/repo-wt'), 'WHICH checkout is in the key');
});

test('newestUnder: walks `dir` entries breadth-first (never through a link), newest file mtime, stops at the cap', async () => {
  const tree = {
    '/r': [
      { name: 'a.md', kind: 'file', mtimeMs: 5 },
      { name: 'sub', kind: 'dir', mtimeMs: 0 }, // $.fs.list: 0 for anything but a regular file
      { name: 'link', kind: 'dir', mtimeMs: 0, isLink: true },
    ],
    '/r/sub': [{ name: 'b.md', kind: 'file', mtimeMs: 9 }],
    '/r/link': [{ name: 'never.md', kind: 'file', mtimeMs: 99 }],
  };
  const list = async (p) => {
    if (!(p in tree)) throw new Error('ENOENT');
    return tree[p];
  };
  assert.deepEqual(await view.newestUnder('/r', list), { mtime: 9, entries: 4, capped: false });
  assert.deepEqual(await view.newestUnder('/r', list, 2), { mtime: 5, entries: 2, capped: true });
  assert.deepEqual(await view.newestUnder('/missing', list), { mtime: null, entries: 0, capped: false });
});

test('isOnlineTrigger: a push or a PR state change, nothing else', () => {
  for (const yes of ['git push -u origin feat/x', 'cd a && git push', 'gh pr create --draft', 'gh pr ready 12', 'gh pr merge 3 --squash'])
    assert.equal(view.isOnlineTrigger(yes), true, yes);
  for (const no of ['git status', 'gh pr view 3', 'gh pr list', 'echo pushed', 'git pushd', undefined])
    assert.equal(view.isOnlineTrigger(no), false, String(no));
});

test('versionRow: only when the PUBLISHED release is higher', () => {
  assert.equal(view.versionRow('0.24.0', '0.24.1'), '  Plugin   0.24.0 installed · 0.24.1 published — /plugin to update');
  assert.equal(view.versionRow('0.14.1', '0.24.1') !== null, true, 'minor beats patch numerically, not as text');
  assert.equal(view.versionRow('0.24.1', '0.24.1'), null);
  assert.equal(view.versionRow('0.25.0', '0.24.1'), null, 'a newer dev copy is not "older"');
  assert.equal(view.versionRow(null, '0.24.1'), null);
  assert.equal(view.versionRow('0.24.0', '0.25.0-rc.1'), null, 'unparseable → no row');
  assert.equal(view.versionRow('0.9.0', '0.10.0') !== null, true);
});

test('publishedManifestPath: from the install cache to the marketplace clone; a dev load → null', () => {
  assert.equal(
    view.publishedManifestPath('/u/.claude/plugins/cache/golden-frijoles/golden-frijoles/0.24.0'),
    '/u/.claude/plugins/marketplaces/golden-frijoles/plugins/golden-frijoles/.claude-plugin/plugin.json'
  );
  assert.equal(view.publishedManifestPath('/repo/skills/plugins/golden-frijoles'), null);
  assert.equal(view.versionOf('{"version":"0.24.1"}'), '0.24.1');
  assert.equal(view.versionOf('nope'), null);
});

test('bandRowsFrom: the Plugin row is a field with its own glyph', () => {
  const rows = view.bandRowsFrom(`Currently building\n${view.versionRow('0.24.0', '0.25.0')}`);
  assert.equal(rows[1].kind, 'field');
  assert.equal(rows[1].label, 'Plugin');
});

/** A fake world for createViewer: a scripted `run`, a Roadmap tree, a store, and what was shown. */
function fakeIo({ porcelain = PORCELAIN, mtime = 1, resolveStdout = JSON.stringify({ lines: ['Currently building'] }), root = '/repo', store = new Map() } = {}) {
  const calls = [];
  const shown = [];
  const logs = [];
  const debugs = [];
  let t = 1_000;
  const world = { porcelain, mtime, resolveStdout, onlineStdout: JSON.stringify({ facts_mode: 'live', lines: [] }) };
  const gate = { hold: null };
  const io = {
    calls,
    shown,
    logs,
    debugs,
    world,
    gate,
    run: async (argv) => {
      calls.push(argv.join(' '));
      if (argv[1] === 'rev-parse') return { exitCode: 0, stdout: `sha\nmain\n${root}\n` };
      if (argv.includes('worktree')) return { exitCode: 0, stdout: world.porcelain };
      if (gate.hold) await gate.hold;
      if (argv.includes('--offline')) return { exitCode: 0, stdout: world.resolveStdout };
      return { exitCode: 0, stdout: world.onlineStdout };
    },
    list: async (p) => (p === `${root}/Roadmap` ? [{ name: 'x.md', kind: 'file', mtimeMs: world.mtime }] : []),
    store,
    getCached: async (r) => store.get(r) ?? null,
    setCached: async (r, v) => {
      store.set(r, v);
    },
    show: async (v) => {
      shown.push(v);
    },
    log: (m) => logs.push(m),
    debug: (m) => debugs.push(m),
    now: () => t,
    tick: (ms) => {
      t += ms;
    },
  };
  return io;
}
const resolves = (io) => io.calls.filter((c) => c.includes('--json')).length;

test('createViewer.check: resolves once, then only when the key moves (a doc edit, another worktree)', async () => {
  const io = fakeIo();
  const v = view.createViewer(io, { buildState: '/vendor/build-state.mjs' });
  assert.equal(await v.check('turn'), 'resolved');
  assert.equal(await v.check('tick'), 'cached');
  assert.equal(resolves(io), 1, 'an unchanged key never re-resolves');
  io.world.mtime = 2;
  assert.equal(await v.check('tick'), 'resolved', 'a Roadmap edit is in the key');
  io.world.porcelain = PORCELAIN.replace('HEAD bbb', 'HEAD ccc');
  assert.equal(await v.check('bash'), 'resolved', "another worktree's commit is in the key");
  assert.equal(resolves(io), 3);
  assert.deepEqual(io.shown, ['Currently building'], 'the band is written only when its text changes');
  assert.ok(io.calls.every((c) => !c.includes('--json') || c.includes('--offline')), 'every check is offline');
  assert.match(io.debugs.at(-1), /bash check resolved in \d+ ms \(1 Roadmap entries\)/);
});

test('createViewer.check: routine checks never reach the transcript — timings go to debug alone (2026-10-04 flood)', async () => {
  const io = fakeIo();
  const v = view.createViewer(io, { buildState: '/vendor/build-state.mjs' });
  for (const reason of ['turn', 'tick', 'bash', 'tick']) await v.check(reason);
  assert.deepEqual(io.logs, [], 'a healthy check says nothing in the main window');
  assert.equal(io.debugs.length, 4, 'every check still leaves its timing in the debug log');
});

test('createViewer.check: no check overlaps another — a second one while the first runs returns busy', async () => {
  const io = fakeIo();
  const v = view.createViewer(io, { buildState: '/vendor/build-state.mjs' });
  let release;
  io.gate.hold = new Promise((r) => (release = r));
  const first = v.check('turn');
  await new Promise((r) => setImmediate(r));
  // Raced against a timer: without the guard the second check would wait on the same held resolve, and a bare await
  // would make the test hang (a cancel, not a failure — the mutation check found exactly that).
  const second = await Promise.race([v.check('tick'), new Promise((r) => setTimeout(() => r('overlapped'), 50))]);
  release();
  assert.equal(second, 'busy');
  assert.equal(await first, 'resolved');
  io.gate.hold = null;
  assert.equal(await v.check('tick'), 'cached', 'the guard is released afterwards');
});

test('createViewer.check: outside a repo shows nothing and never resolves', async () => {
  const io = fakeIo();
  io.run = async (argv) => {
    io.calls.push(argv.join(' '));
    return { exitCode: 128, stdout: '' };
  };
  const v = view.createViewer(io);
  assert.equal(await v.check('turn'), 'no-repo');
  assert.deepEqual(io.shown, [null]);
  assert.equal(resolves(io), 0);
});

test('createViewer.check: a failed resolve is cached as no view; a thrown io is logged, never thrown', async () => {
  const io = fakeIo({ resolveStdout: 'not json' });
  const v = view.createViewer(io);
  assert.equal(await v.check('turn'), 'resolved');
  assert.deepEqual(io.shown, [null]);
  io.list = async () => {
    throw new Error('boom');
  };
  io.getCached = async () => {
    throw new Error('store gone');
  };
  assert.equal(await v.check('tick'), 'failed');
  assert.ok(io.logs.some((l) => /store gone/.test(l)));
});

test('createViewer: the Plugin row rides under the resolver lines, never on its own', async () => {
  const io = fakeIo();
  const v = view.createViewer(io);
  v.setPluginRow(view.versionRow('0.24.0', '0.25.0'));
  await v.check('turn');
  assert.match(io.shown.at(-1), /^Currently building\n {2}Plugin {3}0\.24\.0 installed/);
  const empty = fakeIo({ resolveStdout: '{}' });
  const w = view.createViewer(empty);
  w.setPluginRow(view.versionRow('0.24.0', '0.25.0'));
  await w.check('turn');
  assert.deepEqual(empty.shown, [null]);
});

test('createViewer.refreshOnline: runs the resolver ONLINE, drops the cache, re-checks; warns once without gh', async () => {
  const io = fakeIo();
  const v = view.createViewer(io, { buildState: '/vendor/build-state.mjs' });
  await v.check('turn');
  assert.equal(await v.refreshOnline('timer'), 'live');
  const online = io.calls.filter((c) => c.includes('--json') && !c.includes('--offline'));
  assert.equal(online.length, 1, 'exactly one online run');
  assert.equal(resolves(io), 3, 'turn + online + the re-check it forces');
  io.world.onlineStdout = JSON.stringify({ facts_mode: 'snapshot' });
  assert.equal(await v.refreshOnline('timer'), 'offline');
  assert.equal(await v.refreshOnline('timer'), 'offline');
  assert.equal(io.logs.filter((l) => /no live facts/.test(l)).length, 1, 'logged once, not every five minutes');
});

test('createViewer.refreshOnline: a second one while the first runs returns busy', async () => {
  const io = fakeIo();
  const v = view.createViewer(io);
  let release;
  io.gate.hold = new Promise((r) => (release = r));
  const first = v.refreshOnline('timer');
  await new Promise((r) => setImmediate(r));
  const second = await Promise.race([v.refreshOnline('push'), new Promise((r) => setTimeout(() => r('overlapped'), 50))]);
  io.gate.hold = null;
  release();
  assert.equal(second, 'busy');
  assert.equal(await first, 'live');
});

test('#240 review: two sessions in two worktrees share one store and never serve each other a view', async () => {
  const store = new Map();
  const a = fakeIo({ root: '/r', store, resolveStdout: JSON.stringify({ lines: ['A on main'] }) });
  const b = fakeIo({ root: '/r-wt', store, resolveStdout: JSON.stringify({ lines: ['B on feat/x'] }) });
  const va = view.createViewer(a);
  const vb = view.createViewer(b);
  for (let i = 0; i < 3; i++) {
    await va.check('tick');
    await vb.check('tick');
  }
  assert.equal(resolves(a), 1, 'A resolves once, then its own slot holds');
  assert.equal(resolves(b), 1, 'B too — no thrash between the two');
  assert.deepEqual(a.shown, ['A on main']);
  assert.deepEqual(b.shown, ['B on feat/x'], "B never draws A's view");
});

test('#240 review: a trigger that lands on a running check is deferred to one more pass, never dropped', async () => {
  const io = fakeIo();
  const v = view.createViewer(io);
  let release;
  io.gate.hold = new Promise((r) => (release = r));
  const first = v.check('tick');
  await new Promise((r) => setImmediate(r));
  io.world.porcelain = PORCELAIN.replace('HEAD aaa', 'HEAD moved'); // the agent's `git switch` lands mid-check
  assert.equal(await v.check('bash'), 'busy');
  assert.equal(await v.check('bash'), 'busy', 'a burst collapses into one deferred pass');
  io.gate.hold = null;
  release();
  assert.equal(await first, 'resolved');
  assert.equal(resolves(io), 2, 'the deferred pass saw the moved HEAD');
  assert.ok(io.debugs.some((l) => /tick\+deferred check resolved/.test(l)));
});

test('#240 review: invalidate() re-resolves on an unchanged key — the online refresh mid-check is not lost', async () => {
  const io = fakeIo();
  const v = view.createViewer(io);
  await v.check('turn');
  assert.equal(await v.check('tick'), 'cached');
  v.invalidate();
  assert.equal(await v.check('tick'), 'resolved', 'a new snapshot or usage figure moves no key');
  assert.equal(await v.check('tick'), 'cached', 'once');
  // The race: the online refresh finishes while a check is resolving against the OLD snapshot.
  let release;
  io.gate.hold = new Promise((r) => (release = r));
  io.world.mtime = 9;
  const inflight = v.check('tick');
  await new Promise((r) => setImmediate(r));
  const online = v.refreshOnline('timer');
  await new Promise((r) => setImmediate(r));
  io.gate.hold = null;
  release();
  await inflight;
  await online;
  // The online run's re-check lands on the in-flight check (busy), so it is that check's deferred pass — FORCED, so it
  // resolves although the key did not move, and it runs after the online run rewrote the snapshot.
  const json = io.calls.filter((c) => c.includes('--json'));
  const onlineAt = json.findIndex((c) => !c.includes('--offline'));
  assert.ok(onlineAt !== -1);
  assert.ok(json.slice(onlineAt + 1).some((c) => c.includes('--offline')), 'a resolve after the online run, not before only');
  assert.equal(json.filter((c) => c.includes('--offline')).length, 4, 'turn, invalidated tick, in-flight, forced deferred');
});

// ── live-build-view S2.4: /build ──────────────────────────────────────────────────────────────────────────────
test('/build runs the BUNDLED kickoff generator, never a file the open repo owns', () => {
  const argv = view.kickoffArgv('/stranger', 'live-build-view');
  assert.deepEqual(argv, ['node', join(HERE, '..', 'skills', 'groom', 'vendor', 'emit-epic-kickoff.mjs'), '--epic', 'live-build-view', '--repo-root', '/stranger']);
  assert.ok(existsSync(argv[1]), 'the generator ships inside the plugin');
  assert.deepEqual(view.kickoffArgv('/r', null).slice(2), ['--list', '--repo-root', '/r']);
});

test('isEpicSlug: a slug, never a flag or a path', () => {
  for (const ok of ['live-build-view', 'a1', 'x']) assert.equal(view.isEpicSlug(ok), true, ok);
  for (const no of ['', '--list', '../etc', 'Foo', 'a b', '-x', undefined]) assert.equal(view.isEpicSlug(no), false, String(no));
});

test('the bundled generator --list names startable epics, slug first, build order first', () => {
  // A fixture, never this repo's Roadmap: CI runs this file in the skills mirror, which has none of our epics (#241).
  const root = mkdtempSync(join(tmpdir(), 'build-list-'));
  const epic = (slug, status, order) => {
    mkdirSync(join(root, 'Roadmap', '09-platform-infra', slug), { recursive: true });
    writeFileSync(
      join(root, 'Roadmap', '09-platform-infra', slug, 'README.md'),
      `---\nstatus: ${status}\nslug: ${slug}\ntitle: "Title ${slug}"\nbuild_order: ${order}\n---\n# Epic: ${slug}\n`
    );
  };
  epic('later-one', 'scaffolded', 9);
  epic('first-one', 'in-progress', 2);
  epic('done-one', 'shipped', 1);
  const out = execFileSync('node', [view.VENDOR_EMIT_KICKOFF, '--list', '--repo-root', root], { encoding: 'utf8' });
  assert.deepEqual(out.trim().split('\n'), [
    'first-one  Title first-one  (in-progress, #2)',
    'later-one  Title later-one  (scaffolded, #9)',
  ]);
  assert.match(view.buildListText('/build: which epic?', out), /^\/build: which epic\?\nUsage: \/build <epic-slug>/);
});

test('#240 review r2: a cache write that fails still draws the view (the store file is capped)', async () => {
  const io = fakeIo();
  io.setCached = async () => {
    throw new Error('store over its cap');
  };
  const v = view.createViewer(io);
  assert.equal(await v.check('turn'), 'resolved');
  assert.deepEqual(io.shown, ['Currently building']);
  assert.ok(io.logs.some((l) => /could not cache the view/.test(l)));
});
