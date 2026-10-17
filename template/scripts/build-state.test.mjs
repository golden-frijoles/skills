// build-state.test.mjs — the resolver against REAL fixture git repos (build-visualization-claude-mods S3).
// `gh` is injected: a fake that records calls, so --offline can prove it made none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveBuildState,
  renderLines,
  sprintBars,
  wrapWords,
  WHY_LINES_MAX,
  stageTrack,
  parseBranch,
  branchCandidates,
  parseWorktrees,
  storyIdsIn,
  storyIdsInWithContinuations,
  namesSlug,
} from './build-state.mjs';
import { PHASES } from './lib/roadmap-contract.mjs';

const LOCKED = '2026-10-01T00:00:00Z';
/** The track line, unlabelled under the header (build-view-one-story D1): its text without the indent. */
const statusOf = (lines) => (lines.find((l) => /^ {2}\S/.test(l) && l.includes(' ─ ')) ?? '').slice(2);
// `lockedAt: null` leaves the stamp out — an epic whose architecture lock has not been run (live-build-view D11).
const EPIC_README = (phase = 'Building', lockedAt = LOCKED) => `---
status: in-progress
slug: arranged-only${lockedAt ? `\nlocked_at: "${lockedAt}"` : ''}
title: Arranged-only delivery
area: 04-shipping
risk: high
type: feature
phase: ${phase}
sprints_total: 2
stories_total: 3
---
# Epic: Arranged-only delivery
`;
const SPRINT = (n, phase, stories) => `---
epic: arranged-only
sprint: ${n}
title: Sprint ${n} title
risk: high
phase: ${phase}
stories_total: ${stories.length}
stories:
${stories
  .map(
    ([id, title]) =>
      `  - id: ${id}\n    title: ${title}\n    as_a: "a buyer's agent"\n    i_want: checkout options to reflect arranged-only listings\n    so_that: "I'm never offered a carrier rail"\n    risk: high\n    status: planned`
  )
  .join('\n')}
---
# Arranged-only delivery — Sprint ${n}: title
`;

// ⚠️ SEALED against the repository this file runs in — the same leak pre-push-hook.test.mjs records. git
// exports GIT_DIR (and friends) into hooks, and from a LINKED WORKTREE they point at the real repo's gitdir;
// GIT_DIR overrides `cwd`. Unsealed, this fixture's `git init` / `config user.*` / `commit` rewrote a real
// repository on 2026-09-23 (a consumer's pre-push from a worktree: `core.bare = true`, identity `t <t@t>`,
// three "plan: scaffold" commits on its local main). git-fixtures-sealed.test.mjs now fails any spec that
// runs `git init` without this.
const GIT_ENV_TO_CLEAR = [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX',
];
function sealedEnv(base = process.env) {
  const env = { ...base };
  for (const k of GIT_ENV_TO_CLEAR) delete env[k];
  return env;
}

function fixture({ sprint1 = 'Shipped', sprint2 = 'Building', epicPhase = 'Building' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'build-state-'));
  const git = (...a) =>
    execFileSync('git', a, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: sealedEnv(),
    }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const dir = join(root, 'Roadmap', '04-shipping', 'arranged-only');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), EPIC_README(epicPhase));
  writeFileSync(join(dir, 'sprint-1.md'), SPRINT(1, sprint1, [['S1.1', 'Contract']]));
  writeFileSync(
    join(dir, 'sprint-2.md'),
    SPRINT(2, sprint2, [
      ['S2.1', 'Agent surface parity'],
      ['S2.2', 'Seller toggle'],
    ])
  );
  git('add', '-A');
  git('commit', '-qm', 'plan: scaffold');
  const commit = (msg) => {
    writeFileSync(join(root, `f${Math.random()}`), msg);
    git('add', '-A');
    git('commit', '-qm', msg);
  };
  return { root, git, commit, done: () => rmSync(root, { recursive: true, force: true }) };
}

const noGh = () => {
  throw new Error('gh must not be called');
};
const ghWith = (pr) => {
  const calls = [];
  const fn = (root, branch) => (calls.push(branch), { ok: true, pr });
  fn.calls = calls;
  return fn;
};

test('parseBranch and storyIdsIn: the conventions D2 reads', () => {
  assert.deepEqual(parseBranch('feat/arranged-only'), { slug: 'arranged-only', sprint: null });
  assert.deepEqual(parseBranch('feat/arranged-only-s3'), { slug: 'arranged-only', sprint: 3 });
  assert.deepEqual(parseBranch('chore/x-sprint-2'), { slug: 'x', sprint: 2 });
  assert.equal(parseBranch('main'), null);
  assert.deepEqual(storyIdsIn('S1.1–S1.4 — the contract (Story 2.10)'), ['S1.1', 'S1.4', 'S2.10']);
  assert.deepEqual(storyIdsIn('fix typo, see PRS1.2x'), []);
});

test('a clean feature branch mid-sprint: epic, story + user story, progress, status', () => {
  const f = fixture();
  try {
    f.git('switch', '-qc', 'feat/arranged-only-s2');
    f.commit('S2.1 — agent surface parity [risk HIGH]');
    const s = resolveBuildState({ root: f.root, offline: true, gh: noGh });
    assert.equal(s.in_flight, true);
    assert.deepEqual(s.epic, {
      slug: 'arranged-only',
      title: 'Arranged-only delivery',
      area: '04-shipping',
      risk: 'high',
      phase: 'Building',
      locked_at: LOCKED,
      path: 'Roadmap/04-shipping/arranged-only/README.md',
    });
    assert.equal(s.story.id, 'S2.1');
    assert.equal(s.story.as_a, "a buyer's agent");
    assert.equal(s.story_source, 'commit');
    assert.deepEqual(s.progress, {
      stories_with_commits: 1,
      by_sprint: [
        { n: 1, done: 0, total: 1 },
        { n: 2, done: 1, total: 2 },
      ],
      story: 2,
      stories: 3,
      sprint: 2,
      header_sprint: 2,
      sprints: 2,
    });
    assert.equal(s.status, 'Building');
    assert.equal(s.evidence.gh, 'skipped (--offline)');

    f.commit('S2.2 — seller toggle');
    assert.equal(
      resolveBuildState({ root: f.root, offline: true, gh: noGh }).progress.story,
      3,
      'X advances by one'
    );
    // S2.2 — a repeat counts once; an id the epic does not list (S1.2) never counts; sprint 1's id on a -s2 branch does.
    f.commit('S1.1/1.2 — from before the commit-msg check');
    f.commit('S2.2 — a second commit on the same story');
    const p = resolveBuildState({ root: f.root, offline: true, gh: noGh });
    assert.equal(p.progress.stories_with_commits, 3, 'S1.1 + S2.1 + S2.2; S1.2 is not a story of this epic');
    // build-view-one-story D2 — the header says what and how far; the bar sits at column 100.
    // (The fixture's repo is a long temp-dir name, so the bar takes its own line rather than cutting the title.)
    const [head, bar] = renderLines(p);
    assert.match(head, /^build-state-\S+ \S Sprint 2 of 2 · Arranged-only delivery · ▲ risk HIGH$/);
    assert.equal(bar, '  ▰│▰▰  3 of 3 stories done');
    // D6 — the tree is clean and HEAD is S2.2's commit, so the work is between stories, and none is left.
    assert.equal(p.between, true);
    assert.equal(
      renderLines(p).find((l) => l.startsWith('  ▸ Now')),
      '  ▸ Now      between stories: S2.2 done, every story has a commit'
    );
  } finally {
    f.done();
  }
});

test('S2.2: a pre-S2.1 bundle naming two stories in one subject counts both', () => {
  const f = fixture();
  try {
    f.git('switch', '-qc', 'feat/arranged-only-s2');
    f.commit('S2.1/2.2 — both stories in one commit');
    const s = resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh });
    assert.equal(s.progress.stories_with_commits, 2);
  } finally {
    f.done();
  }
});

test('the default branch, a branch naming no epic, and a detached HEAD all say "nothing in flight"', () => {
  const f = fixture();
  try {
    const main = resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh });
    assert.equal(main.in_flight, false);
    assert.match(main.reason, /on main — not an epic branch/);
    f.git('switch', '-qc', 'feat/some-other-epic');
    const other = resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh });
    assert.equal(other.in_flight, false);
    assert.match(other.reason, /names no epic under Roadmap\//);
    f.git('checkout', '-q', '--detach');
    const detached = resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh });
    assert.equal(detached.in_flight, false);
    assert.match(detached.reason, /detached HEAD/);
    // build-view-one-story D8 — an epic the Roadmap calls in-progress is counted in Around, never listed one by one
    // (the JSON keeps it); with no board here there is nothing to count, so the view is the header alone.
    assert.deepEqual(renderLines(detached), [`${detached.repo} ○ No epic on this branch · detached HEAD`]);
    assert.equal(detached.elsewhere.open_epics[0].slug, 'arranged-only');
    // A branch that names nothing says why; the plain "not an epic branch" case does not repeat the header.
    assert.deepEqual(renderLines(main), [`${main.repo} ○ No epic on this branch · main`]);
    assert.equal(renderLines(other)[1], `  ▸ Now      ${other.reason}`);
  } finally {
    f.done();
  }
});

test('commits with no story convention and no journal → story unknown, never a guess', () => {
  const f = fixture();
  try {
    f.git('switch', '-qc', 'feat/arranged-only');
    f.commit('wip: tidy things');
    const s = resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh });
    assert.equal(s.story, null);
    assert.equal(s.story_source, 'unknown');
    assert.equal(s.sprint, null, 'no -s<N> and no story → no sprint either, not "the first unshipped one"');
    assert.equal(s.progress.story, null);
    const lines = renderLines(s);
    assert.ok(lines.includes('  ⌖ Target   none set'), 'no target and no reason: "none set", nothing invented');
    assert.ok(lines.includes('  ▸ Now      no story started yet · S1.1 next'), 'never "session journal"');
    // D2 — no story and no -sN: the header's sprint is the first with a story left, never "?".
    assert.match(lines[0], /^\S+ \S Sprint 1 of 2 · Arranged-only delivery · ▲ risk HIGH$/);
    assert.equal(lines[1], '  ▱│▱▱  0 of 3 stories done');
    assert.ok(!lines.join('\n').includes('journal'));
  } finally {
    f.done();
  }
});

