#!/usr/bin/env node
// bets-grounded.mjs — the share of a month's bets placed against a North Star input (grounded-bets D2–D4).
//
//   node scripts/bets-grounded.mjs                  # every month in the bets ledger
//   node scripts/bets-grounded.mjs --month 2026-10  # one month
//   node scripts/bets-grounded.mjs --json
//   node scripts/bets-grounded.mjs --push           # post this month's share as the `grounded_bets_share` input value
//
// ── What counts (D3) ──────────────────────────────────────────────────────────────────────────────────────────────
// A month's bets are the epics and seeds whose `underwritten_by:` names a ledger file `wave-YYYY-MM…` (the stamp
// fund.mjs writes; the month from that name). Read from each bet, not from the ledger's rows: the rows' shape changed
// over the months and a bet carries one stamp, so nothing is counted twice. `wave-backfill` has no month and is never
// counted. Bugs and Chores are left out (`type:`): they keep something working and carry no hypothesis.
//
// ── What is grounded (D2) ─────────────────────────────────────────────────────────────────────────────────────────
// Derived from the bet's target, never from its `grounded:` field alone: its `target_metric` is one of the project's
// North Star input keys (`Roadmap/00-strategy/north-star.md`, the sync payload) and `target_from` and `target_to` are
// numbers. A blank `read_date` counts: the read defaults to 30 days after shipping. A bet that records
// `grounded: true` without such a target is reported, not counted. So bets refined before the field existed are
// measured by their targets, with no backfill.
//
// ── The push (D4) ─────────────────────────────────────────────────────────────────────────────────────────────────
// `--push` posts `{ occurredOn: today (UTC), value: this month's share }` to `/api/v1/inputs/grounded_bets_share/values`
// with the same key and URL as roadmap-push.mjs. It skips, cleanly and saying why, when the key is missing, when the
// project's North Star has no `grounded_bets_share` input (so a project never posts to an input it lacks) or when the
// month has no counted bets. The strategy is often private (untracked), so a CI checkout has no `north-star.md`: then
// `--push` asks the engine for the project's input keys (`GET /api/v1/north-star`, the same key) and counts with
// those (verifier, #334: without it the push could never run in CI). The route is append-only per day: the first value of a day stands, and a later different
// one is reported as a mismatch, never an error. Plain fetch, not the SDK: this is a zero-dependency kit script.
//
// Zero deps — Node 18+.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocFrontmatter } from './lib/roadmap-contract.mjs';
import { section } from './lib/strategy-files.mjs';
import { projectRoot } from './lib/project-root.mjs';

export const INPUT_KEY = 'grounded_bets_share';
const NOT_COUNTED_TYPES = new Set(['bug', 'chore']);

/** The North Star input keys in `north-star.md`'s sync payload; [] when there is none or it does not parse. */
export function northStarInputKeys(text) {
  const body = section(text ?? '', 'Sync payload');
  const fence = body && body.match(/```json\n([\s\S]*?)\n```/);
  if (!fence) return [];
  try {
    const inputs = JSON.parse(fence[1])?.inputs;
    return Array.isArray(inputs)
      ? inputs.map((i) => i?.key).filter((k) => typeof k === 'string' && !/^<.*>$/.test(k))
      : [];
  } catch {
    return [];
  }
}

/** `wave-2026-10-04-launch` (or its `.md`) → '2026-10'; null for a ledger with no month (`wave-backfill`). */
export function monthOf(file) {
  const m = /^wave-(\d{4})-(\d{2})(?:[-.]|$)/.exec(file);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** Whether a bet's frontmatter targets a North Star input with a from and a to (D2). */
export function isGrounded(fm, inputKeys) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  return inputKeys.includes(fm.target_metric) && num(fm.target_from) && num(fm.target_to);
}

const recordedTrue = (v) => v === true || v === 'true';

/**
 * Pure: the share per month. `docs` maps a slug to its frontmatter data (seed overlaid by README, readProject). Months
 * come out oldest first.
 */
