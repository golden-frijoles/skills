#!/usr/bin/env node
// build-state.mjs — ONE resolver for "what is being built right now" (build-visualization-claude-mods S3).
//
//   node scripts/build-state.mjs              # the build view, as the five lines the CLI mod renders
//   node scripts/build-state.mjs --json       # everything, as JSON (the mod, standup, anything else)
//   node scripts/build-state.mjs --offline    # never call `gh` (git + files only) — what the mod uses (D4)
//   node scripts/build-state.mjs --repo-root <dir>   # default: this script's repo
//
// It reads EXISTING artefacts only — the epic/sprint frontmatter contract (lib/roadmap-contract.mjs), git,
// the session journal and, unless --offline, one `gh` call. It never writes anything and never becomes a
// second source of truth: every field it prints is either a frontmatter value or a fact git/gh reports.
//
// ── Which epic, which story, which status ────────────────────────────────────────────────────────────
// Epic   — the branch: `feat|fix|chore|spike|bug|docs/<slug>`, optionally `-s<N>` / `-sprint-<N>` for a
//          stacked sprint, and optionally any `-<words>` after it (`feat/foo-s4-licences`, `docs/foo-close`).
//          The LONGEST leading run of the branch's words that names an epic wins, so `feat/aws-s3` is the
//          `aws-s3` epic when one exists and sprint 3 of `aws` when it doesn't. A branch naming no epic but
//          a seed (`Roadmap/00-ideas/seeds/<slug>.md`) is that seed's work: a bug, chore or spike with no
//          epic, or — when the seed carries `epic:` — that epic. A branch naming neither is "nothing in
//          flight here", said plainly. So are the default branch and a detached HEAD.
// Elsewhere — builders usually work in their own `git worktree` while the session sits on `main`, and
//          worktrees share one set of refs. So when this checkout has nothing in flight, the view lists
//          the other worktrees that do (resolved exactly like this one, offline) and, failing those, the
//          epics whose WRITTEN `status:` is in-progress. It reads; it never guesses which one you meant.
// Story  — D2: the newest commit on the branch (base..HEAD) whose subject names `S<n>.<m>` / `Story n.m`,
//          else the newest session-journal entry naming one AND this epic's slug, else `unknown`. A named
//          story that no sprint of this epic lists is `unknown` too — a confident wrong story is the
//          failure this exists to prevent. The journal is read from the LOCAL refs (as last fetched): this runs every turn, and a
//          network fetch has no place there.
// Status — D7: the WRITTEN `phase:` of the sprint in flight (else the epic's). Evidence may only ADVANCE
//          it on the two rungs the cadence makes directly observable: story commits on the branch lift
//          anything below Building to Building (git), and an open PR lifts to In review (gh). Locking
//          architecture, Verifying and Shipped are never inferred. `phase_written` and `status_source` are
//          always in the JSON, so a disagreement is visible rather than smoothed over.

import { execFileSync } from 'node:child_process';

// The repo is `--repo-root`, never an inherited GIT_DIR: git exports GIT_DIR (and friends) into hooks, and
// they override `cwd` — so run from a hook, this resolver would describe whichever repository the hook
// belongs to instead of the one it was asked about (found 2026-09-23 with the fixture leak in its spec).
const GIT_ENV_TO_CLEAR = [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX',
];
function repoEnv() {
  const env = { ...process.env };
  for (const k of GIT_ENV_TO_CLEAR) delete env[k];
  return env;
}
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { PHASES, isDay, parseDocFrontmatter, wrapWords, WHY_LINES_MAX } from './lib/roadmap-contract.mjs';
import { parseJournal, JOURNAL_BRANCH, JOURNAL_PATH } from './lib/session-journal.mjs';
import { branchCandidates, parseBranch } from './lib/work-branch.mjs';
import { buildRows } from './roadmap-extract.mjs';
import { gatherFacts } from './lib/stage-facts.mjs';
import { STAGES, groupByStage, stageWord } from './lib/stage.mjs';
import { getKey } from './lib/config.mjs';
import { readDateOf } from './lib/result-dates.mjs';
import { isMain } from './lib/is-main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SEEDS_DIR = ['Roadmap', '00-ideas', 'seeds'];
const MAX_WORKTREES = 8; // resolved per refresh — a pile of stale agent worktrees must not stall the view
const MAX_ELSEWHERE_LINES = 4;
const STORY_IN_TEXT_RE = /\b(?:S|Story\s+)(\d+)\.(\d+)\b/g;
const rank = (phase) => PHASES.indexOf(phase);

/** Every story id a piece of text names, in order ("S1.1–S1.4 …" → ['S1.1', 'S1.4']). */
export function storyIdsIn(text) {
  return [...String(text).matchAll(STORY_IN_TEXT_RE)].map((m) => `S${Number(m[1])}.${Number(m[2])}`);
}

// A LIST or RANGE of ids in one subject — `S1.1/1.2`, `S2.2-2.4`, `S1.1, 1.3 and 1.4` — names every id in it, but
// storyIdsIn reads only the ones with their own `S` (so `S1.1/1.2` is one id to it). The view's story-in-flight rule
// (D2) is unchanged and keeps storyIdsIn; the commit-msg check and the progress count read this (live-build-view D8).
// Each id ends where a number ends (`(?!\.?\d)` — a sentence's full stop is fine, `.288` is not): `S1.3, 2.1.288` must
// not read `2.1` out of a version number (#241).
const STORY_LIST_RE =
  /\b(?:S|Story\s+)(\d+)\.(\d+)\b(?!\.?\d)((?:\s*(?:[/,+&\u2013-]|\band\b)\s*(?:S|Story\s+)?\d+\.\d+\b(?!\.?\d))*)/g;

/** Every story id a piece of text names, continuations included ("S1.1/1.2" → ['S1.1', 'S1.2']), in order. */
export function storyIdsInWithContinuations(text) {
  return storyIdsWithKind(text).map((x) => x.id);
}

/** Like storyIdsInWithContinuations, but says which ids were bare continuations (`1.2` after `S1.1/`) — weaker evidence. */
function storyIdsWithKind(text) {
  const out = [];
  for (const m of String(text).matchAll(STORY_LIST_RE)) {
    out.push({ id: `S${Number(m[1])}.${Number(m[2])}`, bare: false });
    for (const c of (m[3] || '').matchAll(/(S|Story\s+)?(\d+)\.(\d+)/g))
      out.push({ id: `S${Number(c[2])}.${Number(c[3])}`, bare: !c[1] });
  }
  return out;
}

