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
import { dirname, join, resolve } from 'node:path';
import { PHASES, parseDocFrontmatter } from './lib/roadmap-contract.mjs';
import { parseJournal, JOURNAL_BRANCH, JOURNAL_PATH } from './lib/session-journal.mjs';
import { branchCandidates, parseBranch } from './lib/work-branch.mjs';

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
    lifecycle: readme.data.status ?? null,
    contract: readme.hasFrontmatter && !readme.error && 'phase' in readme.data,
    sprints,
  };
}

const unquoteNull = (v) => (v === null || v === undefined || v === 'null' || v === '' ? null : v);

function readSeed(root, slug) {
  const path = join(root, ...SEEDS_DIR, `${slug}.md`);
  if (!existsSync(path)) return null;
  const p = parseDocFrontmatter(readFileSync(path, 'utf8'));
  if (!p.hasFrontmatter) return null;
  const d = p.data;
  return {
    slug,
    title: d.title ?? slug,
    type: TYPES_KNOWN.includes(d.type) ? d.type : 'chore',
    appetite: unquoteNull(d.appetite),
    risk: unquoteNull(d.risk),
    status: unquoteNull(d.status),
    epic: unquoteNull(d.epic),
    path: `${SEEDS_DIR.join('/')}/${slug}.md`,
  };
}
const TYPES_KNOWN = ['feature', 'spike', 'bug', 'chore'];

/**
 * What the branch names, longest reading first: an epic, else a seed (a seed that carries `epic:` is that
 * epic — once scaffolded the seed is funnel-only), else null.
 */
