#!/usr/bin/env node
// build-order.mjs — render Roadmap/00-ideas/BUILD-ORDER.md in the six stages, from the SAME projection every roadmap
// tool reads (roadmap-extract.mjs) and the ONE stage resolver (lib/stage.mjs). This file is GENERATED — never
// hand-edit BUILD-ORDER.md; run this instead.
//
//   node scripts/build-order.mjs            # write Roadmap/00-ideas/BUILD-ORDER.md (docs only)
//   node scripts/build-order.mjs --check    # exit 1 if the file is stale (for CI/precommit)
//   node scripts/build-order.mjs --live     # print the full six-stage board with git/GitHub facts; writes nothing
//
// ── Why the committed file is docs-only (board-sinks-and-scrumban lock C3) ───────────────────────────────
// Building and QA are FACTS git and GitHub hold (a branch on origin, a ready PR), never fields in a doc. A committed
// file that carried them would go stale on every PR event, and `--check` (build-order-guard, the nightly sync) would
// turn every unrelated PR red. So the file holds what the docs alone decide — To groom, Grooming, Ready to build,
// Shipped — and says where Building and QA live: `--live` here, the Hub board, and the build view. `--live` is the
// same resolver with live facts, so it agrees with the Hub by construction.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STAGES, groupByStage, stageWord } from './lib/stage.mjs';
import { projectRoot } from './lib/project-root.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = projectRoot(); // D2
const OUT = join(REPO, 'Roadmap', '00-ideas', 'BUILD-ORDER.md');
const EXTRACTOR = join(__dirname, 'roadmap-extract.mjs');
const LIVE = process.argv.includes('--live');

