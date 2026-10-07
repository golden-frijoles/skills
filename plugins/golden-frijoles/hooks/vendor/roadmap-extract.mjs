#!/usr/bin/env node
// roadmap-extract.mjs — project the Roadmap docs into rows: the ONE status extractor every roadmap tool reads.
//
//   node scripts/roadmap-extract.mjs              # rows as JSON; stage from the docs + the last snapshot of facts
//   node scripts/roadmap-extract.mjs --live       # gather git/GitHub facts now (one ls-remote, one gh call)
//   node scripts/roadmap-extract.mjs --docs-only  # no facts at all — what the committed BUILD-ORDER.md reads
//   … --live --require-live                        # exit 3 instead of falling back (what a publisher passes)
//   node scripts/roadmap-extract.mjs --sink terminal  # the six-stage board as text (live facts unless told otherwise)
//   node scripts/roadmap-extract.mjs --sink hub       # push the board to the Hub (GROWTH_ENGINE_URL + the project key, see roadmap-push)
//   node scripts/roadmap-extract.mjs --sink notion    # run the optional Notion sync copied beside this file
//
// ── One extractor (board-sinks-and-scrumban D15) ─────────────────────────────────────────────────────────
// This file is THE projection, byte-identical in every project's scripts/ and in the kit. It used to have a fork in
// the origin repo (scripts/roadmap-to-notion.mjs --extract) that had grown folder-derived area names, `status_date`
// and `build_order_num` while this copy still carried another product's area names; the fork is gone and those
// fields live here. The Notion push imports buildRows() from here.
//
// ── Stage (D13/D14/D21) ──────────────────────────────────────────────────────────────────────────────────
// Every Epic and Seed row carries `stage` — one of the six words in lib/stage.mjs, or null (archived) — with the
// `stage_source` it was read from, plus the card's prose (`goal`, `sprints`, `links`, `pr`, `kickoff`,
// `shipped_at`). The default reads facts from `.golden-frijoles/board.json` and never touches the network: six
// callers spawn this with no flags, one of them inside the pre-commit hook. `--live` refreshes the facts.
// `status` and `status_derived` stay as the legacy fields Notion's Status column and older views read.
//
// Readers: build-order.mjs (BUILD-ORDER.md), doc-hygiene.mjs (archived-epic checks), pmo-report.mjs (story
// progress), and — only if a project opts in — optional/notion/roadmap-to-notion.mjs, which pushes these
// same rows to a Notion board.
//
// ── Why this is its own file (plugin-audit-and-extraction S1, story 1.5) ────────────────────────────────
// This used to be the first half of roadmap-to-notion.mjs, the largest file in the copy-once skeleton, for
// an integration most projects never use. But the half every project DOES use — the extractor — was
// inside it, so the Notion sync could not be made opt-in without breaking build-order.mjs. The split puts
// the SSOT here, under a name that says what it is, and moves only the Notion push to optional/notion/.
// The extraction logic is unchanged.
//
// Grain (full funnel, 3 grains):
//   • Epic   — one row per epic folder under Roadmap/<NN-macro>/<slug>/ (has a README.md)
//   • Sprint — one row per sprint-N.md inside an epic, linked to its Epic via the "Epic" relation
//   • Seed   — one row per seed in 00-ideas/seeds/ whose frontmatter epic == null (un-scaffolded funnel)
//
// Status derivation (docs win, re-derived every run):
//   EPIC: the AUTHORITATIVE source is the epic README's frontmatter `status:` field
//     (shipped|in-progress|scaffolded|queued|archived), set at epic close. Sprint/retro derivation is
//     kept ONLY as a fallback when the frontmatter field is ABSENT, and is also emitted as `status_derived`
//     so the board can flag an advisory drift (frontmatter vs derived) when a close-out forgets to set it.
//     A PRESENT but unrecognized value HARD-FAILS the run — it used to silently fall back to the derived
//     status, which made status === status_derived by construction, so the drift check structurally could
//     not fire on invalid enum values (how `mercadolibre-sync` sat at `status: ready` while fully live;
//     Roadmap/00-ideas/audits/roadmap-grooming-audit-2026-07-06.md §1). Seed `status:` is enforced the
//     same way against its own enum.
//   SPRINT: read its `Status:` line (controlled vocab below) → else count story ticks.
//     Planned (none started) · In progress (some stories ✅) · In review (all ✅, not yet closed out /
//     "built — awaiting review/draft PR") · Shipped (✅ merged/shipped, or all ✅ + smoke walkthrough written).
//   EPIC fallback: rolled up from its sprints — all Shipped ⇒ Shipped · any active ⇒ In progress · all Planned ⇒ Scaffolded.
//   SEED: its frontmatter status (raw|ready|queued|archived). A seed with `epic:` set is funnel-only —
//     its status is NOT read for epic status (the epic README frontmatter owns that).
//
// NOTE on the sprint `**Status:**` line: the "Wrap S<n>" step (SESSION-KICKOFFS §7) should set it to one of
//   ⬜ Planned · 🏗 In progress · 🟦 In review · ✅ Shipped — that keeps this projection trivially reliable.
//   Legacy freeform lines are still mapped best-effort below.