// ── The commit-msg story check (live-build-view S2.1, D7/D8) ─────────────────────────────────────────────
// On a branch that resolves to an epic, a commit that changes behaviour names exactly ONE story that epic (or that
// sprint, on `-s<N>`) lists — so "which story is in flight" is a fact git guarantees, not a phrasing habit.
export const STORY_GATED_TYPES = Object.freeze(['feat', 'fix', 'perf', 'refactor']);
const CONVENTIONAL_RE = /^([A-Za-z]+)(?:\([^)]*\))?!?:/;
const EXEMPT_SUBJECT_RE = /^(?:Merge |Revert "|fixup! |squash! |amend! |Squashed commit of the following)/;
export const STORY_CHECK_BYPASS = 'GF_SKIP_STORY_CHECK';

/**
 * The verdict for one commit subject on one branch: `{ ok: true, why }` or `{ ok: false, why, valid, scope, epic }`.
 * Pure over the files under `root` (it reads the epic's docs through resolveTarget — no second branch parser). It never
 * throws: a checkout this cannot read lets the commit through, and says so — a broken check must not block work.
 */
export function storyCheck({ root, branch, subject, env = {} }) {
  if (env[STORY_CHECK_BYPASS] === '1') return { ok: true, why: `${STORY_CHECK_BYPASS}=1` };
  const s = String(subject || '').trim();
  if (EXEMPT_SUBJECT_RE.test(s)) return { ok: true, why: 'merge, revert or fixup' };
  const type = CONVENTIONAL_RE.exec(s)?.[1]?.toLowerCase() ?? null;
  // An untyped subject is gated: an untyped commit must not be a silent way around the check (D8).
  if (type !== null && !STORY_GATED_TYPES.includes(type))
    return { ok: true, why: `type ${type} is not gated` };
  if (!branch) return { ok: true, why: 'detached HEAD' };
  let target;
  try {
    target = resolveTarget(root, branch);
  } catch (err) {
    return { ok: true, why: `could not read the roadmap (${err && err.message ? err.message : err})` };
  }
  if (!target || target.kind !== 'epic') return { ok: true, why: `${branch} is not an epic branch` };
  const { epic, sprint } = target;
  if (!epic.contract) return { ok: true, why: `${epic.path} predates the frontmatter contract` };
  const stories = epic.sprints.flatMap((sp) => sp.stories.map((st) => ({ ...st, sprint: sp.n })));
  const valid = stories.filter((st) => sprint === null || st.sprint === sprint);
  const scope = sprint === null ? `epic ${epic.slug}` : `epic ${epic.slug}, sprint ${sprint}`;
  const refuse = (why) => ({
    ok: false,
    why,
    valid: valid.map((st) => ({ id: st.id, title: st.title ?? '' })),
    scope,
    epic: epic.slug,
  });
  if (!valid.length) return { ok: true, why: `${scope} lists no stories` };
  // A bare continuation (`1.2` after `S1.1/`) counts only when this epic lists it: `S2.1, 3.4 GB` is one story. An id
  // spelled with its own `S` always counts, listed or not — naming a stranger is the mistake this check exists for.
  const listed = new Set(stories.map((st) => st.id));
  const ids = [
    ...new Set(
      storyIdsWithKind(s)
        .filter((x) => !x.bare || listed.has(x.id))
        .map((x) => x.id)
    ),
  ];
  if (ids.length === 0) return refuse('it names no story');
  if (ids.length > 1)
    return refuse(`it names ${ids.length} stories (${ids.join(', ')}) — one commit, one story`);
  if (!valid.some((st) => st.id === ids[0])) return refuse(`${ids[0]} is not a story of ${scope}`);
  return { ok: true, why: `names ${ids[0]}` };
}

/** The refusal, as the commit-msg hook prints it: what was wrong, the ids that would pass, and the way around. */
export function storyCheckMessage(verdict, branch) {
  const list = verdict.valid.map((st) => `    ${st.id}${st.title ? `  ${st.title}` : ''}`).join('\n');
  const example = verdict.valid[0]?.id ?? 'S1.1';
  return [
    `commit-msg: refused — a feat/fix/perf/refactor commit on ${branch} (${verdict.scope}) names exactly one story; ${verdict.why}.`,
    `  The stories it can name:`,
    list,
    `  e.g.  feat(scope): ${example} <what changed>`,
    `  docs/chore/test/ci/build/style commits are not checked. Bypass once: ${STORY_CHECK_BYPASS}=1 git commit …`,
  ].join('\n');
}

// The branch parser lives in lib/work-branch.mjs now (board-sinks-and-scrumban D13), so the stage resolver reads a
// branch exactly as this view does. Re-exported: callers and the spec import them from here.
export { branchCandidates, parseBranch };

function makeGit(root) {
  return (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: repoEnv(),
    }).trim();
}

function tryGit(git, args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function findEpic(root, slug) {
  const roadmap = join(root, 'Roadmap');
  if (!existsSync(roadmap)) return null;
  for (const macro of readdirSync(roadmap).sort()) {
    if (!/^\d{2}-/.test(macro)) continue;
    const dir = join(roadmap, macro, slug);
    if (existsSync(join(dir, 'README.md')) && statSync(dir).isDirectory()) return { macro, dir };
  }
  return null;
}

function readEpic(root, slug) {
  const found = findEpic(root, slug);
  if (!found) return null;
  const readme = parseDocFrontmatter(readFileSync(join(found.dir, 'README.md'), 'utf8'));
  const sprints = readdirSync(found.dir)
    .filter((f) => /^sprint-\d+\.md$/.test(f))
    .map((f) => ({ n: Number(f.match(/\d+/)[0]), file: f }))
    .sort((a, b) => a.n - b.n)
    .map(({ n, file }) => {
      const p = parseDocFrontmatter(readFileSync(join(found.dir, file), 'utf8'));
      return {
        n,
        file,
        title: p.data.title ?? null,
        phase: p.data.phase ?? null,
        stories: Array.isArray(p.data.stories) ? p.data.stories : [],
        contract: p.hasFrontmatter && !p.error,
      };
    });
  return {
    slug,
    path: `Roadmap/${found.macro}/${slug}/README.md`,
    title: readme.data.title ?? slug,
    area: readme.data.area ?? found.macro,
    risk: readme.data.risk ?? null,
    phase: readme.data.phase ?? null,
    locked_at: readme.data.locked_at ?? null, // live-build-view D10 — stamped by scripts/epic-phase.mjs lock
    lifecycle: readme.data.status ?? null,
    quote: quoteOf(readme.data),
    target: targetOf(readme.data),
    // build-view-one-story D2 — 3 of 92 READMEs carry `appetite:`; the quote's basis (`M, n=24, …`) names it in 42.
    size: sizeOf(readme.data.appetite) ?? sizeOf(String(readme.data.quote_basis ?? '').split(',')[0]),
    contract: readme.hasFrontmatter && !readme.error && 'phase' in readme.data,
    sprints,
  };
}

/** `M`, `L          # amended …` → `M`, `L`; anything that is not a size → null. */
function sizeOf(v) {
  const m = /^\s*(XS|S|M|L|XL)\b/.exec(String(v ?? ''));
  return m ? m[1] : null;
}

const unquoteNull = (v) => (v === null || v === undefined || v === 'null' || v === '' ? null : v);

function readSeed(root, slug) {
  const path = join(root, ...SEEDS_DIR, `${slug}.md`);
  if (!existsSync(path)) return null;
  const p = parseDocFrontmatter(readFileSync(path, 'utf8'));
  if (!p.hasFrontmatter) return null;
  const d = p.data;
  // D2 — the seed's quote is its body's `quote: $lo–hi (basis)` line, read with scaffold-epic's own regex.
  const q = /^quote:\s*\$(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)\s*\(([^)]+)\)/m.exec(p.body ?? '');
  return {
    slug,
    title: d.title ?? slug,
    type: TYPES_KNOWN.includes(d.type) ? d.type : 'chore',
    appetite: sizeOf(unquoteNull(d.appetite)),
    risk: unquoteNull(d.risk),
    status: unquoteNull(d.status),
    epic: unquoteNull(d.epic),
    path: `${SEEDS_DIR.join('/')}/${slug}.md`,
    target: targetOf(d),
    quote: q && Number(q[1]) <= Number(q[2]) ? { low: Number(q[1]), high: Number(q[2]), basis: q[3] } : null,
  };
}
const TYPES_KNOWN = ['feature', 'spike', 'bug', 'chore'];

/**
 * What the branch names, longest reading first: an epic, else a seed (a seed that carries `epic:` is that
 * epic — once scaffolded the seed is funnel-only), else null. Exported for epic-actuals.mjs (finops D16): spend is
 * attributed to an epic by exactly this reading of a branch, never a second one.
 */
export function resolveTarget(root, branch) {
  for (const c of branchCandidates(branch)) {
    const epic = readEpic(root, c.slug);
    if (epic) return { kind: 'epic', epic, sprint: c.sprint, match: c.exact ? 'exact' : 'prefix' };
    const seed = readSeed(root, c.slug);
    if (seed) {
      const epicSlug = seed.epic ? String(seed.epic).split('/').pop() : null;
      const linked = epicSlug ? readEpic(root, epicSlug) : null;
      if (linked) return { kind: 'epic', epic: linked, sprint: c.sprint, match: 'seed' };
      return { kind: 'seed', seed, match: c.exact ? 'exact' : 'prefix' };
    }
  }
  return null;
}

