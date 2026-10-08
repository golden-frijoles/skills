#!/usr/bin/env node
// doc-format.mjs — check Roadmap/ epic docs (README.md, sprint-N.md, RETROSPECTIVE.md) against the
// canonical shape: the `refine` plugin's scaffolding templates (golden-frijoles/skills,
// skills/refine/templates/) — proven canonical in the project this was ported from by a zero-drift
// control group (81 seeds, one authoring path, identical shape; epic READMEs drift because they get
// hand-edited after scaffolding, away from the template). dobby-foundation's CI renders a scaffolded
// epic and runs this checker over it, so the producer validates its own templates.
//
// This is FORMAT checking (headings, frontmatter shape, section order) — complementary to
// doc-hygiene.mjs's CONTENT checking (dedupe, dead paths, staleness) on exactly two files.
//
//   node scripts/doc-format.mjs             # full-tree report (all docs, advisory)
//   node scripts/doc-format.mjs --check     # CI mode — exit 1 only for paths in ENFORCED_SWEPT_PATHS
//   node scripts/doc-format.mjs --hook      # single-file mode: read a path from stdin JSON
//                                            (Claude Code PostToolUse hook payload), exit 2 on drift
//   node scripts/doc-format.mjs --fix [--path=Roadmap/09-platform-infra/]
//                                            # mechanically rewrites ONLY the fully-unambiguous
//                                            offenses (DoD heading wording, sprint Status-line shape,
//                                            retro Closed-line bold→italic) — never guesses real
//                                            content (Class/Risk/Area/Scope-seed/dates/sections).
//                                            Everything else is reported as still needing hand-fix.
//
// Reuse, don't rebuild: epic discovery + status come from `roadmap-extract.mjs` (the same SSOT
// build-order.mjs and doc-hygiene.mjs read) — this script does not re-derive epic status itself, and
// NEVER rewrites the `status:` frontmatter field (everything that reads the board depends on that
// field's name + values staying stable).
//
// The machine-readable frontmatter contract (epic README fields, sprint frontmatter, the per-story
// block, the `phase:` ladder) is defined in lib/roadmap-contract.mjs and only ENFORCED here — see
// checkContract below. It is reported as `contract-*` rules, never `--fix`ed: a missing field is filled
// by `node scripts/roadmap-backfill.mjs --write` (which reads the doc's own prose), not by this checker.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import {
  parseDocFrontmatter,
  validateEpicFrontmatter,
  validateSprintFrontmatter,
} from './lib/roadmap-contract.mjs';
import { projectAsset, projectRoot } from './lib/project-root.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = projectRoot(); // D2
const EXTRACTOR = join(__dirname, 'roadmap-extract.mjs');
const ENFORCED_PATH = projectAsset('doc-format.enforced.json'); // per-project policy, kit default

// Active (non-archived) epics are the only ones the sweep + hard gate ever apply to — status:
// archived epics are frozen historical record (Decision D3, doc-format-consistency epic README).
const ACTIVE_STATUSES = new Set(['Scaffolded', 'In progress', 'Shipped']);

// WHICH docs `--check` fails on is the PROJECT's decision, so it lives in the committed
// scripts/doc-format.enforced.json, not in this file: `{ "enforced": [ ... ] }`. An entry ending in `/` is
// a prefix. A new project enforces `Roadmap/` from day one — nothing predates the templates. A project
// adopting this late lists files as each area is swept, so `--check` stays green on today's state and
// red on anything new (the origin project swept incrementally this way, one macro-section at a time).
// A missing file enforces nothing, and says so. Everything outside the list is still REPORTED.
export function loadEnforced(path = ENFORCED_PATH) {
  if (!existsSync(path)) return { entries: [], source: null };
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw.enforced) || raw.enforced.some((e) => typeof e !== 'string')) {
    throw new Error(`${path}: "enforced" must be an array of paths (a trailing "/" makes a prefix)`);
  }
  return { entries: raw.enforced, source: path };
}

export function isEnforced(relPath, entries) {
  return entries.some((e) => (e.endsWith('/') ? relPath.startsWith(e) : relPath === e));
}

const ENFORCED = loadEnforced();
export const ENFORCED_SWEPT_PATHS = {
  has: (p) => isEnforced(p, ENFORCED.entries),
  get size() {
    return ENFORCED.entries.length;
  },
};

const VALID_EPIC_STATUSES = ['scaffolded', 'in-progress', 'shipped', 'archived'];
const CANONICAL_DOD_HEADING = '## Definition of Done (epic)';
const VALID_CLASSES = ['Feature', 'Spike', 'Bug', 'Chore'];

