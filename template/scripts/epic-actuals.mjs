#!/usr/bin/env node
// epic-actuals.mjs — what each epic consumed, measured from this machine's Claude Code transcripts (finops S1).
//
//   node scripts/epic-actuals.mjs --epic <slug> [--json]   # one epic: sessions, tokens by kind/model/skill, ≈ API $
//   node scripts/epic-actuals.mjs --refresh [--json]       # update the index + summary only (what the band's mod runs)
//   node scripts/epic-actuals.mjs --backfill [--write]     # every shipped epic: measured, or why not; --write stamps
//   node scripts/epic-actuals.mjs --epic <slug> --write    # stamp actual_* into that epic's README (at close)
//   node scripts/epic-actuals.mjs --push                   # send changed sessions to the engine (opt-in: spend.telemetry)
//   options: --repo-root <dir> (default: the project) · --projects-dir <dir> (default: ~/.claude/projects)
//
// ── Where the numbers come from (README § Architecture lock) ────────────────────────────────────────
// Claude Code writes every turn to `~/.claude/projects/<dir>/<session>.jsonl`, subagents to
// `<dir>/<session>/subagents/agent-*.jsonl` (D14). Each assistant entry carries `message.id`, `message.model`,
// `message.usage`, `cwd`, `gitBranch`, `sessionId` and sometimes `attributionSkill`. So no hook, receiver or
// credential is needed: the record already exists.
//   • D15 — an entry is THIS repo's when its cwd is the repo, under it, or under one of its worktrees.
//   • D13 — one message is written as several entries (one per content block; the last carries the final
//     output_tokens), and a resumed session copies earlier entries into a new file re-stamped with the NEW
//     branch. So: one record per message id; its counts are the entry with the most output tokens; its
//     attribution is the FIRST occurrence indexed (files are first read oldest-born first).
//   • D16 — branch → epic is build-state.mjs's own resolveTarget(). Anything it does not name — main, a fix
//     branch with no epic — is `unattributed`, reported by branch (D11), never guessed.
//   • C14 — `gitBranch` is the branch of the session's OWN checkout. A session sitting on epic A that builds epic B
//     in another directory is counted as A. So build an epic from a session on its branch, or in a worktree on it.
//   • D4 — unknown is not zero: an unpriceable turn keeps its tokens and makes the $ a lower bound (`usd_known:
//     false`); an entry missing a field the count needs is skipped and counted in `skipped`.
//   • D9 — metrics only. Nothing here reads, stores or prints message content; a spec pins every output key.
//
// The index (D19) lives in the MAIN checkout's `.golden-frijoles/` so every worktree reads one summary, and it is
// incremental: per transcript file it remembers how far it read. Aggregates outlive the transcripts — Claude Code
// deletes old ones, the index keeps what it already counted.
//
// Zero deps — Node 18+.

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTarget } from './build-state.mjs';
import { buildRows } from './roadmap-extract.mjs';
import { projectRoot } from './lib/project-root.mjs';
import { parseDocFrontmatter } from './lib/roadmap-contract.mjs';
import { stampFrontmatter } from './lib/frontmatter-stamp.mjs';

export { stampFrontmatter };
import { needSetting } from './lib/config.mjs';
import { apiKeyFrom } from './roadmap-push.mjs';
import { PRICES_AS_OF, PRICES_SOURCE, TOKEN_KINDS, tokensOf, usdOf } from './lib/model-prices.mjs';

export const INDEX_VERSION = 1;
export const STATE_DIR = '.golden-frijoles';
export const INDEX_FILE = 'usage-index.json';
export const SUMMARY_FILE = 'usage-summary.json';
export const MACHINE = 'this machine';
/** D12 — the agents whose passes this does not see. Named, so a reader never takes "Claude Code" for "everything". */
export const NOT_MEASURED = Object.freeze(['codex', 'agy', 'vibe', 'devin']);
export const NO_SKILL = '(no skill)';
/** How long `--refresh` reads before saving and stopping (the mod's timeout is 10 s — D24). */
export const REFRESH_BUDGET_MS = 6_000;

// The same rule build-state.mjs applies: a git run from a hook must describe --repo-root, never an inherited GIT_DIR.
const GIT_ENV_TO_CLEAR = [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
];
function git(root, args) {
  const env = { ...process.env };
  for (const k of GIT_ENV_TO_CLEAR) delete env[k];
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    }).trim();
  } catch {
    return null;
  }
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// ── Where things are ────────────────────────────────────────────────────────────────────────────────

/** The transcripts folder: `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function defaultProjectsDir(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

/** D19 — the MAIN checkout (the parent of git's common dir), so every worktree shares one index. */
export function mainCheckout(root) {
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return root;
  return basename(common) === '.git' ? dirname(common) : root;
}

/** D15 — the paths an entry's cwd must sit in: the repo, its main checkout and every listed worktree. */
export function repoPaths(root) {
  const out = new Set([real(root), real(mainCheckout(root))]);
  const list = git(root, ['worktree', 'list', '--porcelain']) || '';
  for (const line of list.split('\n')) if (line.startsWith('worktree ')) out.add(real(line.slice(9)));
  return [...out];
}

