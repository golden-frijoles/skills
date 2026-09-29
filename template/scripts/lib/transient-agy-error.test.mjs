// isTransientAgyError — the classifier that decides whether an agy failure earns the fallback model.
//
// Why this needs its own test file rather than a line in an existing one: the two directions of this
// function fail in opposite, equally bad ways, and the balance between them is the whole design.
//
//   Too NARROW → a passing provider blip aborts the run. That is what happened on 2026-07-25:
//     `gpt-oss-120b-medium` returned "Our servers are experiencing high traffic right now" with a
//     non-zero exit, and because the fallback was wired only to the empty-output signal, the second
//     model — a separate capacity pool, sitting right there — was never tried.
//
//   Too BROAD → genuine breakage gets silently retried on another model and looks like success.
//     That is the 1.0.10 incident this repo already paid for once: agy changed its print contract,
//     the failure was absorbed, and empty reviews shipped for weeks. A classifier that matches
//     "error" or "failed" would recreate it.
//
// So the negative cases below matter at least as much as the positive ones.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTransientAgyError,
  checkReviewerPairing,
  reviewersFor,
  BUILDER_FAMILIES,
} from './cross-agent-cli.mjs';

test('transient: the exact live message that motivated this classifier', () => {
  assert.equal(
    isTransientAgyError(
      'Error: Our servers are experiencing high traffic right now, please try again in a minute.'
    ),
    true
  );
});

test('transient: capacity, rate-limit and upstream-status signals', () => {
  for (const msg of [
    'RESOURCE_EXHAUSTED 429: Individual quota reached',
    'Error: rate limit exceeded',
    'HTTP 429 Too Many Requests',
    'upstream returned 503',
    'model is overloaded, retry',
    'service temporarily unavailable',
    'please try again later',
    'request timed out',
    'read ECONNRESET',
    'connect ETIMEDOUT 10.0.0.1:443',
    'getaddrinfo EAI_AGAIN api.example.com',
  ]) {
    assert.equal(isTransientAgyError(msg), true, `expected transient: ${msg}`);
  }
});

test('NOT transient: a real interface break must fail loud, never fall back', () => {
  // Each of these means "the tool or our invocation is wrong". Retrying on a second model would
  // hide the defect and produce a confident, empty or wrong result — the 1.0.10 failure mode.
  for (const msg of [
    'unexpected arguments: [list]',
    'unknown flag: --modle',
    'Error: unknown subcommand "modles"',
    'panic: runtime error: invalid memory address',
    'agy: command not found',
    'permission denied',
    'invalid model name',
    'authentication required — please run agy login',
    'unauthorized',
  ]) {
    assert.equal(isTransientAgyError(msg), false, `expected NON-transient: ${msg}`);
  }
});

test('NOT transient: generic error words alone are not enough', () => {
  // The guard against a lazy future widening of the pattern.
  for (const msg of ['error', 'failed', 'Error: something went wrong', '']) {
    assert.equal(isTransientAgyError(msg), false, `expected NON-transient: ${JSON.stringify(msg)}`);
  }
});

test('null and undefined are handled as non-transient, not thrown', () => {
  assert.equal(isTransientAgyError(null), false);
  assert.equal(isTransientAgyError(undefined), false);
});

test('transient: the signal is found anywhere in MULTI-LINE output, not just on the last line', () => {
  // Cross-review caught the caller passing only the final stderr line (the nicest one to show a
  // human). agy can print the transient notice and THEN a stack trace or a status line, which would
  // hide the phrase and abort instead of falling back. The classifier must scan the whole blob, and
  // the caller must hand it the whole blob.
  const multiline = [
    'Error: Our servers are experiencing high traffic right now, please try again in a minute.',
    '    at Object.<anonymous> (/opt/agy/dist/index.js:1:1)',
    '    at Module._compile (node:internal/modules/cjs/loader:1234:14)',
    'exit status 1',
  ].join('\n');
  assert.equal(isTransientAgyError(multiline), true);

  // …and the same when the notice arrives on stdout while stderr carries only the trailing status,
  // which is how the caller concatenates the two streams.
  assert.equal(isTransientAgyError('exit status 1\n\nupstream returned 503\n'), true);
});

// ── Builder family ≠ reviewer family (2026-07-26) ──────────────────────────────────────────────
// Newly load-bearing now that Codex builds here as well as reviews. The property: a family may
// never clear its own work, and the refusal must be a refusal rather than a warning, because the
// review output looks identical either way.

