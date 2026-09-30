// semantic-lint.test.mjs — the selector, the four outcomes and the CLI, with a replay `ask` (no key, no network, no git).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HUNK_CHAR_LIMIT,
  MAX_CANDIDATES,
  judgeAll,
  judgeCandidate,
  outcomeOf,
  parseArgs,
  parseDiff,
  parseLintRules,
  questionHash,
  run,
  selectCandidates,
  summarize,
} from './semantic-lint.mjs';
import { parseJevConfig } from './lib/jev.mjs';

const RULE = {
  id: 'rule-1',
  source: 'AGENTS.md rule 1',
  severity: 'should-fix',
  globs: ['apps/web/**'],
  allowlist: ['apps/web/app/api/v1/track/route.ts', 'apps/web/e2e/**'],
  patterns: ['\\banalytics\\s*\\.', '\\.from\\(\\s*[\'"]events[\'"]'],
  question: {
    instructions: 'Does this hunk build a parallel telemetry pipeline?',
    criteria: { true: 'Yes', false: 'No' },
  },
};
const rules = (over = {}) => parseLintRules({ rules: [{ ...RULE, ...over }] });

const diffOf = (file, added, { removed = [], context = [] } = {}) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,2 +1,3 @@',
    ...context.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join('\n');

const VIOLATION = diffOf('apps/web/app/api/x/route.ts', ["analytics.track('x')"], { context: ['export {}'] });

// ── the rules parser ────────────────────────────────────────────────────────────────────────────

test('no lint section is no rules; a section without rules is no rules', () => {
  assert.deepEqual(parseLintRules(null), []);
  assert.deepEqual(parseLintRules({ $comment: 'x' }), []);
});

test('a malformed rule fails loud, naming it — a typo must never read as a clean push', () => {
  const bad = [
    [{ rules: [{ ...RULE, patterns: ['(unclosed'] }] }, /not a valid RegExp/],
    [{ rules: [RULE, RULE] }, /duplicate id/],
    [{ rules: [{ ...RULE, id: 'default' }] }, /id must be/],
    [{ rules: [{ ...RULE, id: 'Rule 1' }] }, /id must be/],
    [{ rules: [{ ...RULE, severity: 'high' }] }, /severity/],
    [{ rules: [{ ...RULE, globs: [] }] }, /globs must not be empty/],
    [{ rules: [{ ...RULE, pattern: ['x'] }] }, /unknown key\(s\): pattern/],
    [{ rules: [{ ...RULE, question: { instructions: 'x' } }] }, /question must be/],
    [{ rules: [{ ...RULE, source: '' }] }, /source/],
    [{ rule: [] }, /unknown key\(s\): rule/],
    [{ rules: {} }, /rules must be an array/],
  ];
  for (const [raw, re] of bad) assert.throws(() => parseLintRules(raw), re);
});

test('the question hash moves when a word of the question moves', () => {
  const [a] = rules();
  const [b] = rules({ question: { ...RULE.question, instructions: `${RULE.question.instructions} ` } });
  assert.notEqual(questionHash(a), questionHash(b));
  assert.equal(questionHash(a), questionHash(rules()[0]));
  assert.notEqual(
    questionHash(a),
    questionHash(rules({ source: 'AGENTS.md rule 2' })[0]),
    'source is sent, so it is hashed'
  );
});

// ── the diff and the selector ───────────────────────────────────────────────────────────────────

test('parseDiff: added lines per hunk; a deleted file adds nothing; `++ ` content is not a file header', () => {
  const text = [
    diffOf('apps/web/a.ts', ['++ weird', 'analytics.track(1)']),
    'diff --git a/gone.ts b/gone.ts',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-analytics.track(2)',
  ].join('\n');
  const files = parseDiff(text);
  assert.deepEqual(
    files.map((f) => f.file),
    ['apps/web/a.ts']
  );
  assert.deepEqual(files[0].hunks[0].added, ['++ weird', 'analytics.track(1)']);
  assert.equal(files[0].hunks[0].header, '@@ -1,2 +1,3 @@');
  assert.deepEqual(files[0].hunks[0].lines, ['+++ weird', '+analytics.track(1)']);
});

