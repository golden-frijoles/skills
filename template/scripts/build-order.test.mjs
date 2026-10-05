// build-order.test.mjs — BUILD-ORDER.md speaks the six stages (board-sinks-and-scrumban S1.5; lock C3).
//
// Runs the REAL generator in a temp repo (it resolves the project from its own location). Asserts the six sections
// in order, Ready to build in build order, the committed file docs-only (Building/QA say where they live), `--live`
// printing those columns without writing, and every rendered link resolving on disk (seed board-link-depth).
// Run: node --test scripts/build-order.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Every live epic is funded (fund-at-approval D8): `underwritten_by` names a cycle file the fixture writes.
function epic(root, macro, slug, status, order, underwrittenBy = 'wave-test') {
  const dir = join(root, 'Roadmap', macro, slug);
  mkdirSync(dir, { recursive: true });
  const funded = underwrittenBy ? `underwritten_by: ${underwrittenBy}\n` : '';
  writeFileSync(
    join(dir, 'README.md'),
    `---\nstatus: ${status}\nslug: ${slug}\ntitle: "${slug}"\narea: ${macro}\nrisk: low\ntype: feature\nbuild_order: ${order}\n${funded}---\n\n# Epic: ${slug}\n\n## Why\nBecause.\n`
  );
  writeFileSync(
    join(dir, 'sprint-1.md'),
    `# ${slug} — Sprint 1: One\n\n**Status:** ⬜ not started\n\n### Story 1.1 — A\n`
  );
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'build-order-')));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  for (const f of ['build-order.mjs', 'roadmap-extract.mjs'])
    writeFileSync(join(root, 'scripts', f), readFileSync(join(HERE, f)));
  // The extractor's whole import closure — every lib module, and the push it imports. A hand-kept list of libs broke
  // this fixture twice as the extractor grew (board-sinks-and-scrumban S1, S3), so the closure is copied, not listed.
  for (const name of readdirSync(join(HERE, 'lib')).filter(
    (n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs')
  ))
    writeFileSync(join(root, 'scripts', 'lib', name), readFileSync(join(HERE, 'lib', name)));
  writeFileSync(join(root, 'scripts', 'roadmap-push.mjs'), readFileSync(join(HERE, 'roadmap-push.mjs')));
  mkdirSync(join(root, 'Roadmap', 'bets'), { recursive: true });
  writeFileSync(join(root, 'Roadmap', 'bets', 'wave-test.md'), '# Cycle test\n');
  epic(root, '02-commercial', 'late-epic', 'scaffolded', 40);
  epic(root, '02-commercial', 'early-epic', 'scaffolded', 18);
  epic(root, '09-platform-infra', 'done-epic', 'shipped', 3);
  epic(root, '02-commercial', 'live-epic', 'scaffolded', 25);
  const seeds = join(root, 'Roadmap', '00-ideas', 'seeds');
  mkdirSync(seeds, { recursive: true });
  writeFileSync(
    join(seeds, 'idea.md'),
    '---\ntitle: "An idea"\nslug: idea\nstatus: raw\narea: "02"\ntype: feature\nepic: null\n---\n# Idea\n'
  );
  writeFileSync(
    join(seeds, 'pitch.md'),
    '---\ntitle: "A pitch"\nslug: pitch\nstatus: ready\narea: "02"\ntype: spike\nepic: null\n---\n# Pitch\n'
  );
  // A snapshot that puts live-epic in Building — the committed file must NOT show it there.
  mkdirSync(join(root, '.golden-frijoles'));
  writeFileSync(
    join(root, '.golden-frijoles', 'board.json'),
    JSON.stringify({ generated_at: '2026-10-01T00:00:00Z', branches: ['feat/live-epic'], prs: [] })
  );
  return root;
}

const run = (root, ...args) =>
  spawnSync(process.execPath, [join(root, 'scripts', 'build-order.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
const OUT = (root) => join(root, 'Roadmap', '00-ideas', 'BUILD-ORDER.md');
const headings = (md) =>
  md
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => l.slice(3));

test('the committed file has the six stages in order, Building and QA as "live only"', () => {
  const root = fixture();
  assert.equal(run(root).status, 0);
  const md = readFileSync(OUT(root), 'utf8');
  assert.deepEqual(headings(md), [
    'To groom (1)',
    'Grooming (1)',
    'Ready to build (3)',
    'Building — live only',
    'QA — live only',
    'Shipped (1)',
  ]);
  assert.doesNotMatch(md, /feat\/live-epic/, 'no git fact reaches the committed file, snapshot or not');
});

test('Ready to build runs in build order', () => {
  const root = fixture();
  run(root);
  const md = readFileSync(OUT(root), 'utf8');
  const ready = md.slice(md.indexOf('## Ready to build'), md.indexOf('## Building'));
  const order = [...ready.matchAll(/^- \[([a-z-]+)\]/gm)].map((m) => m[1]);
  assert.deepEqual(order, ['early-epic', 'live-epic', 'late-epic']);
});

test('every link on the board resolves to a file (seed board-link-depth)', () => {
  const root = fixture();
  run(root);
  const md = readFileSync(OUT(root), 'utf8');
  const links = [...md.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 6);
  for (const link of links)
    assert.ok(existsSync(resolve(dirname(OUT(root)), link)), `${link} does not resolve`);
});

test('--live prints the Building column from the facts and writes nothing', () => {
  const root = fixture();
  run(root);
  const before = readFileSync(OUT(root), 'utf8');
  const live = run(root, '--live');
  assert.equal(live.status, 0);
  assert.match(live.stdout, /## Building \(1\)[\s\S]*\[live-epic\][^\n]*git: feat\/live-epic/);
  assert.match(live.stdout, /## QA \(0\)/);
  assert.equal(readFileSync(OUT(root), 'utf8'), before, '--live never writes the committed file');
});

test('--check passes on a fresh file and fails on a stale one', () => {
  const root = fixture();
  run(root);
  assert.equal(run(root, '--check').status, 0);
  writeFileSync(OUT(root), readFileSync(OUT(root), 'utf8').replace('## Grooming', '## Groomed'));
  assert.equal(run(root, '--check').status, 1);
});

test('a live bet with no funding record fails the board; a shipped one does not need one (fund-at-approval D8)', () => {
  const root = fixture();
  try {
    epic(root, '09-platform-infra', 'old-shipped', 'shipped', 2, null);
    assert.equal(run(root).status, 0, 'a shipped epic with no underwriter is history, not a live bet');
    epic(root, '02-commercial', 'unpaid', 'in-progress', 41, null);
    let r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Live bets with no funding record/);
    assert.match(r.stderr, /Roadmap\/02-commercial\/unpaid\/README\.md$/m);
    epic(root, '02-commercial', 'unpaid', 'in-progress', 41, 'wave-nowhere');
    r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unpaid\/README\.md — no Roadmap\/bets\/wave-nowhere\.md/);
    epic(root, '02-commercial', 'unpaid', 'in-progress', 41, '"../bets/wave-test"');
    assert.equal(run(root).status, 1, 'a cycle name that is not kebab-case names no cycle, even when the path exists');
    epic(root, '02-commercial', 'unpaid', 'in-progress', 41, '"Roadmap/bets/wave-test.md"');
    assert.equal(run(root).status, 0, 'the legacy path form names the same cycle file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
