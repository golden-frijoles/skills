// fund.test.mjs — fund-at-approval S1.1/S1.2: the bet lands in the cycle file, the seed is funded, and only the queue
// renumbers. Each test builds a throwaway Roadmap/ and runs the real CLI against it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readField, setField } from './roadmap-fm.mjs';

const FUND = join(dirname(fileURLToPath(import.meta.url)), 'fund.mjs');

const seed = (slug, fm) =>
  `---\ntitle: "${fm.title ?? slug}"\nslug: ${slug}\nstatus: ${fm.status}\nappetite: ${fm.appetite ?? 'S'}\nunderwritten_by: ${fm.uw ?? 'null'}\nepic: ${fm.epic ? `"${fm.epic}"` : 'null'}\nbuild_order: ${fm.n ?? 'null'}\n---\n\n# ${slug}\n`;
const epic = (slug, status, n) =>
  `---\nstatus: ${status}   # SSOT\nslug: ${slug}\ntitle: "${slug}"\nbuild_order: ${n}    # integer position\n---\n\n# Epic\n`;

/** A repo whose queue is 60 a · 61 b · 63 c, with a SHIPPED #62 inside it and a ready seed holding a legacy #14. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fund-'));
  const seeds = join(root, 'Roadmap', '00-ideas', 'seeds');
  mkdirSync(seeds, { recursive: true });
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put('Roadmap/09-x/a/README.md', epic('a', 'scaffolded', 60));
  put('Roadmap/00-ideas/seeds/a.md', seed('a', { status: 'scaffolded', epic: '09-x/a', n: 60, uw: 'wave-old' }));
  put('Roadmap/09-x/b/README.md', epic('b', 'in-progress', 61));
  put('Roadmap/09-x/old/README.md', epic('old', 'shipped', 62));
  put('Roadmap/09-x/c/README.md', epic('c', 'scaffolded', 63));
  put('Roadmap/00-ideas/seeds/legacy.md', seed('legacy', { status: 'ready', n: 14 }));
  put('Roadmap/00-ideas/seeds/new.md', seed('new', { status: 'ready', title: 'New: a | piped title' }));
  return root;
}

const run = (root, args) => spawnSync('node', [FUND, '--repo-root', root, '--date', '2026-10-04', ...args], { encoding: 'utf8' });
const fm = (root, rel, key) => readField(readFileSync(join(root, rel), 'utf8'), key);
const order = (root) => ({
  a: fm(root, 'Roadmap/09-x/a/README.md', 'build_order'),
  b: fm(root, 'Roadmap/09-x/b/README.md', 'build_order'),
  old: fm(root, 'Roadmap/09-x/old/README.md', 'build_order'),
  c: fm(root, 'Roadmap/09-x/c/README.md', 'build_order'),
  new: fm(root, 'Roadmap/00-ideas/seeds/new.md', 'build_order'),
  legacy: fm(root, 'Roadmap/00-ideas/seeds/legacy.md', 'build_order'),
});

test('--next puts the bet at the front and renumbers only the queue, skipping a shipped number', () => {
  const root = fixture();
  try {
    const r = run(root, ['--slug', 'new', '--displaced', 'c waits', '--next']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(order(root), { new: '60', a: '61', b: '63', old: '62', c: '64', legacy: '14' });
    // The epic's seed copy follows its README, so nobody reads a stale fallback.
    assert.equal(fm(root, 'Roadmap/00-ideas/seeds/a.md', 'build_order'), '61');
    // The README's trailing comment survives the edit.
    assert.match(readFileSync(join(root, 'Roadmap/09-x/a/README.md'), 'utf8'), /^build_order: 61 +# integer position$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--after places behind a queued bet; a shipped or unknown slug is refused', () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--slug', 'new', '--displaced', 'x', '--after', 'b']).status, 0);
    assert.deepEqual(order(root), { a: '60', b: '61', new: '63', old: '62', c: '64', legacy: '14' });
    const shipped = run(root, ['--slug', 'legacy', '--displaced', 'x', '--after', 'old']);
    assert.equal(shipped.status, 1);
    assert.match(shipped.stderr, /"old" is not in the queue \(status shipped\)/);
    assert.match(run(root, ['--slug', 'legacy', '--displaced', 'x', '--after', 'nope']).stderr, /no seed or epic "nope"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a ready seed's legacy number never drags the queue into the shipped history's gaps", () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--slug', 'legacy', '--displaced', 'x', '--next']).status, 0);
    assert.deepEqual(order(root), { legacy: '60', a: '61', b: '63', old: '62', c: '64', new: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the seed is funded and queued; the month opens its cycle file on first use, then appends', () => {
  const root = fixture();
  try {
    const cycle = join(root, 'Roadmap/bets/wave-2026-10.md');
    assert.equal(existsSync(cycle), false);
    assert.equal(run(root, ['--slug', 'new', '--displaced', 'c waits', '--next']).status, 0);
    assert.equal(fm(root, 'Roadmap/00-ideas/seeds/new.md', 'underwritten_by'), 'wave-2026-10');
    assert.equal(fm(root, 'Roadmap/00-ideas/seeds/new.md', 'status'), 'queued');
    let text = readFileSync(cycle, 'utf8');
    assert.match(text, /^# Cycle 2026-10 — bets funded at approval$/m);
    assert.match(text, /^\| Bet \| Appetite \| Displaced \(the opportunity cost\) \|$/m);
    assert.match(text, /^\| \*\*new\*\*: New: a \\\| piped title \| \*\*S\*\* \| c waits \|$/m);
    assert.equal(run(root, ['--slug', 'legacy', '--displaced', 'more', '--after', 'c']).status, 0);
    text = readFileSync(cycle, 'utf8');
    assert.equal(text.match(/^# Cycle/gm).length, 1);
    assert.match(text, /\| c waits \|\n\| \*\*legacy\*\*/);
    // Run twice, the row is not added twice.
    assert.equal(run(root, ['--slug', 'new', '--displaced', 'again']).status, 0);
    assert.equal(readFileSync(cycle, 'utf8').match(/\| \*\*new\*\*/g).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a re-bet keeps the position and moves underwritten_by to the new month', () => {
  const root = fixture();
  try {
    const r = spawnSync('node', [FUND, '--repo-root', root, '--date', '2026-11-02', '--slug', 'a', '--displaced', 'wave 2 of a'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /#60, kept \(a re-bet\)/);
    assert.equal(fm(root, 'Roadmap/00-ideas/seeds/a.md', 'underwritten_by'), 'wave-2026-11');
    assert.equal(fm(root, 'Roadmap/00-ideas/seeds/a.md', 'status'), 'scaffolded');
    assert.deepEqual(order(root), { a: '60', b: '61', old: '62', c: '63', new: null, legacy: '14' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refusals: no placement for an unplaced bet, no displaced, a shipped slug, --dry-run writes nothing', () => {
  const root = fixture();
  try {
    assert.match(run(root, ['--slug', 'new', '--displaced', 'x']).stderr, /no build position yet — pass --next or --after/);
    assert.match(run(root, ['--slug', 'new', '--next']).stderr, /missing --displaced/);
    assert.match(run(root, ['--slug', 'old', '--displaced', 'x']).stderr, /is shipped/);
    const before = order(root);
    assert.equal(run(root, ['--slug', 'new', '--displaced', 'x', '--next', '--dry-run']).status, 0);
    assert.deepEqual(order(root), before);
    assert.equal(existsSync(join(root, 'Roadmap/bets/wave-2026-10.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setField replaces in place, keeps a comment, quotes nothing it was not given, and adds an absent key', () => {
  const t = '---\nstatus: ready   # the enum\ntitle: "A: b # c"\n---\nbody\n';
  assert.equal(readField(t, 'title'), 'A: b # c');
  const out = setField(setField(t, 'status', 'queued'), 'underwritten_by', 'wave-2026-10');
  assert.equal(out, '---\nstatus: queued  # the enum\ntitle: "A: b # c"\nunderwritten_by: wave-2026-10\n---\nbody\n');
});