test('a commit naming a story this epic does not list → unknown, with the reason', () => {
  const f = fixture();
  try {
    f.git('switch', '-qc', 'feat/arranged-only');
    f.commit('S9.9 — something from another epic');
    const s = resolveBuildState({ root: f.root, offline: true, gh: noGh });
    assert.equal(s.story, null);
    assert.match(s.story_note, /the newest story commit names S9\.9, which no sprint of this epic lists/);
  } finally {
    f.done();
  }
});

test('the journal fallback resolves the story when commits do not', () => {
  const f = fixture();
  try {
    f.git('switch', '-q', '--orphan', 'claude/session-journal');
    writeFileSync(
      join(f.root, 'session-journal.jsonl'),
      `${JSON.stringify({ ts: '2020-01-01T00:00:00Z', kind: 'doing', text: 'starting S1.1', refs: [] })}\n` +
        `${JSON.stringify({ ts: '2020-01-02T00:00:00Z', kind: 'doing', text: 'arranged-only: on the seller toggle', refs: ['S2.2'] })}\n` +
        `${JSON.stringify({ ts: '2020-01-03T00:00:00Z', kind: 'doing', text: 'golden-flags-by-default S1.1 wiring', refs: [] })}\n`
    );
    f.git('add', 'session-journal.jsonl');
    f.git('commit', '-qm', 'journal');
    f.git('switch', '-q', 'main');
    f.git('switch', '-qc', 'feat/arranged-only');
    f.commit('wip');
    const s = resolveBuildState({ root: f.root, offline: true, gh: noGh });
    assert.equal(s.story.id, 'S2.2');
    assert.equal(s.story_source, 'journal');
    assert.equal(s.evidence.journal, 'claude/session-journal');
  } finally {
    f.done();
  }
});

test('every one of the six phases is reported as written when no evidence advances it', () => {
  for (const phase of PHASES) {
    const f = fixture({ sprint2: phase });
    try {
      f.git('switch', '-qc', 'feat/arranged-only-s2');
      f.commit('wip: no story named');
      const s = resolveBuildState({ root: f.root, offline: true, gh: noGh });
      assert.equal(s.status, phase, phase);
      assert.equal(s.status_source, 'written');
      assert.equal(s.phase_written, phase);
    } finally {
      f.done();
    }
  }
});

test('evidence only advances: a story commit lifts to Building, an open PR to In review — never to Shipped', () => {
  const f = fixture({ sprint2: 'Shaping' });
  try {
    f.git('switch', '-qc', 'feat/arranged-only-s2');
    f.commit('S2.1 — first');
    const building = resolveBuildState({ root: f.root, offline: true, gh: noGh });
    assert.deepEqual(
      [building.status, building.status_source, building.phase_written],
      ['Building', 'git', 'Shaping']
    );

    const gh = ghWith({ number: 7, url: 'https://example/pr/7' });
    const review = resolveBuildState({ root: f.root, gh });
    assert.deepEqual([review.status, review.status_source], ['In review', 'gh']);
    assert.deepEqual(gh.calls, ['feat/arranged-only-s2']);

    const unavailable = resolveBuildState({ root: f.root, gh: () => ({ ok: false, pr: null }) });
    assert.equal(unavailable.status, 'Building');
    assert.equal(unavailable.evidence.gh, 'unavailable');
  } finally {
    f.done();
  }
  const shipped = fixture({ sprint2: 'Shipped' });
  try {
    shipped.git('switch', '-qc', 'feat/arranged-only-s2');
    shipped.commit('S2.1 — first');
    const s = resolveBuildState({ root: shipped.root, gh: ghWith({ number: 1 }) });
    assert.equal(s.status, 'Shipped', 'a written Shipped is never pulled back to In review');
  } finally {
    shipped.done();
  }
});

// ── build-view-one-story S1.7 — each state of the design approved 2026-10-14, rendered from resolver output ──────────
// The seed's *The design* draws these; the states below are the resolver's JSON for them. A change to any line is a
// change to the approved design and should arrive with the product owner's say-so.
const NOW = new Date('2026-10-14T12:00:00Z');
const HUB = 'https://goldenfrijoles.com/hub/golden-frijoles';
const board = (over = {}) => ({ building: 0, qa: 1, ready: 6, next: { name: 'Drill impact for agents', slug: 'drill-impact-for-agents', build_order: 93, grain: 'Epic' }, url: `${HUB}/epic/funnel-truth`, ...over });
const building = {
  in_flight: true,
  kind: 'epic',
  repo: 'golden-frijoles',
  branch: 'feat/funnel-truth',
  lifecycle: 'in-progress',
  stage: 'Building',
  stage_source: 'git: feat/funnel-truth',
  epic: { slug: 'funnel-truth', title: 'Funnel truth', risk: 'high', phase: 'Building', locked_at: '2026-10-15T00:00:00Z', path: 'Roadmap/02-commercial/funnel-truth/README.md' },
  size: 'L',
  sprint: { n: 1, title: 'The trend', phase: 'Building' },
  phase_written: 'Building',
  story: { id: 'S1.3', title: 'The trend on the flag page and the epic page', as_a: 'a founder reading a feature', i_want: 'the trend where I read its funnel', so_that: 'I judge the bet over its whole life' },
  story_source: 'commit',
  between: false,
  next_story: { id: 'S1.4', title: 'x' },
  target: { hypothesis: "A funnel today is one number per period. Showing it by month lets founders judge a bet over its whole life. We'll know when members open funnel trends.", metric: 'members opening a trend', from: 0, to: 3, read_date: '2026-11-13', grounded_reason: null, intent_match: 84, verdict: null },
  progress: { stories_with_commits: 2, by_sprint: [{ n: 1, done: 2, total: 3 }, { n: 2, done: 0, total: 5 }], story: 3, stories: 8, sprint: 1, header_sprint: 1, sprints: 2 },
  spend: { usd: 22, usd_known: true, mtok: 1.1, sessions: 1, basis: 'this machine', push_rejected: 0 },
  quote: { low: 49, high: 68, basis: 'L, n=24, p25–p75' },
  evidence: { story_commits: 2 },
  board: board(),
  elsewhere: { worktrees: [], open_epics: [] },
};
const refining = {
  in_flight: true,
  kind: 'feature',
  repo: 'golden-frijoles',
  branch: 'refine/owed-on-screen',
  lifecycle: 'ready',
  status: 'ready',
  stage: 'Grooming',
  seed: { slug: 'owed-on-screen', title: 'Owed on screen', type: 'feature', appetite: 'M', risk: 'high', path: 'Roadmap/00-ideas/seeds/owed-on-screen.md', status: 'ready', quote: { low: 15, high: 34, basis: 'M, n=24, p25–p75' } },
  target: { hypothesis: 'Owed checks live only in a file nobody opens. Showing them where you already look cuts the open count. We\'ll know when it falls.', metric: null, grounded_reason: null, intent_match: 81 },
  evidence: { commits: 0 },
  board: board({ building: 1, qa: 0, ready: 6, next: { name: 'A delivery whose settle fails is reclaimed', slug: 'delivery-stale-reclaim-uncounted', build_order: 87, grain: 'Epic' }, url: `${HUB}/epic/owed-on-screen` }),
  elsewhere: { worktrees: [], open_epics: [] },
};
const idle = {
  in_flight: false,
  repo: 'golden-frijoles',
  reason: 'on docs/seed-consolidation — not an epic branch (feat/<slug>…), so no epic in flight',
  branch: 'docs/seed-consolidation',
  quiet: true,
  board: { building: 1, qa: 1, ready: 7, next: { name: 'Delivery stale reclaim', slug: 'delivery-stale-reclaim-uncounted', build_order: 87, grain: 'Epic' }, url: `${HUB}/board` },
  elsewhere: {
    worktrees: [
      { kind: 'epic', slug: 'outcome-report-any-product', title: 'The outcome report for any product', story: 'S1.3', status: 'Building' },
      { kind: 'epic', slug: 'golden-welcome', title: 'A golden welcome and recovery pages', story: null, status: 'QA' },
    ],
    open_epics: [],
  },
};
const qa = {
  ...building,
  stage: 'QA',
  epic: { ...building.epic, slug: 'owed-on-screen', title: 'Owed on screen' },
  size: 'M',
  progress: { stories_with_commits: 6, by_sprint: [{ n: 1, done: 2, total: 2 }, { n: 2, done: 4, total: 4 }], story: 6, stories: 6, sprint: 2, header_sprint: 2, sprints: 2 },
  story: { ...building.story, id: 'S2.4' },
  between: true,
  next_story: null,
};
const shipped = {
  ...building,
  lifecycle: 'shipped',
  stage: 'Shipped',
  shipped_on: '2026-10-10',
  epic: { ...building.epic, slug: 'one-bet-wired', title: 'One bet, wired', phase: 'Shipped' },
  phase_written: 'Shipped',
  target: { ...building.target, read_date: null, metric: 'flags with a funnel', from: 0, to: 2 },
  progress: { stories_with_commits: 6, by_sprint: [{ n: 1, done: 3, total: 3 }, { n: 2, done: 3, total: 3 }], story: null, stories: 6, sprint: null, header_sprint: 2, sprints: 2 },
  story: null,
  evidence: { story_commits: 0 },
  spend: { ...building.spend, usd: 61, sessions: 4 },
  quote: { low: 49, high: 79, basis: 'L, n=24, p25–p75' },
  board: board({ url: `${HUB}/epic/one-bet-wired` }),
};
const disagreeing = {
  ...building,
  stage: 'Building',
  epic: { ...building.epic, phase: 'Shaping', locked_at: null },
  phase_written: 'Shaping',
};