export function extractEpics() {
  const json = execFileSync('node', [EXTRACTOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(json).filter((r) => r.grain === 'Epic');
}

export function readRelative(relPath) {
  return readFileSync(join(REPO, relPath), 'utf8');
}

export function existsRelative(relPath) {
  return existsSync(join(REPO, relPath));
}

/** Every sprint-N.md and RETROSPECTIVE.md sitting alongside an epic's README.md. */
export function siblingDocs(readmeRelPath) {
  const dir = dirname(readmeRelPath);
  const absDir = join(REPO, dir);
  if (!existsSync(absDir)) return { sprints: [], retro: null };
  const entries = readdirSync(absDir);
  const sprints = entries
    .filter((f) => /^sprint-\d+\.md$/.test(f))
    .sort((a, z) => Number(a.match(/\d+/)[0]) - Number(z.match(/\d+/)[0]))
    .map((f) => join(dir, f));
  const retro = entries.includes('RETROSPECTIVE.md') ? join(dir, 'RETROSPECTIVE.md') : null;
  return { sprints, retro };
}

// ── Individual checkers — each returns a list of { rule, detail } offenses for one file's content ──

// An HTML comment that never closes hides EVERYTHING after it when the doc renders — the whole epic README, its
// architecture lock included (think-skills and sketch-specs both shipped one, 2026-09-30, from an edit anchored on a
// heading the old template's comment named). Code is skipped first: a `<!-- jev:` inside backticks or a fence is an
// example, not a comment, and several sprint docs quote one.
// A code span opens with a run of backticks and closes with the same run (``<!-- x`` included).
const CODE_SPAN = /(`+)[\s\S]*?\1/g;

// A later `-->` closes an open comment wherever it appears (a mermaid `A --> B` included) — that is what CommonMark
// renders, so the rule agrees with the page; the text in between is still hidden, and only reading it shows that.
export function unclosedComments(content) {
  const lines = content.split('\n');
  let fence = null;
  let open = null; // the line an unclosed <!-- started on, while we are inside one
  for (let i = 0; i < lines.length; i++) {
    // The whole run of marks: a ```` fence is closed only by ```` or longer, never by the ``` it quotes.
    const fenceMark = lines[i].match(/^ {0,3}(`{3,}|~{3,})/);
    if (open === null && fenceMark) {
      const mark = fenceMark[1];
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    let rest = open === null ? lines[i].replace(CODE_SPAN, '') : lines[i];
    for (;;) {
      if (open === null) {
        const at = rest.indexOf('<!--');
        if (at === -1) break;
        open = i;
        rest = rest.slice(at + 4);
      } else {
        const at = rest.indexOf('-->');
        if (at === -1) break;
        open = null;
        rest = rest.slice(at + 3).replace(CODE_SPAN, '');
      }
    }
  }
  return open === null
    ? []
    : [
        {
          rule: 'unclosed-html-comment',
          detail: `line ${open + 1} opens <!-- and nothing closes it — everything after it is hidden when the doc renders`,
        },
      ];
}

export function checkEpicReadme(content, { slug, exists = existsRelative } = {}) {
  const offenses = [];
  offenses.push(...unclosedComments(content));
  // Many epics predate the seeds/ convention and genuinely have no seed file to link — that's an
  // accepted state (Sprint 2 sweep decision), not drift. Only require a **Scope seed:** field when a
  // real seed file exists for this epic's slug; a seed that exists but isn't linked IS still flagged.
  const hasRealSeed = Boolean(slug) && exists(join('Roadmap', '00-ideas', 'seeds', `${slug}.md`));

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    offenses.push({ rule: 'frontmatter-missing', detail: 'no --- frontmatter block at the top of the file' });
  } else {
    const fm = fmMatch[1];
    if (!/^status:\s*\S/m.test(fm))
      offenses.push({ rule: 'frontmatter-status-missing', detail: 'no `status:` key in frontmatter' });
    else {
      const statusVal = fm.match(/^status:\s*(\S+)/m)[1];
      if (!VALID_EPIC_STATUSES.includes(statusVal)) {
        offenses.push({
          rule: 'frontmatter-status-invalid',
          detail: `status: "${statusVal}" is not one of ${VALID_EPIC_STATUSES.join('|')}`,
        });
      }
    }
    if (!/^slug:\s*\S/m.test(fm))
      offenses.push({ rule: 'frontmatter-slug-missing', detail: 'no `slug:` key in frontmatter' });
  }

  // Catch any header-shaped blockquote line, not just an already-canonical one — a line starting
  // with the legacy `**Macro-section:**` still needs to be FOUND so it can be flagged as legacy,
  // rather than mis-reported as entirely missing.
  const headerLine = content.split('\n').find((l) => {
    const t = l.trim();
    return t.startsWith('> **Area:**') || t.startsWith('> **Macro-section:**');
  });
  if (!headerLine) {
    offenses.push({ rule: 'header-missing', detail: 'no `> **Area:** ...` header blockquote line found' });
  } else {
    if (!headerLine.includes('**Risk:**'))
      offenses.push({ rule: 'header-missing-risk', detail: 'header line has Area but no **Risk:** field' });
    if (!headerLine.includes('**Class:**')) {
      offenses.push({
        rule: 'header-missing-class',
        detail:
          'header line has no **Class:** field (should be one of Feature|Spike|Bug|Chore, between Risk and Scope seed)',
      });
    } else {
      const classMatch = headerLine.match(/\*\*Class:\*\*\s*([^·]+)/);
      const classVal = classMatch ? classMatch[1].trim() : '';
      if (!VALID_CLASSES.includes(classVal)) {
        offenses.push({
          rule: 'header-class-invalid',
          detail: `**Class:** "${classVal}" is not one of ${VALID_CLASSES.join('|')} (free-text descriptions belong in ## Why, not the header)`,
        });
      }
    }
    if (!headerLine.includes('**Scope seed:**')) {
      if (headerLine.includes('**Scope doc:**')) {
        offenses.push({
          rule: 'header-scope-doc-legacy',
          detail:
            'header uses **Scope doc:** — canonical is **Scope seed:** pointing at 00-ideas/seeds/ (2. readyforscope/ is documented legacy per 00-ideas/README.md)',
        });
      } else if (hasRealSeed) {
        offenses.push({
          rule: 'header-missing-scope-seed',
          detail: 'header line has no **Scope seed:** field',
        });
      }
    } else if (headerLine.includes('00-ideas/seeds/')) {
      const linkMatch = headerLine.match(/\(([^)]*00-ideas\/seeds\/[^)]+)\)/);
      if (linkMatch) {
        const linkTarget = linkMatch[1].replace(/^\.\.\/\.\.\//, '');
        if (!exists(join('Roadmap', linkTarget))) {
          offenses.push({
            rule: 'header-scope-seed-broken-link',
            detail: `**Scope seed:** links to ${linkTarget}, which doesn't exist`,
          });
        }
      }
    }
    if (headerLine.includes('**Macro-section:**')) {
      offenses.push({
        rule: 'header-macro-section-legacy',
        detail: 'header uses **Macro-section:**/**BUILD-ORDER:** — canonical is **Area:**',
      });
    }
  }

  if (!content.includes(CANONICAL_DOD_HEADING)) {
    if (/^##\s+Epic Definition of Done/m.test(content)) {
      offenses.push({
        rule: 'dod-heading-legacy',
        detail: `heading is "## Epic Definition of Done" — canonical is "${CANONICAL_DOD_HEADING}"`,
      });
    } else if (/^##\s+Definition of Done/m.test(content)) {
      const actual = content.match(/^##\s+.*Definition of Done.*$/m)[0];
      offenses.push({
        rule: 'dod-heading-mismatch',
        detail: `heading is "${actual}" — canonical is "${CANONICAL_DOD_HEADING}"`,
      });
    } else {
      offenses.push({ rule: 'dod-heading-missing', detail: `no "${CANONICAL_DOD_HEADING}" section found` });
    }
  }

  return offenses;
}

