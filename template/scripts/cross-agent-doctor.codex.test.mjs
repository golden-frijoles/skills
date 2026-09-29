// cross-agent-doctor.codex.test.mjs — pure node:test for the decision core + remediation (no real codex, no network).
// The I/O half (observe/main) is a thin spawnSync wrapper, exercised live by running the script; the
// classification + remediation logic is what carries the correctness, so that's what's tested here.
// isMain-guarded per LEARNINGS, so importing the module doesn't execute the CLI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideCodexDoctorAction, remediation } from './cross-agent-doctor.mjs';

test('decideCodexDoctorAction: missing binary short-circuits before any probe', () => {
  assert.equal(decideCodexDoctorAction({ present: false, probe: 'skipped' }).action, 'missing');
});

test('decideCodexDoctorAction: a green probe is ok', () => {
  assert.equal(decideCodexDoctorAction({ present: true, probe: 'ok' }).action, 'ok');
});

test('decideCodexDoctorAction: the three failing probe classes map 1:1', () => {
  assert.equal(decideCodexDoctorAction({ present: true, probe: 'auth' }).action, 'auth-lapsed');
  assert.equal(decideCodexDoctorAction({ present: true, probe: 'outdated' }).action, 'cli-outdated');
  assert.equal(decideCodexDoctorAction({ present: true, probe: 'error' }).action, 'broken');
});

test('remediation: ok → null; every failing action names a concrete fix', () => {
  assert.equal(remediation('ok'), null);
  assert.match(remediation('missing'), /npm install .*codex|codex login/);
  assert.match(remediation('auth-lapsed'), /codex login/);
  assert.match(remediation('broken'), /non-auth, non-stale/i);
});

test('remediation: cli-outdated offers BOTH the upgrade and the CODEX_MODEL stopgap, and reflects the current env', () => {
  const withModel = remediation('cli-outdated', { codexModel: 'gpt-5-codex' });
  assert.match(withModel, /npm install -g @openai\/codex@latest/);
  assert.match(withModel, /CODEX_MODEL="gpt-5-codex"/); // reflects the set value
  const unset = remediation('cli-outdated', {});
  assert.match(unset, /CODEX_MODEL \(unset/); // names the escape hatch even when off
});

test('a usage cap is its own diagnosis, with the route-past remediation (cross-review on #188)', () => {
  const d = decideCodexDoctorAction({ present: true, probe: 'capped' });
  assert.equal(d.action, 'capped');
  assert.match(remediation('capped'), /--exclude codex/);
});
