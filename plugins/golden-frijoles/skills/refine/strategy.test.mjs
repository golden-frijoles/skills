// strategy.test.mjs — refine's reader for Roadmap/00-strategy/ (think-skills D5).
//
// The fixtures ARE the three coaches' templates (`../<coach>/templates/<coach>.md`), filled the way a coach fills
// them. So a heading renamed in a template turns this red here, instead of refine silently reading nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatStrategy, readStrategy } from './strategy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const template = (coach) => readFileSync(join(HERE, '..', coach, 'templates', `${coach}.md`), 'utf8');

/** A project root with the given strategy files written into Roadmap/00-strategy/. */
function project(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'refine-strategy-'));
  if (files === null) return root; // no Roadmap/00-strategy at all
  mkdirSync(join(root, 'Roadmap', '00-strategy'), { recursive: true });
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(root, 'Roadmap', '00-strategy', name), text);
  return root;
}

const filledNorthStar = () =>
  template('north-star')
    .replace('status: draft', 'status: agreed')
    .replace('updated: YYYY-MM-DD', 'updated: 2026-09-30')
    .replace('"<metric_key>"', '"weekly_planned_seeds"')
    .replace('"name": "<Pithy name>"', '"name": "Weekly planned seeds"')
    .replace('"<input_key>", "name": "<Input name>"', '"activated_projects", "name": "Activated projects"')
    .replace('"<other_input_key>", "name": "<Input name>"', '"seeds_groomed", "name": "Seeds refined"');

const filledRisk = () =>
  template('risk-validation')
    .replace(
      '**Dimension:** <one of the six, named exactly as in the tables above>',
      '**Dimension:** Business model'
    )
    .replace(/\*\*Hypothesis:\*\* <[^>]+>/, '**Hypothesis:** Teams pay per seat for planning')
    .replace('| Business model | High · Low | |', '| Business model | Low | no pre-sales yet |')
    .replace('| Growth strategy | High · Low | |', '| Growth strategy | Low | |');

function run(root) {
  return spawnSync(process.execPath, [join(HERE, 'strategy.mjs'), '--root', root], { encoding: 'utf8' });
}

test('no Roadmap/00-strategy/: prints nothing and exits 0, so refine says nothing about strategy', () => {
  for (const root of [project(null), project({})]) {
    const result = run(root);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(formatStrategy(readStrategy(root)), '');
  }
});

test('all three files: the inputs a seed can move, the highest domino, and the pitch line', () => {
  const root = project({
    'north-star.md': filledNorthStar(),
    'risk-validation.md': filledRisk(),
    'pmf-narrative.md': template('pmf-narrative'),
  });
  const { files } = readStrategy(root);
  assert.deepEqual(
    files.map((f) => f.kind),
    ['pmf-narrative', 'north-star', 'risk-validation']
  );
  const ns = files.find((f) => f.kind === 'north-star');
  assert.equal(ns.status, 'agreed');
  assert.equal(ns.updated, '2026-09-30');
  assert.deepEqual(ns.metric, { key: 'weekly_planned_seeds', name: 'Weekly planned seeds' });
  assert.deepEqual(
    ns.inputs.map((i) => i.key),
    ['activated_projects', 'seeds_groomed']
  );
  const rv = files.find((f) => f.kind === 'risk-validation');
  assert.deepEqual(rv.domino, { dimension: 'Business model', hypothesis: 'Teams pay per seat for planning' });
  assert.deepEqual(rv.lowConviction, ['Growth strategy', 'Business model']);
  assert.equal(files.find((f) => f.kind === 'pmf-narrative').dimensions.length, 6);

  const out = run(root);
  assert.equal(out.status, 0);
  assert.match(
    out.stdout,
    /inputs a seed can move: activated_projects \("Activated projects"\) · seeds_groomed/
  );
  assert.match(out.stdout, /highest domino: Business model — "Teams pay per seat for planning"/);
  assert.match(out.stdout, /^Pitch line: Moves: <input key> · Tests: <dimension>/m);
  // result-record D4 — the target question offers the inputs by key.
  assert.match(out.stdout, /^Target \(Stage 1\.5\): target_metric one of activated_projects · seeds_groomed \(or free text: not grounded\)/m);
});

test('an input counted by an event carries it, so the Plan gate can say what measures it (gates-in-plain-agile D4)', () => {
  const root = project({
    'north-star.md': filledNorthStar().replace('"<event_the_product_sends>"', '"seed_groomed"'),
  });
  const ns = readStrategy(root).files.find((f) => f.kind === 'north-star');
  assert.deepEqual(
    ns.inputs.map((i) => [i.key, i.event]),
    [
      ['activated_projects', null], // external_push: nothing the product sends measures it
      ['seeds_groomed', 'seed_groomed'],
    ]
  );
  assert.match(
    run(root).stdout,
    /inputs a seed can move: activated_projects \("Activated projects"\) · seeds_groomed \("Seeds refined", event seed_groomed\)/
  );
  // The template's placeholder event is not an event: the gate must never show `<event_the_product_sends>`.
  const placeholder = readStrategy(project({ 'north-star.md': filledNorthStar() })).files[0];
  assert.deepEqual(placeholder.inputs.map((i) => i.event), [null, null]);
});

test('only one file: the others are simply absent, and an unchosen domino says so', () => {
  const root = project({ 'risk-validation.md': template('risk-validation') });
  const { files } = readStrategy(root);
  assert.deepEqual(
    files.map((f) => f.kind),
    ['risk-validation']
  );
  assert.equal(files[0].domino, null);
  assert.match(formatStrategy({ files }), /^Target \(Stage 1\.5\): target_metric free text \(not grounded: no North Star inputs\)/m);
  assert.deepEqual(files[0].lowConviction, []);
  assert.match(formatStrategy({ files }), /highest domino: not chosen yet/);
});

test('a malformed sync block is named with its reason, and the rest is still read', () => {
  const broken = filledNorthStar().replace('"metric": {', '"metric": {,');
  const twoBlocks = `${filledNorthStar()}\n\`\`\`json\n{}\n\`\`\`\n`;
  for (const text of [broken, twoBlocks]) {
    const root = project({ 'north-star.md': text, 'risk-validation.md': filledRisk() });
    const result = run(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /north-star\.md \(agreed, 2026-09-30\) — could not read: /);
    assert.match(result.stdout, /highest domino: Business model/);
  }
});

test('a heading renamed away from the template contract is not read silently as present', () => {
  const root = project({ 'north-star.md': filledNorthStar().replace('## Sync payload', '## Payload') });
  assert.match(formatStrategy(readStrategy(root)), /could not read: no "## Sync payload" section/);
});

test('an unreadable strategy file is reported, and the others are still read', () => {
  const root = project({ 'risk-validation.md': filledRisk() });
  mkdirSync(join(root, 'Roadmap', '00-strategy', 'north-star.md')); // a directory where a file should be: EISDIR
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /north-star\.md — could not read: /);
  assert.match(result.stdout, /highest domino: Business model/);
});

test('an unfilled north-star template yields no inputs a pitch could claim to move', () => {
  const root = project({ 'north-star.md': template('north-star') });
  const [ns] = readStrategy(root).files;
  assert.equal(ns.metric, null);
  assert.deepEqual(ns.inputs, []);
  const out = formatStrategy({ files: [ns] });
  assert.match(out, /North Star: not filled in yet/);
  assert.match(out, /inputs a seed can move: none/);
  assert.doesNotMatch(out, /<input_key>|<metric_key>/);
});