// Index of the first line AFTER a leading `---` frontmatter block (0 when there is none). Sprint files
// carry frontmatter since build-visualization-claude-mods, and a sprint or story titled "Status: …" must
// not be mistaken for the prose Status line — every Status-line search starts here, and skips headings
// (the scaffolder puts the sprint title in the H1, so the same title reappears there).
export function bodyStartIndex(lines) {
  if (lines[0]?.trim() !== '---') return 0;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  return end === -1 ? 0 : end + 1;
}

export function checkSprintDoc(content) {
  const offenses = [];
  offenses.push(...unclosedComments(content));
  const all = content.split('\n');
  const statusLine = all
    .slice(bodyStartIndex(all))
    .find((l) => !l.startsWith('#') && (l.includes('**Status:**') || l.includes('Status:')));
  if (!statusLine) {
    offenses.push({ rule: 'sprint-status-missing', detail: 'no Status line found' });
  } else {
    const trimmed = statusLine.trim();
    // "Combined" (Epic/Risk sharing the line with Status) is checked independent of what the line
    // starts with — the real drift examples combine in different orders (Epic·Risk·Status vs
    // Epic·Risk on one line + Status on the next blockquote line), so this must not be nested under
    // a "starts with **Status:**" branch or the most common combined shape never matches.
    const combinesOtherFields = /\*\*(Risk|Epic):/i.test(trimmed);
    if (trimmed.startsWith('>')) {
      offenses.push({
        rule: 'sprint-status-blockquote',
        detail:
          'Status line is a blockquote (`> ...`) — canonical is a plain `**Status:** ...` line, no backlink/Risk on the same line',
      });
    } else if (combinesOtherFields) {
      offenses.push({
        rule: 'sprint-status-combined',
        detail: 'Status line combines Epic/Risk on the same line — canonical is Status alone',
      });
    } else if (!trimmed.startsWith('**Status:**')) {
      offenses.push({
        rule: 'sprint-status-format',
        detail: `Status line doesn't start with "**Status:**" — found: "${trimmed.slice(0, 60)}"`,
      });
    }
  }
  return offenses;
}

// ── The frontmatter contract (build-visualization-claude-mods S2.1) ─────────────────────────────────
// Kept apart from checkEpicReadme/checkSprintDoc on purpose: those check the prose FORMAT of one file's
// text, while the contract needs the file's place in its epic (sprint number, slug, sibling totals).
// The rules themselves live in lib/roadmap-contract.mjs — this only supplies that context.

