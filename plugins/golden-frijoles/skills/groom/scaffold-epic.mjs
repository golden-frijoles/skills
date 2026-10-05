#!/usr/bin/env node
// scaffold-epic.mjs — create an epic's Roadmap skeleton from templates (zero deps).
// Planning-only helper for the `groom` skill (Stage 7). Makes the structure; you write the content.
//
// Usage:
//   node "$GROOM/scaffold-epic.mjs" \
//     --slug checkout-state-hardening --area 02 \
//     --macro 02-checkout-and-payments --title "Checkout state hardening" \
//     --risk high --sprints "Durable payment state;Block ship before paid;One coupon-aware total"
//   node "$GROOM/scaffold-epic.mjs" --slug <funded-seed>     # a fixed-scope seed: everything else from the seed
//
// Flags: --type <feature|spike|bug|chore> (default feature, matches SKILL.md's Stage-2 classification
//        table exactly — rendered Capitalized into the epic README's header "Class:" field)
//        · --repo-root <path> (default: cwd) · --dry-run (print, write nothing)
//        · --quote <lo>-<hi> [--quote-basis "…"] (≈ API $; default: the seed’s `quote:` line, else null — finops S2.3)
// It does NOT commit — it prints the exact path-scoped git command for you to run.
//
// ── From a seed (fund-at-approval) ─────────────────────────────────────────────────────────────────────────────
// When `Roadmap/00-ideas/seeds/<slug>.md` exists, it is the source: `--title`, `--area`, `--type` and `--risk` default
// to the seed's, `--macro` to the one `Roadmap/<area>-*` directory, and `--sprints` to ONE sprint named after the seed,
// whose stories are the seed's `## Acceptance criteria` bullets. So a fixed-scope seed scaffolds with `--slug` alone
// (dogfood F33: no generator took a seed, so a builder needed a hand-written prompt). The seed must be FUNDED first
// (`underwritten_by:`, written by `fund.mjs` at the approval gate) — an unfunded seed is refused, because nothing
// leaves grooming scaffolded but unfunded. Its `build_order` is copied into the README, and the seed gets `epic:` and
// `status: scaffolded`. With no seed file at all, nothing here applies and every flag is needed, as before.
//
// ── Why --repo-root exists (a live bug, fixed 2026-08-03) ────────────────────────────────────────────
// This used to resolve the target repo as `resolve(__dirname, '..', '..')` — "skills/groom → repo root".
// That is only true when the skill is checked out INSIDE the project. Installed as a marketplace plugin
// it is not: Claude Code copies a plugin into its own cache directory, so `../..` resolved to the plugin
// package and the scaffolder wrote `Roadmap/<macro>/<slug>/` into the CACHE — silently, exiting green,
// leaving the actual repository untouched. The failure shape is the worst kind: a successful-looking run
// whose output is nowhere the caller can see.
//
// The fix is the same contract `emit-kickoff.mjs` already used: resolve the repo from `--repo-root`,
// defaulting to the CURRENT WORKING DIRECTORY (the repo the agent is actually standing in), and verify a
// `Roadmap/` directory exists there before writing anything. If it doesn't, that is a wrong-directory
// error worth failing on, not a directory to create — silently inventing `Roadmap/` in the wrong place is
// how the original bug stayed invisible.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readField, setField, yamlString } from './roadmap-fm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TPL = join(__dirname, 'templates');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { a[key] = true; }
      else { a[key] = next; i++; }
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

// The ACTIVE repository, not the plugin package — see the header block.
const REPO_ROOT = resolve(String(args['repo-root'] === true ? '' : args['repo-root'] || process.cwd()));
if (!existsSync(join(REPO_ROOT, 'Roadmap'))) {
  console.error(`scaffold-epic: no Roadmap/ directory under "${REPO_ROOT}".`);
  console.error('  This scaffolds into the ACTIVE repository, resolved from --repo-root (default: cwd).');
  console.error('  Run it from the repo root, or pass --repo-root <path>. It will not create Roadmap/ for');
  console.error('  you: scaffolding into the wrong place is the failure this check exists to catch.');
  process.exit(1);
}

// The seed, when there is one, supplies every default (see the header's "From a seed").
const flag = (k) => (typeof args[k] === 'string' ? args[k] : null);
const seedPath = flag('slug') ? join(REPO_ROOT, 'Roadmap', '00-ideas', 'seeds', `${flag('slug')}.md`) : null;
const seedText = seedPath && existsSync(seedPath) ? readFileSync(seedPath, 'utf8') : null;
const fromSeed = (k) => (seedText ? readField(seedText, k) : null);
const areaArg = flag('area') ?? fromSeed('area');