function resolveTarget(root, branch) {
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

function ghOpenPr(root, branch) {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url', '--limit', '1'],
      { cwd: root, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const [pr] = JSON.parse(out);
    return { ok: true, pr: pr || null };
  } catch {
    return { ok: false, pr: null };
  }
}

const notInFlight = (reason, extra = {}) => ({ in_flight: false, reason, ...extra });

/** Does `text` name `slug` as a whole slug — `aws` in "aws S1.1", but not inside "aws-s3 S1.1"? */
export function namesSlug(text, slug) {
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9-])${esc}($|[^A-Za-z0-9-])`).test(String(text));
}

/**
 * Resolve the build state. Every external read is injectable so the tests drive real fixture repos with
 * a fake `gh`: { root, offline, git, gh }. It NEVER throws — it runs once per turn inside a CLI hook, and
 * an exception there is a blank view: any failure is reported as "not in flight", with the reason.
 * `elsewhere: false` skips the other-worktrees / open-epics scan (used when resolving those worktrees).
 */
export function resolveBuildState(opts = {}) {
  let state;
  try {
    state = resolve_(opts);
  } catch (err) {
    state = notInFlight(
      `the resolver could not read this checkout (${err && err.message ? err.message : err})`
    );
  }
  if (opts.elsewhere === false) return state;
  try {
    state.elsewhere = elsewhere_({ root: opts.root, git: opts.git || makeGit(opts.root), state });
  } catch {
    state.elsewhere = { worktrees: [], open_epics: [] };
  }
  return state;
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
    const s = resolveBuildState({ root: w.path, offline: true, elsewhere: false });
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
    },
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

function resolve_({ root, offline = false, git = makeGit(root), gh = ghOpenPr } = {}) {
  if (tryGit(git, ['rev-parse', '--is-inside-work-tree']) !== 'true')
    return notInFlight('not inside a git checkout (or git is not installed)');
  const branch = tryGit(git, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (!branch) return notInFlight('detached HEAD — no branch, so no epic in flight');
  const cands = branchCandidates(branch);
  if (!cands.length)
    return notInFlight(`on ${branch} — not an epic branch (feat/<slug>…), so no epic in flight`, { branch });
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
        ? `commits here name ${foreign.join(', ')} — none of them ${scope}'s; no journal entry names one either`
        : `no commit on this branch names a story of ${scope}, and the session journal names none either`;

  // The sprint: the story's, else the branch's -s<N>, else none — never "the first unshipped one".
  const sprintN = story ? story.sprint : parsed.sprint;
  const sprint = epic.sprints.find((s) => s.n === sprintN) || null;
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
    lifecycle: epic.lifecycle,
    epic: {
      slug: epic.slug,
      title: epic.title,
      area: epic.area,
      risk: epic.risk,
      phase: epic.phase,
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
    progress: {
      story: story ? story.ordinal : null,
      stories: allStories.length,
      sprint: sprint ? epic.sprints.indexOf(sprint) + 1 : null,
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

const HEADINGS = {
  bug: 'Currently fixing',
  chore: 'Currently on a chore',
  spike: 'Currently investigating',
  feature: 'Currently shaping',
};
const clip = (t, n = 56) => (String(t).length > n ? `${String(t).slice(0, n - 1)}…` : String(t));

/** One line per piece of work elsewhere, worktrees first, capped — the JSON carries the full lists. */
function elsewhereLines(state, pad) {
  const e = state.elsewhere || { worktrees: [], open_epics: [] };
  const items = [
    ...e.worktrees.map(
      (w) =>
        `${pad('Worktree')}${clip(w.title)}${w.story ? ` · ${w.story}` : ''}${w.status ? ` · ${w.status}` : ''} · ${w.branch}`
    ),
    ...e.open_epics.map((o) => `${pad('Open')}${clip(o.title)}${o.phase ? ` · ${o.phase}` : ''} · ${o.area}`),
  ];
  if (items.length <= MAX_ELSEWHERE_LINES) return items;
  const shown = items.slice(0, MAX_ELSEWHERE_LINES - 1);
  return [...shown, `${pad('')}+${items.length - shown.length} more — node scripts/build-state.mjs --json`];
}

/**
 * The build view as the CLI shows it — a pure function of resolveBuildState's output (Sprint 4's mod
 * renders exactly these lines and nothing else: D3). Five lines under the heading for an epic, no box;
 * work in other worktrees appears as one `Also` line when this checkout is building, and as the list
 * itself when it isn't.
 */
export function renderLines(state) {
  const pad = (label) => `  ${label.padEnd(9)}`;
  if (!state.in_flight) return [`No epic in flight — ${state.reason}`, ...elsewhereLines(state, pad)];
  const others = state.elsewhere?.worktrees?.length || 0;
  const also = others
    ? [
        `${pad('Also')}${others} more in other worktrees: ${state.elsewhere.worktrees.map((w) => w.branch).join(', ')}`,
      ]
    : [];
  if (state.seed) {
    const { seed } = state;
    const meta = [
      seed.appetite && `appetite ${seed.appetite}`,
      seed.risk && `risk ${String(seed.risk).toUpperCase()}`,
    ]
      .filter(Boolean)
      .join(' · ');
    const label = seed.type.charAt(0).toUpperCase() + seed.type.slice(1);
    return [
      HEADINGS[seed.type] || 'Currently working on',
      `${pad(label)}${seed.title}${meta ? `    ${meta}` : ''}`,
      `${pad('Seed')}${seed.path}`,
      `${pad('Status')}${state.status || 'unknown'}`,
      ...also,
    ];
  }
  const { epic, story, progress } = state;
  const cont = ' '.repeat(11);
  const risk = epic.risk ? ` · risk ${epic.risk.toUpperCase()}` : '';
  const lines = ['Currently building', `${pad('Epic')}${epic.title}    ${epic.area}${risk}`];
  if (story) {
    lines.push(`${pad('Story')}${story.id}${story.title ? ` — ${story.title}` : ''}`);
    lines.push(
      story.as_a && story.i_want && story.so_that
        ? `${cont}As ${story.as_a}, I want ${story.i_want}, so that ${story.so_that}.`
        : `${cont}(the docs carry no user story for ${story.id})`
    );
  } else {
    lines.push(`${pad('Story')}unknown`);
    lines.push(`${cont}${state.story_note}`);
  }
  const storyPart = `Story ${progress.story ?? '?'} of ${progress.stories}`;
  const sprintPart = `Sprint ${progress.sprint ?? '?'} of ${progress.sprints}`;
  lines.push(`${pad('Progress')}${storyPart} · ${sprintPart}`);
  lines.push(`${pad('Status')}${state.status || `unknown${state.warning ? ` — ${state.warning}` : ''}`}`);
  return [...lines, ...also];
}

// realpath on both sides: a plugin or checkout reached through a symlink (macOS /tmp → /private/tmp) would
// otherwise never equal the module URL, and the CLI would print nothing and exit 0 — a blank build view.
const isMain = (() => {
  try {
    return (
      !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (isMain) {
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
