// pod-report — the gatherer's adapter layer.
//
// The adapter is where a real dishonesty crept in and had to be fixed, so it is what is tested
// here. The lens reads `reviewComments[].isAgentReviewer` and `ciCheckNames`; `gh` returns
// `comments[]` and `statusCheckRollup[]`. Handing the lens gh's raw shape meant it saw 98 pull
// requests with no review data and reported the practice as ABSENT — `not_met`, which asserts
// something strictly stronger than "not measured". Understating the pod is still a false claim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync as writeFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync as run } from 'node:child_process';
import { reworkSummary } from './lib/pod-metrics.mjs';
import { basename } from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalisePrForLens,
  parseRiskTier,
  checkSucceeded,
  checkName,
  readCommits,
  windowDays,
  BENCHMARKS,
  buildArtifact,
  gatherSourceRef,
  resolvePushConfig,
  readPodEnvFile,
  pushEnvFrom,
  readEpics,
  buildPushEnvelope,
  POD_REPORT_SCHEMA_VERSION,
} from './pod-report.mjs';

test('an agent review comment is detected by BODY, never by author identity', () => {
  // Forced by the data, not a preference: these comments are posted under the human maintainer's
  // own account, so there is no bot login to filter on. Filtering by author would find zero
  // reviewed PRs across a repo that reviews most of them.
  const pr = normalisePrForLens({
    number: 1,
    comments: [
      { author: { login: 'danybgoode' }, body: '### 🔎 Cross-agent review (Antigravity)\n\nNo findings.' },
      { author: { login: 'danybgoode' }, body: 'looks good to me' },
    ],
  });
  assert.equal(pr.reviewComments[0].isAgentReviewer, true, 'a human-posted agent review still counts');
  assert.equal(pr.reviewComments[1].isAgentReviewer, false, 'ordinary chatter must not count');
});

test('every reviewer-comment shape this repo actually produces is recognised', () => {
  for (const body of [
    '### 🔎 Cross-agent review (Antigravity)',
    '## Fresh-reviewer findings — disposition',
    'This is the judgment-layer review, not a second CI',
  ]) {
    const pr = normalisePrForLens({ number: 1, comments: [{ body }] });
    assert.equal(pr.reviewComments[0].isAgentReviewer, true, `missed: ${body}`);
  }
});

test('gh check names are mapped to the field the lens actually reads', () => {
  const pr = normalisePrForLens({
    number: 2,
    statusCheckRollup: [{ name: 'guards' }, { name: 'inflight' }, { notAName: true }],
  });
  assert.deepEqual(
    pr.ciCheckNames,
    ['guards', 'inflight'],
    'nameless entries are dropped, not passed as undefined'
  );
});

test('a PR with no comments or checks yields empty arrays, never undefined fields', () => {
  // The lens distinguishes "absent" from "empty"; the adapter must not blur that by emitting
  // undefined where gh simply returned nothing for this PR.
  const pr = normalisePrForLens({ number: 3 });
  assert.deepEqual(pr.reviewComments, []);
  assert.deepEqual(pr.ciCheckNames, []);
});

test('windowDays measures the real span and never returns zero for a live repo', () => {
  assert.equal(windowDays([{ date: '2026-06-06' }, { date: '2026-07-25' }]), 49);
  // A single-day repo is one day, not zero — a zero window would make every per-week rate null.
  assert.equal(windowDays([{ date: '2026-07-25' }]), 1);
  assert.equal(windowDays([]), 0);
  assert.equal(windowDays([{ date: 'garbage' }]), 0);
});

