// rail-entry-symlink.test.mjs — every shipped rail entry still RUNS when invoked through a symlinked path.
//
// An isMain guard that compares a link on one side with a real path on the other silently does nothing:
// the script exits 0 having checked nothing (#189 review found it in five entries, one round at a time).
// This runs each entry through a symlinked directory with an argument that must produce output, so the
// class fails here instead of in a stranger's symlinked checkout.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'rail-link-'));
const LINK = join(TMP, 'scripts');
symlinkSync(HERE, LINK);
after(() => rmSync(TMP, { recursive: true, force: true }));

// [entry, args, output that proves main() ran]
const ENTRIES = [
  ['review-route.mjs', ['--builder', 'claude', '12abc'], /must be numeric/],
  ['cross-review.mjs', ['--help'], /cross-review\.mjs/],
  ['cross-agent-doctor.mjs', ['bogus-family'], /unknown family/],
  ['session-note.mjs', [], /usage|kind|note/i],
  ['session-resume.mjs', ['--help'], /session-resume\.mjs/],
  // One per spelling that DID break behind a link before lib/is-main.mjs (template-scripts-consumer-gates D6).
  ['owed-ledger.mjs', ['--bogus'], /owed-ledger: \d+ owed/], // resolve(argv[1]) === fileURLToPath(…)
  ['epic-dod.mjs', ['--bogus'], /usage: node scripts\/epic-dod\.mjs/], // the same, reversed
  ['cold-read.mjs', ['--help'], /usage: cold-read\.mjs/], // fileURLToPath(…) === argv[1], no resolve at all
  ['perf-probe.mjs', ['--help'], /raw compressed transfer baseline/], // pathToFileURL(argv[1]).href
];

for (const [entry, args, proof] of ENTRIES) {
  // A project that copied only some rails (this test travels with them) skips, by name, an entry it does not have.
  // In the template every entry exists, so the source never skips.
  const absent = !existsSync(join(HERE, entry));
  test(`${entry} runs through a symlinked path`, { skip: absent && `${entry} is not in this project's scripts/` }, () => {
    const r = spawnSync(process.execPath, [join(LINK, entry), ...args], { encoding: 'utf8' });
    assert.match(
      `${r.stdout}${r.stderr}`,
      proof,
      `${entry} printed nothing through the link — isMain compared a link to a real path`
    );
  });
}

// The helper itself, through a link: true when run, false when imported (the second half is what keeps a test that
// imports a rail for its pure helpers from running the rail).
test('lib/is-main.mjs: true through a symlinked path, false when imported', () => {
  const probe = join(HERE, 'lib', `.is-main-probe-${process.pid}.mjs`);
  writeFileSync(probe, "import { isMain } from './is-main.mjs';\nconsole.log(isMain(import.meta.url) ? 'main' : 'imported');\n");
  try {
    const run = spawnSync(process.execPath, [join(LINK, 'lib', `.is-main-probe-${process.pid}.mjs`)], { encoding: 'utf8' });
    assert.equal(run.stdout.trim(), 'main', run.stderr);
    const imported = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(join(LINK, 'lib', `.is-main-probe-${process.pid}.mjs`))});`],
      { encoding: 'utf8' }
    );
    assert.equal(imported.stdout.trim(), 'imported', imported.stderr);
  } finally {
    rmSync(probe, { force: true });
  }
});