const GOLDEN = {
  building: [
    "golden-frijoles ▶ Sprint 1 of 2 · Funnel truth · L · ▲ risk HIGH      ▰▰▱│▱▱▱▱▱  2 of 8 stories done",
    "  Refining ─ Ready ─ ◉ Building ─ QA ─ Shipped",
    "  ↗ https://goldenfrijoles.com/hub/golden-frijoles/epic/funnel-truth",
    "  ❝ Why      A funnel today is one number per period. Showing it by month lets founders judge a bet",
    "             over its whole life. We'll know when members open funnel trends.",
    "  ⌖ Target   members opening a trend: 0 → 3 · read 13 Nov · intent match 84",
    "  ▸ Now      S1.3 The trend on the flag page and the epic page",
    "             As a founder reading a feature, I want the trend where I read its funnel, so that I",
    "             judge the bet over its whole life.",
    "  $ Spend    ▰▰▰▱▱▱▱▱▱▱  ≈$22 of the $49–68 quote · 1 session",
    "  ⋯ Around   1 in QA · 6 ready · next up: Drill impact for agents (#93)",
  ],
  refining: [
    "golden-frijoles ❧ Idea · Owed on screen · M · ▲ risk HIGH                               quote $15–34",
    "  ◉ Refining ─ Ready ─ Building ─ QA ─ Shipped",
    "  ↗ Roadmap/00-ideas/seeds/owed-on-screen.md",
    "  ❝ Why      Owed checks live only in a file nobody opens. Showing them where you already look cuts",
    "             the open count. We'll know when it falls.",
    "  ▸ Now      plan ready, waiting for your approval",
    "  ⋯ Around   1 building · 6 ready · next up: A delivery whose settle fails is reclai… (#87)",
  ],
  idle: [
    "golden-frijoles ○ No epic on this branch · docs/seed-consolidation",
    "  ↗ https://goldenfrijoles.com/hub/golden-frijoles/board",
    "  ⋯ Around   1 building · 1 in QA · 7 ready",
    "             in other worktrees: The outcome report for any product (S1.3, Building) · A golden",
    "             welcome and recovery pages (QA)",
    "  → Next     /build delivery-stale-reclaim-uncounted   (top of the ready list)",
  ],
  qa: [
    "golden-frijoles ◎ Sprint 2 of 2 · Owed on screen · M · ▲ risk HIGH      ▰▰│▰▰▰▰  6 of 6 stories done",
    "  Refining ─ Ready ─ Building ─ ◉ QA ─ Shipped",
    "  ↗ https://goldenfrijoles.com/hub/golden-frijoles/epic/funnel-truth",
    "  ❝ Why      A funnel today is one number per period. Showing it by month lets founders judge a bet",
    "             over its whole life. We'll know when members open funnel trends.",
    "  ⌖ Target   members opening a trend: 0 → 3 · read 13 Nov · intent match 84",
    "  ▸ Now      between stories: S2.4 done, every story has a commit",
    "  $ Spend    ▰▰▰▱▱▱▱▱▱▱  ≈$22 of the $49–68 quote · 1 session",
    "  ⋯ Around   1 in QA · 6 ready · next up: Drill impact for agents (#93)",
  ],
  shipped: [
    "golden-frijoles ✓ Sprint 2 of 2 · One bet, wired · L · ▲ risk HIGH      ▰▰▰│▰▰▰  6 of 6 stories done",
    "  Refining ─ Ready ─ Building ─ QA ─ ◉ Shipped",
    "  ↗ https://goldenfrijoles.com/hub/golden-frijoles/epic/one-bet-wired",
    "  ❝ Why      A funnel today is one number per period. Showing it by month lets founders judge a bet",
    "             over its whole life. We'll know when members open funnel trends.",
    "  ⌖ Target   flags with a funnel: 0 → 2 · read 30 days after shipping · intent match 84",
    "  ▸ Now      shipped 10 Oct · verdict due 9 Nov",
    "  $ Spend    ▰▰▰▰▰▰▰▰▱▱  ≈$61 of the $49–79 quote · 4 sessions",
    "  ⋯ Around   1 in QA · 6 ready · next up: Drill impact for agents (#93)",
  ],
  disagreeing: [
    "golden-frijoles ▶ Sprint 1 of 2 · Funnel truth · L · ▲ risk HIGH      ▰▰▱│▱▱▱▱▱  2 of 8 stories done",
    "  Refining ─ Ready ─ ◉ Building ─ QA ─ Shipped",
    "  ⚑ the epic's docs say Shaping, but this branch has story commits",
    "  ↗ https://goldenfrijoles.com/hub/golden-frijoles/epic/funnel-truth",
    "  ❝ Why      A funnel today is one number per period. Showing it by month lets founders judge a bet",
    "             over its whole life. We'll know when members open funnel trends.",
    "  ⌖ Target   members opening a trend: 0 → 3 · read 13 Nov · intent match 84",
    "  ▸ Now      S1.3 The trend on the flag page and the epic page",
    "             As a founder reading a feature, I want the trend where I read its funnel, so that I",
    "             judge the bet over its whole life.",
    "  $ Spend    ▰▰▰▱▱▱▱▱▱▱  ≈$22 of the $49–68 quote · 1 session",
    "  ⋯ Around   1 in QA · 6 ready · next up: Drill impact for agents (#93)",
  ],
};

for (const [name, lines] of Object.entries(GOLDEN))
  test(`build-view-one-story golden: the ${name} state reads as the design draws it`, () => {
    const state = { building, refining, idle, qa, shipped, disagreeing }[name];
    assert.deepEqual(renderLines(state, NOW), lines);
    for (const l of lines) assert.ok([...l].length <= 100, `${[...l].length}: ${l}`);
    // One fact, one place: the stage is said by the track alone, and no line names a source unless two disagree.
    assert.ok(!lines.some((l) => /from (git|github|docs)|snapshot|session journal|no target set/.test(l)), lines.join('\n'));
    assert.equal(lines.filter((l) => l.startsWith('  ⚑')).length, name === 'disagreeing' ? 1 : 0);
  });

test('build-view-one-story D2: a title too long to share the line moves the bar down; only one wider than the line is clipped', () => {
  const long = { ...building, epic: { ...building.epic, title: 'The outcome report for any product and its pace' } };
  const lines = renderLines(long, NOW);
  assert.equal(lines[0], 'golden-frijoles ▶ Sprint 1 of 2 · The outcome report for any product and its pace · L · ▲ risk HIGH');
  assert.equal(lines[1], '  ▰▰▱│▱▱▱▱▱  2 of 8 stories done', 'the bar is never cut');
  assert.equal(lines[2], '  Refining ─ Ready ─ ◉ Building ─ QA ─ Shipped', 'the track is never cut');
  const huge = { ...building, epic: { ...building.epic, title: 'word '.repeat(40).trim() } };
  const head = renderLines(huge, NOW)[0];
  assert.equal([...head].length, 100);
  assert.match(head, /… · L · ▲ risk HIGH$/);
});

test('build-view-one-story D4: a source is named only when two disagree — one spec per pair', async () => {
  const { disagreement } = await import('./build-state.mjs');
  // (a) shipped docs, unmerged story commits — and a close-out branch (no story commit) is NOT a disagreement.
  assert.equal(
    disagreement({ ...shipped, evidence: { story_commits: 2 } }),
    "the epic's docs say Shipped, but this branch has 2 story commits not on main"
  );
  assert.equal(disagreement(shipped), null);
  // (b) story commits before the lock was stamped.
  assert.equal(disagreement(disagreeing), "the epic's docs say Shaping, but this branch has story commits");
  assert.equal(
    disagreement({ ...disagreeing, evidence: { story_commits: 0 } }),
    null,
    'no story commit yet: that is Locking, not a disagreement'
  );
  // (c) a written phase ahead of the board.
  assert.equal(
    disagreement({ ...building, phase_written: 'Shipped', sprint: { n: 1 } }),
    "sprint 1's docs say Shipped, but the board has it at Building"
  );
  assert.equal(
    disagreement({ ...building, phase_written: 'In review', sprint: null }),
    "the epic's docs say In review, but the board has it at Building"
  );
  assert.equal(disagreement({ ...qa, phase_written: 'Building' }), null, 'docs lagging the board is the cadence');
  // (d) an unreadable sprint.
  assert.equal(
    disagreement({ ...building, warning: 'Roadmap/…/sprint-1.md frontmatter could not be read' }),
    'Roadmap/…/sprint-1.md frontmatter could not be read'
  );
  assert.equal(disagreement(building), null);
  assert.equal(disagreement(idle), null);
});

test('build-view-one-story D6: between stories only when the tree is clean and HEAD is that story\'s commit', () => {
  const f = fixture();
  try {
    f.git('switch', '-qc', 'feat/arranged-only-s2');
    f.commit('S2.1 — agent surface parity');
    const now = () => renderLines(resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh })).find((l) => l.startsWith('  ▸ Now'));
    assert.equal(now(), '  ▸ Now      between stories: S2.1 done, S2.2 next');
    writeFileSync(join(f.root, 'half-done.txt'), 'work in progress');
    assert.equal(now(), '  ▸ Now      S2.1 Agent surface parity', 'uncommitted work: the story stays in flight');
    rmSync(join(f.root, 'half-done.txt'));
    f.commit('chore: tidy');
    assert.equal(now(), '  ▸ Now      S2.1 Agent surface parity', 'HEAD is not the story\'s commit: no claim it is done');
    f.commit('S2.2 — seller toggle');
    f.commit('chore(release): 1.2.3');
    assert.equal(
      now(),
      '  ▸ Now      between stories: S2.2 done, every story has a commit',
      'every story in scope has a commit and the tree is clean: a release on top does not reopen one'
    );
  } finally {
    f.done();
  }
});