test('candidateText: the header plus a window around each hit, merged, gaps marked — never the whole new file', () => {
  const body = Array.from({ length: 100 }, (_, i) =>
    i === 10 || i === 20 || i === 90 ? `analytics.track(${i})` : `line ${i}`
  );
  const [c] = selectCandidates(parseDiff(diffOf('apps/web/new.ts', body)), rules());
  const lines = c.hunk.split('\n');
  assert.equal(lines[0], '@@ -1,2 +1,3 @@');
  // 10 and 20 share one window (0…35); 90 has its own (75…99); the gap between them is one `…`.
  assert.deepEqual(lines.slice(1, 3), ['+line 0', '+line 1']);
  assert.equal(lines.filter((l) => l === '…').length, 1);
  assert.ok(lines.includes('+line 35') && !lines.includes('+line 36') && lines.includes('+line 75'));
  assert.equal(lines.at(-1), '+line 99');
  assert.equal(lines.length, 1 + 36 + 1 + 25);
});

test('the selector picks an added match in a globbed file, once per hunk', () => {
  const c = selectCandidates(parseDiff(`${VIOLATION}\n${VIOLATION}`), rules());
  assert.equal(c.length, 1, 'the same hunk through two pushed refs is one candidate');
  assert.equal(c[0].file, 'apps/web/app/api/x/route.ts');
  assert.deepEqual(c[0].hits, ['\\banalytics\\s*\\.']);
});

test('the allowlist, the globs and removed/context lines never select', () => {
  const none = [
    diffOf('apps/web/app/api/v1/track/route.ts', ["analytics.track('x')"]), // allowlisted file
    diffOf('apps/web/e2e/funnel.spec.ts', [".from('events').insert(row)"]), // allowlisted glob
    diffOf('packages/sdk/src/index.ts', ["analytics.track('x')"]), // outside the globs
    diffOf('apps/web/lib/a.ts', ['const x = 1'], {
      removed: ["analytics.track('x')"],
      context: ["analytics.track('y')"],
    }),
  ];
  for (const d of none) assert.deepEqual(selectCandidates(parseDiff(d), rules()), [], d.split('\n')[0]);
});

// ── the four outcomes ───────────────────────────────────────────────────────────────────────────

test('outcomeOf: one threshold, three bands; only a probability is a verdict', () => {
  assert.equal(outcomeOf(0.8, 0.8), 'raise');
  assert.equal(outcomeOf(0.79, 0.8), 'uncertain');
  assert.equal(outcomeOf(0.2, 0.8), 'clear');
  assert.equal(outcomeOf(0.21, 0.8), 'uncertain');
  for (const bad of [true, '1', null, undefined, 1.2, -0.1, Number.NaN])
    assert.equal(outcomeOf(bad, 0.8), null);
});

const answer = (noul) => async () => ({ ok: true, answers: { violates: { noul } } });

test('judgeCandidate: could-not-look and a non-probability are NOT CHECKED, never clear', async () => {
  const [c] = selectCandidates(parseDiff(VIOLATION), rules());
  const down = await judgeCandidate(c, {
    ask: async () => ({ ok: false, error: 'timeout after 8000ms' }),
    threshold: 0.8,
  });
  assert.deepEqual(down, { outcome: 'not-checked', p: null, error: 'timeout after 8000ms' });
  const junk = await judgeCandidate(c, { ask: answer(true), threshold: 0.8 });
  assert.equal(junk.outcome, 'not-checked');
  assert.match(junk.error, /invalid noul/);
  assert.equal((await judgeCandidate(c, { ask: answer(0.1), threshold: 0.8 })).outcome, 'clear');
});

test('judgeCandidate sends only the candidate: rule, source, file and hunk (D6)', async () => {
  const [c] = selectCandidates(parseDiff(VIOLATION), rules());
  let sent;
  await judgeCandidate(c, {
    ask: async (req) => {
      sent = req;
      return { ok: true, answers: { violates: { noul: 0.9 } } };
    },
    threshold: 0.8,
  });
  assert.deepEqual(Object.keys(sent.state).sort(), ['file', 'hunk', 'rule', 'source']);
  assert.equal(sent.questions.violates.type, 'noul');
});

