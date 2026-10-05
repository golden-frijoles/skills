#!/usr/bin/env node
// fund.mjs — place a bet at groom's approval gate: the cycle row, `underwritten_by`, and the build position, in one go
// (fund-at-approval). Planning-only, zero deps, writes `Roadmap/` docs and never commits — the gate commits it with the
// scaffold, in the same commit (groom SKILL.md → Stage 7).
//
// Usage:
//   node "$GROOM/fund.mjs" --slug <slug> --displaced "<what stays parked>" --next            # front of the queue
//   node "$GROOM/fund.mjs" --slug <slug> --displaced "<…>" --after <queued-slug>              # behind that bet
//   node "$GROOM/fund.mjs" --slug <queued-slug> --displaced "<…>"                             # re-bet: position kept
//   node "$GROOM/fund.mjs" --slug <queued-slug> --after <slug>                                 # reorder: funding untouched
//
// Flags: --appetite S|M|L (default: the seed's) · --cycle <name> (default: this month's `wave-YYYY-MM`)
//        · --date YYYY-MM-DD (default: today) · --repo-root <path> (default: cwd) · --dry-run (print, write nothing)
//
// ── What it writes ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. `Roadmap/bets/<cycle>.md`, created on first use, gains one row: Bet · Appetite · Displaced.
// 2. The seed (else the epic README, for an epic with no seed) gets `underwritten_by: <cycle>` and `appetite:`; a
//    seed with no epic yet moves from `ready` to `queued`.
// 3. With `--next`/`--after`, the QUEUE is renumbered in its new order. The queue is funded, live work only: epics
//    `scaffolded`/`in-progress` and seeds `queued`, each with an integer `build_order`. Numbering starts at the
//    queue's lowest number and skips every number a non-queue item holds, so a shipped or archived `build_order`
//    never changes and never collides — history is fixed, only the queue moves.
//
// A bet already in the queue, run again with no placement flag, is a RE-BET (an L bet at its wave boundary): a new row
// in this month's cycle, `underwritten_by` moved to it, position kept. With a placement it is a REORDER: the queue moves
// and the funding record is left alone. A `raw` seed is refused — it has no pitch to fund.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { readField, setField } from './roadmap-fm.mjs';

const APPETITES = ['S', 'M', 'L'];
const LIVE_EPIC = new Set(['scaffolded', 'in-progress']);

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) a[t.slice(2)] = true;
    else {
      a[t.slice(2)] = next;
      i++;
    }
  }
  return a;
}

const intOrNull = (v) => (v != null && /^\d+$/.test(String(v)) ? Number(v) : null);

/**
 * Every epic README and seed under `root`, as `{ slug, kind, path, text, status, build_order, epic? }`.
 * A seed whose `epic:` is set mirrors its epic: it is returned as `mirror` on that epic, never as an item of its own.
 */
export function readItems(root) {
  const roadmap = join(root, 'Roadmap');
  const seedsDir = join(roadmap, '00-ideas', 'seeds');
  const seeds = new Map();
  if (existsSync(seedsDir)) {
    for (const f of readdirSync(seedsDir).filter((n) => n.endsWith('.md') && n !== 'README.md')) {
      const path = join(seedsDir, f);
      const text = readFileSync(path, 'utf8');
      seeds.set(f.slice(0, -3), { slug: f.slice(0, -3), kind: 'seed', path, text, epic: readField(text, 'epic') });
    }
  }
  const items = [];
  const mirrored = new Set();
  for (const macro of readdirSync(roadmap).filter((d) => /^\d{2}-/.test(d) && d !== '00-ideas')) {
    let slugs = [];
    try {
      slugs = readdirSync(join(roadmap, macro));
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const path = join(roadmap, macro, slug, 'README.md');
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      const key = `${macro}/${slug}`;
      const mirror = [...seeds.values()].find((s) => s.epic === key) || null;
      if (mirror) mirrored.add(mirror.slug);
      items.push({ slug, kind: 'epic', path, text, epicKey: key, mirror, status: readField(text, 'status'), build_order: intOrNull(readField(text, 'build_order')) });
    }
  }
  for (const s of seeds.values()) {
    if (mirrored.has(s.slug)) continue;
    items.push({ ...s, status: readField(s.text, 'status'), build_order: intOrNull(readField(s.text, 'build_order')) });
  }
  return items;
}

const inQueue = (it) => (it.kind === 'epic' ? LIVE_EPIC.has(it.status) : it.status === 'queued');