test('build-view-one-story D7: a shipped epic reads shipped on its close-out branch — N of N, the ship day, the read', () => {
  const f = fixture();
  try {
    f.git('switch', '-qc', 'feat/arranged-only');
    f.commit('S1.1 — contract');
    f.git('switch', '-q', 'main');
    f.git('merge', '-q', '--no-ff', '-m', 'merge', 'feat/arranged-only');
    f.git('switch', '-qc', 'docs/arranged-only-close');
    const readme = join(f.root, 'Roadmap', '04-shipping', 'arranged-only', 'README.md');
    writeFileSync(
      readme,
      EPIC_README('Shipped')
        .replace('status: in-progress', 'status: shipped')
        .replace('type: feature', 'type: feature\ntarget_metric: arranged_rate\ntarget_from: 1\ntarget_to: 2')
    );
    f.git('commit', '-qam', 'docs(arranged-only): close');
    const s = resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh });
    const day = f.git('log', '-1', '--format=%cs');
    assert.equal(s.shipped_on, day, 'the commit that wrote status: shipped');
    const lines = renderLines(s, new Date(`${day}T12:00:00Z`));
    assert.match(lines[0], /^\S+ ✓ Sprint 2 of 2 · Arranged-only delivery · ▲ risk HIGH/);
    assert.ok(lines.includes('  ▰│▰▰  3 of 3 stories done'), 'never "1 of 3" on a branch whose stories are on main');
    assert.ok(lines.includes('  Refining ─ Ready ─ Building ─ QA ─ ◉ Shipped'));
    const due = new Date(Date.parse(`${day}T00:00:00Z`) + 30 * 86_400_000);
    const short = (d) => `${d.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]}`;
    const shippedDay = new Date(`${day}T00:00:00Z`);
    assert.ok(lines.includes(`  ▸ Now      shipped ${short(shippedDay)} · verdict due ${short(due)}`), lines.join('\n'));
    assert.ok(!lines.some((l) => l.startsWith('  ⚑')), 'a close-out branch carries no story commit: nothing disagrees');
    writeFileSync(readme, EPIC_README('Shipped').replace('status: in-progress', 'status: shipped'));
    f.git('commit', '-qam', 'docs: drop the target');
    assert.ok(
      renderLines(resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh })).some((l) =>
        / · no target to read$/.test(l)
      )
    );
  } finally {
    f.done();
  }
});

test("#27 review: a stacked sprint branch never inherits the previous sprint's commits as its story", () => {
  const f = fixture();
  try {
    f.git('switch', '-qc', 'feat/arranged-only');
    f.commit('S1.1 — the contract');
    f.git('switch', '-qc', 'feat/arranged-only-s2');
    const s = resolveBuildState({ root: f.root, offline: true, gh: noGh });
    assert.equal(s.story, null, 'S1.1 is sprint 1 — this branch is sprint 2');
    assert.equal(s.evidence.story_commits, 0, 'and it does not lift the status either');
    assert.match(s.story_note, /name S1\.1, none of them sprint 2 of this epic's/);
    assert.equal(s.sprint.n, 2, 'the sprint still comes from the branch');
    f.commit('S2.1 — first of sprint 2');
    assert.equal(resolveBuildState({ root: f.root, offline: true, gh: noGh }).story.id, 'S2.1');
  } finally {
    f.done();
  }
});

test('#27 review: an old journal entry about ANOTHER epic is never read as this one', () => {
  const f = fixture();
  try {
    f.git('switch', '-q', '--orphan', 'claude/session-journal');
    writeFileSync(
      join(f.root, 'session-journal.jsonl'),
      `${JSON.stringify({ ts: '2020-01-01T00:00:00Z', kind: 'doing', text: 'golden-flags-by-default S1.1 wiring', refs: [] })}\n`
    );
    f.git('add', 'session-journal.jsonl');
    f.git('commit', '-qm', 'journal');
    f.git('switch', '-q', 'main');
    f.git('switch', '-qc', 'feat/arranged-only');
    const s = resolveBuildState({ root: f.root, offline: true, gh: noGh });
    assert.equal(s.story, null);
    assert.equal(s.story_source, 'unknown');
  } finally {
    f.done();
  }
});

test('#27 review: it never throws, and the CLI works through a symlinked path', () => {
  const f = fixture();
  try {
    f.git('switch', '-qc', 'feat/arranged-only');
    rmSync(join(f.root, 'Roadmap'), { recursive: true, force: true });
    writeFileSync(join(f.root, 'Roadmap'), 'a file, not a directory');
    const s = resolveBuildState({ root: f.root, offline: true, gh: noGh });
    assert.equal(s.in_flight, false);
    const outside = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    assert.match(
      resolveBuildState({ root: outside, offline: true, gh: noGh }).reason,
      /not inside a git checkout/
    );
    rmSync(outside, { recursive: true, force: true });

    const link = join(mkdtempSync(join(tmpdir(), 'link-')), 'scripts');
    symlinkSync(dirname(fileURLToPath(import.meta.url)), link);
    const out = execFileSync('node', [join(link, 'build-state.mjs'), '--repo-root', f.root, '--offline'], {
      encoding: 'utf8',
      env: sealedEnv(),
    });
    assert.match(out, /^\S+ ○ No epic on this branch/, 'a symlinked invocation still prints the view');
  } finally {
    f.done();
  }
});

test('#27 review: an epic slug that itself ends in -s<N> still resolves', () => {
  const f = fixture();
  try {
    const dir = join(f.root, 'Roadmap', '09-platform-infra', 'aws-s3');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), EPIC_README().replace(/arranged-only/g, 'aws-s3'));
    writeFileSync(
      join(dir, 'sprint-1.md'),
      SPRINT(1, 'Building', [['S1.1', 'Bucket']]).replace(/arranged-only/g, 'aws-s3')
    );
    f.git('add', '-A');
    f.git('commit', '-qm', 'aws');
    f.git('switch', '-qc', 'feat/aws-s3');
    const s = resolveBuildState({ root: f.root, offline: true, gh: noGh });
    assert.equal(s.in_flight, true);
    assert.equal(s.epic.slug, 'aws-s3');
  } finally {
    f.done();
  }
});

test('codex (#158/#188): a NEW journal entry about another epic is ignored — only one naming this slug counts', () => {
  const f = fixture();
  try {
    f.git('switch', '-q', '--orphan', 'claude/session-journal');
    const now = new Date(Date.now() + 60_000).toISOString(); // written after the branch forked
    writeFileSync(
      join(f.root, 'session-journal.jsonl'),
      `${JSON.stringify({ ts: now, kind: 'doing', text: 'arranged-only S2.1 parity', refs: [] })}\n` +
        `${JSON.stringify({ ts: now, kind: 'doing', text: 'other-epic S2.2 wiring', refs: [] })}\n` +
        `${JSON.stringify({ ts: now, kind: 'doing', text: 'arranged-only-v2 S1.1', refs: [] })}\n`
    );
    f.git('add', 'session-journal.jsonl');
    f.git('commit', '-qm', 'journal');
    f.git('switch', '-q', 'main');
    f.git('switch', '-qc', 'feat/arranged-only');
    const s = resolveBuildState({ root: f.root, offline: true, gh: noGh });
    assert.equal(s.story.id, 'S2.1', 'the newer other-epic and longer-slug entries are skipped');
    assert.equal(namesSlug('arranged-only-v2 S1.1', 'arranged-only'), false);
    assert.equal(namesSlug('(arranged-only) S1.1', 'arranged-only'), true);
  } finally {
    f.done();
  }
});

test('codex (#188): with both `aws` and `aws-s3` on the board, feat/aws-s3 is the aws-s3 epic', () => {
  const f = fixture();
  try {
    for (const slug of ['aws', 'aws-s3']) {
      const dir = join(f.root, 'Roadmap', '09-platform-infra', slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'README.md'), EPIC_README().replace(/arranged-only/g, slug));
      const sprints = slug === 'aws' ? [1, 2, 3] : [1];
      for (const n of sprints)
        writeFileSync(
          join(dir, `sprint-${n}.md`),
          SPRINT(n, 'Building', [[`S${n}.1`, 'x']]).replace(/arranged-only/g, slug)
        );
    }
    f.git('add', '-A');
    f.git('commit', '-qm', 'two epics');
    f.git('switch', '-qc', 'feat/aws-s3');
    assert.equal(resolveBuildState({ root: f.root, offline: true, gh: noGh }).epic.slug, 'aws-s3');
    f.git('switch', '-qc', 'feat/aws-s2');
    const s = resolveBuildState({ root: f.root, offline: true, gh: noGh });
    assert.deepEqual(
      [s.epic.slug, s.sprint.n],
      ['aws', 2],
      'with no aws-s2 epic, -s2 is still a sprint suffix'
    );
  } finally {
    f.done();
  }
});

test('codex round 2: an unlisted id in the NEWEST story commit wins over an older valid one', () => {
  const f = fixture();
  try {
    f.git('switch', '-qc', 'feat/arranged-only');
    f.commit('S2.1 — agent surface parity');
    f.commit('S9.9 — a typo, or another epic');
    const s = resolveBuildState({ root: f.root, offline: true, gh: noGh });
    assert.equal(s.story, null, 'the older S2.1 is not served as the answer');
    assert.match(s.story_note, /names S9\.9, which no sprint of this epic lists/);
  } finally {
    f.done();
  }
});

test('codex round 2: a journal line whose refs are not an array cannot break the branch', () => {
  const f = fixture();
  try {
    f.git('switch', '-q', '--orphan', 'claude/session-journal');
    writeFileSync(
      join(f.root, 'session-journal.jsonl'),
      `${JSON.stringify({ ts: 't', kind: 'doing', text: 'arranged-only S2.1', refs: {} })}\n` +
        `${JSON.stringify({ refs: 42 })}\n`
    );
    f.git('add', 'session-journal.jsonl');
    f.git('commit', '-qm', 'journal');
    f.git('switch', '-q', 'main');
    f.git('switch', '-qc', 'feat/arranged-only');
    const s = resolveBuildState({ root: f.root, offline: true, gh: noGh });
    assert.equal(s.in_flight, true, 'a malformed journal line must not make a good branch "not in flight"');
    assert.equal(s.story.id, 'S2.1');
  } finally {
    f.done();
  }
});

