// agy-doctor — pure node:test for the drift-decision core + the pin-bump string transform.
//
// The doctor's I/O (spawning agy) is deliberately untested here (no agy in CI); what CI gates is the
// judgment — which observation pattern maps to which action, most severe first — and that --fix's file
// rewrite is anchored (throws rather than half-writes when the lib shape changed). The decision table
// mirrors the real incidents: the 1.0.10 silent-empty contract break ('contract-broken'), a model
// rename/retirement ('model-drift'), a clean self-update ('bump'), and the 2026-07-06 transient
// Gemini-quota blank the fallback absorbed ('quota-warn').
//
// Run: node --test 'scripts/agy-doctor.test.mjs'   (scripts-guard runs the full glob in CI).

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideDoctorAction, bumpPinnedSource, parseModelList } from './agy-doctor.mjs';

const base = {
  installed: '1.0.16',
  pinned: '1.0.16',
  helpOk: true,
  primaryListed: true,
  fallbackListed: true,
  probes: { primary: 'ok', fallback: 'ok' },
};

test('ok: version matches, contract green, probes green', () => {
  assert.equal(decideDoctorAction(base).action, 'ok');
});

test('bump: version drift with a fully green contract probe', () => {
  const d = decideDoctorAction({ ...base, installed: '1.0.19' });
  assert.equal(d.action, 'bump');
  assert.equal(d.notes.length, 0);
});

test('bump: still blessed when only the primary is quota-empty (fallback carried it), with a note', () => {
  const d = decideDoctorAction({
    ...base,
    installed: '1.0.19',
    probes: { primary: 'empty', fallback: 'ok' },
  });
  assert.equal(d.action, 'bump');
  assert.equal(d.notes.length, 1);
});

test('quota-warn: pinned version, primary empty, fallback ok — informational, not drift', () => {
  const d = decideDoctorAction({ ...base, probes: { primary: 'empty', fallback: 'ok' } });
  assert.equal(d.action, 'quota-warn');
});

test('contract-broken beats everything: help contract gone', () => {
  const d = decideDoctorAction({ ...base, installed: '1.0.19', helpOk: false, primaryListed: false });
  assert.equal(d.action, 'contract-broken');
});

test('contract-broken: a probe ERROR is an interface break, never blessed and never treated as quota', () => {
  for (const probes of [
    { primary: 'error', fallback: 'ok' },
    { primary: 'ok', fallback: 'error' },
  ]) {
    assert.equal(decideDoctorAction({ ...base, installed: '1.0.19', probes }).action, 'contract-broken');
  }
});

test('contract-broken: BOTH models empty — a version this blind cannot be bumped', () => {
  const d = decideDoctorAction({
    ...base,
    installed: '1.0.19',
    probes: { primary: 'empty', fallback: 'empty' },
  });
  assert.equal(d.action, 'contract-broken');
});

test('contract-broken: unparseable installed version (null) is never blessed as a bump', () => {
  const d = decideDoctorAction({ ...base, installed: null });
  assert.equal(d.action, 'contract-broken');
});

test('model-drift: a missing pinned model is reported, outranked only by a broken contract', () => {
  assert.equal(decideDoctorAction({ ...base, primaryListed: false }).action, 'model-drift');
  assert.equal(
    decideDoctorAction({ ...base, installed: '1.0.19', fallbackListed: false }).action,
    'model-drift'
  );
  // …and a version bump must NOT be blessed while a model is missing:
  const d = decideDoctorAction({ ...base, installed: '1.0.19', primaryListed: false });
  assert.notEqual(d.action, 'bump');
});

test('model-drift: every configured model is reported, not just the review pair', () => {
  // The whole reason unlistedModels exists: prose-draft's constants rotted to invalid names for a
  // release cycle while the review pair stayed valid, so this function reported "ok".
  const d = decideDoctorAction({
    ...base,
    unlistedModels: [{ constant: 'PROSE_MODEL', value: 'Gemini 3.5 Flash (High)' }],
  });
  assert.equal(d.action, 'model-drift');
  assert.match(d.notes[0], /PROSE_MODEL \("Gemini 3\.5 Flash \(High\)"\)/);
  // The note must explain WHY an unlisted name is dangerous rather than merely listing it — agy
  // substitutes a default silently, so "unlisted" means "has been running on the wrong model".
  assert.match(d.notes[0], /silently substitutes/i);
});

