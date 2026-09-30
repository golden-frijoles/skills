// rail-entry-symlink.test.mjs — every shipped rail entry still RUNS when invoked through a symlinked path.
//
// An isMain guard that compares a link on one side with a real path on the other silently does nothing:
// the script exits 0 having checked nothing (#189 review found it in five entries, one round at a time).
// This runs each entry through a symlinked directory with an argument that must produce output, so the
// class fails here instead of in a stranger's symlinked checkout.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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
];

for (const [entry, args, proof] of ENTRIES) {
  test(`${entry} runs through a symlinked path`, () => {
    const r = spawnSync(process.execPath, [join(LINK, entry), ...args], { encoding: 'utf8' });
    assert.match(
      `${r.stdout}${r.stderr}`,
      proof,
      `${entry} printed nothing through the link — isMain compared a link to a real path`
    );
  });
}
