// jev-eval.test.mjs — the replay harness and the shadow rot guard (jev-semantic-guards S1.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  coverageFailures,
  evaluate,
  expiredShadowRails,
  FIXTURES_PATH,
  formatReport,
  liveRefusal,
  loadRails,
  MIN_FIXTURES,
  parseLimit,
  replayAsk,
  run,
} from './jev-eval.mjs';
import { loadJevConfig, parseJevConfig, repoRoot } from './lib/jev.mjs';

test('expiredShadowRails: a shadow rail past its date is named; a live one and an off one are not', () => {
  const c = parseJevConfig({
    rails: {
      review: { mode: 'shadow', shadowExpires: '2026-01-01' },
      prose: { mode: 'shadow', shadowExpires: '2099-01-01' },
    },
  });
  assert.deepEqual(expiredShadowRails(c, '2026-09-22'), [
    { rail: 'review', shadowExpires: '2026-01-01', why: 'past its shadowExpires' },
    { rail: 'prose', shadowExpires: '2099-01-01', why: 'more than 21 days out' },
  ]);
  const fine = parseJevConfig({ rails: { review: { mode: 'shadow', shadowExpires: '2026-10-13' } } });
  assert.deepEqual(expiredShadowRails(fine, '2026-09-22'), [], 'exactly 21 days out is allowed');
  assert.deepEqual(expiredShadowRails(fine, '2026-10-13'), [], 'the expiry day itself still runs');
  assert.deepEqual(expiredShadowRails(parseJevConfig({}), '2099-12-31'), []);
});

test('replayAsk: answers only from the recording; a missing answer is could-not-look (a stale fixture)', async () => {
  const ask = replayAsk({ model: 'jev-1.13.0', answers: { a: { type: 'noul', noul: 1 } } });
  assert.equal((await ask({ questions: { a: {} } })).answers.a.noul, 1);
  const r = await ask({ questions: { a: {}, b: {} } });
  assert.equal(r.state, 'could-not-look');
  assert.match(r.error, /no recording for b/);
});

test('evaluate: a replay that disagrees with its recorded decision is a failure', async () => {
  const rail = {
    run: async (fx, deps) => ({
      ok: (await deps.ask({ questions: { q: {} } })).answers.q.noul > 0.5,
      decider: 'jev',
    }),
    regex: () => false,
    predicted: (d) => d.ok,
    expected: (fx) => fx.label,
    summary: (d) => ({ ok: d.ok, decider: d.decider }),
  };
  const fx = (noul, recordedOk) => ({
    id: `n${noul}`,
    label: true,
    recorded: { model: 'jev-1.13.0', answers: { q: { type: 'noul', noul } } },
    decision: { ok: recordedOk, decider: 'jev' },
  });
  const { failures, report } = await evaluate({
    fixtures: { review: [fx(0.9, true), fx(0.1, true)] },
    rails: { review: rail },
    config: parseJevConfig({}),
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /review\/n0.1/);
  assert.equal(report.review.jevRight, 1);
  assert.equal(report.review.regexRight, 0);
});

test('the committed fixtures replay clean against the committed judges', async () => {
  const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8'));
  const rails = await loadRails();
  const { failures } = await evaluate({ fixtures, rails, config: loadJevConfig({ root: repoRoot() }) });
  assert.deepEqual([...failures, ...coverageFailures(fixtures, rails)], []);
});

test('coverageFailures: fixtures with no judge fail (a renamed judge must not go green); a thin judge fails', () => {
  assert.match(coverageFailures({ review: [{}] }, {})[0], /no judge to replay them/);
  assert.match(coverageFailures({ review: [{}] }, { review: {} })[0], new RegExp(`≥${MIN_FIXTURES}`));
  assert.deepEqual(
    coverageFailures({ review: [] }, {}),
    [],
    'no judge and no fixtures is a clean pre-judge checkout'
  );
});

test('evaluate: a recording made by a different model than the pinned one is stale — offline replay fails', async () => {
  const rail = {
    run: async () => ({ ok: true }),
    regex: () => true,
    predicted: (d) => d.ok,
    expected: () => true,
    summary: (d) => ({ ok: d.ok }),
  };
  const { failures } = await evaluate({
    fixtures: {
      review: [
        { id: 'old', label: true, recorded: { model: 'jev-1.12.0', answers: {} }, decision: { ok: true } },
      ],
    },
    rails: { review: rail },
    config: parseJevConfig({}),
  });
  assert.match(failures[0], /recorded by jev-1.12.0, config pins jev-1.13.0/);
});

test('evaluate live refuses unless egress is true: null (unanswered) and false never send (cross-review of #50)', async () => {
  const fixtures = JSON.parse(readFileSync(new URL('./jev-eval.fixtures.json', import.meta.url), 'utf8'));
  const rails = await loadRails();
  for (const egress of [null, false]) {
    let asked = 0;
    const config = { ...loadJevConfig({ root: repoRoot() }), egress };
    await assert.rejects(
      evaluate({ fixtures, rails, config, live: true, ask: async () => ((asked += 1), {}) }),
      /refusing to send/
    );
    assert.equal(asked, 0, `egress ${egress}: nothing asked`);
  }
});

// ── --limit: the setup proof (distribute-what-we-use S3.2) ────────────────────────────────────────────
const proofRail = {
  run: async (fx, deps) => ({
    ok: (await deps.ask({ questions: { [fx.id]: {} } })).answers[fx.id].noul > 0.5,
    decider: 'jev',
  }),
  regex: () => false,
  predicted: (d) => d.ok,
  expected: (fx) => fx.label,
  summary: (d) => ({ ok: d.ok, decider: d.decider }),
};
const proofFixtures = () => ({
  review: Array.from({ length: 6 }, (_, i) => ({
    id: `f${i}`,
    label: true,
    recorded: { model: 'old', answers: {} },
    decision: null,
  })),
});
function harness({ config = parseJevConfig({ egress: true }), key = 'k' } = {}) {
  const h = { out: '', err: '', asked: [], written: 0 };
  h.io = {
    config,
    fixtures: proofFixtures(),
    rails: { review: proofRail },
    key: () => key,
    makeAsk: () => async ({ questions }) => {
      h.asked.push(...Object.keys(questions));
      return {
        ok: true,
        answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.9 }])),
        model: config.model,
      };
    },
    writeFixtures: () => (h.written += 1),
    stdout: (t) => (h.out += t),
    stderr: (t) => (h.err += t),
    today: '2026-09-29',
  };
  return h;
}