function extract() {
  const json = execFileSync('node', [EXTRACTOR, LIVE ? '--live' : '--docs-only'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(json);
}

// What each stage means, in the words the board uses (the seed's table, locked 2026-10-01).
const STAGE_NOTE = {
  'To groom': 'seeds with no pitch yet',
  Grooming: 'a pitch is waiting at the approval gate',
  'Ready to build': 'scaffolded (or a fixed-scope seed), in build order — pull from the top',
  Building: 'a work branch is on origin',
  QA: 'a PR is ready for review, or merged and waiting for its close-out',
  Shipped: 'merged, deployed and closed',
};
const LIVE_ONLY = new Set(['Building', 'QA']);

function line(r) {
  // BUILD-ORDER.md lives in Roadmap/00-ideas/, so an epic README is ONE folder up — `../../` resolved to the repo
  // root and 404'd every epic link on GitHub (seed board-link-depth, absorbed by board-sinks-and-scrumban S1.5).
  const link = r.grain === 'Seed' ? `seeds/${r.slug}.md` : `../${r.doc_link.replace(/^Roadmap\//, '')}`;
  const meta = [];
  if (r.build_order_num != null) meta.push(`#${r.build_order_num}`);
  if (r.area) meta.push(r.area);
  if (r.grain === 'Seed') meta.push(`seed · ${r.type}`);
  if (r.sprint_progress) meta.push(r.sprint_progress);
  if (r.risk) meta.push(`risk: ${r.risk}`);
  if (r.appetite) meta.push(`appetite ${r.appetite}`);
  return `- [${r.name}](${link}) — ${meta.join(' · ')} · _${r.stage_source}_`;
}

function render(rows) {
  // Shipped by build order, never by `shipped_at`: that is a git date, and a depth-1 CI clone would reorder the file.
  const columns = groupByStage(rows, { shipped: 'build-order' });
  const now = new Date().toISOString().slice(0, 10);
  const out = [];
  out.push('<!-- GENERATED FILE — do not edit by hand.');
  out.push('     Regenerate:  node scripts/build-order.mjs');
  out.push(
    "     Stage: scripts/lib/stage.mjs, from each initiative's frontmatter (docs only in this file; the"
  );
  out.push(
    '     live board with git/GitHub facts is `node scripts/build-order.mjs --live` and the Hub). -->'
  );
  out.push('');
  out.push('# Build order — the six stages');
  out.push('');
  out.push(`> **Generated ${now} — do not hand-edit.** One stage per initiative, decided in one place`);
  out.push(`> (\`scripts/lib/stage.mjs\`): ${STAGES.map(stageWord).join(' · ')}.`);
  if (LIVE) {
    out.push('> **Live:** Building and QA come from git and GitHub as of this run. Printed, never written.');
  } else {
    out.push('> This committed file reads the docs alone, so **Building and QA are not here** — they are facts git');
    out.push('> and GitHub hold. For the live board run `node scripts/build-order.mjs --live`, or open the Hub board.');
  }
  out.push('');
  for (const stage of STAGES) {
    const list = columns[stage];
    if (LIVE_ONLY.has(stage) && !LIVE) {
      out.push(`## ${stageWord(stage)} — live only`);
      out.push('');
      out.push(
        `_${STAGE_NOTE[stage]}. Not in this committed file: \`node scripts/build-order.mjs --live\` or the Hub board._`
      );
      out.push('');
      continue;
    }
    out.push(`## ${stageWord(stage)} (${list.length})`);
    out.push('');
    out.push(`_${STAGE_NOTE[stage]}._`);
    out.push('');
    out.push(list.length ? list.map(line).join('\n') : '_None._');
    out.push('');
  }
  const cards = STAGES.reduce((n, s) => n + columns[s].length, 0);
  out.push('---');
  out.push(`_${cards} initiatives on the board. Regenerate with \`node scripts/build-order.mjs\`._`);
  out.push('');
  return out.join('\n');
}

const rows = extract();

// Underwriting enforcement (WAYS-OF-WORKING → Betting & appetite): a QUEUED seed is a bet — it
// must carry an `appetite:`. Hard fail, not advisory: the board physically rejects unfunded work
// (the same enforced-not-advisory stance as the status enum).
const unfunded = rows.filter((r) => r.grain === 'Seed' && r.status === 'Queued' && !r.appetite);
if (unfunded.length) {
  console.error(
    'Queued seeds missing `appetite:` frontmatter (S | M | L — set at shaping, bet at the wave boundary):'
  );
  for (const s of unfunded) console.error(`  - ${s.doc_link}`);
  process.exit(1);
}

// Scaffolded ⇒ funded (fund-at-approval D8). A live bet — an epic scaffolded or in progress, or a queued seed — must
// name the cycle that paid for it, and that cycle must be a file in Roadmap/bets/. `refine` funds a bet at its approval
// gate (`fund.mjs`), in the same commit as the scaffold, so this only fails on work that skipped the gate.
const BETS = join(REPO, 'Roadmap', 'bets');
const cycleOf = (v) => String(v).replace(/^Roadmap\/bets\//, '').replace(/\.md$/, '');
const liveBets = rows.filter(
  (r) => (r.grain === 'Epic' && ['Scaffolded', 'In progress'].includes(r.status)) || (r.grain === 'Seed' && r.status === 'Queued')
);
// A cycle name is kebab-case: anything else (a `/`, a `..`) names no cycle file and is never turned into a path.
const paidBy = (r) => r.underwritten_by && /^[a-z0-9][a-z0-9-]*$/.test(cycleOf(r.underwritten_by)) && existsSync(join(BETS, `${cycleOf(r.underwritten_by)}.md`));
const unpaid = liveBets.filter((r) => !paidBy(r));
if (unpaid.length) {
  console.error('Live bets with no funding record (`underwritten_by:` must name a Roadmap/bets/<cycle>.md):');
  for (const r of unpaid) console.error(`  - ${r.doc_link}${r.underwritten_by ? ` — no Roadmap/bets/${cycleOf(r.underwritten_by)}.md` : ''}`);
  console.error('Fund it at the approval gate: node "$REFINE/fund.mjs" --slug <slug> --displaced "<…>" --next | --after <slug>');
  process.exit(1);
}

const content = render(rows);

if (LIVE) {
  // Printed, never written: the committed file must stay docs-only (lock C3).
  process.stdout.write(content);
} else if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  // Ignore the "Generated <date>" line when comparing so a date-only diff isn't "stale".
  const norm = (s) => s.replace(/^> \*\*Generated \d{4}-\d{2}-\d{2} /m, '> **Generated DATE ');
  if (norm(current) !== norm(content)) {
    console.error('BUILD-ORDER.md is stale — run: node scripts/build-order.mjs');
    process.exit(1);
  }
  console.log('BUILD-ORDER.md is up to date.');
} else {
  writeFileSync(OUT, content);
  console.log(`Wrote ${OUT}`);
}