test('codex round 2: a stale origin/main does not put main’s own commits inside base..HEAD', () => {
  const f = fixture();
  try {
    // origin/main is left at the scaffold commit; local main moves on, and the branch is cut from THAT.
    f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    f.commit('S1.1 — landed on main after the last fetch');
    // No -s<N> suffix: nothing but the base choice can keep main's own S1.1 out of this branch's range.
    f.git('switch', '-qc', 'feat/arranged-only');
    const s = resolveBuildState({ root: f.root, offline: true, gh: noGh });
    assert.equal(s.story, null, "main's own S1.1 commit is not this branch's story");
    assert.equal(s.evidence.story_commits, 0);
    f.commit("S2.1 — the branch's own work");
    assert.equal(resolveBuildState({ root: f.root, offline: true, gh: noGh }).story.id, 'S2.1');
  } finally {
    f.done();
  }
});

test('codex round 2: a sprint whose frontmatter cannot be read says so', () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.root, 'Roadmap', '04-shipping', 'arranged-only', 'sprint-2.md'),
      '# no frontmatter here\n'
    );
    f.git('add', '-A');
    f.git('commit', '-qm', 'break sprint 2');
    f.git('switch', '-qc', 'feat/arranged-only-s2');
    const s = resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh });
    assert.match(s.warning, /sprint-2\.md frontmatter could not be read/);
    assert.equal(s.story, null);
    // …and it does not borrow the epic's phase to fill the gap.
    assert.equal(s.phase_written, null);
    assert.equal(s.status, null);
    assert.equal(s.status_source, 'unknown');
    // D4 (d) — the unreadable sprint is a ⚑ line under the track, as written.
    const lines = renderLines(s);
    const at = lines.indexOf('  stage unknown: the board could not be read');
    assert.ok(at > 0, lines.join('\n'));
    assert.match(lines[at + 1], /^ {2}⚑ Roadmap\/…\/sprint-2\.md frontmatter could not be read$/, 'right under the track');
    // A commit naming S2.1 does NOT lift it either: with sprint-2 unreadable, no story list says S2.1
    // exists, so the id is unlisted and the honest answer stays unknown.
    f.commit('S2.1 — work on the branch anyway');
    const after = resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh });
    assert.deepEqual([after.status, after.status_source], [null, 'unknown']);
    assert.match(after.story_note, /names S2\.1, which no sprint of this epic lists/);
  } finally {
    f.done();
  }
});

test('codex round 3: an unlisted id in the newest story commit outranks a mixed subject and the journal', () => {
  const f = fixture();
  try {
    f.git('switch', '-q', '--orphan', 'claude/session-journal');
    writeFileSync(
      join(f.root, 'session-journal.jsonl'),
      `${JSON.stringify({ ts: 't', kind: 'doing', text: 'arranged-only S2.2 seller toggle', refs: [] })}\n`
    );
    f.git('add', 'session-journal.jsonl');
    f.git('commit', '-qm', 'journal');
    f.git('switch', '-q', 'main');
    f.git('switch', '-qc', 'feat/arranged-only');
    f.commit('S9.9 — an id this epic does not list');
    const s = resolveBuildState({ root: f.root, offline: true, gh: noGh });
    assert.equal(s.story, null, 'the journal must not rescue an unlisted newest commit');

    const g = fixture();
    try {
      g.git('switch', '-qc', 'feat/arranged-only');
      g.commit('S2.1 — parity, reverting S9.9');
      assert.equal(
        resolveBuildState({ root: g.root, offline: true, gh: noGh }).story,
        null,
        'a mixed subject is unknown'
      );
    } finally {
      g.done();
    }
  } finally {
    f.done();
  }
});

// ── kickoff-lean-build-view: suffixed branches, seed work, other worktrees ─────────────────────────────

const SEED = (slug, type, extra = '') => `---
title: "A ${type} called ${slug}"
slug: ${slug}
status: ready
area: "09"
type: ${type}
priority: "x"
appetite: S
underwritten_by: null
risk: low
epic: ${extra || 'null'}
build_order: 1
updated: 2026-09-28
---
# Seed
`;

function addSeed(f, slug, type, epic) {
  const dir = join(f.root, 'Roadmap', '00-ideas', 'seeds');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), SEED(slug, type, epic));
  f.git('add', '-A');
  f.git('commit', '-qm', `seed ${slug}`);
}

test('branch readings: a sprint suffix may carry words after it, and docs/ is a work branch', () => {
  assert.deepEqual(parseBranch('feat/public-monorepo-s4-licences'), { slug: 'public-monorepo', sprint: 4 });
  assert.deepEqual(parseBranch('docs/public-monorepo-close'), {
    slug: 'public-monorepo-close',
    sprint: null,
  });
  assert.deepEqual(
    branchCandidates('docs/foo-close').map((c) => c.slug),
    ['foo-close', 'foo'],
    'longest reading first'
  );
  assert.deepEqual(branchCandidates('feat/../etc'), [], 'no path segments in a slug');
  assert.deepEqual(branchCandidates('release/1.2'), []);
});

test('a suffixed sprint branch and a docs/ branch both resolve to the epic', () => {
  const f = fixture();
  try {
    f.git('switch', '-qc', 'feat/arranged-only-s2-parity');
    f.commit('S2.1 — agent surface parity');
    const s = resolveBuildState({ root: f.root, offline: true, gh: noGh });
    assert.deepEqual([s.in_flight, s.epic.slug, s.sprint.n, s.story.id], [true, 'arranged-only', 2, 'S2.1']);
    assert.equal(s.branch_match, 'prefix');
    f.git('switch', '-qc', 'docs/arranged-only-close');
    assert.equal(resolveBuildState({ root: f.root, offline: true, gh: noGh }).epic.slug, 'arranged-only');
  } finally {
    f.done();
  }
});

test('a branch naming a seed with no epic is that bug/chore/spike — with its own heading, no story', () => {
  const f = fixture();
  try {
    addSeed(f, 'checkout-typo', 'bug');
    f.git('switch', '-qc', 'fix/checkout-typo');
    let s = resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh });
    assert.deepEqual(
      [s.in_flight, s.kind, s.seed.slug, s.status, s.status_source],
      [true, 'bug', 'checkout-typo', 'ready', 'written']
    );
    f.commit('fix the typo');
    s = resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh });
    assert.equal(s.status, 'Building', 'a commit on the branch is the evidence');
    assert.deepEqual(renderLines(s), [
      `${s.repo} ▶ Bug · A bug called checkout-typo · S · ▲ risk LOW`,
      '  Refining ─ Ready ─ ◉ Building ─ QA ─ Shipped',
      '  ↗ Roadmap/00-ideas/seeds/checkout-typo.md',
      '  ▸ Now      1 commit on this branch',
    ]);
    const gh = ghWith({ number: 9, url: 'u' });
    assert.equal(resolveBuildState({ board: false, root: f.root, gh }).status, 'In review');
    f.git('switch', '-q', 'main');
    addSeed(f, 'why-slow', 'spike');
    f.git('switch', '-qc', 'spike/why-slow');
    assert.match(
      renderLines(resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh }))[0],
      /^\S+ ❧ Spike · A spike called why-slow · S · ▲ risk LOW$/,
      'a spike seed not started reads at Refining, by its type word'
    );
  } finally {
    f.done();
  }
});

test('build-view-one-story D6: an idea being refined on its own docs/ branch reads Refining, its commits included', () => {
  const f = fixture();
  try {
    addSeed(f, 'night-garden', 'feature');
    const seed = join(f.root, 'Roadmap', '00-ideas', 'seeds', 'night-garden.md');
    writeFileSync(
      seed,
      readFileSync(seed, 'utf8')
        .replace('appetite: S', 'appetite: M\nhypothesis: "A garden at night."')
        .replace('# Seed', '# Seed\n\nquote: $15–34 (M, n=24, p25–p75)')
    );
    f.git('commit', '-qam', 'seed: hypothesis');
    f.git('switch', '-qc', 'docs/night-garden');
    f.commit('docs(night-garden): refine the pitch');
    const s = resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh });
    assert.deepEqual(renderLines(s), [
      // the fixture's repo name is 18 columns, so the quote fits on the header at column 100
      `${s.repo} ❧ Idea · A feature called night-garden · M · ▲ risk LOW`.padEnd(100 - 'quote $15–34'.length) + 'quote $15–34',
      '  ◉ Refining ─ Ready ─ Building ─ QA ─ Shipped',
      '  ↗ Roadmap/00-ideas/seeds/night-garden.md',
      '  ❝ Why      A garden at night.',
      '  ▸ Now      plan ready, waiting for your approval',
    ]);
  } finally {
    f.done();
  }
});

test('build-view-one-story D7: with no facts snapshot yet, this branch\'s story commits lift the track to Building', () => {
  const f = fixture({ sprint2: 'Building' });
  try {
    f.git('switch', '-qc', 'feat/arranged-only-s2');
    f.commit('S2.1 — agent surface parity');
    const s = resolveBuildState({ root: f.root, offline: true, gh: noGh, elsewhere: false });
    assert.equal(s.facts_mode, 'docs', 'a fresh checkout: no snapshot');
    assert.equal(s.stage, 'Ready to build', 'the board alone reads the docs');
    const lines = renderLines(s);
    assert.match(lines[0], /^\S+ ▶ /);
    assert.ok(lines.includes('  Refining ─ Ready ─ ◉ Building ─ QA ─ Shipped'), lines.join('\n'));
  } finally {
    f.done();
  }
});

test('a seed that carries epic: is that epic — the seed is funnel-only once scaffolded', () => {
  const f = fixture();
  try {
    addSeed(f, 'arranged', 'feature', '"04-shipping/arranged-only"');
    f.git('switch', '-qc', 'feat/arranged-s2');
    const s = resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh });
    assert.deepEqual([s.kind, s.epic.slug, s.sprint.n, s.branch_match], ['epic', 'arranged-only', 2, 'seed']);
  } finally {
    f.done();
  }
});