/**
 * The new numbers after placing `target` (`{ next: true }` or `{ after: '<slug>' }`). Pure.
 * Returns `Map<slug, number>` for every queue item whose number changes, or throws on a bad placement.
 */
export function planQueue(items, targetSlug, placement) {
  const target = items.find((i) => i.slug === targetSlug);
  if (!target) throw new Error(`no seed or epic "${targetSlug}"`);
  const queue = items.filter((i) => i !== target && inQueue(i) && i.build_order != null);
  const held = new Set(items.filter((i) => i !== target && !queue.includes(i) && i.build_order != null).map((i) => i.build_order));
  const order = [...queue].sort((a, b) => a.build_order - b.build_order || a.slug.localeCompare(b.slug));
  if (placement.next) order.unshift(target);
  else {
    const at = order.findIndex((i) => i.slug === placement.after);
    if (at < 0) {
      const known = items.find((i) => i.slug === placement.after);
      throw new Error(
        known
          ? `"${placement.after}" is not in the queue (status ${known.status}${known.build_order == null ? ', no build_order' : ''}) — place behind a funded, live bet, or use --next`
          : `no seed or epic "${placement.after}"`
      );
    }
    order.splice(at + 1, 0, target);
  }
  // A target already in the queue keeps its slot in the count; a `ready` seed's legacy number (one predating funding)
  // is not a queue position, and letting it set the start would pour the queue into the shipped history's gaps.
  const numbers = [...queue, ...(inQueue(target) ? [target] : [])].map((i) => i.build_order).filter((n) => n != null);
  let n = numbers.length ? Math.min(...numbers) : Math.max(0, ...held) + 1;
  const changes = new Map();
  for (const it of order) {
    while (held.has(n)) n++;
    if (it.build_order !== n) changes.set(it.slug, n);
    n++;
  }
  return changes;
}

