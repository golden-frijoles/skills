// build-view.mod.test.ts — the mod under the engine (live-build-view S1, D6). `claude plugin test plugins/golden-frijoles`.
//
// build-view.test.mjs pins the decisions (the key, the overlap guard, the drift row) with node:test. This file pins the
// WIRING those specs cannot see: that session.start starts the 30 s tick, that a tick with an unchanged key does no
// work and a doc edit does, that a Bash call re-checks without holding up its result, that a push queues one online run,
// that every check stays offline, and that /build fills the prompt with the bundled kickoff (S2.4). The test's `on` stands in for the host beneath the plugin: it answers `$.process.run` and `$.fs.*`.
import type { On } from 'claude-code';
import { test, expect, mock } from 'claude-code/testing';

const ROOT = '/repo';
const PORCELAIN = `worktree ${ROOT}\nHEAD aaa\nbranch refs/heads/feat/live-build-view\n`;

type RunOverride = (argv: readonly string[]) => { exitCode: number; stdout: string } | null;

function world(on: On, override: RunOverride = () => null) {
  const ran: string[] = [];
  const logs: { text: string; to: string }[] = [];
  const state = { mtime: 1, porcelain: PORCELAIN };
  on('process.run', async (_$, e) => {
    const argv = e.argv.join(' ');
    ran.push(argv);
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } });
    const own = override(e.argv);
    if (own) return ok(own.stdout, own.exitCode);
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
  on('ui.log', async (_$, e) => {
    logs.push({ text: e.text, to: e.to });
    return { value: undefined };
  });
  const resolves = () => ran.filter((a) => a.includes('--json')).length;
  return { ran, state, resolves, logs };
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

test('healthy checks put nothing in the main window — their timings go to the debug log (2026-10-04)', async ($, on) => {
  const clock = mock.clock(on);
  mock.store(on);
  const w = world(on);
  on('tool.call', async () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: 'ok' }) as never);
  on('command.register', async (_$, e) => ({ value: { command: e.name } }) as never); // a real session registers /build
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: true } as never);
  await $.turn.start({ text: 'go', turnId: 't1' });
  w.state.mtime = 2;
  await clock.advance(30_000);
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never);
  await clock.settle();
  await $.turn.start({ text: 'again', turnId: 't2' });
  expect(w.logs.length).toBeGreaterThan(0); // the checks did log …
  expect(w.logs.filter((l) => l.to !== 'debug')).toEqual([]); // … and none of it reached the transcript
});

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

// ── S2.4: /build <slug> fills the prompt with the bundled generator's kickoff; nothing is sent ──────────────────────
function buildWorld(on: On, override: RunOverride) {
  const w = world(on, override);
  const filled: string[] = [];
  const registered: string[] = [];
  on('command.register', async (_$, e) => {
    registered.push(e.name);
    return { value: { command: e.name } } as never;
  });
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text);
    return { isFilled: true } as never;
  });
  return { ...w, filled, registered };
}

test('/build <slug>: registered at start; runs the bundled generator and fills the prompt', async ($, on) => {
  mock.clock(on);
  mock.store(on);
  const w = buildWorld(on, (argv) => (argv.includes('--epic') ? { exitCode: 0, stdout: 'Start by pushing the epic branch…\n' } : null));
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: true } as never);
  expect(w.registered).toContain('build');
  const out = await $.command.run({ command: 'build', args: 'live-build-view' } as never);
  expect(w.filled).toEqual(['Start by pushing the epic branch…']);
  expect(String(out.text)).toContain('press enter');
  const gen = w.ran.find((a) => a.includes('--epic')) ?? '';
  expect(gen).toContain('/skills/groom/emit-epic-kickoff.mjs --epic live-build-view --repo-root /repo');
});

test('/build with no slug or an unknown one lists the epics and fills nothing', async ($, on) => {
  mock.clock(on);
  mock.store(on);
  const w = buildWorld(on, (argv) =>
    argv.includes('--list')
      ? { exitCode: 0, stdout: 'live-build-view  Live build view  (in-progress, #55)\n' }
      : argv.includes('--epic')
        ? { exitCode: 1, stdout: '' }
        : null
  );
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: true } as never);
  const none = await $.command.run({ command: 'build', args: '' } as never);
  expect(String(none.text)).toContain('live-build-view  Live build view');
  const unknown = await $.command.run({ command: 'build', args: 'nope' } as never);
  expect(String(unknown.text)).toContain('no epic "nope"');
  const flag = await $.command.run({ command: 'build', args: '--list' } as never);
  expect(String(flag.text)).toContain('is not an epic slug');
  expect(w.filled).toEqual([]);
});