test('--live --limit: asks Jev for only the first n fixtures, reports agreement, writes nothing', async () => {
  const h = harness();
  const code = await run(['--live', '--limit', '2'], h.io);
  assert.equal(code, 0);
  assert.deepEqual(h.asked, ['f0', 'f1'], 'only the first two fixtures reached Jev');
  assert.equal(h.written, 0, 'a partial run never rewrites the committed recordings');
  assert.match(h.out, /nothing written/);
  assert.match(h.out, /review: 2 labelled · jev 100\.0%/);
});

test('--live without --limit still asks every fixture and rewrites the recordings', async () => {
  const h = harness();
  assert.equal(await run(['--live'], h.io), 1, 'the thin fixture set still fails the coverage floor');
  const big = harness();
  big.io.fixtures.review = Array.from({ length: MIN_FIXTURES }, (_, i) => ({ id: `g${i}`, label: true }));
  assert.equal(await run(['--live'], big.io), 0);
  assert.equal(big.asked.length, MIN_FIXTURES);
  assert.equal(big.written, 1);
});

test('--live --limit with no key: exits 2 with ONE line naming TYPESAFE_API_KEY and .env.local, asks nothing', async () => {
  const h = harness({ key: null });
  assert.equal(await run(['--live', '--limit', '3'], h.io), 2);
  assert.equal(h.err.trim().split('\n').length, 1);
  assert.match(h.err, /TYPESAFE_API_KEY/);
  assert.match(h.err, /\.env\.local/);
  assert.deepEqual(h.asked, []);
});

test('--live --limit with egress not true (null or false): refused before the key is even read', async () => {
  for (const egress of [null, false]) {
    const h = harness({ config: parseJevConfig({ egress }) });
    let keyRead = false;
    h.io.key = () => ((keyRead = true), 'k');
    assert.equal(await run(['--live', '--limit', '3'], h.io), 2);
    assert.match(h.err, /jev\.egress is/);
    assert.match(h.err, /config set jev\.egress true/);
    assert.equal(keyRead, false);
    assert.deepEqual(h.asked, []);
  }
});

test('--limit is refused without --live, and a malformed n is refused', async () => {
  assert.equal(await run(['--limit', '3'], harness().io), 2);
  for (const bad of ['0', '-1', 'x', '1.5', undefined])
    assert.ok(parseLimit(['--live', '--limit', bad])?.error, `limit ${bad}`);
  assert.equal(parseLimit(['--live']), null);
  assert.equal(parseLimit(['--limit', '10']), 10);
});

test('liveRefusal: egress is checked before the key', () => {
  assert.match(liveRefusal(parseJevConfig({ egress: null }), () => null), /egress/);
  assert.match(liveRefusal(parseJevConfig({ egress: true }), () => null), /TYPESAFE_API_KEY/);
  assert.equal(liveRefusal(parseJevConfig({ egress: true }), () => 'k'), null);
});

// ── The intent set (intent-match D15, C2): evaluated beside the rails, never one of them ────────────────────────

test('the intent set is loaded, replayed and held to the fixture floor, without being a Jev rail', async () => {
  const { RAILS } = await import('./lib/jev.mjs');
  const { EVAL_SETS } = await import('./jev-eval.mjs');
  assert.ok(!RAILS.includes('intent'), 'intent must not become a rail: parseJevConfig would have to accept a mode for it');
  assert.ok(EVAL_SETS.includes('intent'));
  const rails = await loadRails();
  assert.equal(rails.intent.regex, null);
  assert.match(coverageFailures({ intent: [{}] }, { intent: rails.intent })[0], new RegExp(`intent: only 1 .*≥${MIN_FIXTURES}`));
  assert.match(coverageFailures({ intent: [{}] }, {})[0], /no judge to replay them/);
});

test('intent report: decided and right are counted, and there is no regex column to be read as 0%', async () => {
  const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8'));
  const rails = await loadRails();
  const { report, failures } = await evaluate({ fixtures, rails: { intent: rails.intent }, config: loadJevConfig() });
  assert.deepEqual(failures, []);
  const t = report.intent;
  assert.equal(t.regexRight, null);
  assert.ok(t.decided <= t.n && t.decidedRight <= t.decided);
  assert.match(formatReport(report), /^intent: \d+ labelled · jev [\d.]+% · decided \d+\/\d+, \d+ right · no deterministic rule$/m);
  assert.doesNotMatch(formatReport(report), /intent:.*regex/);
});

test('--rail intent is accepted; a misspelt set is still refused', async () => {
  const io = { config: loadJevConfig(), fixtures: { intent: [] }, rails: {}, stdout: () => {}, stderr: () => {}, today: '2026-09-29' };
  assert.notEqual(await run(['--rail', 'intent'], io), 2);
  let err = '';
  assert.equal(await run(['--rail', 'intnet'], { ...io, stderr: (t) => (err += t) }), 2);
  assert.match(err, /review, prose, intent/);
});
