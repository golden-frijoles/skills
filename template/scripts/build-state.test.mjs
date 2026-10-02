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
  parseBranch,
  branchCandidates,
  parseWorktrees,
  storyIdsIn,
  namesSlug,
} from './build-state.mjs';
import { PHASES } from './lib/roadmap-contract.mjs';

const EPIC_README = (phase = 'Building') => `---
status: in-progress
slug: arranged-only
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
      path: 'Roadmap/04-shipping/arranged-only/README.md',
    });
    assert.equal(s.story.id, 'S2.1');
    assert.equal(s.story.as_a, "a buyer's agent");
    assert.equal(s.story_source, 'commit');
    assert.deepEqual(s.progress, { story: 2, stories: 3, sprint: 2, sprints: 2 });
    assert.equal(s.status, 'Building');
    assert.equal(s.evidence.gh, 'skipped (--offline)');

    f.commit('S2.2 — seller toggle');
    assert.equal(
      resolveBuildState({ root: f.root, offline: true, gh: noGh }).progress.story,
      3,
      'X advances by one'
    );
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
    // Nothing here — but the Roadmap says the fixture's epic is in progress, so the view names it.
    assert.deepEqual(renderLines(detached), [
      `No epic in flight — ${detached.reason}`,
      '  Open     Arranged-only delivery · Building · 04-shipping',
    ]);
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
    assert.equal(renderLines(s)[2], '  Story    unknown');
    assert.match(renderLines(s)[4], /Story \? of 3 · Sprint \? of 2/);
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

test('renderLines is a pure function of the state: the exact five lines, no box', () => {
  const state = {
    in_flight: true,
    epic: { title: 'Arranged-only delivery', area: '04-shipping', risk: 'high' },
    story: {
      id: 'S2.1',
      title: 'Agent surface parity',
      as_a: "a buyer's agent",
      i_want: 'checkout options to reflect arranged-only listings',
      so_that: "I'm never offered a carrier rail the seller can't fulfil",
    },
    progress: { story: 4, stories: 7, sprint: 2, sprints: 2 },
    status: 'Building',
  };
  assert.deepEqual(renderLines(state), [
    'Currently building',
    '  Epic     Arranged-only delivery    04-shipping · risk HIGH',
    '  Story    S2.1 — Agent surface parity',
    "           As a buyer's agent, I want checkout options to reflect arranged-only listings, so that I'm never offered a carrier rail the seller can't fulfil.",
    '  Progress Story 4 of 7 · Sprint 2 of 2',
    '  Status   Building',
  ]);
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
    assert.match(s.story_note, /name S1\.1 — none of them sprint 2 of this epic's/);
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
    assert.match(out, /^No epic in flight — /, 'a symlinked invocation still prints the view');
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
    assert.match(
      renderLines(s).at(-1),
      /^ {2}Status {3}unknown — .*sprint-2\.md frontmatter could not be read/
    );
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
      'Currently fixing',
      '  Bug      A bug called checkout-typo    appetite S · risk LOW',
      '  Seed     Roadmap/00-ideas/seeds/checkout-typo.md',
      '  Status   Building',
    ]);
    const gh = ghWith({ number: 9, url: 'u' });
    assert.equal(resolveBuildState({ board: false, root: f.root, gh }).status, 'In review');
    addSeed(f, 'why-slow', 'spike');
    f.git('switch', '-qc', 'spike/why-slow');
    assert.equal(
      renderLines(resolveBuildState({ board: false, root: f.root, offline: true, gh: noGh }))[0],
      'Currently investigating'
    );
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
      '  Worktree Arranged-only delivery · S2.1 · Building · feat/arranged-only-s2',
    ]);

    const there = resolveBuildState({ board: false, root: wt, offline: true, gh: noGh });
    assert.equal(there.in_flight, true);
    assert.equal(there.elsewhere.worktrees.length, 0, 'the root is on main, so nothing else is in flight');
    assert.equal(renderLines(there).length, 6, 'no Also line');
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
    assert.deepEqual(renderLines(s), [`No epic in flight — ${s.reason}`]);
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
    const status = renderLines(s).find((l) => l.startsWith('  Status'));
    assert.equal(status, '  Status   QA · from github: PR #7 ready (live) · phase Building');
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
    assert.match(
      renderLines(s).find((l) => l.startsWith('  Status')),
      /^ {2}Status {3}Building · from git: feat\/arranged-only-s2 \(snapshot, 3h ago\)/
    );

    rmSync(join(f.root, '.golden-frijoles'), { recursive: true, force: true });
    const none = resolveBuildState({ root: f.root, offline: true, elsewhere: false });
    assert.match(
      renderLines(none).find((l) => l.startsWith('  Status')),
      /\(docs only, no snapshot yet\)/
    );
  } finally {
    f.done();
  }
});

test('S3.1: the Board line links to the card on the Hub when board.hubUrl is set, and is silent about it when not', () => {
  const f = fixture();
  try {
    f.git('checkout', '-qb', 'feat/arranged-only-s2');
    const plain = renderLines(resolveBuildState({ root: f.root, gather: liveFacts(), elsewhere: false }));
    assert.ok(plain.some((l) => l.startsWith('  Board    ')));
    assert.ok(!plain.some((l) => l.includes('↗')), 'no hub URL configured → no link, no error');

    writeFileSync(
      join(f.root, 'golden-frijoles.config.json'),
      JSON.stringify({ board: { hubUrl: 'https://goldenfrijoles.com/hub/demo/' } })
    );
    const linked = renderLines(resolveBuildState({ root: f.root, gather: liveFacts(), elsewhere: false }));
    assert.ok(
      linked.includes('           ↗ https://goldenfrijoles.com/hub/demo/board?card=arranged-only'),
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
    assert.equal(lines[at('Spend')], '  Spend    ≈$38 · 1.9M tok · 4 sessions · this machine');
    assert.equal(at('Spend'), at('Progress') + 1);
    assert.equal(at('Status'), at('Spend') + 1);
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
    assert.ok(!renderLines(state()).some((l) => l.startsWith('  Spend')));
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
    '≈$3 · 7.9M tok · 1 session · this machine'
  );
});