/** Epics whose WRITTEN lifecycle is in-progress — the Roadmap's own answer to "what is open". */
function openEpics(root) {
  const roadmap = join(root, 'Roadmap');
  if (!existsSync(roadmap)) return [];
  const out = [];
  for (const macro of readdirSync(roadmap).sort()) {
    if (!/^\d{2}-/.test(macro)) continue;
    let dirs = [];
    try {
      dirs = readdirSync(join(roadmap, macro), { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const d of dirs) {
      const readme = join(roadmap, macro, d.name, 'README.md');
      if (!existsSync(readme)) continue;
      const p = parseDocFrontmatter(readFileSync(readme, 'utf8'));
      if (p.data.status !== 'in-progress') continue;
      out.push({
        slug: d.name,
        title: p.data.title ?? d.name,
        area: p.data.area ?? macro,
        phase: p.data.phase ?? null,
        path: `Roadmap/${macro}/${d.name}/README.md`,
      });
    }
  }
  return out;
}

/**
 * The base to measure "this branch's commits" from: of every default-branch candidate that exists, the one
 * whose merge-base with HEAD is the NEWEST. A stale `origin/main` (local `main` fetched since, or advanced)
 * would otherwise put main's own commits inside base..HEAD and let them name the story (codex, on a
 * consumer copy-in). Returns { ref, mergeBase } or nulls.
 */
function baseRef(git) {
  const head = tryGit(git, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  let best = { ref: null, mergeBase: null };
  for (const ref of [head, 'origin/main', 'main', 'origin/master', 'master'].filter(Boolean)) {
    if (!tryGit(git, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])) continue;
    const mb = tryGit(git, ['merge-base', ref, 'HEAD']);
    if (!mb) continue;
    // "Newest" by ANCESTRY, not by commit date: two candidates' merge-bases can share a timestamp to the
    // second (they do in the tests, and in a fast scripted sequence), and a date comparison then keeps
    // whichever came first in the list.
    const advances =
      !best.mergeBase || tryGit(git, ['merge-base', '--is-ancestor', best.mergeBase, mb]) !== null;
    if (advances) best = { ref, mergeBase: mb };
  }
  return best;
}

function readJournalLocal(git) {
  for (const ref of [JOURNAL_BRANCH, `origin/${JOURNAL_BRANCH}`]) {
    const text = tryGit(git, ['show', `${ref}:${JOURNAL_PATH}`]);
    if (text) return { entries: parseJournal(text), ref };
  }
  return { entries: [], ref: null };
}

/**
 * The open PR for `branch`, read from the run's facts (board-sinks-and-scrumban S3.1): the ONE `gh pr list` the facts
 * made already holds every PR, so the build view asks GitHub nothing more. `ok` is whether those facts are live.
 */
export function prFromFacts(facts, branch) {
  const open = (facts?.prs ?? []).filter((p) => p.head === branch && p.state === 'OPEN');
  const pr = open.reduce((best, p) => (best === null || p.number > best.number ? p : best), null);
  // Only LIVE facts may lift the status to In review: a failed online gather that fell back to the snapshot must not
  // claim a PR from hours ago (before this, a failed gh call meant no lift; fresh review, #227).
  const live = facts?.mode === 'live';
  return { ok: live, pr: live && pr ? { number: pr.number, url: pr.url, draft: !!pr.draft } : null };
}

const notInFlight = (reason, extra = {}) => ({ in_flight: false, reason, ...extra });

// ── Spend (finops S1.3, D5) ─────────────────────────────────────────────────────────────────────────────
// The band only READS: `<main checkout>/.golden-frijoles/usage-summary.json`, written by epic-actuals.mjs (refreshed
// by the mod off the hot path, and by any CLI run). Nothing here scans a transcript. No summary, or no row for this
// epic, means no Spend line — never a zero.
export const USAGE_SUMMARY = ['.golden-frijoles', 'usage-summary.json'];

/** The main checkout of `root` (the parent of git's common dir) — where the usage summary lives (finops D19). */
function mainCheckoutOf(git, root) {
  const common = tryGit(git, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return root;
  return /[\\/]\.git$/.test(common) ? dirname(common) : root;
}

/** This epic's row of the usage summary, or null. Never throws. */
export function spendFor(root, git, slug) {
  try {
    const path = join(mainCheckoutOf(git, root), ...USAGE_SUMMARY);
    if (!existsSync(path)) return null;
    const summary = JSON.parse(readFileSync(path, 'utf8'));
    // A first scan that ran out of its time budget is not a total yet: no row until it completes, never a low number.
    if (summary?.complete === false) return null;
    const row = summary?.epics?.[slug];
    if (!row || typeof row.usd !== 'number') return null;
    return {
      usd: row.usd,
      usd_known: row.usd_known !== false,
      mtok: typeof row.mtok === 'number' ? row.mtok : null,
      sessions: Number.isInteger(row.sessions) ? row.sessions : null,
      basis: typeof summary.basis === 'string' ? summary.basis : 'this machine',
      generated_at: summary.generated_at ?? null,
      // finops S3 (round 3, #232): snapshots the engine refused as malformed, cumulative for this index. Shown on the
      // Spend line so a refusal during the automatic refresh is never only a number in a file nobody opens.
      push_rejected:
        Number.isInteger(summary.push_rejected) && summary.push_rejected > 0 ? summary.push_rejected : 0,
    };
  } catch {
    return null;
  }
}

/** `≈$38` (a lower bound reads `≥$38`: some turns could not be priced — finops D4). */
export function dollars(usd, known = true) {
  const sign = known ? '≈' : '≥';
  return usd > 0 && usd < 1 ? `${sign}$${usd.toFixed(2)}` : `${sign}$${Math.round(usd)}`;
}

/**
 * What the quote's basis adds to the Spend line (build-view-one-story D8): nothing for a calibrated quote (the size is on
 * the header now), `(2 past epics, wide)` while history is thin. Read from the `quote_basis` quote.mjs writes
 * (`M, n=2, wide` / `M, n=5, p25–p75`); an unreadable basis shows as written.
 */
export function quoteLabel(basis) {
  const m = /^\s*([SML])\s*,\s*n=(\d+)\s*,\s*(wide|p25–p75)\s*$/.exec(String(basis ?? ''));
  if (m) return m[3] === 'wide' ? `(${m[2]} past epic${m[2] === '1' ? '' : 's'}, wide)` : '';
  return basis ? `(${basis})` : '';
}

export const SPEND_BAR_WIDTH = 10;

/** `▰▰▰▱▱▱▱▱▱▱` — spend against the quote's high end, full when over (finops D8: alert-only). */
export function spendBar(usd, high) {
  const filled =
    usd > high ? SPEND_BAR_WIDTH : Math.max(0, Math.min(SPEND_BAR_WIDTH, Math.round((usd / high) * SPEND_BAR_WIDTH)));
  return '▰'.repeat(filled) + '▱'.repeat(SPEND_BAR_WIDTH - filled);
}

/**
 * The Spend line's value — the states of the approved design (build-view-one-story D8; the resolver owns the words and
 * the bar, the band only colours them):
 *   inside    ▰▰▰▱▱▱▱▱▱▱  ≈$22 of the $49–68 quote · 1 session
 *   over      ▰▰▰▰▰▰▰▰▰▰  ≈$71 · 29% over the $30–55 quote · 4 sessions        (finops D8: alert-only)
 *   no quote  ≈$22 · no quote · 2 sessions                                    (never an invented quote, so no bar)
 *   thin      ▰▱▱▱▱▱▱▱▱▱  ≈$9 of the $25–90 quote (2 past epics, wide) · …
 * With no quote object at all (an old caller) it names where it was measured.
 */
export function spendValue(spend, quote) {
  const line = spendLine(spend, quote);
  return spend.push_rejected
    ? `${line} · ${spend.push_rejected} usage push${spend.push_rejected === 1 ? '' : 'es'} refused — epic-actuals --push --json`
    : line;
}

function spendLine(spend, quote) {
  const sessions =
    spend.sessions !== null ? `${spend.sessions} session${spend.sessions === 1 ? '' : 's'}` : null;
  const usd = dollars(spend.usd, spend.usd_known);
  if (quote === undefined) return [usd, sessions, spend.basis].filter(Boolean).join(' · ');
  if (!quote) return [usd, 'no quote', sessions].filter(Boolean).join(' · ');
  const label = quoteLabel(quote.basis);
  const range = `the $${quote.low}–${quote.high} quote${label ? ` ${label}` : ''}`;
  const bar = quote.high > 0 ? `${spendBar(spend.usd, quote.high)}  ` : '';
  if (spend.usd > quote.high) {
    const pct = quote.high > 0 ? Math.round(((spend.usd - quote.high) / quote.high) * 100) : null;
    // `<1% over`, never `0% over`: the comparison is on the raw dollars, so a rounded 0 would read as "not over".
    const over = pct === null ? 'over' : pct < 1 ? '<1% over' : `${pct}% over`;
    return `${bar}${[usd, `${over} ${range}`, sessions].filter(Boolean).join(' · ')}`;
  }
  return `${bar}${[`${usd} of ${range}`, sessions].filter(Boolean).join(' · ')}`;
}

/**
 * The result record's target off the README frontmatter (build-view-upgrade D1; the fields are result-record's
 * TARGET_FIELDS). A target is the metric with both numbers; a hypothesis on its own is kept, and is not a target.
 */
export function targetOf(readme) {
  const text = (v) => (typeof v === 'string' && v.trim() && v.trim() !== 'null' ? v.trim() : null);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const metric = text(readme.target_metric);
  const from = num(readme.target_from);
  const to = num(readme.target_to);
  const intent = readme.intent_match;
  return {
    hypothesis: text(readme.hypothesis),
    metric: metric !== null && from !== null && to !== null ? metric : null,
    from,
    to,
    read_date: isDay(readme.read_date) ? readme.read_date : null,
    // build-view-one-story D5 — what we know when there is no target, and how well the pitch matched the ask.
    grounded_reason: text(readme.grounded_reason),
    intent_match: typeof intent === 'number' && Number.isFinite(intent) ? Math.round(intent) : null,
    verdict: ['proven', 'disproven', 'unclear'].includes(readme.verdict) ? readme.verdict : null,
  };
}

/** The epic's quote off its README frontmatter, or null (an unquoted epic — never a $0 quote, D4). */
export function quoteOf(readme) {
  const lo = readme.quote_low_usd;
  const hi = readme.quote_high_usd;
  if (typeof lo !== 'number' || typeof hi !== 'number' || lo > hi) return null;
  return { low: lo, high: hi, basis: readme.quote_basis ?? null, appetite: readme.appetite ?? null };
}

/** Does `text` name `slug` as a whole slug — `aws` in "aws S1.1", but not inside "aws-s3 S1.1"? */
export function namesSlug(text, slug) {
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9-])${esc}($|[^A-Za-z0-9-])`).test(String(text));
}

/** "just now", "12m ago", "3h ago", "2 days ago" — how old the facts behind a stage are. */
export function ageOf(iso, now = new Date()) {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/**
 * The stage of what is in flight, and the board around it (board-sinks-and-scrumban S3.1, D2/D14). The stage is the
 * EXTRACTOR's row for this initiative — the same `buildRows()` the Hub's push and BUILD-ORDER.md read — so the build
 * view cannot say a different word than the board. `dates: false` keeps it inside the hook's budget (~50 ms).
 */
export function boardState({ root, facts, state, now = new Date() }) {
  const rows = buildRows({ facts: facts ?? undefined, root, dates: false });
  const slug = state.in_flight ? (state.epic?.slug ?? state.seed?.slug ?? null) : null;
  const row = slug ? rows.find((r) => r.grain !== 'Sprint' && r.slug === slug) : null;
  const cols = groupByStage(rows);
  // build-view-one-story D8 — the next to pull is never the work this view is about.
  const next = cols['Ready to build'].find((r) => r.slug !== slug) ?? null;
  // The counts leave out the work in view too: "Around" is everything else.
  const others = (stage) => cols[stage].filter((r) => r.slug !== slug).length;
  const hub = getKey('board.hubUrl', { root });
  const hubUrl = typeof hub === 'string' && /^https:\/\//.test(hub) ? hub.replace(/\/+$/, '') : null;
  return {
    stage: row ? row.stage : null,
    stage_source: row ? row.stage_source : null,
    stage_age:
      facts?.mode === 'live' ? 'just now' : facts?.generated_at ? ageOf(facts.generated_at, now) : null,
    facts_mode: facts?.mode ?? 'docs',
    board: {
      building: others('Building'),
      qa: others('QA'),
      ready: others('Ready to build'),
      next: next
        ? { name: next.name, slug: next.slug, build_order: next.build_order_num ?? null, grain: next.grain ?? null }
        : null,
      // build-view-upgrade D4 — the work's own page when the board has a row for it, else the board.
      url: hubUrl ? (slug && row ? `${hubUrl}/epic/${encodeURIComponent(slug)}` : `${hubUrl}/board`) : null,
    },
  };
}

/**
 * Resolve the build state. Every external read is injectable so the tests drive real fixture repos with
 * a fake `gh`: { root, offline, git, gh }. It NEVER throws — it runs once per turn inside a CLI hook, and
 * an exception there is a blank view: any failure is reported as "not in flight", with the reason.
 * `elsewhere: false` skips the other-worktrees / open-epics scan (used when resolving those worktrees).
 */
export function resolveBuildState(opts = {}) {
  // board-sinks-and-scrumban S3.1 — ONE facts gather per run: the snapshot offline (the hook never goes online), else
  // one `git ls-remote` + one `gh pr list`, which also refreshes the snapshot. Injectable for the spec.
  let facts = null;
  if (opts.board !== false) {
    try {
      facts = (opts.gather ?? gatherFacts)({ root: opts.root, mode: opts.offline ? 'snapshot' : 'live' });
    } catch {
      facts = null;
    }
  }
  let state;
  try {
    state = resolve_({ ...opts, facts });
  } catch (err) {
    state = notInFlight(
      `the resolver could not read this checkout (${err && err.message ? err.message : err})`
    );
  }
  if (opts.board !== false) {
    try {
      Object.assign(state, boardState({ root: opts.root, facts, state, now: opts.now ?? new Date() }));
    } catch {
      // A roadmap this extractor cannot read (an out-of-enum status) leaves the view without a stage, never blank.
    }
  }
  try {
    state.repo = repoName(opts.root, opts.git || makeGit(opts.root));
  } catch {
    state.repo = null;
  }
  if (opts.elsewhere === false) return state;
  try {
    state.elsewhere = elsewhere_({ root: opts.root, git: opts.git || makeGit(opts.root), state });
  } catch {
    state.elsewhere = { worktrees: [], open_epics: [] };
  }
  return state;
}

/**
 * The repo's own name for the header (build-view-one-story D2): `origin`'s, else the main checkout's folder — never the
 * worktree's folder, and never the plugin's name (the band hard-coded `golden-frijoles` before this).
 */
export function repoName(root, git) {
  const url = tryGit(git, ['remote', 'get-url', 'origin']);
  const m = url ? /([^/:]+?)(?:\.git)?\/?$/.exec(url) : null;
  if (m) return m[1];
  return basename(mainCheckoutOf(git, root || '.')) || null;
}

/** `git worktree list --porcelain` → [{ path, branch, bare, prunable }]. Pure. */
export function parseWorktrees(porcelain) {
  const out = [];
  let cur = null;
  for (const line of String(porcelain || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: null, bare: false, prunable: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('branch '))
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return out;
}

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

const DONE_LIFECYCLES = ['shipped', 'archived'];

/**
 * Work in flight OUTSIDE this checkout: every other worktree on a work branch, resolved exactly like this
 * one (offline — no `gh` per worktree), and the epics the Roadmap itself says are in progress. Worktrees
 * share this repo's refs, so this is local reads only.
 */
function elsewhere_({ root, git, state }) {
  const top = tryGit(git, ['rev-parse', '--show-toplevel']) || root;
  const worktrees = [];
  const seen = new Set();
  let resolved = 0;
  for (const w of parseWorktrees(tryGit(git, ['worktree', 'list', '--porcelain']))) {
    if (!w.branch || w.bare || w.prunable || samePath(w.path, top) || !existsSync(w.path)) continue;
    if (!branchCandidates(w.branch).length) continue; // main, release branches: nothing to resolve
    if (resolved++ >= MAX_WORKTREES) break;
    const s = resolveBuildState({ root: w.path, offline: true, elsewhere: false, board: false });
    if (!s.in_flight || DONE_LIFECYCLES.includes(s.lifecycle)) continue;
    const item = s.epic
      ? { kind: 'epic', slug: s.epic.slug, title: s.epic.title }
      : { kind: s.kind, slug: s.seed.slug, title: s.seed.title };
    seen.add(item.slug);
    worktrees.push({
      ...item,
      path: w.path,
      branch: w.branch,
      story: s.story ? s.story.id : null,
      status: s.status ?? null,
    });
  }
  const current = state.in_flight ? (state.epic?.slug ?? state.seed?.slug) : null;
  const open_epics = openEpics(root).filter((e) => !seen.has(e.slug) && e.slug !== current);
  return { worktrees, open_epics };
}

/** A branch naming a seed and no epic: a bug, chore, spike or unscaffolded feature. No stories, no sprints. */
function seedState({ root, git, gh, offline, branch, seed, match }) {
  const { ref: base, mergeBase } = baseRef(git);
  const subjects = mergeBase
    ? (tryGit(git, ['log', '--format=%s', `${mergeBase}..HEAD`]) || '').split('\n').filter(Boolean)
    : [];
  let status = seed.status;
  let statusSource = seed.status ? 'written' : 'unknown';
  if (subjects.length) {
    status = 'Building';
    statusSource = 'git';
  }
  let pr = null;
  let ghChecked = false;
  if (!offline) {
    const res = gh(root, branch);
    ghChecked = res.ok;
    pr = res.pr;
    if (pr) {
      status = 'In review';
      statusSource = 'gh';
    }
  }
  return {
    in_flight: true,
    kind: seed.type,
    branch,
    branch_match: match,
    epic: null,
    seed: {
      slug: seed.slug,
      title: seed.title,
      type: seed.type,
      appetite: seed.appetite,
      risk: seed.risk,
      path: seed.path,
      status: seed.status,
      quote: seed.quote,
    },
    target: seed.target,
    sprint: null,
    story: null,
    story_source: 'n/a',
    story_note: null,
    progress: null,
    lifecycle: seed.status,
    status,
    status_source: statusSource,
    phase_written: null,
    evidence: {
      base,
      merge_base: mergeBase,
      commits: subjects.length,
      pr,
      gh: offline ? 'skipped (--offline)' : ghChecked ? 'ok' : 'unavailable',
    },
  };
}

function resolve_({ root, offline = false, git = makeGit(root), facts = null, gh } = {}) {
  gh = gh ?? ((_root, branch) => prFromFacts(facts, branch));
  if (tryGit(git, ['rev-parse', '--is-inside-work-tree']) !== 'true')
    return notInFlight('not inside a git checkout (or git is not installed)', { where: 'not a git checkout' });
  const branch = tryGit(git, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (!branch) return notInFlight('detached HEAD — no branch, so no epic in flight', { where: 'detached HEAD' });
  const cands = branchCandidates(branch);
  if (!cands.length)
    return notInFlight(`on ${branch} — not an epic branch (feat/<slug>…), so no epic in flight`, {
      branch,
      quiet: true, // build-view-one-story D6: the plain case — the header says it, Now does not repeat it
    });
  // The LONGEST reading that names something wins: with both `aws` and `aws-s3` on the board, `feat/aws-s3`
  // is the `aws-s3` epic, never sprint 3 of `aws` (codex, on a consumer copy-in).
  const target = resolveTarget(root, branch);
  if (!target) {
    const slug = cands.at(-1).slug;
    return notInFlight(
      `${branch} names no epic under Roadmap/ (looked for */${cands[0].slug}/README.md … */${slug}/README.md) and no seed`,
      { branch }
    );
  }
  if (target.kind === 'seed')
    return seedState({ root, git, gh, offline, branch, seed: target.seed, match: target.match });
  const epic = target.epic;
  const parsed = { slug: epic.slug, sprint: target.sprint };
  if (!epic.contract)
    return notInFlight(`${epic.path} predates the frontmatter contract — run scripts/roadmap-backfill.mjs`, {
      branch,
    });

  // All stories of the epic, in build order — the ordinal is "Story X of Y".
  const allStories = epic.sprints.flatMap((s) => s.stories.map((st) => ({ ...st, sprint: s.n })));
  const byId = new Map(allStories.map((st, i) => [st.id, { ...st, ordinal: i + 1 }]));
  // A story counts only if THIS epic lists it — and, on a stacked sprint branch (`-s4`), only if it is that
  // sprint's: base..HEAD on a stacked branch still carries the previous sprint's commits, and reporting
  // them would be a confident wrong answer (found by the fresh reviewer on #27).
  const accepts = (id) => byId.has(id) && (parsed.sprint === null || byId.get(id).sprint === parsed.sprint);
  const scope = parsed.sprint === null ? 'this epic' : `sprint ${parsed.sprint} of this epic`;

  // D2 — commits first, then the journal, then unknown.
  const { ref: base, mergeBase } = baseRef(git);
  const range = mergeBase ? `${mergeBase}..HEAD` : null;
  const subjects = range
    ? (tryGit(git, ['log', '--format=%s', range]) || '').split('\n').filter(Boolean)
    : [];
  const storyCommits = subjects.filter((s) => storyIdsIn(s).some(accepts)).length;
  // live-build-view S2.2 (D9): how many of this EPIC's stories have a commit — distinct ids the epic lists, from every id
  // a subject names (continuations too, so a pre-S2.1 `S1.1/1.2` bundle counts both). Not sprint-filtered: a stacked
  // `-s2` branch carries sprint 1's commits, and those are done stories.
  const withCommits = new Set(subjects.flatMap(storyIdsInWithContinuations).filter((id) => byId.has(id)));
  const foreign = [...new Set(subjects.flatMap(storyIdsIn).filter((id) => !accepts(id)))];
  let story = null;
  let storySource = 'unknown';
  let unlisted = null;
  for (const subject of subjects) {
    const ids = storyIdsIn(subject);
    if (!ids.length) continue;
    // An id this epic does not list AT ALL stops everything — including the journal fallback below: the
    // newest story commit is the claim about what is in flight, so answering with an older commit, with
    // the other id in the same subject, or with a journal entry would each be a guess (D2; codex on the
    // consumer copy-ins). An id of ANOTHER SPRINT of this epic is different — a stacked branch inherits
    // those — so it is skipped and the walk continues (the fresh reviewer's finding on #27).
    const strangers = ids.filter((id) => !byId.has(id));
    if (strangers.length) {
      unlisted = strangers;
      break;
    }
    const mine = ids.filter(accepts);
    if (mine.length) {
      story = byId.get(mine.at(-1));
      storySource = 'commit';
      break;
    }
  }
  // The journal: only an entry that NAMES this epic's slug. Every epic has an S1.1, and the journal is
  // shared by every session in the repo — parallel epics write to it at the same time — so neither an id
  // nor a timestamp says which epic an entry meant (codex, on both consumer copy-ins).
  // Journal a story as: node scripts/session-note.mjs --kind doing "<epic-slug> S2.1 — …"
  let journalRef = null;
  if (!story && !unlisted) {
    const journal = readJournalLocal(git);
    journalRef = journal.ref;
    for (const entry of [...journal.entries].reverse()) {
      // A journal line is only JSON — `refs` may be anything, and spreading a non-array threw, which the
      // outer guard then reported as "not in flight" on a perfectly good branch (codex, consumer copy-in).
      const refs = Array.isArray(entry.refs) ? entry.refs : [];
      const text = [entry.text, ...refs].filter((v) => typeof v === 'string').join(' ');
      const ids = namesSlug(text, epic.slug) ? storyIdsIn(text).filter(accepts) : [];
      if (ids.length) {
        story = byId.get(ids.at(-1));
        storySource = 'journal';
        break;
      }
    }
  }
  const storyNote = story
    ? null
    : unlisted
      ? `the newest story commit names ${unlisted.join(', ')}, which no sprint of this epic lists`
      : foreign.length
        ? `commits here name ${foreign.join(', ')}, none of them ${scope}'s`
        : 'no story started yet';

  // The sprint: the story's, else the branch's -s<N>, else none — never "the first unshipped one".
  const sprintN = story ? story.sprint : parsed.sprint;
  const sprint = epic.sprints.find((s) => s.n === sprintN) || null;
  // build-view-one-story D6 — the next story in this branch's scope with no commit yet, and whether the work is BETWEEN
  // stories: the tree is clean and HEAD itself is the in-flight story's commit (story `status:` is ticked at close, so
  // it cannot say this — measured on the last four epics).
  const shipped = epic.lifecycle === 'shipped';
  const nextStory = allStories.find((st) => accepts(st.id) && !withCommits.has(st.id)) ?? null;
  const clean = story && storySource === 'commit' ? tryGit(git, ['status', '--porcelain']) === '' : false;
  // …or every story in scope already has one, and nothing is uncommitted (a release or docs commit on top).
  const between = !!(clean && ((subjects[0] && storyIdsIn(subjects[0]).includes(story.id)) || !nextStory));
  // D2 — the header's sprint: the story's, else the branch's, else the first with a story left, else the last.
  const headerSprint =
    sprint ??
    (shipped ? null : epic.sprints.find((s) => s.stories.some((st) => !withCommits.has(st.id)))) ??
    epic.sprints.at(-1) ??
    null;
  // D7 — the ship day: the newest commit touching the README's `status: shipped` line. One git call, shipped only.
  const shippedOn = shipped
    ? tryGit(git, ['log', '-1', '--format=%cs', '-G^status:[[:space:]]*shipped', '--', epic.path]) || null
    : null;
  // A sprint whose frontmatter could not be read is not "a sprint with no stories": say so, rather than
  // serving the epic's phase as if it were the sprint's (codex, consumer copy-in).
  const unreadableSprint =
    sprint && !sprint.contract ? `Roadmap/…/sprint-${sprint.n}.md frontmatter could not be read` : null;

  // D7 — the written phase, advanced only by direct evidence.
  // The sprint in flight owns the phase. When there IS a sprint but it carries no readable one, the epic's
  // phase is NOT a stand-in — claiming it would state a sprint phase nobody wrote (codex, consumer copy-in).
  // Status is then null ("unknown") unless evidence lifts it, which is the one honest answer.
  const phaseWritten = sprint ? sprint.phase || null : epic.phase;
  let status = phaseWritten;
  let statusSource = phaseWritten ? 'written' : 'unknown';
  if (storyCommits > 0 && rank(status) < rank('Building')) {
    status = 'Building';
    statusSource = 'git';
  }
  let pr = null;
  let ghChecked = false;
  if (!offline) {
    const res = gh(root, branch);
    ghChecked = res.ok;
    pr = res.pr;
    if (pr && rank(status) < rank('In review')) {
      status = 'In review';
      statusSource = 'gh';
    }
  }

  return {
    in_flight: true,
    kind: 'epic',
    branch,
    branch_match: target.match,
    spend: spendFor(root, git, epic.slug),
    quote: epic.quote,
    lifecycle: epic.lifecycle,
    epic: {
      slug: epic.slug,
      title: epic.title,
      area: epic.area,
      risk: epic.risk,
      phase: epic.phase,
      locked_at: epic.locked_at,
      path: epic.path,
    },
    sprint: sprint ? { n: sprint.n, title: sprint.title, phase: sprint.phase } : null,
    story: story
      ? {
          id: story.id,
          title: story.title,
          as_a: story.as_a,
          i_want: story.i_want,
          so_that: story.so_that,
          status: story.status,
        }
      : null,
    story_source: storySource,
    story_note: unreadableSprint ? `${unreadableSprint}${storyNote ? ` — ${storyNote}` : ''}` : storyNote,
    warning: unreadableSprint,
    target: epic.target,
    size: epic.size ?? readSeed(root, epic.slug)?.appetite ?? null,
    between,
    next_story: nextStory ? { id: nextStory.id, title: nextStory.title ?? null } : null,
    shipped_on: isDay(shippedOn) ? shippedOn : null,
    progress: {
      // D7 — a shipped epic has done every story (the extractor's floorSprintDone rule): its commits are on main now,
      // outside base..HEAD, and "0 of 6 done" on a close-out branch was the bug.
      stories_with_commits: shipped ? allStories.length : withCommits.size,
      // build-view-upgrade D2 — the same measure per sprint, in build order: [done, total] for each.
      by_sprint: epic.sprints.map((sp) => ({
        n: sp.n,
        done: shipped ? sp.stories.length : sp.stories.filter((st) => withCommits.has(st.id)).length,
        total: sp.stories.length,
      })),
      story: story ? story.ordinal : null,
      stories: allStories.length,
      sprint: sprint ? epic.sprints.indexOf(sprint) + 1 : null,
      header_sprint: headerSprint ? epic.sprints.indexOf(headerSprint) + 1 : null,
      sprints: epic.sprints.length,
    },
    status,
    status_source: statusSource,
    phase_written: phaseWritten,
    evidence: {
      base,
      merge_base: mergeBase,
      story_commits: storyCommits,
      pr,
      gh: offline ? 'skipped (--offline)' : ghChecked ? 'ok' : 'unavailable',
      journal: journalRef,
    },
  };
}

/**
 * The stage, said with where it came from and how old that is (board-sinks-and-scrumban S3.1): "Building · from git:
 * feat/x · facts from the snapshot, 3h ago". The written `phase:` stays only as a detail (D12). Without a stage (the
 * roadmap could not be read) it falls back to the old written-phase status, labelled as such.
 */
export function statusValue(state) {
  if (!state.stage) return state.status || `unknown${state.warning ? ` — ${state.warning}` : ''}`;
  const { stage, source, age, phase } = stageParts(state);
  return `${stage} · from ${source} (${age})${phase}`;
}

/** The stage in flight, where it came from, how old that is and a differing written phase — statusValue's parts. */
function stageParts(state) {
  const source = String(state.stage_source || '').replace(/ · snapshot@\S+$/, '');
  // live-build-view D11 — the band's refinement of Building, not a new stage (the Hub and the board keep Building): an
  // epic whose branch is live but whose README carries no `locked_at` is still Locking architecture. The lock is a
  // command (scripts/epic-phase.mjs lock), so from here on every rung is set by a trigger.
  // Only while the EPIC's written phase is still before the lock (the README's, not the sprint's — sprint files are born
  // Shaping): an epic built before the command existed (README Building or later, no stamp) keeps reading Building (#241).
  const locking =
    state.kind === 'epic' &&
    state.stage === 'Building' &&
    !state.epic?.locked_at &&
    [null, 'Shaping', 'Locking architecture'].includes(state.epic?.phase ?? null) &&
    // build-view-one-story D4 (b): story commits mean the build has started; the ⚑ line names the missing stamp.
    !(state.evidence?.story_commits > 0) &&
    /^(?:git: |github: PR #\d+ draft)/.test(source);
  const stage = locking ? 'Locking architecture' : state.stage;
  const age =
    state.facts_mode === 'live'
      ? 'live'
      : state.facts_mode === 'snapshot'
        ? `snapshot, ${state.stage_age ?? 'age unknown'}`
        : 'docs only, no snapshot yet';
  const phase = state.phase_written && state.phase_written !== stage ? ` · phase ${state.phase_written}` : '';
  return { stage, locking, source, age, phase };
}

// build-view-upgrade D3 — the stage as a track, in lib/stage.mjs's words. `To groom` shows only when it is the stage.
export const TRACK_MARK = '◉';

/** `Grooming ─ Ready ─ ◉ Building ─ QA ─ Shipped` for a stage; `◉ Locking` in Building's place while locking. */
export function stageTrack(stage, locking = false) {
  return STAGES.filter((s) => s !== 'To groom' || stage === 'To groom')
    .map((s) => {
      const word = s === 'Building' && locking ? 'Locking' : stageWord(s);
      return s === stage ? `${TRACK_MARK} ${word}` : word;
    })
    .join(' ─ ');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-12-04` → `4 Dec` (with the year when it is not `now`'s), read in UTC like every result-record day. */
export function shortDay(day, now = new Date()) {
  if (!isDay(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${y !== now.getUTCFullYear() ? ` ${y}` : ''}`;
}

// Four significant digits, so a small target (0.004 → 0.006) never rounds to 0 (#312 review).
const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(4))));

