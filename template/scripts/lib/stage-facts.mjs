// stage-facts.mjs — gather the git and GitHub facts the stage resolver reads, once per run (board-sinks-and-scrumban
// D14).
//
// Three modes:
//   live      one `git ls-remote --heads origin` and one `gh pr list --state all`, then the snapshot is rewritten.
//             When either call fails (no network, no `gh`, no auth) it falls back to the snapshot and says why.
//   snapshot  read `.golden-frijoles/board.json`. A missing or unreadable snapshot means no facts (docs only).
//   docs      no facts at all — BUILD-ORDER.md (committed, so it may not hold anything that moves without a commit:
//             lock C3) and fixtures.
//
// ── Why the snapshot holds FACTS, not stages ─────────────────────────────────────────────────────────────
// A snapshot of computed stages would freeze the docs too: an offline client would keep showing a seed as To groom
// after its pitch was written. Facts age; docs never do. So an offline run reads the docs as they are NOW and only
// the branch and PR lists carry an age — which every stage read from them states (`… · snapshot@<iso>`).
//
// Zero deps — Node 18+.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SNAPSHOT_PATH = join('.golden-frijoles', 'board.json');
export const FACT_MODES = Object.freeze(['live', 'snapshot', 'docs']);
const PR_LIMIT = 1000; // 223 PRs in this repo on 2026-10-01; one call, gh paginates.

// git exports GIT_DIR and friends into hooks, and they override `cwd` (build-state.mjs found this the hard way).
const GIT_ENV_TO_CLEAR = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_PREFIX'];
function cleanEnv() {
  const env = { ...process.env };
  for (const k of GIT_ENV_TO_CLEAR) delete env[k];
  return env;
}

/** `git ls-remote --heads` output → branch names. Pure. */
export function parseLsRemote(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.split('\t')[1] || '')
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length));
}

/** `gh pr list --json number,headRefName,state,isDraft,url` → the resolver's PR shape. Pure. */
export function normalizePrs(list) {
  if (!Array.isArray(list)) throw new Error('gh pr list did not return an array');
  return list.map((p) => ({
    number: Number(p.number),
    head: String(p.headRefName ?? ''),
    state: String(p.state ?? '').toUpperCase(),
    draft: Boolean(p.isDraft),
    url: String(p.url ?? ''),
  }));
}

function readSnapshot(root, read) {
  try {
    const data = JSON.parse(read(join(root, SNAPSHOT_PATH), 'utf8'));
    if (!Array.isArray(data.branches) || !Array.isArray(data.prs) || !data.generated_at) return null;
    return data;
  } catch {
    return null;
  }
}

/** Write the snapshot, and the directory's own ignore file when it is missing (the directory is never committed). */
export function writeSnapshot(
  root,
  facts,
  { write = writeFileSync, exists = existsSync, mkdir = mkdirSync } = {}
) {
  const file = join(root, SNAPSHOT_PATH);
  mkdir(dirname(file), { recursive: true });
  const ignore = join(dirname(file), '.gitignore');
  if (!exists(ignore)) write(ignore, '# local roadmap facts and figures, never committed\n*\n');
  write(file, `${JSON.stringify(facts, null, 2)}\n`);
}

/**
 * The facts for one run.
 * @returns `{ mode, branches, prs, origin, generated_at, note }` — `mode` is the mode actually used (a failed live
 *          run reports `snapshot` or `docs`), `origin` is `snapshot@<iso>` when the facts were read from the file
 *          (the resolver appends it to every git/GitHub source) and null otherwise, `note` says why a mode fell back.
 */
export function gatherFacts({
  root,
  mode = 'snapshot',
  run = spawnSync,
  read = readFileSync,
  persist = writeSnapshot,
  now = () => new Date(),
} = {}) {
  if (!FACT_MODES.includes(mode))
    throw new Error(`unknown facts mode "${mode}" — one of ${FACT_MODES.join(' | ')}`);
  const none = (note) => ({ mode: 'docs', branches: [], prs: [], origin: null, generated_at: null, note });
  if (mode === 'docs') return none(null);

  let note = null;
  if (mode === 'live') {
    const opts = { cwd: root, encoding: 'utf8', env: cleanEnv(), maxBuffer: 32 * 1024 * 1024 };
    const ls = run('git', ['ls-remote', '--heads', 'origin'], { ...opts, timeout: 20_000 });
    const gh =
      ls.status === 0
        ? run(
            'gh',
            [
              'pr',
              'list',
              '--state',
              'all',
              '--limit',
              String(PR_LIMIT),
              '--json',
              'number,headRefName,state,isDraft,url',
            ],
            { ...opts, timeout: 30_000 }
          )
        : null;
    if (ls.status !== 0) note = `live facts unavailable: git ls-remote failed (${firstLine(ls)})`;
    else if (gh.status !== 0) note = `live facts unavailable: gh pr list failed (${firstLine(gh)})`;
    else {
      try {
        const facts = {
          generated_at: now().toISOString(),
          source: 'github',
          branches: parseLsRemote(ls.stdout),
          prs: normalizePrs(JSON.parse(gh.stdout)),
        };
        try {
          persist(root, facts);
        } catch {
          // A read-only checkout still gets live facts; it just cannot leave a snapshot behind.
        }
        return {
          mode: 'live',
          branches: facts.branches,
          prs: facts.prs,
          origin: null,
          generated_at: facts.generated_at,
          note: null,
        };
      } catch (err) {
        note = `live facts unavailable: ${err.message}`;
      }
    }
  }

  const snap = readSnapshot(root, read);
  if (!snap) return none(note ?? 'no snapshot yet — run with --live once');
  return {
    mode: 'snapshot',
    branches: snap.branches,
    prs: snap.prs,
    origin: `snapshot@${snap.generated_at}`,
    generated_at: snap.generated_at,
    note,
  };
}

function firstLine(res) {
  if (res.error) return res.error.code === 'ENOENT' ? 'not installed' : res.error.message;
  return (
    String(res.stderr || '')
      .trim()
      .split('\n')[0] || `exit ${res.status}`
  ).slice(0, 160);
}
