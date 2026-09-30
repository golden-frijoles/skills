// jev-questions.mjs — every Jev question the kit asks, as data, and the hash a recording pins it by
// (compiled-prompts D2/D3).
//
// A question is exactly what Jev receives — `{ type, instructions, criteria }` — so the file IS the wire shape:
// no translation layer between what a maintainer edits and what `askJev` sends. `criteria` is `{ true, false }`
// for a noul, `{ label: text }` for a choice and `[level…]` for a score. Beside it, `measured` says how well that
// exact wording decided on the labelled fixtures (or is null, with an `unmeasured` reason, where no labels exist).
//
//   lib/jev-questions/review.json   the review rail (lib/review-guard.mjs)
//   lib/jev-questions/prose.json    the prose rail's four families (lib/prose-guard.mjs); each also names its `code`
//   lib/jev-questions/intent.json   intent-match's question sets (intent-match.mjs)
//
// The semantic-lint rule questions are NOT here: they are each project's own data (`lint.rules[]`), in the same
// `{ instructions, criteria }` shape (compiled-prompts D7).
//
// Zero deps — Node 18+.

import { readFileSync } from 'node:fs';
import { textHash } from './jev.mjs';

export const QUESTION_SETS = ['review', 'prose', 'intent'];

/**
 * Pins a recording to the wording that produced it (D3): an edited question must be re-measured with
 * `jev-eval --live`, never replayed green on answers Jev gave to the old text. Only the three fields Jev
 * receives are hashed, in a fixed order, so the `measured` block and the id can change without a re-record.
 */
export const questionHash = (q) =>
  textHash(JSON.stringify({ type: q.type, instructions: q.instructions, criteria: q.criteria }));

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isCount = (v) => Number.isInteger(v) && v >= 0;
const ENTRY_KEYS = new Set(['id', 'code', 'type', 'instructions', 'criteria', 'measured', 'unmeasured']);
const MEASURED_KEYS = ['model', 'date', 'n', 'decided', 'right', 'how'];

/** Pure: validate one set's parsed file and return its questions. Throws naming the first bad field. */
export function parseQuestions(set, raw) {
  const fail = (msg) => {
    throw new Error(`jev-questions/${set}.json: ${msg}`);
  };
  if (!isObj(raw)) fail('must be an object { "$comment", "questions": [...] }');
  const extra = Object.keys(raw).filter((k) => k !== '$comment' && k !== 'questions');
  if (extra.length) fail(`unknown key(s) ${extra.join(', ')}`);
  if (!Array.isArray(raw.questions) || !raw.questions.length) fail('`questions` must be a non-empty array');
  const seen = new Set();
  return raw.questions.map((q, i) => {
    const at = `questions[${i}]`;
    if (!isObj(q)) fail(`${at} must be an object`);
    const unknown = Object.keys(q).filter((k) => !ENTRY_KEYS.has(k));
    if (unknown.length) fail(`${at} has unknown key(s) ${unknown.join(', ')}`);
    if (!isText(q.id) || seen.has(q.id)) fail(`${at}.id must be a unique non-empty string`);
    seen.add(q.id);
    if (set === 'prose' ? !isText(q.code) : q.code !== undefined)
      fail(`${at}.code is ${set === 'prose' ? 'required (the finding it raises)' : 'only for prose'}`);
    if (!isText(q.instructions)) fail(`${at}.instructions must be a non-empty string`);
    const c = q.criteria;
    if (q.type === 'noul') {
      if (!isObj(c) || Object.keys(c).sort().join() !== 'false,true' || !isText(c.true) || !isText(c.false))
        fail(`${at}.criteria for a noul must be exactly { true, false }, both text`);
    } else if (q.type === 'choice') {
      if (!isObj(c) || Object.keys(c).length < 2 || !Object.values(c).every(isText))
        fail(`${at}.criteria for a choice must be { label: text } with at least two labels`);
    } else if (q.type === 'score') {
      if (!Array.isArray(c) || c.length < 2 || !c.every(isText))
        fail(`${at}.criteria for a score must be an array of at least two levels`);
    } else fail(`${at}.type must be noul, choice or score`);
    if (q.measured === null) {
      if (!isText(q.unmeasured)) fail(`${at}: measured is null, so \`unmeasured\` must say why`);
    } else {
      const m = q.measured;
      if (q.unmeasured !== undefined) fail(`${at}: \`unmeasured\` is only for a null \`measured\``);
      if (!isObj(m) || Object.keys(m).sort().join() !== [...MEASURED_KEYS].sort().join())
        fail(`${at}.measured must be { ${MEASURED_KEYS.join(', ')} } or null`);
      if (!isText(m.model) || !/^\d{4}-\d{2}-\d{2}$/.test(m.date) || !isText(m.how))
        fail(`${at}.measured needs a model, a YYYY-MM-DD date and how it was counted`);
      if (![m.n, m.decided, m.right].every(isCount) || m.right > m.decided || m.decided > m.n)
        fail(`${at}.measured needs whole counts with right ≤ decided ≤ n`);
    }
    return q;
  });
}

/** Read and validate one set from the JSON beside this module. A fresh copy per call: callers may not share state. */
export function loadQuestions(set, { read = readFileSync } = {}) {
  if (!QUESTION_SETS.includes(set))
    throw new Error(`jev-questions: unknown set "${set}" (${QUESTION_SETS.join(', ')})`);
  const raw = JSON.parse(read(new URL(`./jev-questions/${set}.json`, import.meta.url), 'utf8'));
  return parseQuestions(set, raw);
}

/** The question as `askJev` sends it — the three fields the hash covers, nothing else. */
export const wireQuestion = ({ type, instructions, criteria }) => ({ type, instructions, criteria });