/** The contract context for one epic dir: slug, archived?, sprint numbers + each sprint's parsed frontmatter. */
export function contractContext(readmeRelPath, { read = readRelative } = {}) {
  const dir = dirname(readmeRelPath);
  const slug = dir.split('/').at(-1);
  const epic = parseDocFrontmatter(read(readmeRelPath));
  const { sprints } = siblingDocs(readmeRelPath);
  const parsedSprints = sprints.map((p) => ({
    path: p,
    n: Number(p.match(/sprint-(\d+)\.md$/)[1]),
    parsed: parseDocFrontmatter(read(p)),
  }));
  // The epic's story total is only cross-checked when every sprint's list could be read — a sprint that
  // fails to parse is already its own finding, and a sum over a partial set would add a false second one.
  const allRead = parsedSprints.every(
    (s) => s.parsed.hasFrontmatter && !s.parsed.error && Array.isArray(s.parsed.data.stories)
  );
  return {
    slug,
    archived: epic.data.status === 'archived',
    epic,
    sprints: parsedSprints,
    sprintCount: parsedSprints.length,
    storyCount: allRead ? parsedSprints.reduce((a, s) => a + s.parsed.data.stories.length, 0) : undefined,
  };
}

/** Contract offenses for one doc, given its epic's context. RETROSPECTIVE.md carries no contract. */
export function checkContract(docType, content, ctx) {
  if (ctx.archived) return []; // frozen historical record (doc-format-consistency D3)
  if (docType === 'epic-README')
    return validateEpicFrontmatter(parseDocFrontmatter(content), {
      sprintCount: ctx.sprintCount,
      storyCount: ctx.storyCount,
    });
  if (docType === 'sprint')
    return validateSprintFrontmatter(parseDocFrontmatter(content), { n: ctx.n, slug: ctx.slug });
  return [];
}

// Accepted section headings, by stem. Triage against a second project (golden-beans, plugin-audit-and-
// extraction S2.4) found the canonical sections written with a subtitle ("## What we learned the hard
// way", "## Gaps, stated rather than implied") or a plain synonym ("## Follow-ups", "## Durable
// learnings"). Same section, same job — flagging them was a rule tuned to one corpus, so it is relaxed
// to the stem. A retro with none of a section's stems is still flagged.
export const RETRO_SECTION_STEMS = [
  { canonical: '## What shipped', stems: ['## What shipped'] },
  { canonical: '## What went well', stems: ['## What went well', '## What worked'] },
  {
    canonical: '## What we learned',
    stems: ['## What we learned', '## What was learned', '## Durable learning'],
  },
  { canonical: '## Gaps / follow-ups', stems: ['## Gaps', '## Follow-ups', '## Remaining follow-up'] },
];

// The close line stays STRICT — `_Closed: YYYY-MM-DD_` — on purpose. A relaxed "any close word with a
// date" rule was tried after the golden-beans triage and reverted on review: it false-passed lines like
// "Epic not closed yet — last touched 2026-07-20", and it disagreed with epic-dod.mjs's `retro-written`
// item (byte-identical across projects), which requires the literal form. One rule, two rails agreeing.
// A retro that records its close as "**Shipped:** <date>" gets the canonical line added, carrying the
// same date — that is fixing drift, not relaxing the check.
export function checkRetrospective(content) {
  const offenses = [];
  offenses.push(...unclosedComments(content));
  const closedLine = content.split('\n').find((l) => /closed/i.test(l) && l.trim() !== '');
  if (!closedLine) {
    offenses.push({ rule: 'retro-closed-missing', detail: 'no "Closed" date line found near the top' });
  } else {
    const trimmed = closedLine.trim();
    // Canonical is an italic line STARTING with "_Closed: YYYY-MM-DD" — trailing content after the
    // date (sprint counts, PR refs, caveats) is genuinely the norm across real retros, not drift, as
    // long as the italic markup actually closes somewhere (immediately after the date, or at the end
    // of the line). Require: starts with the italic-open + "Closed:" + a real date, and a closing "_"
    // appears somewhere after that.
    // The canonical refine scaffold intentionally has no close date yet. Accept its literal sentinel:
    // treating an unbuilt epic as closed would make roadmap-to-notion derive a false Shipped state.
    const isScaffoldPlaceholder = trimmed === '_Closed: <date>_';
    const startsWithDate = /^_Closed:\s*\d{4}-\d{2}-\d{2}/.test(trimmed);
    const hasClosingItalic = trimmed.slice(1).includes('_');
    if (!isScaffoldPlaceholder && (!startsWithDate || !hasClosingItalic)) {
      if (/^\*\*Closed/.test(trimmed)) {
        offenses.push({
          rule: 'retro-closed-bold',
          detail: `"Closed" line is bold (**Closed ...**) — canonical is italic: "_Closed: YYYY-MM-DD_"`,
        });
      } else {
        offenses.push({
          rule: 'retro-closed-format',
          detail: `"Closed" line doesn't match canonical "_Closed: YYYY-MM-DD_" — found: "${trimmed}"`,
        });
      }
    }
  }

  const headings = content.split('\n').filter((l) => l.startsWith('## '));
  for (const { canonical, stems } of RETRO_SECTION_STEMS) {
    if (!headings.some((h) => stems.some((stem) => h.startsWith(stem)))) {
      offenses.push({ rule: 'retro-section-missing', detail: `missing canonical section "${canonical}"` });
    }
  }

  return offenses;
}

// ── Mechanical rewrites — only for offenses with exactly one unambiguous correct rewrite. Never
// guess real content (Class/Risk/Area/Scope-seed/dates/section text) — those stay hand-fix-only. ──

