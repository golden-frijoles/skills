import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseValue } from './config.mjs';

test('parseValue: JSON when it is JSON, else the literal string', () => {
  assert.equal(parseValue('true'), true);
  assert.equal(parseValue('3'), 3);
  assert.deepEqual(parseValue('["a","b"]'), ['a', 'b']);
  assert.equal(parseValue('null'), null);
  assert.equal(parseValue('every-pr'), 'every-pr');
});

/** Run `frijoles-kit config` against a temp project (GF_PROJECT_ROOT is how frijoles-kit --root reaches a script). */
function run(argv, root) {
  const prev = process.env.GF_PROJECT_ROOT;
  process.env.GF_PROJECT_ROOT = root;
  const out = [];
  const err = [];
  try {
    const code = main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    if (prev === undefined) delete process.env.GF_PROJECT_ROOT;
    else process.env.GF_PROJECT_ROOT = prev;
  }
}

test('set then get round-trips through the project file', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gfkit-config-')));
  assert.equal(run(['set', 'jev.egress', 'false'], root).code, 0);
  assert.equal(run(['get', 'jev.egress'], root).out.trim(), 'false');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'golden-frijoles.config.json'), 'utf8')), { jev: { egress: false } });
});

test('a secret is refused with exit 2 and the fix; a usage error exits 1', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gfkit-config-')));
  const r = run(['set', 'reporting.botToken', 'xoxb-1'], root);
  assert.equal(r.code, 2);
  assert.match(r.err, /env var NAME/);
  assert.equal(run(['frobnicate'], root).code, 1);
});

test('migrate --dry-run on an empty repo: nothing to migrate, nothing written', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gfkit-config-')));
  const r = run(['migrate', '--dry-run'], root);
  assert.equal(r.code, 0);
  assert.match(r.out, /Nothing to migrate/);
});

test('migrate --dry-run with legacy files prints the file it would write and writes nothing', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gfkit-config-')));
  writeFileSync(join(root, 'jev.config.json'), JSON.stringify({ egress: true }));
  const r = run(['migrate', '--dry-run'], root);
  assert.match(r.out, /Would write golden-frijoles\.config\.json/);
  assert.throws(() => readFileSync(join(root, 'golden-frijoles.config.json')));
});