test('benchmarks are CITED and linked, never republished', () => {
  assert.ok(BENCHMARKS.length >= 3);
  for (const b of BENCHMARKS) {
    assert.ok(b.id && b.label, 'every benchmark needs an identity');
    assert.match(b.url, /^https:\/\//, 'a citation without a link is not a citation');
    assert.ok(b.note.length > 20, 'state what the published level is, and that it is cited');
  }
});

test('the artifact always carries its caveats, whatever it is built from', () => {
  // The renderer cannot drop what it never had to opt into.
  const a = buildArtifact({ delivery: {}, source: {}, generatedAt: 'x' });
  assert.ok(a.caveats.length >= 3);
  assert.ok(a.caveats.some((c) => /not instrumented/i.test(c)));
  assert.ok(a.caveats.some((c) => /published benchmarks/i.test(c)));
  assert.equal(a.schemaVersion, 1);
});

test('the maturity section is included only when computed, never as an empty shell', () => {
  assert.equal(buildArtifact({ delivery: {}, source: {}, generatedAt: 'x' }).maturity, undefined);
  assert.ok(
    buildArtifact({ delivery: {}, source: {}, generatedAt: 'x', maturity: { verdict: {} } }).maturity
  );
});

// ── Regressions from cross-review round 2 (PR #32) ──────────────────────────────────────────
// The adapter dropped three fields the gatherer was already fetching, so the risk-tier and
// self-verification criteria read `not_instrumented` on every real repo and the ladder was capped
// at step 1. The same bug class as round 1 — fetch the data, forget to map it — in a second place.

test('the adapter maps riskTier, mergedByIsAgent and ciPassedBeforeMerge', () => {
  const pr = normalisePrForLens({
    number: 1,
    mergedAt: '2026-07-01T00:00:00Z',
    mergedBy: { login: 'danybgoode', is_bot: false },
    body: 'Risk tier: HIGH\n\nSome description.',
    statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }],
  });
  assert.equal(pr.riskTier, 'HIGH');
  assert.equal(pr.mergedByIsAgent, false);
  assert.equal(pr.ciPassedBeforeMerge, true);
});

test('both risk-tier spellings in the dataset are parsed', () => {
  // This repo's template writes `Risk tier:`; the sibling roadmap docs write `**Risk:** LOW`.
  assert.equal(parseRiskTier('Risk tier: LOW'), 'LOW');
  assert.equal(parseRiskTier('- [x] **Risk tier:** HIGH'), 'HIGH');
  assert.equal(parseRiskTier('**Risk:** MED'), 'MED');
  assert.equal(parseRiskTier('**Risk:** MEDIUM'), 'MED', 'MEDIUM normalises to MED');
  assert.equal(parseRiskTier('risk TIER : high'), 'HIGH', 'case and spacing are tolerated');
});

test('an UNDECLARED risk tier is undefined — never guessed, never defaulted', () => {
  // Coverage is partial by nature: many PR bodies declare no tier. Undefined means "not measured"
  // to the lens; any default would be a claim the body does not support.
  assert.equal(parseRiskTier('no tier here'), undefined);
  assert.equal(parseRiskTier(''), undefined);
  assert.equal(parseRiskTier(null), undefined);
  assert.equal(parseRiskTier(undefined), undefined);
});

test('a PR with NO checks reports ciPassedBeforeMerge as undefined, not false', () => {
  // "This PR ran no checks" and "we don't know whether checks passed" are different facts, and
  // `false` would assert the first.
  assert.equal(normalisePrForLens({ number: 1, statusCheckRollup: [] }).ciPassedBeforeMerge, undefined);
  assert.equal(normalisePrForLens({ number: 1 }).ciPassedBeforeMerge, undefined);
  // A failing check is a real false.
  assert.equal(
    normalisePrForLens({ number: 1, statusCheckRollup: [{ name: 'ci', conclusion: 'FAILURE' }] })
      .ciPassedBeforeMerge,
    false
  );
});

test('an UNMERGED pr has no merged-by verdict', () => {
  assert.equal(normalisePrForLens({ number: 1, mergedBy: { is_bot: true } }).mergedByIsAgent, undefined);
});

// ── Regressions from cross-review round 3 ───────────────────────────────────────────────────

