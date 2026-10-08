// kit-bin.test.mjs — frijoles-kit's own contract: which flags are its own, what it refuses, and its exit codes.
// Run: node --test scripts/kit-bin.test.mjs   (needs a built kit: node scripts/build-kit.mjs)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { stageKit } from './build-kit.mjs';
import { parseArgs, deprecatedNameNotice } from '../kit/bin.mjs';

// A private staged kit: specs run in parallel, and the shared kit/dist/ must not be rebuilt under another one.
const STAGE = realpathSync(mkdtempSync(join(tmpdir(), 'kit-bin-')));
stageKit(STAGE);
const BIN = join(STAGE, 'bin.mjs');
const gfKit = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

test('parseArgs: only flags BEFORE the script name belong to frijoles-kit; the rest go to the script untouched', () => {
  assert.deepEqual(parseArgs(['--root', 'x', 'build-order', '--root', 'y', '--list']), {
    root: 'x', list: false, version: false, help: false, name: 'build-order', rest: ['--root', 'y', '--list'],
  });
  assert.equal(parseArgs(['--root=/a', 'b']).root, '/a');
  assert.equal(parseArgs(['--root']).root, '', 'a --root with no value is caught later, not silently null');
});

test('frijoles-kit refuses an unknown script and anything path-shaped, with exit 2 and the list', () => {
  for (const name of ['nope', '../../etc/passwd', 'lib/project-root', 'build-order.mjs']) {
    const r = gfKit(name);
    assert.equal(r.status, 2, `${name} should be refused`);
    assert.match(r.stderr, /no script/);
  }
});

test('frijoles-kit --root must name a directory that exists', () => {
  assert.equal(gfKit('--root', '/definitely/not/here', 'build-order').status, 2);
  assert.equal(gfKit('--root').status, 2);
});

test('frijoles-kit with no script prints usage and exits 2; --help exits 0; --version prints the package version', () => {
  assert.equal(gfKit().status, 2);
  assert.equal(gfKit('--help').status, 0);
  assert.match(gfKit('--version').stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("a script's exit code passes through unchanged", () => {
  // build-order --check exits 1 on a project whose board is stale/absent; the dispatcher must not flatten it.
  const r = spawnSync(process.execPath, [BIN, '--root', dirname(fileURLToPath(import.meta.url)), 'build-order', '--check'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.notEqual(r.status, 2, 'a script failure is not a usage error');
});

test('started as gf-kit: one stderr notice naming frijoles-kit and the date; frijoles-kit and the entry: none', () => {
  for (const path of ['/usr/local/bin/gf-kit', '/x/node_modules/.bin/gf-kit']) {
    assert.match(deprecatedNameNotice(path), /^gf-kit is now frijoles-kit\. .*2026-12-31.*\n$/);
  }
  for (const path of ['/usr/local/bin/frijoles-kit', '/x/kit/bin.mjs', '/x/gf', undefined]) {
    assert.equal(deprecatedNameNotice(path), null, String(path));
  }
});