test('parseWorktrees reads git worktree list --porcelain', () => {
  const out = parseWorktrees(
    'worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/.claude/worktrees/x\nHEAD def\nbranch refs/heads/feat/a-s2\n\nworktree /gone\nHEAD 123\ndetached\nprunable gitdir file points to non-existent location\n'
  );
  assert.deepEqual(out, [
    { path: '/r', branch: 'main', bare: false, prunable: false },
    { path: '/r/.claude/worktrees/x', branch: 'feat/a-s2', bare: false, prunable: false },
    { path: '/gone', branch: null, bare: false, prunable: true },
  ]);
});

test('on main with a builder in a worktree: the view names the worktree, and the worktree names itself', () => {
  const f = fixture();
  const wt = mkdtempSync(join(tmpdir(), 'build-state-wt-'));
  rmSync(wt, { recursive: true, force: true });
  try {
    f.git('worktree', 'add', '-q', '-b', 'feat/arranged-only-s2', wt);
    const inWt = (...a) =>
      execFileSync('git', a, {
        cwd: wt,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: sealedEnv(),
      });
    writeFileSync(join(wt, 'work.txt'), 'x');
    inWt('add', 'work.txt');
    inWt('commit', '-qm', 'S2.1 — agent surface parity');

    const main = resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh });
    assert.equal(main.in_flight, false);
    assert.equal(main.elsewhere.worktrees.length, 1);
    assert.deepEqual(
      [
        main.elsewhere.worktrees[0].slug,
        main.elsewhere.worktrees[0].story,
        main.elsewhere.worktrees[0].status,
      ],
      ['arranged-only', 'S2.1', 'Building']
    );
    assert.deepEqual(main.elsewhere.open_epics, [], 'an epic shown from its worktree is not listed twice');
    assert.deepEqual(renderLines(main).slice(1), [
      '  ⋯ Around   in other worktrees: Arranged-only delivery (S2.1, Building)',
    ]);

    const there = resolveBuildState({ board: false, root: wt, offline: true, gh: noGh });
    assert.equal(there.in_flight, true);
    assert.equal(there.elsewhere.worktrees.length, 0, 'the root is on main, so nothing else is in flight');
    assert.ok(!renderLines(there).some((l) => l.includes('Around')), 'nothing else to say: no Around line');
  } finally {
    try {
      f.git('worktree', 'remove', '--force', wt);
    } catch {}
    rmSync(wt, { recursive: true, force: true });
    f.done();
  }
});

test('a shipped epic is never "open", and a worktree on it is not in flight elsewhere', () => {
  const f = fixture();
  try {
    const readme = join(f.root, 'Roadmap', '04-shipping', 'arranged-only', 'README.md');
    writeFileSync(readme, EPIC_README('Shipped').replace('status: in-progress', 'status: shipped'));
    f.git('commit', '-qam', 'ship');
    const s = resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh });
    assert.deepEqual(s.elsewhere, { worktrees: [], open_epics: [] });
    assert.deepEqual(renderLines(s), [`${s.repo} ○ No epic on this branch · main`]);
  } finally {
    f.done();
  }
});

// ── board-sinks-and-scrumban S3.1 — the CLI mod is a client of the resolver ──────────────────────────────────────

const liveFacts = (prs = [], branches = []) => {
  const calls = [];
  const gather = ({ mode }) => (
    calls.push(mode),
    { mode: 'live', branches, prs, origin: null, generated_at: '2026-10-02T10:00:00.000Z', note: null }
  );
  gather.calls = calls;
  return gather;
};

test('S3.1: the stage comes from the resolver, said with its source; ONE facts gather per run', () => {
  const f = fixture();
  try {
    f.git('checkout', '-qb', 'feat/arranged-only-s2');
    f.commit('S2.1 wire it');
    const gather = liveFacts(
      [{ number: 7, head: 'feat/arranged-only-s2', state: 'OPEN', draft: false, url: 'https://x/pull/7' }],
      ['feat/arranged-only-s2']
    );
    const s = resolveBuildState({ root: f.root, gather, elsewhere: false });
    assert.deepEqual(gather.calls, ['live'], 'one gather, live');
    assert.equal(s.stage, 'QA');
    assert.equal(s.stage_source, 'github: PR #7 ready');
    assert.equal(s.evidence.pr.number, 7, 'the PR comes from the same facts — no second gh call');
    const lines = renderLines(s);
    assert.equal(statusOf(lines), 'Refining ─ Ready ─ Building ─ ◉ QA ─ Shipped');
    // build-view-one-story D4 — the source is in the JSON, and named in the text only when two disagree. A phase that
    // lags the board (Building, PR ready) is the cadence, not a disagreement.
    assert.equal(s.facts_mode, 'live');
    assert.ok(!lines.some((l) => l.includes('from github') || l.startsWith('  ⚑')), lines.join('\n'));
  } finally {
    f.done();
  }
});

test('S3.1: offline, the stage is read from the snapshot and says how old it is; no snapshot says so too', () => {
  const f = fixture();
  try {
    f.git('checkout', '-qb', 'feat/arranged-only-s2');
    mkdirSync(join(f.root, '.golden-frijoles'), { recursive: true });
    writeFileSync(
      join(f.root, '.golden-frijoles', 'board.json'),
      JSON.stringify({
        generated_at: '2026-10-02T09:00:00.000Z',
        branches: ['feat/arranged-only-s2'],
        prs: [],
      })
    );
    const s = resolveBuildState({
      root: f.root,
      offline: true,
      now: new Date('2026-10-02T12:00:00.000Z'),
      elsewhere: false,
    });
    assert.equal(s.stage, 'Building');
    assert.equal(statusOf(renderLines(s)), 'Refining ─ Ready ─ ◉ Building ─ QA ─ Shipped');
    assert.match(s.stage_source, /^git: feat\/arranged-only-s2\b/);
    assert.deepEqual([s.facts_mode, s.stage_age], ['snapshot', '3h ago']);

    rmSync(join(f.root, '.golden-frijoles'), { recursive: true, force: true });
    const none = resolveBuildState({ root: f.root, offline: true, elsewhere: false });
    assert.equal(none.facts_mode, 'docs');
  } finally {
    f.done();
  }
});

test('S2.3: a live epic branch with no locked_at reads Locking architecture; the stamp makes it Building', () => {
  const f = fixture({ sprint2: 'Shaping', epicPhase: 'Shaping' });
  try {
    f.git('checkout', '-qb', 'feat/arranged-only-s2');
    const readme = join(f.root, 'Roadmap', '04-shipping', 'arranged-only', 'README.md');
    writeFileSync(readme, EPIC_README('Shaping', null));
    mkdirSync(join(f.root, '.golden-frijoles'), { recursive: true });
    const snapshot = (prs) =>
      writeFileSync(
        join(f.root, '.golden-frijoles', 'board.json'),
        JSON.stringify({ generated_at: '2026-10-02T09:00:00.000Z', branches: ['feat/arranged-only-s2'], prs })
      );
    snapshot([]);
    const status = () =>
      statusOf(renderLines(resolveBuildState({ root: f.root, offline: true, elsewhere: false })));
    assert.equal(status(), 'Refining ─ Ready ─ ◉ Locking ─ QA ─ Shipped');
    // A draft PR is still the lock in progress; a READY one is QA whatever the docs say (the stage resolver decides).
    snapshot([{ number: 9, head: 'feat/arranged-only-s2', state: 'OPEN', draft: true, url: 'u' }]);
    assert.match(status(), /◉ Locking /);
    snapshot([{ number: 9, head: 'feat/arranged-only-s2', state: 'OPEN', draft: false, url: 'u' }]);
    assert.match(status(), /◉ QA /);
    snapshot([]);
    writeFileSync(readme, EPIC_README('Building'));
    assert.match(status(), /◉ Building /);
  } finally {
    f.done();
  }
});

test('S2.3 (#241 review r2): the gate reads the README phase, not a sprint file born Shaping', () => {
  const f = fixture({ sprint2: 'Shaping', epicPhase: 'Building' });
  try {
    f.git('checkout', '-qb', 'feat/arranged-only-s2');
    writeFileSync(
      join(f.root, 'Roadmap', '04-shipping', 'arranged-only', 'README.md'),
      EPIC_README('Building', null)
    );
    mkdirSync(join(f.root, '.golden-frijoles'), { recursive: true });
    writeFileSync(
      join(f.root, '.golden-frijoles', 'board.json'),
      JSON.stringify({
        generated_at: '2026-10-02T09:00:00.000Z',
        branches: ['feat/arranged-only-s2'],
        prs: [],
      })
    );
    const line = statusOf(renderLines(resolveBuildState({ root: f.root, offline: true, elsewhere: false })));
    assert.doesNotMatch(line, /Locking/);
  } finally {
    f.done();
  }
});

test('S2.3 (#241 review): an epic built before the lock command — no stamp, phase already Building or later — reads Building', () => {
  for (const phase of ['Building', 'Verifying']) {
    const f = fixture({ sprint2: phase, epicPhase: phase });
    try {
      f.git('checkout', '-qb', 'feat/arranged-only-s2');
      writeFileSync(
        join(f.root, 'Roadmap', '04-shipping', 'arranged-only', 'README.md'),
        EPIC_README(phase, null)
      );
      mkdirSync(join(f.root, '.golden-frijoles'), { recursive: true });
      writeFileSync(
        join(f.root, '.golden-frijoles', 'board.json'),
        JSON.stringify({
          generated_at: '2026-10-02T09:00:00.000Z',
          branches: ['feat/arranged-only-s2'],
          prs: [],
        })
      );
      const line = statusOf(
        renderLines(resolveBuildState({ root: f.root, offline: true, elsewhere: false }))
      );
      assert.match(line, /◉ Building /, phase);
      assert.doesNotMatch(line, /Locking/, phase);
    } finally {
      f.done();
    }
  }
});