const manyCandidates = (n, { big = false } = {}) =>
  selectCandidates(
    parseDiff(
      Array.from({ length: n }, (_, i) =>
        diffOf(`apps/web/f${i}.ts`, [`analytics.track(${i})${big ? 'x'.repeat(HUNK_CHAR_LIMIT) : ''}`])
      ).join('\n')
    ),
    rules()
  );

test('judgeAll: the cap, the hunk limit and the budget are not-checked, logged, and ask nothing', async () => {
  const logged = [];
  let asked = 0;
  const ask = async () => {
    asked++;
    return { ok: true, answers: { violates: { noul: 0.9 } } };
  };
  const rail = { thresholds: { default: 0.8 } };
  const over = await judgeAll(manyCandidates(MAX_CANDIDATES + 2), {
    ask,
    log: (e) => logged.push(e),
    rail,
    mode: 'shadow',
    sha: 'abc',
  });
  assert.equal(asked, MAX_CANDIDATES);
  assert.deepEqual(
    over.slice(MAX_CANDIDATES).map((r) => r.outcome),
    ['not-checked', 'not-checked']
  );
  assert.equal(logged.length, MAX_CANDIDATES + 2, 'every candidate is logged, judged or not');
  assert.equal(logged[0].rail, 'lint:rule-1');
  assert.equal(logged[0].decider, 'jev');
  assert.equal(logged[0].jev, true);
  assert.equal(logged[0].source, 'apps/web/f0.ts@abc');
  assert.equal(logged.at(-1).decider, 'not-checked');
  assert.equal(logged.at(-1).jev, null);

  asked = 0;
  const big = await judgeAll(manyCandidates(1, { big: true }), { ask, log: () => {}, rail, mode: 'shadow' });
  assert.equal(asked, 0);
  assert.match(big[0].error, /hunk over/);

  let t = 0;
  const late = await judgeAll(manyCandidates(2), {
    ask,
    log: () => {},
    rail,
    mode: 'shadow',
    now: () => (t += 70_000),
  });
  assert.equal(asked, 0);
  assert.match(late[0].error, /time budget/);
});

test('a per-rule threshold overrides the default', async () => {
  const c = manyCandidates(1);
  const [r] = await judgeAll(c, {
    ask: answer(0.7),
    log: () => {},
    rail: { thresholds: { default: 0.8, 'rule-1': 0.65 } },
    mode: 'shadow',
  });
  assert.equal(r.outcome, 'raise');
});

test('summarize: shadow says "would raise" with p; jev prints the finding; all-not-checked says so', () => {
  const c = manyCandidates(2);
  const res = [
    { outcome: 'raise', p: 0.93, error: null },
    { outcome: 'not-checked', p: null, error: 'timeout after 8000ms' },
  ];
  const [shadow] = summarize(c, res, { mode: 'shadow' });
  assert.match(
    shadow,
    /^semantic-lint \(shadow\): lint:rule-1 — 2 candidate\(s\): 1 would raise \(p=0\.93 apps\/web\/f0\.ts\), 1 not checked \(timeout after 8000ms\) · logged, not shown as findings$/
  );
  const jev = summarize(c, res, { mode: 'jev' });
  assert.equal(jev.length, 2);
  assert.match(jev[1], /\[should-fix\] apps\/web\/f0\.ts: p=0\.93 — may break AGENTS\.md rule 1/);
  const none = summarize(
    c,
    res.map(() => ({ outcome: 'not-checked', p: null, error: 'no TYPESAFE_API_KEY' })),
    { mode: 'shadow' }
  );
  assert.deepEqual(none, [
    'semantic-lint: not checked (no key) — lint:rule-1, 2 candidate(s) logged, none judged',
  ]);
});

// ── the CLI ─────────────────────────────────────────────────────────────────────────────────────

const jevCfg = (lint = { mode: 'shadow', shadowExpires: '2026-10-14' }) =>
  parseJevConfig({ egress: true, rails: { lint } });