/** dod-heading-legacy / dod-heading-mismatch → rename the heading line to the canonical wording. */
export function fixDodHeading(content) {
  return content.replace(/^##\s+.*Definition of Done.*$/m, CANONICAL_DOD_HEADING);
}

/**
 * sprint-status-blockquote / sprint-status-combined → collapse to a plain `**Status:** <value>` line.
 * Extracts just the status value (whatever follows "Status:"/"Status**" up to the field's own end —
 * `·`, end of blockquote line, or end of string) and drops any Epic/Risk sharing the line/block.
 */
export function fixSprintStatusLine(content) {
  const lines = content.split('\n');
  const from = bodyStartIndex(lines);
  const idx = lines.findIndex(
    (l, i) => i >= from && !l.startsWith('#') && (l.includes('**Status:**') || l.includes('Status:'))
  );
  if (idx === -1) return content;

  const extractValue = (line) => {
    // Whether to strip a trailing `**` from the captured value depends on WHERE the label's bold
    // closes, and both real shapes exist in this tree:
    //   "**Status:** value"        — label bold closes right after the colon (captured, non-greedy
    //                                 group below matches those 2 asterisks) — the value that follows
    //                                 is plain; any trailing `**`/`*` in it belongs to unrelated
    //                                 content later in the value (e.g. "...*(...)*" or "...**x**") and
    //                                 must be left alone.
    //   "**Status: value**"        — label bold stays open past the colon and closes at the very end
    //                                 of the value — THAT trailing `**` really is the label wrapper's
    //                                 own close and should be stripped.
    const m = line.match(/(\*{0,2})Status:?(\*{0,2})\s*(.*)$/i);
    if (!m) return null;
    const labelOpened = m[1] === '**';
    const labelClosedAtColon = m[2] === '**';
    const value = labelOpened && !labelClosedAtColon ? m[3].replace(/\*+$/, '') : m[3];
    return value.trim();
  };

  // Real docs have both failure modes a naive rewrite can silently cause: (a) a bold span that
  // wraps onto the NEXT physical line — collapsing just this line leaves a dangling unmatched `**`
  // behind; (b) a bold span that closes mid-sentence, not at the end of the extracted value — the
  // leftover `**` ends up embedded inside the new line. Both show up as an ODD count of `**` somewhere
  // that should have been even. Bail (leave for hand-fix) rather than risk corrupting or discarding
  // real content — checked against BOTH the raw input (catches case a) and the candidate output
  // (catches case b).
  const isBalancedBold = (s) => (s.match(/\*\*/g) || []).length % 2 === 0;

  const trimmed = lines[idx].trim();
  if (trimmed.startsWith('>')) {
    // Blockquote form: the Status line may be this line, or the block may span a preceding
    // `> Epic: ... **Risk: ...**` line immediately above — collapse the whole contiguous blockquote
    // run into one plain Status line, but ONLY when that block is short backlink/Risk noise. A long
    // or prose-heavy block (PR links, findings, "Owed to the product owner" notes, etc.) is real documentation,
    // not formatting cruft — silently discarding it is worse than leaving it for hand-fix.
    let start = idx;
    while (start > 0 && lines[start - 1].trim().startsWith('>')) start--;
    let end = idx;
    while (end < lines.length - 1 && lines[end + 1].trim().startsWith('>')) end++;

    // A short line is NOT proof it's disposable backlink noise — e.g. a one-line "Surfaces: ..."
    // continuation is real, load-bearing content, not formatting cruft (a real case found sweeping
    // promoter-funnel-v2/sprint-5.md, where a length-only heuristic let it through and it was
    // silently discarded). Require every non-Status line in the block to be STRICTLY an Epic:/Risk:
    // labeled field and nothing else — anything else in the block means real content is mixed in,
    // so bail and leave the whole thing for hand-fix.
    const blockLines = lines.slice(start, end + 1);
    if (blockLines.length > 3) return content;
    const isDisposableNoiseLine = (l) => /^\*{0,2}(Epic|Risk)\s*:.*$/i.test(l.replace(/^>\s*/, '').trim());
    if (blockLines.some((l, i) => start + i !== idx && !isDisposableNoiseLine(l))) return content;
    if (!isBalancedBold(blockLines.join('\n'))) return content;

    // Same ordering hazard as the combined branch below: if Risk/Epic trails Status on the Status
    // line itself, extractValue would fold it into the kept value instead of dropping it.
    const statusLineNoQuote = trimmed.replace(/^>\s*/, '');
    const statusIdx = statusLineNoQuote.search(/Status:?/i);
    if (statusIdx === -1 || /\*\*(Risk|Epic):/i.test(statusLineNoQuote.slice(statusIdx))) return content;

    const value = extractValue(statusLineNoQuote);
    if (value === null || !isBalancedBold(value)) return content;
    const newLines = [...lines.slice(0, start), `**Status:** ${value}`, ...lines.slice(end + 1)];
    return newLines.join('\n');
  }

  if (/\*\*(Risk|Epic):/i.test(trimmed)) {
    if (!isBalancedBold(lines[idx])) return content;
    // extractValue captures everything from "Status:" to the end of the line — safe only when
    // Risk/Epic appear BEFORE Status (the dropped fields precede the kept one). If Status comes
    // first, Risk/Epic trailing after it would get silently folded into the "Status value" instead
    // of dropped, defeating the whole point of this rewrite (real case found sweeping
    // homepage-polish-b sprint-1/3, where Status led and Risk trailed on the same line).
    const statusIdx = trimmed.search(/Status:?/i);
    if (statusIdx === -1 || /\*\*(Risk|Epic):/i.test(trimmed.slice(statusIdx))) return content;
    const value = extractValue(trimmed);
    if (value === null || !isBalancedBold(value)) return content;
    lines[idx] = `**Status:** ${value}`;
    return lines.join('\n');
  }

  return content;
}

/** retro-closed-bold → convert `**Closed ...**` to `_Closed: YYYY-MM-DD ...trailing..._`. */
export function fixRetroClosedLine(content) {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => /^\*\*Closed/.test(l.trim()));
  if (idx === -1) return content;

  // Real retros have plain-prose paragraphs that just happen to START with "**Closed <date>.**" —
  // the bold span self-closes right after the date, then the SAME paragraph continues in plain text
  // across several more physical lines (soft-wrapped, no blank line between). Rewriting only the
  // first line there leaves a dangling italic close (`_...text_`) mid-paragraph and strands the
  // continuation lines as an orphaned fragment. Only touch a Closed line that is its own complete
  // paragraph — i.e. the next line is blank, a heading, or EOF.
  const nextLine = lines[idx + 1];
  const isStandaloneParagraph =
    nextLine === undefined || nextLine.trim() === '' || /^#{1,6}\s/.test(nextLine.trim());
  if (!isStandaloneParagraph) return content;

  const trimmed = lines[idx].trim();
  const dateMatch = trimmed.match(/\d{4}-\d{2}-\d{2}/);
  if (!dateMatch) return content;
  // Strip the bold markers, keep whatever trailing content follows the date (sprint counts, PR
  // refs) as-is, re-wrap the whole thing in italics starting with "_Closed: ".
  const rest = trimmed.slice(trimmed.indexOf(dateMatch[0]) + dateMatch[0].length).replace(/\*+\s*$/, '');
  lines[idx] = `_Closed: ${dateMatch[0]}${rest}_`;
  return lines.join('\n');
}

