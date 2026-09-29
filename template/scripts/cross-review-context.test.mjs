// Which files a reviewer is shown, and under which name.
//
// ── Why this matters more than it looks ──────────────────────────────────────────────────────
// `cross-review.mjs` attaches whole-file context alongside the diff, because a reviewer reasoning
// about code it cannot see invents findings — that is stated in the attachment block's own header
// ("three wrong findings in two days"). The corollary is sharper: showing it the WRONG file is
// worse than showing none, because the reviewer is then confidently wrong rather than visibly
// blind, and a false Blocking costs a round trip to disprove.
//
// Two ways that happened, both fixed and both pinned here:
//   1. Content was read from the WORKING TREE, so reviewing a PR while checked out on its stacked
//      child handed the reviewer one branch's diff and another branch's files. Mistral Vibe duly
//      reported a compile error that did not exist (PR #118).
//   2. The path was taken from the diff's `a/` (pre-image) side, which is the wrong side once the
//      content comes from the PR head — on a rename it is the OLD name (Codex, PR #119).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headSidePaths } from './lib/cross-agent-cli.mjs';

const RENAME = [
  'diff --git a/old-name.ts b/new-name.ts',
  'similarity index 92%',
  'rename from old-name.ts',
  'rename to new-name.ts',
  '--- a/old-name.ts',
  '+++ b/new-name.ts',
  '@@ -1 +1 @@',
  '-before',
  '+after',
].join('\n');

const DELETION = [
  'diff --git a/removed.ts b/removed.ts',
  'deleted file mode 100644',
  'index 1234567..0000000',
  '--- a/removed.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
].join('\n');

const ADDITION = [
  'diff --git a/added.ts b/added.ts',
  'new file mode 100644',
  'index 0000000..1234567',
  '--- /dev/null',
  '+++ b/added.ts',
  '@@ -0,0 +1 @@',
  '+fresh',
].join('\n');

const MODIFICATION = [
  'diff --git a/kept.ts b/kept.ts',
  'index aaaaaaa..bbbbbbb 100644',
  '--- a/kept.ts',
  '+++ b/kept.ts',
  '@@ -1 +1 @@',
  '-a',
  '+b',
].join('\n');

test('a rename yields the NEW name — the one that exists at the PR head', () => {
  // The regression: taking `a/` gave "old-name.ts", which `git show <head>:old-name.ts` cannot
  // resolve, so the file was silently dropped from the reviewer's context.
  assert.deepEqual(headSidePaths(RENAME), ['new-name.ts']);
});

test('a deleted file is skipped entirely', () => {
  // It has no head-side content, so asking for it can only miss — and a miss trips the
  // "fell back to the working tree" warning for a file that is correctly absent.
  assert.deepEqual(headSidePaths(DELETION), []);
});

test('an added file is included — `--- /dev/null` must not be read as a deletion', () => {
  // The narrow-miss this guards: matching /dev/null anywhere in the chunk would drop every NEW
  // file, which is most of a feature PR. Only the `+++` side marks a deletion.
  assert.deepEqual(headSidePaths(ADDITION), ['added.ts']);
});

test('an ordinary modification is included', () => {
  assert.deepEqual(headSidePaths(MODIFICATION), ['kept.ts']);
});

test('a mixed diff keeps exactly the files that exist at head, under their head names', () => {
  const diff = [MODIFICATION, RENAME, DELETION, ADDITION].join('\n');
  assert.deepEqual(headSidePaths(diff), ['kept.ts', 'new-name.ts', 'added.ts']);
});

test("one file's deletion does not suppress its neighbours", () => {
  // `+++ /dev/null` is matched per file chunk. Scanned across the whole diff it would drop
  // everything after the first deletion — a silent, total loss of context on any PR that removes
  // a file, which is the failure mode most likely to go unnoticed.
  assert.deepEqual(headSidePaths([DELETION, MODIFICATION].join('\n')), ['kept.ts']);
  assert.deepEqual(headSidePaths([MODIFICATION, DELETION].join('\n')), ['kept.ts']);
});

test('an empty or absent diff yields nothing rather than throwing', () => {
  for (const input of ['', null, undefined]) {
    assert.deepEqual(headSidePaths(input), []);
  }
});

test('a GIT-QUOTED path is parsed, not dropped', () => {
  // Git quotes any path containing a space, a control character or a non-ASCII byte. The first
  // version treated a quoted header as unparseable and silently omitted the file — which is the
  // exact defect this seam exists to remove (Codex, PR #119 round 2). Losing a renamed file and
  // losing an accented one are the same bug.
  const spaced =
    'diff --git "a/with space.ts" "b/with space.ts"\n--- "a/with space.ts"\n+++ "b/with space.ts"\n@@ -1 +1 @@\n-a\n+b';
  assert.deepEqual(headSidePaths(spaced), ['with space.ts']);
});

