// roadmap-backfill.test.mjs — the backfill reads prose once, writes the contract, reports what it could
// not resolve, and is idempotent (build-visualization-claude-mods S2.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUserStory, readRisk, readStories, planBackfill } from './roadmap-backfill.mjs';
import {
  parseDocFrontmatter,
  validateEpicFrontmatter,
  validateSprintFrontmatter,
} from './lib/roadmap-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// The board extractor, as this repo ships it: the template's is self-contained, while a consumer's may be a
// thin delegate to its own roadmap-to-notion.mjs — copy that too when it is there.
const EXTRACTOR_FILES = ['roadmap-extract.mjs', 'roadmap-to-notion.mjs'].filter((f) =>
  existsSync(join(HERE, f))
);

test('readUserStory: the shapes the corpus uses', () => {
  const want = { as_a: 'a buyer', i_want: 'to pay once', so_that: 'I am not charged twice' };
  assert.deepEqual(
    readUserStory('**As a** buyer, **I want** to pay once, **so that** I am not charged twice.'),
    want
  );
  assert.deepEqual(
    readUserStory(
      '> **As** the product owner, **I want** the nav to name real pages, **so that** I can find\n> the string.'
    ),
    { as_a: 'the product owner', i_want: 'the nav to name real pages', so_that: 'I can find the string' }
  );
  assert.deepEqual(
    readUserStory('**As** admin, **I want** a % per SKU, **so that** I can tune it. One % per SKU (x).'),
    { as_a: 'admin', i_want: 'a % per SKU', so_that: 'I can tune it' },
    'so_that stops at the end of its sentence'
  );
  assert.deepEqual(
    readUserStory('**As any** tool, **I want** one resolver,\n**so that** nothing parses markdown.'),
    {
      as_a: 'any tool',
      i_want: 'one resolver',
      so_that: 'nothing parses markdown',
    }
  );
});

test('readUserStory: no user story → null, not a guess', () => {
  assert.equal(readUserStory('**Built:** `abc123`. New model, unique index.'), null);
  assert.equal(readUserStory('As noted above, this is a chore.'), null);
});

test('readRisk: the tier word after the label, whatever surrounds it', () => {
  assert.equal(readRisk('**Risk:** LOW — docs only'), 'low');
  assert.equal(readRisk('**Risk: HIGH** (money)'), 'high');
  assert.equal(readRisk('> **Epic:** x · **Risk:** all LOW'), 'low');
  assert.equal(readRisk('**Risk:** med'), 'med');
  assert.equal(readRisk('no risk line here'), null);
});

const SPRINT = `# E — Sprint 2: Two

**Status:** 🏗 In progress

### Story 2.1 — First ✅ \`abc\`
**As a** seller, **I want** a thing, **so that** it works.
**Risk:** high

### Story 2.2 — Second — low
Just notes.

## Sprint QA
**As a** stray, **I want** nothing, **so that** this is never read as story 2.2.
`;

test('readStories: ids from the headings, titles cleaned, ✅ is done, risk per story, findings named', () => {
  const { stories, findings } = readStories(SPRINT, 2, { sprintRisk: 'low', sprintShipped: false });
  assert.deepEqual(stories, [
    {
      id: 'S2.1',
      title: 'First',
      as_a: 'a seller',
      i_want: 'a thing',
      so_that: 'it works',
      risk: 'high',
      status: 'done',
    },
    { id: 'S2.2', title: 'Second', as_a: null, i_want: null, so_that: null, risk: 'low', status: 'planned' },
  ]);
  assert.deepEqual(findings, [
    'S2.2: no "As a … I want … so that …" line — as_a/i_want/so_that written null',
  ]);
});

