// roadmap-extract.test.mjs — the PURE tier of the Roadmap extractor: projection logic, no filesystem walk.
//
// Ported from the origin project's roadmap-to-notion.test.mjs with the extractor split (plugin-audit-and-
// extraction S1, story 1.5). Only the assertions for logic the template's extractor HAS came across:
// lifecycleForPr moved with the Notion sync to optional/notion/ (CI smokes it from a temp copy), and the
// origin's later additions (dangling seed pointers, external-sprint epics) were not part of this port.
//   • floorSprintStatus / floorSprintDone — an archived epic's sprints read Archived, a Shipped epic's
//     stale Planned sprints read Shipped, real in-flight signals pass through.
//   • the status-enum hard-fail + seed status labels.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  floorSprintStatus, normalizeBuildOrder, deriveEpicStatus,
  frontmatterStatusBucket, seedStatusLabel, floorSprintDone,
} from './roadmap-extract.mjs';

// --- S1.1: floorSprintStatus ---------------------------------------------------------------------
test('floorSprintStatus: an Archived epic floors EVERY sprint status to Archived', () => {
  for (const sp of ['Planned', 'In progress', 'In review', 'Shipped']) {
    assert.equal(floorSprintStatus('Archived', sp), 'Archived');
  }
});

test('floorSprintStatus: a Shipped epic floors ALL sprint statuses to Shipped', () => {
  // A shipped epic cannot have a non-shipped sprint — Planned/In progress/In review all → Shipped.
  // (Previously only Planned was floored, so In progress/In review leaked onto the board as stale rows.)
  for (const sp of ['Planned', 'In progress', 'In review', 'Shipped']) {
    assert.equal(floorSprintStatus('Shipped', sp), 'Shipped');
  }
});

test('floorSprintStatus: a NON-terminal epic keeps the real per-sprint signal', () => {
  assert.equal(floorSprintStatus('In progress', 'In progress'), 'In progress');
  assert.equal(floorSprintStatus('In progress', 'In review'), 'In review');
  assert.equal(floorSprintStatus('In progress', 'Planned'), 'Planned');
  assert.equal(floorSprintStatus('Scaffolded', 'Planned'), 'Planned');
});

// --- deriveEpicStatus: an `archived` epic short-circuits so the board never false-flags drift -----
test('deriveEpicStatus: an archived epic derives Archived regardless of its sprints', () => {
  // The bug this fixes: without the short-circuit, an archived epic with open-looking sprints derives
  // In progress/Shipped, so status (Archived) != status_derived → permanent false drift every regen.
  const openSprints = [{ status: 'In progress' }, { status: 'Planned' }];
  assert.equal(deriveEpicStatus(openSprints, false, 'archived'), 'Archived');
  assert.equal(deriveEpicStatus([{ status: 'Shipped' }], true, 'archived'), 'Archived'); // even retro-shipped
});

test('deriveEpicStatus: non-archived epics keep the prose/retro derivation', () => {
  assert.equal(deriveEpicStatus([{ status: 'Shipped' }, { status: 'Shipped' }], false, 'in-progress'), 'Shipped');
  assert.equal(deriveEpicStatus([{ status: 'In progress' }], false, undefined), 'In progress');
  assert.equal(deriveEpicStatus([{ status: 'Planned' }], false, 'scaffolded'), 'Scaffolded');
  assert.equal(deriveEpicStatus([], true, undefined), 'Shipped'); // retroShipped wins
});

// --- S1.2: build_order normalization + projection ------------------------------------------------
test('normalizeBuildOrder: numeric → Number, blank/absent → null, legacy non-numeric → passthrough', () => {
  assert.equal(normalizeBuildOrder('1'), 1);
  assert.equal(normalizeBuildOrder(2), 2);
  assert.equal(normalizeBuildOrder(''), null);
  assert.equal(normalizeBuildOrder(null), null);
  assert.equal(normalizeBuildOrder(undefined), null);
  assert.equal(normalizeBuildOrder('#3c'), '#3c'); // legacy seed build_order survives for seed rows
});