test('a classic commit STATUS counts as success, not just a check-run conclusion', () => {
  // GitHub check-RUNS carry `conclusion`; classic commit STATUSES carry `state`. the first measured product uses
  // check-runs exclusively (94 of 94), so this dataset never exercises the second shape — but this
  // tool runs against CUSTOMER repos, and one posting statuses from an external CI would have had
  // every PR silently reported as failing its gate.
  assert.equal(checkSucceeded({ conclusion: 'SUCCESS' }), true);
  assert.equal(checkSucceeded({ state: 'SUCCESS' }), true);
  assert.equal(checkSucceeded({ state: 'success' }), true, 'case is tolerated');
  assert.equal(checkSucceeded({ conclusion: 'FAILURE' }), false);
  assert.equal(checkSucceeded({ state: 'PENDING' }), false);
  assert.equal(checkSucceeded({}), false);
  assert.equal(checkSucceeded(null), false);
});

test('the ADAPTER honours a classic commit status, not just the helper in isolation', () => {
  // This test exists because its absence let a real bug ship past three review rounds. Round 3
  // added `checkSucceeded` (handling both `conclusion` and `state`) and tested it DIRECTLY — but
  // the edit wiring it into the adapter silently failed, so `normalisePrForLens` kept its own
  // conclusion-only comparison. Every test still passed, because none of them exercised a classic
  // `state` through the adapter: the coverage was real for the helper and unreachable for the
  // integration. Exactly the "spec passes but cannot fail" trap Roadmap/LEARNINGS.md records.
  //
  // The distinguishing case is a SUCCEEDING classic status: it yields true only if the adapter
  // actually calls the helper, and false under the old conclusion-only code.
  const classicPass = normalisePrForLens({
    number: 1,
    statusCheckRollup: [{ name: 'ci', state: 'SUCCESS' }],
  });
  assert.equal(classicPass.ciPassedBeforeMerge, true, 'a passing classic status must count as passing');

  // A failing one must still fail — and note this case alone proves nothing, since it is false
  // under both implementations. That is why the assertion above has to exist.
  const classicFail = normalisePrForLens({
    number: 1,
    statusCheckRollup: [{ name: 'ci', state: 'FAILURE' }],
  });
  assert.equal(classicFail.ciPassedBeforeMerge, false);

  // Mixed shapes: every check must pass, whichever field carries its verdict.
  const mixed = normalisePrForLens({
    number: 1,
    statusCheckRollup: [{ conclusion: 'SUCCESS' }, { state: 'SUCCESS' }],
  });
  assert.equal(mixed.ciPassedBeforeMerge, true);
  const mixedFail = normalisePrForLens({
    number: 1,
    statusCheckRollup: [{ conclusion: 'SUCCESS' }, { state: 'FAILURE' }],
  });
  assert.equal(mixedFail.ciPassedBeforeMerge, false, 'one failing classic status fails the whole gate');
});

// ── Regression from cross-review round 6 ────────────────────────────────────────────────────

test('readCommits populates isRevert, and matches the SUBJECT not the body', () => {
  // `scoreTrustedSelfVerificationLoop` filters on `c.isRevert`; leaving it undefined made
  // revertCount 0 for EVERY repository — a 0% revert rate that means "never computed". It happened
  // to match this dataset (the first measured product genuinely has no reverts), which is exactly how it went
  // unnoticed for six rounds: accidentally right here, wrong everywhere else.
  const SEP = '\x1e';
  const US = '\x1f';
  const log = [
    `abc${US}2026-07-01${US}Revert "feat: the thing"${SEP}`,
    `def${US}2026-07-02${US}Revert: an older style${SEP}`,
    `ghi${US}2026-07-03${US}feat: ordinary work${SEP}`,
    // The false positive this repo's own history actually contains: a commit whose BODY explains
    // how to revert. Matching the body would count it, and it is not a revert.
    `jkl${US}2026-07-04${US}chore: adopt the plugin\n\nRevert path: git revert <sha> on main.${SEP}`,
  ].join('');
  const commits = readCommits('/irrelevant', () => log);

  assert.deepEqual(
    commits.map((c) => c.isRevert),
    [true, true, false, false],
    'only a genuine revert SUBJECT counts'
  );
});

