// build-view.mod.test.ts — the mod under the engine (live-build-view S1, D6). `claude plugin test plugins/golden-frijoles`.
//
// build-view.test.mjs pins the decisions (the key, the overlap guard, the drift row) with node:test. This file pins the
// WIRING those specs cannot see: that session.start starts the 30 s tick, that a tick with an unchanged key does no
// work and a doc edit does, that a Bash call re-checks without holding up its result, that a push queues one online run,
// and that every check stays offline. The test's `on` stands in for the host beneath the plugin: it answers `$.process.run` and `$.fs.*`.
import type { On } from 'claude-code';
import { test, expect, mock } from 'claude-code/testing';

const ROOT = '/repo';
const PORCELAIN = `worktree ${ROOT}\nHEAD aaa\nbranch refs/heads/feat/live-build-view\n`;

function world(on: On) {
  const ran: string[] = [];
  const state = { mtime: 1, porcelain: PORCELAIN };
  on('process.run', async (_$, e) => {
    const argv = e.argv.join(' ');
    ran.push(argv);
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } });
    if (e.argv[1] === 'rev-parse') return ok(`aaa\nfeat/live-build-view\n${ROOT}\n`);
    if (e.argv.includes('worktree')) return ok(state.porcelain);
    if (e.argv.includes('--json')) return ok(JSON.stringify({ facts_mode: 'live', lines: ['Currently building', '  Status   Building'] }));
    return ok('');
  });
  on('fs.list', async (_$, e) => ({
    value: e.path === `${ROOT}/Roadmap` ? [{ name: 'README.md', kind: 'file', size: 1, mtimeMs: state.mtime, isLink: false }] : [],
  }));
  on('fs.exists', async () => ({ value: false }));
  // The engine's own events, answered as a session's would be (nothing beneath a test answers them).
  on('session.start', async (_$, e) => ({ cwd: e.cwd }));
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }));
  on('ui.log', async () => ({ value: undefined }));
  const resolves = () => ran.filter((a) => a.includes('--json')).length;
  return { ran, state, resolves };
}

const offline = (w: { ran: string[] }) => w.ran.filter((a) => a.includes('--json') && a.includes('--offline')).length;

// Ticks land at 30 s and 60 s; the online refresh also lands at 60 s, so each case reads ONE tick before it.
for (const edit of [false, true]) {
  test(`the 30 s tick: ${edit ? 'a doc edit re-resolves' : 'an unchanged key does no work'}`, async ($, on) => {
    const clock = mock.clock(on);
    mock.store(on);
    const w = world(on);
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: true } as never);
    await $.turn.start({ text: 'go', turnId: 't1' });
    expect(offline(w)).toBe(1);
    if (edit) w.state.mtime = 2; // somebody edited an epic doc mid-turn
    await clock.advance(30_000);
    expect(offline(w)).toBe(edit ? 2 : 1);
  });
}

test('a Bash call re-checks mid-turn without holding up its result; a push queues one online run', async ($, on) => {
  const clock = mock.clock(on);
  mock.store(on);
  const w = world(on);
  on('tool.call', async () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: 'ok' }) as never);
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: true } as never);
  await $.turn.start({ text: 'go', turnId: 't1' });
  w.state.porcelain = PORCELAIN.replace('HEAD aaa', 'HEAD bbb'); // the agent committed
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat(x): S1.1 y"' } as never);
  expect(offline(w)).toBe(1); // the call returned before any re-check ran
  await clock.settle();
  expect(offline(w)).toBe(2);
  const online = () => w.ran.filter((a) => a.includes('--json') && !a.includes('--offline')).length;
  await $.tool.call({ tool: 'Bash', command: 'git push -u origin feat/live-build-view' } as never);
  await clock.settle();
  expect(online()).toBe(1);
  await $.tool.call({ tool: 'Bash', command: 'git status' } as never);
  await clock.settle();
  expect(online()).toBe(1);
});

test('the online refresh waits a minute, runs without --offline, and repeats every five', async ($, on) => {
  const clock = mock.clock(on);
  mock.store(on);
  const w = world(on);
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: true } as never);
  await $.turn.start({ text: 'go', turnId: 't1' });
  const online = () => w.ran.filter((a) => a.includes('--json') && !a.includes('--offline')).length;
  await clock.advance(59_000);
  expect(online()).toBe(0);
  await clock.advance(1_000);
  expect(online()).toBe(1);
  await clock.advance(300_000);
  expect(online()).toBe(2);
});
