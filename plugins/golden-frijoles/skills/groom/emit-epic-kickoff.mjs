#!/usr/bin/env node
// emit-epic-kickoff.mjs — print the finished, paste-ready EPIC-MODE kickoff for a groomed epic.
//
// ── Why this exists ──────────────────────────────────────────────────────────────────────────────────
// Epic mode — one orchestrated run across a whole epic, sprint files as internal integration boundaries
// — is the DEFAULT unit of work. But the only generator that existed was `emit-kickoff.mjs`, which emits
// a single-sprint prompt, so every epic-mode kickoff was composed BY HAND. Hand-composed prompts are
// exactly where a process contract erodes: the architecture-lock pass gets summarised away, the review
// policy reverts to whatever the composing agent remembered, and nobody notices because the prompt still
// looks complete. This is the sibling generator, and the two now split cleanly:
//
//   emit-epic-kickoff.mjs  → the DEFAULT. One prompt, whole epic, one orchestrator.
//   emit-kickoff.mjs       → the EXCEPTION. A single-sprint epic, or a sprint whose outcome genuinely
//                            changes the next sprint's scope (so the next kickoff can't be written yet).
//
// Same contract as its sibling: it resolves the epic by SEARCHING Roadmap/*/<slug>/ under --repo-root
// (default cwd), reads the epic README and EVERY sprint-N.md, substitutes into templates/epic-kickoff.md
// and prints to stdout. It writes no file — read + print, editorial control stays with the caller.
//
// The prompt POINTS at the process instead of restating it. WAYS-OF-WORKING → *Epic-mode builds* is the
// one copy of the doctrine; an earlier template restated it verbatim and the two had already drifted on the
// review policy. The test fails if a section the template names is missing, so the pointer can't dangle.
// What stays in the prompt: the few non-negotiables that went missing when prompts were hand-composed, and
// rules picked from THIS epic's docs (high risk, a migration, a flag) — see buildEpicRules.
//
// Usage:
//   node skills/groom/emit-epic-kickoff.mjs --epic <slug> [--repo-root <path>]

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TPL = join(__dirname, 'templates');

// Reuse the sibling's parsers rather than forking a second copy — the file formats are identical, and two
// drifting parsers for one format is a bug generator.
import {
  parseArgs,
  sub,
  parseFrontmatter,
  parseEpicTitle,
  parseSprintHeader,
  parseStoryHeadings,
} from './emit-kickoff.mjs';

// ── pure helpers (exported for the co-located test) ─────────────────────────────────────────

// `sprint-3.md` → 3. Returns null for anything that isn't a sprint file, so a stray doc in the epic dir
// (a NOTES.md, an image) can't be mistaken for a sprint.
export function sprintNumFromFilename(name) {
  const m = name.match(/^sprint-(\d+)\.md$/);
  return m ? Number(m[1]) : null;
}

// Every sprint file in the epic dir, NUMERICALLY sorted. Numeric, not lexicographic: a 10-sprint epic
// would otherwise order sprint-10 between sprint-1 and sprint-2, and the whole point of epic mode is that
// the sprints are an ordered assembly line. Stacked branches make a wrong order actively harmful.
export function listSprintFiles(names) {
  return names
    .map((name) => ({ name, num: sprintNumFromFilename(name) }))
    .filter((s) => s.num !== null)
    .sort((a, b) => a.num - b.num);
}

// The comma-separated file list for the orientation line.
export function buildSprintFileList(sprints) {
  if (!sprints.length) return '(no sprint-N.md files found)';
  return sprints.map((s) => s.name).join(', ');
}

// `Story 1.1 — Persist intent ✅ #12. **Decided …**` → `1.1 Persist intent`, clipped. The breakdown is a
// checklist for the orchestrator and the product owner; the sprint files carry the detail.
export function compactStory(heading) {
  const m = String(heading).match(/^Story\s+(\d+\.\d+)\s+[-–—]\s+(.+)$/);
  if (!m) return String(heading);
  const title = m[2].replace(/\s+✅.*$/, '').replace(/\*\*/g, '').trim();
  return `${m[1]} ${title.length > 70 ? `${title.slice(0, 69)}…` : title}`;
}

// The per-sprint breakdown at the foot of the prompt: one line per sprint, its stories inline. This is the
// only part that genuinely varies per epic, and it is deliberately the LAST thing in the prompt — the
// contract above it is invariant, so two kickoffs diff to their scope.
export function buildSprintBreakdown(sprints) {
  if (!sprints.length) return '(no sprint files found — scaffold the epic first)';
  return sprints
    .map((s) => {
      const stories = s.stories.length
        ? s.stories.map(compactStory).join(' · ')
        : '(no `### Story N.M — <title>` headings found in this sprint doc)';
      const clean = s.title ? s.title.replace(/^S\d+\s*[—–:-]?\s*/, '') : '';
      const title = clean ? ` · ${clean}` : '';
      return `- **S${s.num}${title}** (${s.name}): ${stories}`;
    })
    .join('\n');
}

// Rules that apply to THIS epic only, picked from its docs. A false positive costs one line; a missing one
// is the incident each rule came from, so the patterns lean inclusive.
const MIGRATION_RE = /\bmigrations?\b|supabase\/migrations|\bALTER TABLE\b|\bCREATE TABLE\b/i;
// A flag KEY (`checkout.stripe_enabled`) or a flag write — not the words "kill-switch" / "flag", which every
// scaffolded README's Definition of Done carries whether or not a flag was planned.
const FLAG_RE = /\b[a-z][a-z0-9_]*\.[a-z0-9_]+_enabled\b|\bgf flags (?:create|set|on)\b/;

