// Roster CONSISTENCY between the two modules that decide who reviews what.
//
// ── Why a separate file, and what is deliberately NOT here ───────────────────────────────────
// The pairing LOGIC — same-family refusal, unknown-builder refusal, case-insensitivity,
// `reviewersFor` never returning the builder's own family — is already covered, in
// `scripts/lib/transient-agy-error.test.mjs`. Nothing here repeats it; duplicated assertions are two
// things to update and one of them will be forgotten.
//
// What was NOT covered, and what this file exists for, is the seam BETWEEN the two rosters:
//
//   • `review-route.mjs`      decides who to ROUTE to      → PREFERENCE, BUILDERS
//   • `lib/cross-agent-cli.mjs` decides who may REVIEW what → BUILDER_FAMILIES, reviewersFor, AGENTS
//
// Those are two lists in two files that must agree, and on 2026-08-25 they did not: `vibe` had been
// a routable cross-family reviewer for some time while `BUILDER_FAMILIES` had never heard of it. The
// consequence was not a crash — it was `--builder vibe` dying as "unknown", so the only way to review
// a vibe-built diff was to misreport who wrote it, which disables the same-family guard completely.
// A safety check failing open through a roster gap rather than a logic bug is the harder kind to
// notice, because every individual module's own tests stay green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, BUILDER_FAMILIES, isTruncatedReview, reviewersFor } from './lib/cross-agent-cli.mjs';
// `PREFERENCE` was `CROSS_FAMILY_PREFERENCE` until the router collapsed (ways-of-work-lean-pass S2.5);
// the roster seam this file guards is unchanged — one list of who may review, one of who may build.
import { BUILDERS, PREFERENCE as CROSS_FAMILY_PREFERENCE } from './review-route.mjs';

/** The reviewer CLI name → the model family it belongs to. `antigravity` is agy's CLI name. */
const FAMILY_OF = { codex: 'codex', antigravity: 'agy', vibe: 'vibe', claude: 'claude' };

test('every routable cross-family reviewer is a builder family the guard recognises', () => {
  // THE REGRESSION THIS FILE WAS WRITTEN FOR.
  for (const family of CROSS_FAMILY_PREFERENCE) {
    assert.ok(
      BUILDER_FAMILIES.includes(family),
      `${family} is routable as a reviewer but is not a known builder family — ` +
        `\`--builder ${family}\` would be refused as unknown, and its diffs could only be reviewed ` +
        `by misreporting the builder, which disables the same-family guard`
    );
  }
});

test('every family that can BUILD is a family the pairing guard recognises', () => {
  for (const builder of BUILDERS) {
    assert.ok(
      BUILDER_FAMILIES.includes(builder),
      `${builder} can build but the pairing guard does not recognise it`
    );
  }
});

test('every reviewer the policy suggests is a real, invocable agent name', () => {
  // The suggestion is printed inside a refusal message, so a name `--agent` would reject sends the
  // reader in a circle: the tool tells you to run something the tool then declines to run.
  for (const builder of BUILDER_FAMILIES) {
    for (const suggested of reviewersFor(builder)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(AGENTS, suggested),
        `reviewersFor('${builder}') suggested '${suggested}', which is not a key of AGENTS — ` +
          `\`--agent ${suggested}\` would die as an unknown reviewer`
      );
    }
  }
});

test('every cross-family reviewer is reachable from at least one builder', () => {
  // A reviewer nobody is ever told to use is a reviewer that silently does not exist. `claude` is
  // excluded deliberately: it is the named escalation, not a default suggestion (see the cost note
  // on BUILDER_FAMILIES).
  const suggested = new Set(BUILDER_FAMILIES.flatMap((builder) => reviewersFor(builder)));
  for (const family of CROSS_FAMILY_PREFERENCE) {
    if (family === 'claude') continue;
    const agentName = Object.entries(FAMILY_OF).find(([, f]) => f === family)?.[0];
    assert.ok(
      agentName && suggested.has(agentName),
      `${family} is on the routing roster but is never suggested to any builder`
    );
  }
});

// ── A truncated review must never reach a PR ─────────────────────────────────────────────────
// On PR #121 vibe exhausted its turn budget mid-read and exited 0 with a bare tool call as its
// whole output. The runner's two guards — non-zero status, empty output — both passed, so it was
// posted, where it renders as a review that found nothing. That is worse than an empty result: an
// empty one looks wrong, a truncated one looks like a clean pass and silently drops a family from
// the gate on the exact PR it was supposed to review.

test('a bare tool call is recognised as a stopped review, not a clean pass', () => {
  assert.equal(isTruncatedReview('read_file{"file_path": "/x/y.ts", "offset": 180, "limit": 40}'), true);
  assert.equal(isTruncatedReview('grep{"pattern": "foo"}'), true);
});

test('prose with no findings section is a stopped review', () => {
  // The prompt REQUIRES a findings heading, so its absence means the model never got there.
  assert.equal(isTruncatedReview('I read the diff and it looks reasonable to me.'), true);
  assert.equal(isTruncatedReview(''), true);
});

test('a real review is NOT flagged — in either of the shapes the reviewers actually emit', () => {
  // Both forms are taken from reviews these agents have posted to this repo. Flagging either would
  // make the guard worse than the bug: it would reject genuine clean passes and stall every merge.
  assert.equal(isTruncatedReview('## Findings\n\n**Blocking**\n- None\n\n**Should-fix**\n- None'), false);
  assert.equal(
    isTruncatedReview('The diff is clean. No Blocking, Should-fix, or Nit findings were identified.'),
    false
  );
});

test('a review that found something real is never flagged', () => {
  assert.equal(
    isTruncatedReview('**Blocking**\n- `page.tsx` double-decodes the route param and 500s.'),
    false
  );
});