test('S2.1/S2.2 (#241 review): version numbers and prose are not stories', () => {
  assert.deepEqual(storyIdsInWithContinuations('feat(x): S1.3, 2.1.288 bump'), ['S1.3']);
  assert.deepEqual(storyIdsInWithContinuations('feat(x): S2.4 + 0.26.0 release'), ['S2.4']);
  assert.deepEqual(storyIdsInWithContinuations('S2.1a and 2.2'), []);
  const f = fixture();
  try {
    f.git('switch', '-qc', 'feat/arranged-only-s2');
    f.commit('S2.1, 2.1.288 pin');
    f.commit('S2.1 + 0.26.0 release');
    const s = resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh });
    assert.equal(s.progress.stories_with_commits, 1, 'no S2.1-out-of-2.1.288, no S0.26');
  } finally {
    f.done();
  }
});

test('build-view-upgrade D4: the link opens the epic page; with no board row it opens the board', () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.root, 'golden-frijoles.config.json'),
      JSON.stringify({ board: { hubUrl: 'https://goldenfrijoles.com/hub/demo/' } })
    );
    f.git('checkout', '-qb', 'feat/arranged-only-s2');
    const lines = renderLines(resolveBuildState({ root: f.root, gather: liveFacts(), elsewhere: false }));
    assert.ok(
      lines.includes('  ↗ https://goldenfrijoles.com/hub/demo/epic/arranged-only'),
      lines.join('\n')
    );
    f.git('checkout', '-q', 'main');
    const idle = renderLines(resolveBuildState({ root: f.root, gather: liveFacts(), elsewhere: false }));
    assert.equal(idle[1], '  ↗ https://goldenfrijoles.com/hub/demo/board', 'nothing in flight: the board link is line 2');
    writeFileSync(
      join(f.root, 'golden-frijoles.config.json'),
      JSON.stringify({ board: { hubUrl: 'http://goldenfrijoles.com/hub/demo' } })
    );
    assert.ok(
      !renderLines(resolveBuildState({ root: f.root, gather: liveFacts(), elsewhere: false })).some((l) =>
        l.includes('↗')
      ),
      'https only'
    );
  } finally {
    f.done();
  }
});

test('build-view-one-story D5: Why and Target say what we know — the target, else the reason, then intent match', () => {
  const f = fixture();
  try {
    const readme = join(f.root, 'Roadmap', '04-shipping', 'arranged-only', 'README.md');
    const now = new Date('2026-10-08T00:00:00Z');
    f.git('checkout', '-qb', 'feat/arranged-only-s2');
    const why = () => {
      const lines = renderLines(
        resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh }),
        now
      );
      const at = lines.findIndex((l) => /^ {2}[❝⌖] /.test(l));
      return lines.slice(at, lines.findIndex((l) => l.startsWith('  ▸ Now')));
    };
    assert.deepEqual(why(), ['  ⌖ Target   none set']);
    const withTarget = (fields) =>
      writeFileSync(readme, EPIC_README().replace('type: feature', `type: feature\n${fields}`));
    withTarget(
      'hypothesis: "Sellers who can mark a listing arranged-only stop losing orders to carrier rails they cannot fulfil at checkout time"\ntarget_metric: arranged_checkout_rate\ntarget_from: 12\ntarget_to: 30\nread_date: 2026-12-04\nintent_match: 84'
    );
    const lines = why();
    // why-as-a-story D4: the Why wraps in full; the Target is its own line.
    assert.deepEqual(lines, [
      '  ❝ Why      Sellers who can mark a listing arranged-only stop losing orders to carrier rails they',
      '             cannot fulfil at checkout time',
      '  ⌖ Target   arranged_checkout_rate: 12 → 30 · read 4 Dec · intent match 84',
    ]);
    for (const l of lines) assert.ok([...l].length <= 100, `${l.length}: ${l}`);
    withTarget('target_metric: "activation rate"\ntarget_from: 0.4\ntarget_to: 0.55\nread_date: null');
    assert.deepEqual(why(), ['  ⌖ Target   activation rate: 0.4 → 0.55 · read 30 days after shipping']);
    // "no target set" said less than we know: a funded-anyway epic carries its reason.
    withTarget('hypothesis: "a sentence on its own"\ntarget_metric: null\ngrounded: false\ngrounded_reason: "A terminal surface; no North Star input counts it."\nintent_match: 81');
    assert.deepEqual(why(), [
      '  ❝ Why      a sentence on its own',
      '  ⌖ Target   none yet: A terminal surface; no North Star input counts it. · intent match 81',
    ]);
    withTarget('target_metric: tiny\ntarget_from: 0.004\ntarget_to: 0.006');
    assert.deepEqual(
      why(),
      ['  ⌖ Target   tiny: 0.004 → 0.006 · read 30 days after shipping'],
      'small numbers keep their digits'
    );
    withTarget('target_metric: half_a_target\ntarget_from: 1');
    assert.deepEqual(why(), ['  ⌖ Target   none set'], 'a metric without both numbers is not a target');
    assert.ok(!renderLines(resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh })).join('\n').includes('no target set'));
  } finally {
    f.done();
  }
});

test('why-as-a-story D4: the Why wraps at word boundaries, up to five lines, and is never cut mid-sentence', () => {
  const story =
    "Today the Why lists the parts being built and is cut off on screen, so a founder approves bets they cannot easily explain. Written as a short story from the strategy we already agreed, and shown in full, it becomes a bet they can defend. We'll know when every new Why is read in full and approved without a rewrite.";
  const lines = wrapWords(story, 69);
  assert.ok(lines.length <= WHY_LINES_MAX, `${lines.length} lines`);
  assert.equal(lines.join(' '), story, 'every word, in order: nothing cut');
  for (const l of lines) assert.ok(l.length <= 69, `${l.length}: ${l}`);
  const long = wrapWords(`${story} ${story}`, 69);
  assert.equal(long.length, WHY_LINES_MAX, 'a Why longer than the story rule stops at five lines');
  assert.ok(long.at(-1).endsWith('…') && long.at(-1).length <= 69, long.at(-1));
  assert.deepEqual(
    wrapWords('a'.repeat(80), 10),
    ['aaaaaaaaa…'],
    'one word wider than the room is the only thing clipped'
  );
  assert.deepEqual(wrapWords('', 10), []);
});

test('build-view-upgrade D2/D3: bars per sprint, the track per stage', () => {
  assert.equal(
    sprintBars([
      { done: 2, total: 3 },
      { done: 0, total: 4 },
    ]),
    '▰▰▱│▱▱▱▱'
  );
  assert.equal(
    sprintBars([{ done: 5, total: 16 }]),
    '▰▰▱▱▱▱▱▱',
    'a wide sprint is scaled to 8 cells, rounded down'
  );
  assert.equal(
    sprintBars([{ done: 19, total: 20 }]),
    '▰▰▰▰▰▰▰▱',
    'never drawn full before every story has a commit'
  );
  assert.equal(sprintBars([{ done: 20, total: 20 }]), '▰▰▰▰▰▰▰▰');
  assert.equal(
    sprintBars([
      { done: 0, total: 0 },
      { done: 1, total: 1 },
    ]),
    '▰',
    'an empty sprint draws nothing'
  );
  assert.equal(sprintBars([]), '');
  assert.equal(stageTrack('Grooming'), '◉ Refining ─ Ready ─ Building ─ QA ─ Shipped');
  assert.equal(stageTrack('Ready to build'), 'Refining ─ ◉ Ready ─ Building ─ QA ─ Shipped');
  assert.equal(stageTrack('Building'), 'Refining ─ Ready ─ ◉ Building ─ QA ─ Shipped');
  assert.equal(stageTrack('Building', true), 'Refining ─ Ready ─ ◉ Locking ─ QA ─ Shipped');
  assert.equal(stageTrack('QA'), 'Refining ─ Ready ─ Building ─ ◉ QA ─ Shipped');
  assert.equal(stageTrack('Shipped'), 'Refining ─ Ready ─ Building ─ QA ─ ◉ Shipped');
  assert.equal(stageTrack('To groom'), '◉ Backlog ─ Refining ─ Ready ─ Building ─ QA ─ Shipped');
  for (const s of ['To groom', 'Grooming', 'Ready to build', 'Building', 'QA', 'Shipped'])
    assert.ok(`  Status   ${stageTrack(s)}`.length <= 80, s);
});

test('S3.1: the Board line links to the card on the Hub when board.hubUrl is set, and is silent about it when not', () => {
  const f = fixture();
  try {
    f.git('checkout', '-qb', 'feat/arranged-only-s2');
    const plain = renderLines(resolveBuildState({ root: f.root, gather: liveFacts(), elsewhere: false }));
    // build-view-one-story D8 — the board is other work: one Around line, never this epic itself.
    assert.ok(plain.includes('  ⋯ Around   nothing else on the board'), plain.join('\n'));
    // No hub URL configured → the link is the README's path, never an error and never a made-up URL.
    assert.equal(plain.find((l) => l.startsWith('  ↗')), '  ↗ Roadmap/04-shipping/arranged-only/README.md');

    writeFileSync(
      join(f.root, 'golden-frijoles.config.json'),
      JSON.stringify({ board: { hubUrl: 'https://goldenfrijoles.com/hub/demo/' } })
    );
    const linked = renderLines(resolveBuildState({ root: f.root, gather: liveFacts(), elsewhere: false }));
    assert.ok(
      linked.includes('  ↗ https://goldenfrijoles.com/hub/demo/epic/arranged-only'),
      linked.join('\n')
    );
  } finally {
    f.done();
  }
});