// why-as-a-story D4 — the Why is read in full: it wraps (lib/roadmap-contract's wrapWords, the guard's own wrap).
export { wrapWords, WHY_LINES_MAX };


// build-view-upgrade D2 — one cell per story, sprint by sprint: ▰ has a commit, ▱ not yet, │ between sprints.
export const SPRINT_CELLS_MAX = 8;

/** `[{done:2,total:3},{done:0,total:4}]` → `▰▰▱│▱▱▱▱`. A sprint wider than SPRINT_CELLS_MAX is scaled to it. */
export function sprintBars(bySprint) {
  return (bySprint || [])
    .filter((sp) => sp.total > 0)
    .map((sp) => {
      const width = Math.min(sp.total, SPRINT_CELLS_MAX);
      // Rounded down, so a scaled sprint is never drawn full before every story has a commit (#312 review).
      const filled =
        sp.done >= sp.total
          ? width
          : Math.max(0, Math.min(width - 1, Math.floor((sp.done / sp.total) * width)));
      return '▰'.repeat(filled) + '▱'.repeat(width - filled);
    })
    .join('│');
}

// ── The view (build-view-one-story) ──────────────────────────────────────────────────────────────────────
// Top to bottom it answers what is being built, how far it has got, why, what is happening now, what it costs and what
// else is going on (the design approved 2026-10-14, the seed's *The design*). Each fact appears once; a bar is drawn
// only for an amount against a known total. The text is the band's: the mod colours it and never adds a fact (D3).

