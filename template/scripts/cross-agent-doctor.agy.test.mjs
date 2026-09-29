// agy-doctor — pure node:test for the drift-decision core + the pin-bump string transform.
//
// The doctor's I/O (spawning agy) is deliberately untested here (no agy in CI); what CI gates is the
// judgment — which observation pattern maps to which action, most severe first — and that --fix's file
// rewrite is anchored (throws rather than half-writes when the lib shape changed). The decision table
// mirrors the real incidents: the 1.0.10 silent-empty contract break ('contract-broken'), a model
// rename/retirement ('model-drift'), a clean self-update ('bump'), and the 2026-07-06 transient
// Gemini-quota blank the fallback absorbed ('quota-warn').
//
// Run: node --test 'scripts/cross-agent-doctor.agy.test.mjs'   (scripts-guard runs the full glob in CI).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideDoctorAction,
  bumpPinnedSource,
  parseAgyModelSlugs,
  isUpstreamUnavailable,
  isAgySignedOut,
} from './cross-agent-doctor.mjs';

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

test('agy 1.1.11 tabular model output is parsed by slug, not compared as a whole display row', () => {
  assert.deepEqual(
    parseAgyModelSlugs(
      'Fetching available models...\ngemini-3.6-flash-high\tGemini 3.6 Flash (High)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n'
    ),
    ['gemini-3.6-flash-high', 'gpt-oss-120b-medium']
  );
});

test('a tabular row may carry an alphabetic-only slug because the tab proves its structure', () => {
  assert.deepEqual(parseAgyModelSlugs('mistral\tMistral Base\n'), ['mistral']);
});

test('legacy bare model ids remain valid while status prose is never treated as a slug', () => {
  assert.deepEqual(parseAgyModelSlugs('gemini-3.6-flash-high\ngpt-oss-120b-medium\n'), [
    'gemini-3.6-flash-high',
    'gpt-oss-120b-medium',
  ]);
  assert.deepEqual(parseAgyModelSlugs('gemini-3.6-flash-high is unavailable\nSomething went wrong\n'), []);
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

// ── Provider capacity is not an interface break (2026-08-19) ────────────────────
// agy's GPT-OSS fallback started exiting 1 with "Our servers are experiencing high
// traffic right now, please try again in a minute." The probe called that 'error',
// 'error' means the CLI changed, and that verdict refuses to bump the pin — so one
// busy model took the whole review family offline. These pin the distinction.

test('isUpstreamUnavailable: the live message that caused the outage', () => {
  assert.equal(
    isUpstreamUnavailable(
      'Error: Our servers are experiencing high traffic right now, please try again in a minute.'
    ),
    true
  );
});

test('isUpstreamUnavailable: other provider-busy phrasings', () => {
  for (const msg of [
    'HTTP 429 Too Many Requests',
    'model overloaded',
    'rate limit exceeded',
    'service temporarily unavailable',
    '503 Service Unavailable',
  ]) {
    assert.equal(isUpstreamUnavailable(msg), true, msg);
  }
});

test('isUpstreamUnavailable: a REAL interface break is NOT swallowed', () => {
  // The negation is the whole safety of this guard. These also exit non-zero, and
  // every one of them must still reach 'error' and break the contract loudly.
  for (const msg of [
    'flags provided but not defined: -models',
    'Usage of agy:',
    'unknown model "gpt-oss-120b-low"',
    'Error: unknown flag --print',
    '',
  ]) {
    assert.equal(isUpstreamUnavailable(msg), false, JSON.stringify(msg));
  }
});

test('a busy FALLBACK no longer breaks the contract — the pin can still bump', () => {
  const d = decideDoctorAction({
    ...base,
    installed: '1.0.19',
    probes: { primary: 'ok', fallback: 'unavailable' },
  });
  assert.equal(d.action, 'bump');
  assert.match(d.notes.join(' '), /second quota pool/);
});

test('a busy PRIMARY is carried by the fallback, still not a contract break', () => {
  const d = decideDoctorAction({ ...base, probes: { primary: 'unavailable', fallback: 'ok' } });
  assert.equal(d.action, 'quota-warn');
});

test('but a version with NO working model is still never blessed', () => {
  for (const probes of [
    { primary: 'unavailable', fallback: 'unavailable' },
    { primary: 'empty', fallback: 'unavailable' },
    { primary: 'unavailable', fallback: 'empty' },
  ]) {
    assert.equal(decideDoctorAction({ ...base, installed: '1.0.19', probes }).action, 'contract-broken');
  }
});

test('a genuine probe error still outranks everything, both slots', () => {
  for (const probes of [
    { primary: 'error', fallback: 'unavailable' },
    { primary: 'unavailable', fallback: 'error' },
  ]) {
    assert.equal(decideDoctorAction({ ...base, installed: '1.0.19', probes }).action, 'contract-broken');
  }
});

// ── Signed out is could-not-look, never contract-broken (distribute-what-we-use S1, observed 2026-09-29) ──
test('isAgySignedOut: the real signed-out strings from agy 1.2.13', () => {
  assert.equal(
    isAgySignedOut(
      'Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n'
    ),
    true
  );
  assert.equal(
    isAgySignedOut('Waiting for authentication (timeout 60s)...\nError: authentication timed out.'),
    true
  );
  assert.equal(isAgySignedOut('gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n'), false);
  assert.equal(isAgySignedOut(''), false);
});

test('signed out outranks every contract verdict — it is an operator action, not a break', () => {
  const blind = {
    installed: '1.2.13',
    pinned: '1.2.12',
    helpOk: true,
    primaryListed: false,
    fallbackListed: false,
    probes: { primary: 'skipped', fallback: 'skipped' },
    signedOut: true,
  };
  assert.equal(decideDoctorAction(blind).action, 'signed-out');
  assert.equal(
    decideDoctorAction({ ...blind, signedOut: true, probes: { primary: 'error', fallback: 'error' } }).action,
    'signed-out'
  );
  assert.equal(
    decideDoctorAction({ ...blind, signedOut: false, probes: { primary: 'error', fallback: 'error' } })
      .action,
    'contract-broken'
  );
});

test('a help-contract break is reported as broken even while signed out (pr-reviewer S2 on #188)', () => {
  const base = {
    installed: '1.2.13',
    pinned: '1.2.12',
    primaryListed: false,
    fallbackListed: false,
    probes: { primary: 'skipped', fallback: 'skipped' },
    signedOut: true,
  };
  assert.equal(decideDoctorAction({ ...base, helpOk: false }).action, 'contract-broken');
  assert.equal(decideDoctorAction({ ...base, installed: null, helpOk: true }).action, 'contract-broken');
  assert.equal(decideDoctorAction({ ...base, helpOk: true }).action, 'signed-out');
});
