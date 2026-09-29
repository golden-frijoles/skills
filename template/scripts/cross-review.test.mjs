// cross-review.test.mjs — the empty-output guard, proven against a DELIBERATELY BROKEN reviewer CLI.
//
// This is the load-bearing spec of the one-external-pass policy (ways-of-work-lean-pass S2.4): with two
// passes, a CLI that exited 0 printing nothing was contradicted by the other one; with one, it reads as
// a clean review. So the fixture below IS the failure — a `codex` that exits 0 and says nothing — and
// asserts the run exits non-zero, posts NO review comment, and marks the PR's status FAILED.
//
// No network: `gh` and `codex` are stubs on PATH that log their argv. Real `cross-review.mjs`, real
// argument parsing, real guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildComment, promptPathFor } from './cross-review.mjs';
import { decideSecurityPass, parseReviewConfig } from './lib/review-guard.mjs';

// A path that THIS project's own review-config.json treats as a security path. Derived, not hardcoded:
// each repo's globs differ, and a hardcoded path silently stops triggering the lens in a repo whose
// config moved — the spec would then pass while testing nothing.

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const CONFIG = parseReviewConfig(JSON.parse(readFileSync(join(SCRIPTS, 'review-config.json'), 'utf8')));
const SECURITY_PATH = (() => {
  for (const glob of CONFIG.securityPaths) {
    const candidate = glob
      .replace(/\*\*\//g, 'x/')
      .replace(/\/\*\*/g, '/x')
      .replace(/\*/g, 'x');
    if (decideSecurityPass({ files: [candidate], securityPaths: CONFIG.securityPaths }).run) return candidate;
  }
  throw new Error('no securityPaths glob could be materialised — review-config.json is unusable');
})();
const DIFF =
  'diff --git a/app/api/checkout/route.ts b/app/api/checkout/route.ts\n--- a/app/api/checkout/route.ts\n+++ b/app/api/checkout/route.ts\n@@ -1 +1,2 @@\n+// a change worth reviewing\n';

/** A sandbox with stub `gh` + `codex` on PATH. `codexOut` is what the stub reviewer prints. */
function sandbox(codexOut) {
  const dir = mkdtempSync(join(tmpdir(), 'cross-review-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
echo "$@" >> "${log}"
case "$*" in
  *"pr comment"*) cat >> "${log}" ;;
esac
case "$1 $2" in
  "auth status") exit 0 ;;
esac
case "$*" in
  *"pr diff"*) printf '%s' '${DIFF.replace(/'/g, "'\\''")}' ;;
  *"--json comments"*) echo '{"comments":[]}' ;;
  *"--json headRefOid,url"*) echo '{"headRefOid":"abc123def456","url":"https://github.com/o/r/pull/7"}' ;;
  *"--json headRefOid"*) echo '{"headRefOid":"abc123def456"}' ;;
  *"--json files"*) echo '{"files":[{"path":"${SECURITY_PATH}","additions":40,"deletions":0}]}' ;;
  *"--json author"*) echo 'a-collaborator' ;;
  *"/permission"*) echo "\${GH_PERMISSION:-write}" ;;
  *) echo "ok" ;;
esac
exit 0
`
  );
  // The broken reviewer: exit 0, print exactly what the caller asked for (nothing, by default).
  writeFileSync(
    join(bin, 'codex'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.154.0"; exit 0; fi
cat > /dev/null
printf '%s' '${String(codexOut).replace(/'/g, "'\\''")}'
exit 0
`
  );
  for (const f of ['gh', 'codex']) chmodSync(join(bin, f), 0o755);
  return { dir, bin, log };
}

