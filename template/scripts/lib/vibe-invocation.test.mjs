// The vibe reviewer's INVOCATION contract.
//
// The reviewer must never be steerable into reading or writing anything on the host, and it must still
// see the code it reviews. Since distribute-what-we-use D1 (2026-09-29) both halves are met the same way
// every consumer meets them: every model-driven tool is disabled (`--disabled-tools '*'`, no
// `--auto-approve`), and cross-review embeds the diff plus the touched files' head-side contents in the
// prompt instead. The earlier read-only allow-list (`read_file`/`grep` + `--auto-approve`, 2026-08-07)
// was removed because vibe checks auto-approval BEFORE its sensitive-file and outside-workdir prompts, and
// `read_file` takes absolute paths — so a malicious diff could put `.env.local` into a posted comment.
//
// These tests pin the contract at the argv level, because that is where the guarantee lives.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runVibe, VIBE_READ_ONLY_TOOLS, VIBE_MAX_TURNS } from './cross-agent-cli.mjs';

/** Capture the argv runVibe would spawn, without running anything. */
function argvFor(prompt = 'review this') {
  let captured = null;
  const spawn = (_bin, args) => {
    captured = args;
    // A REVIEW-SHAPED placeholder, not the bare word 'findings'. These tests only inspect the argv
    // runVibe builds, but runVibe now rejects output that looks like a stopped-mid-review — a bare
    // tool call, or prose with no findings heading — so a stub must look like a real review or it
    // trips a guard it was never about. (Guard added after vibe truncated on PR #121 and the
    // runner posted the fragment as if it were a clean pass.)
    return { status: 0, stdout: '**Blocking**\n- None\n\n**Should-fix**\n- None', stderr: '' };
  };
  runVibe(prompt, {}, { spawn });
  return captured;
}

test('Vibe receives the bounded diff with every model-driven host tool disabled', () => {
  const args = argvFor();
  assert.ok(!args.includes('--auto-approve'), 'auto-approval bypasses Vibe sensitivity/workdir checks');
  assert.ok(
    !args.includes('--enabled-tools'),
    'no model-driven read or write tool is needed for an embedded diff'
  );
  assert.equal(args[args.indexOf('--disabled-tools') + 1], '*');
  assert.deepEqual([...VIBE_READ_ONLY_TOOLS], [], 'the exported toolset is the empty set');
});

test('the reviewer cannot write: no tool is ever enabled by name', () => {
  const args = argvFor();
  // vibe's full toolset: skill, task, web_fetch, bash, edit, grep, read_file, web_search, todo,
  // write_file. With `--disabled-tools '*'` none of them is reachable; none may reappear by name either.
  for (const tool of [
    'bash',
    'edit',
    'write_file',
    'task',
    'skill',
    'web_fetch',
    'web_search',
    'read_file',
    'grep',
  ]) {
    assert.ok(!args.includes(tool), `${tool} must never be named in the reviewer's argv`);
  }
});

test('--agent plan stays, as a second layer under the tool filter', () => {
  const args = argvFor();
  assert.equal(args[args.indexOf('--agent') + 1], 'plan');
});

test('the turn budget is high enough that a real review is not truncated', () => {
  // 4 was the value that produced "<vibe_stop_event>Turn limit of 4 reached</vibe_stop_event>" on
  // large diffs. 24 is the template's live-probed budget; with no tools, a turn cannot be wasted.
  assert.ok(Number(VIBE_MAX_TURNS) >= 24, `expected the live-probed budget, got ${VIBE_MAX_TURNS}`);
  assert.equal(argvFor()[argvFor().indexOf('--max-turns') + 1], String(VIBE_MAX_TURNS));
});

test('a turn-limit stop is reported as OUR budget, not as a quota cap', () => {
  // The distinction is the whole point of the message: quota means "wait or top up", a turn limit
  // means "raise the number". Reporting the first when it is the second sends someone to the wrong fix.
  const spawn = () => ({
    status: 1,
    stdout: '',
    stderr: '<vibe_stop_event>Turn limit of 4 reached</vibe_stop_event>',
  });
  // `fail(soft)` warns on stderr and returns null, so the message is captured there.
  const original = process.stderr.write.bind(process.stderr);
  let warned = '';
  process.stderr.write = (chunk) => {
    warned += chunk;
    return true;
  };
  try {
    assert.equal(runVibe('review this', { soft: true }, { spawn }), null);
  } finally {
    process.stderr.write = original;
  }
  assert.match(warned, /turns, not quota/i);
  assert.match(warned, /VIBE_MAX_TURNS/);
});

test('a disabled-tool request is not accepted as a completed review', () => {
  const spawn = () => ({
    status: 0,
    stdout: 'read_file{"path":"/tmp/private-file"}',
    stderr: '',
  });
  const original = process.stderr.write.bind(process.stderr);
  let warned = '';
  process.stderr.write = (chunk) => {
    warned += chunk;
    return true;
  };
  try {
    assert.equal(runVibe('review this', { soft: true }, { spawn }), null);
  } finally {
    process.stderr.write = original;
  }
  assert.match(warned, /requested a disabled tool/i);
  assert.match(warned, /no review was produced/i);
});