import { readFileSync, readdirSync, existsSync, statSync, writeSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { projectRoot } from './lib/project-root.mjs';
import { attributeFacts, resolveStage } from './lib/stage.mjs';
import { gatherFacts } from './lib/stage-facts.mjs';
import { epicKickoffFromDir, sprintBranch } from './lib/epic-kickoff.mjs';
import { renderBoardText } from './lib/board-text.mjs';
import {
  FINOPS_FIELDS,
  FINOPS_NUMERIC_FIELDS,
  RESULT_DAY_FIELDS,
  RESULT_FIELDS,
  RESULT_NUMERIC_FIELDS,
  VERDICTS,
} from './lib/roadmap-contract.mjs';
import { isDay, isLate, readDateOf } from './lib/result-dates.mjs';
import { pushRoadmap, reportPush } from './roadmap-push.mjs';

const REPO = projectRoot(); // D2 — the CLI's default root; buildRows takes its own

// Area labels are DERIVED from the project's own macro-section folders (`Roadmap/NN-slug/` → "NN Slug Title-Cased"),
// never hardcoded: a hardcoded map was another product's area list and mislabeled every line it touched. A number
// with no folder yet (a seed for a future area) falls back to the raw number.
export function areaNames(roadmapDir) {
  if (!existsSync(roadmapDir)) return {};
  return Object.fromEntries(
    readdirSync(roadmapDir)
      .filter((d) => /^\d{2}-/.test(d) && statSync(join(roadmapDir, d)).isDirectory())
      .map((d) => {
        const [, num, slug] = d.match(/^(\d{2})-(.+)$/);
        const label = slug
          .split('-')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
        return [num, `${num} ${label}`];
      })
  );
}

const SEED_STATUS_LABEL = {
  raw: 'Raw',
  ready: 'Ready',
  queued: 'Queued',
  scaffolded: 'Scaffolded',
  'in-progress': 'In progress',
  shipped: 'Shipped',
  archived: 'Archived',
};
const TYPE_LABEL = { feature: 'Feature', spike: 'Spike', chore: 'Chore', bug: 'Bug', epic: 'Epic' };

/**
 * finops D6 — an epic's quote and actual, off its README frontmatter (this file's own line reader yields strings).
 * A number field that does not read as a finite number >= 0 is null, never 0: doc-format reports the bad value, and
 * the board must not show a quote nobody wrote. The field list is the contract's, not a second copy.
 */
export function finopsFields(fm) {
  const out = {};
  for (const key of FINOPS_FIELDS) {
    const raw = fm[key];
    if (FINOPS_NUMERIC_FIELDS.includes(key)) {
      const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
      out[key] = Number.isFinite(n) && n >= 0 ? n : null;
    } else out[key] = typeof raw === 'string' && raw ? raw : null;
  }
  return out;
}

/**
 * result-record D5 — an epic's target and verdict, off its README frontmatter, plus what is DERIVED from them: the
 * default read date (30 days after shipping, only for a shipped epic that has a target) and whether a verdict came
 * late (more than 90 days after shipping). Derived here and labelled, never written back into the README. A value
 * that does not read as its type is null (doc-format names it); a number is never invented as 0.
 */
export function resultFields(fm, shippedAt) {
  const out = {};
  for (const key of RESULT_FIELDS) {
    const raw = fm[key];
    const blank = raw === null || raw === undefined || raw === '' || raw === 'null' || raw === '~';
    if (RESULT_NUMERIC_FIELDS.includes(key)) {
      // A numeral or a number, nothing else (codex review, #290): `Number(' ')` is 0 and `Number(true)` is 1.
      const numeral = typeof raw === 'string' && /^-?\d+(?:\.\d+)?$/.test(raw.trim());
      const n = typeof raw === 'number' ? raw : numeral ? Number(raw) : NaN;
      out[key] = !blank && Number.isFinite(n) ? n : null;
    } else if (RESULT_DAY_FIELDS.includes(key)) out[key] = isDay(raw) ? raw : null;
    else if (key === 'verdict') out[key] = VERDICTS.includes(raw) ? raw : null;
    else out[key] = !blank && typeof raw === 'string' ? raw : null;
  }
  const { readDate, derived } = readDateOf({
    readDate: out.read_date,
    targetMetric: out.target_metric,
    shippedAt,
  });
  out.read_date = readDate;
  out.read_date_derived = derived;
  out.read_late = out.verdict ? isLate({ verdictAt: out.verdict_at, shippedAt }) : false;
  return out;
}

function parseFrontmatter(md) {
  if (!md.startsWith('---')) return {};
  const end = md.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = md.slice(3, end).trim();
  const fm = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (v[0] === '"' || v[0] === "'") {
      const q = v[0];
      const e = v.indexOf(q, 1);
      v = e > 0 ? v.slice(1, e) : v.slice(1); // quoted: take inside quotes (keeps '#5')
    } else {
      const h = v.search(/\s#/);
      if (h >= 0) v = v.slice(0, h); // strip inline ` # comment`
      v = v.trim();
      if (v === 'null' || v === '') v = null;
    }
    fm[m[1]] = v;
  }
  return fm;
}

function readSeeds(seedsDir) {
  if (!existsSync(seedsDir)) return [];
  return readdirSync(seedsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const fm = parseFrontmatter(readFileSync(join(seedsDir, f), 'utf8'));
      seedStatusLabel(fm.status, `Roadmap/00-ideas/seeds/${f}`); // hard-fail on an invalid enum value
      seedAppetite(fm.appetite, `Roadmap/00-ideas/seeds/${f}`); // hard-fail on an invalid appetite
      return { ...fm, _file: `Roadmap/00-ideas/seeds/${f}` };
    });
}

