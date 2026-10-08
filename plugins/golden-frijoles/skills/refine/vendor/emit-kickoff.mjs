#!/usr/bin/env node
// emit-kickoff.mjs — print the finished, paste-ready Stage-8 Claude Code kickoff for a groomed
// sprint. Planning-only helper for the `refine` skill (Stage 8). The invariant preamble (the
// orientation reads, plan-mode, escalate-don't-guess triggers, etc.) lives in
// `templates/kickoff.md` — this script's whole point is that boilerplate stops being retyped by
// hand per sprint; only the sprint-specific delta (epic title, sprint number + its own title,
// story list) is read out of the epic's own docs and substituted in.
//
// Usage, from the project root (the project's own `scripts/` copy wins, else the kit):
//   npx -y @golden-frijoles/kit emit-kickoff --epic <slug> --sprint N [--repo-root <path>]
//
// One source, three homes (kickoff-generator-path C1): this file ships in the kit, a project spawned from the template
// carries it in `scripts/`, and the refine skill holds a byte-identical copy in `vendor/` (render-hook-vendor.mjs).
// The template is read from this file's own directory, which is the kit root in all three.
//
// Resolves the epic dir by SEARCHING Roadmap/*/<slug>/ under the project root (lib/kickoff-cli.mjs) — the
// macro-area prefix (e.g. "09-platform-infra") isn't knowable from the slug alone. Reads that
// epic's README.md (frontmatter + H1 title) and sprint-<N>.md (H1 + `### Story N.M — <title>`
// headings), then substitutes into templates/kickoff.md and prints the result to stdout.
//
// It does NOT write any file — this is a read + print tool, same "advisory, editorial control
// stays with the caller" stance as the other refine/cross-agent scripts in this repo.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs, resolveRepoRoot, findEpicDir } from './lib/kickoff-cli.mjs';
export { parseArgs };

const __dirname = dirname(fileURLToPath(import.meta.url));
const TPL = join(__dirname, 'templates');

// ── pure helpers (exported for the co-located test) ─────────────────────────────────────────

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
} from './lib/epic-kickoff.mjs';
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
  const repoRoot = resolveRepoRoot(args);

  const found = findEpicDir(repoRoot, slug);
  if (found.error) die(found.error);
  const { macro, dir } = found;

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

// realpath on both sides (D6): run through a symlinked path (npx's bin link, macOS /tmp → /private/tmp) a plain
// compare is false and the script would exit 0 having printed nothing.
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) main();