test('model-drift: a drifted review-pair model keeps the offending model NAME in the note', () => {
  // Regression for a defect cross-review caught on PR #24. Both the bare `primaryListed` flag and
  // the descriptive unlistedModels entry describe the SAME constant; de-duping by name kept the
  // bare one because it happened to be first in the array, discarding the only actionable detail —
  // which model to replace. The descriptive entry must win regardless of source ordering.
  const d = decideDoctorAction({
    ...base,
    primaryListed: false,
    unlistedModels: [{ constant: 'AGY_MODEL', value: 'gemini-9.9-imaginary' }],
  });
  assert.equal(d.action, 'model-drift');
  assert.match(d.notes[0], /AGY_MODEL \("gemini-9\.9-imaginary"\)/);
  // And exactly once — not "AGY_MODEL and AGY_MODEL (...)".
  assert.equal(d.notes[0].match(/AGY_MODEL/g).length, 1);
});

// ── bumpPinnedSource: anchored rewrite of the real lib shape ──────────────────────────────────────
const LIB_SHAPE = `// prose above
// agy-doctor: last verified 2026-07-03 against 1.0.16.
//   ^ machine-managed marker
export const AGY_PINNED = '1.0.16';
// prose below
`;

test('bumpPinnedSource rewrites BOTH the constant and the marker, nothing else', () => {
  const out = bumpPinnedSource(LIB_SHAPE, '1.0.19', '2026-07-10');
  assert.match(out, /export const AGY_PINNED = '1\.0\.19';/);
  assert.match(out, /\/\/ agy-doctor: last verified 2026-07-10 against 1\.0\.19\./);
  assert.ok(!out.includes('1.0.16'), 'no stale version string left behind');
  assert.ok(out.includes('// prose above') && out.includes('// prose below'), 'surrounding prose untouched');
});

test('bumpPinnedSource THROWS (never half-writes) when an anchor is missing', () => {
  assert.throws(
    () => bumpPinnedSource("export const AGY_PINNED = '1.0.16';\n", '1.0.19', '2026-07-10'),
    /marker line not found/
  );
  assert.throws(
    () =>
      bumpPinnedSource('// agy-doctor: last verified 2026-07-03 against 1.0.16.\n', '1.0.19', '2026-07-10'),
    /constant line not found/
  );
});

test('bumpPinnedSource round-trips against the REAL lib source (anchors exist exactly once)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const lib = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'lib', 'cross-agent-cli.mjs'),
    'utf8'
  );
  const out = bumpPinnedSource(lib, '9.9.9', '2099-01-01');
  assert.match(out, /export const AGY_PINNED = '9\.9\.9';/);
  assert.match(out, /agy-doctor: last verified 2099-01-01 against 9\.9\.9\./);
});

// ── `agy models` output format ────────────────────────────────────────────────────────────────
// Pinned by a test because getting this wrong fails CLOSED on the gate that decides whether the
// cross-agent review layer may run at all. agy 1.1.11 added a human-readable label column and a
// "Fetching…" preamble; the previous parser kept whole lines, matched nothing, and reported every
// configured model as NOT LISTED while `agy models` was listing all of them.

test('parseModelList: the 1.1.11 tab-separated format, preamble dropped', () => {
  const raw = [
    'Fetching available models...',
    'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
    '',
  ].join('\n');
  assert.deepEqual(parseModelList(raw), [
    'gemini-3.6-flash-high',
    'gpt-oss-120b-medium',
    'claude-opus-4-6-thinking',
  ]);
});

test('parseModelList: the older bare-id format still parses', () => {
  assert.deepEqual(parseModelList('gemini-3.6-flash-high\nclaude-sonnet-4-6\n'), [
    'gemini-3.6-flash-high',
    'claude-sonnet-4-6',
  ]);
});

test('parseModelList: prose is never mistaken for a model id', () => {
  // The bug this replaced went the other way — everything was junk. Guard the opposite direction
  // too: a preamble word must not become a model that then "matches" nothing downstream.
  assert.deepEqual(parseModelList('Fetching available models...\n\nSomething went wrong\n'), []);
  assert.deepEqual(parseModelList(''), []);
  assert.deepEqual(parseModelList(null), []);
});
