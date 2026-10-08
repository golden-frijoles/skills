#!/usr/bin/env node
// doc-hygiene.mjs — measure the always-read session-start doc set and flag dedupe/staleness
// candidates in LEARNINGS.md + the README poster. ADVISORY ONLY: this script never edits any
// Roadmap doc — it only reads them and (unless --check) writes ONE new dated report file under
// Roadmap/00-ideas/. Every flagged candidate is a hint for a human/model to verify, not a verdict —
// see Step 4 of scripts/routines/roadmap-hygiene.prompt.md for the
// judgment pass this script's output feeds.
//
//   node scripts/doc-hygiene.mjs             # print the report + write Roadmap/00-ideas/DOC-HYGIENE-REPORT-<date>.md
//   node scripts/doc-hygiene.mjs --check     # print only, write nothing (quick look / CI-safe)
//
// Reuse, don't rebuild: epic status comes from `roadmap-extract.mjs` (the same SSOT
// build-order.mjs reads) — this script does not re-parse frontmatter itself.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { projectRoot } from './lib/project-root.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = projectRoot(); // D2
const ROADMAP = join(REPO, 'Roadmap');
const IDEAS = join(ROADMAP, '00-ideas');

// App roots are DISCOVERED, not hardcoded. The origin project listed its two apps by name, which
// silently degraded to "no app roots" in any project laid out differently — and this script's
// dead-path check reads a missing root as "path not found", i.e. it would have flagged every
// app-relative bullet as stale. Discovery keeps absent and unknown distinguishable.
function discoverAppRoots() {
  const appsDir = join(REPO, 'apps');
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => join(appsDir, e.name))
    .sort();
}
const APP_ROOTS = discoverAppRoots();

// The always-read set — the "Start here" orientation list. AGENTS.md is taken from the repo root,
// falling back to a single app's copy when the repo keeps it there instead.
function resolveAgentsMd() {
  const rootDoc = join(REPO, 'AGENTS.md');
  if (existsSync(rootDoc)) return rootDoc;
  const fromApp = APP_ROOTS.map((r) => join(r, 'AGENTS.md')).find((p) => existsSync(p));
  return fromApp || rootDoc; // report the root path as missing rather than inventing one
}
const ALWAYS_READ = [
  { label: 'AGENTS.md', path: resolveAgentsMd() },
  { label: 'WAYS-OF-WORKING.md', path: join(ROADMAP, 'WAYS-OF-WORKING.md') },
  { label: 'LEARNINGS.md', path: join(ROADMAP, 'LEARNINGS.md') },
  { label: 'README.md (poster)', path: join(ROADMAP, 'README.md') },
];

// In-scope for candidate-flagging (per the doc-hygiene-learnings-sweep epic's v1 scope).
const FLAG_TARGETS = ['LEARNINGS.md', 'README.md (poster)'];

const STOPWORDS = new Set(
  (
    'the a an and or but of to in on for with at by from as is are was were be been being this that ' +
    'it its own not no never every each any one two both same real still only just also once new'
  ).split(' ')
);

function measure() {
  return ALWAYS_READ.map(({ label, path }) => {
    if (!existsSync(path)) return { label, path, lines: 0, bytes: 0, missing: true };
    const text = readFileSync(path, 'utf8');
    return { label, path, lines: text.split('\n').length, bytes: Buffer.byteLength(text, 'utf8') };
  });
}

