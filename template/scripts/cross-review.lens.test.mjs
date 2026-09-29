// cross-review.lens.test.mjs — the security lens and the model attribution.
//
// These functions became testable only because this sprint added the isMain guard: cross-review.mjs
// used to call main() unconditionally, so importing it ran a review.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promptPathFor, resolveReviewModel, buildComment, LENSES } from './cross-review.mjs';

// ---- prompt selection ----

test('no lens keeps the default prompt — the mandatory rail is untouched', () => {
  assert.ok(promptPathFor(null).endsWith('cross-review.prompt.md'));
});

test('--lens security selects the security prompt', () => {
  assert.ok(promptPathFor('security').endsWith('cross-review.security.prompt.md'));
});

test('an unknown lens is rejected rather than silently falling back to the default', () => {
  // Silently defaulting would run a GENERAL review while the operator believed a security pass ran —
  // the worst possible outcome for a security tool.
  assert.throws(() => promptPathFor('sekurity'));
});

test('LENSES is the single source of valid values', () => {
  assert.deepEqual(LENSES, ['security']);
});

// ---- model attribution ----
//
// The reviewer model is machine-local state no artifact recorded; if it drifts, review strength changes
// family and nothing notices. Adopted from a consuming project, where an unset CODEX_MODEL meant "read
// ~/.codex/config.toml". In the superset (distribute-what-we-use D1) unset means the PIN, because that is
// what execCodex actually passes; `CODEX_MODEL=default` means codex's built-in default, because reviews ignore
// the user config — so the config file is never read for attribution.

test('CODEX_MODEL wins when set, with the effort execCodex passes alongside it', () => {
  assert.equal(
    resolveReviewModel('codex', false, { env: { CODEX_MODEL: 'gpt-5.6-sol' } }),
    'gpt-5.6-sol (effort: high)'
  );
});

test('unset CODEX_MODEL is attributed to the pin, not to whatever the local config says', () => {
  const cfg = 'model = "something-else"\n';
  assert.match(resolveReviewModel('codex', false, { env: {}, readCfg: () => cfg }), /^gpt-5\.6-terra /);
});

test("CODEX_MODEL=default is attributed to codex's BUILT-IN default — the review ignores the user config", () => {
  // Reviews run --ignore-user-config, so ~/.codex/config.toml's model is not what ran; naming it would be
  // the false attribution this file exists to prevent (pr-reviewer round 3 on #188).
  const cfg = 'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "xhigh"\n';
  const got = resolveReviewModel('codex', false, { env: { CODEX_MODEL: 'default' }, readCfg: () => cfg });
  assert.match(got, /built-in default/);
  assert.doesNotMatch(got, /luna|xhigh/);
});

test('a fallback run is attributed to agy, naming the model that actually answered', () => {
  // The whole point of recording this: nobody should read an Antigravity review as a Codex one.
  assert.match(resolveReviewModel('codex', true, { env: {} }), /^agy /);
  assert.equal(
    resolveReviewModel('codex', true, { env: {}, usedAgyModel: 'gpt-oss-120b-medium' }),
    'agy gpt-oss-120b-medium'
  );
});

test('a Vibe run is never attributed to the Codex model', () => {
  assert.equal(
    resolveReviewModel('vibe', false, {
      env: { CODEX_MODEL: 'gpt-5.6-sol', VIBE_ACTIVE_MODEL: 'devstral-medium' },
    }),
    'devstral-medium'
  );
  assert.equal(
    resolveReviewModel('vibe', false, { env: { CODEX_MODEL: 'gpt-5.6-sol' } }),
    'vibe configured default'
  );
});

// ---- the comment ----

test('a security-lens comment is labelled as one and states its limits inline', () => {
  const body = buildComment('Codex', 'no findings', false, { lens: 'security', model: 'gpt-5.6-terra' });
  assert.match(body, /security lens/i);
  assert.match(body, /not\*\* static analysis/i);
  assert.match(body, /not a security guarantee/i);
});

test('the comment names the model that actually ran', () => {
  assert.match(
    buildComment('Codex', 'x', false, { model: 'gpt-5.6-terra (effort: high)' }),
    /gpt-5\.6-terra \(effort: high\)/
  );
});

test('an unresolved model says so rather than printing a plausible default', () => {
  assert.match(buildComment('Codex', 'x', false, { model: null }), /unrecorded/);
});

test('a non-lens comment carries no security disclaimer and keeps the original title', () => {
  const body = buildComment('Codex', 'x', false, { model: 'm' });
  assert.match(body, /### 🔎 Cross-agent review/);
  assert.doesNotMatch(body, /security guarantee/);
});

test('a fallback is still unmistakable in the header, lens or not', () => {
  assert.match(buildComment('Codex', 'x', true, { lens: 'security', model: 'm' }), /Codex unavailable/);
});