test('readCommits still parses sha, date and agent authorship from a multi-line body', () => {
  const SEP = '\x1e';
  const US = '\x1f';
  const log = `abc${US}2026-07-01${US}feat: thing\n\nSome body.\n\nCo-Authored-By: Claude Opus 5 <x@y>${SEP}`;
  const [c] = readCommits('/irrelevant', () => log);
  assert.equal(c.sha, 'abc');
  assert.equal(c.date, '2026-07-01');
  assert.equal(c.agentCoAuthored, true, 'the trailer lives in the BODY, not the subject');
});

// ── Regression from cross-review round 8 ────────────────────────────────────────────────────

test('a check NAME is read from either shape — `name` or classic `context`', () => {
  // The third half-migration of the same two-shape API: round 3 taught `checkSucceeded` about
  // classic `state`, and the NAME beside it kept reading only `name`. A repo posting classic
  // statuses produced an empty ciCheckNames and a false `not_met` on code-quality enforcement.
  assert.equal(checkName({ name: 'Static gate + build' }), 'Static gate + build');
  assert.equal(checkName({ context: 'ci/circleci: build' }), 'ci/circleci: build');
  assert.equal(checkName({}), null);
  assert.equal(checkName(null), null);
});

test('the adapter collects names from BOTH check shapes', () => {
  const pr = normalisePrForLens({
    number: 1,
    statusCheckRollup: [
      { name: 'gate', conclusion: 'SUCCESS' },
      { context: 'ci/external', state: 'SUCCESS' },
    ],
  });
  assert.deepEqual(pr.ciCheckNames, ['gate', 'ci/external']);
  assert.equal(pr.ciPassedBeforeMerge, true, 'and both count toward the gate');
});

// ── Sprint 2.5a — wiring `--push` for real ───────────────────────────────────────────────────
// The bug this closes: the old `--push` printed a warning and exited 0 whether or not anything was
// actually stored. These pure helpers are what main() calls to decide WHERE to push, WITH what
// credential, and WHAT to send — each is worth pinning on its own, without a network or a real
// the first measured product checkout.

test('gatherSourceRef reads the ANALYSED repo, not this one, via an injectable git runner', () => {
  const calls = [];
  const run = (repo, args) => {
    calls.push([repo, args]);
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'deadbeef1234';
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main';
    return '';
  };
  const ref = gatherSourceRef('/some/client-shop', run);
  assert.deepEqual(ref, { commit: 'deadbeef1234', ref: 'main' });
  assert.ok(
    calls.every(([repo]) => repo === '/some/client-shop'),
    'every git call must target the analysed repo, never this checkout'
  );
});

test('gatherSourceRef returns null, never empty string, when git yields nothing', () => {
  // null (not '' and not undefined) matches buildPushEnvelope's own `?? null` and
  // scripts/roadmap-push.mjs's stated reason: JSON.stringify drops undefined keys silently, and an
  // empty string is a value a caller could mistake for a real (if odd) ref.
  assert.deepEqual(
    gatherSourceRef('/irrelevant', () => ''),
    { commit: null, ref: null }
  );
});

test('resolvePushConfig prefers POD_REPORT_API_KEY over SELF_PROJECT_API_KEY', () => {
  const cfg = resolvePushConfig({
    POD_REPORT_API_KEY: 'pod-key',
    SELF_PROJECT_API_KEY: 'self-key',
  });
  assert.equal(cfg.apiKey, 'pod-key', 'the Pod Report may push to a different tenant than the roadmap');
});

test('resolvePushConfig falls back to SELF_PROJECT_API_KEY when POD_REPORT_API_KEY is unset', () => {
  const cfg = resolvePushConfig({ SELF_PROJECT_API_KEY: 'self-key' });
  assert.equal(cfg.apiKey, 'self-key');
});

