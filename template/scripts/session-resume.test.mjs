// session-resume.test.mjs — pure-logic coverage for the derive/format seam (no real git/gh/DB I/O), plus
// injected-deps coverage proving each D4 degradation path produces a partial brief, never a throw.
// Fixtures for parseWorktreeListPorcelain/parseMigrationListTable are captured from REAL live output
// (`git worktree list --porcelain` in this repo; `supabase migration list --linked` against the shared
// project, 2026-07-26) so the parser is proven against the actual shape, not an invented one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRepos,
  parseWorktreeListPorcelain,
  parseMigrationListTable,
  rollupHasFailure,
  rollupHasPending,
  decideStrayBranch,
  decideDirtyTree,
  decideWorktreeAnomalies,
  decidePrAnomalies,
  decideStalePrAnomalies,
  assertRenderableAnomalies,
  prAgeLabel,
  decideMigrationAnomalies,
  buildAnomalies,
  buildGaps,
  buildReport,
  renderHumanReport,
  parseArgs,
  main,
  decideMemoryBudgetAnomaly,
  readMemoryIndex,
  MEMORY_BUDGET_BYTES,
  MEMORY_HARD_LIMIT_BYTES,
} from './session-resume.mjs';

// ---- resolveRepos: the project's one repo list, from reporting.config.json ----
// The origin hard-coded its three repos and their checkout dirs; the template reads them from config.
// Fixture repos below: a root repo, an app checkout and an api checkout — the origin's shape, renamed.

const FIXTURE_REPOS = [
  { repo: 'acme/root', dir: '.' },
  { repo: 'acme/web', dir: 'apps/web' },
  { repo: 'acme/api', dir: 'apps/api' },
];
const originSpawn = (url) => () => ({ status: 0, stdout: `${url}\n`, stderr: '' });

test('resolveRepos: config repos + checkouts; the origin remote is "." unless mapped; unmapped = no checkout', () => {
  const { repos, note } = resolveRepos({
    root: '/r',
    spawn: originSpawn('git@github.com:acme/root.git'),
    loadConfig: () => ({
      repos: ['acme/root', 'acme/web', 'acme/lib'],
      checkouts: { 'acme/web': 'apps/web' },
    }),
  });
  assert.equal(note, null);
  assert.deepEqual(repos, [
    { repo: 'acme/root', dir: '.' },
    { repo: 'acme/web', dir: 'apps/web' },
    { repo: 'acme/lib', dir: null },
  ]);
});

test('resolveRepos: no reporting config degrades to THIS repo and names the gap (D4 — never dies)', async () => {
  const { ReportingConfigError } = await import('./lib/reporting-config.mjs');
  const { repos, note } = resolveRepos({
    root: '/r',
    spawn: originSpawn('https://github.com/acme/root.git'),
    loadConfig: () => {
      throw new ReportingConfigError('/r/reporting.config.json not found — …');
    },
  });
  assert.deepEqual(repos, [{ repo: 'acme/root', dir: '.' }]);
  assert.match(note, /reading only this repo/);
});

// ---- parseWorktreeListPorcelain (fixture: real `git worktree list --porcelain` output, this repo) ----

const WORKTREE_FIXTURE = [
  'worktree /Users/dev/dobby/project',
  'HEAD a684cccedf5979e01f027ffcdab722884d91c78b',
  'branch refs/heads/feat/exec-prose-rail',
  '',
  'worktree /Users/dev/dobby/project/.worktrees/session-continuity',
  'HEAD 7e7eb185775f90b32100ac12b590fcb8d980a83c',
  'branch refs/heads/feat/session-continuity',
  '',
].join('\n');

test('parseWorktreeListPorcelain: parses both worktree blocks and strips refs/heads/', () => {
  const wts = parseWorktreeListPorcelain(WORKTREE_FIXTURE);
  assert.equal(wts.length, 2);
  assert.equal(wts[0].path, '/Users/dev/dobby/project');
  assert.equal(wts[0].branch, 'feat/exec-prose-rail');
  assert.equal(wts[1].path, '/Users/dev/dobby/project/.worktrees/session-continuity');
  assert.equal(wts[1].branch, 'feat/session-continuity');
});

test('parseWorktreeListPorcelain: a detached worktree sets detached true, branch null', () => {
  const text = 'worktree /a\nHEAD deadbeef\ndetached\n';
  const wts = parseWorktreeListPorcelain(text);
  assert.equal(wts[0].detached, true);
  assert.equal(wts[0].branch, null);
});

test('parseWorktreeListPorcelain: empty text → []', () => {
  assert.deepEqual(parseWorktreeListPorcelain(''), []);
});

// ---- parseMigrationListTable (fixture: real `supabase migration list --linked` output, 2026-07-26) ----

const MIGRATION_FIXTURE = [
  '   Local          | Remote         | Time (UTC)          ',
  '  ----------------|----------------|---------------------',
  '   20260430120000 | 20260430120000 | 2026-04-30 12:00:00 ',
  '   20260722160000 | 20260722160000 | 2026-07-22 16:00:00 ',
  '   20260722170000 |                | 2026-07-22 17:00:00 ', // local-only: unapplied
  '                  | 20260725120000 | 2026-07-25 12:00:00 ', // remote-only: applied, no file
].join('\n');

