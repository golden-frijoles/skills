#!/usr/bin/env node
// quote.mjs — the quote for an appetite, calibrated from this project's own shipped epics (finops S2.2, D7).
//
//   node scripts/quote.mjs --appetite M          # one line: $30–55 (M, n=6, p25–p75)
//   node scripts/quote.mjs --appetite M --json   # for the scaffolder and the band
//   node scripts/quote.mjs --report              # per appetite: how many actuals landed inside their quote
//
// The quote is the p25–p75 of `actual_usd` over SHIPPED epics at the same appetite — the middle half of what epics
// that size actually cost here. Until there are MIN_HISTORY of them it is WIDE_DEFAULT, labelled `wide` with its n,
// never a guess dressed as a calibration (D4). It is recomputed at every groom, so it moves as history accumulates.
// Epics are read through the extractor (`buildRows`), so appetite follows the board's own rule (README, else seed —
// D20) and no second frontmatter reader exists.
//
// The unit is ≈ API $ (list-price equivalent, D3) — see lib/model-prices.mjs.
//
// Zero deps — Node 18+.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRows } from './roadmap-extract.mjs';
import { projectRoot } from './lib/project-root.mjs';

export const APPETITES = Object.freeze(['S', 'M', 'L']);
export const MIN_HISTORY = 3;
/** The band before there is history (≈ API $). Deliberately wide: it says "we don't know yet", in dollars. */
export const WIDE_DEFAULT = Object.freeze({ S: [5, 40], M: [20, 120], L: [50, 300] });

/** Linear-interpolated percentile (p in 0..1) of a sorted list. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** The shipped actuals at an appetite, ascending. An epic with a quote but no actual is ignored. */
export function actualsAt(rows, appetite) {
  return rows
    .filter((r) => r.grain === 'Epic' && r.status === 'Shipped' && r.appetite === appetite)
    .map((r) => r.actual_usd)
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
}

/** `M, n=5, p25–p75` / `M, n=2, wide` — the basis string the scaffolder writes and the band reads. */
export function basisOf(q) {
  return `${q.appetite}, n=${q.n}, ${q.kind}`;
}

/** The quote for an appetite: { appetite, low, high, n, kind: 'p25–p75' | 'wide', basis, line }. */
export function quoteFor(rows, appetite) {
  if (!APPETITES.includes(appetite))
    throw new Error(`appetite must be one of ${APPETITES.join(', ')} (got ${appetite})`);
  const xs = actualsAt(rows, appetite);
  const calibrated = xs.length >= MIN_HISTORY;
  const [low, high] = calibrated
    ? [Math.floor(percentile(xs, 0.25)), Math.ceil(percentile(xs, 0.75))]
    : WIDE_DEFAULT[appetite];
  const q = { appetite, low, high, n: xs.length, kind: calibrated ? 'p25–p75' : 'wide' };
  return { ...q, basis: basisOf(q), line: `$${low}–${high} (${basisOf(q)})` };
}

/**
 * The calibration signal: per appetite, of the shipped epics that carry BOTH a quote and an actual, how many landed
 * inside it, and the n behind today's quote.
 */
export function calibrationReport(rows) {
  return APPETITES.map((appetite) => {
    const judged = rows.filter(
      (r) =>
        r.grain === 'Epic' &&
        r.status === 'Shipped' &&
        r.appetite === appetite &&
        typeof r.actual_usd === 'number' &&
        typeof r.quote_low_usd === 'number' &&
        typeof r.quote_high_usd === 'number'
    );
    const inside = judged.filter(
      (r) => r.actual_usd >= r.quote_low_usd && r.actual_usd <= r.quote_high_usd
    ).length;
    const over = judged.filter((r) => r.actual_usd > r.quote_high_usd).length;
    return {
      appetite,
      quote: quoteFor(rows, appetite),
      judged: judged.length,
      inside,
      over,
      under: judged.length - inside - over,
    };
  });
}

function main(argv) {
  const i = argv.indexOf('--repo-root');
  const root = resolve(i !== -1 && argv[i + 1] ? argv[i + 1] : projectRoot());
  const rows = buildRows({ root, dates: false });
  if (argv.includes('--report')) {
    const rep = calibrationReport(rows);
    if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(rep, null, 2)}\n`);
    else
      for (const r of rep)
        process.stdout.write(
          `${r.appetite}  quote ${r.quote.line} · ${r.judged ? `${r.inside} of ${r.judged} landed inside (${r.over} over, ${r.under} under)` : 'no quoted epic has shipped yet'}\n`
        );
    return 0;
  }
  const a = argv.indexOf('--appetite');
  const appetite = a !== -1 ? String(argv[a + 1] || '').toUpperCase() : null;
  if (!appetite) {
    process.stderr.write('usage: quote.mjs --appetite S|M|L [--json] | --report [--json]\n');
    return 2;
  }
  const q = quoteFor(rows, appetite);
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(q)}\n` : `${q.line}\n`);
  return 0;
}

const isMain = (() => {
  try {
    return (
      !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`quote: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 2;
  }
}
