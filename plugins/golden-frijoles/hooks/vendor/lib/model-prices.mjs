// model-prices.mjs — ONE dated price table for the ≈ API $ an epic cost (finops D3, D18).
//
// "≈ API $" is a LIST-PRICE EQUIVALENT: what the same tokens would have cost on the Claude API at the prices below.
// It is not what anyone was billed (a subscription is not billed per token), and it says so wherever it is shown.
// A stamped actual keeps the $ it was stamped with; changing this table re-prices only what is measured after.
//
// Read from the official pricing page on PRICES_AS_OF. To update: re-read that page, change the rows and the date
// in ONE commit, and say in the CHANGELOG which models moved.
//
// Zero deps, no imports.

export const PRICES_AS_OF = '2026-10-02';
export const PRICES_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';

// USD per million tokens, per kind. `fast`: the page lists fast-mode pricing for this model, at 2× (Opus 5.5 $8/$40,
// Opus 5 and Opus 4.8 $10/$50); the prompt-caching multipliers stack on top, so every kind doubles.
const row = (input, cache_write_5m, cache_write_1h, cache_read, output, fast = false) =>
  Object.freeze({ input, cache_write_5m, cache_write_1h, cache_read, output, fast });

export const PRICES = Object.freeze({
  'claude-fable-5-1': row(10, 12.5, 20, 0.25, 50),
  'claude-mythos-5-1': row(10, 12.5, 20, 0.25, 50),
  'claude-fable-5': row(10, 12.5, 20, 1, 50),
  'claude-mythos-5': row(10, 12.5, 20, 1, 50),
  'claude-opus-5-5': row(4, 5, 8, 0.2, 20, true),
  'claude-opus-5': row(5, 6.25, 10, 0.5, 25, true),
  'claude-opus-4-8': row(5, 6.25, 10, 0.5, 25, true),
  'claude-opus-4-7': row(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-6': row(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-5': row(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-1': row(15, 18.75, 30, 1.5, 75),
  'claude-opus-4': row(15, 18.75, 30, 1.5, 75),
  'claude-sonnet-5-5': row(2, 2.5, 4, 0.2, 10),
  'claude-sonnet-5': row(2, 2.5, 4, 0.2, 10),
  'claude-sonnet-4-6': row(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4-5': row(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4': row(3, 3.75, 6, 0.3, 15),
  'claude-haiku-4-5': row(1, 1.25, 2, 0.1, 5),
  'claude-haiku-3-5': row(0.8, 1, 1.6, 0.08, 4),
});

/** The token kinds a usage record carries, in the order every report prints them. */
export const TOKEN_KINDS = Object.freeze([
  'input',
  'output',
  'cache_read',
  'cache_write_5m',
  'cache_write_1h',
]);

/** `claude-haiku-4-5-20251001` → `claude-haiku-4-5`: a dated snapshot is priced as its model. */
export function normalizeModel(model) {
  return String(model || '').replace(/-\d{8}$/, '');
}

/** The price row for a model id, or null when the table does not know it (→ `$ unknown`, never $0 — D4). */
export function priceFor(model) {
  return PRICES[normalizeModel(model)] ?? null;
}

/**
 * The tokens of one transcript `message.usage`, split by kind. A cache write with no 5m/1h split is counted as 5m
 * (the cheaper rate — so the $ is never overstated) and reported in `unsplit_cache_write`.
 */
export function tokensOf(usage) {
  const u = usage || {};
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const split = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const total = n(u.cache_creation_input_tokens);
  let w5 = split ? n(split.ephemeral_5m_input_tokens) : 0;
  const w1 = split ? n(split.ephemeral_1h_input_tokens) : 0;
  let unsplit = 0;
  if (!split || w5 + w1 < total) {
    unsplit = total - w5 - w1;
    w5 += unsplit;
  }
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cache_read: n(u.cache_read_input_tokens),
    cache_write_5m: w5,
    cache_write_1h: w1,
    unsplit_cache_write: unsplit,
  };
}

/**
 * ≈ API $ for one turn: Σ tokens × price per kind, × 2 in fast mode, × 1.1 for US-only inference. null when it cannot
 * be priced (an unknown model, or fast mode on a model the page lists no fast price for).
 */
export function usdOf(model, tokens, { speed = 'standard', inferenceGeo = null } = {}) {
  const p = priceFor(model);
  if (!p) return null;
  let mult = 1;
  if (speed === 'fast') {
    if (!p.fast) return null;
    mult *= 2;
  }
  if (inferenceGeo === 'us') mult *= 1.1;
  let usd = 0;
  for (const kind of TOKEN_KINDS) usd += ((tokens[kind] || 0) * p[kind]) / 1e6;
  return usd * mult;
}
