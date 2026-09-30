// jev-report.test.mjs — the agreement report and the labelling round-trip (jev-semantic-guards S5.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendLabels, classify, dedupe, markerRows, parseLog, render, renderLint, summarize, summarizeLint } from './jev-report.mjs';
import { jevMarker } from './lib/review-guard.mjs';

const T = { review: { real: 0.85, notReal: 0.3 }, prose: { claim: 0.8 } };
const rv = (regex, confidence, extra = {}) => ({
  rail: 'review',
  regex,
  confidence,
  textHash: `h${Math.random()}`,
  text: 't',
  ...extra,
});
const pr = (regex, jev, extra = {}) => ({
  rail: 'prose',
  regex,
  jev,
  confidence: 0.9,
  textHash: `p${Math.random()}`,
  text: 'd',
  ...extra,
});

test('classify: review agreement, disagreement, the uncertain band and could-not-look', () => {
  assert.equal(classify(rv(true, 0.97), T), 'agree');
  assert.equal(classify(rv(true, 0.05), T), 'disagree');
  assert.equal(classify(rv(false, 0.97), T), 'disagree');
  assert.equal(classify(rv(true, 0.5), T), 'uncertain');
  assert.equal(classify(rv(true, null), T), 'could-not-look');
  assert.equal(classify(rv(true, 0.9, { error: 'HTTP 429' }), T), 'could-not-look');
});

test('classify: prose compares code SETS, order-free', () => {
  assert.equal(classify(pr(['a', 'b'], ['b', 'a']), T), 'agree');
  assert.equal(classify(pr([], ['invented-commitment']), T), 'disagree');
  assert.equal(classify(pr([], null), T), 'could-not-look');
});

test('parseLog skips blank and malformed lines; dedupe keeps one row per text per source', () => {
  const { rows, bad } = parseLog(
    '{"rail":"review","textHash":"a"}\n\nnot json\n{"rail":"review","textHash":"a"}\n'
  );
  assert.equal(bad, 1);
  assert.equal(dedupe(rows).length, 1);
});

test('markerRows: a posted comment is a regex-ACCEPTED reply with Jev’s noul; no marker, no row', () => {
  const body = `### 🔎 Cross-agent review (x)\n\n---\n\nClean.${jevMarker({ mode: 'shadow', decider: 'regex', jev: { noul: 0.1, severity: 'clean', model: 'm' } })}`;
  const rows = markerRows([
    { url: 'u', body, reply: 'Clean.' },
    { url: 'v', body: 'plain' },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].regex, rows[0].confidence], [true, 0.1]);
  assert.equal(classify(rows[0], T), 'disagree');
});

test('summarize + render: per-rail agreement and a disagreement table with a label column', () => {
  const { summary, candidates } = summarize(
    [rv(true, 0.97), rv(true, 0.05), pr([], []), pr([], ['invented-commitment'])],
    T
  );
  assert.equal(summary.review.agreement, 0.5);
  assert.equal(summary.prose.disagree, 1);
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((c) => c.label === null));
  const md = render({ summary, candidates });
  assert.match(md, /\| review \| 2 \| 50\.0% \|/);
  assert.match(md, /\| label: \|/);
});

test('appendLabels: only labelled rows are appended, unrecorded, never twice', () => {
  const fixtures = { review: [{ id: 'old' }], prose: [] };
  const labelled = [
    { rail: 'review', id: 'shadow-1', label: false, text: 't', regex: true, jev: 0.1 },
    { rail: 'prose', id: 'shadow-2', label: null, draft: 'd' },
    { rail: 'review', id: 'old', label: true, text: 'x' },
  ];
  const { fixtures: next, added } = appendLabels(fixtures, labelled);
  assert.equal(added, 1);
  assert.deepEqual(next.review[1], {
    id: 'shadow-1',
    label: false,
    text: 't',
    recorded: null,
    decision: null,
  });
});

test('post-flip markers carry the regex verdict: a Jev-only pass is a DISAGREEMENT, not agreement (PR #39)', () => {
  const body = (v) => `x${jevMarker(v)}`;
  const jevOnly = {
    mode: 'jev',
    decider: 'jev',
    regexOk: false,
    jev: { noul: 0.95, severity: 'nit', model: 'm' },
  };
  const rows = markerRows([{ url: 'a', body: body(jevOnly) }]);
  assert.equal(rows[0].regex, false);
  assert.equal(classify(rows[0], T), 'disagree');
  const legacyJev = `x\n<!-- jev:{"mode":"jev","decider":"jev","noul":0.95,"severity":null,"model":null} -->`;
  assert.equal(
    markerRows([{ url: 'b', body: legacyJev }]).length,
    0,
    'a jev marker without regexOk is skipped'
  );
});

