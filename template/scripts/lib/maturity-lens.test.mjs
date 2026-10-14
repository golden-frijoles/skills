// maturity-lens — placing the pod on the published Steps-of-AI-Adoption ladder.
//
// This is the section a buyer's leadership reads as a position on a named external scale, so the
// tests that matter are the ones that stop it flattering us. Two in particular are stated as
// acceptance criteria in sprint-2.md and are asserted here directly:
//
//   · no row may be `met` without a resolvable evidence pointer — the renderer must be
//     STRUCTURALLY incapable of an unevidenced claim;
//   · a deliberately low-maturity fixture must score LOW — the lens must not be tuned to the shape
//     of the one repo it was developed against.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMaturityLens,
  scoreFeedbackRemediationLoop,
  scoreVerdict,
  NOT_INSTRUMENTED,
  LADDER_CITATION,
} from './maturity-lens.mjs';

/** A repo doing essentially everything: reviewed, gated, parallel, agent-written, disciplined. */
const HIGH = {
  // NOTE THE FIELD NAMES. The lens reads `reviewComments[].isAgentReviewer` and `ciCheckNames` —
  // the NORMALISED shape produced by pod-report.mjs's adapter — not gh's raw `comments`/
  // `statusCheckRollup`. An earlier version of this fixture used gh's names, so the two scorers
  // that matter most never saw their data and HIGH scored the same step as LOW: the high-maturity
  // path was effectively unverified while the suite stayed green. Cross-review caught it.
  prs: Array.from({ length: 20 }, (_, i) => ({
    number: i + 1,
    // OVERLAPPING lifetimes, deliberately: the worktree-isolation criterion looks for two PRs open
    // at the same time as its proxy for parallel agents. An earlier fixture put each PR on its own
    // calendar day, so nothing overlapped and the criterion read `not_met` — the fixture failed to
    // represent the very practice it was meant to demonstrate.
    createdAt: `2026-07-10T${String(i).padStart(2, '0')}:00:00Z`,
    mergedAt: `2026-07-11T${String(i).padStart(2, '0')}:00:00Z`,
    body: 'Risk tier: LOW\n\nCross-agent review (Antigravity): clean.',
    reviewComments: [
      { body: '### 🔎 Cross-agent review (Antigravity)\n\nNo blocking findings.', isAgentReviewer: true },
    ],
    ciCheckNames: ['Static gate + build', 'Playwright vs local Supabase'],
    checks: [{ name: 'Static gate + build', conclusion: 'success' }],
    headRefName: `feat/thing-${i}`,
    // The last two scorers need these, and a fixture missing them leaves those criteria
    // `not_instrumented` — which the lens correctly refuses to climb the ladder on.
    // Every PR HIGH-tier and human-merged: the risk-tier scorer measures whether HIGH-tier PRs are
    // merged by a human, so a fixture with only a handful of HIGH PRs leaves it under-evidenced.
    riskTier: 'HIGH',
    mergedByIsAgent: false, // a HIGH-tier PR merged by a human = the discipline holding
    ciPassedBeforeMerge: true,
  })),
  commits: Array.from({ length: 100 }, (_, i) => ({
    sha: `sha${i}`,
    date: '2026-07-10',
    subject: `feat: thing ${i}`,
    agentCoAuthored: i < 90,
    isRevert: false,
  })),
  ciCheckNames: ['Static gate + build', 'Playwright vs local Supabase'],
  hasClaudeMd: true,
  skillsProvenance: ['ways-of-work'],
};

/** A repo doing none of it: no review, no checks, no agents, no standards. */
const LOW = {
  prs: [
    {
      number: 1,
      createdAt: '2026-07-01T00:00:00Z',
      mergedAt: '2026-07-01T01:00:00Z',
      body: '',
      comments: [],
      checks: [],
      headRefName: 'main',
    },
  ],
  commits: [{ sha: 'a', date: '2026-07-01', subject: 'wip', agentCoAuthored: false }],
  ciCheckNames: [],
  hasClaudeMd: false,
  skillsProvenance: [],
};

