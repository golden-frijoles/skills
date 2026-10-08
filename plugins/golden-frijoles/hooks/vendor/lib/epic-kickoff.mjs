// epic-kickoff.mjs — the epic-mode kickoff, as one pure builder (board-sinks-and-scrumban D17).
//
// It used to live only in the refine skill (`emit-epic-kickoff.mjs` + `templates/epic-kickoff.md`), which the kit does
// not ship and an installed extractor cannot import (lock C11). The Hub's "Ready to build" card has to carry the same
// kickoff the CLI prints — a kickoff composed twice is the exact drift `emit-epic-kickoff` was written to end — so
// the builder, the parsers it reads the docs with and the template text all live here, in the ONE source
// (`template/scripts/`). The refine skill imports a byte-identical copy that `skills/scripts/render-hook-vendor.mjs`
// writes into `refine/vendor/` and checks in CI; the extractor imports this file directly.
//
// The parsers moved here from `emit-kickoff.mjs` unchanged; that file re-exports them, so the per-sprint generator
// and this one still read the doc format with ONE set of parsers.
//
// Zero deps beyond node:fs/node:path (for `epicKickoffFromDir`, the only function that touches the disk).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Same substitution approach as scaffold-epic.mjs's `sub()` — {{PLACEHOLDER}} → value, leaves
// unknown placeholders untouched (so a missing var surfaces loudly in the printed output).
export const sub = (str, vars) => str.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));

// Parses the epic README's YAML-ish frontmatter block (the two `---` fence lines and simple
// `key: value` lines between them — no nested structures, matches what scaffold-epic.mjs emits).
export function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return {};
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return {};
  const out = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    // Strip a YAML inline comment (whitespace + `#` … to end-of-line) before
    // trimming: frontmatter routinely annotates values, e.g.
    // `status: in-progress   # AUTHORITATIVE …`. Without this, a comment on
    // the `slug:` line would make `frontmatter.slug !== slug` a false mismatch
    // and crash the run on otherwise-fine data. Only an UNquoted value is
    // parsed here (these frontmatters never quote), so this can't eat a `#`
    // inside a quoted string.
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, '').trim();
  }
  return out;
}

// Strips a leading `---`…`---` frontmatter fence, if present, returning only the body. Frontmatter
// commonly carries trailing `# comment` annotations on its own lines (e.g. `status: in-progress   #
// AUTHORITATIVE epic status …`, or a bare `# note` line) — those must never be mistaken for the H1,
// so every H1 search below runs against this stripped body, not the raw file text.
export function stripFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return text;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return text;
  return lines.slice(end + 1).join('\n');
}