/** Is `cwd` one of `paths`, or under one? A sibling that merely shares a prefix (`repo-old`) is not. */
export function inRepo(cwd, paths) {
  if (typeof cwd !== 'string' || !cwd) return false;
  const c = real(cwd);
  return paths.some((p) => c === p || c.startsWith(p.endsWith(sep) ? p : p + sep));
}

/**
 * Claude Code's folder name for a session started in `path`: every character other than a letter, digit or `-`
 * becomes `-` (`/Users/me/repo` → `-Users-me-repo`, `/r/.claude/worktrees/x` → `-r--claude-worktrees-x`).
 */
export function projectDirName(path) {
  return String(path).replace(/[^A-Za-z0-9-]/g, '-');
}

/**
 * D15 (amended, C15) — the folders Claude Code keeps for this repo and its worktrees. A transcript in one of them is
 * this repo's whatever `cwd` it recorded: when a checkout MOVES, Claude Code moves its folder but the entries keep the
 * old path (this repo: 24k entries under ~/dobby/golden-beans, recorded before the 2026-09-29 folder move).
 */
export function ownProjectDirs(paths) {
  return new Set(paths.map(projectDirName));
}

/** The project folder a transcript file lives in (`<projects>/<dir>/…`). */
export function projectDirOf(file, projectsDir) {
  const rel = file.slice(projectsDir.length).replace(/^[\\/]+/, '');
  return rel.split(/[\\/]/)[0];
}

/** D14 — every transcript file: `<dir>/*.jsonl` and `<dir>/<session>/subagents/*.jsonl`. */
export function listTranscripts(projectsDir) {
  const files = [];
  let dirs = [];
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return files;
  }
  for (const d of dirs) {
    const dir = join(projectsDir, d.name);
    let names = [];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const n of names) {
      if (n.isFile() && n.name.endsWith('.jsonl')) files.push(join(dir, n.name));
      else if (n.isDirectory()) {
        const sub = join(dir, n.name, 'subagents');
        let subs = [];
        try {
          subs = readdirSync(sub);
        } catch {
          continue;
        }
        for (const f of subs) if (f.endsWith('.jsonl')) files.push(join(sub, f));
      }
    }
  }
  return files;
}

// ── One transcript line ─────────────────────────────────────────────────────────────────────────────

/**
 * One transcript line → `{ record }`, `{ skip: reason }` or null (not an assistant turn — most lines). The record holds
 * metrics and ids ONLY (D9): it is built field by field, never by copying the entry.
 */
export function readEntry(line) {
  if (!line.includes('"assistant"')) return null;
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return { skip: 'unparseable' };
  }
  if (!d || d.type !== 'assistant') return null;
  const m = d.message && typeof d.message === 'object' ? d.message : null;
  if (!m) return { skip: 'no_message' };
  const id = (typeof m.id === 'string' && m.id) || (typeof d.requestId === 'string' && d.requestId) || null;
  if (!id) return { skip: 'no_id' };
  if (m.model === '<synthetic>') return { skip: 'synthetic', cwd: d.cwd };
  if (!m.usage || typeof m.usage !== 'object') return { skip: 'no_usage', cwd: d.cwd };
  if (typeof m.model !== 'string' || !m.model) return { skip: 'no_model', cwd: d.cwd };
  if (typeof d.cwd !== 'string' || !d.cwd) return { skip: 'no_cwd' };
  return {
    record: {
      id,
      session: typeof d.sessionId === 'string' ? d.sessionId : null,
      branch: typeof d.gitBranch === 'string' && d.gitBranch ? d.gitBranch : null,
      cwd: d.cwd,
      skill: typeof d.attributionSkill === 'string' && d.attributionSkill ? d.attributionSkill : null,
      model: m.model,
      at: typeof d.timestamp === 'string' ? d.timestamp : null,
      speed: m.usage.speed === 'fast' ? 'fast' : 'standard',
      geo: m.usage.inference_geo === 'us' ? 'us' : null,
      tokens: tokensOf(m.usage),
    },
  };
}

// ── The index ───────────────────────────────────────────────────────────────────────────────────────
// messages[id] = [session, branch, skill, model, at, speed, geo, input, output, cache_read, w5, w1]
// (compact on purpose: ~20k records). The cwd is checked at read time and not stored — every stored record is
// this repo's.

const T0 = 7; // first token column
export function emptyIndex() {
  return { version: INDEX_VERSION, files: {}, messages: {}, skipped: {} };
}

function packRecord(r) {
  const t = r.tokens;
  return [
    r.session,
    r.branch,
    r.skill,
    r.model,
    r.at,
    r.speed,
    r.geo,
    t.input,
    t.output,
    t.cache_read,
    t.cache_write_5m,
    t.cache_write_1h,
  ];
}

