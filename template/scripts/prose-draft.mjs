#!/usr/bin/env node
// prose-draft.mjs — delegate FILE-DERIVED internal prose to a cheaper, different-family model.
//
// The cross-agent rail (cross-review / cross-panel) proved the primitive: pipe context into a
// foreign CLI, get one advisory pass back. This extends it from *reviewing code* to *drafting
// prose* — but only for artifacts whose inputs are FILES (epic docs, sprint docs, git log), not
// the builder's in-head context. That's the honest scope boundary: a PR body is cheapest written
// by the agent that just built the PR; a retrospective/poster entry is a synthesis of docs that
// are already on disk, which a cheap fast model drafts well and the coordinating agent edits.
//
// Modes (v1):
//   node scripts/prose-draft.mjs --kind retro  --epic Roadmap/<area>/<epic-dir>
//   node scripts/prose-draft.mjs --kind poster --epic Roadmap/<area>/<epic-dir>
//   node scripts/prose-draft.mjs --kind sprint-wrap --sprint Roadmap/<area>/<epic>/sprint-N.md
//
// Output: the draft on stdout (synchronous flush — LEARNINGS pipe-truncation rule). The caller
// reviews/edits/commits; this tool NEVER writes repo files itself (editorial control stays with
// the coordinating agent — same "advisory only" stance as cross-review).
//
// Model: agy with a cheap-fast pair by default (prose doesn't need Pro-tier reasoning; the
// coordinating agent is the editor). Override via PROSE_MODEL / PROSE_FALLBACK_MODEL.

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, writeSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasCmd, loadPromptBody, die, need } from './lib/cross-agent-cli.mjs';
import { writeProse, buildWriterPrompt, loadLessons } from './lib/prose-writer.mjs';
import { projectAsset, projectRoot } from './lib/project-root.mjs';
import { isMain } from './lib/is-main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = projectRoot(); // D2

// The model/router lives in scripts/lib/prose-writer.mjs now — deliberately NOT here.
//
// This file used to default to `gemini-3.5-flash-high`. That is the exact constant a consuming
// project identified as having silently destroyed the register of every report it wrote: the accepted
// drafts had come from GPT-OSS on the occasions Gemini's quota was exhausted, so the "fallback" was
// actually the good writer. The rail now pins a single non-Gemini model and routes devin first. Do not
// reintroduce a model constant here.

export const KINDS = ['retro', 'poster', 'sprint-wrap'];

// ── mode task blocks (pure) ─────────────────────────────────────────────────────────────────

export function taskBlock(kind) {
  switch (kind) {
    case 'retro':
      return `## Task: draft RETROSPECTIVE.md for the epic whose docs follow.
Shape (exactly these sections): a one-line header with the epic name + close date placeholder
(_Closed: YYYY-MM-DD_ — leave the placeholder if no date is in the sources); **## What shipped**
(per sprint, outcome-first, with PR/commit refs from the sources); **## What worked**;
**## What didn't / incidents** (plain, unsoftened); **## Gaps / follow-ups** (the owed ledger —
every unverified item, pending migration, human smoke); **## Durable learnings** (only the
*transferable* rules, each a bold one-liner + why + date/source, written so it can be pasted
into Roadmap/LEARNINGS.md — dedupe-aware: if a learning sharpens an existing well-known rule,
say "sharpens: <rule>"). Length budget: 60-90 lines.`;
    case 'poster':
      return `## Task: draft the product-poster entry for this epic (Roadmap/README.md house shape).
One dated bold-led bullet: **YYYY-MM-DD — <Epic name> (<n> sprint(s); <risk>, <surface>).**
followed by 3-8 sentences: the problem, what shipped (with PR refs), the load-bearing technical
decision(s), what's owed. Then one table-row line for the area README:
| [<slug>](<slug>/) | <one-line what> | ✅ **Shipped YYYY-MM-DD** (<refs + owed note>) |
Length budget: 12 lines max.`;
    case 'sprint-wrap':
      return `## Task: draft the sprint-wrap terminal summary (SESSION-KICKOFFS §7 shape) for the
sprint doc that follows. It is a THIN POINTER, never a re-summary: 4-8 lines — sprint name +
status, the one-line outcome per story (ref'd), the owed list, and "next:" with the next sprint
or close-out step. No headings, no code fences.`;
    default:
      return die(`unknown --kind "${kind}" (expected: ${KINDS.join(' | ')})`);
  }
}

// ── source gathering (I/O, thin) ────────────────────────────────────────────────────────────

function read(p) {
  return readFileSync(p, 'utf8');
}