// "No new table, no migration" is the most common way a doc mentions one — strip negated mentions first.
const NEGATED_RE = /\b(?:no|without|zero|not an?|nor an?)\s+(?:new\s+)?(?:db\s+|database\s+|schema\s+)?migrations?\b/gi;

export function buildEpicRules({ risk, texts }) {
  const all = texts.join('\n').replace(NEGATED_RE, '');
  const rules = [];
  if (String(risk).toUpperCase() === 'HIGH')
    rules.push(
      '- **High risk:** the fresh `pr-reviewer` pass is mandatory on every PR, on top of the routed external passes.'
    );
  if (MIGRATION_RE.test(all))
    rules.push(
      '- **Migration:** apply it BEFORE merging (merging deploys), verify live, merge, then confirm the deploy.'
    );
  if (FLAG_RE.test(all))
    rules.push(
      '- **Flag:** create it in Golden Frijoles in every env and ACTIVATE it; `gf flags get <key>` must show production.'
    );
  return rules.length ? `\nFor this epic:\n${rules.join('\n')}\n` : '';
}

export function buildEpicKickoff({ macro, slug, epicTitle, risk, sprints, templateText, texts = [] }) {
  return sub(templateText, {
    EPIC_RULES: buildEpicRules({ risk, texts }),
    MACRO: macro,
    SLUG: slug,
    EPIC_TITLE: epicTitle,
    RISK: risk,
    SPRINT_COUNT: String(sprints.length),
    SPRINT_FILE_LIST: buildSprintFileList(sprints),
    SPRINT_BREAKDOWN: buildSprintBreakdown(sprints),
  });
}

// The epic README header line carries `**Risk:** <low|high>`; the frontmatter doesn't. Falls back to
// 'high' — the WAYS-OF-WORKING rule is "when unsure, treat it as high", and a kickoff that under-declares
// risk is the one that skips the mandatory fresh-reviewer pass.
export function parseEpicRisk(text) {
  const m = text.match(/\*\*Risk:\*\*\s*([A-Za-z]+)/);
  return m ? m[1].toLowerCase() : 'high';
}

// ── filesystem helpers (thin, not unit-tested — exercised by the real run) ──────────────────

function die(msg) {
  console.error(`emit-epic-kickoff: ${msg}`);
  process.exit(1);
}

// Search Roadmap/*/<slug>/ under repoRoot — the macro-area prefix isn't knowable from the slug alone.
function findEpicDir(repoRoot, slug) {
  const roadmapDir = join(repoRoot, 'Roadmap');
  if (!existsSync(roadmapDir)) die(`no Roadmap/ dir under --repo-root "${repoRoot}"`);
  let macros;
  try {
    macros = readdirSync(roadmapDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    die(`couldn't read ${roadmapDir}: ${e.message}`);
  }
  const hits = macros.filter((m) => existsSync(join(roadmapDir, m, slug, 'README.md')));
  if (hits.length === 0) {
    die(`no epic found for slug "${slug}" under any Roadmap/*/ dir in "${repoRoot}" (searched: ${macros.join(', ') || '(none)'})`);
  }
  if (hits.length > 1) {
    die(`ambiguous slug "${slug}" — found under multiple macro-areas: ${hits.map((m) => `Roadmap/${m}/${slug}`).join(', ')}`);
  }
  return { macro: hits[0], dir: join(roadmapDir, hits[0], slug) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.epic || args.epic === true) {
    console.error('emit-epic-kickoff: missing required flag: --epic');
    console.error('Run with --epic <slug> [--repo-root <path>]');
    process.exit(1);
  }

  const slug = String(args.epic);
  const repoRoot = resolve(String(args['repo-root'] === true ? '' : args['repo-root'] || process.cwd()));
  const { macro, dir } = findEpicDir(repoRoot, slug);

  const readmeText = readFileSync(join(dir, 'README.md'), 'utf8');
  const frontmatter = parseFrontmatter(readmeText);
  if (frontmatter.slug && frontmatter.slug !== slug) {
    die(`Roadmap/${macro}/${slug}/README.md frontmatter slug "${frontmatter.slug}" != requested "${slug}"`);
  }

  const epicTitle = parseEpicTitle(readmeText);
  if (!epicTitle) die(`couldn't find an H1 title in Roadmap/${macro}/${slug}/README.md`);

  const found = listSprintFiles(readdirSync(dir));
  if (!found.length) die(`no sprint-N.md files under Roadmap/${macro}/${slug}/ — scaffold the epic first`);

  const sprints = found.map(({ name, num }) => {
    const text = readFileSync(join(dir, name), 'utf8');
    const header = parseSprintHeader(text);
    return { name, num, text, title: header ? header.sprintTitle : null, stories: parseStoryHeadings(text) };
  });

  // A single-sprint "epic" is the documented exception, not the default — say so instead of emitting a
  // whole-epic orchestration prompt for one sprint's worth of work.
  if (sprints.length === 1) {
    process.stderr.write(
      `⚠ "${slug}" has one sprint. Epic mode buys nothing here — the per-sprint kickoff is the right ` +
        `tool: node skills/groom/emit-kickoff.mjs --epic ${slug} --sprint 1\n` +
        `  (Emitting the epic-mode prompt anyway.)\n\n`
    );
  }

  const templatePath = join(TPL, 'epic-kickoff.md');
  if (!existsSync(templatePath)) die(`missing template: ${templatePath}`);

  process.stdout.write(
    buildEpicKickoff({
      macro,
      slug,
      epicTitle,
      risk: parseEpicRisk(readmeText).toUpperCase(),
      sprints,
      templateText: readFileSync(templatePath, 'utf8'),
      texts: [readmeText, ...sprints.map((s) => s.text)],
    })
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
