#!/usr/bin/env node
// roadmap-backfill.mjs — bring existing epic docs onto the frontmatter contract
// (build-visualization-claude-mods S2.2/S2.3; the contract itself is lib/roadmap-contract.mjs).
//
//   node scripts/roadmap-backfill.mjs                    # dry run: what would change + every finding
//   node scripts/roadmap-backfill.mjs --write            # write it
//   node scripts/roadmap-backfill.mjs --write --report Roadmap/00-ideas/audits/frontmatter-backfill.md
//   node scripts/roadmap-backfill.mjs --repo-root <dir>  # another checkout (default: this script's repo)
//
// ── What it writes, and from where ──────────────────────────────────────────────────────────────────
// Everything is read from the docs' own prose and from the board projection (`roadmap-extract.mjs`, the
// SSOT every roadmap tool reads). Nothing is invented.
//   epic README  — ADDS the missing contract fields just before the closing `---`: title (the H1),
//                  area (the macro-section dir), risk + type (the `> **Area:** …` header line, else the
//                  seed via the projection), phase (from the lifecycle `status:`), and the two totals.
//                  Existing lines are never rewritten, except a total that disagrees with the sprints'
//                  lists — a total is derived data, so it is recomputed rather than trusted.
//   sprint-N.md  — PREPENDS a frontmatter block when the file has none: its epic, number, title (the
//                  H1), risk, phase (the projection's sprint status) and one `stories:` entry per story
//                  heading, with the user story read from the "As a … I want … so that …" line under it.
//                  A sprint that already has frontmatter is left alone — which is what makes a second run
//                  a no-op.
//
// ── The failure policy (D5): findings are recorded, never guessed around ──────────────────────────────
// A value the prose does not carry is written `null` (an explicit unknown) and REPORTED with a reason:
// a story with no user story, a sprint with no story headings, a risk that is neither low nor high, a
// heading whose number names another sprint. `--report` writes those findings as a markdown table.
// Archived epics are frozen record and skipped (the contract exempts them). An epic README with no
// frontmatter block at all is reported and left alone: it predates the lifecycle `status:` itself.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  EPIC_FIELDS,
  RISKS,
  TYPES,
  SPRINT_FIELDS,
  parseDocFrontmatter,
  serializeFields,
  formatScalar,
} from './lib/roadmap-contract.mjs';
import { isMain } from './lib/is-main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The story-heading shapes the corpus actually uses (1,480 headings across three repos, read 2026-09-19):
// `### Story 1.2`, `## US-3`, `### S1.2`, `### US-3`, `## Story 1.2`, `### S3`, and epic-letter forms
// `### B1.1` / `## C.1`. The same recognition the board's story counter uses. This is the LAST place a
// story is found by its heading: the backfill reads the prose once, and from then on the frontmatter
// `stories:` list is what tools read.
export const STORY_HEADING_RE =
  /^#{2,3}\s+(Story\s+\d+(?:\.\d+)?|S\d+(?:\.\d+)?(?:\s*\([^)]*\))?|US-\d+|[A-Z]\d*\.\d+)\b(.*)$/i;

const SPRINT_PHASE = {
  Planned: 'Shaping',
  'In progress': 'Building',
  'In review': 'In review',
  Shipped: 'Shipped',
};
const EPIC_PHASE = {
  scaffolded: 'Shaping',
  queued: 'Shaping',
  'in-progress': 'Building',
  shipped: 'Shipped',
};
const PHASE_RANK = ['Shaping', 'Locking architecture', 'Building', 'Verifying', 'In review', 'Shipped'];

