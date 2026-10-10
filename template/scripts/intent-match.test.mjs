// intent-match.test.mjs — the scorer, with a replay client: no key, no egress, no network (intent-match S1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BANDS,
  EXIT_COULD_NOT_LOOK,
  EXIT_SCORED,
  EXIT_USAGE,
  INTENT_QUESTIONS,
  ROUTES,
  band,
  frontmatterOf,
  FENCE_RE,
  formatReport,
  buildRequest,
  buildRouteRequest,
  judgeItem,
  listItems,
  parseSeed,
  run,
  scoreAnswers,
  totalOf,
  writeIntoSeed,
} from './intent-match.mjs';

const SEED = `---
title: "Export"
slug: export
status: ready
appetite: M
updated: 2026-09-29
---

# Pitch — Export

## The ask, as given

> I want people to download their orders as a spreadsheet, and I never want to see an export stuck on a spinner again.

### Claims
1. A person can download their orders as a spreadsheet.
2. An export never hangs on a spinner:
   it finishes or says why it failed.
3. Exports are emailed every Monday.

**Teach-back:** partly — "You want a CSV download that never hangs, so that support stops getting tickets. Right?"

## Problem
<!-- template guidance that is not pitch -->
Support gets tickets about exports that never finish.

## Bill of materials (What / Why)
| What | Why |
|---|---|
| A CSV download button on /orders | the ask |

## Acceptance criteria
- On /orders, pressing **Download CSV** saves a file with one row per order.
  - the header row is: id, date, total
- An export that fails shows the reason within 10 seconds.
- It feels fast.

## Intent match

old score, must not reach Jev
`;

const noul = (p) => ({ type: 'noul', noul: p });
const score = (s) => ({ type: 'score', score: s });

/** Answers for SEED: claim 3 uncovered, criterion 3 unclear and untraced. */
const ANSWERS = {
  in_c1: noul(0.95),
  in_c2: noul(0.85),
  in_c3: noul(0.1),
  out_a1: noul(0.9),
  out_a2: noul(0.8),
  out_a3: noul(0.2),
  clar_a1: score(3),
  clar_a2: score(2.4),
  clar_a3: score(0.3),
};

const replay = (answers, { routes = {} } = {}) => {
  const calls = [];
  const ask = async (req) => {
    calls.push(req);
    const ids = Object.keys(req.questions);
    if (ids[0].startsWith('route_'))
      return {
        ok: true,
        answers: Object.fromEntries(ids.map((id) => [id, { type: 'choice', choice: routes[id] }])),
      };
    return { ok: true, answers: Object.fromEntries(ids.map((id) => [id, answers[id]])), model: 'jev-1.13.0' };
  };
  return { ask, calls };
};

const makeIo = (over = {}) => {
  const out = { stdout: '', stderr: '', written: null, logged: [], asked: 0, needEgress: 0 };
  const r = replay(over.answers ?? ANSWERS, { routes: over.routes });
  const io = {
    read: () => over.text ?? SEED,
    write: (_p, t) => {
      out.written = t;
    },
    config: () => ({ model: 'jev-1.13.0', egress: 'egress' in over ? over.egress : true }),
    key: () => ('key' in over ? over.key : 'k'),
    needEgress: () => {
      out.needEgress++;
    },
    makeAsk: () => async (req) => {
      out.asked++;
      out.stderrAtFirstAsk ??= out.stderr;
      return over.ask ? over.ask(req) : r.ask(req);
    },
    log: (e) => out.logged.push(e),
    stdout: (t) => {
      out.stdout += t;
    },
    stderr: (t) => {
      out.stderr += t;
    },
  };
  return { io, out, calls: r.calls };
};

// ── parsing ───────────────────────────────────────────────────────────────────────────────────────────────────

test('parseSeed: claims, teach-back and criteria come from the D9 sections', () => {
  const p = parseSeed(SEED);
  assert.deepEqual(p.claims, [
    'A person can download their orders as a spreadsheet.',
    'An export never hangs on a spinner: it finishes or says why it failed.',
    'Exports are emailed every Monday.',
  ]);
  assert.equal(p.teachBack, 'partly');
  assert.equal(p.criteria.length, 3, 'a nested bullet belongs to its parent, not a criterion of its own');
  assert.match(p.criteria[0], /header row is: id, date, total/);
  assert.match(p.ask, /download their orders as a spreadsheet/);
  assert.doesNotMatch(p.ask, /Teach-back/);
});