export function shareByMonth({ docs, inputKeys, month = null }) {
  const months = new Map();
  for (const [slug, fm] of docs) {
    const m = typeof fm.underwritten_by === 'string' ? monthOf(fm.underwritten_by.trim()) : null;
    if (!m || (month && m !== month)) continue;
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(slug);
  }
  return [...months.keys()].sort().map((m) => {
    const counted = [];
    const grounded = [];
    const excluded = [];
    const unbacked = [];
    for (const slug of months.get(m).sort()) {
      const fm = docs.get(slug);
      if (NOT_COUNTED_TYPES.has(String(fm.type ?? '').toLowerCase())) {
        excluded.push(slug);
        continue;
      }
      counted.push(slug);
      if (isGrounded(fm, inputKeys)) grounded.push(slug);
      else if (recordedTrue(fm.grounded)) unbacked.push(slug);
    }
    const total = counted.length;
    const share = total ? Math.round((grounded.length / total) * 10000) / 10000 : null;
    return { month: m, total, grounded, excluded, unbacked, share };
  });
}

/** Each bet's frontmatter (its seed, overlaid by its epic README) and the North Star input keys, from a project root. */
export function readProject(root) {
  const docs = new Map();
  const roadmap = join(root, 'Roadmap');
  const epics = existsSync(roadmap)
    ? readdirSync(roadmap, { withFileTypes: true })
        .filter(
          (d) =>
            d.isDirectory() && /^\d{2}-/.test(d.name) && d.name !== '00-ideas' && d.name !== '00-strategy'
        )
        .flatMap((d) =>
          readdirSync(join(roadmap, d.name), { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => ({ slug: e.name, path: join(roadmap, d.name, e.name, 'README.md') }))
        )
    : [];
  const read = (path) => {
    if (!existsSync(path)) return null;
    const parsed = parseDocFrontmatter(readFileSync(path, 'utf8'));
    return parsed.error ? null : parsed.data;
  };
  // The seed holds the funding stamp (`underwritten_by:`); the epic README, once scaffolded, is authoritative for
  // everything it carries (type, target, grounded). So a bet is its seed with its README laid over it.
  const seeds = join(roadmap, '00-ideas', 'seeds');
  if (existsSync(seeds))
    for (const f of readdirSync(seeds).filter((f) => f.endsWith('.md'))) {
      const fm = read(join(seeds, f));
      if (fm) docs.set(f.slice(0, -3), fm);
    }
  for (const { slug, path } of epics) {
    const fm = read(path);
    if (fm) docs.set(slug, { ...(docs.get(slug) ?? {}), ...fm });
  }
  const ns = join(roadmap, '00-strategy', 'north-star.md');
  const inputKeys = existsSync(ns) ? northStarInputKeys(readFileSync(ns, 'utf8')) : [];
  return { docs, inputKeys };
}

export function formatShares(rows, inputKeys) {
  const out = [
    `Grounded bets (${INPUT_KEY}) — North Star inputs: ${inputKeys.length ? inputKeys.join(' · ') : 'none (no strategy yet: nothing can be grounded)'}`,
  ];
  if (!rows.length) out.push('  no bets in the ledger');
  for (const r of rows) {
    const pct = r.share === null ? 'no bets' : `${Math.round(r.share * 1000) / 10}%`;
    out.push(
      `  ${r.month}: ${r.grounded.length} of ${r.total} grounded (${pct})` +
        (r.excluded.length ? ` · not counted (bug/chore): ${r.excluded.length}` : '')
    );
    if (r.grounded.length) out.push(`    grounded: ${r.grounded.join(', ')}`);
    if (r.unbacked.length)
      out.push(`    ⚠ grounded: true but no North Star target: ${r.unbacked.join(', ')}`);
  }
  return out.join('\n');
}

/**
 * The project's North Star input keys from the engine: `{ keys }`, `{ skip }` when there is no key to ask with, or
 * `{ error }` when the engine could not say (a refusal, a 5xx, a network error). Never throws; the key goes only into
 * the Authorization header. The engine lists every input of every metric it holds, so when it is asked, it — not a
 * local file — decides what counts as grounded for the pushed value (verifier, #334).
 */
export async function engineInputKeys({ env = process.env, fetchImpl = fetch } = {}) {
  const apiKey = apiKeyFrom(env);
  if (!apiKey) return { skip: 'no SELF_PROJECT_API_KEY or GROWTH_ENGINE_API_KEY' };
  const base = (env.GROWTH_ENGINE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${base}/api/v1/north-star`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok || !Array.isArray(body.metrics))
      return { error: `the engine's North Star could not be read (${res.status})` };
    return {
      keys: body.metrics.flatMap((m) =>
        Array.isArray(m?.inputs) ? m.inputs.map((i) => i?.key).filter((k) => typeof k === 'string') : []
      ),
    };
  } catch {
    return { error: "the engine's North Star could not be read (network error)" };
  }
}

const apiKeyFrom = (env) => env.SELF_PROJECT_API_KEY || env.GROWTH_ENGINE_API_KEY || null; // as roadmap-push.mjs

/** Post today's value. Returns a line to print; never throws for a skip. */
export async function pushShare({ rows, inputKeys, env = process.env, fetchImpl = fetch, today }) {
  const day = today ?? new Date().toISOString().slice(0, 10);
  if (!inputKeys.includes(INPUT_KEY))
    return { ok: true, line: `push skipped: this project's North Star has no ${INPUT_KEY} input` };
  const row = rows.find((r) => r.month === day.slice(0, 7));
  if (!row || row.share === null)
    return { ok: true, line: `push skipped: no counted bets in ${day.slice(0, 7)}` };
  const apiKey = apiKeyFrom(env);
  if (!apiKey) return { ok: true, line: 'push skipped: no SELF_PROJECT_API_KEY or GROWTH_ENGINE_API_KEY' };
  const base = (env.GROWTH_ENGINE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  let res;
  try {
    res = await fetchImpl(`${base}/api/v1/inputs/${INPUT_KEY}/values`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ values: [{ occurredOn: day, value: row.share }] }),
    });
  } catch (err) {
    return {
      ok: false,
      line: `push failed: ${err instanceof Error ? err.message.replace(/\/\/[^/\s@]*@/g, '//***@') : 'network error'}`,
    };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok)
    return { ok: false, line: `push failed (${res.status}): ${body?.error ?? 'no error message'}` };
  if (body.inserted > 0) return { ok: true, line: `pushed ${INPUT_KEY} = ${row.share} for ${day}` };
  const mismatch = Array.isArray(body.mismatchedDuplicates) && body.mismatchedDuplicates.length > 0;
  return {
    ok: true,
    line: mismatch
      ? `already pushed for ${day} with a different value; the first value of a day stands (now ${row.share})`
      : `already pushed for ${day} (${row.share})`,
  };
}