/** The one `Roadmap/<area>-*` directory, or null when there are none or several (then --macro is needed). */
function macroFor(area) {
  if (!area) return null;
  const dirs = readdirSync(join(REPO_ROOT, 'Roadmap')).filter((d) => d.startsWith(`${area}-`));
  return dirs.length === 1 ? dirs[0] : null;
}

/**
 * The items under the seed's `## Acceptance…` heading (any suffix: "criteria", "checks"…), one string each, wrapped
 * lines joined. Bullets (`-`, `*`) and numbered items (`1.`, `1)`) both count: seeds use both (review #271).
 */
function acceptanceCriteria(text) {
  const section = /^## Acceptance[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text ?? '')?.[1];
  if (section == null) return [];
  const out = [];
  for (const line of section.split('\n')) {
    const item = /^(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) out.push(item[1].trim());
    else if (/^\s+\S/.test(line) && out.length) out[out.length - 1] += ` ${line.trim()}`;
  }
  if (!out.length) console.error('scaffold-epic: the seed has an Acceptance section but no list items in it — sprint 1 gets one placeholder story.');
  return out;
}

const criteria = seedText && !flag('sprints') ? acceptanceCriteria(seedText) : [];
const resolved = {
  slug: flag('slug'),
  area: areaArg,
  macro: flag('macro') ?? macroFor(areaArg),
  title: flag('title') ?? fromSeed('title'),
  sprints: flag('sprints') ?? fromSeed('title'),
};
const required = ['slug', 'area', 'macro', 'title', 'sprints'];
const missing = required.filter((k) => !resolved[k]);
if (missing.length) {
  console.error(`scaffold-epic: missing required flag(s): ${missing.map((m) => '--' + m).join(', ')}`);
  console.error('Run with --slug --area --macro --title --sprints "S1;S2;S3" [--risk low|high] [--type feature] [--repo-root <path>] [--dry-run]');
  if (seedText) console.error(`  (the seed supplied what it has${missing.includes('macro') ? `; no single Roadmap/${areaArg}-* directory, so pass --macro` : ''})`);
  process.exit(1);
}
// Each of these becomes a path segment: a `/` or `..` in one would write outside Roadmap/ (security lens, #271).
const SEGMENT = { slug: /^[a-z0-9][a-z0-9-]*$/, area: /^\d{2}$/, macro: /^\d{2}-[a-z0-9-]+$/ };
for (const [k, re] of Object.entries(SEGMENT)) {
  if (!re.test(String(resolved[k]))) {
    console.error(`scaffold-epic: --${k} must match ${re} (got "${resolved[k]}") — it names a directory under Roadmap/`);
    process.exit(1);
  }
}
if (seedText && !fromSeed('underwritten_by')) {
  console.error(`scaffold-epic: the seed ${resolved.slug} is not funded (no \`underwritten_by:\`) — nothing leaves grooming scaffolded but unfunded.`);
  console.error('  Fund it first, at the approval gate (groom SKILL.md → Stage 7):');
  console.error(`    node "$GROOM/fund.mjs" --slug ${resolved.slug} --displaced "<what stays parked>" --next   # or --after <slug>`);
  console.error('  "Approve, don\'t fund" is a real answer too: the seed then stays `ready` and nothing is scaffolded.');
  process.exit(1);
}

const slug = resolved.slug;
const area = String(resolved.area);
const macro = resolved.macro;
const title = resolved.title;
const risk = String(flag('risk') ?? fromSeed('risk') ?? 'high').toLowerCase();
if (!['low', 'high'].includes(risk)) {
  console.error(`scaffold-epic: --risk must be low|high (got "${risk}") — the frontmatter contract's two tiers; unsure means high.`);
  process.exit(1);
}
const typeRaw = String(flag('type') ?? fromSeed('type') ?? 'feature').toLowerCase();
const VALID_TYPES = ['feature', 'spike', 'bug', 'chore'];
if (!VALID_TYPES.includes(typeRaw)) {
  console.error(`scaffold-epic: --type must be one of ${VALID_TYPES.join('|')} (got "${typeRaw}") — matches SKILL.md's Stage-2 classification table.`);
  process.exit(1);
}
const type = typeRaw[0].toUpperCase() + typeRaw.slice(1); // rendered Capitalized in the header's Class: field
const dryRun = !!args['dry-run'];
const date = new Date().toISOString().slice(0, 10);
const sprints = String(resolved.sprints).split(';').map((s) => s.trim()).filter(Boolean);

if (!sprints.length) { console.error('scaffold-epic: --sprints produced no sprint titles'); process.exit(1); }

const epicDir = join(REPO_ROOT, 'Roadmap', macro, slug);
if (existsSync(epicDir)) {
  console.error(`scaffold-epic: refusing to clobber existing epic dir: Roadmap/${macro}/${slug}`);
  process.exit(1);
}