test('parseMigrationListTable: matched rows are neither unapplied nor orphaned', () => {
  const parsed = parseMigrationListTable(MIGRATION_FIXTURE);
  assert.equal(parsed.rows.length, 4);
  assert.deepEqual(parsed.unappliedLocal, ['20260722170000']);
  assert.deepEqual(parsed.appliedNoFile, ['20260725120000']);
});

test('parseMigrationListTable: header and separator rows are not treated as data', () => {
  const parsed = parseMigrationListTable(MIGRATION_FIXTURE);
  assert.equal(
    parsed.rows.some((r) => r.local === null && r.remote === null),
    false
  );
});

// Captured VERBATIM from the live CLI, 2026-07-26. Two local files genuinely share version
// 20260711120000 (the connector-flag and seller-shell-flag seeds), so the CLI prints the pair as a
// matched row PLUS a local-only row. Reading that second row as "unapplied" was a false positive on the
// one signal that must be trustworthy — verified against the live DB: the version IS in
// schema_migrations and both seeded rows exist in the project's own tables.
const DUPLICATE_VERSION_FIXTURE = [
  '   Local          | Remote         | Time (UTC)          ',
  '  ----------------|----------------|---------------------',
  '   20260711120000 | 20260711120000 | 2026-07-11 12:00:00 ',
  '   20260711120000 |                | 2026-07-11 12:00:00 ',
  '                  | 20260711121000 | 2026-07-11 12:10:00 ',
].join('\n');

test('parseMigrationListTable: a version applied in ANY row is not reported unapplied (duplicate-version collision)', () => {
  const parsed = parseMigrationListTable(DUPLICATE_VERSION_FIXTURE);
  assert.deepEqual(parsed.unappliedLocal, [], 'an applied version must never be reported as unapplied');
  assert.deepEqual(parsed.duplicateLocalVersions, ['20260711120000']);
  assert.deepEqual(parsed.appliedNoFile, ['20260711121000']);
});

test('decideMigrationAnomalies: a duplicate version is named as a collision, not as unapplied', () => {
  const out = decideMigrationAnomalies({
    repo: 'r',
    unappliedLocal: [],
    appliedNoFile: [],
    duplicateLocalVersions: ['20260711120000'],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'migration-duplicate-version');
  assert.match(out[0].detail, /only one can ever be recorded/);
  assert.equal(
    out.some((a) => a.type === 'migration-unapplied'),
    false
  );
});

test('parseMigrationListTable: empty/garbage text → no rows, no throw', () => {
  // Assert the FIELDS, not the whole object — a whole-object deepEqual here made adding
  // `duplicateLocalVersions` look like a regression when nothing about empty-input handling changed.
  const empty = parseMigrationListTable('');
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.unappliedLocal, []);
  assert.deepEqual(empty.appliedNoFile, []);
  assert.deepEqual(empty.duplicateLocalVersions, []);
  assert.deepEqual(parseMigrationListTable('not a table at all').rows, []);
});

// ---- rollupHasFailure / rollupHasPending ----

test('rollupHasFailure: a FAILURE conclusion or state is caught', () => {
  assert.equal(rollupHasFailure([{ conclusion: 'FAILURE' }]), true);
  assert.equal(rollupHasFailure([{ state: 'FAILURE' }]), true);
  assert.equal(rollupHasFailure([{ conclusion: 'SUCCESS' }]), false);
});

test('rollupHasFailure: null/non-array rollup (unavailable) → false, not a throw', () => {
  assert.equal(rollupHasFailure(null), false);
  assert.equal(rollupHasFailure(undefined), false);
});

test('rollupHasPending: an in-progress/queued check with no conclusion yet is pending', () => {
  assert.equal(rollupHasPending([{ status: 'IN_PROGRESS', conclusion: null }]), true);
  assert.equal(rollupHasPending([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]), false);
});

// ---- decideStrayBranch — THE motivating anomaly (apps/api / feat/order-payment-capture-state) ----

test('decideStrayBranch: a non-main branch with NO matching open PR is the stray-branch anomaly', () => {
  const a = decideStrayBranch({ branch: 'feat/order-payment-capture-state', detached: false, openPrs: [] });
  assert.equal(a.type, 'stray-branch');
  assert.match(a.detail, /feat\/order-payment-capture-state/);
});

test('decideStrayBranch: a branch WITH a matching open PR is not an anomaly', () => {
  const a = decideStrayBranch({
    branch: 'feat/x',
    detached: false,
    openPrs: [{ headRefName: 'feat/x', number: 1 }],
  });
  assert.equal(a, null);
});

test('decideStrayBranch: main is never a stray branch', () => {
  assert.equal(decideStrayBranch({ branch: 'main', detached: false, openPrs: [] }), null);
});

test('decideStrayBranch: detached HEAD is not judged as a stray branch', () => {
  assert.equal(decideStrayBranch({ branch: 'HEAD', detached: true, openPrs: [] }), null);
});

test('decideStrayBranch: openPrs unknown (gh unavailable) → null, NOT a false-positive anomaly', () => {
  assert.equal(decideStrayBranch({ branch: 'feat/x', detached: false, openPrs: undefined }), null);
});

// ---- decideDirtyTree / decideWorktreeAnomalies ----