/** One glyph per meaning, every one single-width (D11: the glyph spec fails a wide or emoji-presentation one). */
export const GLYPHS = Object.freeze({
  Why: '❝',
  Target: '⌖',
  Now: '▸',
  Spend: '$',
  Around: '⋯',
  Next: '→',
  link: '↗',
  flag: '⚑',
  risk: '▲',
});
/** The header's state symbol, by stage (D2). `none` is nothing in flight. */
export const STATE_SYMBOLS = Object.freeze({
  'To groom': '❧',
  Grooming: '❧',
  'Ready to build': '◇',
  Building: '▶',
  QA: '◎',
  Shipped: '✓',
  none: '○',
  unknown: '◌', // the roadmap could not be read: never borrow a stage's symbol for it (#396 review)
});
const WIDTH = 100;
const CONT = ' '.repeat(13);
const ROOM = WIDTH - CONT.length;
const cols = (t) => [...String(t)].length; // every glyph is single-width (D11), so a code point is a column
const clip = (t, n = 56) => (cols(t) > n ? `${[...String(t)].slice(0, Math.max(1, n - 1)).join('')}…` : String(t));
/** `  ❝ Why      <value>` — the glyph, the label padded to 9, then the value at column 13 (D1). */
const field = (label, value) => `  ${GLYPHS[label]} ${label.padEnd(9)}${value}`;
/** A field over as many lines as it needs: the first beside the label, the rest at column 13. */
const fieldLines = (label, text) => wrapWords(text, ROOM, 20).map((l, i) => (i ? `${CONT}${l}` : field(label, l)));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The stage this view draws and whether it is the Locking refinement of Building (live-build-view D11). The extractor's
 * stage when there is one; a shipped README is Shipped whatever the board says (stage.mjs rule 2).
 */