test('S3.1: an epic shipped in ONE merged PR, every sprint ✅ by its own docs, reads QA — never Building (the 2026-10-01 mismatch)', () => {
  const f = fixture();
  try {
    const dir = join(f.root, 'Roadmap', '04-shipping', 'arranged-only');
    for (const n of [1, 2]) {
      const p = join(dir, `sprint-${n}.md`);
      writeFileSync(
        p,
        readFileSync(p, 'utf8').replace(/\n# Arranged/, '\n**Status:** ✅ Shipped — merged\n\n# Arranged')
      );
    }
    f.git('add', '-A');
    f.git('commit', '-qm', 'docs: sprints shipped');
    const gather = liveFacts([
      { number: 98, head: 'feat/arranged-only', state: 'MERGED', draft: false, url: 'https://x/pull/98' },
    ]);
    const s = resolveBuildState({ root: f.root, gather, elsewhere: false });
    assert.equal(s.in_flight, false, 'on main');
    assert.equal(s.board.qa, 1);
    assert.equal(s.board.building, 0);
  } finally {
    f.done();
  }
});

test('stage agreement: the build view, the extractor rows and the six-column board report ONE stage', async () => {
  const { buildRows } = await import('./roadmap-extract.mjs');
  const { groupByStage } = await import('./lib/stage.mjs');
  const f = fixture();
  try {
    f.git('checkout', '-qb', 'feat/arranged-only-s2');
    const facts = {
      mode: 'live',
      branches: ['feat/arranged-only-s2'],
      prs: [],
      origin: null,
      generated_at: null,
    };
    const s = resolveBuildState({ root: f.root, gather: () => facts, elsewhere: false });
    const row = buildRows({ facts, root: f.root, dates: false }).find((r) => r.slug === 'arranged-only');
    const column = Object.entries(groupByStage(buildRows({ facts, root: f.root, dates: false }))).find(
      ([, rows]) => rows.some((r) => r.slug === 'arranged-only')
    )[0];
    assert.deepEqual([s.stage, row.stage, column], ['Building', 'Building', 'Building']);
  } finally {
    f.done();
  }
});

test('S3.1: an online run whose gather FELL BACK to the snapshot never lifts the status to In review from a stale PR', () => {
  const f = fixture();
  try {
    f.git('checkout', '-qb', 'feat/arranged-only-s2');
    f.commit('S2.1 wire it');
    const stale = () => ({
      mode: 'snapshot',
      branches: ['feat/arranged-only-s2'],
      prs: [
        { number: 7, head: 'feat/arranged-only-s2', state: 'OPEN', draft: false, url: 'https://x/pull/7' },
      ],
      origin: 'snapshot@2026-10-01T00:00:00.000Z',
      generated_at: '2026-10-01T00:00:00.000Z',
    });
    const s = resolveBuildState({ root: f.root, gather: stale, elsewhere: false });
    assert.equal(s.evidence.pr, null, 'no PR claimed from fallen-back facts');
    assert.notEqual(s.status, 'In review');
  } finally {
    f.done();
  }
});

// ── finops S1.3 — the Spend row reads the usage summary, and only that (D5) ──────────────────────────────────────────
const SUMMARY = (epics) =>
  JSON.stringify({ basis: 'this machine', generated_at: '2026-10-02T00:00:00Z', epics });

test('finops 1.3: on an epic branch with a summary row, Spend sits between Progress and Status', () => {
  const f = fixture();
  try {
    f.git('switch', '-qc', 'feat/arranged-only-s2');
    mkdirSync(join(f.root, '.golden-frijoles'), { recursive: true });
    writeFileSync(
      join(f.root, '.golden-frijoles', 'usage-summary.json'),
      SUMMARY({ 'arranged-only': { usd: 38.42, usd_known: true, mtok: 1.9, sessions: 4 } })
    );
    const lines = renderLines(
      resolveBuildState({ root: f.root, offline: true, gh: noGh, board: false, elsewhere: false })
    );
    const at = (label) => lines.findIndex((l) => l.startsWith(`  ${label}`));
    assert.equal(
      lines[at('$ Spend')],
      '  $ Spend    ≈$38 · no quote · 4 sessions',
      'the fixture epic carries no quote, so no bar: a bar only against a known total'
    );
    // build-view-one-story D1 — what is happening, then what it costs, then what else is going on.
    assert.ok(at('$ Spend') > at('▸ Now'));
    assert.equal(at('$ Spend'), lines.length - 1, 'nothing else on this board-less view');
  } finally {
    f.done();
  }
});

test('finops 1.3: no summary, or no row for this epic, renders no Spend line — never a zero', () => {
  const f = fixture();
  try {
    f.git('switch', '-qc', 'feat/arranged-only');
    const state = () =>
      resolveBuildState({ root: f.root, offline: true, gh: noGh, board: false, elsewhere: false });
    assert.equal(state().spend, null);
    assert.ok(!renderLines(state()).some((l) => l.startsWith('  $ Spend')));
    mkdirSync(join(f.root, '.golden-frijoles'), { recursive: true });
    writeFileSync(join(f.root, '.golden-frijoles', 'usage-summary.json'), SUMMARY({ other: { usd: 5 } }));
    assert.equal(state().spend, null);
    writeFileSync(join(f.root, '.golden-frijoles', 'usage-summary.json'), '{ torn');
    assert.equal(state().spend, null, 'a torn file is no row, not a throw');
    writeFileSync(
      join(f.root, '.golden-frijoles', 'usage-summary.json'),
      JSON.stringify({ complete: false, epics: { 'arranged-only': { usd: 1, mtok: 1, sessions: 1 } } })
    );
    assert.equal(state().spend, null, 'an incomplete first scan shows no row, never an understated one');
  } finally {
    f.done();
  }
});

test('finops 1.3: a lower bound reads ≥, and cents show only under $1', async () => {
  const { dollars, spendValue } = await import('./build-state.mjs');
  assert.equal(dollars(38.42, false), '≥$38');
  assert.equal(dollars(0.65), '≈$0.65');
  assert.equal(
    spendValue({ usd: 3, usd_known: true, mtok: 7.9, sessions: 1, basis: 'this machine' }),
    '≈$3 · 1 session · this machine'
  );
});

// ── finops S2.4's four states, in the words of the design approved 2026-10-14 (build-view-one-story D8) ──────────────
test('build-view-one-story D8: the Spend line carries its own bar and the approved words', async () => {
  const { spendValue } = await import('./build-state.mjs');
  const q = { low: 30, high: 55, basis: 'M, n=6, p25–p75', appetite: 'M' };
  const spend = (usd, mtok, sessions) => ({ usd, usd_known: true, mtok, sessions, basis: 'this machine' });
  assert.equal(spendValue(spend(38, 1.9, 4), q), '▰▰▰▰▰▰▰▱▱▱  ≈$38 of the $30–55 quote · 4 sessions');
  assert.equal(spendValue(spend(71, 3.4, 9), q), '▰▰▰▰▰▰▰▰▰▰  ≈$71 · 29% over the $30–55 quote · 9 sessions');
  assert.equal(spendValue(spend(22, 1.1, 2), null), '≈$22 · no quote · 2 sessions', 'no quote, no bar');
  assert.equal(
    spendValue(spend(55.1, 1, 1), q),
    '▰▰▰▰▰▰▰▰▰▰  ≈$55 · <1% over the $30–55 quote · 1 session',
    'never "0% over"'
  );
  assert.equal(
    spendValue(spend(9, 0.4, 1), { low: 25, high: 90, basis: 'M, n=2, wide', appetite: 'M' }),
    '▰▱▱▱▱▱▱▱▱▱  ≈$9 of the $25–90 quote (2 past epics, wide) · 1 session'
  );
});

test('finops 2.4: a quote comes off the README only when both ends are numbers in order — else no quote, never $0', async () => {
  const { quoteOf } = await import('./build-state.mjs');
  assert.deepEqual(
    quoteOf({ quote_low_usd: 30, quote_high_usd: 55, quote_basis: 'M, n=6, p25–p75', appetite: 'M' }),
    {
      low: 30,
      high: 55,
      basis: 'M, n=6, p25–p75',
      appetite: 'M',
    }
  );
  assert.equal(quoteOf({ quote_low_usd: null, quote_high_usd: null }), null);
  assert.equal(quoteOf({ quote_low_usd: 60, quote_high_usd: 55 }), null);
  assert.equal(quoteOf({ quote_low_usd: '30', quote_high_usd: 55 }), null);
});

test('finops 2.4: on a quoted epic branch the resolver prints the inside state', () => {
  const f = fixture();
  try {
    const readme = join(f.root, 'Roadmap', '04-shipping', 'arranged-only', 'README.md');
    writeFileSync(
      readme,
      readFileSync(readme, 'utf8').replace(
        'stories_total: 3\n',
        'stories_total: 3\nquote_low_usd: 30\nquote_high_usd: 55\nquote_basis: "M, n=6, p25–p75"\n'
      )
    );
    f.git('add', '-A');
    f.git('commit', '-qm', 'quote');
    f.git('switch', '-qc', 'feat/arranged-only');
    mkdirSync(join(f.root, '.golden-frijoles'), { recursive: true });
    writeFileSync(
      join(f.root, '.golden-frijoles', 'usage-summary.json'),
      SUMMARY({ 'arranged-only': { usd: 38.42, mtok: 1.9, sessions: 4 } })
    );
    const lines = renderLines(
      resolveBuildState({ root: f.root, offline: true, gh: noGh, board: false, elsewhere: false })
    );
    assert.ok(
      lines.includes('  $ Spend    ▰▰▰▰▰▰▰▱▱▱  ≈$38 of the $30–55 quote · 4 sessions'),
      lines.join('\n')
    );
    // D2 — the size comes off `quote_basis` when the README has no `appetite:` (3 of 92 do).
    assert.match(lines[0], / · Arranged-only delivery · M · ▲ risk HIGH/);
  } finally {
    f.done();
  }
});

test('finops S3 (round 3, #232): a usage push the engine refused shows on the Spend line, never only in a file', async () => {
  const { spendValue } = await import('./build-state.mjs');
  const spend = { usd: 22, usd_known: true, mtok: 1.1, sessions: 2, basis: 'this machine', push_rejected: 2 };
  assert.equal(
    spendValue(spend, null),
    '≈$22 · no quote · 2 sessions · 2 usage pushes refused — epic-actuals --push --json'
  );
  assert.equal(spendValue({ ...spend, push_rejected: 0 }, null), '≈$22 · no quote · 2 sessions');
});