test('decideDirtyTree: 0 dirty files → no anomaly; >0 → anomaly naming the count', () => {
  assert.equal(decideDirtyTree({ label: '.', dirtyFiles: 0 }), null);
  const a = decideDirtyTree({ label: 'apps/api', dirtyFiles: 3 });
  assert.match(a.detail, /apps\/api: 3 uncommitted/);
});

test('decideWorktreeAnomalies: only dirty worktrees surface, clean ones do not', () => {
  const wts = [
    { path: '/a', branch: 'x', dirty: true },
    { path: '/b', branch: 'y', dirty: false },
  ];
  const out = decideWorktreeAnomalies(wts);
  assert.equal(out.length, 1);
  assert.match(out[0].detail, /\/a/);
});

// ---- decidePrAnomalies ----

test('decidePrAnomalies: a conflicting PR and a red-CI PR both surface, a clean PR does not', () => {
  const open = [
    { number: 1, title: 'clean', url: 'x', mergeable: 'MERGEABLE', ciFailing: false },
    { number: 2, title: 'conflict', url: 'x', mergeable: 'CONFLICTING', ciFailing: false },
    { number: 3, title: 'red', url: 'x', mergeable: 'MERGEABLE', ciFailing: true },
  ];
  const out = decidePrAnomalies(open);
  assert.equal(out.length, 2);
  assert.ok(out.some((a) => a.type === 'pr-conflict' && /#2/.test(a.detail)));
  assert.ok(out.some((a) => a.type === 'pr-ci-red' && /#3/.test(a.detail)));
});

// ---- decideMigrationAnomalies ----

test('decideMigrationAnomalies: both directions produce distinctly-typed anomalies', () => {
  const out = decideMigrationAnomalies({
    repo: 'r',
    unappliedLocal: ['20260722170000'],
    appliedNoFile: ['20260725120000'],
  });
  assert.equal(out.length, 2);
  assert.ok(out.some((a) => a.type === 'migration-unapplied'));
  assert.ok(out.some((a) => a.type === 'migration-orphan-summary'));
});

// The first REAL run (2026-07-26) emitted 47 anomalies of which 36 were orphans, burying the 3
// actionable ones — the exact attention failure D3 exists to prevent. Orphans are the expected residue
// of the documented MCP-timestamp/filename divergence, so they collapse to one counted line by default.
test('decideMigrationAnomalies: many orphans collapse to ONE summary line, unapplied stay per-item', () => {
  const orphans = Array.from({ length: 36 }, (_, i) => `2026072${String(i).padStart(7, '0')}`);
  const out = decideMigrationAnomalies({
    repo: 'r',
    unappliedLocal: ['20260711120000'],
    appliedNoFile: orphans,
  });

  // 1 dangerous-direction line + exactly 1 collapsed orphan line — never 37.
  assert.equal(out.length, 2);
  const summary = out.find((a) => a.type === 'migration-orphan-summary');
  assert.ok(summary, 'expected a collapsed summary line');
  assert.match(summary.detail, /36 applied version\(s\)/);
  assert.match(summary.detail, /--all-migrations/);
  // The count must be real, not a magic number: it names some of the actual versions.
  assert.ok(summary.detail.includes(orphans[0]));
  // The dangerous direction is never collapsed.
  assert.equal(out.filter((a) => a.type === 'migration-unapplied').length, 1);
});

test('decideMigrationAnomalies: --all-migrations (expandOrphans) restores the per-item listing', () => {
  const orphans = ['20260701000000', '20260702000000', '20260703000000'];
  const out = decideMigrationAnomalies({
    repo: 'r',
    unappliedLocal: [],
    appliedNoFile: orphans,
    expandOrphans: true,
  });
  assert.equal(out.length, 3);
  assert.ok(out.every((a) => a.type === 'migration-orphan'));
  assert.equal(out.filter((a) => a.type === 'migration-orphan-summary').length, 0);
});

test('decideMigrationAnomalies: zero orphans emits NO summary line at all', () => {
  const out = decideMigrationAnomalies({ repo: 'r', unappliedLocal: [], appliedNoFile: [] });
  assert.deepEqual(out, []);
});

// ---- buildAnomalies — the aggregation, incl. the apps/api end-to-end scenario ----

test('buildAnomalies: reproduces the apps/api stray-branch case end-to-end', () => {
  const repoStates = [
    {
      repo: 'acme/api',
      dir: 'apps/api',
      git: {
        available: true,
        branch: 'feat/order-payment-capture-state',
        detached: false,
        dirtyFiles: 0,
        worktrees: [],
      },
      // `createdAt` is RELATIVE, not a literal date: gatherRepoGh always carries one through from the
      // REST payload, and a hardcoded date would silently age past STALE_PR_DAYS and turn this
      // stray-branch assertion red for a reason that has nothing to do with stray branches.
      gh: {
        available: true,
        open: [
          {
            number: 110,
            title: 'dependabot bump',
            headRefName: 'dependabot/x',
            createdAt: new Date().toISOString(),
            isDraft: false,
            mergeable: 'MERGEABLE',
            ciFailing: false,
          },
        ],
      },
    },
  ];
  const anomalies = buildAnomalies({ repoStates, migrationResults: [] });
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].type, 'stray-branch');
  assert.equal(anomalies[0].repo, 'acme/api');
});

test('buildAnomalies: gh unavailable for a repo suppresses stray-branch AND PR anomalies for it (no false positive)', () => {
  const repoStates = [
    {
      repo: 'r',
      dir: '.',
      git: { available: true, branch: 'feat/x', detached: false, dirtyFiles: 0, worktrees: [] },
      gh: { available: false, reason: 'unauthenticated' },
    },
  ];
  assert.deepEqual(buildAnomalies({ repoStates, migrationResults: [] }), []);
});

test('buildAnomalies: git unavailable for a repo produces no anomalies for it (not a crash)', () => {
  const repoStates = [
    {
      repo: 'r',
      dir: '.',
      git: { available: false, reason: 'not found' },
      gh: { available: true, open: [] },
    },
  ];
  assert.deepEqual(buildAnomalies({ repoStates, migrationResults: [] }), []);
});

// ---- buildGaps — D4: name every degraded source ----

test('buildGaps: names a missing-repo git gap, a gh gap, a migration gap, and a journal gap', () => {
  const repoStates = [
    {
      repo: 'r1',
      git: { available: false, reason: 'path not found: /x' },
      gh: { available: false, reason: 'unauthenticated' },
    },
  ];
  const migrationResults = [{ repo: 'r1', available: false, reason: 'supabase CLI not found' }];
  const gaps = buildGaps({
    repoStates,
    migrationResults,
    journalAvailable: false,
    journalReason: 'no entries yet',
  });
  assert.equal(gaps.length, 4);
  assert.match(gaps.join('\n'), /path not found: \/x/);
  assert.match(gaps.join('\n'), /unauthenticated/);
  assert.match(gaps.join('\n'), /supabase CLI not found/);
  assert.match(gaps.join('\n'), /no entries yet/);
});

test('buildGaps: everything available → []', () => {
  const repoStates = [{ repo: 'r1', git: { available: true }, gh: { available: true } }];
  assert.deepEqual(
    buildGaps({ repoStates, migrationResults: [{ repo: 'r1', available: true }], journalAvailable: true }),
    []
  );
});

// ---- buildReport / renderHumanReport — shape + D3 ordering ----

test('buildReport: assembles anomalies, gaps, journal (capped to journalLimit), and repos/migrations verbatim', () => {
  const report = buildReport({
    repoStates: [
      {
        repo: 'r',
        dir: '.',
        git: { available: true, branch: 'main', dirtyFiles: 0, worktrees: [] },
        gh: { available: true, open: [] },
      },
    ],
    migrationResults: [],
    journalEntries: [
      { kind: 'decision', text: 'a' },
      { kind: 'next', text: 'b' },
      { kind: 'doing', text: 'c' },
    ],
    journalAvailable: true,
    journalLimit: 2,
    generatedAt: '2026-07-26T00:00:00Z',
  });
  assert.equal(report.generatedAt, '2026-07-26T00:00:00Z');
  assert.deepEqual(report.anomalies, []);
  assert.deepEqual(report.gaps, []);
  assert.equal(report.journal.totalEntries, 3);
  assert.equal(report.journal.recent.length, 2);
  assert.deepEqual(report.journal.recent, [
    { kind: 'next', text: 'b' },
    { kind: 'doing', text: 'c' },
  ]);
});

test('renderHumanReport: anomalies section precedes the journal section, which precedes full state (D3 order)', () => {
  const report = buildReport({
    repoStates: [
      {
        repo: 'acme/api',
        dir: 'apps/api',
        git: { available: true, branch: 'feat/stray', detached: false, dirtyFiles: 0, worktrees: [] },
        gh: { available: true, open: [], recentMerged: [] },
      },
    ],
    migrationResults: [],
    journalEntries: [{ ts: 't', session: 's', kind: 'decision', text: 'wrote D6', refs: [] }],
    journalAvailable: true,
  });
  const text = renderHumanReport(report);
  const anomalyIdx = text.indexOf('ANOMALIES');
  const journalIdx = text.indexOf('Journal —');
  const stateIdx = text.indexOf('Full derived state:');
  assert.ok(
    anomalyIdx >= 0 && anomalyIdx < journalIdx && journalIdx < stateIdx,
    'expected anomalies → journal → full state ordering'
  );
  assert.match(text, /stray-branch/);
});

test('renderHumanReport: no anomalies renders the reassuring line, not an empty section', () => {
  const report = buildReport({
    repoStates: [],
    migrationResults: [],
    journalEntries: [],
    journalAvailable: true,
  });
  assert.match(renderHumanReport(report), /No anomalies detected/);
});

// ---- parseArgs ----

test('parseArgs: --json, --root, --journal-limit all parse', () => {
  const args = parseArgs(['--json', '--root', '/tmp/x', '--journal-limit', '5']);
  assert.equal(args.json, true);
  assert.equal(args.root, '/tmp/x');
  assert.equal(args.journalLimit, 5);
});

test('parseArgs: an unknown flag throws', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});

// ============================================================================================
// main() — injected-deps coverage of EVERY D4 degradation path (no real git/gh/network/DB)
// ============================================================================================

function baseDeps(overrides = {}) {
  return {
    log: () => {},
    warn: () => {},
    existsSyncFn: () => true,
    readdirSyncFn: () => [],
    spawn: () => ({ status: 0, stdout: 'main\n', stderr: '' }),
    listPullsFn: () => [],
    mergeFn: () => 'MEARGEABLE',
    rollupFn: () => [],
    readLogFromBranchFn: () => null,
    now: new Date('2026-07-26T00:00:00Z'),
    resolveReposFn: () => ({ repos: FIXTURE_REPOS, note: null }),
    ...overrides,
  };
}

test('main(): gh entirely unavailable (unauthenticated) → degrades, gaps named, exit 0, never throws', async () => {
  let out = '';
  const code = await main([], baseDeps({ listPullsFn: () => null, log: (m) => (out += m) }));
  assert.equal(code, 0);
  assert.match(out, /PR\/CI state unavailable/);
});

test('main(): a missing repo path → degrades, git gap named, exit 0', async () => {
  let out = '';
  const code = await main(
    [],
    baseDeps({
      existsSyncFn: (p) => !String(p).includes('apps/api'),
      log: (m) => (out += m),
    })
  );
  assert.equal(code, 0);
  assert.match(out, /path not found/);
});

test('main(): empty/unreachable journal → degrades, journal gap named, exit 0', async () => {
  let out = '';
  const code = await main([], baseDeps({ readLogFromBranchFn: () => null, log: (m) => (out += m) }));
  assert.equal(code, 0);
  assert.match(out, /journal unavailable/);
  assert.match(out, /none: /);
});

test('main(): migration CLI unavailable (spawn error) → degrades, migration gap named, exit 0', async () => {
  let out = '';
  const code = await main(
    [],
    baseDeps({
      existsSyncFn: (_p) => true,
      readdirSyncFn: () => ['20260101000000_x.sql'],
      spawn: (cmd) =>
        cmd === 'supabase'
          ? { error: new Error('spawn supabase ENOENT'), status: null }
          : { status: 0, stdout: 'main\n' },
      log: (m) => (out += m),
    })
  );
  assert.equal(code, 0);
  assert.match(out, /migration drift check unavailable/);
});

test('main(): apps/api on a stray branch with no open PR → the anomaly appears in real output', async () => {
  let out = '';
  const code = await main(
    [],
    baseDeps({
      spawn: (cmd, args, opts) => {
        if (cmd === 'git' && args[0] === 'rev-parse') {
          return {
            status: 0,
            stdout: opts.cwd.includes('apps/api') ? 'feat/order-payment-capture-state\n' : 'main\n',
          };
        }
        if (cmd === 'git' && args[0] === 'worktree') return { status: 0, stdout: '' };
        return { status: 0, stdout: '' };
      },
      listPullsFn: () => [
        { number: 1, state: 'OPEN', headRefName: 'dependabot/x', title: 't', url: 'u', headSha: 's' },
      ],
      log: (m) => (out += m),
    })
  );
  assert.equal(code, 0);
  assert.match(out, /stray-branch/);
  assert.match(out, /feat\/order-payment-capture-state/);
});

test('main(): --json emits valid, parseable JSON with the same shape as the human report', async () => {
  let out = '';
  const code = await main(['--json'], baseDeps({ log: (m) => (out += m) }));
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.ok('anomalies' in parsed && 'gaps' in parsed && 'journal' in parsed && 'repos' in parsed);
});

test('main(): everything degraded at once still returns one coherent partial brief, not a crash', async () => {
  let out = '';
  const code = await main(
    [],
    baseDeps({
      existsSyncFn: () => false,
      listPullsFn: () => null,
      readLogFromBranchFn: () => null,
      log: (m) => (out += m),
    })
  );
  assert.equal(code, 0);
  assert.match(out, /Session resume/);
  assert.match(out, /Degraded sources/);
});

test('main(): --help prints usage and exits 0 without gathering anything', async () => {
  let out = '';
  let spawnCalled = false;
  const code = await main(
    ['--help'],
    baseDeps({
      spawn: () => {
        spawnCalled = true;
        return { status: 0 };
      },
      log: (m) => (out += m),
    })
  );
  assert.equal(code, 0);
  assert.equal(spawnCalled, false);
  assert.match(out, /Usage: node scripts\/session-resume\.mjs/);
});

// ---- cross-review findings on PR #109: silent degradation ----
//
// D4 says degrade and NAME the gap. A failed probe that renders as silence is indistinguishable from
// a clean result — the "unknown is not none" rule this repo already learned once, applied to itself.

test('buildGaps: a failed working-tree probe is reported as UNKNOWN, not silently as clean', () => {
  const gaps = buildGaps({
    repoStates: [
      {
        repo: 'r',
        dir: '.',
        git: { available: true, branch: 'main', dirtyFiles: null, dirtyProbeFailed: true, worktrees: [] },
        gh: { available: true, open: [] },
      },
    ],
    migrationResults: [],
    journalAvailable: true,
  });
  assert.ok(
    gaps.some((g) => /UNKNOWN, not clean/.test(g)),
    'a failed dirty probe must name a gap'
  );
});

test('buildGaps: a successful clean tree produces NO dirty gap', () => {
  const gaps = buildGaps({
    repoStates: [
      {
        repo: 'r',
        dir: '.',
        git: { available: true, branch: 'main', dirtyFiles: 0, dirtyProbeFailed: false, worktrees: [] },
        gh: { available: true, open: [] },
      },
    ],
    migrationResults: [],
    journalAvailable: true,
  });
  assert.equal(
    gaps.some((g) => /UNKNOWN/.test(g)),
    false
  );
});

// ── D-mem: the memory index budget ────────────────────────────────────────────────────────────
//
// MEMORY.md is loaded into every session, but only its first ~24.4 KB. Past that the tail is
// truncated with NO error — and the tail holds "Open items owed to the product owner". It reached 29.7 KB
// on 2026-08-19 and had been silently truncating for an unknown number of sessions. These guard
// the decision, never the filesystem.

test('decideMemoryBudgetAnomaly: comfortably under budget is no anomaly', () => {
  assert.equal(decideMemoryBudgetAnomaly({ available: true, bytes: 18_000, path: '/m/MEMORY.md' }), null);
});

test('decideMemoryBudgetAnomaly: over the hard limit says it IS truncating, now', () => {
  const a = decideMemoryBudgetAnomaly({ available: true, bytes: 29_700, path: '/m/MEMORY.md' });
  assert.equal(a.type, 'memory-index-truncating');
  // The number must be in the text: "it is too big" without the size is unactionable.
  assert.match(a.detail, /29\.0 KB/);
  assert.match(a.detail, /truncated/);
});

test('decideMemoryBudgetAnomaly: between budget and limit warns WITHOUT claiming truncation', () => {
  // The distinction is the point. Saying "you are being truncated" when you are not is the
  // guard-that-cries-wolf failure, and it is how a real warning stops being read.
  const a = decideMemoryBudgetAnomaly({ available: true, bytes: 24_000, path: '/m/MEMORY.md' });
  assert.equal(a.type, 'memory-index-near-limit');
  assert.doesNotMatch(a.detail, /IS being truncated/);
});

test('decideMemoryBudgetAnomaly: unreadable is UNAVAILABLE, never "fine"', () => {
  const a = decideMemoryBudgetAnomaly({ available: false, bytes: null, path: '/m/MEMORY.md' });
  assert.equal(a.type, 'memory-index-unavailable');
  assert.match(a.detail, /UNKNOWN, not fine/);
});

test('decideMemoryBudgetAnomaly: the boundaries are inclusive of "still fine"', () => {
  // Exactly at budget is fine; one byte over is not. A guard that fires ON its own stated
  // threshold makes the documented number a lie.
  assert.equal(decideMemoryBudgetAnomaly({ available: true, bytes: MEMORY_BUDGET_BYTES }), null);
  assert.equal(
    decideMemoryBudgetAnomaly({ available: true, bytes: MEMORY_BUDGET_BYTES + 1 }).type,
    'memory-index-near-limit'
  );
  assert.equal(
    decideMemoryBudgetAnomaly({ available: true, bytes: MEMORY_HARD_LIMIT_BYTES + 1 }).type,
    'memory-index-truncating'
  );
});

test('buildAnomalies: a truncating memory index leads the report', () => {
  const anomalies = buildAnomalies({
    repoStates: [],
    migrationResults: [],
    memoryIndex: { available: true, bytes: 30_000, path: '/m/MEMORY.md' },
  });
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].type, 'memory-index-truncating');
});