export function stageOf(state) {
  if (state.lifecycle === 'shipped') return { stage: 'Shipped', locking: false };
  const board = STAGES.includes(state.stage) ? state.stage : null;
  // Evidence only advances (D7): with no facts snapshot yet (a fresh worktree, before the first online refresh) the
  // board reads the docs alone, while this branch's own story commits already say more. An idea's commits
  // on its own branch are refining it, not building it.
  const ev = state.evidence || {};
  const commits = state.kind === 'epic' ? ev.story_commits : refiningIdea(state) ? 0 : ev.commits;
  // Story commits only: a PR is known only from live facts, and then the board has already read it (a draft as Building,
  // a ready one as QA — lib/stage.mjs), so a PR lift here could only disagree with it (#396 verifier).
  const evidence = commits > 0 ? 'Building' : null;
  const base = board ?? (refiningIdea(state) ? STAGE_FROM_STATUS[state.seed.status] : STAGE_FROM_STATUS[state.status]) ?? null;
  const stage = evidence && (!base || STAGES.indexOf(evidence) > STAGES.indexOf(base)) ? evidence : base;
  return { stage, locking: !!stage && stageParts({ ...state, stage }).locking };
}
/** An idea (a feature seed) still raw or ready: being refined, whatever its branch carries. */
const refiningIdea = (state) =>
  !!state.seed && state.seed.type === 'feature' && ['raw', 'ready'].includes(state.seed.status);