/** Applies every mechanical rewrite this module knows to one file's content; returns { content, fixedRules, remainingOffenses }. */
export function applyMechanicalFixes(content, docType) {
  let next = content;
  const fixedRules = [];

  const before1 = next;
  next = fixDodHeading(next);
  if (next !== before1) fixedRules.push('dod-heading-legacy/dod-heading-mismatch');

  if (docType === 'sprint') {
    const before2 = next;
    next = fixSprintStatusLine(next);
    if (next !== before2) fixedRules.push('sprint-status-blockquote/sprint-status-combined');
  }

  if (docType === 'retrospective') {
    const before3 = next;
    next = fixRetroClosedLine(next);
    if (next !== before3) fixedRules.push('retro-closed-bold');
  }

  return { content: next, fixedRules };
}

// ── Full-tree walk ──────────────────────────────────────────────────────────

export function findAllOffenses({ activeOnly = false } = {}) {
  const epics = extractEpics().filter((e) => !activeOnly || ACTIVE_STATUSES.has(e.status));
  const results = [];

  for (const epic of epics) {
    const readmePath = epic.doc_link;
    if (!existsRelative(readmePath)) continue; // extractor can lag a just-renamed/moved doc
    const ctx = contractContext(readmePath);
    const readmeText = readRelative(readmePath);
    const readmeOffenses = [
      ...checkEpicReadme(readmeText, { slug: epic.slug }),
      ...checkContract('epic-README', readmeText, ctx),
    ];
    if (readmeOffenses.length)
      results.push({ path: readmePath, docType: 'epic-README', offenses: readmeOffenses });

    const { sprints, retro } = siblingDocs(readmePath);
    for (const sprintPath of sprints) {
      const sprintText = readRelative(sprintPath);
      const n = Number(sprintPath.match(/sprint-(\d+)\.md$/)[1]);
      const sprintOffenses = [
        ...checkSprintDoc(sprintText),
        ...checkContract('sprint', sprintText, { ...ctx, n }),
      ];
      if (sprintOffenses.length)
        results.push({ path: sprintPath, docType: 'sprint', offenses: sprintOffenses });
    }
    if (retro) {
      const retroOffenses = checkRetrospective(readRelative(retro));
      if (retroOffenses.length)
        results.push({ path: retro, docType: 'retrospective', offenses: retroOffenses });
    }
  }

  return results;
}

export function formatOffense(fileResult) {
  return fileResult.offenses.map((o) => `  [${o.rule}] ${o.detail}`).join('\n');
}

// ── CLI modes ────────────────────────────────────────────────────────────────

function runReport() {
  const results = findAllOffenses();
  if (!results.length) {
    console.log('doc-format: zero findings across the full Roadmap tree.');
    return;
  }
  console.log(`doc-format: ${results.length} file(s) with findings\n`);
  const byType = {};
  for (const r of results) (byType[r.docType] ??= []).push(r);
  for (const [docType, group] of Object.entries(byType)) {
    console.log(`── ${docType} (${group.length}) ──`);
    for (const r of group) {
      const enforced = ENFORCED_SWEPT_PATHS.has(r.path) ? ' [ENFORCED]' : '';
      console.log(`${r.path}${enforced}`);
      console.log(formatOffense(r));
    }
    console.log('');
  }
  const enforcedCount = results.filter((r) => ENFORCED_SWEPT_PATHS.has(r.path)).length;
  console.log(`Total: ${results.length} file(s), ${enforcedCount} enforced (would fail --check).`);
}