// Seed frontmatter `status:` → board label. Absent → 'Raw' (legacy tolerance); a PRESENT but
// unrecognized value THROWS — a typo'd status would otherwise silently land the seed in the wrong
// funnel bucket (e.g. `status: seed` read as Raw). Validated for EVERY seed, funnel-only ones
// included, so the documented enum holds repo-wide.
export function seedStatusLabel(status, file = 'seed') {
  if (status == null) return 'Raw';
  const label = SEED_STATUS_LABEL[status];
  if (!label) {
    throw new Error(
      `${file}: unrecognized seed frontmatter status "${status}" — valid values: ${Object.keys(SEED_STATUS_LABEL).join(' | ')}`
    );
  }
  return label;
}

// Seed frontmatter `appetite:` — the economics enum (WAYS-OF-WORKING → Betting & appetite).
// Absent → null (the funnel tolerates unshaped ideas); a PRESENT but unrecognized value THROWS,
// same rationale as the status enum — a typo'd appetite must not silently pass for funded work.
// Whether an appetite is REQUIRED (at `status: queued`) is build-order.mjs's enforcement; this
// only guards the vocabulary.
const APPETITES = new Set(['S', 'M', 'L']);
export function seedAppetite(appetite, file = 'seed') {
  if (appetite == null) return null;
  if (!APPETITES.has(appetite)) {
    throw new Error(
      `${file}: unrecognized seed frontmatter appetite "${appetite}" — valid values: S | M | L`
    );
  }
  return appetite;
}

function listEpicDirs(roadmapDir) {
  const out = [];
  for (const macro of readdirSync(roadmapDir)) {
    if (!/^[0-9]{2}-/.test(macro)) continue; // macro-section folders only
    const macroPath = join(roadmapDir, macro);
    if (!statSync(macroPath).isDirectory()) continue;
    for (const slug of readdirSync(macroPath)) {
      const epicPath = join(macroPath, slug);
      if (!statSync(epicPath).isDirectory()) continue;
      if (!existsSync(join(epicPath, 'README.md'))) continue;
      out.push({ macro, slug, path: epicPath, area: macro.slice(0, 2) });
    }
  }
  return out;
}

