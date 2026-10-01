// stage-facts.test.mjs — D14: one ls-remote and one gh call per live run, the snapshot fallback, and its age.
// Run: node --test scripts/lib/stage-facts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SNAPSHOT_PATH, gatherFacts, normalizePrs, parseLsRemote } from './stage-facts.mjs';

const LS = 'abc\trefs/heads/main\ndef\trefs/heads/feat/x-s2\n0123\trefs/tags/v1\n';
const GH = JSON.stringify([{ number: 7, headRefName: 'feat/x-s2', state: 'OPEN', isDraft: true, url: 'u7' }]);

/** A fake spawnSync that records every call and answers git/gh from a script. */
function stub({ git = { status: 0, stdout: LS }, gh = { status: 0, stdout: GH } } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    return cmd === 'git' ? { stderr: '', ...git } : { stderr: '', ...gh };
  };
  return { run, calls };
}
const root = () => mkdtempSync(join(tmpdir(), 'stage-facts-'));
const NOW = () => new Date('2026-10-01T12:00:00.000Z');

test('parseLsRemote keeps branch heads only', () => {
  assert.deepEqual(parseLsRemote(LS), ['main', 'feat/x-s2']);
});

test('normalizePrs maps gh fields onto the resolver shape', () => {
  assert.deepEqual(normalizePrs(JSON.parse(GH)), [
    { number: 7, head: 'feat/x-s2', state: 'OPEN', draft: true, url: 'u7' },
  ]);
  assert.throws(() => normalizePrs({}), /array/);
});

test('live: exactly ONE git ls-remote and ONE gh pr list, and the snapshot is written', () => {
  const dir = root();
  const { run, calls } = stub();
  const facts = gatherFacts({ root: dir, mode: 'live', run, now: NOW });
  assert.deepEqual(calls, [
    'git ls-remote --heads origin',
    'gh pr list --state all --limit 1000 --json number,headRefName,state,isDraft,url',
  ]);
  assert.equal(facts.mode, 'live');
  assert.equal(facts.origin, null, 'live facts carry no snapshot suffix');
  assert.deepEqual(facts.branches, ['main', 'feat/x-s2']);
  const snap = JSON.parse(readFileSync(join(dir, SNAPSHOT_PATH), 'utf8'));
  assert.equal(snap.generated_at, '2026-10-01T12:00:00.000Z');
  assert.equal(snap.prs[0].number, 7);
  assert.equal(
    readFileSync(join(dir, '.golden-frijoles', '.gitignore'), 'utf8')
      .trim()
      .split('\n')
      .at(-1),
    '*'
  );
});

test('live with no network falls back to the snapshot and stamps its age', () => {
  const dir = root();
  gatherFacts({ root: dir, mode: 'live', run: stub().run, now: NOW });
  const { run, calls } = stub({ git: { status: 128, stdout: '', stderr: 'fatal: unable to access origin' } });
  const facts = gatherFacts({ root: dir, mode: 'live', run });
  assert.equal(calls.length, 1, 'no gh call once git has failed');
  assert.equal(facts.mode, 'snapshot');
  assert.equal(facts.origin, 'snapshot@2026-10-01T12:00:00.000Z');
  assert.match(facts.note, /git ls-remote failed \(fatal: unable to access origin\)/);
});

test('live with no gh installed falls back too, and says so', () => {
  const dir = root();
  const { run } = stub({
    gh: { status: null, stdout: '', error: Object.assign(new Error('spawn gh'), { code: 'ENOENT' }) },
  });
  const facts = gatherFacts({ root: dir, mode: 'live', run });
  assert.equal(facts.mode, 'docs', 'no snapshot either → docs only');
  assert.match(facts.note, /gh pr list failed \(not installed\)/);
});

test('snapshot mode never runs a command; docs mode returns no facts', () => {
  const dir = root();
  mkdirSync(join(dir, '.golden-frijoles'));
  writeFileSync(
    join(dir, SNAPSHOT_PATH),
    JSON.stringify({ generated_at: '2026-09-30T00:00:00Z', branches: ['feat/y'], prs: [] })
  );
  const { run, calls } = stub();
  const snap = gatherFacts({ root: dir, mode: 'snapshot', run });
  assert.equal(calls.length, 0);
  assert.deepEqual(snap.branches, ['feat/y']);
  assert.equal(snap.origin, 'snapshot@2026-09-30T00:00:00Z');
  const docs = gatherFacts({ root: dir, mode: 'docs', run });
  assert.deepEqual([docs.mode, docs.branches, docs.prs, docs.origin], ['docs', [], [], null]);
});

test('a malformed snapshot is no snapshot, never a crash', () => {
  const dir = root();
  mkdirSync(join(dir, '.golden-frijoles'));
  writeFileSync(join(dir, SNAPSHOT_PATH), '{"branches": "nope"}');
  const facts = gatherFacts({ root: dir, mode: 'snapshot', run: stub().run });
  assert.equal(facts.mode, 'docs');
  assert.match(facts.note, /no snapshot yet/);
});

test('an unknown mode is refused', () => {
  assert.throws(() => gatherFacts({ root: root(), mode: 'online' }), /unknown facts mode/);
});
