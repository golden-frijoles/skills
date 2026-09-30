// intent-reader.test.mjs — the optional reader at the lock: off costs nothing, every failure is one skip line
// (intent-match S2.3, D4, D16). No CLI and no network: spawn, Jev and the filesystem are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAMILIES, READER_PROMPT, askReader, isStructured, pickFamily, run } from './intent-reader.mjs';

const REPLY = `## Will build
- a scorer
## Won't build
- a dashboard
## First question
- who answers the close question?`;

const SEED = `---
slug: demo
intent_match: 80
---
# Pitch

## The ask, as given
> I want a score.

### Claims
1. A score.

## Intent match

<!-- intent-match: {"coverage_in":0.9,"coverage_out":0.8,"clarity":0.7,"teach_back":null,"total":80} -->
`;

const README = `---
status: in-progress
slug: demo
---

# Epic: demo

## Decisions
- D1 — build the scorer.
`;

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'intent-reader-'));
  mkdirSync(join(root, 'Roadmap', '09-platform-infra', 'demo'), { recursive: true });
  mkdirSync(join(root, 'Roadmap', '00-ideas', 'seeds'), { recursive: true });
  writeFileSync(join(root, 'Roadmap', '09-platform-infra', 'demo', 'README.md'), README);
  writeFileSync(join(root, 'Roadmap', '00-ideas', 'seeds', 'demo.md'), SEED);
  return root;
}

function makeIo(over = {}) {
  const root = over.root ?? fixtureRepo();
  const log = { out: [], spawned: [], asked: [], has: [] };
  const io = {
    root,
    setting: () => ('setting' in over ? over.setting : 'on'),
    config: () => ({ egress: 'egress' in over ? over.egress : true, model: 'jev-1.13.0' }),
    key: () => ('key' in over ? over.key : 'k'),
    secrets: over.secrets ?? (() => ({ leaks: [] })),
    has: (bin) => {
      log.has.push(bin);
      return (over.installed ?? ['codex', 'agy', 'vibe']).includes(bin);
    },
    spawn: (bin, args, opts) => {
      log.spawned.push({ bin, args, opts });
      return over.spawnResult ?? { status: 0, stdout: REPLY, stderr: '' };
    },
    ask: async (req) => {
      log.asked.push(req);
      return over.jev ?? { ok: true, answers: { agreement: { type: 'noul', noul: 0.8 } } };
    },
    read: (p) => readFileSync(p, 'utf8'),
    write: (p, t) => writeFileSync(p, t),
    out: (l) => log.out.push(l),
    today: '2026-09-29',
  };
  return { io, log, root, readme: join(root, 'Roadmap', '09-platform-infra', 'demo', 'README.md') };
}

const oneSkip = (log, re) => {
  assert.equal(log.out.length, 1, `exactly one line, got: ${JSON.stringify(log.out)}`);
  assert.match(log.out[0], /^reader skipped: /);
  assert.match(log.out[0], re);
};

// ── never Claude, and the order ──────────────────────────────────────────────────────────────────────────────

test('FAMILIES: codex, agy, vibe — in that order, and never Claude (D4)', () => {
  assert.deepEqual(
    FAMILIES.map((f) => f.id),
    ['codex', 'agy', 'vibe']
  );
  assert.ok(!FAMILIES.some((f) => /claude/i.test(`${f.id} ${f.bin}`)));
});

test('never Claude: with no reader installed, claude is not even looked for', async () => {
  const { io, log } = makeIo({ installed: ['claude'] });
  assert.equal(await run(['--epic', 'demo'], io), 0);
  oneSkip(log, /no reader CLI on PATH/);
  assert.ok(!log.has.includes('claude'));
  assert.equal(log.spawned.length, 0);
});

test('pickFamily: a missing binary is the only reason to move down the list', () => {
  assert.equal(pickFamily((b) => b === 'vibe').id, 'vibe');
  assert.equal(pickFamily((b) => b === 'agy' || b === 'vibe').id, 'agy');
  assert.equal(
    pickFamily(() => false),
    null
  );
});

// ── off costs nothing ────────────────────────────────────────────────────────────────────────────────────────

test('off (the default): one line, nothing read, spawned or asked', async () => {
  for (const setting of ['off', undefined, null]) {
    const { io, log } = makeIo({ setting });
    let read = 0;
    io.read = () => {
      read++;
      return '';
    };
    const t0 = Date.now();
    assert.equal(await run(['--epic', 'demo'], io), 0);
    assert.ok(Date.now() - t0 < 200, 'nothing waits');
    assert.equal(log.out.length, 1);
    assert.match(log.out[0], /^intent reader: off/);
    assert.deepEqual([read, log.spawned.length, log.asked.length, log.has.length], [0, 0, 0, 0]);
  }
});

// ── every skip path is one line and exit 0 ───────────────────────────────────────────────────────────────────