function epicTitle(epicPath, slug) {
  try {
    const first = readFileSync(join(epicPath, 'README.md'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('# '));
    if (first) return first.replace(/^#\s+(Epic\s*[—·:\-]\s*)?/i, '').trim();
  } catch {}
  return slug;
}

// --- story counting: tolerant of the real heading drift. Stories appear at BOTH `## US-1` (level-2,
// e.g. support-widget) and `### S1.1` (level-3), as `Story 1.1` / `S1` / `US-1`, and the #3c B/C/D
// epics label them by epic-letter (`## C.1`, `### B1.1`, `## D.2`). Matching only `### S/US/Story`
// silently undercounted ~22 epics to "0 stories" (status then leaned on the retro-floor by luck). The
// letter form requires a `.digit` (`[A-Z]\d*\.\d+`) so it can't false-fire on `## QA` / `## Stories`. ---
// A heading may lead with its own status mark (`### ✅ S1.1 …`).
const STORY_RE =
  /^#{2,3}\s+(?:✅|⬜|🟦|🏗️?)?\s*(?:Story\s+\d+|S\d+(?:\.\d+)?(?:\s*\([^)]*\))?|US-\d+|[A-Z]\d*\.\d+)\b/i;
export function countStories(body) {
  let total = 0,
    done = 0;
  for (const line of body.split('\n')) {
    if (STORY_RE.test(line)) {
      total++;
      if (line.includes('✅')) done++;
    }
  }
  return { total, done };
}

// --- sprint status: the `Status:` line first, then story ticks. Accept both `**Status:**` (bold) and a
// plain `Status:` line — real sprint files use both (e.g. support-widget writes `Status: ✅ shipped`). ---
function deriveSprintStatus(body) {
  const hasSmoke = /Smoke walkthrough \(do these|—\s*Smoke walkthrough/i.test(body);
  const m = body.match(/^(?:\*\*)?Status:(?:\*\*)?\s*(.+)$/im);
  const line = (m ? m[1] : '').trim();
  const s = line.toLowerCase();
  if (line) {
    if (/⬜|not started|^planned\b/.test(s)) return 'Planned';
    if (/🟦|in review|awaiting\s*(pr|review)|draft\s*\[?pr|built\s*—.*(awaiting|review|draft)/.test(s))
      return 'In review';
    if (/✅/.test(line) && /(shipped|merged|live|in prod|to\s*`?main`?|on\s*`?main`?)/.test(s))
      return 'Shipped';
    if (/✅\s*built|built\s*\(/.test(s)) return 'In review'; // "built" with no merge word ⇒ not yet shipped
    if (/🏗|in progress|wip|building\b/.test(s)) return 'In progress';
    if (/✅/.test(line)) return 'Shipped';
  }
  const { total, done } = countStories(body);
  if (total > 0) {
    if (done === total) return hasSmoke ? 'Shipped' : 'In review';
    if (done > 0) return 'In progress';
    return 'Planned';
  }
  return 'Planned';
}

function sprintTitleFrom(body, n) {
  const first = body.split('\n').find((l) => l.startsWith('# ')) || '';
  const m = first.match(/Sprint\s+\d+\s*[:—\-]\s*(.+)$/i);
  return m ? m[1].trim() : `Sprint ${n}`;
}

function epicSprints(epicPath) {
  return readdirSync(epicPath)
    .filter((f) => /^sprint-(\d+)\.md$/.test(f))
    .map((f) => Number(f.match(/^sprint-(\d+)\.md$/)[1]))
    .sort((a, b) => a - b)
    .map((n) => {
      const body = readFileSync(join(epicPath, `sprint-${n}.md`), 'utf8');
      const { total, done } = countStories(body);
      return { n, title: sprintTitleFrom(body, n), status: deriveSprintStatus(body), total, done };
    });
}

// A written, DATED retrospective is the strongest "this epic closed" signal. The scaffold template only
// carries a literal `<date>` placeholder, so requiring a real ISO date avoids false-firing on stubs.
function epicShippedByRetro(epicPath) {
  const f = join(epicPath, 'RETROSPECTIVE.md');
  if (!existsSync(f)) return false;
  const t = readFileSync(f, 'utf8');
  // A retrospective is written at epic CLOSE (the epic DoD) and carries a real date; the scaffold STUB
  // only has a literal `_Closed: <date>_` placeholder (no real date). So a real ISO date anywhere in the
  // retro ⇒ the epic was closed/shipped. This avoids false-firing on un-built scaffolds.
  // NOTE: do NOT anchor with \b on either side. The scaffold renders the close date markdown-italicised
  // as `_Closed: 2026-06-09_`, and `_` is a word character, so a trailing \b fails immediately after the
  // date and a real underscore-wrapped close-date would be missed (this regressed agent-readable-about-
  // surface Shipped→In progress). A bare date pattern matches it; the literal `<date>` stub has no digits.
  return /20\d\d-\d\d-\d\d/.test(t);
}

// `epicFmStatus` is the raw README frontmatter `status:` (or undefined). Archival is a frontmatter-only
// decision — it cannot be derived from sprints/retro — so when the epic declares `archived`, the
// derivation must also say Archived; otherwise an archived epic with open-looking sprints false-flags
// drift (status=Archived vs status_derived=In progress) on EVERY board regeneration, forever.
export function deriveEpicStatus(sprints, retroShipped, epicFmStatus) {
  if (epicFmStatus === 'archived') return 'Archived';
  if (retroShipped) return 'Shipped';
  if (sprints.length && sprints.every((s) => s.status === 'Shipped')) return 'Shipped';
  if (sprints.some((s) => s.status === 'Shipped' || s.status === 'In progress' || s.status === 'In review'))
    return 'In progress';
  return 'Scaffolded'; // scaffolded-only / all Planned
}

// AUTHORITATIVE epic status: the README frontmatter `status:` field (set at epic close). Returns the
// board bucket, or null when the README has NO frontmatter status (→ caller falls back to derivation).
// A PRESENT but unrecognized value THROWS: it used to return null and silently fall back to the derived
// status, which made `status === status_derived` by construction — so the advisory drift check could
// never fire on exactly the class of error it exists to catch (an epic mislabeled with an out-of-enum
// value, e.g. `mercadolibre-sync` at `status: ready` while fully shipped; audit 2026-07-06 §1).
const EPIC_FM_TO_BUCKET = {
  shipped: 'Shipped',
  'in-progress': 'In progress',
  scaffolded: 'Scaffolded',
  queued: 'Scaffolded',
  archived: 'Archived',
};
function epicFrontmatter(epicPath) {
  return parseFrontmatter(readFileSync(join(epicPath, 'README.md'), 'utf8'));
}
export function frontmatterStatusBucket(fm, doc = 'epic README') {
  if (!fm.status) return null;
  const bucket = EPIC_FM_TO_BUCKET[fm.status];
  if (!bucket) {
    throw new Error(
      `${doc}: unrecognized epic frontmatter status "${fm.status}" — valid values: ${Object.keys(EPIC_FM_TO_BUCKET).join(' | ')}`
    );
  }
  return bucket;
}

// Coerce a `build_order` frontmatter value: numeric → Number (so the Notion views sort right), a legacy
// non-numeric seed value (e.g. "#3c") passes through unchanged, empty/absent → null.
export function normalizeBuildOrder(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  return /^-?\d+$/.test(s) ? Number(s) : v;
}

// Numeric sort key for build order: "#3" → 3, "#3c" → 3, 4 → 4, absent → null. The display value stays as-is;
// this feeds a NUMBER sort (rich text sorted "#10" before "#2").
export function buildOrderNum(v) {
  if (v === null || v === undefined) return null;
  const m = String(v).match(/\d+/);
  return m ? Number(m[0]) : null;
}

// When a row ENTERED its current status: the last commit whose diff touched the status-bearing line, else the
// file's last commit, else today (a brand-new uncommitted scaffold entered its status now). Docs + git stay the SSOT.
function gitDate(root, args) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%as', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}
function statusDate(root, relFile, statusLineRegex) {
  return (
    (statusLineRegex && gitDate(root, [`-G${statusLineRegex}`, '--', relFile])) ||
    gitDate(root, ['--', relFile]) ||
    new Date().toISOString().slice(0, 10)
  );
}

// Floor a sprint's derived status against its epic's AUTHORITATIVE status, so the Sprints board never
// shows an archived epic full of "Planned" sprints (S1.1) nor a Shipped epic with stale "Planned" ones.
// Real in-flight signals (In progress / In review) are preserved on non-archived epics.
export function floorSprintStatus(epicStatus, sprintStatus) {
  // A TERMINAL epic forces ALL its sprints to that terminal state — a shipped/archived epic cannot have
  // an "In progress"/"In review"/"Planned" sprint (those leaked onto the board as stale in-flight rows
  // when this only floored Planned). Only a non-terminal epic keeps the real per-sprint signal.
  if (epicStatus === 'Archived') return 'Archived';
  if (epicStatus === 'Shipped') return 'Shipped';
  return sprintStatus;
}

// A sprint whose (floored) status is Shipped has shipped ALL its stories. Completion is very often
// recorded in the sprint's `Status:` line or a per-story summary table instead of a ✅ on each story
// heading — countStories() only sees heading ticks, which understated progress for ~20 epics (a fully
// shipped epic read "0/15 stories"; audit 2026-07-06 §6). Applied to the FLOORED status (not the raw
// derivation) so both undercount patterns heal: sprints that declare ✅ merged themselves, and
// stale-Planned sprints inside a frontmatter-`shipped` epic. Archived is NOT floored — archived
// stories were dropped, not done.
export function floorSprintDone(sprintStatus, total, done) {
  return sprintStatus === 'Shipped' && total > 0 ? total : done;
}

// Per-sprint Claude Code kickoff — the SESSION-KICKOFFS.md §2 "Build a sprint" thin-pointer template,
// filled from values already in scope. Generated (not stored per-sprint) so it can't drift; surfaced as a
// Notion "Kickoff" property so an open Sprint card carries its ready-to-paste prompt. Mirror §2 if it changes.
function sprintKickoff({ epicKey, slug, n, risk }) {
  const tier = risk === 'High' ? 'HIGH' : 'LOW';
  // TEMPLATE FILL-IN: replace <AGENTS-path> with this project's real AGENTS.md path (see
  // SESSION-KICKOFFS.md §2, which this function mirrors).
  let k = [
    `Read <AGENTS-path> (Start here) + Roadmap/LEARNINGS.md, then`,
    `Roadmap/${epicKey}/README.md + sprint-${n}.md.`,
    `Build Sprint ${n} of "${slug}" per WAYS-OF-WORKING, in your OWN git worktree off latest main on`,
    `${sprintBranch(slug, n)} (stacked). Plan mode → confirm stories with me → build one story at a time. Commit per story`,
    `PATH-SCOPED (git add <your files> && git commit -- <those paths>; never -A). One api spec`,
    `per testable story. Keep the CI gate green; open a draft PR declaring risk ${tier}, and flip it`,
    `ready-for-review (+ sprint Status → 🟦 In review) once the gate is green and self-QA is posted.`,
    `Write the sprint smoke walkthrough into sprint-${n}.md before calling it done.`,
  ].join('\n');
  if (risk === 'High')
    k += `\nHIGH-risk: all stories HIGH → the product owner merges; the authed money-path browser smoke is owed to them.`;
  return k;
}

// ── The card's prose (D21) ─────────────────────────────────────────────────────────────────────────────────
const GOAL_MAX = 600;

/**
 * The first paragraph under the first of `headings` (`## Why`, `## Problem` …): whitespace collapsed, bold markers
 * dropped, clipped at a word to GOAL_MAX. null when none of the headings has a paragraph under it.
 */
export function firstParagraph(md, headings) {
  const lines = String(md).split('\n');
  for (const heading of headings) {
    const at = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
    if (at === -1) continue;
    const para = [];
    for (const line of lines.slice(at + 1)) {
      if (/^#{1,6}\s/.test(line)) break;
      if (!line.trim()) {
        if (para.length) break;
        continue;
      }
      para.push(line.trim());
    }
    if (!para.length) continue;
    const text = para.join(' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    if (text.length <= GOAL_MAX) return text;
    const cut = text.slice(0, GOAL_MAX - 1);
    return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : cut.length)}…`;
  }
  return null;
}

// The branch prefix a fixed-scope seed is built on, by its type.
const SEED_BRANCH_PREFIX = { bug: 'fix', chore: 'chore', spike: 'spike', feature: 'feat' };

/** The kickoff a queued seed (fixed scope, no epic) carries on its Ready-to-build card. */
export function seedKickoff({ slug, title, type, file }) {
  const branch = `${SEED_BRANCH_PREFIX[type] ?? 'feat'}/${slug}`;
  return [
    `Start by pushing the branch, before anything else — it is what moves this card to Building on the board:`,
    `\`git switch -c ${branch} origin/main && git push -u origin ${branch}\` (resuming? \`git switch ${branch}\`).`,
    ``,
    `Build: "${title}" — fixed scope, one builder session. The scope is ${file}.`,
    `The process is Roadmap/WAYS-OF-WORKING.md under AGENTS.md: build, verify, open a PR, route its review with`,
    `\`node scripts/review-route.mjs --builder <who-wrote-it> <PR#>\`, merge on green, then mark the seed shipped.`,
  ].join('\n');
}

const prOf = (pr) =>
  pr ? { number: pr.number, url: pr.url, state: pr.state, draft: Boolean(pr.draft) } : null;

/**
 * Build the rows. `facts` is what lib/stage-facts.mjs gathered (`{ branches, prs, origin }`); the default is no
 * facts, so an import — doc-hygiene, pmo-report, a spec — never touches the network or the snapshot.
 */
export function buildRows({
  facts = { branches: [], prs: [], origin: null },
  root = REPO,
  dates = true,
} = {}) {
  const ROADMAP = join(root, 'Roadmap');
  const AREA_NAMES = areaNames(ROADMAP);
  // `dates: false` skips the per-row `git log` (one per doc) — the build view runs inside a 5-second hook budget and
  // reads no date; every other field is the same either way.
  const when = (rel, re) => (dates ? statusDate(root, rel, re) : null);
  const seeds = readSeeds(join(ROADMAP, '00-ideas', 'seeds'));
  const seedByEpic = new Map();
  for (const s of seeds) if (s.epic) seedByEpic.set(s.epic, s);

  const rows = [];
  const epicDirs = listEpicDirs(ROADMAP);

  // Which initiative each branch and PR belongs to (D13): epic slugs and funnel-seed slugs are the names a branch can
  // carry; a seed that carries `epic:` names that epic.
  const known = new Set([...epicDirs.map((e) => e.slug), ...seeds.map((x) => x.slug)]);
  const alias = new Map(seeds.filter((x) => x.epic).map((x) => [x.slug, String(x.epic).split('/').pop()]));
  const byInitiative = attributeFacts(facts, known, alias);
  const stageFor = (slug, row) => {
    const own = byInitiative.get(slug) ?? { branches: [], prs: [] };
    return resolveStage(row, { branches: own.branches }, { prs: own.prs }, facts.origin ?? null);
  };

  for (const e of epicDirs) {
    const epicKey = `${e.macro}/${e.slug}`;
    const seed = seedByEpic.get(epicKey) || {};
    const sprints = epicSprints(e.path);
    const retroShipped = epicShippedByRetro(e.path);
    const epicFm = epicFrontmatter(e.path); // read README frontmatter once
    const statusDerived = deriveEpicStatus(sprints, retroShipped, epicFm.status); // prose/retro fallback + drift signal (archived short-circuits)
    const status = frontmatterStatusBucket(epicFm, `Roadmap/${epicKey}/README.md`) || statusDerived; // README frontmatter is authoritative; invalid value throws
    const buildOrder = normalizeBuildOrder(epicFm.build_order ?? seed.build_order); // epic FM is SSOT, seed fallback
    // Board view of each sprint: status floored against the authoritative epic status, done-count
    // floored against THAT (a Shipped sprint shipped all its stories — see floorSprintDone). The raw
    // `sprints` array stays untouched above so statusDerived / the drift signal never feed on the floor.
    const boardSprints = sprints.map((sp) => {
      const st = floorSprintStatus(status, sp.status);
      return { ...sp, status: st, done: floorSprintDone(st, sp.total, sp.done) };
    });
    const totStories = boardSprints.reduce((a, s) => a + s.total, 0);
    const doneStories = boardSprints.reduce((a, s) => a + s.done, 0);
    const area = AREA_NAMES[e.area] || e.area;
    const riskWord = epicFm.risk || seed.risk;
    const risk = riskWord ? (riskWord === 'high' ? 'High' : 'Low') : null;
    const readmePath = `Roadmap/${epicKey}/README.md`;
    const statusKey =
      epicFm.status ||
      (statusDerived === 'Shipped' ? 'shipped' : statusDerived === 'Archived' ? 'archived' : 'scaffolded');
    const {
      stage,
      source: stageSource,
      pr,
    } = stageFor(e.slug, {
      grain: 'Epic',
      status: statusKey,
      sprints: sprints.map((sp) => ({ n: sp.n, status: sp.status })), // each sprint's OWN docs status, not floored
      sprints_total: sprints.length,
    });
    const statusDay = when(readmePath, '^status:');
    let kickoff = null;
    if (stage === 'Ready to build') {
      try {
        kickoff = epicKickoffFromDir({ macro: e.macro, slug: e.slug, dir: e.path }).kickoff;
      } catch {
        kickoff = null; // an epic with no H1 or no sprint files has no kickoff to offer; the card says so by omission
      }
    }

    // Epic row
    rows.push({
      name: epicTitle(e.path, e.slug),
      slug: e.slug,
      grain: 'Epic',
      status,
      status_derived: statusDerived, // prose/retro derivation — for the advisory drift check on the board
      status_date: statusDay,
      stage,
      stage_source: stageSource,
      area,
      type: TYPE_LABEL[epicFm.type || seed.type] || 'Epic',
      risk,
      // finops D20 — the README's own appetite first (an epic groomed after FinOps carries it), else the seed's.
      appetite: epicFm.appetite || seed.appetite || null,
      // fund-at-approval D8 — the README's own first (an epic with no seed carries it there), else the seed's.
      underwritten_by: epicFm.underwritten_by || seed.underwritten_by || null,
      sprint_progress: totStories ? `${doneStories}/${totStories} stories` : `${sprints.length} sprints`,
      build_order: buildOrder,
      build_order_num: buildOrderNum(buildOrder),
      doc_link: readmePath,
      epic_slug: null,
      goal: firstParagraph(readFileSync(join(e.path, 'README.md'), 'utf8'), ['Why', 'Goal', 'Problem']),
      sprints: boardSprints.map((sp) => ({ n: sp.n, title: sp.title, done: sp.done, total: sp.total })),
      links: {
        readme: readmePath,
        seed: seed._file || null,
        sprints: boardSprints.map((sp) => `Roadmap/${epicKey}/sprint-${sp.n}.md`),
        retro: existsSync(join(e.path, 'RETROSPECTIVE.md')) ? `Roadmap/${epicKey}/RETROSPECTIVE.md` : null,
      },
      pr: prOf(pr),
      kickoff,
      shipped_at: stage === 'Shipped' ? statusDay : null,
      ...finopsFields(epicFm),
      ...resultFields(epicFm, stage === 'Shipped' ? statusDay : null),
    });

    // Sprint rows (one per sprint-N.md), related to the Epic by slug. boardSprints already carries
    // the floored status (archived epic ⇒ Archived sprints; Shipped epic's stale "Planned" sprints ⇒
    // Shipped; real in-flight signals preserved — floorSprintStatus) and the floored done-count
    // (Shipped sprint ⇒ all stories done — floorSprintDone).
    for (const sp of boardSprints) {
      rows.push({
        name: `${epicTitle(e.path, e.slug)} — S${sp.n}: ${sp.title}`,
        slug: `${e.slug}--s${sp.n}`,
        grain: 'Sprint',
        status: sp.status,
        status_date: when(`Roadmap/${epicKey}/sprint-${sp.n}.md`, '^(\\*\\*)?Status:'),
        area,
        type: 'Sprint',
        risk,
        sprint_progress: sp.total ? `${sp.done}/${sp.total} stories` : '—',
        build_order: buildOrder, // sprints inherit their epic's build order
        build_order_num: buildOrderNum(buildOrder),
        doc_link: `Roadmap/${epicKey}/sprint-${sp.n}.md`,
        epic_slug: e.slug, // resolved to the Epic page id at sync time
        kickoff: sprintKickoff({ epicKey, slug: e.slug, n: sp.n, risk }),
      });
    }
  }

  // Seed rows: only seeds with no scaffolded epic (epic == null)
  for (const s of seeds.filter((x) => !x.epic)) {
    const { stage, source: stageSource, pr } = stageFor(s.slug, { grain: 'Seed', status: s.status });
    const statusDay = when(s._file, '^status:');
    const name = s.title || s.slug;
    rows.push({
      name,
      slug: s.slug,
      grain: 'Seed',
      status: seedStatusLabel(s.status, s._file),
      status_date: statusDay,
      stage,
      stage_source: stageSource,
      area: AREA_NAMES[s.area] || s.area || null,
      type: TYPE_LABEL[s.type] || 'Feature',
      risk: s.risk ? (s.risk === 'high' ? 'High' : 'Low') : null,
      appetite: s.appetite || null,
      underwritten_by: s.underwritten_by || null,
      sprint_progress: null,
      build_order: s.build_order || null,
      build_order_num: buildOrderNum(s.build_order),
      doc_link: s._file,
      epic_slug: null,
      goal: firstParagraph(readFileSync(join(root, s._file), 'utf8'), [
        'Problem',
        'Why',
        'Outcome & signal',
        'The ask, as given',
      ]),
      links: { readme: null, seed: s._file, sprints: [], retro: null },
      pr: prOf(pr),
      kickoff:
        stage === 'Ready to build'
          ? seedKickoff({ slug: s.slug, title: name, type: s.type, file: s._file })
          : null,
      shipped_at: stage === 'Shipped' ? statusDay : null,
    });
  }
  return rows;
}

/** The sinks one projector feeds (board-sinks-and-scrumban S3.2): no `--sink` prints the rows as JSON. */
export const SINKS = Object.freeze(['terminal', 'hub', 'notion']);

/** `--sink <name>` / `--sink=<name>` → the name, `''` for a bare `--sink`, or null when absent. */
export function sinkFrom(argv) {
  const eq = argv.find((a) => a.startsWith('--sink='));
  if (eq) return eq.slice('--sink='.length);
  const i = argv.indexOf('--sink');
  return i === -1 ? null : (argv[i + 1] ?? '');
}

/** `--live` · `--offline` (the default) · `--docs-only` → a facts mode. The last one given wins. */
export function factsModeFrom(argv) {
  let mode = 'snapshot';
  for (const a of argv) {
    if (a === '--live') mode = 'live';
    else if (a === '--offline') mode = 'snapshot';
    else if (a === '--docs-only') mode = 'docs';
  }
  return mode;
}

// Print the rows. writeSync to fd 1 is synchronous on a PIPE too — `console.log` then an exit truncates
// piped stdout (the async write has not flushed), which crashed build-order.mjs's execFileSync with
// "Unexpected end of JSON input". Synchronous write guarantees the full payload.
// realpath, not resolve: on macOS a temp or symlinked path (/var → /private/var) never equals the module
// URL, and a plain comparison makes the CLI a silent no-op.
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const sink = sinkFrom(argv);
  if (sink !== null && !SINKS.includes(sink)) {
    process.stderr.write(`roadmap-extract: --sink takes one of ${SINKS.join(' | ')} (got "${sink}")\n`);
    process.exit(2);
  }
  // A sink shows or sends the board, so it wants Building and QA: live facts unless a mode was asked for.
  const explicit = argv.some((a) => a === '--live' || a === '--offline' || a === '--docs-only');
  const mode = sink !== null && !explicit ? 'live' : factsModeFrom(argv);
  const facts = gatherFacts({ root: REPO, mode });
  // A FAILED --live run says why on stderr (the rows say where their facts came from in every stage_source). An
  // offline run with no snapshot is the normal case for the six callers that spawn this with no flags — one of them
  // in the pre-commit hook — so it stays quiet.
  if (facts.note && mode === 'live') process.stderr.write(`roadmap-extract: ${facts.note}\n`);
  // --require-live: a publisher must never send a board whose live facts silently fell back (a fresh CI checkout has
  // no snapshot, so the fallback is docs-only: every Building/QA card would drop to its docs stage on the Hub and the
  // unchanged-board check would store it as a new version). The Hub sink implies it whenever it asked for live facts.
  const requireLive = argv.includes('--require-live') || (sink === 'hub' && mode === 'live');
  if (requireLive && facts.mode !== 'live') {
    process.stderr.write(
      'roadmap-extract: live facts could not be gathered — nothing printed or pushed. ' +
        '(The Hub sink needs git and an authenticated `gh`; pass --docs-only to push the docs-only stages.)\n'
    );
    process.exit(3);
  }
  const rows = buildRows({ facts });
  if (sink === null) writeSync(1, JSON.stringify(rows, null, 2) + '\n');
  else if (sink === 'terminal') writeSync(1, renderBoardText(rows, facts));
  else if (sink === 'hub')
    process.exitCode = reportPush(await pushRoadmap(rows, { root: REPO }), rows.length);
  else {
    // Notion is opt-in (template/optional/notion/): a project that wants it copies roadmap-to-notion.mjs beside this.
    // Beside this file when it IS the project's copy; the project's scripts/ when this runs from the kit (fresh review, #227).
    const notion = [
      join(dirname(fileURLToPath(import.meta.url)), 'roadmap-to-notion.mjs'),
      join(REPO, 'scripts', 'roadmap-to-notion.mjs'),
    ].find((p) => existsSync(p));
    if (!notion) {
      process.stderr.write(
        "roadmap-extract: no roadmap-to-notion.mjs beside this script or in the project's scripts/ — the Notion sink is opt-in: copy " +
          'template/optional/notion/roadmap-to-notion.mjs into scripts/ and set NOTION_TOKEN + NOTION_DB_ID.\n'
      );
      process.exit(2);
    }
    const r = spawnSync(
      process.execPath,
      [notion, '--sync', `--${mode === 'live' ? 'live' : mode === 'docs' ? 'docs-only' : 'offline'}`],
      {
        stdio: 'inherit',
      }
    );
    process.exitCode = r.status ?? 1;
  }
}
