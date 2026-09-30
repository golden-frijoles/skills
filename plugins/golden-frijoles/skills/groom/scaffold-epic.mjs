#!/usr/bin/env node
// scaffold-epic.mjs — create an epic's Roadmap skeleton from templates (zero deps).
// Planning-only helper for the `groom` skill (Stage 7). Makes the structure; you write the content.
//
// Usage:
//   node skills/groom/scaffold-epic.mjs \
//     --slug checkout-state-hardening --area 02 \
//     --macro 02-checkout-and-payments --title "Checkout state hardening" \
//     --risk high --sprints "Durable payment state;Block ship before paid;One coupon-aware total"
//
// Flags: --type <feature|spike|bug|chore> (default feature, matches SKILL.md's Stage-2 classification
//        table exactly — rendered Capitalized into the epic README's header "Class:" field)
//        · --repo-root <path> (default: cwd) · --dry-run (print, write nothing)
// It does NOT commit — it prints the exact path-scoped git command for you to run.
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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

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
const required = ['slug', 'area', 'macro', 'title', 'sprints'];
const missing = required.filter((k) => !args[k] || args[k] === true);
if (missing.length) {
  console.error(`scaffold-epic: missing required flag(s): ${missing.map((m) => '--' + m).join(', ')}`);
  console.error('Run with --slug --area --macro --title --sprints "S1;S2;S3" [--risk low|high] [--type feature] [--repo-root <path>] [--dry-run]');
  process.exit(1);
}

// The ACTIVE repository, not the plugin package — see the header block.
const REPO_ROOT = resolve(String(args['repo-root'] === true ? '' : args['repo-root'] || process.cwd()));
if (!existsSync(join(REPO_ROOT, 'Roadmap'))) {
  console.error(`scaffold-epic: no Roadmap/ directory under "${REPO_ROOT}".`);
  console.error('  This scaffolds into the ACTIVE repository, resolved from --repo-root (default: cwd).');
  console.error('  Run it from the repo root, or pass --repo-root <path>. It will not create Roadmap/ for');
  console.error('  you: scaffolding into the wrong place is the failure this check exists to catch.');
  process.exit(1);
}

const slug = String(args.slug);
const area = String(args.area);
const macro = String(args.macro);
const title = String(args.title);
const risk = String(args.risk || 'high').toLowerCase();
if (!['low', 'high'].includes(risk)) {
  console.error(`scaffold-epic: --risk must be low|high (got "${risk}") — the frontmatter contract's two tiers; unsure means high.`);
  process.exit(1);
}
const typeRaw = String(args.type || 'feature').toLowerCase();
const VALID_TYPES = ['feature', 'spike', 'bug', 'chore'];
if (!VALID_TYPES.includes(typeRaw)) {
  console.error(`scaffold-epic: --type must be one of ${VALID_TYPES.join('|')} (got "${typeRaw}") — matches SKILL.md's Stage-2 classification table.`);
  process.exit(1);
}
const type = typeRaw[0].toUpperCase() + typeRaw.slice(1); // rendered Capitalized in the header's Class: field
const dryRun = !!args['dry-run'];
const date = new Date().toISOString().slice(0, 10);
const sprints = String(args.sprints).split(';').map((s) => s.trim()).filter(Boolean);

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
const seedPath = join(REPO_ROOT, 'Roadmap', '00-ideas', 'seeds', `${slug}.md`);
const seedFm = existsSync(seedPath) ? /^---\n([\s\S]*?)\n---/.exec(readFileSync(seedPath, 'utf8'))?.[1] ?? '' : '';
const seedScore = /^intent_match:\s*(\d{1,3})\s*(?:#.*)?$/m.exec(seedFm)?.[1];
const intentMatch = seedScore != null && Number(seedScore) <= 100 ? seedScore : 'null';
const baseVars = {
  SLUG: slug, TITLE: title, TITLE_YAML: yaml(title), AREA: area, MACRO: macro, RISK: risk, TYPE: type,
  TYPE_KEY: typeRaw, DATE: date, INTENT_MATCH: intentMatch,
  // Born with one placeholder story per sprint, so the totals are true on day one.
  SPRINTS_TOTAL: String(sprints.length), STORIES_TOTAL: String(sprints.length),
};

const sprintList = sprints
  .map((st, i) => `| ${i + 1} | ${st} | ${risk} |`)
  .join('\n');

const epicTpl = readFileSync(join(TPL, 'epic-README.md'), 'utf8');
const sprintTpl = readFileSync(join(TPL, 'sprint-N.md'), 'utf8');
const retroTpl = readFileSync(join(TPL, 'RETROSPECTIVE.md'), 'utf8');

const files = [];
files.push([join(epicDir, 'README.md'), sub(epicTpl, { ...baseVars, SPRINT_LIST: sprintList })]);
sprints.forEach((st, i) => {
  files.push([join(epicDir, `sprint-${i + 1}.md`), sub(sprintTpl, { ...baseVars, N: String(i + 1), SPRINT_TITLE: st, SPRINT_TITLE_YAML: yaml(st) })]);
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

console.log(`Scaffolded epic Roadmap/${macro}/${slug} (${files.length} files):`);
files.forEach(([p]) => console.log('  + ' + rel(p)));
console.log('\nNext:');
console.log(`  1. Fill the generated files with real stories / reuse list / QA stages.`);
console.log(`  2. The epic README frontmatter \`status:\` is the SSOT (born \`scaffolded\`; set \`shipped\` at close).`);
console.log(`     \`phase:\` (epic + every sprint) is the build-view ladder — write it at each cadence event. Each sprint's`);
console.log(`     \`stories:\` list is the per-story data; keep it and both \`stories_total\` fields in step with the prose.`);
console.log(`     Set the SEED frontmatter \`epic: "${macro}/${slug}"\` so it leaves the funnel (the seed is funnel-only after this).`);
console.log(`  3. Commit PATH-SCOPED (never git add -A):`);
const paths = files.map(([p]) => `'${rel(p)}'`).join(' ');
console.log(`     git add ${paths} 'Roadmap/00-ideas/seeds/${slug}.md'`);
console.log(`     git commit -- ${paths} 'Roadmap/00-ideas/seeds/${slug}.md' -m "plan(${slug}): scaffold epic + sprints"`);