test('a codex-built diff may NOT be reviewed by codex', () => {
  const msg = checkReviewerPairing('codex', 'codex');
  assert.ok(msg, 'expected a refusal');
  assert.match(msg, /SAME-FAMILY/);
  // The message must name the way out, or the next person works around it instead of complying.
  assert.match(msg, /--agent antigravity/);
});

test('an agy-built diff may NOT be reviewed by antigravity (the name differs from the family)', () => {
  // The trap: the CLI is 'antigravity' and the family is 'agy'. A naive string compare passes this
  // pairing straight through, which is exactly the silent same-family review the guard exists for.
  assert.ok(checkReviewerPairing('agy', 'antigravity'), 'expected a refusal');
});

test('the cross-family pairings are all permitted', () => {
  assert.equal(checkReviewerPairing('codex', 'antigravity'), null);
  assert.equal(checkReviewerPairing('agy', 'codex'), null);
  assert.equal(checkReviewerPairing('claude', 'codex'), null);
  assert.equal(checkReviewerPairing('claude', 'antigravity'), null);
});

test('an unstated or human builder is never refused', () => {
  // Refusing an unlabelled diff would make the safe path the annoying one, which is how a check
  // gets bypassed rather than followed.
  for (const b of ['', null, undefined, 'human', 'HUMAN']) {
    assert.equal(checkReviewerPairing(b, 'codex'), null);
    assert.equal(checkReviewerPairing(b, 'antigravity'), null);
  }
});

test('builder is matched case-insensitively', () => {
  assert.ok(checkReviewerPairing('CODEX', 'codex'), 'expected a refusal for CODEX/codex');
});

test('reviewersFor never returns the builder own family', () => {
  for (const b of ['claude', 'codex', 'agy', 'vibe']) {
    const family = (a) => (a === 'antigravity' ? 'agy' : a);
    assert.ok(reviewersFor(b).length > 0, `${b} must have an eligible reviewer`);
    for (const r of reviewersFor(b)) {
      assert.notEqual(family(r), b, `${b} must not be eligible to review its own work`);
    }
  }
});

test('claude gets EVERY other family — the cost preference is about review, not coverage', () => {
  // Updated 2026-08-25: `vibe` (Mistral) joined the roster as a first-class cross-family reviewer.
  // It was already in review-route.mjs's CROSS_FAMILY_PREFERENCE and AGENT_FLAG, but not here — so
  // routing could name a reviewer this guard did not recognise as a builder. The assertion is still
  // "all families except the builder's own"; there is simply one more family.
  assert.deepEqual(reviewersFor('claude').sort(), ['antigravity', 'codex', 'vibe']);
});

test('vibe is a first-class family in BOTH directions', () => {
  // The gap this closes: vibe could REVIEW (cross-review.mjs accepted --agent vibe) but could not
  // BUILD (--builder vibe died as "unknown --builder"). The only way to review a vibe-built diff was
  // to misreport the builder, which disables the same-family guard entirely — the guard failing open
  // through a roster gap rather than a logic bug.
  assert.ok(BUILDER_FAMILIES.includes('vibe'), 'vibe must be a recognised builder family');
  assert.ok(reviewersFor('codex').includes('vibe'), 'vibe must be offered as a reviewer');
  // ...and it still cannot clear its own work.
  assert.ok(checkReviewerPairing('vibe', 'vibe'), 'vibe must not be able to review a vibe-built diff');
  assert.equal(checkReviewerPairing('vibe', 'codex'), null);
  assert.equal(checkReviewerPairing('vibe', 'antigravity'), null);
});

test('an UNKNOWN explicit builder is REFUSED, not treated as human', () => {
  // Cross-review (Codex, PR #38): unknown values fell through to the same "no constraint" branch as
  // an unstated builder, so `--builder codez --agent codex` — a typo — silently disabled the
  // same-family guard and produced a review indistinguishable from a valid one.
  const msg = checkReviewerPairing('codez', 'codex');
  assert.ok(msg, 'expected a refusal for an unknown builder');
  assert.match(msg, /unknown --builder/);
});

test('...but an OMITTED builder is still permitted — that is an honest "unstated"', () => {
  assert.equal(checkReviewerPairing('', 'codex'), null);
  assert.equal(checkReviewerPairing(undefined, 'codex'), null);
});

test('every declared builder family is accepted by the pairing check', () => {
  // Guards against BUILDER_FAMILIES and the pairing logic drifting apart: a family listed as valid
  // that the checker rejects would make the correct invocation the one that fails.
  for (const b of BUILDER_FAMILIES) {
    const eligible = reviewersFor(b);
    for (const r of eligible) {
      assert.equal(checkReviewerPairing(b, r), null, `${b} should permit reviewer ${r}`);
    }
  }
});