test('resolvePushConfig yields a null apiKey when neither env var is set — the clean-skip signal', () => {
  const cfg = resolvePushConfig({});
  assert.equal(cfg.apiKey, null);
  // outcome-report-any-product D4 (decision b): a stranger's push reaches the hosted engine with only its key.
  assert.equal(cfg.baseUrl, 'https://goldenfrijoles.com');
});

test('resolvePushConfig falls back to GROWTH_ENGINE_API_KEY last — the name `frijoles init --ingest` writes', () => {
  assert.equal(resolvePushConfig({ GROWTH_ENGINE_API_KEY: 'ingest' }).apiKey, 'ingest');
  assert.equal(
    resolvePushConfig({ GROWTH_ENGINE_API_KEY: 'ingest', SELF_PROJECT_API_KEY: 'self' }).apiKey,
    'self'
  );
});

test('readPodEnvFile reads only its own names, strips quotes, and the last assignment wins', () => {
  const env = readPodEnvFile(
    'GROWTH_ENGINE_API_KEY=first\nexport GROWTH_ENGINE_API_KEY="second"\nOTHER=x\nGROWTH_ENGINE_URL=\'https://e.test\'\n'
  );
  assert.deepEqual(env, { GROWTH_ENGINE_API_KEY: 'second', GROWTH_ENGINE_URL: 'https://e.test' });
});

test('resolvePushConfig reads GROWTH_ENGINE_URL when set', () => {
  const cfg = resolvePushConfig({ GROWTH_ENGINE_URL: 'https://goldenfrijoles.com' });
  assert.equal(cfg.baseUrl, 'https://goldenfrijoles.com');
});

test('buildPushEnvelope adds git provenance WITHOUT displacing the dataset counts', () => {
  const artifact = buildArtifact({
    delivery: { cycleTimeDays: 1 },
    source: { repo: 'client-shop', commits: 841, epics: 133, mergedPrs: 98, windowDays: 400 },
    generatedAt: '2026-07-25T00:00:00.000Z',
  });
  const envelope = buildPushEnvelope(artifact, { commit: 'abc1234', ref: 'main' });

  assert.equal(envelope.schemaVersion, POD_REPORT_SCHEMA_VERSION);
  assert.equal(envelope.generatedAt, artifact.generatedAt);
  assert.deepEqual(envelope.delivery, artifact.delivery);
  assert.deepEqual(envelope.caveats, artifact.caveats);

  // Git provenance rides in its OWN key. An earlier draft put it in `source`, which meant the push
  // overwrote Story 2.1's dataset provenance — so every PUSHED report rendered "measured over ⟨⟩"
  // with no counts, while a locally printed one looked perfect. This pair of assertions is what
  // distinguishes the two implementations, so it is the pair that has to exist.
  assert.deepEqual(envelope.pushSource, { commit: 'abc1234', ref: 'main' });
  assert.deepEqual(envelope.source, artifact.source, 'the dataset counts must survive the push');
  assert.equal(envelope.source.commits, 841);
});

test('buildPushEnvelope emits explicit nulls, never undefined, for a missing commit/ref', () => {
  const artifact = buildArtifact({ delivery: {}, source: {}, generatedAt: 'x' });
  const envelope = buildPushEnvelope(artifact, {});
  assert.equal(envelope.pushSource.commit, null);
  assert.equal(envelope.pushSource.ref, null);
  const round = JSON.parse(JSON.stringify(envelope));
  assert.ok('commit' in round.pushSource, 'commit must survive serialisation as an explicit null');
  assert.ok('ref' in round.pushSource, 'ref must survive serialisation as an explicit null');
});

// The engine's schema module lives in the product repo, not in the kit's mirror: the pin runs where the file is, and
// says why it skips elsewhere (the roadmap-push.test.mjs precedent).
const POD_SCHEMA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps',
  'web',
  'lib',
  'pod-report-schema.ts'
);