const sub = (str, vars) => str.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
// Frontmatter values are written double-quoted (a JSON string is valid YAML), so a title carrying a
// colon, a `#` or a quote can never change the parse — the machine-readable contract
// (build-visualization-claude-mods) is only worth having if a title cannot break it.
const yaml = (s) => JSON.stringify(s);
// intent-match: the seed's advisory score travels into the epic README, so `epic-dod` and `intent-outcomes` can tell a
// scored epic from an unscored one without opening the seed. Only a whole number 0–100 is copied; anything else
// (absent, `null`, a typo) scaffolds `null` — an unscored epic, never a made-up score.
const seedFm = seedText ? /^---\n([\s\S]*?)\n---/.exec(seedText)?.[1] ?? '' : '';
const seedScore = /^intent_match:\s*(\d{1,3})\s*(?:#.*)?$/m.exec(seedFm)?.[1];
const intentMatch = seedScore != null && Number(seedScore) <= 100 ? seedScore : 'null';
// finops S2.3 — the quote (≈ API $) travels the same way: `--quote <lo>-<hi> [--quote-basis "…"]` wins, else the seed's
// `quote: $<lo>–<hi> (<basis>)` line, the one groom copies from `quote.mjs` at Stage 1.5. Anything else scaffolds null —
// an unquoted epic, never a quote of $0.
function quoteFrom(flag, basisFlag, seedText) {
  if (flag === true) {
    console.error('scaffold-epic: --quote needs a value like 30-55 (low-high, in ≈ API $)');
    process.exit(1);
  }
  if (typeof flag === 'string') {
    const m = /^\$?(\d+(?:\.\d+)?)\s*[-–]\s*\$?(\d+(?:\.\d+)?)$/.exec(flag.trim());
    if (!m || Number(m[1]) > Number(m[2])) {
      console.error(`scaffold-epic: --quote must look like 30-55 (low-high, in ≈ API $), got "${flag}"`);
      process.exit(1);
    }
    const r2 = (v) => String(Math.round(Number(v) * 100) / 100); // D17 — writers round $ to 2 places
    if (Number(r2(m[2])) <= 0) {
      console.error(`scaffold-epic: a quote of $0 is not a quote — leave --quote out to scaffold an unquoted epic`);
      process.exit(1);
    }
    return { low: r2(m[1]), high: r2(m[2]), basis: typeof basisFlag === 'string' ? yaml(basisFlag) : 'null' };
  }
  const m = /^quote:\s*\$(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)\s*\(([^)]+)\)/m.exec(seedText);
  if (m && Number(m[1]) <= Number(m[2])) return { low: m[1], high: m[2], basis: yaml(m[3].trim()) };
  return { low: 'null', high: 'null', basis: 'null' };
}
const quote = quoteFrom(args.quote, args['quote-basis'], seedText ?? '');
const baseVars = {
  QUOTE_LOW: quote.low, QUOTE_HIGH: quote.high, QUOTE_BASIS: quote.basis,
  SLUG: slug, TITLE: title, TITLE_YAML: yaml(title), AREA: area, MACRO: macro, RISK: risk, TYPE: type,
  TYPE_KEY: typeRaw, DATE: date, INTENT_MATCH: intentMatch,
  // Born with one placeholder story per sprint, so the totals are true on day one.
  // Sprint 1 of a seed-born epic carries one story per acceptance criterion (withCriteria, below).
  SPRINTS_TOTAL: String(sprints.length), STORIES_TOTAL: String(sprints.length - 1 + Math.max(1, criteria.length)),
};

const sprintList = sprints
  .map((st, i) => `| ${i + 1} | ${st} | ${risk} |`)
  .join('\n');

const epicTpl = readFileSync(join(TPL, 'epic-README.md'), 'utf8');
const sprintTpl = readFileSync(join(TPL, 'sprint-N.md'), 'utf8');
const retroTpl = readFileSync(join(TPL, 'RETROSPECTIVE.md'), 'utf8');

/**
 * Sprint 1 of a seed-born epic: one story per acceptance criterion, in the frontmatter list and in the prose. The
 * criterion is the want; the role and outcome are left for the builder to sharpen, as the template's own are.
 */
