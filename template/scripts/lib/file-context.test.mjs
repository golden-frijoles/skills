// Whole-file context for the DIFF-ONLY reviewers (agy, vibe).
//
// The property that matters most here is the manifest, not the attachment: a reviewer handed some
// files and not others, with no list, would conclude an unattached file does not exist — which is
// the exact finding class this feature exists to remove, made worse. Every omission must be named.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFileContext, renderFileContext } from './cross-agent-cli.mjs';

const read = (map) => (p) => {
  if (!(p in map)) throw new Error('ENOENT');
  return map[p];
};

test('a deleted/renamed file is skipped, not fatal', () => {
  const r = buildFileContext(['gone.ts', 'a.ts'], read({ 'a.ts': 'ok' }), 10_000);
  assert.deepEqual(
    r.attached.map((f) => f.path),
    ['a.ts']
  );
  assert.deepEqual(r.omitted, []);
});

test('smallest first, and everything that did not fit is NAMED', () => {
  const r = buildFileContext(
    ['big.ts', 'small.ts'],
    read({ 'big.ts': 'x'.repeat(9000), 'small.ts': 'y' }),
    1000
  );
  assert.deepEqual(
    r.attached.map((f) => f.path),
    ['small.ts']
  );
  assert.deepEqual(r.omitted, ['big.ts']);
  const rendered = renderFileContext(r);
  assert.match(rendered, /did NOT fit the size budget/);
  assert.match(
    rendered,
    /big\.ts/,
    'an omitted file must be named — silence would read as "it does not exist"'
  );
});

test('duplicates are collapsed', () => {
  const r = buildFileContext(['a.ts', 'a.ts'], read({ 'a.ts': 'ok' }), 10_000);
  assert.equal(r.attached.length, 1);
});

test('a zero budget attaches nothing and says so rather than pretending', () => {
  const r = buildFileContext(['a.ts'], read({ 'a.ts': 'ok' }), 0);
  assert.deepEqual(r.attached, []);
  assert.deepEqual(r.omitted, ['a.ts']);
  assert.match(renderFileContext(r), /a\.ts/);
});

test('nothing to attach renders nothing at all', () => {
  assert.equal(renderFileContext({ attached: [], omitted: [] }), '');
});
