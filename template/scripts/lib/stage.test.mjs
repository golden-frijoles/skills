// stage.test.mjs — the D13 stage rule, one fixture per stage plus every hard case the lock named.
// Run: node --test scripts/lib/stage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, attributeFacts, groupByStage, ownerOf, resolveStage } from './stage.mjs';
import { STAGES as BUCKET_STAGES } from './roadmap-status-buckets.mjs';

const epic = (status, sprints_total = 3) => ({ grain: 'Epic', status, sprints_total });
const seed = (status) => ({ grain: 'Seed', status });
const branch = (name, sprint = null) => ({ name, sprint });
const pr = (number, head, state, draft = false, sprint = null) => ({
  number,
  head,
  state,
  draft,
  url: `https://github.com/o/r/pull/${number}`,
  sprint,
});
const stageOf = (row, branches = [], prs = []) => resolveStage(row, { branches }, { prs }).stage;

test('the six stages are these words, in this order (D1)', () => {
  assert.deepEqual([...STAGES], ['To groom', 'Grooming', 'Ready to build', 'Building', 'QA', 'Shipped']);
  assert.ok(Object.isFrozen(STAGES));
});

test('roadmap-status-buckets re-exports the stages, so the old buckets have one home', () => {
  assert.equal(BUCKET_STAGES, STAGES);
});

test('one initiative per stage', () => {
  assert.equal(stageOf(seed('raw')), 'To groom');
  assert.equal(stageOf(seed('ready')), 'Grooming');
  assert.equal(stageOf(epic('scaffolded')), 'Ready to build');
  assert.equal(stageOf(epic('scaffolded'), [branch('feat/x')]), 'Building');
  assert.equal(stageOf(epic('scaffolded'), [branch('feat/x')], [pr(7, 'feat/x', 'OPEN')]), 'QA');
  assert.equal(stageOf(epic('shipped')), 'Shipped');
});

test('a seed with no status is To groom, and an epic with no status is Ready to build', () => {
  assert.equal(stageOf(seed(null)), 'To groom');
  assert.equal(stageOf(epic(null)), 'Ready to build');
});

test('a fixed-scope queued seed is Ready to build', () => {
  assert.equal(stageOf(seed('queued')), 'Ready to build');
});

test('an archived epic or seed is off the board, whatever git says', () => {
  const r = resolveStage(epic('archived'), { branches: [branch('feat/x')] }, { prs: [] });
  assert.equal(r.stage, null);
  assert.equal(stageOf(seed('archived')), null);
});

test('a shipped epic with a stale branch left on origin is Shipped (feat/mockups-as-built-s3, C7)', () => {
  assert.equal(stageOf(epic('shipped'), [branch('feat/x-s3', 3)]), 'Shipped');
});

test('in-progress is never Building on its own word (D3)', () => {
  assert.equal(stageOf(epic('in-progress')), 'Ready to build');
});

test('a draft PR is Building, a ready one is QA, back to draft is Building again', () => {
  const b = [branch('feat/x')];
  assert.equal(stageOf(epic('scaffolded'), b, [pr(9, 'feat/x', 'OPEN', true)]), 'Building');
  assert.equal(stageOf(epic('scaffolded'), b, [pr(9, 'feat/x', 'OPEN', false)]), 'QA');
});

test('stacked: -s2 PR ready and an -s3 branch with no PR → Building (the later sprint wins)', () => {
  const branches = [branch('feat/x-s2', 2), branch('feat/x-s3', 3)];
  const prs = [pr(12, 'feat/x-s2', 'OPEN', false, 2)];
  assert.equal(stageOf(epic('scaffolded', 3), branches, prs), 'Building');
});

test('stacked: -s3 PR ready and -s2 merged → QA', () => {
  const branches = [branch('feat/x-s2', 2), branch('feat/x-s3', 3)];
  const prs = [pr(12, 'feat/x-s2', 'MERGED', false, 2), pr(13, 'feat/x-s3', 'OPEN', false, 3)];
  const r = resolveStage(epic('scaffolded', 3), { branches }, { prs });
  assert.equal(r.stage, 'QA');
  assert.equal(r.source, 'github: PR #13 ready');
  assert.equal(r.pr.number, 13);
});

test('a tie between a ready PR and a branch still being built goes to Building', () => {
  const branches = [branch('feat/x'), branch('docs/x-notes')];
  assert.equal(stageOf(epic('scaffolded'), branches, [pr(5, 'feat/x', 'OPEN')]), 'Building');
});

test('a merged branch kept on origin is not Building (C7) — merged, close-out owed is QA', () => {
  const branches = [branch('feat/x'), branch('feat/x-s2', 2)];
  const prs = [pr(1, 'feat/x', 'MERGED'), pr(2, 'feat/x-s2', 'MERGED', false, 2)];
  const r = resolveStage(epic('in-progress', 2), { branches }, { prs });
  assert.equal(r.stage, 'QA');
  assert.equal(r.source, 'github: PR #2 merged');
});

test('a deleted branch whose PR merged still counts — paused between sprints is Ready to build', () => {
  const prs = [pr(1, 'feat/x', 'MERGED')];
  const row = {
    ...epic('in-progress', 3),
    sprints: [
      { n: 1, status: 'Shipped' },
      { n: 2, status: 'Planned' },
      { n: 3, status: 'Planned' },
    ],
  };
  const r = resolveStage(row, { branches: [] }, { prs });
  assert.equal(r.stage, 'Ready to build');
  assert.equal(r.source, 'github: PR #1 merged, S2 not started');
});