test('dedupe: the same comment from the backtest and from its marker counts once', () => {
  const rows = [
    { rail: 'review', textHash: 'h1', source: 'backtest:https://x/1' },
    { rail: 'review', textHash: 'https://x/1', source: 'marker:https://x/1' },
  ];
  assert.equal(dedupe(rows).length, 1);
});

test('appendLabels skips a row with no valid rail instead of throwing', () => {
  const { added } = appendLabels({ review: [], prose: [] }, [{ id: 'z', label: true, rail: 'reviews' }]);
  assert.equal(added, 0);
});

test('monitoring after the flip (codex, #192): could-not-look markers count, off markers do not, newest wins by ts', () => {
  const cnl = `x\n<!-- jev:{"mode":"jev","decider":"regex","regexOk":true,"noul":null,"severity":null,"model":null} -->`;
  const off = `x\n<!-- jev:{"mode":"off","decider":"regex","regexOk":true,"noul":null,"severity":null,"model":null} -->`;
  const rows = markerRows([
    { url: 'a', body: cnl },
    { url: 'b', body: off },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(classify(rows[0], T), 'could-not-look');
  const kept = dedupe([
    { rail: 'review', source: 'marker:u', ts: '2026-09-23T02:00:00Z', confidence: 0.9 },
    { rail: 'review', source: 'backtest:u', ts: '2026-09-22T02:00:00Z', confidence: 0.1 },
  ]);
  assert.equal(kept[0].confidence, 0.9, 'the newer decision wins regardless of input order');
});

test('a marker with no known mode is not evidence (codex, #40)', () => {
  assert.equal(markerRows([{ url: 'a', body: 'x\n<!-- jev:{"noul":null} -->' }]).length, 0);
});

// ── semantic-lint C5: the lint rows get their own report ────────────────────────────────────────

const lintRow = (outcome, { hash = outcome, p = 0.5, ts = '2026-10-01T00:00:00Z', file = 'apps/web/x.ts' } = {}) => ({
  rail: 'lint:rule-1',
  mode: 'shadow',
  decider: outcome === 'not-checked' ? 'not-checked' : 'jev',
  confidence: outcome === 'not-checked' ? null : p,
  textHash: hash,
  text: `hunk ${hash}`,
  source: `${file}@abc`,
  evidence: { file, outcome },
  ts,
});

test('summarizeLint: counts every outcome per rule, lists raised + uncertain to label, drops rows with no outcome', () => {
  const rows = [lintRow('raise', { p: 0.93 }), lintRow('uncertain', { p: 0.6 }), lintRow('clear'), lintRow('not-checked'),
    { ...lintRow('clear', { hash: 'x' }), evidence: {} }, { rail: 'review', confidence: 0.9 }];
  const { summary, toLabel } = summarizeLint(rows);
  assert.deepEqual(summary, { 'lint:rule-1': { n: 4, raise: 1, uncertain: 1, clear: 1, 'not-checked': 1 } });
  assert.deepEqual(toLabel.map((c) => [c.outcome, c.p]), [['raise', 0.93], ['uncertain', 0.6]]);
  assert.match(renderLint({ summary, toLabel }), /\| lint:rule-1 \| 4 \| 25\.0% \| 25\.0% \| 25\.0% \| 25\.0% \|/);
  assert.equal(renderLint(summarizeLint([])), '', 'no lint rows, no section');
});

test('dedupe: one lint row per hunk — two hunks of one file both count, one hunk re-pushed counts once', () => {
  const rows = dedupe([
    lintRow('clear', { hash: 'a', ts: '2026-10-01T00:00:00Z' }),
    lintRow('raise', { hash: 'b', ts: '2026-10-01T00:00:01Z' }),
    lintRow('raise', { hash: 'a', ts: '2026-10-02T00:00:00Z' }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.textHash === 'a').evidence.outcome, 'raise', 'the newest decision wins');
  assert.equal(dedupe([lintRow('clear', { hash: 'a' }), lintRow('clear', { hash: 'a', file: 'apps/web/y.ts' })]).length, 2,
    'the same window in two files is two decisions');
});
