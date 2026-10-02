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
// (default cwd), reads the epic README and EVERY sprint-N.md, substitutes into EPIC_KICKOFF_TEMPLATE (lib/epic-kickoff.mjs)
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

// The builder, its parsers and the template text live in ONE file, `template/scripts/lib/epic-kickoff.mjs`, vendored
// here byte-for-byte (board-sinks-and-scrumban D17): the Hub's Ready-to-build card carries the kickoff the extractor
// builds from that same file, so the card and this CLI cannot print two different prompts. Re-exported for the spec.
import { parseArgs, parseFrontmatter } from './emit-kickoff.mjs';
import {
  sprintNumFromFilename,
  listSprintFiles,
  buildSprintFileList,
  compactStory,
  buildSprintBreakdown,
  buildEpicRules,
  buildEpicKickoff,
  parseEpicRisk,
  epicKickoffFromDir,
  EPIC_KICKOFF_TEMPLATE,
} from './vendor/lib/epic-kickoff.mjs';
import { wipWarning } from './vendor/lib/wip.mjs';
export {
  sprintNumFromFilename,
  listSprintFiles,
  buildSprintFileList,
  compactStory,
  buildSprintBreakdown,
  buildEpicRules,
  buildEpicKickoff,
  parseEpicRisk,
  EPIC_KICKOFF_TEMPLATE,
};

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

  let built;
  try {
    built = epicKickoffFromDir({ macro, slug, dir });
  } catch (err) {
    die(err.message);
  }

  // A single-sprint "epic" is the documented exception, not the default — say so instead of emitting a
  // whole-epic orchestration prompt for one sprint's worth of work.
  if (built.sprints.length === 1) {
    process.stderr.write(
      `⚠ "${slug}" has one sprint. Epic mode buys nothing here — the per-sprint kickoff is the right ` +
        `tool: node skills/groom/emit-kickoff.mjs --epic ${slug} --sprint 1\n` +
        `  (Emitting the epic-mode prompt anyway.)\n\n`
    );
  }

  // S3.4 — scrumban's pull as advice: one line on stderr when Building is at its WIP limit; the kickoff still prints.
  const wip = wipWarning({ root: repoRoot, excluding: slug });
  if (wip) process.stderr.write(`${wip}\n\n`);

  process.stdout.write(built.kickoff);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