test('skip: a timeout is one line, and the deadline reached the spawn', async () => {
  const err = Object.assign(new Error('spawnSync codex ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const { io, log } = makeIo({ spawnResult: { error: err, status: null, stdout: '' } });
  assert.equal(await run(['--epic', 'demo', '--timeout', '5'], io), 0);
  oneSkip(log, /codex: timed out after 5s/);
  assert.equal(log.spawned[0].opts.timeout, 5000);
  assert.equal(log.asked.length, 0);
});

test('skip: a capped or logged-out CLI (non-zero exit) — no second family is tried', async () => {
  const { io, log } = makeIo({
    spawnResult: { status: 1, stdout: '', stderr: 'error: usage limit reached' },
  });
  assert.equal(await run(['--epic', 'demo'], io), 0);
  oneSkip(log, /codex: exited 1 — error: usage limit reached/);
  assert.equal(log.spawned.length, 1);
});

test('skip: an empty reply, and an unstructured one', async () => {
  const empty = makeIo({ spawnResult: { status: 0, stdout: '  \n', stderr: '' } });
  assert.equal(await run(['--epic', 'demo'], empty.io), 0);
  oneSkip(empty.log, /codex: empty reply/);
  const prose = makeIo({
    spawnResult: { status: 0, stdout: 'Looks fine to me, I would build it.', stderr: '' },
  });
  assert.equal(await run(['--epic', 'demo'], prose.io), 0);
  oneSkip(prose.log, /codex: unstructured reply/);
  assert.equal(prose.log.asked.length, 0, 'an unstructured reply is never sent to Jev');
});

test('skip: the CLI cannot start', async () => {
  const { io, log } = makeIo({ spawnResult: { error: new Error('spawn codex ENOENT'), status: null } });
  assert.equal(await run(['--epic', 'demo'], io), 0);
  oneSkip(log, /codex: could not start/);
});

test('skip: Jev cannot be asked — checked BEFORE any reader is spawned', async () => {
  for (const [over, re] of [
    [{ egress: null }, /jev\.egress is null/],
    [{ egress: false }, /jev\.egress is false/],
    [{ key: null }, /no TYPESAFE_API_KEY/],
  ]) {
    const { io, log } = makeIo(over);
    assert.equal(await run(['--epic', 'demo'], io), 0);
    oneSkip(log, re);
    assert.equal(log.spawned.length, 0, 'no reader time spent on an agreement nobody can score');
  }
});

test('skip: Jev could not look, or answered in the wrong shape — the README is untouched', async () => {
  for (const jev of [
    { ok: false, state: 'could-not-look', error: 'HTTP 429' },
    { ok: true, answers: { agreement: { type: 'noul', noul: '0.8' } } },
    { ok: true, answers: { agreement: { type: 'score', noul: 0.8 } } },
  ]) {
    const { io, log, readme } = makeIo({ jev });
    assert.equal(await run(['--epic', 'demo'], io), 0);
    oneSkip(log, /Jev could not look/);
    assert.equal(readFileSync(readme, 'utf8'), README);
  }
});

test('skip: no seed, or no epic', async () => {
  const noEpic = makeIo();
  assert.equal(await run(['--epic', 'nope'], noEpic.io), 0);
  oneSkip(noEpic.log, /no epic "nope"/);
  const root = fixtureRepo();
  writeFileSync(join(root, 'Roadmap', '00-ideas', 'seeds', 'demo.md'), '');
  const { io, log } = makeIo({ root });
  io.root = root;
  // an empty seed file still exists; remove it to exercise "no seed"
  const { rmSync } = await import('node:fs');
  rmSync(join(root, 'Roadmap', '00-ideas', 'seeds', 'demo.md'));
  assert.equal(await run(['--epic', 'demo'], io), 0);
  oneSkip(log, /no seed/);
});

test('usage errors are the only non-zero exit', async () => {
  const { io } = makeIo();
  assert.equal(await run([], io), 1);
  assert.equal(await run(['--epic', 'demo', '--timeout', '0'], io), 1);
  assert.equal(await run(['--epic', 'demo', '--bogus'], io), 1);
});

// ── the happy path ───────────────────────────────────────────────────────────────────────────────────────────

test('on: codex reads the pitch once, Jev scores agreement, and the README gets it with the new total', async () => {
  const { io, log, readme } = makeIo();
  assert.equal(await run(['--epic', 'demo'], io), 0);
  assert.equal(log.spawned.length, 1);
  assert.equal(log.spawned[0].bin, 'codex');
  assert.equal(log.spawned[0].opts.input, SEED, 'codex gets the pitch file on stdin, and nothing else');
  assert.ok(log.spawned[0].args.includes(READER_PROMPT));
  assert.ok(log.spawned[0].args.includes('read-only'), "the reader runs in codex's read-only sandbox");
  assert.deepEqual(Object.keys(log.asked[0].questions), ['agreement']);
  assert.equal(log.asked[0].state.reading, REPLY);
  const after = readFileSync(readme, 'utf8');
  // seed components 0.9, 0.8, 0.7 + agreement 0.8 → 80
  assert.match(after, /^intent_match: 80$/m);
  assert.match(after, /Agreement \(reader: codex, 2026-09-29\): \*\*0\.80\*\*/);
  assert.match(after, /Total with agreement: \*\*80 \/ 100\*\*/);
  assert.match(after, /<!-- intent-match: \{.*"agreement":0\.8,"total":80\} -->/);
  assert.match(after, /## Decisions\n- D1 — build the scorer\./, 'the plan itself is untouched');
  assert.equal(log.out.length, 1);
  assert.match(log.out[0], /codex read the pitch — agreement 0\.80; total 80 \(seed 80\)/);
  // A second run replaces the section rather than stacking another.
  await run(['--epic', 'demo'], io);
  assert.equal(readFileSync(readme, 'utf8').match(/^## Intent match/gm).length, 1);
});

test('agy and vibe get the prompt and pitch in argv, under their size limit', () => {
  const agy = FAMILIES.find((f) => f.id === 'agy');
  const calls = [];
  const spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { status: 0, stdout: REPLY };
  };
  assert.equal(askReader(agy, 'PITCH', { spawn, timeoutMs: 1000 }).ok, true);
  assert.equal(calls[0].bin, 'agy');
  assert.match(calls[0].args[1], /## First question[\s\S]*PITCH/);
  const vibe = FAMILIES.find((f) => f.id === 'vibe');
  const r = askReader(vibe, 'x'.repeat(300 * 1024), { spawn, timeoutMs: 1000 });
  assert.deepEqual(r.ok, false);
  assert.match(r.why, /over its 256 KB argument limit/);
  assert.equal(calls.length, 1, 'an oversize pitch is refused before spawning');
});

test('isStructured: the three headings, any heading level, either apostrophe', () => {
  assert.equal(isStructured(REPLY), true);
  assert.equal(isStructured(REPLY.replace("Won't", 'Won’t').replace(/## /g, '### ')), true);
  assert.equal(isStructured('## Will build\n- x\n## First question\n- y'), false);
});

// ── fresh review of #197 ─────────────────────────────────────────────────────────────────────────────────────

test('a reply carrying fences (``` or ~~~) and its own ## headings never escapes the section, run after run', async () => {
  const nasty = `## Will build\n- x\n~~~\n## Won't build\n\`\`\`\n- y\n## First question\n- z?`;
  const { io, readme } = makeIo({ spawnResult: { status: 0, stdout: nasty, stderr: '' } });
  await run(['--epic', 'demo'], io);
  await run(['--epic', 'demo'], io);
  await run(['--epic', 'demo'], io);
  const after = readFileSync(readme, 'utf8');
  assert.equal(after.match(/^## Intent match$/gm).length, 1);
  assert.equal(after.match(/^## /gm).length, 2, 'the only headings are Decisions and Intent match');
  assert.equal(after.match(/<!-- intent-match: /g).length, 1);
  assert.match(after, /^ {4}~~~$/m, 'the reply is kept, indented');
});

test('a secret-shaped reply is skipped before Jev is asked or anything is written', async () => {
  const { io, log, readme } = makeIo({
    secrets: () => ({ leaks: [{ kind: 'shape', name: 'a GitHub token' }] }),
  });
  assert.equal(await run(['--epic', 'demo'], io), 0);
  oneSkip(
    log,
    /codex: the reply carried secret-shaped text \(a GitHub token\); nothing sent, nothing written/
  );
  assert.equal(log.asked.length, 0);
  assert.equal(readFileSync(readme, 'utf8'), README);
});

test('the real secret guard is wired: a token-shaped reply from the CLI is caught', async () => {
  const { findSecretLeaks } = await import('./lib/secret-guard.mjs');
  const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
  const { io, log } = makeIo({
    spawnResult: { status: 0, stdout: `${REPLY}\n${token}`, stderr: '' },
    secrets: (t) => findSecretLeaks(t),
  });
  await run(['--epic', 'demo'], io);
  oneSkip(log, /secret-shaped text/);
});

test('a sub-second timeout is reported as given, and an oversize reply is not "could not start"', () => {
  const err = (code) => Object.assign(new Error(code), { code });
  const codex = FAMILIES[0];
  assert.match(
    askReader(codex, 'p', { spawn: () => ({ error: err('ETIMEDOUT') }), timeoutMs: 500 }).why,
    /timed out after 0\.5s/
  );
  assert.match(
    askReader(codex, 'p', { spawn: () => ({ error: err('ENOBUFS') }), timeoutMs: 500 }).why,
    /over 16 MB/
  );
});

test('an ODD fence line in a reply (a clip mid-code-block) never swallows the sections after it', async () => {
  for (const fence of ['```js', '~~~']) {
    const { io, readme } = makeIo({
      spawnResult: { status: 0, stdout: `${REPLY}\n${fence}\nconst x = 1;`, stderr: '' },
    });
    await run(['--epic', 'demo'], io);
    writeFileSync(readme, `${readFileSync(readme, 'utf8')}\n## Retrospective link\n\nkeep me\n`);
    await run(['--epic', 'demo'], io);
    const after = readFileSync(readme, 'utf8');
    assert.match(after, /## Retrospective link\n\nkeep me/, fence);
    assert.equal(after.match(/^## Intent match$/gm).length, 1, fence);
  }
});