function withCriteria(text, list) {
  const short = (s) => (s.length <= 80 ? s : `${s.slice(0, 77).replace(/\s+\S*$/, '')}…`).replace(/`/g, '');
  const yamlStories = list
    .map((c, i) =>
      [
        `  - id: S1.${i + 1}`,
        `    title: ${yamlString(short(c))}`,
        '    as_a: "the product owner"',
        `    i_want: ${yamlString(c)}`,
        `    so_that: "the pitch's acceptance criterion is met"`,
        `    risk: ${risk}`,
        '    status: planned',
      ].join('\n')
    )
    .join('\n');
  const prose = list
    .map(
      (c, i) =>
        `### Story 1.${i + 1} — ${short(c)}\n**As** the product owner, **I want** this to hold, **so that** the pitch's ` +
        `acceptance criterion is met.\n**Acceptance:** ${c}\n**Risk:** ${risk}\n`
    )
    .join('\n');
  return text
    .replace(/^stories_total: 1$/m, () => `stories_total: ${list.length}`) // functions: a criterion may hold `$&`
    .replace(/^stories:\n[\s\S]*?(?=^---$)/m, () => `stories:\n${yamlStories}\n`)
    .replace(/^### Story 1\.1 — [\s\S]*?(?=^## Sprint QA)/m, () => `${prose}\n`);
}

// The position fund.mjs gave the bet: the README is the SSOT from here, the seed's copy a fallback.
const seedOrder = /^\d+$/.test(String(fromSeed('build_order') ?? '')) ? fromSeed('build_order') : null;
let epicText = sub(epicTpl, { ...baseVars, SPRINT_LIST: sprintList });
if (seedOrder) epicText = setField(epicText, 'build_order', seedOrder);
const files = [];
files.push([join(epicDir, 'README.md'), epicText]);
sprints.forEach((st, i) => {
  let text = sub(sprintTpl, { ...baseVars, N: String(i + 1), SPRINT_TITLE: st, SPRINT_TITLE_YAML: yaml(st) });
  if (i === 0 && criteria.length) text = withCriteria(text, criteria);
  files.push([join(epicDir, `sprint-${i + 1}.md`), text]);
});
files.push([join(epicDir, 'RETROSPECTIVE.md'), sub(retroTpl, baseVars)]);

const rel = (p) => p.replace(REPO_ROOT + '/', '');

if (dryRun) {
  console.log(`[dry-run] would create epic Roadmap/${macro}/${slug} with ${files.length} files:`);
  files.forEach(([p]) => console.log('  + ' + rel(p)));
  process.exit(0);
}

mkdirSync(epicDir, { recursive: true });
files.forEach(([p, body]) => writeFileSync(p, body));
// The seed leaves the funnel: it points at its epic, and the epic README's `status:` is the SSOT from here.
if (seedText) writeFileSync(seedPath, setField(setField(seedText, 'status', 'scaffolded'), 'epic', yaml(`${macro}/${slug}`)));

console.log(`Scaffolded epic Roadmap/${macro}/${slug} (${files.length} files):`);
files.forEach(([p]) => console.log('  + ' + rel(p)));
console.log('\nNext:');
console.log(`  1. Fill the generated files with real stories / reuse list / QA stages.`);
console.log(`  2. The epic README frontmatter \`status:\` is the SSOT (born \`scaffolded\`; set \`shipped\` at close).`);
console.log(`     \`phase:\` (epic + every sprint) is the build-view ladder — write it at each cadence event. Each sprint's`);
console.log(`     \`stories:\` list is the per-story data; keep it and both \`stories_total\` fields in step with the prose.`);
if (seedText) console.log(`     The seed now says \`epic: "${macro}/${slug}"\` and \`status: scaffolded\` — it is funnel-only from here.`);
else console.log(`     Set the SEED frontmatter \`epic: "${macro}/${slug}"\` so it leaves the funnel (the seed is funnel-only after this).`);
if (criteria.length) console.log(`     Sprint 1's ${criteria.length} stories are the seed's acceptance criteria — sharpen each role and outcome.`);
// One commit holds the bet and the scaffold (fund-at-approval): the cycle row fund.mjs wrote, and the regenerated board.
const cycle = fromSeed('underwritten_by')?.replace(/^Roadmap\/bets\//, '').replace(/\.md$/, '');
const extra = seedText ? [`Roadmap/00-ideas/seeds/${slug}.md`] : [];
if (cycle && existsSync(join(REPO_ROOT, 'Roadmap', 'bets', `${cycle}.md`))) extra.push(`Roadmap/bets/${cycle}.md`);
const board = existsSync(join(REPO_ROOT, 'Roadmap', '00-ideas', 'BUILD-ORDER.md'));
if (board) extra.push('Roadmap/00-ideas/BUILD-ORDER.md');
console.log(`  3. ${board ? 'Regenerate the board (node scripts/build-order.mjs), then commit' : 'Commit'} PATH-SCOPED, in ONE commit (never git add -A):`);
const paths = [...files.map(([p]) => rel(p)), ...extra].map((p) => `'${p}'`).join(' ');
console.log(`     git add ${paths}`);
console.log(`     git commit -- ${paths} -m "plan(${slug}): fund + scaffold epic"`);
if (cycle) console.log('     …plus any queue docs fund.mjs renumbered (it printed them), in the same commit.');