/** D13 — the first occurrence owns the attribution; a later one may only raise the counts (the final streamed write). */
export function mergeRecord(index, r) {
  const prev = index.messages[r.id];
  if (!prev) {
    index.messages[r.id] = packRecord(r);
    return 'added';
  }
  if (r.tokens.output > prev[T0 + 1]) {
    const t = r.tokens;
    prev.splice(T0, 5, t.input, t.output, t.cache_read, t.cache_write_5m, t.cache_write_1h);
    return 'raised';
  }
  return 'same';
}

/** The bytes of `path` from `offset` to its last complete line. */
function readFrom(path, offset, size) {
  const len = size - offset;
  if (len <= 0) return { text: '', end: offset };
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) return { text: '', end: offset };
    return { text: buf.subarray(0, lastNl + 1).toString('utf8'), end: offset + lastNl + 1 };
  } finally {
    closeSync(fd);
  }
}

/**
 * Bring the index up to date: read only the bytes each transcript gained since the last run. A file that SHRANK
 * (rewritten) is read again from the start — harmless, records are keyed by message id. Files are taken oldest-born
 * first so an original session is indexed before a resumed copy of it (D13). Returns what changed.
 */
export function updateIndex(
  index,
  { projectsDir, paths, stat = statSync, deadline = Infinity, now = Date.now }
) {
  const own = ownProjectDirs(paths);
  const files = listTranscripts(projectsDir)
    .map((path) => {
      try {
        const s = stat(path);
        return { path, size: s.size, mtimeMs: s.mtimeMs, born: s.birthtimeMs || s.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.born - b.born || (a.path < b.path ? -1 : 1));
  const changes = { files_read: 0, added: 0, raised: 0, complete: true };
  for (const f of files) {
    // A time budget (the mod's run is timeout-bound): stop BETWEEN files, so every file recorded is fully read and the
    // next run resumes where this one stopped. A first scan on a slow machine then completes over a few runs instead of
    // starting from zero every time and never saving (fresh review, #230).
    // At least ONE file per run, by construction: listing and stat-ing every transcript happens inside the budget, so
    // checking before the first file could let a slow listing read nothing, forever (round-2 review, #230).
    if (changes.files_read > 0 && now() > deadline) {
      changes.complete = false;
      break;
    }
    const known = index.files[f.path];
    if (known && known.size === f.size && known.mtimeMs === f.mtimeMs) continue;
    const from = known && f.size >= known.offset ? known.offset : 0;
    const { text, end } = readFrom(f.path, from, f.size);
    changes.files_read++;
    const ownFolder = own.has(projectDirOf(f.path, projectsDir));
    for (const line of text.split('\n')) {
      if (!line) continue;
      const e = readEntry(line);
      if (!e) continue;
      if (e.skip) {
        // Counted only when it is THIS repo's (its folder, or its cwd when the entry still has one) — another
        // project's skips are not this summary's business. A line too broken to say counts only in our own folder.
        if (ownFolder || inRepo(e.cwd, paths)) index.skipped[e.skip] = (index.skipped[e.skip] || 0) + 1;
        continue;
      }
      if (!ownFolder && !inRepo(e.record.cwd, paths)) continue;
      const how = mergeRecord(index, e.record);
      if (how !== 'same') changes[how]++;
    }
    index.files[f.path] = { size: f.size, mtimeMs: f.mtimeMs, offset: end };
  }
  return changes;
}

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Atomic: a second session writing at the same instant leaves one whole file, never a torn one. */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const ignore = join(dirname(path), '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}

export function loadIndex(file) {
  const idx = readJson(file, null);
  return idx && idx.version === INDEX_VERSION && idx.messages && idx.files ? idx : emptyIndex();
}

// ── Totals ──────────────────────────────────────────────────────────────────────────────────────────

const zeroTokens = () => Object.fromEntries(TOKEN_KINDS.map((k) => [k, 0]));
const totalTokens = (t) => TOKEN_KINDS.reduce((a, k) => a + (t[k] || 0), 0);

function newBucket() {
  return {
    usd: 0,
    usd_known: true,
    tokens: zeroTokens(),
    sessions: new Set(),
    first_at: null,
    last_at: null,
  };
}

function addTo(bucket, rec) {
  const [session, , , , at] = rec;
  const t = tokensFromRecord(rec);
  for (const k of TOKEN_KINDS) bucket.tokens[k] += t[k];
  const usd = usdOf(rec[3], t, { speed: rec[5], inferenceGeo: rec[6] });
  if (usd === null) bucket.usd_known = false;
  else bucket.usd += usd;
  if (session) bucket.sessions.add(session);
  if (at && (!bucket.first_at || at < bucket.first_at)) bucket.first_at = at;
  if (at && (!bucket.last_at || at > bucket.last_at)) bucket.last_at = at;
}

function tokensFromRecord(rec) {
  return {
    input: rec[T0],
    output: rec[T0 + 1],
    cache_read: rec[T0 + 2],
    cache_write_5m: rec[T0 + 3],
    cache_write_1h: rec[T0 + 4],
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
const mtok = (t) => Math.round(totalTokens(t) / 1e5) / 10;

function finish(b) {
  return {
    usd: round2(b.usd),
    usd_known: b.usd_known,
    tokens: b.tokens,
    mtok: mtok(b.tokens),
    sessions: b.sessions.size,
    first_at: b.first_at,
    last_at: b.last_at,
  };
}

/**
 * The index → per-epic totals (and the unattributed rest, by branch). `epicOf(branch)` is the D16 resolution —
 * injected so a spec can drive it without a Roadmap on disk.
 */
export function summarize(index, { epicOf, now = new Date() }) {
  const epics = new Map();
  const unattributed = new Map();
  const cache = new Map();
  const resolveBranch = (b) => {
    if (!b) return null;
    if (!cache.has(b)) cache.set(b, epicOf(b));
    return cache.get(b);
  };
  for (const rec of Object.values(index.messages)) {
    const epic = resolveBranch(rec[1]);
    if (!epic) {
      const key = rec[1] || '(no branch)';
      if (!unattributed.has(key)) unattributed.set(key, newBucket());
      addTo(unattributed.get(key), rec);
      continue;
    }
    if (!epics.has(epic))
      epics.set(epic, { all: newBucket(), models: new Map(), skills: new Map(), branches: new Set() });
    const e = epics.get(epic);
    addTo(e.all, rec);
    e.branches.add(rec[1]);
    const model = rec[3];
    if (!e.models.has(model)) e.models.set(model, newBucket());
    addTo(e.models.get(model), rec);
    const skill = rec[2] || NO_SKILL;
    if (!e.skills.has(skill)) e.skills.set(skill, newBucket());
    addTo(e.skills.get(skill), rec);
  }
  const part = (b) => {
    const f = finish(b);
    return { usd: f.usd, usd_known: f.usd_known, mtok: f.mtok, tokens: f.tokens };
  };
  const out = {};
  for (const [slug, e] of [...epics].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    out[slug] = {
      ...finish(e.all),
      branches: [...e.branches].sort(),
      by_model: Object.fromEntries([...e.models].map(([k, b]) => [k, part(b)])),
      by_skill: Object.fromEntries([...e.skills].map(([k, b]) => [k, part(b)])),
    };
  }
  let oldest = null;
  for (const rec of Object.values(index.messages))
    if (rec[4] && (!oldest || rec[4] < oldest)) oldest = rec[4];
  return {
    generated_at: now.toISOString(),
    basis: MACHINE,
    oldest_at: oldest,
    prices_as_of: PRICES_AS_OF,
    prices_source: PRICES_SOURCE,
    not_measured: [...NOT_MEASURED],
    epics: out,
    unattributed: Object.fromEntries(
      [...unattributed].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, b]) => [k, finish(b)])
    ),
    skipped: { ...index.skipped },
  };
}

/** D16 — the epic slug a branch names in `root`'s Roadmap, or null. */
export function epicOfBranch(root) {
  return (branch) => {
    try {
      const t = resolveTarget(root, branch);
      return t && t.kind === 'epic' ? t.epic.slug : null;
    } catch {
      return null;
    }
  };
}

/** Refresh index + summary under the main checkout's `.golden-frijoles/`. Returns { summary, changes, dir }. */
export async function refresh({
  root,
  projectsDir = defaultProjectsDir(),
  now = new Date(),
  budgetMs = Infinity,
  push = false,
  throttle = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  const dir = join(mainCheckout(root), STATE_DIR);
  const indexPath = join(dir, INDEX_FILE);
  const index = loadIndex(indexPath);
  const changes = updateIndex(index, {
    projectsDir,
    paths: repoPaths(root),
    deadline: Date.now() + budgetMs,
  });
  // The push runs only on a COMPLETE scan: a partial index would send understated snapshots (finops D24).
  const pushed =
    push && changes.complete
      ? await pushUsage({ root, index, epicOf: epicOfBranch(root), env, fetchImpl, throttle })
      : null;
  const summary = {
    ...summarize(index, { epicOf: epicOfBranch(root), now }),
    complete: changes.complete,
    pushed_at: Number.isFinite(index.pushed_at) ? new Date(index.pushed_at).toISOString() : null,
    // Refusals since the last clean push — 0 once a later push went through with none.
    push_rejected:
      Number.isFinite(index.push_rejected_at) && !(index.push_clean_at > index.push_rejected_at)
        ? (index.push_rejected ?? 0)
        : 0,
  };
  // A push that TRIED the network changed the index (attempt time, 409/400 marks) even when no transcript moved — an
  // idle machine must persist its backoff, or it retries every minute and re-sends what was refused (round 2, #232).
  const triedNetwork = pushed && !/^(off|throttled|no ingest key|config unreadable)/.test(pushed.reason);
  if (changes.files_read || triedNetwork || !existsSync(indexPath)) writeJson(indexPath, index);
  writeJson(join(dir, SUMMARY_FILE), summary);
  return { summary, changes, dir, pushed };
}

/** One epic's report — the `--epic <slug> --json` shape (a spec pins the key set, D9). */
export function epicReport(summary, slug) {
  const e = summary.epics[slug];
  return {
    epic: slug,
    measured: !!e,
    basis: summary.basis,
    sessions: e ? e.sessions : 0,
    tokens: e ? e.tokens : zeroTokens(),
    mtok: e ? e.mtok : 0,
    usd: e ? e.usd : null,
    usd_known: e ? e.usd_known : true,
    first_at: e ? e.first_at : null,
    last_at: e ? e.last_at : null,
    branches: e ? e.branches : [],
    by_model: e ? e.by_model : {},
    by_skill: e ? e.by_skill : {},
    skipped: summary.skipped,
    prices_as_of: summary.prices_as_of,
    prices_source: summary.prices_source,
    not_measured: summary.not_measured,
    pushed_at: summary.pushed_at ?? null,
  };
}

/** `≈$38.42` / `≥$38.42` (a lower bound: some turns could not be priced — D4). */
export function usdText(usd, known) {
  return `${known ? '≈' : '≥'}$${usd >= 100 ? Math.round(usd) : usd.toFixed(2)}`;
}

// ── The engine push (finops S3.1, D21–D24) ────────────────────────────────────────────────────────────
// OPT-IN: nothing leaves this machine unless `spend.telemetry` is `on` (golden-frijoles.config.json; unset = off).
// One `$agent_usage` event per (session, epic) on the EXISTING `POST /api/v1/track`, with the project's ingest key —
// the same one the roadmap push reads (`apiKeyFrom`), so the engine resolves the project from the key and nothing in
// the body names one (D23). Each event is a cumulative snapshot; the engine keeps the latest per (session, epic)
// (D22), and the idempotency key makes an unchanged re-push a no-op. Metrics only: the payload is built field by
// field from the index, which never held content (D9).

export const AGENT_USAGE_EVENT = '$agent_usage';
export const PUSH_EVERY_MS = 10 * 60_000;
export const PUSH_BUDGET_MS = 5_000;

const part = () => ({ tokens: zeroTokens(), usd: 0 });
function addPart(p, t, usd) {
  for (const k of TOKEN_KINDS) p.tokens[k] += t[k];
  if (usd === null || p.usd === null) p.usd = null;
  else p.usd += usd;
}

/**
 * The index → one snapshot per (session, epic): the exact `$agent_usage` payload (the engine's lib/agent-usage.ts
 * AGENT_USAGE_KEYS). Unattributed turns are never pushed — there is no epic to put them on (D11).
 */
export function sessionSnapshots(index, { epicOf }) {
  const out = new Map();
  for (const rec of Object.values(index.messages)) {
    const [session, branch, skill, model, at, speed, geo] = rec;
    const epic = branch ? epicOf(branch) : null;
    if (!epic || !session || !at) continue;
    const key = `${session}|${epic}`;
    if (!out.has(key))
      out.set(key, {
        session_id: session,
        epic,
        branch,
        model_breakdown: {},
        skill_breakdown: {},
        tokens_by_kind: zeroTokens(),
        usd_estimate: 0,
        price_table_date: PRICES_AS_OF,
        first_at: at,
        last_at: at,
      });
    const s = out.get(key);
    const t = tokensFromRecord(rec);
    const usd = usdOf(model, t, { speed, inferenceGeo: geo });
    for (const k of TOKEN_KINDS) s.tokens_by_kind[k] += t[k];
    if (usd !== null) s.usd_estimate += usd;
    s.model_breakdown[model] ??= part();
    addPart(s.model_breakdown[model], t, usd);
    const sk = skill || NO_SKILL;
    s.skill_breakdown[sk] ??= part();
    addPart(s.skill_breakdown[sk], t, usd);
    if (at < s.first_at) s.first_at = at;
    if (at > s.last_at) {
      s.last_at = at;
      s.branch = branch;
    }
  }
  const r = (p) => ({ tokens: p.tokens, usd: p.usd === null ? null : round2(p.usd) });
  return [...out.values()].map((s) => ({
    ...s,
    usd_estimate: round2(s.usd_estimate),
    model_breakdown: Object.fromEntries(Object.entries(s.model_breakdown).map(([k, p]) => [k, r(p)])),
    skill_breakdown: Object.fromEntries(Object.entries(s.skill_breakdown).map(([k, p]) => [k, r(p)])),
    // The engine wants ISO-8601 UTC with exactly milliseconds and a `Z`; the transcript writes that shape, copied as is.
    first_at: s.first_at,
    last_at: s.last_at,
  }));
}

/**
 * Push every snapshot that changed since the last push. Returns { sent, rejected, reason }. Never throws: a failure is a
 * reason, and the snapshots it did not send go next time. `index.pushed` remembers what each (session, epic) last sent.
 */
export async function pushUsage({
  root,
  index,
  epicOf,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  throttle = false,
}) {
  // Never throws (fresh review, #232): a malformed golden-frijoles.config.json must not take the Spend row's refresh
  // down with it — it is a reason, and the scan still saves.
  let setting;
  try {
    setting = needSetting('spend.telemetry', { root });
  } catch (err) {
    return { sent: 0, reason: `config unreadable — ${err && err.message ? err.message : err}` };
  }
  if (setting !== 'on')
    return { sent: 0, reason: 'off — spend.telemetry is not on (gf-kit config set spend.telemetry on)' };
  // The throttle counts ATTEMPTS, not successes: a persistent 401 or 429 retries every 10 minutes, not every minute.
  const last = Math.max(index.pushed_at ?? -Infinity, index.push_attempt_at ?? -Infinity);
  if (throttle && Number.isFinite(last) && now - last < PUSH_EVERY_MS)
    return { sent: 0, reason: 'throttled' };
  const key = apiKeyFrom(env);
  if (!key) return { sent: 0, reason: 'no ingest key — set SELF_PROJECT_API_KEY (or GROWTH_ENGINE_API_KEY)' };
  const base = String(env.GROWTH_ENGINE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  index.pushed ??= {};
  index.push_attempt_at = now;
  const due = sessionSnapshots(index, { epicOf }).filter(
    (s) => index.pushed[`${s.session_id}|${s.epic}`] !== s.last_at
  );
  const deadline = Date.now() + PUSH_BUDGET_MS;
  let sent = 0;
  let rejected = 0;
  for (const s of due) {
    const left = deadline - Date.now();
    if (left <= 0) return { sent, rejected, reason: 'budget — the rest go next time' };
    let res;
    try {
      res = await fetchImpl(`${base}/api/v1/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          userId: 'agent:claude-code',
          event: AGENT_USAGE_EVENT,
          metadata: s,
          context: { version: 1, idempotencyKey: `agent_usage:${s.session_id}:${s.epic}:${s.last_at}` },
        }),
        // Clamped to what is left of the budget, so the run as a whole stays inside the hook's timeout.
        signal: AbortSignal.timeout(Math.max(1, left)),
      });
    } catch (err) {
      return { sent, rejected, reason: `network — ${err && err.message ? err.message : err}` };
    }
    // Per snapshot, never "one bad row stops everything forever" (fresh review, #232):
    //   201 stored · 200 this exact snapshot was already there → done.
    //   409 the engine already holds a snapshot at this (session, epic, last_at) with other numbers — a rebuilt index,
    //       or a new price table re-pricing an old session. The engine's copy stands (append-only, latest-wins) → done.
    //   400 this snapshot will never be accepted (say, a branch name over the limit) → recorded and counted (the CLI says so
    //       and exits non-zero); not retried at this `last_at` — a grown session tries again.
    //   anything else (401 wrong key, 429 quota, 5xx) → stop; it is about the run, not the row. Next try in 10 min.
    if (res.status === 201 || res.status === 200 || res.status === 409) {
      index.pushed[`${s.session_id}|${s.epic}`] = s.last_at;
      if (res.status !== 409) sent++;
      continue;
    }
    if (res.status === 400) {
      index.pushed[`${s.session_id}|${s.epic}`] = s.last_at;
      index.push_rejected = (index.push_rejected ?? 0) + 1;
      index.push_rejected_at = now;
      rejected++;
      continue;
    }
    return { sent, rejected, reason: `engine answered ${res.status}` };
  }
  index.pushed_at = now;
  // A run that finished with no refusal clears the alarm (round 4, #232): the band stops saying "refused" once a later
  // push went through cleanly, so a signal that fired once does not become one people learn to ignore.
  // CLEAN means something actually went through with no refusal — an idle run ("nothing changed") or one where every
  // snapshot was a 409 proves nothing, and must not silence a refusal that is still current (round 5, #232).
  if (sent > 0 && !rejected) {
    index.push_clean_at = now;
    index.push_rejected = 0;
  }
  return { sent, rejected, reason: due.length ? 'ok' : 'nothing changed' };
}

// ── Stamping actual_* (S1.4 backfill, S2.5 close) ───────────────────────────────────────────────────

// stampFrontmatter moved to lib/frontmatter-stamp.mjs (result-record D8); re-exported above for existing callers.

/** The three actual_* fields for an epic's report. */
export function actualFields(report, basisPrefix, date) {
  return {
    actual_usd: report.usd,
    actual_mtok: report.mtok,
    actual_basis: `${basisPrefix}${MACHINE} · ${date} · ${report.sessions} session${report.sessions === 1 ? '' : 's'}${
      report.usd_known ? '' : ' · lower bound (unpriced model)'
    } · prices ${PRICES_AS_OF}`,
  };
}

function epicReadme(root, slug) {
  const roadmap = join(root, 'Roadmap');
  for (const macro of existsSync(roadmap) ? readdirSync(roadmap).sort() : []) {
    if (!/^\d{2}-/.test(macro)) continue;
    const p = join(roadmap, macro, slug, 'README.md');
    if (existsSync(p)) return p;
  }
  return null;
}

/** Write an epic's actual into its README. Returns the README path, or null when nothing was measured. */
export function stampEpic({ root, summary, slug, basisPrefix = '', date, keepStamped = false }) {
  const report = epicReport(summary, slug);
  if (!report.measured) return null;
  const path = epicReadme(root, slug);
  if (!path) throw new Error(`no Roadmap/*/${slug}/README.md`);
  const md = readFileSync(path, 'utf8');
  // A backfill never overwrites an actual already written — one stamped at close, or a deliberate hold such as
  // `actual_usd: null` with its reason (README C14). `--epic <slug> --write` (the close) is the one that replaces.
  if (keepStamped) {
    // Read through the contract's own parser: an empty `actual_basis:` or `actual_basis: null` is NOT a written actual.
    const fm = parseDocFrontmatter(md);
    // Fail CLOSED: a frontmatter this parser cannot read (an out-of-subset line, CRLF) may still hold an actual.
    if (fm.error) return null;
    const basis = fm.data.actual_basis;
    if (typeof basis === 'string' && basis.trim()) return null;
  }
  const next = stampFrontmatter(md, actualFields(report, basisPrefix, date));
  if (next !== md) writeFileSync(path, next);
  return path;
}

// ── Backfill (S1.4) ─────────────────────────────────────────────────────────────────────────────────

/**
 * Every shipped epic: measured from local transcripts, or the reason it could not be (findings recorded, not fixed).
 * `shippedAt(slug)` is when its README last changed; `oldestTranscriptAt` bounds what this machine can still see.
 */
export function backfillReport({
  summary,
  shipped,
  oldestTranscriptAt,
  shippedAt = () => null,
  scaffoldedAt = () => null,
}) {
  const resolved = [];
  const partial = [];
  const unresolved = [];
  for (const slug of shipped) {
    const e = summary.epics[slug];
    if (e) {
      // An epic scaffolded before the oldest transcript this machine still has was partly built in sessions that are
      // gone: its total is an UNDERSTATEMENT, and stamping it would teach the first quotes a number too low (D4).
      // And one measured only on `docs/` branches (a retro, a close-out) is not its build: the build ran elsewhere.
      const born = scaffoldedAt(slug);
      const onlyDocs = (e.branches || []).length > 0 && e.branches.every((b) => /^docs\//.test(b));
      const reason =
        born && oldestTranscriptAt && born < oldestTranscriptAt
          ? `scaffolded ${born.slice(0, 10)}, before the oldest transcript on this machine (${oldestTranscriptAt.slice(0, 10)}) — a partial total, not stamped`
          : onlyDocs
            ? `only close-out sessions here (${e.branches.join(', ')}) — the build ran elsewhere; a partial total, not stamped`
            : null;
      if (reason) partial.push({ epic: slug, ...epicReport(summary, slug), reason });
      else resolved.push({ epic: slug, ...epicReport(summary, slug) });
      continue;
    }
    const at = shippedAt(slug);
    const reason =
      at && oldestTranscriptAt && at < oldestTranscriptAt
        ? `shipped ${at.slice(0, 10)}, before the oldest transcript on this machine (${oldestTranscriptAt.slice(0, 10)}) — no transcripts left`
        : at
          ? `shipped ${at.slice(0, 10)}, but no session on this machine ran on a branch naming it — built in the cloud, on another machine, or from a session whose own checkout sat on another branch`
          : 'no session on this machine ran on a branch naming it';
    unresolved.push({ epic: slug, reason });
  }
  return { resolved, partial, unresolved };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────

function arg(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

function printEpic(r) {
  if (!r.measured) return `${r.epic}: no session on ${MACHINE} ran on a branch naming this epic`;
  const t = r.tokens;
  const m = (n) => `${Math.round(n / 1e5) / 10}M`;
  const lines = [
    `${r.epic}: ${usdText(r.usd, r.usd_known)} · ${r.mtok}M tok · ${r.sessions} session${r.sessions === 1 ? '' : 's'} · ${MACHINE}`,
    `  tokens   in ${m(t.input)} · out ${m(t.output)} · cache-read ${m(t.cache_read)} · cache-write ${m(t.cache_write_5m + t.cache_write_1h)}`,
    `  models   ${Object.entries(r.by_model)
      .map(([k, v]) => `${k} ${usdText(v.usd, v.usd_known)}`)
      .join(' · ')}`,
    `  skills   ${Object.entries(r.by_skill)
      .map(([k, v]) => `${k} ${usdText(v.usd, v.usd_known)}`)
      .join(' · ')}`,
    `  span     ${r.first_at ?? '?'} → ${r.last_at ?? '?'} · branches ${r.branches.join(', ')}`,
    `  ≈ API $ = list-price equivalent (${r.prices_source}, ${r.prices_as_of}); not measured: ${r.not_measured.join(', ')}`,
  ];
  return lines.join('\n');
}

async function main(argv) {
  const rootArg = arg(argv, '--repo-root');
  const root = resolve(rootArg ?? projectRoot());
  const projectsDir = arg(argv, '--projects-dir') ?? defaultProjectsDir();
  const json = argv.includes('--json');
  const write = argv.includes('--write');
  const today = new Date().toISOString().slice(0, 10);
  // --refresh is what the mod runs under a 10 s timeout (D24): it saves what it read within REFRESH_BUDGET_MS.
  const budgetMs = argv.includes('--refresh') ? REFRESH_BUDGET_MS : Infinity;
  // The push: `--push` asks for it now; `--refresh` (the mod) pushes too when `spend.telemetry` is on, at most every
  // PUSH_EVERY_MS. With the setting off both are a no-op that says so (D21).
  const wantsPush = argv.includes('--push') || argv.includes('--refresh');
  const { summary, changes, pushed } = await refresh({
    root,
    projectsDir,
    budgetMs,
    push: wantsPush,
    throttle: !argv.includes('--push'),
  });
  if (argv.includes('--push')) {
    // This run's refusals, and every one before it (a refusal during the band's automatic refresh lands here too).
    const total = summary.push_rejected ?? 0; // since the last clean push
    const refused = total
      ? ` · ${pushed?.rejected ?? 0} refused now, ${total} since the last clean push — the engine answered 400 (malformed); run --push --json and report it`
      : '';
    process.stdout.write(
      `epic-actuals: pushed ${pushed?.sent ?? 0} session snapshot(s) — ${pushed?.reason ?? 'scan incomplete, nothing sent'}${refused}\n`
    );
    // The exit code is THIS run's: a refusal last week must not fail every --push after it.
    return pushed && /^(ok|nothing changed)$/.test(pushed.reason) && !pushed.rejected ? 0 : 1;
  }

  if (argv.includes('--refresh')) {
    if (json)
      process.stdout.write(
        `${JSON.stringify({ changes, epics: Object.keys(summary.epics).length, pushed })}\n`
      );
    return 0;
  }
  const slug = arg(argv, '--epic');
  if (slug) {
    const report = epicReport(summary, slug);
    if (write) {
      const path = stampEpic({ root, summary, slug, date: today });
      if (!path) {
        process.stderr.write(`epic-actuals: nothing measured for ${slug} on ${MACHINE} — nothing written\n`);
        return 1;
      }
      process.stderr.write(`epic-actuals: stamped actual_* in ${path.slice(root.length + 1)}\n`);
    }
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${printEpic(report)}\n`);
    return 0;
  }
  if (argv.includes('--backfill')) {
    const rows = buildRows({ root, dates: false });
    const shipped = rows.filter((r) => r.grain === 'Epic' && r.status === 'Shipped').map((r) => r.slug);
    const shippedAt = (s) => {
      const p = epicReadme(root, s);
      // The FIRST commit that wrote `status: shipped` — a later edit (a move, a close-out) would date it too late.
      const dates = p ? git(root, ['log', '--format=%cI', '-G', '^status: shipped', '--', p]) : null;
      return dates ? dates.split('\n').filter(Boolean).at(-1) || null : null;
    };
    const scaffoldedAt = (s) => {
      const p = epicReadme(root, s);
      const dates = p ? git(root, ['log', '--format=%cI', '--follow', '--diff-filter=A', '--', p]) : null;
      return dates ? dates.split('\n').filter(Boolean).at(-1) || null : null;
    };
    const rep = backfillReport({
      summary,
      shipped,
      oldestTranscriptAt: summary.oldest_at,
      shippedAt,
      scaffoldedAt,
    });
    if (write)
      for (const r of rep.resolved)
        if (
          !stampEpic({
            root,
            summary,
            slug: r.epic,
            basisPrefix: 'backfill · ',
            date: today,
            keepStamped: true,
          })
        )
          process.stderr.write(`epic-actuals: ${r.epic} already carries an actual — left as written\n`);
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ...rep, unattributed: summary.unattributed, written: write }, null, 2)}\n`
      );
      return 0;
    }
    const out = [
      `Measured on ${MACHINE} (${rep.resolved.length} shipped epic${rep.resolved.length === 1 ? '' : 's'}):`,
    ];
    for (const r of rep.resolved)
      out.push(
        `  ${r.epic.padEnd(36)} ${usdText(r.usd, r.usd_known).padStart(9)} · ${r.mtok}M tok · ${r.sessions} session${r.sessions === 1 ? '' : 's'}`
      );
    out.push(`Partly measured — not stamped (${rep.partial.length}):`);
    for (const r of rep.partial)
      out.push(`  ${r.epic.padEnd(36)} ${usdText(r.usd, r.usd_known).padStart(9)} · ${r.reason}`);
    out.push(`Could not measure (${rep.unresolved.length}):`);
    for (const u of rep.unresolved) out.push(`  ${u.epic.padEnd(36)} ${u.reason}`);
    const un = Object.entries(summary.unattributed);
    out.push(
      `Unattributed (D11 — planning on main, fixes with no epic; ${un.length} branch${un.length === 1 ? '' : 'es'}):`
    );
    for (const [b, v] of un.slice(0, 12))
      out.push(
        `  ${b.padEnd(36)} ${usdText(v.usd, v.usd_known).padStart(9)} · ${v.sessions} session${v.sessions === 1 ? '' : 's'}`
      );
    if (un.length > 12) out.push(`  … ${un.length - 12} more — --json`);
    out.push(
      write
        ? 'Stamped actual_* on every measured shipped epic.'
        : 'Dry run — add --write to stamp actual_* on the measured ones.'
    );
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  }
  process.stderr.write(
    'usage: epic-actuals.mjs --epic <slug> [--json] [--write] | --refresh | --backfill [--write]\n'
  );
  return 2;
}

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
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`epic-actuals: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 2;
  }
}