const rowsOf = (input) => computeMaturityLens(input).rows;

test('ACCEPTANCE: no row can be `met` without a resolvable evidence pointer', () => {
  // The structural guarantee sprint-2.md demands. Checked across BOTH fixtures so it holds for a
  // row that legitimately earned `met` and for one that did not.
  for (const input of [HIGH, LOW]) {
    for (const row of rowsOf(input)) {
      assert.ok(['met', 'not_met', 'not_instrumented'].includes(row.status), `bad status: ${row.status}`);
      if (row.status === 'met') {
        assert.ok(row.evidence, `${row.criterion} is met with no evidence field`);
        const text = typeof row.evidence === 'string' ? row.evidence : JSON.stringify(row.evidence);
        assert.ok(text.length > 3, `${row.criterion} has an empty evidence pointer`);
      }
    }
  }
});

test('ACCEPTANCE: a deliberately LOW-maturity repo scores lower than a high-maturity one', () => {
  // The lens must not be tuned to the shape of the repo it was built against.
  const high = computeMaturityLens(HIGH).verdict;
  const low = computeMaturityLens(LOW).verdict;
  assert.ok(low.step < high.step, `low (${low.step}) must score below high (${high.step})`);
  assert.ok(low.metCriteria < high.metCriteria);
  // And HIGH must actually reach the upper rungs. Without this the assertion above passes when
  // BOTH fixtures score step 1 — which is exactly what happened while the fixture used gh's field
  // names: a green test that verified nothing about high maturity.
  // A COMPLETELY instrumented fixture must clear step 1. Note what this does NOT assert: that a
  // partially-instrumented repo climbs. The lens deliberately refuses to advance on a
  // `not_instrumented` row — unmeasured is not met — and an earlier version of this assertion
  // demanded the opposite, which would have been a request to inflate the score.
  assert.ok(high.step >= 2, `a fully-instrumented repo must clear step 1, got ${high.step}`);
  assert.ok(
    high.metCriteria >= 5,
    `HIGH should satisfy most criteria, got ${high.metCriteria}/${high.totalCriteria}`
  );
});

test('ACCEPTANCE: the verdict ALWAYS travels with the not-instrumented count', () => {
  // Coverage can never be hidden by the score, because they are returned from the same call — a
  // renderer cannot show one without having the other in hand.
  for (const input of [HIGH, LOW, {}]) {
    const { verdict } = computeMaturityLens(input);
    assert.equal(typeof verdict.step, 'number');
    assert.equal(typeof verdict.notInstrumentedCount, 'number');
    assert.ok(
      verdict.notInstrumentedCount >= NOT_INSTRUMENTED.length,
      'the fixed v1 gaps must always be included in the count'
    );
  }
});

test('every not-instrumented gap names a reason AND the guardrail that would close it', () => {
  // The epic's design: an honest gap doubles as the upsell. A gap without its remedy is an apology.
  assert.ok(NOT_INSTRUMENTED.length >= 6);
  for (const row of NOT_INSTRUMENTED) {
    assert.ok(row.label, 'every gap needs a label');
    assert.ok((row.reason ?? '').length > 15, `${row.label} needs a real reason`);
    assert.ok((row.guardrail ?? '').length > 10, `${row.label} must name what would fix it`);
  }
});

test('every derived row states its PROXY nature where it is one', () => {
  // A Co-Authored-By trailer ratio is a proxy for "the agent wrote most of the code", not proof.
  const row = rowsOf(HIGH).find((r) => /most of the code/i.test(r.criterion));
  assert.ok(row, 'the trailer-ratio criterion must exist');
  const text = `${row.proxyNote ?? ''}${row.note ?? ''}${row.interpretation ?? ''}`;
  assert.match(text, /proxy/i, 'the trailer-ratio row must admit it is a proxy');
});

test('the ladder citation is version-pinned, so an old report stays interpretable', () => {
  assert.ok(LADDER_CITATION.title);
  assert.ok(LADDER_CITATION.author);
  assert.ok(LADDER_CITATION.date, 'without a date, a future ladder revision silently rescores history');
  const { ladder } = computeMaturityLens(HIGH);
  assert.deepEqual(ladder, LADDER_CITATION);
});

