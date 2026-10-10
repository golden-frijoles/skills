import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, whyFromArgs } from './why-check.mjs';

const sink = () => {
  const s = { text: '', write: (t) => (s.text += t) };
  return s;
};
const STORY =
  'Today a founder ships a feature and cannot tell if anyone used it. Put the switch and the numbers on one page and every bet shows who it reached and who came back. We will know when a founder reads it before the next bet.';

test('why-as-a-story D2: a plain Why passes; one with code is told why; usage is exit 2', () => {
  const ok = sink();
  assert.equal(main([STORY], ok, sink()), 0);
  assert.match(ok.text, /reads in full \(\d of 5 lines\)/);
  const bad = sink();
  assert.equal(main(['We believe that wiring flag_key fixes it.'], bad, sink()), 1);
  assert.match(bad.text, /internal words \(wiring\)/);
  assert.match(bad.text, /code identifier \("flag_key"\)/);
  const err = sink();
  assert.equal(main([], sink(), err), 2);
  assert.match(err.text, /usage/);
});

test('why-as-a-story D2: --seed reads the hypothesis, and says when there is none', () => {
  const read = (p) => (p === 'with.md' ? `---\nhypothesis: "${STORY}"\n---\n# x\n` : '---\nhypothesis: null\n---\n');
  assert.deepEqual(whyFromArgs(['--seed', 'with.md'], read), { text: STORY });
  assert.match(whyFromArgs(['--seed', 'without.md'], read).error, /has no hypothesis/);
  assert.match(whyFromArgs(['--seed'], read).error, /usage/);
});
