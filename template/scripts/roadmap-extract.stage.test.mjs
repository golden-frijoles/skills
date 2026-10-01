// roadmap-extract.stage.test.mjs — the projection carries stage and the card's prose (board-sinks-and-scrumban S1.2).
//
// Spawns the REAL extractor in a temp repo (its project root is resolved from its own location, so an in-process
// import would read this repo). The fixture holds one epic per docs stage, a branch and a PR in a snapshot, and
// asserts the D21 fields every sink reads. Run: node --test scripts/roadmap-extract.stage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIBS = ['project-root.mjs', 'stage.mjs', 'work-branch.mjs', 'stage-facts.mjs', 'epic-kickoff.mjs'];

const epicReadme = (slug, status, title) => `---
status: ${status}
slug: ${slug}
title: "${title}"
area: 02-commercial
risk: high
type: feature
build_order: ${slug === 'ready-epic' ? 18 : 30}
---

# Epic: ${title}

> **Area:** 02-commercial · **Risk:** high

## Why
So that a stranger installs it **once** and every skill
runs in their own repo.

## Scope
`;
const sprint = (title, n) => `---
epic: x
sprint: ${n}
title: "${title}"
phase: Shaping
---
# ${title} — Sprint ${n}: Part ${n}

**Status:** ⬜ not started

### Story ${n}.1 — Do the thing
`;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'extract-stage-')));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  writeFileSync(
    join(root, 'scripts', 'roadmap-extract.mjs'),
    readFileSync(join(HERE, 'roadmap-extract.mjs'))
  );
  for (const lib of LIBS)
    writeFileSync(join(root, 'scripts', 'lib', lib), readFileSync(join(HERE, 'lib', lib)));
  for (const [slug, status, title] of [
    ['ready-epic', 'scaffolded', 'Ready epic'],
    ['building-epic', 'scaffolded', 'Building epic'],
  ]) {
    const dir = join(root, 'Roadmap', '02-commercial', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), epicReadme(slug, status, title));
    writeFileSync(join(dir, 'sprint-1.md'), sprint(title, 1));
    writeFileSync(join(dir, 'sprint-2.md'), sprint(title, 2));
  }
  const seeds = join(root, 'Roadmap', '00-ideas', 'seeds');
  mkdirSync(seeds, { recursive: true });
  writeFileSync(
    join(seeds, 'raw-seed.md'),
    '---\ntitle: "A raw idea"\nslug: raw-seed\nstatus: raw\narea: "02"\ntype: feature\nepic: null\n---\n\n# A raw idea\n\n## Problem\nNobody can see the board.\n'
  );
  writeFileSync(
    join(seeds, 'fix-seed.md'),
    '---\ntitle: "A fixed-scope fix"\nslug: fix-seed\nstatus: queued\nappetite: S\narea: "02"\ntype: bug\nepic: null\n---\n\n# A fix\n'
  );
  mkdirSync(join(root, '.golden-frijoles'));
  writeFileSync(
    join(root, '.golden-frijoles', 'board.json'),
    JSON.stringify({
      generated_at: '2026-10-01T09:00:00.000Z',
      source: 'github',
      branches: ['main', 'feat/building-epic-s2'],
      prs: [
        { number: 41, head: 'feat/building-epic', state: 'MERGED', draft: false, url: 'https://x/pull/41' },
      ],
    })
  );
  return root;
}

function extract(root, ...args) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'roadmap-extract.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return new Map(JSON.parse(r.stdout).map((row) => [row.slug, row]));
}

test('the default run reads the snapshot: stage, its source and the snapshot age on every git/GitHub answer', () => {
  const rows = extract(fixture());
  const building = rows.get('building-epic');
  assert.equal(building.stage, 'Building');
  assert.equal(building.stage_source, 'git: feat/building-epic-s2 · snapshot@2026-10-01T09:00:00.000Z');
  assert.equal(rows.get('ready-epic').stage, 'Ready to build');
  assert.equal(rows.get('ready-epic').stage_source, 'docs: status scaffolded', 'docs never age');
  assert.equal(rows.get('raw-seed').stage, 'To groom');
  assert.equal(rows.get('fix-seed').stage, 'Ready to build');
});

test('--docs-only ignores the snapshot entirely (what the committed BUILD-ORDER.md reads — lock C3)', () => {
  const rows = extract(fixture(), '--docs-only');
  assert.equal(rows.get('building-epic').stage, 'Ready to build');
  assert.equal(rows.get('building-epic').stage_source, 'docs: status scaffolded');
});

test('an epic card carries its goal, sprints, links and type; only a Ready-to-build card carries a kickoff', () => {
  const rows = extract(fixture());
  const ready = rows.get('ready-epic');
  assert.equal(ready.goal, 'So that a stranger installs it once and every skill runs in their own repo.');
  assert.deepEqual(ready.sprints, [
    { n: 1, title: 'Part 1', done: 0, total: 1 },
    { n: 2, title: 'Part 2', done: 0, total: 1 },
  ]);
  assert.deepEqual(ready.links, {
    readme: 'Roadmap/02-commercial/ready-epic/README.md',
    seed: null,
    sprints: ['Roadmap/02-commercial/ready-epic/sprint-1.md', 'Roadmap/02-commercial/ready-epic/sprint-2.md'],
    retro: null,
  });
  assert.equal(ready.type, 'Feature', 'the README frontmatter type, not "Epic"');
  assert.equal(ready.risk, 'High');
  assert.equal(ready.build_order_num, 18);
  assert.match(ready.kickoff, /^Start by pushing the epic branch, before anything else/);
  assert.match(ready.kickoff, /git switch -c feat\/ready-epic origin\/main/);
  assert.equal(rows.get('building-epic').kickoff, null);
  assert.equal(ready.pr, null);
  assert.equal(ready.shipped_at, null);
});

test('a queued seed gets the fixed-scope Build kickoff on the branch its type names', () => {
  const fix = extract(fixture()).get('fix-seed');
  assert.match(fix.kickoff, /git switch -c fix\/fix-seed origin\/main/);
  assert.match(fix.kickoff, /^Build: "A fixed-scope fix" — fixed scope/m);
  assert.equal(fix.type, 'Bug');
});

test('a seed card carries its problem as the goal and links to itself', () => {
  const raw = extract(fixture()).get('raw-seed');
  assert.equal(raw.goal, 'Nobody can see the board.');
  assert.deepEqual(raw.links, {
    readme: null,
    seed: 'Roadmap/00-ideas/seeds/raw-seed.md',
    sprints: [],
    retro: null,
  });
  assert.equal(raw.kickoff, null);
});