test('an EMPTY input scores step 0 and claims nothing', () => {
  // The pathological case: no data must never produce a flattering position.
  const { verdict, rows } = computeMaturityLens({});
  assert.equal(verdict.step, 0);
  assert.equal(rows.filter((r) => r.status === 'met').length, 0);
});

test('the lens is DETERMINISTIC — same input, byte-identical output, twice', () => {
  assert.equal(JSON.stringify(computeMaturityLens(HIGH)), JSON.stringify(computeMaturityLens(HIGH)));
  assert.equal(JSON.stringify(computeMaturityLens({})), JSON.stringify(computeMaturityLens({})));
});

test('scoreVerdict never reports a step above what the evidence supports', () => {
  // A row set with nothing met cannot yield a positive step, whatever the ladder logic does.
  const allUnmet = [
    { criterion: 'a', status: 'not_met', ladderStep: 2 },
    { criterion: 'b', status: 'not_instrumented', ladderStep: 3 },
  ];
  assert.equal(scoreVerdict(allUnmet).step, 0);
  assert.ok(scoreVerdict(allUnmet).notInstrumentedCount >= NOT_INSTRUMENTED.length);
});

// ── Feedback remediation loop — signals-loop Story 3.3b ─────────────────────────────────────

test('feedback remediation reaches Step 4 exactly at the scaled-evidence threshold', () => {
  const row = scoreFeedbackRemediationLoop({
    taskLifecycle: {
      agentResolvedTotal: 3,
      agentResolvedWithEvidence: 3,
      sampleEvidencePointer: 'https://github.com/golden-beans/golden-beans/commit/abc123',
    },
  });
  assert.equal(row.status, 'met');
  assert.equal(row.evidence.ref, 'https://github.com/golden-beans/golden-beans/commit/abc123');
  assert.match(row.evidence.detail, /3 agent-resolved task\(s\).*3 total; threshold: 3/);
  assert.equal(
    computeMaturityLens({ taskLifecycle: { agentResolvedTotal: 3, agentResolvedWithEvidence: 3 } }).rows.at(
      -1
    ).id,
    'feedback_remediation_loop'
  );
});

test('feedback remediation is not met one evidenced resolution below the scaled threshold', () => {
  const row = scoreFeedbackRemediationLoop({
    taskLifecycle: { agentResolvedTotal: 3, agentResolvedWithEvidence: 2 },
  });
  assert.equal(row.status, 'not_met');
  assert.match(row.reason, /2 agent-resolved task\(s\).*below the 3 required/);
  assert.match(row.reason, /1 lack resolvable pointers; an unevidenced resolution is not counted/);
});

test('feedback remediation is not instrumented when task-lifecycle data is absent, malformed, or non-numeric', () => {
  for (const taskLifecycle of [
    undefined,
    'not an object',
    { agentResolvedTotal: '3', agentResolvedWithEvidence: 3 },
  ]) {
    const row = scoreFeedbackRemediationLoop({ taskLifecycle });
    assert.equal(row.status, 'not_instrumented');
    assert.equal(row.evidence, null);
  }
});

test('ACCEPTANCE: an unevidenced agent resolution can never produce a met feedback-remediation row', () => {
  // A free-text "done" note is real work, but it is not auditable remediation evidence. Counting
  // it would let an unverifiable closure move the public maturity claim to Step 4.
  const row = scoreFeedbackRemediationLoop({
    taskLifecycle: { agentResolvedTotal: 3, agentResolvedWithEvidence: 0 },
  });
  assert.equal(row.status, 'not_met');
  assert.equal(row.evidence, null);
  assert.match(row.reason, /3 lack resolvable pointers; an unevidenced resolution is not counted/);
});

// ── Regression from cross-review round 3 ────────────────────────────────────────────────────