function harness({ config = jevCfg(), section = { rules: [RULE] }, diff = VIOLATION, ctx = {} } = {}) {
  const out = [];
  const err = [];
  const logged = [];
  const calls = { context: 0, ask: 0 };
  const io = {
    jevConfig: () => config,
    lintSection: () => section,
    defaultRange: () => 'origin/main...HEAD',
    diff: typeof diff === 'function' ? diff : () => diff,
    headSha: () => 'abc123',
    context: () => {
      calls.context++;
      return {
        mode: 'shadow',
        why: 'configured shadow',
        ask: async () => {
          calls.ask++;
          return { ok: true, answers: { violates: { noul: 0.93 } } };
        },
        log: (e) => logged.push(e),
        ...ctx,
      };
    },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  };
  return { io, out, err, logged, calls };
}

test('run: shadow, one violation → one line naming lint:rule-1 with p, logged, exit 0', async () => {
  const h = harness();
  assert.equal(await run([], h.io), 0);
  assert.equal(h.out.length, 1);
  assert.match(
    h.out[0],
    /lint:rule-1 — 1 candidate\(s\): 1 would raise \(p=0\.93 apps\/web\/app\/api\/x\/route\.ts\)/
  );
  assert.equal(h.logged.length, 1);
  assert.equal(h.logged[0].rail, 'lint:rule-1');
  assert.equal(h.logged[0].source, 'apps/web/app/api/x/route.ts@abc123');
});

test('run: an allowlisted-only push has nothing to judge and never builds a context or asks', async () => {
  const h = harness({ diff: diffOf('apps/web/e2e/x.spec.ts', [".from('events').insert(r)"]) });
  assert.equal(await run([], h.io), 0);
  assert.match(h.out[0], /nothing to judge/);
  assert.deepEqual(h.calls, { context: 0, ask: 0 });
  assert.equal(h.logged.length, 0);
});

test('run: no key → "semantic-lint: not checked (no key)", logged per candidate, exit 0', async () => {
  const h = harness({ ctx: { mode: 'off', why: 'no TYPESAFE_API_KEY' } });
  assert.equal(await run([], h.io), 0);
  assert.match(h.out[0], /^semantic-lint: not checked \(no key\)/);
  assert.equal(h.calls.ask, 0);
  assert.equal(h.logged.length, 1);
  assert.equal(h.logged[0].decider, 'not-checked');
});

test("run: off exits before reading rules or building a context (no egress ask on a stranger's push)", async () => {
  const h = harness({ config: jevCfg({ mode: 'off' }), section: 'not even valid' });
  assert.equal(await run([], h.io), 0);
  assert.deepEqual(h.out, ['semantic-lint: off (jev.rails.lint.mode)\n']);
  assert.equal(h.calls.context, 0);
});

test('run: a malformed rule is exit 2 and says why; no rules is a quiet 0', async () => {
  const bad = harness({ section: { rules: [{ ...RULE, patterns: ['('] }] } });
  assert.equal(await run([], bad.io), 2);
  assert.match(bad.err.join(''), /not run — lint: .*not a valid RegExp/);
  const empty = harness({ section: null });
  assert.equal(await run([], empty.io), 0);
  assert.match(empty.out[0], /no rules/);
});

test('run: an unreadable diff is "not checked", never a pass', async () => {
  const h = harness({
    diff: () => {
      throw new Error("fatal: bad revision 'nope'\nmore");
    },
  });
  assert.equal(await run(['--range', 'nope...HEAD'], h.io), 0);
  assert.deepEqual(h.out, [
    "semantic-lint: not checked (could not read the diff: fatal: bad revision 'nope')\n",
  ]);
});

test('run: every --range is read; usage errors are exit 2', async () => {
  const seen = [];
  const h = harness({ diff: (r) => (seen.push(r), '') });
  await run(['--range', 'a...b', '--range', 'c...d'], h.io);
  assert.deepEqual(seen, ['a...b', 'c...d']);
  assert.ok(parseArgs(['--range']).error);
  assert.ok(parseArgs(['--nope']).error);
  const u = harness();
  assert.equal(await run(['--rang', 'x'], u.io), 2);
});