// Epic status via the existing extractor — never a second frontmatter parser.
function archivedEpicSlugs() {
  try {
    const json = execFileSync('node', [join(__dirname, 'roadmap-extract.mjs')], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const rows = JSON.parse(json);
    return rows
      .filter((r) => r.grain === 'Epic' && r.status === 'Archived')
      .map((r) => r.slug)
      .filter(Boolean);
  } catch {
    return []; // extractor missing/broken shouldn't block the rest of the report
  }
}

// Split a doc into { section, bullets: [{ text, line }] } by top-level "## " headers and "- " bullets.
function splitIntoBullets(text) {
  const lines = text.split('\n');
  let section = '(preamble)';
  const bullets = [];
  let current = null;
  lines.forEach((line, i) => {
    if (/^## /.test(line)) {
      section = line.replace(/^## /, '').trim();
      return;
    }
    if (/^- /.test(line)) {
      if (current) bullets.push(current);
      current = { section, line: i + 1, text: line };
    } else if (current && /^\s+\S/.test(line)) {
      current.text += ' ' + line.trim();
    } else if (current && line.trim() === '') {
      bullets.push(current);
      current = null;
    }
  });
  if (current) bullets.push(current);
  return bullets;
}

function significantWords(text) {
  const words = text
    .toLowerCase()
    .replace(/[`*_()[\]{}"'.,:;!?]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
  return new Set(words);
}

function jaccard(a, b) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Cheap near-duplicate detector: flag bullet pairs in the SAME section sharing a high fraction of
// significant words. Threshold is deliberately conservative — false negatives are cheap (a human
// reads the section anyway); false positives waste review time.
function findNearDuplicates(bullets, threshold = 0.5) {
  const bySection = new Map();
  for (const b of bullets) {
    if (!bySection.has(b.section)) bySection.set(b.section, []);
    bySection.get(b.section).push({ ...b, words: significantWords(b.text) });
  }
  const hits = [];
  for (const [section, list] of bySection) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const sim = jaccard(list[i].words, list[j].words);
        if (sim >= threshold) {
          hits.push({ section, a: list[i].line, b: list[j].line, sim: Math.round(sim * 100) });
        }
      }
    }
  }
  return hits;
}

// Bullets reference app-relative paths (`lib/x.ts`) without an `apps/<app>/` prefix, since each app
// is its own repo. Check candidate paths against every known app root, plus the repo root for
// scripts/infra paths — a hit in ANY root clears the flag.
const SEARCH_ROOTS = [REPO, ...APP_ROOTS];

// Flag a bullet whose text names a backtick-quoted file path that doesn't exist in THIS checkout,
// under any known app root. This is a hint only — apps/* are separate, gitignored repos here and can
// be stale locally, and a bullet may legitimately describe a file deliberately deleted as part of the
// change it documents. Never treat this as proof of staleness; verify against the app repo's own history.
function findDeadPathRefs(bullets) {
  const pathRe = /`((?:apps|lib|app|scripts|infra)\/[^\s`]+\.[a-zA-Z0-9]+)`/g;
  const hits = [];
  for (const b of bullets) {
    let m;
    pathRe.lastIndex = 0;
    while ((m = pathRe.exec(b.text))) {
      const rel = m[1];
      const existsAnywhere = SEARCH_ROOTS.some((root) => existsSync(join(root, rel)));
      if (!existsAnywhere) hits.push({ section: b.section, line: b.line, path: rel });
    }
  }
  return hits;
}

function findArchivedEpicMentions(bullets, archivedSlugs) {
  if (archivedSlugs.length === 0) return [];
  const hits = [];
  for (const b of bullets) {
    for (const slug of archivedSlugs) {
      if (b.text.includes(slug)) hits.push({ section: b.section, line: b.line, slug });
    }
  }
  return hits;
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function buildReport() {
  const sizes = measure();
  const totalBytes = sizes.reduce((a, s) => a + s.bytes, 0);
  const totalLines = sizes.reduce((a, s) => a + s.lines, 0);
  const archivedSlugs = archivedEpicSlugs();

  const perFile = FLAG_TARGETS.map((label) => {
    const entry = ALWAYS_READ.find((f) => f.label === label);
    const text = existsSync(entry.path) ? readFileSync(entry.path, 'utf8') : '';
    const bullets = splitIntoBullets(text);
    return {
      label,
      dupes: findNearDuplicates(bullets),
      deadPaths: findDeadPathRefs(bullets),
      archivedMentions: findArchivedEpicMentions(bullets, archivedSlugs),
    };
  });

  const date = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push(
    `<!-- Advisory artifact from the doc-hygiene pass (the roadmap-hygiene routine, step 4) (scripts/doc-hygiene.mjs). Findings are proposals`,
    `     only — no LEARNINGS.md/README.md content was changed by this script. -->`,
    '',
    `# Doc hygiene report — ${date}`,
    '',
    '🧹 **doc-hygiene pass (the roadmap-hygiene routine, step 4).** Advisory only — review by hand; nothing here gates or auto-edits.',
    '',
    '## Always-read set size',
    ''
  );
  lines.push('| Doc | Lines | KB |', '|---|---|---|');
  for (const s of sizes) {
    lines.push(
      `| ${s.label} | ${s.missing ? '—' : fmt(s.lines)} | ${s.missing ? 'missing' : (s.bytes / 1024).toFixed(1)} |`
    );
  }
  lines.push(`| **Total** | **${fmt(totalLines)}** | **${(totalBytes / 1024).toFixed(1)}** |`, '');

  for (const f of perFile) {
    lines.push(`## ${f.label} — flagged candidates`, '');
    if (f.dupes.length === 0 && f.deadPaths.length === 0 && f.archivedMentions.length === 0) {
      lines.push('Nothing flagged this pass.', '');
      continue;
    }
    if (f.dupes.length) {
      lines.push(
        `**Possible near-duplicate bullets** (same section, high word overlap — verify before merging):`,
        ''
      );
      for (const d of f.dupes)
        lines.push(
          `- \`${f.label}\` section "${d.section}": line ${d.a} vs line ${d.b} (${d.sim}% shared words)`
        );
      lines.push('');
    }
    if (f.deadPaths.length) {
      lines.push(
        `**Referenced paths not found in this checkout** (verify against the app repo before treating as stale — this checkout can be behind the app's own \`main\`):`,
        ''
      );
      for (const d of f.deadPaths) lines.push(`- \`${f.label}\` line ${d.line}: \`${d.path}\``);
      lines.push('');
    }
    if (f.archivedMentions.length) {
      lines.push(`**Mentions an archived epic** (check whether the lesson is superseded):`, '');
      for (const d of f.archivedMentions)
        lines.push(`- \`${f.label}\` line ${d.line}: mentions archived epic \`${d.slug}\``);
      lines.push('');
    }
  }

  lines.push('---', 'Advisory only — never auto-edits. Review, then hand-merge any accepted change.', '');
  return { markdown: lines.join('\n'), sizes, totalBytes, totalLines };
}

const { markdown, totalBytes, totalLines } = buildReport();
console.log(markdown);

if (!process.argv.includes('--check')) {
  const date = new Date().toISOString().slice(0, 10);
  const outPath = join(IDEAS, `DOC-HYGIENE-REPORT-${date}.md`);
  writeFileSync(outPath, markdown);
  console.error(
    `\nWrote ${outPath} (always-read set: ${fmt(totalLines)} lines / ${(totalBytes / 1024).toFixed(1)} KB)`
  );
}
