// review-route.test.mjs — the reviewer-selection rule. Pure; no gh, no CLIs.
//
// This replaces the four-row-table test from the two-pass era (ways-of-work-lean-pass S2.5/S2.8). What
// survives is the guard that actually erodes silently — a family reviewing its own diff still produces
// plausible output, so nothing fails when the routing degrades.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILDERS, PREFERENCE, planReview, renderPlan } from './review-route.mjs';

test('a family never reviews its own diff, whoever built it', () => {
  for (const builder of BUILDERS) {
    const plan = planReview({ builder });
    assert.notEqual(plan.general, builder, `${builder} was routed to review its own diff`);
    assert.equal(
      plan.general,
      PREFERENCE.find((f) => f !== builder)
    );
  }
});

test('exactly ONE general pass — the second cross-family pass is gone', () => {
  const plan = planReview({ builder: 'claude' });
  assert.equal(plan.general, 'codex');
  assert.equal(plan.security, null, 'no security lens unless the PR triggers it');
  const rendered = renderPlan(plan, 7, 'o/r');
  assert.equal(rendered.match(/cross-review\.mjs/g).length, 1);
  assert.match(rendered, /pr-reviewer subagent/);
});

test('the security lens takes a DIFFERENT family from the general pass', () => {
  const plan = planReview({ builder: 'claude', securityPass: true });
  assert.equal(plan.general, 'codex');
  assert.equal(plan.security, 'agy');
  assert.match(renderPlan(plan, 7, 'o/r'), /--agent antigravity --builder claude --lens security/);
});

test('a capped family falls to the next in the order — no refund ask, no waiting', () => {
  const plan = planReview({ builder: 'claude', available: ['vibe', 'claude'] });
  assert.equal(plan.general, 'vibe');
  assert.ok(
    plan.notes.every((n) => !/refund/i.test(n)),
    'the REFUND-ASK protocol is deleted'
  );
});

test('one family left runs both prompts and SAYS so — a short layer must be loud', () => {
  const plan = planReview({ builder: 'claude', available: ['codex'], securityPass: true });
  assert.equal(plan.general, 'codex');
  assert.equal(plan.security, 'codex');
  assert.ok(plan.notes.some((n) => /BOTH passes/.test(n) && /family independence is short/i.test(n)));
});

test('no family available is reported as DARK, never as a clean pass', () => {
  const plan = planReview({ builder: 'claude', available: [] });
  assert.equal(plan.general, null);
  assert.ok(plan.notes.some((n) => /DARK/.test(n)));
  assert.doesNotMatch(renderPlan(plan, 7, null), /--agent/);
});

test('the fresh reviewer is named on every plan — it is unconditional now, not HIGH-only', () => {
  for (const builder of BUILDERS) {
    assert.ok(planReview({ builder }).notes.some((n) => /pr-reviewer/.test(n)));
  }
});

test('--exclude routes past a capped family without any protocol', () => {
  // `hasCmd` cannot see a quota cap, so the fallback is operator-driven: one flag, next family.
  const plan = planReview({ builder: 'claude', available: PREFERENCE.filter((f) => f !== 'codex') });
  assert.equal(plan.general, 'agy');
});

test('an unknown builder throws rather than silently routing to the default family', () => {
  assert.throws(() => planReview({ builder: 'gemini' }), /unknown builder/);
});

test('every emitted command names the builder, so the pairing guard fires in normal use (#188 B3)', () => {
  const plan = planReview({ builder: 'agy', securityPass: true });
  const cmds = renderPlan(plan, 7, 'o/r')
    .split('\n')
    .filter((l) => l.includes('cross-review.mjs'));
  assert.equal(cmds.length, 2);
  for (const c of cmds) assert.match(c, /--builder agy\b/);
});