test('frontmatterStatusBucket: canonical values map to their buckets; absent → null (fallback allowed)', () => {
  assert.equal(frontmatterStatusBucket({ status: 'shipped' }), 'Shipped');
  assert.equal(frontmatterStatusBucket({ status: 'in-progress' }), 'In progress');
  assert.equal(frontmatterStatusBucket({ status: 'scaffolded' }), 'Scaffolded');
  assert.equal(frontmatterStatusBucket({ status: 'queued' }), 'Scaffolded');
  assert.equal(frontmatterStatusBucket({ status: 'archived' }), 'Archived');
  assert.equal(frontmatterStatusBucket({}), null);                 // no frontmatter status at all
  assert.equal(frontmatterStatusBucket({ status: null }), null);   // parsed-empty value
});

test('frontmatterStatusBucket: a present-but-unrecognized value THROWS naming the doc and the value', () => {
  // 'ready', 'Done', 'complete' are the exact invalid spellings the 2026-07-06 audit found in the wild;
  // the enum is case-sensitive by design ('Shipped' is not 'shipped').
  for (const bad of ['ready', 'Done', 'complete', 'Shipped']) {
    assert.throws(
      () => frontmatterStatusBucket({ status: bad }, 'Roadmap/03-selling-and-shops/x/README.md'),
      new RegExp(`Roadmap/03-selling-and-shops/x/README\\.md.*unrecognized epic frontmatter status "${bad}"`),
    );
  }
});

test('seedStatusLabel: the 7 documented seed values map; absent → Raw; invalid THROWS with the file name', () => {
  assert.equal(seedStatusLabel('raw'), 'Raw');
  assert.equal(seedStatusLabel('ready'), 'Ready');       // 'ready' IS valid for seeds (unlike epics)
  assert.equal(seedStatusLabel('queued'), 'Queued');
  assert.equal(seedStatusLabel('scaffolded'), 'Scaffolded');
  assert.equal(seedStatusLabel('in-progress'), 'In progress');
  assert.equal(seedStatusLabel('shipped'), 'Shipped');
  assert.equal(seedStatusLabel('archived'), 'Archived');
  assert.equal(seedStatusLabel(null), 'Raw');
  assert.equal(seedStatusLabel(undefined), 'Raw');
  // 'seed' is the invalid value the audit found live (spike-envia-byo).
  assert.throws(() => seedStatusLabel('seed', 'Roadmap/00-ideas/seeds/x.md'),
    /seeds\/x\.md.*unrecognized seed frontmatter status "seed"/);
});

test('floorSprintDone: a Shipped sprint counts ALL its stories done; other statuses keep raw ticks', () => {
  assert.equal(floorSprintDone('Shipped', 5, 0), 5);   // Status-line-only completion (e.g. ml-sync sprints)
  assert.equal(floorSprintDone('Shipped', 5, 3), 5);
  assert.equal(floorSprintDone('Shipped', 0, 0), 0);   // no detectable stories → nothing to floor
  assert.equal(floorSprintDone('In review', 4, 0), 0); // built-not-merged stays honest
  assert.equal(floorSprintDone('In progress', 4, 2), 2);
  assert.equal(floorSprintDone('Planned', 4, 0), 0);
  assert.equal(floorSprintDone('Archived', 4, 1), 1);  // archived stories were dropped, not done
});

test('firstParagraph: a template comment is never the goal, and a listed Problem reads as text (#398 verifier)', async () => {
  const { firstParagraph, EPIC_GOAL_HEADINGS, SEED_GOAL_HEADINGS } = await import('./roadmap-extract.mjs');
  const scaffolded = '## Why\n<!-- One paragraph: the outcome this epic delivers and for whom. -->\n\n## Scope\nx\n';
  assert.equal(firstParagraph(scaffolded, EPIC_GOAL_HEADINGS), null);
  assert.equal(firstParagraph('## Why\n<!-- a\nmulti-line note -->\nThe real why.\n', EPIC_GOAL_HEADINGS), 'The real why.');
  assert.equal(firstParagraph('## Problem\n- Lint.\n- Symlinks.\n', SEED_GOAL_HEADINGS), 'Lint. Symlinks.');
  // The heading order is the reading: an epic's Why wins, a seed's Problem wins (pinned: #398 verifier).
  const both = '## Problem\nThe problem.\n\n## Why\nThe why.\n';
  assert.equal(firstParagraph(both, EPIC_GOAL_HEADINGS), 'The why.');
  assert.equal(firstParagraph(both, SEED_GOAL_HEADINGS), 'The problem.');
  assert.deepEqual(SEED_GOAL_HEADINGS, ['Problem', 'Why', 'Outcome & signal', 'The ask, as given']);
});
