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
    assert.match(run(root, ['--slug', 'new', '--displaced', 'x']).stderr, /not in the queue yet — pass --next or --after/);
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

test('review #271: a $-pattern in frontmatter survives an edit; a lowercase seed appetite is read; a path slug is refused', () => {
  const t = '---\ntitle: "Costs $& and $\' and $` stay"\nstatus: ready\n---\n';
  assert.equal(readField(setField(t, 'status', 'queued'), 'title'), "Costs $& and $' and $` stay");
  const root = fixture();
  try {
    writeFileSync(join(root, 'Roadmap/00-ideas/seeds/new.md'), seed('new', { status: 'ready', appetite: 's' }));
    assert.equal(run(root, ['--slug', 'new', '--displaced', 'x', '--next']).status, 0);
    assert.equal(fm(root, 'Roadmap/00-ideas/seeds/new.md', 'appetite'), 'S');
    assert.match(run(root, ['--slug', '../../etc/x', '--displaced', 'x', '--next']).stderr, /a slug is kebab-case/);
    assert.match(run(root, ['--slug', 'new', '--displaced', 'x', '--after', '../a']).stderr, /a slug is kebab-case/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review #271: a legacy number is not a position, a reorder keeps the funding record, a raw seed is refused', () => {
  const root = fixture();
  try {
    // `legacy` is ready with a leftover #14: no placement means no position, never a "re-bet" at #14.
    assert.match(run(root, ['--slug', 'legacy', '--displaced', 'x']).stderr, /not in the queue yet/);
    assert.equal(fm(root, 'Roadmap/00-ideas/seeds/legacy.md', 'status'), 'ready');
    // `c` is queued: a placement only reorders — no cycle row, underwritten_by untouched, no --displaced needed.
    const r = run(root, ['--slug', 'a', '--after', 'c']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Reordered a \(funding record unchanged\)/);
    assert.deepEqual(order(root), { b: '60', c: '61', a: '63', old: '62', new: null, legacy: '14' });
    assert.equal(fm(root, 'Roadmap/00-ideas/seeds/a.md', 'underwritten_by'), 'wave-old');
    assert.equal(existsSync(join(root, 'Roadmap/bets/wave-2026-10.md')), false);
    writeFileSync(join(root, 'Roadmap/00-ideas/seeds/rough.md'), seed('rough', { status: 'raw' }));
    assert.match(run(root, ['--slug', 'rough', '--displaced', 'x', '--next']).stderr, /is raw — groom it/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review #271 round 2: an epic scaffolded before funding is FUNDED by --next, or in place when it already has a number', () => {
  const root = fixture();
  try {
    // A seedless scaffolded epic with no number and no funding: --next funds it, it does not "reorder" it.
    mkdirSync(join(root, 'Roadmap/09-x/bare'), { recursive: true });
    writeFileSync(join(root, 'Roadmap/09-x/bare/README.md'), epic('bare', 'scaffolded', 'null').replace('build_order: null', 'appetite: M\nbuild_order: null'));
    let r = run(root, ['--slug', 'bare', '--displaced', 'x', '--next']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Funded bare in wave-2026-10/m);
    assert.equal(fm(root, 'Roadmap/09-x/bare/README.md', 'underwritten_by'), 'wave-2026-10');
    assert.equal(fm(root, 'Roadmap/09-x/bare/README.md', 'build_order'), '60');
    // `b` is live and numbered but unfunded (no seed): no placement funds it where it stands.
    r = run(root, ['--slug', 'b', '--appetite', 'S', '--displaced', 'y']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Funded b in wave-2026-10/m);
    assert.equal(fm(root, 'Roadmap/09-x/b/README.md', 'underwritten_by'), 'wave-2026-10');
    assert.match(readFileSync(join(root, 'Roadmap/bets/wave-2026-10.md'), 'utf8'), /\| \*\*b\*\*/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