test(
  'the script and the server agree on POD_REPORT_SCHEMA_VERSION',
  { skip: !existsSync(POD_SCHEMA) && 'the engine source is not in this checkout' },
  () => {
    // Duplicated on purpose (this zero-dependency .mjs cannot import the TypeScript module behind
    // Next's `@/` alias) — the same convention roadmap-push.test.mjs pins for ROADMAP_SCHEMA_VERSION.
    const ts = readFileSync(POD_SCHEMA, 'utf8');
    const m = ts.match(/export const POD_REPORT_SCHEMA_VERSION = (\d+)/);
    assert.ok(m, 'could not find POD_REPORT_SCHEMA_VERSION in the schema module — did it move?');
    assert.equal(
      Number(m[1]),
      POD_REPORT_SCHEMA_VERSION,
      'scripts/pod-report.mjs and lib/pod-report-schema.ts disagree on the schema version'
    );
  }
);

test('source.repo names the ANALYSED checkout, never a hardcoded dataset', () => {
  // This was the literal string 'the first measured product', so pointing --repo anywhere else produced an
  // artifact claiming to measure the first measured product — a false provenance line on a document whose whole
  // value is traceability. Invisible with one dataset; found the first time a second repo was
  // measured. The basename is also REPO_PR_BASE's key in the renderer, so a wrong name silently
  // downgrades every `pr` evidence pointer to plain text instead of linking it.
  assert.equal(basename('/Users/someone/dobby/golden-beans'), 'golden-beans');
  assert.equal(basename('/Users/someone/dobby/client-shop'), 'client-shop');
  // And the constant is gone from the source — the assertion that would actually have caught it.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pod-report.mjs'), 'utf8');
  assert.equal(
    /repo:\s*'[^']+'/.test(src),
    false,
    'source.repo must be derived from the checkout, not hardcoded'
  );
});

// ── outcome-report-any-product D1/D2 — dates and rework from each README's REAL status history ──────────────────
// Real throwaway git repos, so the git half (`git log` + one `git cat-file --batch`) is exercised, not mocked.

/**
 * The environment with every GIT_* variable removed (the `sealedEnv()` pattern, git-fixtures-sealed.test.mjs): from a
 * linked worktree's hook, git exports GIT_DIR pointing at the REAL repository, and it beats `cwd`.
 */
function sealedEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return { ...env, ...extra };
}
// readEpics (the code under test) spawns git with the PROCESS environment, so it is sealed here too.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];