test('octal escapes are decoded as BYTES, so a non-ASCII filename survives intact', () => {
  // Git emits one escape per UTF-8 byte: `é` is \303\251. Decoding each escape as its own
  // character would yield "cafÃ©" — a filename `git show` cannot resolve, i.e. a silent omission
  // wearing the appearance of success.
  const accented =
    'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n--- "a/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n@@ -1 +1 @@\n-a\n+b';
  assert.deepEqual(headSidePaths(accented), ['café.ts']);
});

test('a quoted RENAME still yields the new name', () => {
  const renamed =
    'diff --git "a/old name.ts" "b/new name.ts"\n--- "a/old name.ts"\n+++ "b/new name.ts"\n@@ -1 +1 @@\n-a\n+b';
  assert.deepEqual(headSidePaths(renamed), ['new name.ts']);
});

test('a quoted DELETION is still skipped', () => {
  const removed =
    'diff --git "a/with space.ts" "b/with space.ts"\ndeleted file mode 100644\n--- "a/with space.ts"\n+++ /dev/null\n@@ -1 +0,0 @@\n-x';
  assert.deepEqual(headSidePaths(removed), []);
});

test('a malformed header is dropped, never emitted as undefined', () => {
  // Emitting undefined would make the file reader throw on a filename rather than skip it.
  for (const header of ['diff --git nonsense', 'diff --git "a/unterminated b/x', 'diff --git ']) {
    const result = headSidePaths(`${header}\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b`);
    assert.ok(
      result.every((path) => typeof path === 'string' && path.length > 0),
      `malformed header produced a bad entry: ${JSON.stringify(result)}`
    );
  }
});

test('an ADDED line that looks like a deletion marker does not drop the file', () => {
  // Inside a hunk, an added line is rendered with a leading `+`, so a source line whose literal text
  // is `++ /dev/null` produces the byte-identical `+++ /dev/null`. Scanning the whole chunk read
  // that as a deletion and silently dropped a file that was never deleted (Codex, PR #119 round 3).
  // The `+++` marker only means deletion in the HEADER, before the first `@@`.
  const tricky =
    'diff --git a/tricky.ts b/tricky.ts\n--- a/tricky.ts\n+++ b/tricky.ts\n@@ -0,0 +1 @@\n+++ /dev/null';
  assert.deepEqual(headSidePaths(tricky), ['tricky.ts']);
});

test('a real deletion is still detected when a later hunk contains the same text', () => {
  // The inverse guard: scoping to the header must not stop finding a genuine deletion.
  const removed =
    'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-+++ /dev/null';
  assert.deepEqual(headSidePaths(removed), []);
});

test('a BINARY deletion is skipped — it has no `+++ /dev/null` line at all', () => {
  // Git renders a binary deletion as `Binary files a/x and /dev/null differ`, with no `+++` marker.
  // Checking only that marker attached a path that cannot exist at head, then reported it as
  // "unavailable" — a misleading warning about a file that is correctly gone (Codex, PR #119 r4).
  const binaryDelete = [
    'diff --git a/logo.png b/logo.png',
    'deleted file mode 100644',
    'index 1234567..0000000',
    'Binary files a/logo.png and /dev/null differ',
  ].join('\n');
  assert.deepEqual(headSidePaths(binaryDelete), []);
});

test('a BINARY addition is still included — it exists at head', () => {
  // The inverse: `new file mode` plus `Binary files /dev/null and b/x differ`. Matching /dev/null
  // loosely, or treating any binary chunk as a deletion, would drop every added asset.
  const binaryAdd = [
    'diff --git a/logo.png b/logo.png',
    'new file mode 100644',
    'index 0000000..1234567',
    'Binary files /dev/null and b/logo.png differ',
  ].join('\n');
  assert.deepEqual(headSidePaths(binaryAdd), ['logo.png']);
});

test('MIXED quoting is handled — git quotes each side independently', () => {
  // A reviewer (Mistral Vibe, PR #119) suggested documenting an invariant that "git always quotes
  // both sides when needed", so the mixed case is impossible. It is not: git quotes a path only if
  // THAT path needs it, so renaming `old.ts` to `new file.ts` produces exactly one quoted side.
  // Pinned as a spec rather than written down as a comment, because the comment would have been
  // false and a false invariant invites someone to "simplify" the code that handles the real case.
  const unquotedToQuoted =
    'diff --git a/old.ts "b/new file.ts"\n--- a/old.ts\n+++ "b/new file.ts"\n@@ -1 +1 @@\n-a\n+b';
  assert.deepEqual(headSidePaths(unquotedToQuoted), ['new file.ts']);

  const quotedToUnquoted =
    'diff --git "a/old file.ts" b/new.ts\n--- "a/old file.ts"\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b';
  assert.deepEqual(headSidePaths(quotedToUnquoted), ['new.ts']);
});
