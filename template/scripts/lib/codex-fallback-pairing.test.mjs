// The codex→agy self-heal must never become a same-family review (distribute-what-we-use D1).
//
// runWithCodexFallback changes the REVIEWING family when codex cannot run. cross-review's pairing guard
// checks the family the operator asked for (`--agent codex`), so without a second check a diff agy built
// could be cleared by agy after a lapsed codex token — a same-family pass wearing a cross-family label.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runWithCodexFallback,
  decideCodexFallback,
  codexModelFrom,
  codexExecArgs,
  isCodexCapped,
  isCodexModelUnavailable,
  isCodexOutdated,
} from './cross-agent-cli.mjs';

/** Deps where codex fails with `codex` and agy answers; `fail` throws so the test can see the message. */
function deps(codex) {
  const calls = [];
  return {
    calls,
    deps: {
      tryCodex: () => codex,
      runAntigravity: (argv) => {
        calls.push(argv);
        return 'agy findings';
      },
      hasCmd: () => true,
      fail: (msg) => {
        throw new Error(msg);
      },
      warn: () => {},
    },
  };
}
const LAPSED = {
  ok: false,
  text: '',
  authFailed: true,
  cliOutdated: false,
  contextOverflow: false,
  stderr: '401',
};
const STALE = {
  ok: false,
  text: '',
  authFailed: false,
  cliOutdated: true,
  contextOverflow: false,
  stderr: '',
};

test('an agy-built diff is never healed onto agy: the fallback fails loud instead', () => {
  const { calls, deps: d } = deps(LAPSED);
  assert.throws(
    () => runWithCodexFallback({ prompt: 'p', stdin: 's', antigravityArgv: 'a', builder: 'agy' }, d),
    /SAME-FAMILY/
  );
  assert.equal(calls.length, 0, 'agy must not even be invoked');
});

test('a claude-built diff still heals onto agy (a different family)', () => {
  const { calls, deps: d } = deps(LAPSED);
  const out = runWithCodexFallback({ prompt: 'p', stdin: 's', antigravityArgv: 'a', builder: 'claude' }, d);
  assert.deepEqual(out, { findings: 'agy findings', fellBack: true, from: 'codex', to: 'antigravity' });
  assert.equal(calls.length, 1);
});

test('an unstated builder keeps the old behaviour (heals)', () => {
  const { deps: d } = deps(LAPSED);
  assert.equal(runWithCodexFallback({ prompt: 'p', stdin: 's', antigravityArgv: 'a' }, d).fellBack, true);
});

test('a stale codex CLI heals like a lapsed token, and the message names the doctor', () => {
  let warned = '';
  const { deps: d } = deps(STALE);
  d.warn = (m) => (warned += m);
  assert.equal(runWithCodexFallback({ prompt: 'p', stdin: 's', antigravityArgv: 'a' }, d).fellBack, true);
  assert.match(warned, /cross-agent-doctor\.mjs codex/);
});

test('decideCodexFallback: the pairing refusal outranks the heal, never the overflow', () => {
  const base = { codexOk: false, authFailed: true, contextOverflow: false, agyAvailable: true };
  assert.equal(decideCodexFallback({ ...base, fallbackPairingError: 'x' }), 'fail-fallback-same-family');
  assert.equal(
    decideCodexFallback({ ...base, contextOverflow: true, fallbackPairingError: 'x' }),
    'fail-context-overflow'
  );
  assert.equal(
    decideCodexFallback({ ...base, agyAvailable: false, fallbackPairingError: 'x' }),
    'fail-both-dead'
  );
  assert.equal(decideCodexFallback(base), 'fallback');
});

test('CODEX_MODEL: unset is the pin, `default` is codex’s own default, anything else is used verbatim', () => {
  assert.equal(codexModelFrom(undefined), 'gpt-5.6-terra');
  assert.equal(codexModelFrom('  '), 'gpt-5.6-terra');
  assert.equal(codexModelFrom('default'), null);
  assert.equal(codexModelFrom('DEFAULT'), null);
  assert.equal(codexModelFrom('gpt-5.6-sol'), 'gpt-5.6-sol');
});

test('codex exec argv: locked down always; effort always; `default` drops only the model', () => {
  const lock = ['--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '--ephemeral'];
  assert.deepEqual(codexExecArgs('P', { model: 'm', effort: 'high' }), [
    'exec',
    ...lock,
    '--model',
    'm',
    '-c',
    'model_reasoning_effort=high',
    'P',
  ]);
  assert.deepEqual(codexExecArgs('P', { model: null, effort: 'high' }), [
    'exec',
    ...lock,
    '-c',
    'model_reasoning_effort=high',
    'P',
  ]);
  assert.ok(!codexExecArgs('P').includes('workspace-write'));
});

test('a usage cap heals onto agy like an auth lapse; a model refusal names CODEX_MODEL=default, a cap does not', () => {
  const CAPPED = {
    ok: false,
    text: '',
    authFailed: false,
    cliOutdated: false,
    capped: true,
    contextOverflow: false,
    stderr: '',
  };
  const { deps: d } = deps(CAPPED);
  assert.equal(runWithCodexFallback({ prompt: 'p', stdin: 's', antigravityArgv: 'a' }, d).fellBack, true);
  assert.equal(isCodexCapped("ERROR: You've hit your usage limit. To continue using Codex…"), true);
  assert.equal(
    isCodexModelUnavailable('model: gpt-5.6-terra\nERROR: something else'),
    false,
    'the banner is not a refusal'
  );
  assert.equal(
    isCodexModelUnavailable("The 'x' model is not supported when using Codex with a ChatGPT account."),
    true
  );
});

test('a codex too old for the lockdown flags is told to upgrade, not failed as non-auth', () => {
  assert.equal(isCodexOutdated("error: unexpected argument '--ignore-rules' found"), true);
  assert.equal(isCodexOutdated('error: something unrelated'), false);
});