function runCheck() {
  const results = findAllOffenses();
  const enforced = results.filter((r) => ENFORCED_SWEPT_PATHS.has(r.path));
  if (enforced.length) {
    console.error(`doc-format --check: ${enforced.length} enforced file(s) have drift:\n`);
    for (const r of enforced) {
      console.error(r.path);
      console.error(formatOffense(r));
    }
    process.exit(1);
  }
  console.log(
    `doc-format --check: clean (${ENFORCED_SWEPT_PATHS.size} path(s) enforced, ${results.length} advisory finding(s) elsewhere).`
  );
}

const MECHANICAL_RULES = new Set([
  'dod-heading-legacy',
  'dod-heading-mismatch',
  'sprint-status-blockquote',
  'sprint-status-combined',
  'retro-closed-bold',
]);

/**
 * Mechanically rewrites only the fully-unambiguous offenses (see MECHANICAL_RULES / the rewrite
 * functions above). Everything else — header fields, missing sections, missing dates — needs a human
 * to read the epic's own content, so it's left untouched and reported as still-needing-hand-fix.
 */
function runFix() {
  const pathFilterArg = process.argv.find((a) => a.startsWith('--path='));
  const pathFilter = pathFilterArg ? pathFilterArg.slice('--path='.length) : null;

  const results = findAllOffenses();
  let filesFixed = 0;
  let filesUntouched = 0;
  const stillNeedsHandFix = [];

  for (const r of results) {
    if (pathFilter && !r.path.startsWith(pathFilter)) continue;
    const mechanicalOffenses = r.offenses.filter((o) => MECHANICAL_RULES.has(o.rule));
    const remainingOffenses = r.offenses.filter((o) => !MECHANICAL_RULES.has(o.rule));

    if (mechanicalOffenses.length) {
      const original = readRelative(r.path);
      const { content: fixed, fixedRules } = applyMechanicalFixes(original, r.docType);
      if (fixed !== original) {
        writeFileSync(join(REPO, r.path), fixed);
        filesFixed++;
        console.log(`fixed: ${r.path} (${fixedRules.join(', ')})`);
      } else {
        filesUntouched++;
      }
    } else {
      filesUntouched++;
    }

    if (remainingOffenses.length) {
      stillNeedsHandFix.push({ path: r.path, offenses: remainingOffenses });
    }
  }

  console.log(
    `\ndoc-format --fix: ${filesFixed} file(s) mechanically rewritten, ${filesUntouched} left as they were.`
  );
  if (stillNeedsHandFix.length) {
    console.log(`${stillNeedsHandFix.length} file(s) still need hand-fixing (real content judgment):\n`);
    for (const r of stillNeedsHandFix) {
      console.log(r.path);
      console.log(formatOffense(r));
    }
  } else {
    console.log('No remaining offenses need hand-fixing.');
  }
}

/**
 * Check ONE doc by path. Returns `null` when the path isn't a doc type this checker covers, or an
 * array of offenses (possibly empty) when it is.
 *
 * Extracted so the single-file path has exactly one implementation. `--hook` (the editor hook) and
 * `--files` (the git pre-commit hook) are the same question asked by two callers, and a second copy
 * of this dispatch would drift — the epic-README segment-count rule below is subtle enough that a
 * near-duplicate would eventually disagree with this one about what counts as an epic doc.
 */
export function checkOneDoc(relPath, contentOverride = null) {
  if (!/^Roadmap\/.*\.md$/.test(relPath)) return null; // not a Roadmap doc — nothing to check
  const abs = join(REPO, relPath);
  if (contentOverride === null && !existsSync(abs)) return null;

  const content = contentOverride ?? readFileSync(abs, 'utf8');
  const segs = relPath.split('/');
  const base = segs.pop();
  // An epic README is exactly Roadmap/<macro-section>/<epic>/README.md (4 segments). The top-level
  // poster (Roadmap/README.md, 2) and macro-section index READMEs (Roadmap/<section>/README.md, 3)
  // share the README.md basename but are NOT epic docs — checkEpicReadme's frontmatter/Area/DoD
  // rules don't apply to them. segs still holds the dir path after the pop() above.
  // Sprint + README docs also carry the frontmatter contract, which needs the epic's context — read
  // from the sibling README when there is one (a sprint file with no README is not an epic doc).
  const readme = join(...segs, 'README.md');
  const ctx = segs.length === 3 && existsRelative(readme) ? contractContext(readme) : null;
  if (base === 'README.md') {
    if (segs.length !== 3) return null; // ['Roadmap', section, epic] ⇒ epic README; else skip
    return [
      ...checkEpicReadme(content, { slug: segs.at(-1) }),
      ...(ctx ? checkContract('epic-README', content, ctx) : []),
    ];
  }
  if (/^sprint-\d+\.md$/.test(base)) {
    const n = Number(base.match(/\d+/)[0]);
    // A sprint edit can make its epic's declared totals wrong (a story added to `stories:`), and the README
    // is not in the staged set — so its totals are re-checked here, named as the README's, or the commit
    // passes locally and only the full CI walk notices.
    const totals = ctx
      ? checkContract('epic-README', readRelative(readme), ctx)
          .filter((o) => o.rule === 'contract-total-mismatch')
          .map((o) => ({ ...o, detail: `${readme}: ${o.detail}` }))
      : [];
    return [
      ...checkSprintDoc(content),
      ...(ctx ? checkContract('sprint', content, { ...ctx, n }) : []),
      ...totals,
    ];
  }
  if (base === 'RETROSPECTIVE.md') return checkRetrospective(content);
  return null; // not an epic doc type this checker covers (e.g. a seed, the poster)
}