test('buildAnomalies: omitting memoryIndex adds nothing — absence is not a pass', () => {
  // A caller that did not look must not be reported as having looked and found nothing.
  assert.deepEqual(buildAnomalies({ repoStates: [], migrationResults: [] }), []);
});

test('readMemoryIndex: an unreadable path reports unavailable, not zero bytes', () => {
  const result = readMemoryIndex('/some/project', {
    home: '/nonexistent-home',
    stat: () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(result.available, false);
  // Zero would flow into the size comparison and read as "comfortably under budget".
  assert.notEqual(result.bytes, 0);
  assert.equal(result.bytes, null);
});

test('readMemoryIndex: derives the project slug from the path, dashes for separators', () => {
  const seen = [];
  readMemoryIndex('/Users/x/dobby/project', {
    home: '/Users/x',
    stat: (p) => {
      seen.push(p);
      return { size: 1234 };
    },
  });
  assert.equal(seen[0], '/Users/x/.claude/projects/-Users-x-dobby-project/memory/MEMORY.md');
});

// Fixes from the agy cross-family pass on PR #160. Each is a real seam, and each would
// have been invisible: none of them changes the happy path.

test('decideMemoryBudgetAnomaly: a non-numeric size is UNAVAILABLE, not healthy', () => {
  // `available: true, bytes: null` used to fall through both comparisons and return
  // null — "no anomaly" — from a size nobody knows. The third state exists for this.
  for (const bytes of [null, undefined, NaN, 'big']) {
    const a = decideMemoryBudgetAnomaly({ available: true, bytes, path: '/m/MEMORY.md' });
    assert.equal(a?.type, 'memory-index-unavailable', `bytes=${String(bytes)}`);
  }
});

test('readMemoryIndex: a non-string cwd degrades instead of throwing', () => {
  // `resolve(null)` throws a TypeError. Deriving the path outside the guard would take
  // the whole session brief down — "degrade, never die" is the rule this script is built on.
  // `undefined` is excluded deliberately: it triggers the default parameter
  // (`process.cwd()`), which is a real string and correctly succeeds.
  for (const cwd of [null, 42, {}]) {
    const result = readMemoryIndex(cwd, { home: '/h', stat: () => ({ size: 1 }) });
    assert.equal(result.available, false, `cwd=${String(cwd)}`);
    assert.equal(result.bytes, null);
  }
});

test('main: forwards its injected stat/home — never touches the real home directory', async () => {
  // The convention this whole file rests on. A main() test that stats $HOME is a test
  // whose result depends on the machine it runs on.
  const seen = [];
  await main(['--json'], {
    log: () => {},
    warn: () => {},
    existsSyncFn: () => false,
    readdirSyncFn: () => [],
    spawn: () => ({ status: 1, stdout: '', stderr: 'unavailable' }),
    listPullsFn: () => {
      throw new Error('gh unavailable');
    },
    mergeFn: () => {
      throw new Error('gh unavailable');
    },
    rollupFn: () => {
      throw new Error('gh unavailable');
    },
    readLogFromBranchFn: () => {
      throw new Error('no journal');
    },
    resolveReposFn: () => ({ repos: FIXTURE_REPOS, note: null }),
    home: '/injected-home',
    homeDir: '/injected-home',
    stat: (p) => {
      seen.push(p);
      return { size: 100 };
    },
    statFn: (p) => {
      seen.push(p);
      return { size: 100 };
    },
    now: new Date('2026-08-20T00:00:00Z'),
  });
  // Exactly one, on EITHER path: this deps set is harsh enough to push main down its
  // last-resort branch, and that branch was silently dropping the memory check until
  // this test caught it.
  assert.equal(seen.length, 1, 'expected exactly one stat call');
  assert.ok(seen[0].startsWith('/injected-home/'), `stat hit ${seen[0]}, not the injected home`);
});

test('main: forwards its injected stat/home on the SUCCESS path too', async () => {
  // The sibling test above turned out to exercise only the last-resort branch: with
  // harsh deps main falls into its catch, so mutating the SUCCESS-path call site left
  // it green. A mutation that does not kill the test proves nothing about the test, so
  // this one keeps main on its normal path — benign deps, nothing throwing.
  const seen = [];
  await main(['--json'], {
    log: () => {},
    warn: () => {},
    existsSyncFn: () => false,
    readdirSyncFn: () => [],
    spawn: () => ({ status: 0, stdout: '', stderr: '' }),
    listPullsFn: () => [],
    mergeFn: () => ({}),
    rollupFn: () => ({}),
    readLogFromBranchFn: () => '',
    resolveReposFn: () => ({ repos: FIXTURE_REPOS, note: null }),
    homeDir: '/success-path-home',
    statFn: (p) => {
      seen.push(p);
      return { size: 100 };
    },
    now: new Date('2026-08-20T00:00:00Z'),
  });
  assert.equal(seen.length, 1, 'expected exactly one stat call on the success path');
  assert.ok(
    seen[0].startsWith('/success-path-home/'),
    `stat hit ${seen[0]} — main is not forwarding its injected home`
  );
});

// ---- decideStalePrAnomalies ----
// Added 2026-08-24 after the backend carried four dependabot PRs aged 10–17 days and this repo had four
// advisory audit PRs stranded since 08-03, none of which any session ever announced: `open PRs: 4` reads
// the same whether they are hours or five weeks old.
const NOW = '2026-08-24T12:00:00.000Z';
const pr = (o) => ({ number: 1, title: 't', url: 'u', createdAt: NOW, isDraft: false, ...o });

test('decideStalePrAnomalies: flags a PR past the threshold and names its age', () => {
  const out = decideStalePrAnomalies(
    [pr({ number: 151, title: 'bump', createdAt: '2026-08-07T11:20:14.000Z' })],
    { nowISO: NOW }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'pr-stale');
  assert.match(out[0].detail, /#151 .* has been open 17 days/);
});

test('decideStalePrAnomalies: a fresh PR is silent, and the boundary is inclusive', () => {
  // 6 days — in flight, says nothing. The negation of what is flagged must stay allowed, or the line
  // gets skimmed and the whole anomaly is worth less than nothing.
  assert.deepEqual(
    decideStalePrAnomalies([pr({ createdAt: '2026-08-18T12:00:00.000Z' })], { nowISO: NOW }),
    []
  );
  // exactly 7 → flagged; a hair under 7 → not.
  assert.equal(
    decideStalePrAnomalies([pr({ createdAt: '2026-08-17T12:00:00.000Z' })], { nowISO: NOW }).length,
    1
  );
  assert.equal(
    decideStalePrAnomalies([pr({ createdAt: '2026-08-17T12:00:01.000Z' })], { nowISO: NOW }).length,
    0
  );
});

// The first cut of this guard exempted every draft ("a draft is open on purpose"). That is exactly
// wrong for the failure already recorded here: nightly smoke-fix routines open DRAFTS and they pile up
// (4 stacked by 2026-08-02; six red nights were unmerged fixes, not quota). Proven again 2026-08-25 —
// frontend #404 was a green, finished, 5-day-old draft this guard skipped by design, and merging it was
// the fix for a nightly red. The test is "does it look FINISHED", not "is it a draft".
const finished = { ciAvailable: true, ciFailing: false, ciPending: false, mergeable: 'MERGEABLE' };

test('decideStalePrAnomalies: an old draft that is GREEN and mergeable is finished work nobody landed', () => {
  const out = decideStalePrAnomalies(
    [
      pr({
        number: 404,
        title: 'nightly smoke fix',
        createdAt: '2026-08-15T00:00:00.000Z',
        isDraft: true,
        ...finished,
      }),
    ],
    { nowISO: NOW }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'pr-draft-finished');
  assert.match(out[0].detail, /#404 .* DRAFT .* green and mergeable for 9 days/);
});

test('decideStalePrAnomalies: a draft still in flight stays silent — the negation the guard must allow', () => {
  const old = { createdAt: '2026-06-01T00:00:00.000Z', isDraft: true };
  // red CI, pending CI, conflicting, and "CI not reported at all" are all genuinely in-progress.
  assert.deepEqual(
    decideStalePrAnomalies([pr({ ...old, ...finished, ciFailing: true })], { nowISO: NOW }),
    []
  );
  assert.deepEqual(
    decideStalePrAnomalies([pr({ ...old, ...finished, ciPending: true })], { nowISO: NOW }),
    []
  );
  assert.deepEqual(
    decideStalePrAnomalies([pr({ ...old, ...finished, mergeable: 'CONFLICTING' })], { nowISO: NOW }),
    []
  );
  assert.deepEqual(
    decideStalePrAnomalies([pr({ ...old, ...finished, ciAvailable: false })], { nowISO: NOW }),
    []
  );
  assert.deepEqual(decideStalePrAnomalies([pr({ ...old })], { nowISO: NOW }), []);
  // and a FRESH finished draft is not nagged either
  assert.deepEqual(
    decideStalePrAnomalies([pr({ createdAt: '2026-08-23T00:00:00.000Z', isDraft: true, ...finished })], {
      nowISO: NOW,
    }),
    []
  );
});

test('decideStalePrAnomalies: an unreadable createdAt is UNKNOWN, never silently "fresh"', () => {
  for (const bad of [undefined, null, '', 'not-a-date']) {
    const out = decideStalePrAnomalies([pr({ number: 9, createdAt: bad })], { nowISO: NOW });
    assert.equal(out.length, 1, `createdAt=${JSON.stringify(bad)} must not be collapsed into "fresh"`);
    assert.equal(out[0].type, 'pr-age-unknown');
    assert.match(out[0].detail, /age is UNKNOWN/);
  }
});

test('decideStalePrAnomalies: no trustworthy clock ⇒ assert nothing rather than assert wrongly', () => {
  assert.deepEqual(
    decideStalePrAnomalies([pr({ createdAt: '2026-01-01T00:00:00.000Z' })], { nowISO: 'garbage' }),
    []
  );
  assert.deepEqual(decideStalePrAnomalies(undefined, { nowISO: NOW }), []);
  assert.deepEqual(decideStalePrAnomalies([], { nowISO: NOW }), []);
});

test('prAgeLabel: renders days, and says unknown rather than a plausible 0', () => {
  assert.equal(prAgeLabel({ createdAt: '2026-08-17T12:00:00.000Z' }, NOW), '7d');
  assert.equal(prAgeLabel({ createdAt: NOW }, NOW), '0d');
  assert.equal(prAgeLabel({ createdAt: 'nonsense' }, NOW), 'unknown');
  assert.equal(prAgeLabel({}, NOW), 'unknown');
  assert.equal(prAgeLabel(undefined, NOW), 'unknown');
});

// ---- assertRenderableAnomalies ----
// The report renders every anomaly as `[${a.type}] ${a.detail}`. decideMemoryBudgetAnomaly returned
// {kind, text} from the day it was added, so the ONE anomaly whose whole job is to say "MEMORY.md is
// silently truncating" was itself unreadable — it printed "[undefined] undefined" at the top of every
// report. The bug survived because the tests asserted `.kind`/`.text`: they pinned the broken shape
// rather than the rendered outcome. These assert the shared contract instead.
test('assertRenderableAnomalies: throws on an anomaly that would render as [undefined] undefined', () => {
  assert.throws(
    () => assertRenderableAnomalies([{ kind: 'memory-index-near-limit', text: 'over budget' }]),
    /\[undefined\] undefined/
  );
  assert.throws(() => assertRenderableAnomalies([{ type: 'x' }]), /lack a string/);
  assert.throws(() => assertRenderableAnomalies([{ detail: 'y' }]), /lack a string/);
  assert.throws(() => assertRenderableAnomalies([null]), /lack a string/);
});

test('assertRenderableAnomalies: a well-formed set passes through unchanged', () => {
  const ok = [
    { type: 'dirty-tree', detail: 'x' },
    { type: 'pr-stale', detail: 'y', repo: 'r' },
  ];
  assert.equal(assertRenderableAnomalies(ok), ok);
  assert.deepEqual(assertRenderableAnomalies([]), []);
});

test('every memory-budget verdict is renderable — the population, not one sampled case', () => {
  const cases = [
    { available: false },
    { available: true, bytes: 'nope' },
    { available: true, bytes: MEMORY_HARD_LIMIT_BYTES + 1 },
    { available: true, bytes: MEMORY_BUDGET_BYTES + 1 },
  ];
  for (const c of cases) {
    const a = decideMemoryBudgetAnomaly(c);
    assert.ok(a, `expected an anomaly for ${JSON.stringify(c)}`);
    // The real assertion: it survives the same guard buildAnomalies runs, so it can actually be READ.
    assertRenderableAnomalies([a]);
  }
  // And the healthy case still yields nothing at all.
  assert.equal(decideMemoryBudgetAnomaly({ available: true, bytes: 1024 }), null);
});
