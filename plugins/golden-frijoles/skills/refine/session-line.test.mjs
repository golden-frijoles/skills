// session-line.test.mjs — the Cowork CLI: the printed line, the parse errors, and the gitignored log (D6, D7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './session-line.mjs';

const CLI = fileURLToPath(new URL('./session-line.mjs', import.meta.url));

test('parseArgs takes whole-number counts and refuses anything else', () => {
  assert.deepEqual(parseArgs(['--asks-open', '2', '--questions-waiting', '0', '--gates-passed', '1', '--root', '/x']), {
    counts: { asksOpen: 2, questionsWaiting: 0, gatesPassed: 1 },
    root: '/x',
    log: true,
  });
  assert.throws(() => parseArgs(['--asks-open', 'two']), /whole number/);
  assert.throws(() => parseArgs(['--asks-open', '-1']), /whole number/);
  assert.throws(() => parseArgs(['--context', '50']), /unknown argument/);
  assert.throws(() => parseArgs(['--gates-passed', '1', '--root']), /--root takes a directory/);
  assert.throws(() => parseArgs(['--root', '--no-log']), /--root takes a directory/, 'a flag is never a directory');
});

test('the CLI prints the line and appends one row to a self-ignoring log per run', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-line-'));
  try {
    const run = () =>
      execFileSync('node', [CLI, '--asks-open', '1', '--questions-waiting', '3', '--gates-passed', '2', '--root', root], {
        encoding: 'utf8',
      });
    assert.equal(run().trim(), '1 ask open · 3 questions waiting · 2 gates passed · context: not measured here → checkpoint');
    run();
    const rows = readFileSync(join(root, '.golden-frijoles/session-budget.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].surface, 'cowork');
    assert.equal(rows[0].verdict, 'checkpoint');
    assert.equal(rows[0].questionsWaiting, 3);
    assert.equal('contextPct' in rows[0], false, 'Cowork never logs a context figure it did not measure');
    assert.match(readFileSync(join(root, '.golden-frijoles/.gitignore'), 'utf8'), /^\*$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--no-log prints without writing; a bad argument exits 2 with usage', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-line-'));
  try {
    execFileSync('node', [CLI, '--gates-passed', '1', '--root', root, '--no-log']);
    assert.equal(spawnSync('test', ['-e', join(root, '.golden-frijoles')]).status, 1);
    const bad = spawnSync('node', [CLI, '--asks-open'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Usage:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