/**
 * `--check --files <path>...` — validate ONLY the named docs.
 *
 * This is the pre-commit path, and it exists for one reason: `--check` (the full-tree walk) reads all
 * ~860 docs under Roadmap/ to tell you about the two you just staged. That walk is ~99.8% waste at
 * commit time and it was the single slowest thing in the local gate alongside build-order's own walk.
 *
 * The full walk still has a job — it catches drift in docs *nobody touched* (a rule added today makes
 * yesterday's file non-conforming). That's a CI question, not a per-commit one, so `--check` stays
 * exactly as it is and runs on the PR.
 */
/** The committed (HEAD) text of a doc, or null when it is new — the "known state" a commit is measured against. */
function committedVersion(relPath) {
  try {
    return execFileSync('git', ['show', `HEAD:${relPath}`], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * The offenses a commit INTRODUCES: those in the staged doc that its committed version did not already
 * have (same rule + detail, counted). A NEW doc has no committed version, so every finding is its own.
 *
 * Why (build-visualization-claude-mods S2): the doctrine for this checker is "green on today's known
 * state, red on anything new". Blocking on a touched doc's PRE-EXISTING findings made every edit to a
 * legacy doc a demand to sweep it — and a mechanical change touching hundreds of legacy docs (the
 * frontmatter backfill) impossible to commit without bypassing the hook. A finding the commit did not
 * cause is still printed, as a count, and the full walk still reports all of them.
 */
export function introducedOffenses(now, before) {
  if (!before) return now;
  const seen = new Map();
  for (const o of before)
    seen.set(`${o.rule}\u0000${o.detail}`, (seen.get(`${o.rule}\u0000${o.detail}`) || 0) + 1);
  return now.filter((o) => {
    const key = `${o.rule}\u0000${o.detail}`;
    if (!seen.get(key)) return true;
    seen.set(key, seen.get(key) - 1);
    return false;
  });
}

function runCheckFiles(paths) {
  const findings = [];
  let checked = 0;
  let preExisting = 0;
  for (const p of paths) {
    const relPath = p.startsWith(REPO) ? relative(REPO, p) : p;
    const offenses = checkOneDoc(relPath);
    if (offenses === null) continue; // not a covered doc type
    checked++;
    if (!offenses.length) continue;
    const committed = committedVersion(relPath);
    const introduced = introducedOffenses(
      offenses,
      committed === null ? null : checkOneDoc(relPath, committed) || []
    );
    preExisting += offenses.length - introduced.length;
    if (introduced.length) findings.push({ path: relPath, offenses: introduced });
  }
  if (preExisting)
    console.log(
      `doc-format: ${preExisting} pre-existing finding(s) in the staged docs were already committed — not this commit's (see: node scripts/doc-format.mjs).`
    );

  if (findings.length) {
    console.error(
      `doc-format: ${findings.length} of ${checked} checked doc(s) have findings this commit introduces:\n`
    );
    for (const f of findings) {
      console.error(f.path);
      console.error(formatOffense(f));
    }
    console.error("Fix by hand, or 'node scripts/doc-format.mjs --fix' for the mechanical rules.");
    process.exit(1);
  }
  console.log(`doc-format: ${checked} staged doc(s) clean.`);
}

function runHook() {
  let input = '';
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    let filePath;
    try {
      const payload = JSON.parse(input);
      filePath = payload?.tool_input?.file_path;
    } catch {
      process.exit(0); // malformed hook payload — fail open, never block an edit on a parse error
    }
    if (!filePath) process.exit(0);
    const relPath = relative(REPO, filePath);
    const offenses = checkOneDoc(relPath);
    if (offenses === null) process.exit(0);

    if (offenses.length) {
      console.error(`doc-format: ${relPath} has ${offenses.length} format finding(s):`);
      console.error(formatOffense({ offenses }));
      process.exit(2);
    }
    process.exit(0);
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes('--hook')) {
    runHook();
  } else if (process.argv.includes('--files')) {
    // `--files a.md b.md` — everything after the flag that isn't itself a flag. Checked BEFORE
    // `--check` so `--check --files …` reads naturally and still takes the cheap path.
    const i = process.argv.indexOf('--files');
    const paths = process.argv.slice(i + 1).filter((a) => !a.startsWith('-'));
    if (!paths.length) {
      console.log('doc-format: --files given no paths — nothing to check.');
      process.exit(0);
    }
    runCheckFiles(paths);
  } else if (process.argv.includes('--check')) {
    runCheck();
  } else if (process.argv.includes('--fix')) {
    runFix();
  } else {
    runReport();
  }
}