// The epic README's H1 is `# Epic: <title>` — strip the `Epic: ` prefix. Searches only the body
// AFTER the frontmatter fence (see stripFrontmatter) so a `# `-led YAML comment can't win first.
export function parseEpicTitle(text) {
  const m = stripFrontmatter(text).match(/^#\s+(.+)$/m);
  if (!m) return null;
  const raw = m[1].trim();
  return raw.replace(/^Epic:\s*/, '');
}

// The sprint doc's H1 is `# <epic title> — Sprint <N>: <sprint title>`. The separator accepts a
// hyphen, en-dash, or em-dash ([-–—]) — an author typing a plain "-" must not crash the generator.
export function parseSprintHeader(text) {
  const m = stripFrontmatter(text).match(/^#\s+(.+?)\s+[-–—]\s+Sprint\s+(\d+):\s+(.+)$/m);
  if (!m) return null;
  return { epicTitle: m[1].trim(), sprintNum: m[2], sprintTitle: m[3].trim() };
}

// Story headings are `### Story N.M — <title>` — return the full heading text (minus `### `). The
// separator accepts a hyphen, en-dash, or em-dash ([-–—]): the em-dash-only regex this replaced
// silently dropped every story typed with a plain "-", producing a complete-looking kickoff with
// NO stories at all — the worst failure shape (silent, plausible-looking output).
export function parseStoryHeadings(text) {
  const out = [];
  const re = /^###\s+(Story\s+\d+\.\d+\s+[-–—]\s+.+)$/gm;
  let m;
  while ((m = re.exec(text))) out.push(m[1].trim());
  return out;
}

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
  const title = m[2]
    .replace(/\s+✅.*$/, '')
    .replace(/\*\*/g, '')
    .trim();
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
const NEGATED_RE =
  /\b(?:no|without|zero|not an?|nor an?)\s+(?:new\s+)?(?:db\s+|database\s+|schema\s+)?migrations?\b/gi;

export function buildEpicRules({ risk, texts, appetite = null, slug = '<slug>' }) {
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
      '- **Flag:** create it in Golden Frijoles in every env and ACTIVATE it; `frijoles flags get <key>` must show production.'
    );
  // fund-at-approval D7 — an L bet is funded one wave at a time; the re-bet is one line, asked where the builder stops.
  if (String(appetite).toUpperCase() === 'L')
    rules.push(
      `- **L bet:** it is funded one wave at a time. When you stop at a wave boundary, ask the product owner one line — ` +
        `"Start the next part of \`${slug}\`? What waits for it?" — and on yes run refine's ` +
        `\`fund.mjs --slug ${slug} --displaced "<…>"\` (position kept) before the next wave starts.`
    );
  return rules.length ? `\nFor this epic:\n${rules.join('\n')}\n` : '';
}

export function buildEpicKickoff({ macro, slug, epicTitle, risk, sprints, templateText, texts = [], appetite = null }) {
  return sub(templateText, {
    EPIC_RULES: buildEpicRules({ risk, texts, appetite, slug }),
    MACRO: macro,
    SLUG: slug,
    EPIC_TITLE: epicTitle,
    RISK: risk,
    SPRINT_COUNT: String(sprints.length),
    SPRINT_FILE_LIST: buildSprintFileList(sprints),
    SPRINT_BREAKDOWN: buildSprintBreakdown(sprints),
  });
}

// `appetite:` from a doc's frontmatter (the README's own first, else its seed's — finops D20), or null.
export function parseAppetite(text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text ?? '')?.[1] ?? '';
  return /^appetite:\s*"?([SML])"?\s*(?:#.*)?$/m.exec(fm)?.[1] ?? null;
}

// The epic's seed: the one whose `epic:` names `<macro>/<slug>` (as the extractor matches it — a seed's slug may differ
// from its epic's), else `seeds/<slug>.md`; '' when there is none.
function readSeed(read, list, dir, macro, slug) {
  const seeds = join(dir, '..', '..', '00-ideas', 'seeds');
  const pointer = new RegExp(`^epic:\\s*"?${macro}/${slug}"?\\s*(?:#.*)?$`, 'm');
  try {
    for (const name of list(seeds).filter((n) => String(n).endsWith('.md'))) {
      const text = read(join(seeds, String(name)));
      if (pointer.test(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '')) return text;
    }
    return read(join(seeds, `${slug}.md`));
  } catch {
    return '';
  }
}

// The epic README header line carries `**Risk:** <low|high>`; the frontmatter doesn't. Falls back to
// 'high' — the WAYS-OF-WORKING rule is "when unsure, treat it as high", and a kickoff that under-declares
// risk is the one that skips the mandatory fresh-reviewer pass.
export function parseEpicRisk(text) {
  const m = text.match(/\*\*Risk:\*\*\s*([A-Za-z]+)/);
  return m ? m[1].toLowerCase() : 'high';
}

/**
 * A sprint's branch, STACKED (WAYS-OF-WORKING → *Epic-mode builds*: `feat/<slug>` → `-s2` → …): sprint 1 is the epic
 * branch itself, sprint N is `feat/<slug>-s<N>`. One function, so the per-sprint kickoff, the Notion sprint card and
 * the stage resolver's branch reading (`lib/work-branch.mjs`: `-s<N>` is sprint N, no suffix is sprint 1) agree.
 */
export const sprintBranch = (slug, n) => (Number(n) <= 1 ? `feat/${slug}` : `feat/${slug}-s${Number(n)}`);
/** What sprint N branches FROM: main for sprint 1, else the previous sprint's branch (stacked; main once it merged). */
export const sprintBase = (slug, n) =>
  Number(n) <= 1 ? 'origin/main' : `origin/${sprintBranch(slug, Number(n) - 1)}`;

// The prompt POINTS at the process instead of restating it (WAYS-OF-WORKING → *Epic-mode builds* is the one copy of
// the doctrine). Its FIRST step pushes the epic branch (S1.4): Building is a git fact the moment work starts, not a
// status somebody remembers to write — the push is what moves the card on the board (README § lock, D13).
export const EPIC_KICKOFF_TEMPLATE = `Start by pushing the epic branch, before anything else — it is what moves this card to Building on the board:
\`git switch -c feat/{{SLUG}} origin/main && git push -u origin feat/{{SLUG}}\` (resuming? \`git switch feat/{{SLUG}}\`).

Build this epic in ONE orchestrated run: "{{EPIC_TITLE}}" ({{SPRINT_COUNT}} sprints, risk {{RISK}}).
Docs: Roadmap/{{MACRO}}/{{SLUG}}/README.md and {{SPRINT_FILE_LIST}}.

The process is Roadmap/WAYS-OF-WORKING.md → *Epic-mode builds*, *Review & merge* and *Escalate, don't guess*,
under AGENTS.md. Read those, the epic docs, and the Roadmap/LEARNINGS.md entries that touch this area. Start
with \`node scripts/session-resume.mjs\`.

Non-negotiable for this run:
1. **Lock first.** Write \`D1…Dn\` and each sprint's build contract into the epic README, verified against
   live code and live data, before any builder starts. Scope the live system disproves gets corrected out loud.
   Then stamp it: \`node scripts/epic-phase.mjs lock --epic {{SLUG}}\` (refuses a README with no D1; moves the band
   from Locking architecture to Building), and run \`node scripts/intent-reader.mjs --epic {{SLUG}}\` once: off by
   default (one line, nothing waits); on, one other family reads the pitch and any failure is a single
   \`reader skipped\` line. Never wait on it.
2. **Stack** \`feat/{{SLUG}}\` → \`-s2\` → …, one PR per sprint, merged in order. Worktree or in place: decide
   per *Epic-mode builds*.
3. **Review** every PR through \`node scripts/review-route.mjs --builder <who-wrote-it> <PR#>\` (one general
   pass, plus the security lens when the paths trigger it); each finding is fixed or answered before merge.
4. **Merge on green** — pre-authorized, except a new category of production mutation: ask that once.
5. **Done means shipped** — deployed and verified live, each sprint's smoke walkthrough in its sprint file,
   then the epic Definition of Done.
{{EPIC_RULES}}
## Sprints

{{SPRINT_BREAKDOWN}}
`;

/**
 * The epic kickoff for the epic in `dir` (`Roadmap/<macro>/<slug>/`), read from its README and every sprint file.
 * Throws (never exits) on a missing H1 or no sprint files: the CLI turns that into its own message, and the
 * extractor leaves the card without a kickoff rather than failing the whole projection.
 */
export function epicKickoffFromDir({
  macro,
  slug,
  dir,
  read = (p) => readFileSync(p, 'utf8'),
  list = readdirSync,
}) {
  const readmeText = read(join(dir, 'README.md'));
  const epicTitle = parseEpicTitle(readmeText);
  if (!epicTitle) throw new Error(`couldn't find an H1 title in Roadmap/${macro}/${slug}/README.md`);
  const found = listSprintFiles(list(dir));
  if (!found.length)
    throw new Error(`no sprint-N.md files under Roadmap/${macro}/${slug}/ — scaffold the epic first`);
  const sprints = found.map(({ name, num }) => {
    const text = read(join(dir, name));
    const header = parseSprintHeader(text);
    return { name, num, text, title: header ? header.sprintTitle : null, stories: parseStoryHeadings(text) };
  });
  return {
    sprints,
    readmeText,
    kickoff: buildEpicKickoff({
      macro,
      slug,
      epicTitle,
      risk: parseEpicRisk(readmeText).toUpperCase(),
      sprints,
      templateText: EPIC_KICKOFF_TEMPLATE,
      texts: [readmeText, ...sprints.map((s) => s.text)],
      appetite: parseAppetite(readmeText) ?? parseAppetite(readSeed(read, list, dir, macro, slug)),
    }),
  };
}

/** True when `dir` holds an epic README — a convenience for callers that search macro folders. */
export const isEpicDir = (dir) => existsSync(join(dir, 'README.md'));