async function main(argv) {
  const opt = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? null : (argv[at + 1] ?? '');
  };
  const month = opt('--month');
  if (month !== null && !/^\d{4}-\d{2}$/.test(month)) {
    console.error('bets-grounded: --month takes YYYY-MM');
    return 1;
  }
  const root = opt('--root') ? resolve(opt('--root')) : projectRoot();
  const project = readProject(root);
  const { docs } = project;
  let { inputKeys } = project;
  // No local strategy (it is often private and untracked, as in CI): ask the engine when there is a key, for the
  // printed count as well as the push. A failure to read it is a failed push, never a "no input" skip (verifier, #334).
  const push = argv.includes('--push');
  if (!inputKeys.length) {
    const fromEngine = await engineInputKeys();
    if (fromEngine.keys) {
      inputKeys = fromEngine.keys;
      console.error('North Star inputs read from the engine (no local Roadmap/00-strategy/north-star.md).');
    } else if (push) {
      console.error(
        fromEngine.error ? `push failed: ${fromEngine.error}` : `push skipped: ${fromEngine.skip}`
      );
      return fromEngine.error ? 1 : 0;
    }
  }
  const rows = shareByMonth({ docs, inputKeys, month });
  if (argv.includes('--json')) console.log(JSON.stringify({ inputKeys, months: rows }, null, 2));
  else console.log(formatShares(rows, inputKeys));
  if (!push) return 0;
  const all = month ? shareByMonth({ docs, inputKeys }) : rows;
  const result = await pushShare({ rows: all, inputKeys });
  console.log(result.line);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