function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pod-history-'));
  const git = (...args) => {
    const r = run('git', args, { cwd: dir, encoding: 'utf8', env: sealedEnv() });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q');
  git('config', 'user.email', 'spec@example.test');
  git('config', 'user.name', 'spec');
  const commit = (path, text, subject, date) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFile(join(dir, path), text);
    git('add', path);
    const r = run('git', ['commit', '-q', '-m', subject], {
      cwd: dir,
      env: sealedEnv({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
    });
    if (r.status !== 0) throw new Error(`git commit ${subject}: ${r.stderr}`);
  };
  return { dir, commit };
}

const readme = (status, body = '') => `---\nstatus: ${status}\n---\n# Epic\n${body}\n`;
// The template's own Definition-of-Done line — the text the old `git log -S 'status: shipped'` matched at creation.
const TEMPLATE_BODY = "- [ ] this README's frontmatter `status: shipped` (the SSOT)";

test("the template's own `status: shipped` text is NOT a ship — the status line is (the bug the old search had)", () => {
  const { dir, commit } = scratchRepo();
  const path = 'Roadmap/01-x/alpha/README.md';
  commit(path, readme('scaffolded', TEMPLATE_BODY), 'plan alpha', '2026-01-01T10:00:00Z');
  commit(path, readme('shipped', TEMPLATE_BODY), 'ship alpha', '2026-01-04T10:00:00Z');
  const [epic] = readEpics(dir);
  assert.equal(epic.slug, 'alpha');
  assert.equal(Date.parse(epic.startedAt), Date.parse('2026-01-01T10:00:00Z'));
  assert.equal(Date.parse(epic.shippedAt), Date.parse('2026-01-04T10:00:00Z'));
});

test('a quoted status counts; a reworded comment on the status line is not a change; never shipped stays null', () => {
  const { dir, commit } = scratchRepo();
  commit('Roadmap/01-x/quoted/README.md', readme('in-progress'), 'start', '2026-02-01T00:00:00Z');
  commit('Roadmap/01-x/quoted/README.md', readme('"shipped"   # done'), 'ship', '2026-02-03T00:00:00Z');
  commit(
    'Roadmap/01-x/quoted/README.md',
    readme('shipped   # done, reworded'),
    'comment',
    '2026-02-05T00:00:00Z'
  );
  commit(
    'Roadmap/01-x/parked/README.md',
    readme('scaffolded', TEMPLATE_BODY),
    'plan',
    '2026-02-01T00:00:00Z'
  );
  const epics = Object.fromEntries(readEpics(dir).map((epic) => [epic.slug, epic]));
  assert.equal(Date.parse(epics.quoted.shippedAt), Date.parse('2026-02-03T00:00:00Z'));
  assert.deepEqual(
    epics.quoted.statusHistory.map((change) => [change.from, change.to]),
    [
      [null, 'in-progress'],
      ['in-progress', 'shipped'],
    ]
  );
  assert.equal(epics.parked.shippedAt, null);
});

test('a re-opened epic keeps its FIRST ship for lead time, and rework counts it with the re-opening subject', () => {
  const { dir, commit } = scratchRepo();
  const path = 'Roadmap/01-x/beta/README.md';
  commit(path, readme('in-progress'), 'start beta', '2026-03-01T00:00:00Z');
  commit(path, readme('shipped'), 'ship beta', '2026-03-03T00:00:00Z');
  commit(path, readme('in-progress'), 'reopen beta: a regression', '2026-03-10T00:00:00Z');
  commit(path, readme('shipped'), 'ship beta again', '2026-03-12T00:00:00Z');
  const [epic] = readEpics(dir);
  assert.equal(Date.parse(epic.shippedAt), Date.parse('2026-03-03T00:00:00Z'));
  assert.equal(Date.parse(epic.reopenedAt), Date.parse('2026-03-10T00:00:00Z'));
  assert.equal(epic.reopenedBy, 'reopen beta: a regression');
  const rework = reworkSummary([epic]);
  assert.deepEqual(
    {
      reopened: rework.reopened,
      of: rework.of,
      median: rework.medianDaysToReship,
      subject: rework.epics[0].subject,
    },
    { reopened: 1, of: 1, median: 2, subject: 'reopen beta: a regression' }
  );
});

test("⚠️ a file's URL is never paired with the shell's key (security lens, vibe, #368)", () => {
  const shell = { GROWTH_ENGINE_API_KEY: 'mine', GROWTH_ENGINE_URL: 'https://goldenfrijoles.com' };
  // A cloned repo's .env.local that names only a host: ignored — the push stays where the person's key belongs.
  assert.deepEqual(resolvePushConfig(pushEnvFrom(shell, { GROWTH_ENGINE_URL: 'https://evil.test' })), {
    baseUrl: 'https://goldenfrijoles.com',
    apiKey: 'mine',
  });
  // A file that supplies its own key brings its own URL — and the shell's key and URL are not mixed in.
  assert.deepEqual(
    resolvePushConfig(
      pushEnvFrom(shell, { GROWTH_ENGINE_URL: 'https://local.test', GROWTH_ENGINE_API_KEY: 'filekey' })
    ),
    { baseUrl: 'https://local.test', apiKey: 'filekey' }
  );
  assert.deepEqual(
    resolvePushConfig(
      pushEnvFrom({ GROWTH_ENGINE_URL: 'https://evil.test' }, { GROWTH_ENGINE_API_KEY: 'filekey' })
    ),
    {
      baseUrl: 'https://goldenfrijoles.com',
      apiKey: 'filekey',
    }
  );
});