test('one PR that shipped every sprint from feat/<slug> is QA, not paused at sprint 1 (scenarios-pm-operable, #98)', () => {
  const prs = [pr(98, 'feat/x', 'MERGED')];
  const row = {
    ...epic('in-progress', 3),
    sprints: [
      { n: 1, status: 'Shipped' },
      { n: 2, status: 'Shipped' },
      { n: 3, status: 'Shipped' },
    ],
  };
  assert.equal(stageOf(row, [], prs), 'QA');
});

test('without sprint statuses the merged sprint number is compared with the sprint count', () => {
  assert.equal(stageOf(epic('in-progress', 3), [], [pr(1, 'feat/x', 'MERGED')]), 'Ready to build');
  assert.equal(stageOf(epic('in-progress', 3), [], [pr(3, 'feat/x-s3', 'MERGED', false, 3)]), 'QA');
});

test('an abandoned branch (newest PR closed unmerged) is not Building', () => {
  assert.equal(
    stageOf(epic('scaffolded'), [branch('feat/x')], [pr(4, 'feat/x', 'CLOSED')]),
    'Ready to build'
  );
});

test('a branch reopened after a closed PR follows its NEWEST PR', () => {
  const prs = [pr(4, 'feat/x', 'CLOSED'), pr(8, 'feat/x', 'OPEN', true)];
  assert.equal(stageOf(epic('scaffolded'), [branch('feat/x')], prs), 'Building');
});

test('a seed being fixed: branch → Building, ready PR → QA, merged → QA until it is marked shipped', () => {
  assert.equal(stageOf(seed('queued'), [branch('fix/x')]), 'Building');
  assert.equal(stageOf(seed('queued'), [branch('fix/x')], [pr(3, 'fix/x', 'OPEN')]), 'QA');
  assert.equal(stageOf(seed('queued'), [], [pr(3, 'fix/x', 'MERGED')]), 'QA');
  assert.equal(stageOf(seed('shipped'), [], [pr(3, 'fix/x', 'MERGED')]), 'Shipped');
});

test('facts from a snapshot say so in the source', () => {
  const r = resolveStage(
    epic('scaffolded'),
    { branches: [branch('feat/x')] },
    { prs: [] },
    'snapshot@2026-10-01T00:00:00Z'
  );
  assert.equal(r.source, 'git: feat/x · snapshot@2026-10-01T00:00:00Z');
  // Docs answers carry no snapshot suffix: docs never age.
  assert.equal(resolveStage(seed('raw'), undefined, undefined, 'snapshot@x').source, 'docs: status raw');
});

test('ownerOf takes the longest reading that names a known slug, and folds a seed into its epic', () => {
  const known = new Set(['aws', 'aws-s3', 'board']);
  assert.deepEqual(ownerOf('feat/aws-s3', known), { slug: 'aws-s3', sprint: null });
  assert.deepEqual(ownerOf('feat/aws-s2', known), { slug: 'aws', sprint: 2 });
  assert.equal(ownerOf('claude/aws', known), null);
  assert.equal(ownerOf('dependabot/npm/aws', known), null);
  assert.deepEqual(ownerOf('feat/board-s4-licences', known, new Map([['board', 'board-epic']])), {
    slug: 'board-epic',
    sprint: 4,
  });
});

test('attributeFacts files branches and PRs under their initiative, PRs by head NAME', () => {
  const facts = attributeFacts(
    {
      branches: ['feat/x-s2', 'main', 'claude/x'],
      prs: [
        { number: 1, head: 'feat/x', state: 'MERGED', draft: false, url: 'u1' },
        { number: 2, head: 'feat/y', state: 'OPEN', draft: true, url: 'u2' },
      ],
    },
    new Set(['x'])
  );
  assert.deepEqual([...facts.keys()], ['x']);
  assert.deepEqual(facts.get('x').branches, [{ name: 'feat/x-s2', sprint: 2 }]);
  assert.equal(facts.get('x').prs[0].number, 1);
});

test('groupByStage: six columns, Ready to build in build order, Shipped newest first, no sprints, no archived', () => {
  const rows = [
    { grain: 'Epic', name: 'B', stage: 'Ready to build', build_order_num: 20 },
    { grain: 'Epic', name: 'A', stage: 'Ready to build', build_order_num: 18 },
    { grain: 'Seed', name: 'Z', stage: 'Ready to build', build_order_num: null },
    { grain: 'Epic', name: 'Old', stage: 'Shipped', shipped_at: '2026-08-01' },
    { grain: 'Epic', name: 'New', stage: 'Shipped', shipped_at: '2026-09-30' },
    { grain: 'Sprint', name: 'A — S1', stage: 'Building' },
    { grain: 'Epic', name: 'Gone', stage: null },
  ];
  const cols = groupByStage(rows);
  assert.deepEqual(Object.keys(cols), [...STAGES]);
  assert.deepEqual(
    cols['Ready to build'].map((r) => r.name),
    ['A', 'B', 'Z']
  );
  assert.deepEqual(
    cols.Shipped.map((r) => r.name),
    ['New', 'Old']
  );
  assert.equal(cols.Building.length, 0);
});

test('groupByStage can order Shipped by build order, highest first — the committed board must not read git dates', () => {
  const rows = [
    { grain: 'Epic', name: 'Early', stage: 'Shipped', build_order_num: 3, shipped_at: '2026-09-30' },
    { grain: 'Epic', name: 'Late', stage: 'Shipped', build_order_num: 30, shipped_at: '2026-08-01' },
    { grain: 'Epic', name: 'Unordered', stage: 'Shipped', build_order_num: null, shipped_at: '2026-10-01' },
  ];
  assert.deepEqual(
    groupByStage(rows, { shipped: 'build-order' }).Shipped.map((r) => r.name),
    ['Late', 'Early', 'Unordered']
  );
  assert.deepEqual(
    groupByStage(rows).Shipped.map((r) => r.name),
    ['Unordered', 'Early', 'Late']
  );
});
