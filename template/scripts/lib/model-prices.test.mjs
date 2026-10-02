// model-prices.test.mjs — the ≈ API $ arithmetic against hand-computed numbers (finops D18).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRICES_AS_OF, PRICES_SOURCE, normalizeModel, priceFor, tokensOf, usdOf } from './model-prices.mjs';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('the table is dated and cites its source', () => {
  assert.match(PRICES_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(PRICES_SOURCE, /^https:\/\/platform\.claude\.com\//);
});

test('one Opus 5.5 turn, by hand: 2 in · 240 out · 25,183 read · 38,537 1h-write', () => {
  const t = tokensOf({
    input_tokens: 2,
    output_tokens: 240,
    cache_read_input_tokens: 25183,
    cache_creation_input_tokens: 38537,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 38537 },
  });
  // 2×4 + 240×20 + 25183×0.20 + 38537×8 = 8 + 4800 + 5036.6 + 308296 = 318140.6 → / 1e6
  close(usdOf('claude-opus-5-5', t), 0.3181406);
});

test('fast mode doubles where the page prices it, and is unknown where it does not', () => {
  const t = tokensOf({ input_tokens: 1e6, output_tokens: 0 });
  close(usdOf('claude-opus-5-5', t, { speed: 'fast' }), 8);
  assert.equal(usdOf('claude-sonnet-5', t, { speed: 'fast' }), null);
});

test('US-only inference is × 1.1; a dated snapshot is priced as its model', () => {
  const t = tokensOf({ input_tokens: 1e6 });
  close(usdOf('claude-haiku-4-5-20251001', t, { inferenceGeo: 'us' }), 1.1);
  assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
});

test('an unknown model is null — never $0 (D4)', () => {
  assert.equal(priceFor('claude-future-9'), null);
  assert.equal(usdOf('claude-future-9', tokensOf({ input_tokens: 5 })), null);
});

test('a cache write with no 5m/1h split is priced as 5m (never overstated) and reported', () => {
  const t = tokensOf({ cache_creation_input_tokens: 1e6 });
  assert.equal(t.cache_write_5m, 1e6);
  assert.equal(t.unsplit_cache_write, 1e6);
  close(usdOf('claude-sonnet-5', t), 2.5);
});