/** A cycle file's opening text: the bets README's three columns, said to be a month opened at approval. */
export function cycleHeader(name, date) {
  const month = /^wave-(\d{4}-\d{2})$/.exec(name)?.[1];
  return [
    `# Cycle ${month ?? name} — bets funded at approval`,
    '',
    `Opened by \`fund.mjs\` on ${date}, at the first bet funded in it. Each row was placed at \`groom\`'s approval gate`,
    '(fund-at-approval): approving a pitch funds it. The shape is `Roadmap/bets/README.md`.',
    '',
    '| Bet | Appetite | Displaced (the opportunity cost) |',
    '|---|---|---|',
    '',
  ].join('\n');
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

function die(msg) {
  console.error(`fund: ${msg}`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.slug || args.slug === true) die('missing --slug <seed-or-epic-slug>');
  const root = resolve(String(typeof args['repo-root'] === 'string' ? args['repo-root'] : process.cwd()));
  if (!existsSync(join(root, 'Roadmap'))) die(`no Roadmap/ under "${root}" — run it from the repo root, or pass --repo-root`);
  if (args.next && args.after) die('--next and --after are two placements; pass one');
  if (args.after === true) die('--after needs the slug of the bet to place this one behind');
  const date = typeof args.date === 'string' ? args.date : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) die(`--date must be YYYY-MM-DD, got "${date}"`);
  const cycle = typeof args.cycle === 'string' ? args.cycle.replace(/^Roadmap\/bets\//, '').replace(/\.md$/, '') : `wave-${date.slice(0, 7)}`;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(cycle)) die(`--cycle must be a kebab name like wave-2026-10, got "${cycle}"`);

  const slug = String(args.slug);
  // The slug names files: a `/` or `..` would reach outside Roadmap/ (security lens, #271).
  for (const s of [slug, typeof args.after === 'string' ? args.after : 'x'])
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) die(`a slug is kebab-case (got "${s}")`);
  const items = readItems(root);
  const target = items.find((i) => i.slug === slug);
  if (!target) die(`no seed Roadmap/00-ideas/seeds/${slug}.md and no epic Roadmap/*/${slug}/ — groom it first`);
  if (['shipped', 'archived'].includes(target.status)) die(`"${slug}" is ${target.status} — there is nothing left to fund`);
  if (!inQueue(target) && target.status === 'raw') die(`"${slug}" is raw — groom it to a pitch (status: ready) before it can be funded`);
  // The doc that carries the funding: the seed (its own, or the epic's mirror), else a seedless epic's README.
  const fundDoc = target.kind === 'seed' ? target : target.mirror || target;

  // Three modes, decided by whether the bet is FUNDED and PLACED (review #271, rounds 1–2):
  //   fund    — no funding record yet: written now. It needs a placement unless it already holds a queue position (an
  //             epic scaffolded before funding existed); a `ready` seed's leftover number is never a position;
  //   re-bet  — funded and placed, no placement flag: a new cycle row, position kept (an L bet at its wave boundary);
  //   reorder — funded and placed, with a placement: the queue moves, the funding record is left alone.
  const placement = args.next ? { next: true } : typeof args.after === 'string' ? { after: args.after } : null;
  const placed = inQueue(target) && target.build_order != null;
  const funded = readField(fundDoc.text, 'underwritten_by') != null;
  const mode = funded && placed ? (placement ? 'reorder' : 're-bet') : 'fund';
  if (mode === 'fund' && !placement && !placed) die(`"${slug}" is not in the queue yet — pass --next or --after <slug> to place it`);
  const appetite = (typeof args.appetite === 'string' ? args.appetite : readField(fundDoc.text, 'appetite'))?.toUpperCase() ?? null;
  if (mode !== 'reorder') {
    if (!APPETITES.includes(appetite)) die(`--appetite must be S | M | L (the seed has ${appetite ?? 'none'}) — set at shaping, Stage 1.5`);
    if (!args.displaced || args.displaced === true) die('missing --displaced "<what stays parked because of this bet>" — the whole point of the row');
  }
  let changes = new Map();
  if (placement) {
    try {
      changes = planQueue(items, slug, placement);
    } catch (err) {
      die(err.message);
    }
  }

  const writes = new Map(); // path → new text
  const edit = (doc, fn) => writes.set(doc.path, fn(writes.get(doc.path) ?? doc.text));
  if (mode !== 'reorder') edit(fundDoc, (t) => setField(setField(t, 'underwritten_by', cycle), 'appetite', appetite));
  if (target.kind === 'seed' && target.status === 'ready') edit(target, (t) => setField(t, 'status', 'queued'));
  for (const [s, n] of changes) {
    const it = items.find((i) => i.slug === s);
    edit(it, (t) => setField(t, 'build_order', n));
    // The seed's copy of an epic's number is a fallback; keep it equal so nobody reads a stale one.
    if (it.mirror && readField(it.mirror.text, 'build_order') != null) edit(it.mirror, (t) => setField(t, 'build_order', n));
  }

  const cyclePath = join(root, 'Roadmap', 'bets', `${cycle}.md`);
  const cycleText = existsSync(cyclePath) ? readFileSync(cyclePath, 'utf8') : cycleHeader(cycle, date);
  const title = readField(fundDoc.text, 'title') ?? slug;
  const already = mode === 'reorder' || cycleText.split('\n').some((l) => l.startsWith(`| **${slug}**`));
  if (!already) {
    const row = `| **${slug}**: ${cell(title)} | **${appetite}** | ${cell(args.displaced)} |`;
    writes.set(cyclePath, `${cycleText.replace(/\n*$/, '\n')}${row}\n`);
  }

  const rel = (p) => p.slice(root.length + 1);
  const head = mode === 'reorder' ? `Reordered ${slug} (funding record unchanged)` : `Funded ${slug} in ${cycle} (appetite ${appetite}${mode === 're-bet' ? ', a re-bet' : ''})`;
  console.log(`${args['dry-run'] ? '[dry-run] ' : ''}${head}.`);
  if (mode !== 'reorder') console.log(already ? `  cycle: Roadmap/bets/${cycle}.md already has a row for ${slug} — not added twice` : `  cycle: ${existsSync(cyclePath) ? 'row added to' : 'opened'} Roadmap/bets/${cycle}.md`);
  if (placement) {
    const finalN = changes.get(slug) ?? target.build_order;
    console.log(`  position: #${finalN}${changes.size > 1 ? ` — the queue renumbered: ${[...changes].filter(([s]) => s !== slug).map(([s, n]) => `${s} → #${n}`).join(', ')}` : ''}`);
  } else console.log(`  position: #${target.build_order}, kept${mode === 're-bet' ? ' (a re-bet)' : ''}`);
  if (args['dry-run']) {
    [...writes.keys()].forEach((p) => console.log(`  would write ${rel(p)}`));
    return;
  }
  mkdirSync(join(root, 'Roadmap', 'bets'), { recursive: true });
  for (const [p, t] of writes) writeFileSync(p, t);
  console.log(`  commit these${mode === 'fund' ? ' with the scaffold, in one commit' : ''}: ${[...writes.keys()].map((p) => `'${rel(p)}'`).join(' ')}`);
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) main();
