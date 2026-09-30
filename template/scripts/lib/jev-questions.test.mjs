// jev-questions.test.mjs — the question files, their loader and the wording hash (compiled-prompts D2/D3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadQuestions,
  parseQuestions,
  QUESTION_SETS,
  questionHash,
  wireQuestion,
} from './jev-questions.mjs';

const fixtures = JSON.parse(readFileSync(new URL('../jev-eval.fixtures.json', import.meta.url), 'utf8'));

test('every set loads, and every question carries a measurement or says why it has none', () => {
  for (const set of QUESTION_SETS) {
    const qs = loadQuestions(set);
    assert.ok(qs.length > 0, set);
    for (const q of qs)
      assert.ok(q.measured ? q.measured.right <= q.measured.n : q.unmeasured, `${set}.${q.id}`);
  }
});

test('the loaded wording is the wording every committed recording answered (the move was byte-identical)', () => {
  let pinned = 0;
  for (const set of QUESTION_SETS) {
    const byId = Object.fromEntries(loadQuestions(set).map((q) => [q.id, questionHash(q)]));
    for (const fx of fixtures[set])
      for (const [id, hash] of Object.entries(fx.recorded?.questionHashes ?? {})) {
        assert.equal(byId[id], hash, `${set}/${fx.id}: ${id}`);
        pinned++;
      }
  }
  assert.ok(pinned > 250, `checked ${pinned} stamps`);
});

test('the guards hold no question text: it lives only in the JSON', () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const holders = {
    review: src('./review-guard.mjs'),
    prose: src('./prose-guard.mjs'),
    intent: src('../intent-match.mjs'),
  };
  for (const set of QUESTION_SETS)
    for (const q of loadQuestions(set)) {
      assert.ok(!holders[set].includes(q.instructions), `${set}.${q.id}'s question is still in code`);
      const texts = Array.isArray(q.criteria) ? q.criteria : Object.values(q.criteria);
      for (const t of texts)
        assert.ok(!holders[set].includes(t), `${set}.${q.id}'s criteria are still in code`);
    }
});

test('questionHash covers only what Jev receives: one changed character moves it, the id and measurement do not', () => {
  const [q] = loadQuestions('review');
  assert.equal(questionHash(q), questionHash({ ...q, id: 'renamed', measured: null }));
  assert.notEqual(questionHash(q), questionHash({ ...q, instructions: `${q.instructions} ` }));
  assert.notEqual(
    questionHash(q),
    questionHash({ ...q, criteria: { ...q.criteria, false: q.criteria.false.replace('No', 'no') } })
  );
  assert.deepEqual(Object.keys(wireQuestion(q)), ['type', 'instructions', 'criteria']);
});

test('loadQuestions returns a fresh copy each call, and refuses an unknown set', () => {
  const a = loadQuestions('prose');
  a[0].instructions = 'mutated';
  assert.notEqual(loadQuestions('prose')[0].instructions, 'mutated');
  assert.throws(() => loadQuestions('lint'), /unknown set "lint"/);
});

test('parseQuestions refuses every malformed shape, naming the field', () => {
  const noul = { true: 't', false: 'f' };
  const measured = { model: 'jev-1.13.0', date: '2026-09-30', n: 3, decided: 2, right: 2, how: 'h' };
  const q = (over = {}) => ({ id: 'a', type: 'noul', instructions: 'i', criteria: noul, measured, ...over });
  const file = (...qs) => ({ questions: qs });
  const refuse = (set, raw, re) => assert.throws(() => parseQuestions(set, raw), re);
  assert.equal(parseQuestions('review', file(q())).length, 1);
  refuse('review', { questions: [q()], extra: 1 }, /unknown key\(s\) extra/);
  refuse('review', file(), /non-empty array/);
  refuse('review', file(q({ oops: 1 })), /unknown key\(s\) oops/);
  refuse('review', file(q(), q()), /unique/);
  refuse('review', file(q({ code: 'x' })), /code is only for prose/);
  refuse('prose', file(q()), /code is required/);
  refuse('review', file(q({ instructions: ' ' })), /instructions/);
  refuse('review', file(q({ criteria: { ...noul, maybe: 'm' } })), /exactly \{ true, false \}/);
  refuse('review', file(q({ type: 'choice', criteria: { only: 'one' } })), /at least two labels/);
  refuse('review', file(q({ type: 'score', criteria: { a: 'b', c: 'd' } })), /array of at least two levels/);
  refuse('review', file(q({ type: 'maybe' })), /noul, choice or score/);
  refuse('review', file(q({ measured: null })), /must say why/);
  refuse('review', file(q({ unmeasured: 'x' })), /only for a null/);
  refuse('review', file(q({ measured: { ...measured, right: 3 } })), /right ≤ decided ≤ n/);
  refuse('review', file(q({ measured: { ...measured, date: 'Sept 30' } })), /YYYY-MM-DD/);
  refuse('review', file(q({ measured: { ...measured, extra: 1 } })), /must be \{ model/);
  assert.equal(
    parseQuestions('review', file(q({ measured: null, unmeasured: 'no labels' })))[0].measured,
    null
  );
});