const clean = (s) =>
  s
    .replace(/\*\*|__/g, '')
    .replace(/(^|\s)[*_](\S)/g, '$1$2')
    .replace(/(\S)[*_](?=[\s,.;:]|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The risk a "Risk:" line names → 'low' | 'high' | another word it names ('medium', 'med') | null when
 * there is no Risk line or it names no tier. Reads the first tier word AFTER the label, so "**Risk:** all
 * LOW" and "Risk — the usual: high" resolve to the tier, not to "all" / "the".
 */
export function readRisk(text) {
  for (const line of text.split('\n')) {
    const at = line.search(/\bRisk\b\**\s*[:—-]/i);
    if (at === -1) continue;
    const tier = line.slice(at + 4, at + 80).match(/\b(low|high|medium|med|critical)\b/i);
    if (tier) return tier[1].toLowerCase();
  }
  return null;
}

// "As a buyer, I want …, so that …" — and the forms the corpus also uses: "As the product owner, I want", "As
// admin, I need", "As any tool, I want", bolded fragments, and the whole thing inside a `>` quote.
const USER_STORY_RE =
  /\bAs\s+(.+?),?\s+I (?:want|need|can)\s+(.+?),?\s+so (?:that\s+)?(.+?)(?=\.["'”’)]?(?:\s|$)|$)/i;

/** The "As a … I want … so that …" of one story block, or null when the prose has none. */
export function readUserStory(block) {
  const lines = block.split('\n').map((l) => l.replace(/^\s*>\s?/, ''));
  for (let start = 0; start < lines.length; start++) {
    if (!/\bAs\s+\S/i.test(clean(lines[start]))) continue;
    const para = [];
    for (let i = start; i < lines.length; i++) {
      const t = lines[i].trim();
      if (
        i > start &&
        (t === '' ||
          /^([-*+]|\d+[.)])\s/.test(t) || // a list starts: implementation bullets, never the user story
          /^(\*\*)?(Acceptance|Risk|Why|Notes?|Scope|Build|Verification)\b/i.test(t))
      )
        break;
      para.push(t);
    }
    const m = clean(para.join(' ').replace(/^[-*]\s+/, '')).match(USER_STORY_RE);
    if (!m) continue;
    const tidy = (s) => s.replace(/[.\s]+$/, '').trim();
    // A sentence that ends inside a quote (`… "pending."`) stops before the period; give the quote back.
    const closeQuote = (s) => ((s.match(/"/g) || []).length % 2 ? `${s}"` : s);
    return { as_a: tidy(m[1]), i_want: tidy(m[2]), so_that: closeQuote(tidy(m[3])) };
  }
  return null;
}

function headingTitle(rest) {
  return clean(
    rest
      .replace(/✅.*$/, '')
      .replace(/^\s*(?:\([^)]*\))?\s*[—–:\-|·]\s*/, '')
      .replace(/`([^`]*)`/g, '$1')
  )
    .replace(/\s*[—–·(-]\s*(?:risk:?\s*)?(?:low|high|med|medium)\)?$/i, '') // a trailing risk tag is not the title
    .replace(/[\s—–:\-]+$/, '');
}

/** The stories of one sprint body, in order, plus the findings reading them produced. */
export function readStories(body, n, { sprintRisk, sprintShipped }) {
  const lines = body.split('\n');
  const heads = [];
  lines.forEach((l, i) => {
    const m = l.match(STORY_HEADING_RE);
    if (m) heads.push({ i, label: m[1], rest: m[2], line: l });
  });
  const findings = [];
  const stories = heads.map((h, k) => {
    let end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
    const nextSection = lines.findIndex(
      (l, j) => j > h.i && j < end && /^##\s/.test(l) && !STORY_HEADING_RE.test(l)
    );
    if (nextSection !== -1) end = nextSection;
    const block = lines.slice(h.i + 1, end).join('\n');
    const nums = h.label.match(/(\d+)\.(\d+)/);
    let id = `S${n}.${k + 1}`;
    if (nums && Number(nums[1]) === n) id = `S${n}.${Number(nums[2])}`;
    else if (nums)
      findings.push(
        `heading "${h.label}" names sprint ${nums[1]} in sprint-${n}.md — id set to its position, ${id}`
      );
    const us = readUserStory(block);
    if (!us) findings.push(`${id}: no "As a … I want … so that …" line — as_a/i_want/so_that written null`);
    let risk = readRisk(block) || sprintRisk;
    if (!RISKS.includes(risk)) {
      findings.push(
        `${id}: risk "${risk}" is not low|high — written high (WAYS-OF-WORKING: unsure means HIGH)`
      );
      risk = 'high';
    }
    const done = h.line.includes('✅') || sprintShipped;
    return {
      id,
      title: headingTitle(h.rest) || null,
      as_a: us ? us.as_a : null,
      i_want: us ? us.i_want : null,
      so_that: us ? us.so_that : null,
      risk,
      status: done ? 'done' : 'planned',
    };
  });
  const seen = new Map();
  for (const s of stories) seen.set(s.id, (seen.get(s.id) || 0) + 1);
  if ([...seen.values()].some((c) => c > 1)) {
    findings.push(`duplicate story numbers in the headings — every id set to its position (S${n}.1 …)`);
    stories.forEach((s, k) => (s.id = `S${n}.${k + 1}`));
  }
  if (!stories.length)
    findings.push('no story headings — no clean story boundaries; `stories:` written empty');
  return { stories, findings };
}

function sprintTitle(body) {
  const h1 = body.split('\n').find((l) => l.startsWith('# ')) || '';
  const m = h1.match(/Sprint\s+\d+\s*[:—–\-]\s*(.+)$/i);
  return m ? clean(m[1]) : null;
}

function headerLine(readme) {
  return (
    readme.split('\n').find((l) => /^>\s*\*\*(Area|Macro-section):\*\*/.test(l.trim())) ||
    readme.split('\n').find((l) => /\*\*Risk:\*\*/.test(l)) ||
    ''
  );
}

function listEpics(root) {
  const roadmap = join(root, 'Roadmap');
  const out = [];
  for (const macro of readdirSync(roadmap).sort()) {
    if (!/^\d{2}-/.test(macro) || !statSync(join(roadmap, macro)).isDirectory()) continue;
    for (const slug of readdirSync(join(roadmap, macro)).sort()) {
      const dir = join(roadmap, macro, slug);
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'README.md'))) out.push({ macro, slug, dir });
    }
  }
  return out;
}

function projection(root) {
  const extractor = join(root, 'scripts', 'roadmap-extract.mjs');
  const json = execFileSync('node', [extractor], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const rows = JSON.parse(json);
  return new Map(rows.map((r) => [r.doc_link, r]));
}

/** Insert `key: value` lines before the closing fence of an existing frontmatter block. */
function addToFrontmatter(md, lines) {
  const all = md.split('\n');
  const end = all.findIndex((l, i) => i > 0 && l.trim() === '---');
  all.splice(end, 0, ...lines);
  return all.join('\n');
}

function replaceTopLevel(md, key, value) {
  const all = md.split('\n');
  const end = all.findIndex((l, i) => i > 0 && l.trim() === '---');
  const i = all.findIndex((l, j) => j < end && new RegExp(`^${key}:`).test(l));
  const comment = all[i].match(/\s+#.*$/);
  all[i] = `${key}: ${formatScalar(value)}${comment ? comment[0] : ''}`;
  return all.join('\n');
}

/** Plan the backfill of one repo. Pure over the files it reads; returns { writes, findings, stats }. */
export function planBackfill(root, rows = projection(root)) {
  const writes = new Map(); // abs path → new content
  const findings = []; // { doc, reason }
  const stats = {
    epics: 0,
    archived: 0,
    noFrontmatter: 0,
    sprintsWritten: 0,
    epicsWritten: 0,
    stories: 0,
    userStories: 0,
  };
  const note = (doc, reason) => findings.push({ doc, reason });

  for (const { macro, slug, dir } of listEpics(root)) {
    stats.epics++;
    const rel = (f) => `Roadmap/${macro}/${slug}/${f}`;
    const readmePath = join(dir, 'README.md');
    const readme = readFileSync(readmePath, 'utf8');
    const epic = parseDocFrontmatter(readme);
    if (!epic.hasFrontmatter) {
      stats.noFrontmatter++;
      note(
        rel('README.md'),
        'no frontmatter block at all (predates the lifecycle `status:`) — not backfilled'
      );
      continue;
    }
    if (epic.error) {
      note(
        rel('README.md'),
        `frontmatter outside the contract's YAML subset: ${epic.error} — not backfilled`
      );
      continue;
    }
    if (epic.data.status === 'archived') {
      stats.archived++;
      continue;
    }
    const row = rows.get(rel('README.md')) || {};
    const header = headerLine(readme);
    let epicRisk = readRisk(header) || (row.risk ? row.risk.toLowerCase() : null);
    if (!RISKS.includes(epicRisk)) {
      if (!('risk' in epic.data))
        note(
          rel('README.md'),
          `risk "${epicRisk}" is not low|high — written high (WAYS-OF-WORKING: unsure means HIGH)`
        );
      epicRisk = 'high';
    }

    const sprintFiles = readdirSync(dir)
      .filter((f) => /^sprint-\d+\.md$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    const sprintPhases = [];
    let storyTotal = 0;
    let totalsKnown = true;
    for (const f of sprintFiles) {
      const n = Number(f.match(/\d+/)[0]);
      const path = join(dir, f);
      const text = readFileSync(path, 'utf8');
      const parsed = parseDocFrontmatter(text);
      if (parsed.hasFrontmatter) {
        // Already on the contract (a second run, or born from the new templates): leave it alone.
        if (Array.isArray(parsed.data.stories)) storyTotal += parsed.data.stories.length;
        else if (parsed.data.stories === null && parsed.data.stories_total === 0) storyTotal += 0;
        else totalsKnown = false;
        if (parsed.data.phase) sprintPhases.push(parsed.data.phase);
        continue;
      }
      const sprintRow = rows.get(rel(f)) || {};
      const phase = SPRINT_PHASE[sprintRow.status] || 'Shaping';
      if (!SPRINT_PHASE[sprintRow.status])
        note(
          rel(f),
          `the board has no status for this sprint ("${sprintRow.status}") — phase written Shaping`
        );
      sprintPhases.push(phase);
      // The sprint's own risk lives in its header — the lines before the first story, never a story's.
      const allLines = text.split('\n');
      const firstStory = allLines.findIndex((l) => STORY_HEADING_RE.test(l));
      const head = allLines.slice(0, firstStory === -1 ? 15 : Math.min(firstStory, 15)).join('\n');
      let risk = readRisk(head) || epicRisk;
      if (!RISKS.includes(risk)) {
        note(
          rel(f),
          `sprint risk "${risk}" is not low|high — written high (WAYS-OF-WORKING: unsure means HIGH)`
        );
        risk = 'high';
      }
      const { stories, findings: storyFindings } = readStories(text, n, {
        sprintRisk: risk,
        sprintShipped: phase === 'Shipped',
      });
      for (const r of storyFindings) note(rel(f), r);
      let title = sprintTitle(text);
      if (!title) {
        title = `Sprint ${n}`;
        note(rel(f), `no "# … Sprint ${n}: <title>" H1 — title written "Sprint ${n}"`);
      }
      stats.stories += stories.length;
      stats.userStories += stories.filter((s) => s.as_a).length;
      storyTotal += stories.length;
      const fm = { epic: slug, sprint: n, title, risk, phase, stories_total: stories.length, stories };
      writes.set(path, `---\n${serializeFields(fm, SPRINT_FIELDS)}\n---\n${text}`);
      stats.sprintsWritten++;
    }

    // The epic README: add what is missing.
    const fm = epic.data;
    const h1 = (epic.body.split('\n').find((l) => l.startsWith('# ')) || '').replace(
      /^#\s+(Epic\s*[—·:\-]\s*)?/i,
      ''
    );
    const classMatch = header.match(/\*\*Class:\*\*\s*([A-Za-z]+)/);
    let type = classMatch ? classMatch[1].toLowerCase() : row.type ? row.type.toLowerCase() : null;
    if (!TYPES.includes(type)) {
      if (!('type' in fm))
        note(
          rel('README.md'),
          `no Class/type among ${TYPES.join('|')} ("${type}") — type written feature (the scaffolder default)`
        );
      type = 'feature';
    }
    let phase = EPIC_PHASE[fm.status] || 'Shaping';
    if (fm.status === 'in-progress') {
      const open = sprintPhases.filter((p) => p !== 'Shipped' && p !== 'Shaping');
      if (open.length) phase = open.sort((a, b) => PHASE_RANK.indexOf(b) - PHASE_RANK.indexOf(a))[0];
    }
    const want = {
      title: clean(h1) || slug,
      area: macro,
      risk: epicRisk,
      type,
      phase,
      sprints_total: sprintFiles.length,
      stories_total: storyTotal,
    };
    let next = readme;
    const missing = EPIC_FIELDS.filter((k) => !(k in fm));
    if (missing.length)
      next = addToFrontmatter(
        next,
        missing.map((k) => `${k}: ${formatScalar(want[k])}`)
      );
    for (const k of ['sprints_total', 'stories_total']) {
      if (k in fm && fm[k] !== want[k] && (k === 'sprints_total' || totalsKnown))
        next = replaceTopLevel(next, k, want[k]);
    }
    if (next !== readme) {
      writes.set(readmePath, next);
      stats.epicsWritten++;
    }
  }
  return { writes, findings, stats };
}

export function renderReport({ findings, stats }, { repo, date }) {
  const out = [
    `# Frontmatter backfill — ${repo}, ${date}`,
    '',
    'Generated by `node scripts/roadmap-backfill.mjs --write --report …` (build-visualization-claude-mods S2).',
    'Every doc the backfill could not fully resolve, **with the reason**. These are findings, recorded — not',
    'fixed (D5). A `null` in a `stories:` entry is the explicit unknown the row below explains.',
    '',
    `- Epics read: **${stats.epics}** (archived, skipped as frozen record: ${stats.archived}; no frontmatter at all: ${stats.noFrontmatter})`,
    `- Epic READMEs given fields: **${stats.epicsWritten}** · sprint files given frontmatter: **${stats.sprintsWritten}**`,
    `- Stories written: **${stats.stories}**, of which **${stats.userStories}** carry a full user story read from the prose`,
    `- Findings: **${findings.length}**`,
    '',
  ];
  if (!findings.length) return [...out, '_None._', ''].join('\n');
  out.push('| Doc | Why it could not be fully resolved |', '|---|---|');
  for (const f of findings) out.push(`| \`${f.doc}\` | ${f.reason.replace(/\|/g, '\\|')} |`);
  return out.join('\n') + '\n';
}

function main(argv) {
  const at = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };
  const root = resolve(at('--repo-root') || join(__dirname, '..'));
  const write = argv.includes('--write');
  const plan = planBackfill(root);
  for (const [path, content] of plan.writes) {
    if (write) writeFileSync(path, content);
    else console.log(`would write ${path.slice(root.length + 1)}`);
  }
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = at('--report');
  // A run with nothing to write leaves an existing report alone: its findings describe the run that
  // DID write, and a second run must leave `git status` clean (the idempotency the sprint asks for).
  if (reportPath && !plan.writes.size && existsSync(resolve(root, reportPath))) {
    console.log(
      `roadmap-backfill: nothing to backfill — ${reportPath} left as the record of the run that wrote.`
    );
  } else if (reportPath) {
    const abs = resolve(root, reportPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, renderReport(plan, { repo: root.split('/').at(-1), date }));
  }
  const s = plan.stats;
  console.log(
    `roadmap-backfill${write ? '' : ' (dry run)'}: ${plan.writes.size} file(s) ${write ? 'written' : 'to write'} ` +
      `(${s.epicsWritten} epic README(s), ${s.sprintsWritten} sprint file(s)); ${s.stories} stories, ` +
      `${s.userStories} with a user story; ${plan.findings.length} finding(s)` +
      (reportPath ? ` → ${reportPath}` : '')
  );
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