function gitLogFor(paths) {
  // argv-array spawn, never a shell-built string — a path can't smuggle command substitution.
  const r = spawnSync('git', ['log', '--oneline', '-20', '--', ...paths], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0 ? (r.stdout || '').trim() : '(git log unavailable)';
}

export function gatherEpicSources(epicDir, { readFile = read, listDir = readdirSync, log = gitLogFor } = {}) {
  const files = listDir(epicDir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  if (!files.includes('README.md')) die(`${epicDir} has no README.md — is this an epic directory?`);
  const parts = files.map((f) => `\n\n### FILE: ${f}\n\n${readFile(join(epicDir, f))}`);
  return `## Source material — epic directory ${epicDir}${parts.join('')}\n\n### GIT LOG (epic paths)\n${log([epicDir])}`;
}

export function gatherSprintSources(
  sprintPath,
  { readFile = read, log = gitLogFor, exists = existsSync } = {}
) {
  const epicDir = dirname(sprintPath);
  const readme = join(epicDir, 'README.md');
  let out = `## Source material — sprint doc ${sprintPath}\n\n### FILE: ${sprintPath}\n\n${readFile(sprintPath)}`;
  if (exists(readme)) out += `\n\n### FILE (context): ${readme}\n\n${readFile(readme)}`;
  return `${out}\n\n### GIT LOG (epic paths)\n${log([epicDir])}`;
}

// ── prompt assembly (pure) ──────────────────────────────────────────────────────────────────

// The house voice now comes from the SHARED persona + the internal-artifact task file, so a change to
// the register reaches this surface and the two scheduled reports at once. What is genuinely local to
// this tool — its three mode shapes — lives in taskBlock. (The old prose-draft.prompt.md is retired;
// its internal-artifact rules moved into prose/internal.task.md.)
export function loadStylePrompt() {
  return [
    loadPromptBody(projectAsset('prose/cpo-persona.md')), // a TEMPLATE FILL-IN the project owns
    loadPromptBody(join(__dirname, 'prose', 'internal.task.md')),
  ].join('\n\n');
}

export function buildPrompt({ style, kind, sources, lessons = '' }) {
  // buildWriterPrompt owns the style→lessons→task ordering for BOTH backends, so the lessons file
  // cannot reach one surface and silently miss the other.
  return buildWriterPrompt({ style, lessons, task: `${taskBlock(kind)}\n\n${sources}` });
}

// ── main ────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let kind, epic, sprint;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--kind') kind = need(args[++i], '--kind');
    else if (args[i] === '--epic') epic = need(args[++i], '--epic');
    else if (args[i] === '--sprint') sprint = need(args[++i], '--sprint');
    else die(`unknown arg ${args[i]}`);
  }
  if (!kind || !KINDS.includes(kind)) die(`--kind is required (${KINDS.join(' | ')})`);

  if (!hasCmd('devin') && !hasCmd('agy')) {
    die('no prose writer available — this rail needs devin or agy on PATH (see scripts/README.md).');
  }

  let sources;
  if (kind === 'sprint-wrap') {
    if (!sprint) die('--sprint <path/to/sprint-N.md> is required for --kind sprint-wrap');
    sources = gatherSprintSources(resolve(REPO_ROOT, sprint));
  } else {
    if (!epic) die(`--epic <path/to/epic-dir> is required for --kind ${kind}`);
    sources = gatherEpicSources(resolve(REPO_ROOT, epic));
  }

  const prompt = buildPrompt({ style: loadStylePrompt(), kind, sources, lessons: loadLessons() });

  // These are INTERNAL engineering artifacts, so two guard rules that fit a chat-message report would
  // misfire here: refs/dates are required (not invented), and the length budget is a document, not 60
  // words. `allowsBeneficiary` stays TRUE because a retro legitimately discusses merchants and buyers.
  // The size cap is gone with the argv path — devin takes the prompt in a file.
  const result = await writeProse({
    prompt,
    evidence: {
      allowsFixClaim: true,
      allowsBeneficiary: true,
      allowsMarkdown: true,
      maxWords: 4000,
      minWords: 40,
    },
  });
  if (!result.text) die(result.error || 'no prose writer produced a draft.');

  // Advisory banner: names the writer AND the model that actually ran, plus whether the guard passed
  // clean — so a paste-without-reading stays self-identifying in review.
  const decided = result.guard?.decider ? ` by ${result.guard.decider}` : '';
  const verdict = result.ok
    ? `guard: clean${decided}`
    : `guard: FLAGGED${decided} (${result.guard.findings.map((f) => f.code).join(', ')})`;
  writeSync(
    1,
    `<!-- draft: prose-draft.mjs --kind ${kind} · writer ${result.writer}/${result.model} · ${verdict} · EDIT BEFORE COMMITTING -->\n${result.text}\n`
  );

  if (!result.ok) {
    process.stderr.write(
      `\n⚠ The guard rejected this draft and it did NOT converge after a revision pass:\n` +
        result.guard.findings.map((f) => `  · ${f.code}: ${f.note}`).join('\n') +
        `\n  Read it carefully before committing.\n\n`
    );
  }
}

if (isMain(import.meta.url))
  main().catch((e) => {
    process.stderr.write(`prose-draft: ${e?.message || e}\n`);
    process.exit(1);
  });
