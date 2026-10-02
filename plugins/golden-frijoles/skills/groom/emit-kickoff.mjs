#!/usr/bin/env node
// emit-kickoff.mjs — print the finished, paste-ready Stage-8 Claude Code kickoff for a groomed
// sprint. Planning-only helper for the `groom` skill (Stage 8). The invariant preamble (the
// orientation reads, plan-mode, escalate-don't-guess triggers, etc.) lives in
// `templates/kickoff.md` — this script's whole point is that boilerplate stops being retyped by
// hand per sprint; only the sprint-specific delta (epic title, sprint number + its own title,
// story list) is read out of the epic's own docs and substituted in.
//
// Usage:
//   node skills/groom/emit-kickoff.mjs --epic <slug> --sprint N [--repo-root <path>]
//
// Resolves the epic dir by SEARCHING Roadmap/*/<slug>/ under --repo-root (default: cwd) — the
// macro-area prefix (e.g. "09-platform-infra") isn't knowable from the slug alone. Reads that
// epic's README.md (frontmatter + H1 title) and sprint-<N>.md (H1 + `### Story N.M — <title>`
// headings), then substitutes into templates/kickoff.md and prints the result to stdout.
//
// It does NOT write any file — this is a read + print tool, same "advisory, editorial control
// stays with the caller" stance as the other groom/cross-agent scripts in this repo.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TPL = join(__dirname, 'templates');

// ── pure helpers (exported for the co-located test) ─────────────────────────────────────────

export function parseArgs(argv) {
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

// The doc parsers live in the epic kickoff builder now (board-sinks-and-scrumban D17), so the per-sprint and epic
// generators — and the Hub card's kickoff, which the extractor builds from the same file — read the doc format with
// ONE set of parsers. Re-exported for this file's spec and for any caller that imported them from here.
import {
  sub,
  parseFrontmatter,
  stripFrontmatter,
  parseEpicTitle,
  parseSprintHeader,
  parseStoryHeadings,
  sprintBranch,
  sprintBase,
} from './vendor/lib/epic-kickoff.mjs';
export { sub, parseFrontmatter, stripFrontmatter, parseEpicTitle, parseSprintHeader, parseStoryHeadings };

export function buildStoryList(headings) {
  if (!headings.length) return '(no `### Story N.M — <title>` headings found in the sprint doc)';
  return headings.map((h) => `- ${h}`).join('\n');
}

export function buildKickoff({ macro, slug, sprintNum, epicTitle, sprintTitle, storyList, templateText }) {
  return sub(templateText, {
    MACRO: macro,
    SLUG: slug,
    N: String(sprintNum),
    BRANCH: sprintBranch(slug, sprintNum),
    BASE: sprintBase(slug, sprintNum),
    EPIC_TITLE: epicTitle,
    SPRINT_TITLE: sprintTitle,
    STORY_LIST: storyList,
  });
}

// ── filesystem helpers (thin, not unit-tested — exercised by the real run) ──────────────────

function die(msg) {
  console.error(`emit-kickoff: ${msg}`);
  process.exit(1);
}

// Search Roadmap/*/<slug>/ under repoRoot — the macro-area prefix isn't knowable from the slug
// alone. Dies with a clear message if zero or more-than-one match is found.
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
  const missing = ['epic', 'sprint'].filter((k) => !args[k] || args[k] === true);
  if (missing.length) {
    console.error(`emit-kickoff: missing required flag(s): ${missing.map((m) => '--' + m).join(', ')}`);
    console.error('Run with --epic <slug> --sprint N [--repo-root <path>]');
    process.exit(1);
  }

  const slug = String(args.epic);
  const sprintNum = String(args.sprint);
  if (!/^\d+$/.test(sprintNum)) die(`--sprint must be a number (got "${sprintNum}")`);
  const repoRoot = resolve(String(args['repo-root'] || process.cwd()));

  const { macro, dir } = findEpicDir(repoRoot, slug);

  const readmePath = join(dir, 'README.md');
  const sprintPath = join(dir, `sprint-${sprintNum}.md`);
  if (!existsSync(sprintPath)) die(`no sprint-${sprintNum}.md under Roadmap/${macro}/${slug}/`);

  const readmeText = readFileSync(readmePath, 'utf8');
  const sprintText = readFileSync(sprintPath, 'utf8');

  const frontmatter = parseFrontmatter(readmeText);
  if (frontmatter.slug && frontmatter.slug !== slug) {
    die(`Roadmap/${macro}/${slug}/README.md frontmatter slug "${frontmatter.slug}" != requested "${slug}"`);
  }

  const epicTitle = parseEpicTitle(readmeText);
  if (!epicTitle) die(`couldn't find an H1 title in Roadmap/${macro}/${slug}/README.md`);

  const sprintHeader = parseSprintHeader(sprintText);
  if (!sprintHeader) die(`couldn't parse the H1 of Roadmap/${macro}/${slug}/sprint-${sprintNum}.md (expected "# <epic title> — Sprint <N>: <sprint title>")`);

  const storyHeadings = parseStoryHeadings(sprintText);
  const storyList = buildStoryList(storyHeadings);

  const templatePath = join(TPL, 'kickoff.md');
  if (!existsSync(templatePath)) die(`missing template: ${templatePath}`);
  const templateText = readFileSync(templatePath, 'utf8');

  const out = buildKickoff({ macro, slug, sprintNum, epicTitle, sprintTitle: sprintHeader.sprintTitle, storyList, templateText });
  process.stdout.write(out);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