test('the standards evidence cites the file that ACTUALLY exists, not a hardcoded name', () => {
  // The lens's central promise is that a `met` row's evidence pointer resolves to a real object. A
  // pointer reading "CLAUDE.md" for a repo whose file is AGENTS.md does not resolve — it is a
  // met row whose evidence is wrong, which is the failure this whole design forbids.
  const withAgents = computeMaturityLens({ ...HIGH, hasClaudeMd: true, standardsFile: 'AGENTS.md' });
  const row = withAgents.rows.find((r) => /Standards encoded/.test(r.criterion));
  assert.equal(row.status, 'met');
  assert.equal(row.evidence.ref, 'AGENTS.md');
  assert.match(row.evidence.detail, /AGENTS\.md/);
});

test('"measured and absent" stays not_met, distinct from "never measured"', () => {
  // Collapsing the boolean into the filename regressed this row from not_met to not_instrumented,
  // turning "we checked and there is none" back into "we never checked" — the exact distinction
  // this epic turns on.
  const measuredAbsent = computeMaturityLens({ ...HIGH, hasClaudeMd: false, standardsFile: undefined });
  assert.equal(measuredAbsent.rows.find((r) => /Standards encoded/.test(r.criterion)).status, 'not_met');

  const neverMeasured = computeMaturityLens({ ...HIGH, hasClaudeMd: undefined, standardsFile: undefined });
  assert.equal(
    neverMeasured.rows.find((r) => /Standards encoded/.test(r.criterion)).status,
    'not_instrumented'
  );
});

// ── Regression from cross-review round 5 ────────────────────────────────────────────────────

test('an UNKNOWN merge identity can never produce a `met` risk-tier row', () => {
  // The worst failure this lens can produce, and it shipped for four rounds: filtering on
  // `mergedByIsAgent === true` meant a PR whose merger was never captured counted as "not a
  // violation", so the row returned `met` with the evidence "N of N merged under a human identity"
  // — a specific, checkable-looking claim about data that does not exist.
  const unidentified = {
    prs: [
      { number: 1, mergedAt: '2026-07-01T00:00:00Z', riskTier: 'HIGH' }, // no mergedByIsAgent at all
      { number: 2, mergedAt: '2026-07-02T00:00:00Z', riskTier: 'HIGH', mergedByIsAgent: undefined },
    ],
    commits: [],
  };
  const row = computeMaturityLens(unidentified).rows.find((r) =>
    /Risk-tier merge discipline/.test(r.criterion)
  );
  assert.equal(row.status, 'not_instrumented', 'unknown identity must never read as met');
  assert.ok(!row.evidence, 'a not-instrumented row must carry no evidence pointer');
  assert.match(row.reason, /none records who merged it/i);
});

test('a KNOWN human merge still earns met, and the evidence counts only what was checked', () => {
  const mixed = {
    prs: [
      { number: 10, mergedAt: '2026-07-01T00:00:00Z', riskTier: 'HIGH', mergedByIsAgent: false },
      { number: 11, mergedAt: '2026-07-02T00:00:00Z', riskTier: 'HIGH' }, // identity unknown → excluded
    ],
    commits: [],
  };
  const row = computeMaturityLens(mixed).rows.find((r) => /Risk-tier merge discipline/.test(r.criterion));
  assert.equal(row.status, 'met');
  // "1 of 1" — the identified subset — plus an explicit note that one PR was excluded. Saying
  // "2 of 2" would be true-looking and misleading.
  assert.match(row.evidence.detail, /1 of 1/);
  assert.match(row.evidence.detail, /1 further HIGH-risk PR\(s\) record no merger/);
});

test('a KNOWN agent merge is a real violation, not hidden by the new guard', () => {
  const violating = {
    prs: [{ number: 20, mergedAt: '2026-07-01T00:00:00Z', riskTier: 'HIGH', mergedByIsAgent: true }],
    commits: [],
  };
  const row = computeMaturityLens(violating).rows.find((r) => /Risk-tier merge discipline/.test(r.criterion));
  assert.equal(row.status, 'not_met');
  assert.match(row.reason, /agent identity/i);
});
