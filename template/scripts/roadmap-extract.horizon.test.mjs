// roadmap-extract.horizon.test.mjs — a product's horizon travels with its roadmap (many-products S3.1, D14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRows } from './roadmap-extract.mjs';
import { buildEnvelope, envelopeFor } from './roadmap-push.mjs';
import { destinationIds, parseHorizonMd, readHorizon, unknownDestinations } from './lib/horizon.mjs';

const HORIZON = [
  '# Horizon',
  '',
  'Preamble that is ignored.',
  '',
  '## front-door — The front door',
  'Where a new user lands.',
  '',
  'A second paragraph is not the description.',
  '',
  '## the-loop — The loop',
  'Signals close themselves.',
  '',
].join('\n');

test('parseHorizonMd: id, title, one-line description, in file order', () => {
  assert.deepEqual(parseHorizonMd(HORIZON), [
    { id: 'front-door', title: 'The front door', description: 'Where a new user lands.' },
    { id: 'the-loop', title: 'The loop', description: 'Signals close themselves.' },
  ]);
});

test('parseHorizonMd: a title may itself hold a dash, and an en dash or hyphen separates too', () => {
  const [a, b] = parseHorizonMd('## a-b — Pods & proof — ROI\nx\n## c – Plain\ny\n');
  assert.equal(a.title, 'Pods & proof — ROI');
  assert.equal(b.id, 'c');
});

test('parseHorizonMd: names the line of a bad heading, a bad id, a repeat and a missing description', () => {
  assert.throws(() => parseHorizonMd('## just a title\nx'), /horizon\.md:1: a destination heading is/);
  assert.throws(() => parseHorizonMd('## Bad_Id — T\nx'), /lowercase-kebab/);
  assert.throws(
    () => parseHorizonMd('## a — T\nx\n## a — U\ny'),
    /horizon\.md:3: destination "a" is declared twice/
  );
  assert.throws(() => parseHorizonMd('## a — T\n\n## b — U\nz'), /"a" has no one-line description/);
});

test('parseHorizonMd: more than 50 destinations is refused', () => {
  const md = Array.from({ length: 51 }, (_, i) => `## d${i}x — T\ndesc`)
    .join('\n')
    .replace(/\d/g, (c) => 'abcdefghij'[c]);
  assert.throws(() => parseHorizonMd(md), /at most 50/);
});

test('destinationIds: one id or a comma list, trimmed, deduped; anything else is none', () => {
  assert.deepEqual(destinationIds('front-door'), ['front-door']);
  assert.deepEqual(destinationIds('front-door, the-loop ,front-door,'), ['front-door', 'the-loop']);
  for (const none of [null, undefined, '', '  ', 7]) assert.deepEqual(destinationIds(none), []);
});

test('unknownDestinations: ids the horizon lacks; with no horizon every id is unknown', () => {
  const h = parseHorizonMd(HORIZON);
  assert.deepEqual(unknownDestinations(['front-door', 'nope'], h), ['nope']);
  assert.deepEqual(unknownDestinations(['front-door'], null), ['front-door']);
  assert.deepEqual(unknownDestinations([], null), []);
});

test('buildEnvelope: horizon is additive — present when declared, absent (not null) when not', () => {
  const h = parseHorizonMd(HORIZON);
  assert.deepEqual(buildEnvelope([{ slug: 'a' }], { horizon: h }).horizon, h);
  assert.equal('horizon' in buildEnvelope([{ slug: 'a' }], {}), false);
  assert.equal('horizon' in buildEnvelope([{ slug: 'a' }], { horizon: [] }), false);
});

function fixture(horizonMd, destination) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'extract-horizon-')));
  const dir = join(root, 'Roadmap', '09-platform-infra', 'reminders');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, 'Roadmap', '00-ideas', 'seeds'), { recursive: true });
  if (horizonMd !== null) {
    mkdirSync(join(root, 'Roadmap'), { recursive: true });
    writeFileSync(join(root, 'Roadmap', 'horizon.md'), horizonMd);
  }
  writeFileSync(
    join(dir, 'README.md'),
    [
      '---',
      'status: scaffolded',
      'slug: reminders',
      'title: reminders',
      'area: 09-platform-infra',
      'risk: low',
      'type: feature',
      'phase: Shaping',
      'sprints_total: 0',
      'stories_total: 0',
      ...(destination === undefined ? [] : [`destination: ${destination}`]),
      '---',
      '# Epic: reminders',
      '',
    ].join('\n')
  );
  return root;
}
const facts = { mode: 'docs', prs: [], branches: [] };
const epicRow = (root) =>
  buildRows({ root, dates: false, facts }).find((r) => r.slug === 'reminders' && r.grain === 'Epic');

test('buildRows: an epic row carries destinations from `destination:` (one id or a list); none → no key', () => {
  let root = fixture(HORIZON, 'front-door, the-loop');
  try {
    assert.deepEqual(epicRow(root).destinations, ['front-door', 'the-loop']);
    assert.deepEqual(
      readHorizon(root).map((d) => d.id),
      ['front-door', 'the-loop']
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  root = fixture(HORIZON, 'front-door');
  try {
    assert.deepEqual(epicRow(root).destinations, ['front-door']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  root = fixture(HORIZON);
  try {
    assert.equal('destinations' in epicRow(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildRows: an unknown destination FAILS, naming the epic and the declared ids', () => {
  const root = fixture(HORIZON, 'front-door, ghost');
  try {
    assert.throws(
      () => buildRows({ root, dates: false, facts }),
      /epic "reminders" names destination "ghost".*horizon\.md does not declare.*front-door, the-loop/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildRows: a destination with NO horizon.md fails too; no horizon and no destination is fine', () => {
  let root = fixture(null, 'front-door');
  try {
    assert.throws(() => buildRows({ root, dates: false, facts }), /epic "reminders".*no horizon file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  root = fixture(null);
  try {
    assert.equal(readHorizon(root), null);
    assert.equal('horizon' in envelopeFor([{ slug: 'a' }], root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('envelopeFor: reads the horizon from the project root', () => {
  const root = fixture(HORIZON, 'front-door');
  try {
    assert.deepEqual(
      envelopeFor([{ slug: 'a' }], root).horizon.map((d) => d.id),
      ['front-door', 'the-loop']
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