test('parseSeed: the pitch Jev reads holds neither the ask, an old score, the frontmatter nor template comments (C5)', () => {
  const { pitch } = parseSeed(SEED);
  assert.doesNotMatch(pitch, /spinner again/, 'the verbatim ask would make every claim trivially covered');
  assert.doesNotMatch(pitch, /### Claims/);
  assert.doesNotMatch(pitch, /old score/);
  assert.doesNotMatch(pitch, /appetite: M/);
  assert.doesNotMatch(pitch, /template guidance/);
  assert.match(pitch, /## Problem/);
  assert.match(pitch, /Download CSV/);
});

test('parseSeed: an absent section leaves its signal absent, never zero', () => {
  const p = parseSeed('# Pitch\n\n## Problem\nx\n');
  assert.deepEqual([p.claims, p.criteria, p.teachBack, p.ask], [[], [], null, null]);
});

test('listItems: a heading inside a fence is not a list, and a blank line closes an item', () => {
  assert.deepEqual(listItems(['- one', '', 'a paragraph', '- two']), ['one', 'two']);
  assert.deepEqual(listItems(['```', '- not an item', '```', '- item']), ['item']);
  assert.deepEqual(listItems(['1. a', '2) b'], { numbered: true }), ['a', 'b']);
});

// ── the request ───────────────────────────────────────────────────────────────────────────────────────────────

test('buildRequest: one Noul per claim, a Noul and a Score per criterion, each naming its item by path', () => {
  const { state, questions } = buildRequest(parseSeed(SEED));
  assert.deepEqual(Object.keys(questions), [
    'in_c1',
    'in_c2',
    'in_c3',
    'out_a1',
    'clar_a1',
    'out_a2',
    'clar_a2',
    'out_a3',
    'clar_a3',
  ]);
  assert.equal(questions.in_c2.type, 'noul');
  assert.equal(questions.clar_a1.type, 'score');
  assert.match(questions.in_c2.instructions, /`claims\.c2`/);
  assert.match(questions.out_a3.instructions, /`criteria\.a3`/);
  assert.doesNotMatch(JSON.stringify(questions), /\{item\}/);
  assert.equal(state.claims.c3, 'Exports are emailed every Monday.');
  assert.equal(state.criteria.a3, 'It feels fast.');
});

test('INTENT_QUESTIONS: every question set in one object, in the shapes Jev takes (D13)', () => {
  assert.deepEqual(Object.keys(INTENT_QUESTIONS).sort(), [
    'agreement',
    'clarity',
    'coverage_in',
    'coverage_out',
    'route',
    'why_story',
  ]);
  assert.equal(INTENT_QUESTIONS.agreement.type, 'noul');
  for (const id of ['coverage_in', 'coverage_out']) {
    assert.equal(INTENT_QUESTIONS[id].type, 'noul');
    assert.deepEqual(Object.keys(INTENT_QUESTIONS[id].criteria), ['true', 'false']);
  }
  assert.equal(INTENT_QUESTIONS.clarity.criteria.length, 4, 'clarity ÷ 3 assumes four levels');
  assert.deepEqual(
    Object.keys(INTENT_QUESTIONS.route.criteria),
    Object.keys(ROUTES),
    'the route vocabulary is D14'
  );
});

// ── scoring ───────────────────────────────────────────────────────────────────────────────────────────────────

test('scoreAnswers: each signal is one mean, the total the mean of the signals present', () => {
  const r = scoreAnswers(parseSeed(SEED), ANSWERS);
  assert.equal(r.ok, true);
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
  close(r.signals.coverage_in, (0.95 + 0.85 + 0.1) / 3);
  close(r.signals.coverage_out, (0.9 + 0.8 + 0.2) / 3);
  close(r.signals.clarity, (3 + 2.4 + 0.3) / 3 / 3);
  assert.equal(r.signals.teach_back, 0.5);
  const want = Math.round(
    (100 * (r.signals.coverage_in + r.signals.coverage_out + r.signals.clarity + 0.5)) / 4
  );
  assert.equal(r.total, want);
  assert.deepEqual(r.present, ['coverage_in', 'coverage_out', 'clarity', 'teach_back']);
  assert.deepEqual(
    r.gaps.map((g) => [g.id, g.kind]),
    [
      ['c3', 'uncovered'],
      ['a3', 'unclear'],
    ]
  );
  assert.deepEqual(
    r.untraced.map((u) => u.id),
    ['a3']
  );
});

test('scoreAnswers: a malformed answer is could-not-look for the whole score, never a coerced number', () => {
  for (const bad of [
    { type: 'noul', noul: true },
    { type: 'noul', noul: '0.9' },
    { type: 'noul', noul: 1.2 },
    { type: 'score', noul: 0.9 },
    { noul: 0.9 },
    null,
    undefined,
  ]) {
    const r = scoreAnswers(parseSeed(SEED), { ...ANSWERS, in_c1: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /in_c1/);
  }
  assert.equal(scoreAnswers(parseSeed(SEED), { ...ANSWERS, clar_a2: score(4) }).ok, false);
  assert.equal(
    scoreAnswers(parseSeed(SEED), { ...ANSWERS, clar_a2: { type: 'noul', score: 2 } }).ok,
    false,
    'a Score read off a Noul-typed answer'
  );
});

test('totalOf: signals that are absent do not count, and none at all is no total', () => {
  assert.deepEqual(totalOf({ coverage_in: 0.8, clarity: null, teach_back: 1 }), {
    total: 90,
    present: ['coverage_in', 'teach_back'],
  });
  assert.equal(totalOf({ coverage_in: null }), null);
});

test('band: the placeholder edges are 80 and 60', () => {
  assert.deepEqual(
    [band(100), band(80), band(79), band(60), band(59), band(0)],
    [BANDS[0].label, BANDS[0].label, BANDS[1].label, BANDS[1].label, BANDS[2].label, BANDS[2].label]
  );
});

test('buildRouteRequest: one Choice per gap, over the D14 vocabulary', () => {
  const p = parseSeed(SEED);
  const r = scoreAnswers(p, ANSWERS);
  const { questions } = buildRouteRequest(p, r.gaps);
  assert.deepEqual(Object.keys(questions), ['route_c3', 'route_a3']);
  assert.equal(questions.route_c3.type, 'choice');
  assert.match(questions.route_c3.instructions, /`claims\.c3`.*does not deliver it/);
  assert.match(questions.route_a3.instructions, /`criteria\.a3`.*could not test it/);
});

// ── the CLI ───────────────────────────────────────────────────────────────────────────────────────────────────

test('run: prints four components, an uncalibrated total, a band and a route per gap', async () => {
  const { io, out } = makeIo({ routes: { route_c3: 'spike', route_a3: 'copy_deck' } });
  assert.equal(await run(['seed.md'], io), EXIT_SCORED);
  for (const line of [
    'coverage in',
    'coverage out',
    'clarity',
    'teach-back',
    'agreement     pending',
    'uncalibrated',
    'Band:',
  ])
    assert.ok(out.stdout.includes(line), `missing "${line}"`);
  assert.match(out.stdout, /signals: coverage in, coverage out, clarity, teach-back/);
  assert.match(out.stdout, /teach-back {4}0\.50  \(partly\)/);
  assert.match(out.stdout, /claim 3 — uncovered.*→ spike/);
  assert.match(out.stdout, /criterion 3 — unclear.*→ copy deck/);
  assert.match(out.stdout, /Untraced[\s\S]*criterion 3/);
  assert.equal(out.logged.length, 1);
  assert.equal(out.logged[0].rail, 'intent');
});

test('run: the question count is printed BEFORE anything is asked', async () => {
  const { io, out } = makeIo();
  await run(['seed.md'], io);
  assert.match(out.stderrAtFirstAsk, /asking Jev 9 question\(s\) — 3 claim\(s\), 3 criteria/);
});

test('run: a route that cannot be asked leaves the score standing and says so per gap', async () => {
  const { io, out } = makeIo({
    ask: async (req) =>
      Object.keys(req.questions)[0].startsWith('route_')
        ? { ok: false, state: 'could-not-look', error: 'HTTP 429' }
        : { ok: true, answers: ANSWERS },
  });
  assert.equal(await run(['seed.md'], io), EXIT_SCORED);
  assert.match(out.stdout, /claim 3 — uncovered.*route: could not look/);
});

const assertCouldNotLook = (out, why) => {
  assert.match(out.stderr, new RegExp(`could not look \\(.*${why}`));
  assert.doesNotMatch(out.stdout, /Total/);
  assert.doesNotMatch(out.stdout + out.stderr, /\d+ \/ 100/);
  assert.equal(out.written, null);
  assert.equal(out.logged.length, 0);
};

test('could not look: no TYPESAFE_API_KEY — no number, nothing asked', async () => {
  const { io, out } = makeIo({ key: null });
  assert.equal(await run(['seed.md', '--write'], io), EXIT_COULD_NOT_LOOK);
  assertCouldNotLook(out, 'no TYPESAFE_API_KEY');
  assert.equal(out.asked, 0);
});

test('could not look: egress false — and the key is never read', async () => {
  let keyRead = false;
  const { io, out } = makeIo({ egress: false });
  io.key = () => {
    keyRead = true;
    return 'k';
  };
  assert.equal(await run(['seed.md'], io), EXIT_COULD_NOT_LOOK);
  assertCouldNotLook(out, 'egress is false');
  assert.equal(keyRead, false);
  assert.equal(out.needEgress, 0);
});

test('could not look: egress unanswered (null) — and the egress question is asked once', async () => {
  const { io, out } = makeIo({ egress: null });
  assert.equal(await run(['seed.md'], io), EXIT_COULD_NOT_LOOK);
  assertCouldNotLook(out, 'egress is null');
  assert.equal(out.needEgress, 1);
});

test('could not look: a pitch over the state budget is refused, never truncated', async () => {
  const big = SEED.replace('Support gets tickets', `${'x'.repeat(120_000)} Support gets tickets`);
  const { io, out } = makeIo({ text: big });
  assert.equal(await run(['seed.md'], io), EXIT_COULD_NOT_LOOK);
  assertCouldNotLook(out, "over Jev's state budget");
  assert.equal(out.asked, 0);
});

test('could not look: Jev unreachable, or a malformed answer', async () => {
  const down = makeIo({
    ask: async () => ({ ok: false, state: 'could-not-look', error: 'timeout after 30000ms' }),
  });
  assert.equal(await run(['seed.md'], down.io), EXIT_COULD_NOT_LOOK);
  assertCouldNotLook(down.out, 'timeout');
  const bad = makeIo({ answers: { ...ANSWERS, out_a2: { type: 'noul', noul: true } } });
  assert.equal(await run(['seed.md'], bad.io), EXIT_COULD_NOT_LOOK);
  assertCouldNotLook(bad.out, 'malformed answer');
});

test('could not look: a seed with no claims has nothing to match against', async () => {
  const { io, out } = makeIo({ text: '# Pitch\n\n## Acceptance\n- a check\n' });
  assert.equal(await run(['seed.md'], io), EXIT_COULD_NOT_LOOK);
  assertCouldNotLook(out, 'no claims');
});

test('run: --json puts the result on stdout and the report on stderr', async () => {
  const { io, out } = makeIo();
  await run(['seed.md', '--json', '--no-route'], io);
  const j = JSON.parse(out.stdout);
  assert.equal(j.state, 'scored');
  assert.equal(j.uncalibrated, true);
  assert.equal(typeof j.total, 'number');
  assert.match(out.stderr, /Total/);
});

test('run: usage errors exit 1', async () => {
  assert.equal(await run([], makeIo().io), EXIT_USAGE);
  assert.equal(await run(['a.md', '--bogus'], makeIo().io), EXIT_USAGE);
});

// ── --write ───────────────────────────────────────────────────────────────────────────────────────────────────

test('--write: frontmatter gains intent_match and intent_ask, the old section is replaced, and a rewrite is stable', async () => {
  const { io, out } = makeIo({ routes: { route_c3: 'spike', route_a3: 'copy_deck' } });
  await run(['seed.md', '--write'], io);
  const w = out.written;
  assert.match(w, /^---[\s\S]*\nintent_match: \d+\nintent_ask: verbatim\n---/);
  assert.equal(w.match(/^## Intent match/gm).length, 1);
  assert.doesNotMatch(w, /old score, must not reach Jev/);
  assert.match(w, /<!-- intent-match: \{"coverage_in":0\.633,.*"total":\d+\} -->/);
  const r = scoreAnswers(parseSeed(w), ANSWERS);
  assert.equal(r.ok, true, 'the written seed still parses to the same items');
  r.gaps = r.gaps.map((g) => ({ ...g, route: null }));
  const again = writeIntoSeed(w, r, { source: 'seed.md', hasAsk: true });
  assert.equal(again.match(/^## Intent match/gm).length, 1);
  assert.equal(again.match(/^intent_match:/gm).length, 1);
  assert.equal(parseSeed(again).pitch, parseSeed(w).pitch, 'the pitch is unchanged by re-scoring');
});

test('--write: an existing intent_ask (proxy) is kept', () => {
  const r = scoreAnswers(parseSeed(SEED), ANSWERS);
  r.gaps = [];
  const w = writeIntoSeed(SEED.replace('updated:', 'intent_ask: proxy\nupdated:'), r, { hasAsk: true });
  assert.match(w, /intent_ask: proxy/);
  assert.doesNotMatch(w, /intent_ask: verbatim/);
});

// ── the eval hook ─────────────────────────────────────────────────────────────────────────────────────────────

test('judgeItem: asks exactly the question the scorer asks, and reads only a valid answer', async () => {
  const fx = { question: 'clarity', pitch: 'p', claims: {}, criteria: { a1: 'It feels fast.' }, item: 'a1' };
  let seen;
  const d = await judgeItem(fx, {
    ask: async (req) => {
      seen = req;
      return { ok: true, answers: { clar_a1: score(0.6) } };
    },
  });
  assert.deepEqual(Object.keys(seen.questions), ['clar_a1']);
  assert.deepEqual(
    seen.questions.clar_a1,
    buildRequest({ claims: [], criteria: ['It feels fast.'], pitch: 'p' }).questions.clar_a1
  );
  assert.deepEqual(d, { value: false, p: 0.2, decider: 'jev' });
  const nope = await judgeItem(fx, { ask: async () => ({ ok: true, answers: { clar_a1: { score: '2' } } }) });
  assert.deepEqual(nope, { value: null, p: null, decider: 'could-not-look' });
  const wrongType = await judgeItem(fx, {
    ask: async () => ({ ok: true, answers: { clar_a1: { type: 'noul', score: 2 } } }),
  });
  assert.deepEqual(wrongType, { value: null, p: null, decider: 'could-not-look' });
});

// ── fresh review of #196 ─────────────────────────────────────────────────────────────────────────────────────

test('a teach-back line directly under the last claim ends the claims instead of joining the last one', () => {
  const p = parseSeed(
    '## The ask, as given\n> x\n\n### Claims\n1. A\n2. B\n**Teach-back:** yes — "you want A and B"\n'
  );
  assert.deepEqual(p.claims, ['A', 'B']);
  assert.equal(p.teachBack, 'yes');
});

test('the format string "yes | partly | no" is not an answer', () => {
  for (const line of [
    '**Teach-back:** yes | partly | no — "<mirror>"',
    '**Teach-back:** yes|partly|no',
    '**Teach-back:** <yes | partly | no>',
  ])
    assert.equal(
      parseSeed(`## The ask, as given\n> x\n\n### Claims\n1. A\n\n${line}\n`).teachBack,
      null,
      line
    );
  assert.equal(parseSeed('## The ask, as given\n> x\n\n**Teach-back:** partly — "…"\n').teachBack, 'partly');
});

test('a CRLF seed parses the same as an LF one', () => {
  const crlf = SEED.replace(/\n/g, '\r\n');
  const a = parseSeed(crlf);
  const b = parseSeed(SEED);
  assert.deepEqual([a.claims, a.criteria, a.teachBack], [b.claims, b.criteria, b.teachBack]);
});

test('--write ignores a "## Intent match" inside a code fence, and never deletes the text around it', () => {
  const fenced = `${SEED.replace('## Intent match\n\nold score, must not reach Jev\n', '')}\n## Notes\n\n\`\`\`md\n## Intent match\nan example\n\`\`\`\n\nkeep me\n`;
  const r = scoreAnswers(parseSeed(fenced), ANSWERS);
  r.gaps = [];
  const w = writeIntoSeed(fenced, r, { hasAsk: true });
  assert.match(w, /```md\n## Intent match\nan example\n```\n\nkeep me/);
  assert.equal(
    w.match(/^## Intent match$/gm).length,
    2,
    'the fenced example stays, and the real section is appended'
  );
});

test('--write on a CRLF seed writes the score into the frontmatter it reports writing', async () => {
  const { io, out } = makeIo({ text: SEED.replace(/\n/g, '\r\n') });
  assert.equal(await run(['seed.md', '--write', '--no-route'], io), EXIT_SCORED);
  assert.match(out.written, /^---\n[\s\S]*\nintent_match: \d+\n[\s\S]*?---\n/);
  assert.doesNotMatch(out.written, /\r/);
});

// ── the seed template (intent-match S2.1) is the parser's contract ───────────────────────────────────────────

test('the refine seed template parses: placeholder teach-back is unanswered, Visuals never leak into criteria', async (t) => {
  const { existsSync, readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  // This spec runs from skills/template/scripts/ and from this repo's scripts/ copy; a kit consumer has neither path.
  const tpl = [
    join(here, '..', '..', 'plugins', 'golden-frijoles', 'skills', 'refine', 'templates', 'scope-seed.md'),
    join(
      here,
      '..',
      'skills',
      'plugins',
      'golden-frijoles',
      'skills',
      'refine',
      'templates',
      'scope-seed.md'
    ),
  ].find((p) => existsSync(p));
  if (!tpl) return t.skip('refine template not in this checkout');
  const text = readFileSync(tpl, 'utf8').replace(
    '## Acceptance criteria',
    '## Acceptance criteria\n- the one real check'
  );
  const p = parseSeed(text);
  assert.equal(p.teachBack, null, 'the "<yes | partly | no>" placeholder is not an answer');
  assert.equal(p.claims.length, 2);
  assert.deepEqual(p.criteria, ['the one real check']);
  assert.doesNotMatch(p.pitch, /paste the ask here/, 'the ask section never reaches Jev');
  assert.match(p.pitch, /```surface/, 'the Visuals stay in the pitch Jev reads');
  assert.match(frontmatterOf(text).intent_ask, /^verbatim$/);
  assert.equal(frontmatterOf(text).intent_match, 'null');
});

test('FENCE_RE follows CommonMark: up to three spaces of indent is a fence, four is code', () => {
  assert.equal(FENCE_RE.test('```'), true);
  assert.equal(FENCE_RE.test('   ~~~'), true);
  assert.equal(FENCE_RE.test('    ```'), false);
});

// think-skills D9: a "worth doing?" gap leads to the coaches that answer it, not to "answer by hand".
test('the think-chain route names the strategy coaches', () => {
  assert.match(ROUTES.think_chain, /`pmf-narrative`/);
  assert.match(ROUTES.think_chain, /`risk-validation`/);
  assert.doesNotMatch(ROUTES.think_chain, /answer by hand/);
});

test('why-as-a-story D3: the Why is asked about on its own, reported outside the total, and a bad answer is could-not-look', () => {
  const parsed = parseSeed(
    SEED.replace(/^---\n/, '---\nhypothesis: "Today a founder cannot tell if a feature worked."\n')
  );
  const req = buildRequest(parsed);
  assert.equal(req.state.why, 'Today a founder cannot tell if a feature worked.');
  assert.match(req.questions.why_story.instructions, /`why`/);
  assert.equal(buildRequest(parseSeed(SEED)).questions.why_story, undefined, 'no Why, no question');
  const yes = (n) => ({ type: 'noul', noul: n });
  const answers = Object.fromEntries(
    Object.keys(req.questions).map((id) => [
      id,
      id.startsWith('clar_') ? { type: 'score', score: 3 } : yes(0.9),
    ])
  );
  const withStory = scoreAnswers(parsed, { ...answers, why_story: yes(0.2) });
  const without = scoreAnswers(parsed, { ...answers, why_story: { type: 'noul', noul: 'high' } });
  assert.equal(withStory.total, without.total, 'the story answer never moves the total');
  assert.equal(withStory.whyStory, 0.2);
  assert.equal(without.whyStory, null);
  assert.match(
    formatReport(withStory),
    /why story +0\.20 +\(advisory, not in the total: rewrite the Why as a story\)/
  );
  assert.match(formatReport(without), /why story +— +\(could not look/);
});
