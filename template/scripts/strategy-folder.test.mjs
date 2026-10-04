// strategy-folder.test.mjs — the Roadmap tools ignore Roadmap/00-strategy/ (think-skills S2.2, D8).
//
// The strategy coaches leave flat files in `Roadmap/00-strategy/`. Its name matches the `NN-` pattern every walker
// uses to find macro sections, so the question is real: does a strategy file ever turn up as an epic, a seed or a
// doc-format finding? It does not, by construction — each walker only takes `Roadmap/<NN-area>/<dir>/README.md`, and
// a flat file is neither a directory nor has a README. These are PINS of that property, not fixes: each runs the real
// tool against a fixture project twice, with and without the folder, and requires identical output.
//
// Each pin is proven able to fail on the D8 violation, a strategy SUBFOLDER that carries a README.md, because the
// extractor and the board skip a flat file twice over (it isn't a directory, and it has no README), so no one-line
// change to their walk picks it up. doc-format's per-file path is the exception: widening its sprint-file match
// (`/^sprint-\d+\.md$/` to `/\.md$/`) does turn its `--files` pin red (fresh review, #215).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const EPIC = `---
status: in-progress
phase: Building
slug: demo-epic
title: "Demo epic"
area: 09-platform-infra
risk: low
type: feature
sprints_total: 1
stories_total: 1
build_order: 1
underwritten_by: wave-demo
---

# Epic: Demo epic
`;

const SPRINT = `---
epic: demo-epic
sprint: 1
title: "One"
risk: low
phase: Building
stories_total: 1
stories:
  - id: S1.1
    title: "A story"
    risk: low
    status: planned
---
# Demo epic — Sprint 1: One

**Status:** ⬜ not started
`;

const STRATEGY = {
  'north-star.md': '---\nkind: north-star\nstatus: draft\nupdated: 2026-09-30\n---\n\n# North Star\n\n## Sync payload\n',
  'pmf-narrative.md': '---\nkind: pmf-narrative\nstatus: agreed\nupdated: 2026-09-30\n---\n\n# PMF\n\n## Problem to solve\n',
  'risk-validation.md': '---\nkind: risk-validation\nstatus: draft\nupdated: 2026-09-30\n---\n\n# Risk\n',
};

/** A fixture project. `strategy`: null = no folder, 'flat' = the D8 contract, 'subfolder' = the D8 violation. */
function fixture(strategy) {
  const root = mkdtempSync(join(tmpdir(), 'strategy-folder-'));
  const epic = join(root, 'Roadmap', '09-platform-infra', 'demo-epic');
  mkdirSync(epic, { recursive: true });
  mkdirSync(join(root, 'Roadmap', '00-ideas', 'seeds'), { recursive: true });
  writeFileSync(join(epic, 'README.md'), EPIC);
  mkdirSync(join(root, 'Roadmap', 'bets'), { recursive: true }); // a live epic is funded (fund-at-approval D8)
  writeFileSync(join(root, 'Roadmap', 'bets', 'wave-demo.md'), '# Cycle demo\n');
  writeFileSync(join(epic, 'sprint-1.md'), SPRINT);
  if (strategy) {
    const dir = join(root, 'Roadmap', '00-strategy');
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(STRATEGY)) writeFileSync(join(dir, name), text);
    if (strategy === 'subfolder') {
      mkdirSync(join(dir, 'north-star'));
      writeFileSync(join(dir, 'north-star', 'README.md'), EPIC.replace(/demo-epic/g, 'north-star'));
    }
  }
  return root;
}

function tool(root, script, args = []) {
  const result = spawnSync(process.execPath, [join(HERE, script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GF_PROJECT_ROOT: root },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const extract = (root) => {
  const { status, out } = tool(root, 'roadmap-extract.mjs');
  assert.equal(status, 0, out);
  return JSON.parse(out).map((row) => `${row.grain}:${row.slug ?? row.name}`);
};

test('roadmap-extract: a flat Roadmap/00-strategy/ adds no row', () => {
  const without = extract(fixture(null));
  assert.ok(without.includes('Epic:demo-epic'), 'the fixture epic is seen at all');
  assert.deepEqual(extract(fixture('flat')), without);
});

test('roadmap-extract: the pin can fail — a strategy subfolder with a README becomes an epic row (the D8 violation)', () => {
  assert.notDeepEqual(extract(fixture('subfolder')), extract(fixture(null)));
});

test('build-order: the board is byte-identical with a flat Roadmap/00-strategy/', () => {
  const board = (root) => {
    const { status, out } = tool(root, 'build-order.mjs');
    assert.equal(status, 0, out);
    return readFileSync(join(root, 'Roadmap', '00-ideas', 'BUILD-ORDER.md'), 'utf8').replace(
      /^> \*\*Generated \d{4}-\d{2}-\d{2} /m,
      '> **Generated DATE '
    );
  };
  const without = board(fixture(null));
  assert.match(without, /demo-epic/);
  assert.equal(board(fixture('flat')), without);
  assert.notEqual(board(fixture('subfolder')), without);
});

test('doc-format: strategy files are not a doc type it checks, in the full walk or by name', () => {
  const report = (root) => tool(root, 'doc-format.mjs').out;
  assert.equal(report(fixture('flat')), report(fixture(null)));
  // The failing direction: a strategy subfolder with a README is walked as an epic and its doc is checked.
  assert.notEqual(report(fixture('subfolder')), report(fixture(null)));
  for (const name of Object.keys(STRATEGY)) {
    const root = fixture('flat');
    const { status, out } = tool(root, 'doc-format.mjs', ['--check', '--files', `Roadmap/00-strategy/${name}`]);
    assert.equal(status, 0, out);
    assert.doesNotMatch(out, /00-strategy/);
  }
});