// With no board row (the extractor could not read the roadmap), the resolver's own status names the stage; a status it
// does not know stays unknown, said as such.
const STAGE_FROM_STATUS = {
  raw: 'To groom',
  ready: 'Grooming',
  Shaping: 'Ready to build',
  'Locking architecture': 'Ready to build',
  Building: 'Building',
  Verifying: 'QA',
  'In review': 'QA',
  Shipped: 'Shipped',
};

/**
 * build-view-one-story D4 — the one place a source is named: a sentence when the docs and the live facts disagree,
 * else null. Four pairs, a spec each.
 */
export function disagreement(state) {
  if (!state.in_flight || state.kind !== 'epic') return null;
  if (state.warning) return state.warning; // (d) a sprint whose frontmatter could not be read
  const commits = state.evidence?.story_commits ?? 0;
  const phase = state.epic?.phase ?? null;
  if (state.lifecycle === 'shipped')
    // (a) — a close-out branch carries no story commit, so it never trips this.
    return commits > 0
      ? `the epic's docs say Shipped, but this branch has ${plural(commits, 'story commit')} not on main`
      : null;
  // (b) — the lock was never stamped, yet stories are being committed.
  if (commits > 0 && !state.epic?.locked_at && [null, 'Shaping', 'Locking architecture'].includes(phase))
    return `the epic's docs say ${phase ?? 'no phase written'}, but this branch has story commits`;
  // (c) — the docs say a sprint shipped while the stage the track DRAWS is still before review. Compared with the drawn
  // stage, never the raw board (#396 verifier: the raw board said Ready under a lifted Building track), and only on
  // facts that can see branches: a docs-only board cannot tell a merged sprint from an unstarted one. Verifying and
  // In review ahead of the board are the cadence (written before the PR opens), not a disagreement.
  const written = state.phase_written;
  const drawn = stageOf(state).stage;
  if (written === 'Shipped' && state.facts_mode !== 'docs' && ['Ready to build', 'Building'].includes(drawn))
    return `${state.sprint ? `sprint ${state.sprint.n}'s` : "the epic's"} docs say Shipped, but the board has it at ${stageWord(drawn)}`;
  return null;
}

/**
 * `<repo> <symbol> <lead> · <title> · <size> · ▲ risk <LEVEL>`, the right part pushed to column 100 (D2). When the whole
 * title and the right part cannot share 100 columns, the right part takes its own line under the header — the band's
 * narrow layout — rather than cutting the title down to a stub; only a title wider than the line itself is clipped.
 * Returns one line or two.
 */
function headerLines({ repo, symbol, lead, title, size, risk, right }) {
  const risky = risk ? `${GLYPHS.risk} risk ${String(risk).toUpperCase()}` : null;
  const build = (t) => [`${repo} ${symbol} ${lead}`, t, size, risky].filter(Boolean).join(' · ');
  const full = build(title || null);
  if (!right) return [cols(full) > WIDTH ? build(clip(title, WIDTH - cols(build(null)) - 3)) : full];
  if (cols(full) + 4 + cols(right) <= WIDTH)
    return [`${full}${' '.repeat(WIDTH - cols(full) - cols(right))}${right}`];
  const left = cols(full) > WIDTH ? build(clip(title, WIDTH - cols(build(null)) - 3)) : full;
  return [left, `  ${right}`];
}