function runCrossReview({ bin, args, env = {} }) {
  // stdout AND stderr: the run's warnings (a security lens still owed) go to stderr, and a spec that
  // only reads stdout would pass whatever the run said.
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'cross-review.mjs'), ...args], {
    encoding: 'utf8',
    // HOME is a temp dir: the secret guard reads the operator's credential stores, and a test must not.
    env: {
      ...process.env,
      HOME: mkdtempSync(join(tmpdir(), 'cr-home-')),
      ...env,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('a reviewer that exits 0 printing NOTHING fails the run and fails the PR status', () => {
  const { bin, log } = sandbox('');
  const r = runCrossReview({ bin, args: ['7', '--repo', 'o/r', '--agent', 'codex'] });
  assert.notEqual(r.code, 0, 'a silent reviewer must not exit 0');
  assert.match(r.out, /did not return a review/);
  const gh = readFileSync(log, 'utf8');
  assert.match(gh, /statuses\/abc123def456/, 'no commit status was posted');
  assert.match(gh, /state=failure/, 'the status must be failure');
  assert.doesNotMatch(gh, /pr comment/, 'a failed run must not post a review comment');
});

test('a reviewer that emits a raw tool call fails the same way', () => {
  const { bin, log } = sandbox(`read_file{"path": "/repo/${SECURITY_PATH}"}`);
  const r = runCrossReview({ bin, args: ['7', '--repo', 'o/r', '--agent', 'codex'] });
  assert.notEqual(r.code, 0);
  assert.match(readFileSync(log, 'utf8'), /state=failure/);
});

test('the comment carries the reviewed sha, and the status is pinned to it', () => {
  const { bin, log } = sandbox('### Blocking\n\n- ' + SECURITY_PATH + ':1 trusts the body.\n');
  const r = runCrossReview({ bin, args: ['7', '--repo', 'o/r', '--agent', 'codex'] });
  assert.equal(r.code, 0, r.out);
  const gh = readFileSync(log, 'utf8');
  // The stub gh reports headRefOid abc123def456 for every query.
  assert.match(gh, /statuses\/abc123def456/);
  assert.match(gh, /sha=abc123def456/, 'the posted comment must record which commit was reviewed');
});

test('a real review posts the comment and a success status', () => {
  const { bin, log } = sandbox(
    '### Blocking\n\n- `app/api/checkout/route.ts:1` the handler trusts the body.\n'
  );
  const r = runCrossReview({ bin, args: ['7', '--repo', 'o/r', '--agent', 'codex'] });
  assert.equal(r.code, 0, r.out);
  const gh = readFileSync(log, 'utf8');
  assert.match(gh, /pr comment 7/);
  assert.match(gh, /state=success/);
});

test('a general pass on a security-path PR says the security lens is still OWED', () => {
  // The stub gh reports a changed file matching the default securityPaths globs.
  const { bin, log } = sandbox('### Blocking\n\n- ' + SECURITY_PATH + ':1 trusts the body.\n');
  const r = runCrossReview({ bin, args: ['7', '--repo', 'o/r', '--agent', 'codex'] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /triggers the security lens/);
  assert.match(readFileSync(log, 'utf8'), /pr comment 7/);
});

test('--dry-run posts neither a comment nor a status, even on a failed run', () => {
  const { bin, log } = sandbox('');
  const r = runCrossReview({ bin, args: ['7', '--repo', 'o/r', '--agent', 'codex', '--dry-run'] });
  assert.notEqual(r.code, 0);
  const gh = readFileSync(log, 'utf8');
  assert.doesNotMatch(gh, /statuses/);
  assert.doesNotMatch(gh, /pr comment/);
});

test('--lens security swaps the prompt, and an unknown lens is refused rather than silently general', () => {
  assert.match(promptPathFor('security'), /cross-review\.security\.prompt\.md$/);
  assert.match(promptPathFor(null), /cross-review\.prompt\.md$/);
  assert.throws(() => promptPathFor('perf'), /unknown lens/);
  const { bin } = sandbox('');
  const r = runCrossReview({ bin, args: ['7', '--repo', 'o/r', '--agent', 'codex', '--lens', 'perf'] });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /unknown --lens/);
});

test('the comment labels the lens, records the CLI version, and marks a re-review', () => {
  const security = buildComment('Codex', 'findings', false, { lens: 'security', version: 'codex 0.154.0' });
  assert.match(security, /🔐 Cross-agent review — security lens \(Codex\)/);
  assert.match(security, /static analysis/i);
  assert.match(security, /_codex 0\.154\.0\._/);
  const owed = buildComment('Codex', 'findings', false, {
    securityOwed: 'touches security paths: app/api/x.ts',
  });
  assert.match(owed, /security lens is OWED/);
  const general = buildComment('Codex', 'findings', false, { reReview: true });
  assert.doesNotMatch(general, /OWED/);
  assert.match(general, /🔎 Cross-agent review \(Codex\)/);
  assert.match(general, /Re-review/);
  assert.doesNotMatch(buildComment('Codex', 'f', false, {}), /Re-review/);
});

test('the reviewer diff treats jev-eval.fixtures.json as generated data (jev-semantic-guards)', async () => {
  const { stripGeneratedFileDiffs } = await import('./lib/cross-agent-cli.mjs');
  const hunk =
    'diff --git a/scripts/jev-eval.fixtures.json b/scripts/jev-eval.fixtures.json\nindex 1..2 100644\n--- a/scripts/jev-eval.fixtures.json\n+++ b/scripts/jev-eval.fixtures.json\n@@ -1 +1 @@\n-{}\n+{"review":[]}\n';
  assert.deepEqual(stripGeneratedFileDiffs(hunk).strippedFiles, ['scripts/jev-eval.fixtures.json']);
});

test('buildComment still accepts the older (label, findings, opts) shape (distribute-what-we-use D1)', () => {
  // This repo's copy called buildComment without `fellBack` until the rail was merged into one; an
  // options object in third position must never be read as a truthy "fell back".
  const legacy = buildComment('Codex', 'findings', { lens: 'security' });
  assert.match(legacy, /🔐 Cross-agent review — security lens \(Codex\)/);
  assert.doesNotMatch(legacy, /Codex unavailable/);
  assert.match(buildComment('Codex', 'findings', true, {}), /Antigravity — Codex unavailable/);
});

test('every status post pins the reviewed sha (distribute-what-we-use S1, cross-review on #188)', () => {
  // The template pinned all three; this repo's copy pinned only the pending one, and the first superset
  // kept that. Without the pin, a push during the review attaches the verdict to a head nobody reviewed.
  const src = readFileSync(new URL('./cross-review.mjs', import.meta.url), 'utf8');
  const calls = src
    .split('postReviewStatus({')
    .slice(1)
    .map((rest) => rest.slice(0, rest.indexOf('});')));
  assert.ok(calls.length >= 3, 'pending, failure, withheld and success');
  for (const call of calls) assert.match(call, /\bsha: reviewedSha\b/);
});

test('the secret guard runs before anything is posted (pr-reviewer round 2 on #188)', () => {
  const src = readFileSync(new URL('./cross-review.mjs', import.meta.url), 'utf8');
  const guard = src.indexOf('findSecretLeaks(findings');
  assert.ok(guard > 0, 'cross-review checks the reply with findSecretLeaks');
  assert.ok(guard < src.indexOf('= postComment(pr, repo, body)'), 'and does so before postComment');
  // …and before the output guard, which quotes the reply in a public status and asks Jev about it.
  const judged = src.indexOf('await judgeReviewOutput(findings');
  assert.ok(judged > 0 && guard < judged, 'the secret guard runs before judgeReviewOutput');
  const afterReview = src.indexOf('runReview(', src.indexOf('async function main'));
  const firstStatus = src.indexOf('postReviewStatus({', afterReview);
  assert.ok(guard < firstStatus, 'and before any status posted after the review ran');
});

test('the author-trust gate runs before any reviewer is given the diff (codex security lens on #188)', () => {
  const src = readFileSync(new URL('./cross-review.mjs', import.meta.url), 'utf8');
  const main = src.indexOf('async function main');
  const gate = src.indexOf('decideAuthorTrust({', main);
  assert.ok(gate > main, 'main() checks the author');
  assert.ok(gate < src.indexOf('runReview(', main), 'before runReview');
});

test('an author without write access is refused before the reviewer runs or anything is posted', () => {
  const { bin, log } = sandbox('### Blocking\n\n- `x.mjs:1` a finding.\n');
  const r = runCrossReview({
    bin,
    args: ['7', '--repo', 'o/r', '--agent', 'codex'],
    env: { GH_PERMISSION: 'read' },
  });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /--allow-untrusted-author/);
  const gh = readFileSync(log, 'utf8');
  assert.doesNotMatch(gh, /pr diff/, 'the diff was never even fetched');
  assert.doesNotMatch(gh, /statuses\/|pr comment/, 'nothing was posted');
  const allowed = runCrossReview({
    bin,
    args: ['7', '--repo', 'o/r', '--agent', 'codex', '--allow-untrusted-author'],
    env: { GH_PERMISSION: 'read' },
  });
  assert.equal(allowed.code, 0, allowed.out);
});

test('a reply carrying a secret is WITHHELD end to end: no comment, a failing status, redacted locally (#188 r4)', () => {
  const token = 'ghp_' + 'Z'.repeat(36);
  const { bin, log } = sandbox(`### Blocking\n\n- \`x.mjs:1\` the config is ${token}\n`);
  const r = runCrossReview({ bin, args: ['7', '--repo', 'o/r', '--agent', 'codex'] });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /WITHHELD/);
  assert.doesNotMatch(r.out, new RegExp(token), 'the value is redacted even in the local print');
  const gh = readFileSync(log, 'utf8');
  assert.doesNotMatch(gh, /pr comment/, 'nothing posted as a comment');
  assert.doesNotMatch(gh, new RegExp(token), 'nothing carrying the token reached gh');
  assert.match(gh, /state=failure/);
});