test('readStories: duplicate or foreign numbering falls back to position, and says so', () => {
  const dup = readStories('### Story 1.1 — a\n### Story 1.1 — b\n', 1, {
    sprintRisk: 'low',
    sprintShipped: true,
  });
  assert.deepEqual(
    dup.stories.map((s) => [s.id, s.status]),
    [
      ['S1.1', 'done'],
      ['S1.2', 'done'],
    ]
  );
  assert.ok(dup.findings.some((f) => f.startsWith('duplicate story numbers')));
  const foreign = readStories('## US-4 — a\n### Story 3.1 — b\n', 2, {
    sprintRisk: 'medium',
    sprintShipped: false,
  });
  assert.deepEqual(
    foreign.stories.map((s) => [s.id, s.risk]),
    [
      ['S2.1', 'high'],
      ['S2.2', 'high'],
    ]
  );
  assert.ok(foreign.findings.some((f) => /names sprint 3 in sprint-2\.md/.test(f)));
  assert.ok(foreign.findings.some((f) => /risk "medium" is not low\|high — written high/.test(f)));
  assert.deepEqual(readStories('No stories.\n', 1, { sprintRisk: 'low' }).findings, [
    'no story headings — no clean story boundaries; `stories:` written empty',
  ]);
});

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'backfill-'));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  for (const f of ['roadmap-backfill.mjs', ...EXTRACTOR_FILES])
    copyFileSync(join(HERE, f), join(root, 'scripts', f));
  copyFileSync(
    join(HERE, 'lib', 'roadmap-contract.mjs'),
    join(root, 'scripts', 'lib', 'roadmap-contract.mjs')
  );
  // roadmap-extract.mjs resolves the project through lib/project-root.mjs (golden-frijoles-plugin D2) and computes
  // each row's stage through the board-sinks-and-scrumban libs (D13/D14/D17).
  for (const lib of [
    'project-root.mjs',
    'stage.mjs',
    'work-branch.mjs',
    'stage-facts.mjs',
    'epic-kickoff.mjs',
  ])
    copyFileSync(join(HERE, 'lib', lib), join(root, 'scripts', 'lib', lib));
  const epic = join(root, 'Roadmap', '04-shipping', 'arranged-only');
  mkdirSync(epic, { recursive: true });
  writeFileSync(
    join(epic, 'README.md'),
    '---\nstatus: in-progress   # AUTHORITATIVE\nslug: arranged-only\n---\n\n# Epic: Arranged-only delivery\n\n' +
      '> **Area:** 04-shipping · **Risk:** HIGH · **Class:** Feature\n'
  );
  writeFileSync(
    join(epic, 'sprint-1.md'),
    SPRINT.replace(/Sprint 2/, 'Sprint 1').replace(/2\.(\d)/g, '1.$1')
  );
  writeFileSync(join(epic, 'sprint-2.md'), SPRINT.replace('✅', ''));
  const old = join(root, 'Roadmap', '04-shipping', 'old-thing');
  mkdirSync(old);
  writeFileSync(join(old, 'README.md'), '---\nstatus: archived\nslug: old-thing\n---\n# Epic: Old\n');
  writeFileSync(join(old, 'sprint-1.md'), '# Old — Sprint 1: x\n');
  return { root, epic };
}

test('end to end: the written docs pass the contract, the prose is untouched, a second run is a no-op', () => {
  const { root, epic } = fixtureRepo();
  try {
    const before = readFileSync(join(epic, 'sprint-2.md'), 'utf8');
    const run = () =>
      spawnSync('node', ['scripts/roadmap-backfill.mjs', '--write', '--report', 'Roadmap/audit.md'], {
        cwd: root,
        encoding: 'utf8',
      });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /3 file\(s\) written \(1 epic README\(s\), 2 sprint file\(s\)\)/);

    const readme = parseDocFrontmatter(readFileSync(join(epic, 'README.md'), 'utf8'));
    assert.deepEqual(validateEpicFrontmatter(readme, { sprintCount: 2, storyCount: 4 }), []);
    assert.equal(readme.data.status, 'in-progress', 'the lifecycle status is never rewritten');
    assert.deepEqual(
      [readme.data.title, readme.data.area, readme.data.risk, readme.data.type, readme.data.stories_total],
      ['Arranged-only delivery', '04-shipping', 'high', 'feature', 4]
    );
    for (const n of [1, 2]) {
      const parsed = parseDocFrontmatter(readFileSync(join(epic, `sprint-${n}.md`), 'utf8'));
      assert.deepEqual(validateSprintFrontmatter(parsed, { n, slug: 'arranged-only' }), [], `sprint-${n}`);
    }
    assert.ok(
      readFileSync(join(epic, 'sprint-2.md'), 'utf8').endsWith(before),
      'the prose is kept byte-for-byte'
    );
    assert.equal(
      readFileSync(join(root, 'Roadmap', '04-shipping', 'old-thing', 'sprint-1.md'), 'utf8'),
      '# Old — Sprint 1: x\n'
    );

    const report = readFileSync(join(root, 'Roadmap', 'audit.md'), 'utf8');
    assert.match(report, /`Roadmap\/04-shipping\/arranged-only\/sprint-2\.md` \| S2\.2: no "As a/);
    assert.match(report, /archived, skipped as frozen record: 1/);

    const second = run();
    assert.match(second.stdout, /nothing to backfill/);
    assert.equal(
      readFileSync(join(root, 'Roadmap', 'audit.md'), 'utf8'),
      report,
      'the report is not rewritten'
    );
    assert.equal(planBackfill(root).writes.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review fixes (#26): so_that stops before a list and after a quoted sentence end', () => {
  assert.deepEqual(
    readUserStory(
      '**As a** buyer, **I want** to report a payment, **so that** it shows "pending."\n- New backend `POST /x` persists it'
    ),
    { as_a: 'a buyer', i_want: 'to report a payment', so_that: 'it shows "pending"' }
  );
  assert.equal(
    readUserStory('**As a** buyer, **I want** a thing, **so that** it works\n1. step one\n2. step two')
      .so_that,
    'it works'
  );
});