/** `▰▰▱│▱▱▱  2 of 8 stories done` — the header's right part for an epic. */
function storiesRight(progress) {
  const bars = sprintBars(progress.by_sprint);
  const done = `${progress.stories_with_commits ?? 0} of ${progress.stories} stories done`;
  return bars ? `${bars}  ${done}` : done;
}

/** ❝ Why, then ⌖ Target (D5). A seed being refined has a Why and no Target yet. */
function whyTargetLines(target, now, { withTarget = true } = {}) {
  const t = target || {};
  const lines = t.hypothesis ? fieldLines('Why', t.hypothesis) : [];
  if (!withTarget) return lines;
  return [...lines, ...fieldLines('Target', targetValue(t, now))];
}

/** The Target's words (D5): the target, or what we know when there is none, then the verdict and intent match. */
export function targetValue(target, now = new Date()) {
  const t = target || {};
  let head;
  if (t.metric) {
    const read = t.read_date ? `read ${shortDay(t.read_date, now)}` : 'read 30 days after shipping';
    head = `${t.metric}: ${fmtNum(t.from)} → ${fmtNum(t.to)} · ${read}`;
  } else head = t.grounded_reason ? `none yet: ${t.grounded_reason}` : 'none set';
  const tail = [t.verdict && `verdict ${t.verdict}`, Number.isFinite(t.intent_match) && `intent match ${t.intent_match}`];
  return [head, ...tail.filter(Boolean)].join(' · ');
}

/** ▸ Now (D6, D7): what is happening this minute, as a first line and, for a story, its user story. */
function nowLines(state, now) {
  const { story } = state;
  const next = state.next_story?.id ?? null;
  if (state.lifecycle === 'shipped') {
    const day = state.shipped_on ? shortDay(state.shipped_on, now) : null;
    const t = state.target || {};
    const due = readDateOf({ readDate: t.read_date, targetMetric: t.metric, shippedAt: state.shipped_on });
    const after = t.verdict
      ? `verdict ${t.verdict}`
      : due.readDate
        ? `verdict due ${shortDay(due.readDate, now)}`
        : 'no target to read';
    return [field('Now', [day ? `shipped ${day}` : 'shipped', after].join(' · '))];
  }
  if (stageOf(state).locking) return [field('Now', `locking the architecture${next ? ` · ${next} next` : ''}`)];
  if (story && state.between)
    return [field('Now', `between stories: ${story.id} done, ${next ? `${next} next` : 'every story has a commit'}`)];
  if (story) {
    const said = story.as_a && story.i_want && story.so_that;
    return [
      field('Now', `${story.id}${story.title ? ` ${story.title}` : ''}`),
      ...wrapWords(
        said
          ? `As ${story.as_a}, I want ${story.i_want}, so that ${story.so_that}.`
          : `(the docs carry no user story for ${story.id})`,
        ROOM,
        20
      ).map((l) => `${CONT}${l}`),
    ];
  }
  const note = state.story_note || 'no story started yet';
  return [field('Now', note === 'no story started yet' && next ? `${note} · ${next} next` : note)];
}

/** ⋯ Around and → Next (D8): everything else on the board, then — with nothing in flight — the next command. */
function aroundLines(state) {
  const b = state.board;
  const wts = state.elsewhere?.worktrees ?? [];
  const counts = b
    ? [b.building && `${b.building} building`, b.qa && `${b.qa} in QA`, b.ready && `${b.ready} ready`].filter(Boolean)
    : [];
  const next = b?.next ?? null;
  const command = !state.in_flight && next?.grain === 'Epic';
  const upNext = next && !command ? `next up: ${clip(next.name, 40)}${next.build_order !== null ? ` (#${next.build_order})` : ''}` : null;
  const first = [...counts, upNext].filter(Boolean);
  const items = wts.map((w) => `${clip(w.title, 48)}${w.story || w.status ? ` (${[w.story, w.status].filter(Boolean).join(', ')})` : ''}`);
  const shown = items.length > MAX_ELSEWHERE_LINES ? [...items.slice(0, MAX_ELSEWHERE_LINES - 1), `+${items.length - MAX_ELSEWHERE_LINES + 1} more`] : items;
  const lines = [];
  if (first.length || shown.length || b) {
    const head = first.length ? first.join(' · ') : shown.length ? null : 'nothing else on the board';
    const there = shown.length ? wrapWords(`in other worktrees: ${shown.join(' · ')}`, ROOM, 20) : [];
    const all = [...(head ? [head] : []), ...there];
    lines.push(...all.map((l, i) => (i ? `${CONT}${l}` : field('Around', l))));
  }
  if (command) lines.push(field('Next', `/build ${next.slug}   (top of the ready list)`));
  return lines;
}

/** The view as the CLI and the band show it — a pure function of resolveBuildState's output (D1). */
export function renderLines(state, now = new Date()) {
  const repo = state.repo || 'this repo';
  const link = (target) => (target ? [`  ${GLYPHS.link} ${target}`] : []);
  if (!state.in_flight) {
    const where = state.where ?? state.branch ?? null;
    return [
      `${repo} ${STATE_SYMBOLS.none} No epic on this branch${where ? ` · ${where}` : ''}`,
      ...link(state.board?.url),
      ...(state.quiet || state.where ? [] : [field('Now', state.reason)]),
      ...aroundLines(state),
    ];
  }
  const { stage, locking } = stageOf(state);
  const track = stage ? `  ${stageTrack(stage, locking)}` : '  stage unknown: the board could not be read';
  const flag = disagreement(state);
  const flagged = flag ? [`  ${GLYPHS.flag} ${flag}`] : [];
  const symbol = STATE_SYMBOLS[stage] ?? STATE_SYMBOLS.unknown;
  if (state.seed) {
    const { seed } = state;
    const refining = refiningIdea(state);
    const lead = seed.type === 'feature' ? 'Idea' : seed.type.charAt(0).toUpperCase() + seed.type.slice(1);
    const commits = state.evidence?.commits ?? 0;
    const now_ =
      seed.status === 'raw' && refining
        ? 'shaping the plan'
        : seed.status === 'ready' && refining
          ? 'plan ready, waiting for your approval'
          : commits
            ? `${plural(commits, 'commit')} on this branch`
            : 'no commits on this branch yet';
    return [
      ...headerLines({
        repo,
        symbol,
        lead,
        title: seed.title,
        size: seed.appetite,
        risk: seed.risk,
        right: seed.quote ? `quote $${seed.quote.low}–${seed.quote.high}` : null,
      }),
      track,
      ...flagged,
      ...link(seed.path),
      // A seed shows a Target only when it says something (a bug or a chore has none to read).
      ...whyTargetLines(state.target, now, {
        withTarget: !refining && !!(state.target?.metric || state.target?.grounded_reason),
      }),
      field('Now', now_),
      ...aroundLines(state),
    ];
  }
  const { epic, progress } = state;
  const n = progress.header_sprint ?? progress.sprint;
  return [
    ...headerLines({
      repo,
      symbol,
      lead: `Sprint ${n ?? '?'} of ${progress.sprints}`,
      title: epic.title,
      size: state.size,
      risk: epic.risk,
      right: storiesRight(progress),
    }),
    track,
    ...flagged,
    ...link(state.board?.url ?? epic.path),
    ...whyTargetLines(state.target, now),
    ...nowLines(state, now),
    ...(state.spend ? [field('Spend', spendValue(state.spend, state.quote ?? null))] : []),
    ...aroundLines(state),
  ];
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--repo-root');
  if (i !== -1 && (!argv[i + 1] || argv[i + 1].startsWith('--'))) {
    process.stderr.write('build-state: --repo-root needs a directory\n');
    process.exit(2);
  }
  const root = resolve(i === -1 ? join(__dirname, '..') : argv[i + 1]);
  const state = resolveBuildState({ root, offline: argv.includes('--offline') });
  if (argv.includes('--json'))
    process.stdout.write(`${JSON.stringify({ ...state, lines: renderLines(state) }, null, 2)}\n`);
  else process.stdout.write(`${renderLines(state).join('\n')}\n`);
}
