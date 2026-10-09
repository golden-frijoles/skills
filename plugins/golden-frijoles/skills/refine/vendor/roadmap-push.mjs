#!/usr/bin/env node
// roadmap-push.mjs — push a project's roadmap extract to a Growth Engine as a report artifact (the Hub).
//
// board-sinks-and-scrumban S3.2 — this file ships in the kit (`npx -y @golden-frijoles/kit roadmap-push`, or
// `roadmap-extract --sink hub`, which calls `pushRoadmap()` in-process), byte-identical in every project's scripts/.
// So a stranger feeds the hosted board with the same rail this repo uses.
//
// pod-report · Sprint 1, Story 1.1. golden-beans is tenant #0: it dogfoods the same client-pushes
// rail a customer uses, through the same public endpoint, with the same kind of API key. There is
// no privileged internal path — if this script works, a customer's does too.
//
//   node scripts/roadmap-push.mjs                       # push to $GROWTH_ENGINE_URL
//   node scripts/roadmap-push.mjs --dry-run             # print the envelope, send nothing
//   node scripts/roadmap-push.mjs --url http://localhost:3000
//   node scripts/roadmap-push.mjs --env-file .env.local   # the key and URL `frijoles init --ingest` wrote
//
// Env: GROWTH_ENGINE_URL (default http://localhost:3000) and the project's ingest key: SELF_PROJECT_API_KEY FIRST (it only
// ever means this project's own key), else the SDK's GROWTH_ENGINE_API_KEY. Not the other way round — see apiKeyFrom.
// A missing key is a CLEAN SKIP (exit 0), not a failure — see the note in the CI step.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getKey } from './lib/config.mjs';
import { projectRoot } from './lib/project-root.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The PROJECT, not this file's parent: installed from the kit, this file lives in node_modules (golden-frijoles-plugin D2).
const REPO_ROOT = projectRoot();

// Must match apps/web/lib/roadmap-artifact-schema.ts's ROADMAP_SCHEMA_VERSION. Duplicated rather
// than imported because this is a zero-dependency .mjs script and that module is TypeScript behind
// a Next.js path alias — a spec asserts the two agree so the duplication cannot silently drift.
export const ROADMAP_SCHEMA_VERSION = 1;

function git(args, root = REPO_ROOT) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

/**
 * Build the push envelope from the extract rows.
 *
 * Pure and exported so a unit test pins the contract without running git, spawning the generator or
 * touching the network — the envelope is the thing the server validates, so it is the thing worth
 * testing.
 */
export function buildEnvelope(items, { commit, ref, generatedAt, board = null } = {}) {
  return {
    schemaVersion: ROADMAP_SCHEMA_VERSION,
    generatedAt: generatedAt ?? new Date().toISOString(),
    source: {
      // null, never undefined: JSON.stringify DROPS undefined keys, and a silently absent field is
      // harder to diagnose server-side than an explicit null.
      commit: commit ?? null,
      ref: ref ?? null,
    },
    items,
    // board-sinks-and-scrumban D21 — optional and additive; absent rather than null when there is nothing in it,
    // so the server's unchanged-board check (D16) never sees a difference that carries no information.
    ...(board ? { board } : {}),
  };
}

/**
 * The https base a card's repo-relative doc links resolve against, from the `origin` remote:
 * `git@github.com:o/r.git` or `https://github.com/o/r(.git)` → `https://github.com/o/r/blob/<branch>/`.
 * null for any other host — a link the Hub cannot build is better left out than guessed.
 */
export function repoBlobBase(remoteUrl, branch = 'main') {
  const m = String(remoteUrl || '')
    .trim()
    .match(
      /^(?:git@github\.com:|https:\/\/(?:[^@/]+@)?github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/
    );
  if (!m || !/^[A-Za-z0-9_./-]+$/.test(branch)) return null;
  return `https://github.com/${m[1]}/${m[2]}/blob/${branch}/`;
}

/** The envelope's `board` block: the WIP limits from config (D22) and the repo base for doc links. null when empty. */
export function buildBoard({ wip, repo }) {
  const limits = {};
  for (const stage of ['Building', 'QA']) {
    const n = wip?.[stage];
    if (Number.isInteger(n) && n > 0) limits[stage] = n;
  }
  const board = {};
  if (Object.keys(limits).length) board.wip = limits;
  if (repo) board.repo = repo;
  return Object.keys(board).length ? board : null;
}

/**
 * Rows from `roadmap-extract.mjs --live` — the ONE extractor (board-sinks-and-scrumban D15), with git and GitHub facts
 * gathered now, so the pushed stages are the ones the event that triggered this run produced. Dies loudly on empty
 * output (LEARNINGS: treat empty as failure).
 */
export function readExtract(run = spawnSync) {
  // --require-live: a failed git/GitHub gather turns the run red rather than publishing a docs-only board.
  const r = run('node', [resolve(__dirname, 'roadmap-extract.mjs'), '--live', '--require-live'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`roadmap-extract.mjs --live failed: ${(r.stderr || '').trim().split('\n').pop()}`);
  }
  const out = (r.stdout || '').trim();
  if (!out) throw new Error('roadmap-extract.mjs --live produced no output — treating empty as failure.');
  const items = JSON.parse(out);
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('extract returned no rows — refusing to push an empty roadmap.');
  }
  return items;
}

/** The project's ingest key: `SELF_PROJECT_API_KEY` first, else the SDK's `GROWTH_ENGINE_API_KEY`. */
// ⚠️ ORDER MATTERS (fresh review, #227): a repo that ALSO syncs data from another project can hold that other project's
// key in `GROWTH_ENGINE_API_KEY` (the SDK's name for "the engine key"), so preferring it would push this roadmap into
// someone else's project from any shell that has it exported. `SELF_PROJECT_API_KEY` — the name that only ever means
// "this project's own key" — wins; a project that never sets it uses the SDK's name.
export const apiKeyFrom = (env = process.env) =>
  env.SELF_PROJECT_API_KEY || env.GROWTH_ENGINE_API_KEY || null;

/** The envelope for `items` as pushed from the checkout at `root`: provenance, the WIP limits, the repo base. */
export function envelopeFor(items, root = REPO_ROOT) {
  const defaultBranch = (
    git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root) || 'origin/main'
  ).replace(/^origin\//, '');
  return buildEnvelope(items, {
    commit: git(['rev-parse', 'HEAD'], root),
    ref: git(['rev-parse', '--abbrev-ref', 'HEAD'], root),
    board: buildBoard({
      wip: getKey('board.wip', { root }),
      repo: repoBlobBase(git(['remote', 'get-url', 'origin'], root), defaultBranch),
    }),
  });
}

/**
 * Push rows to the engine. Returns `{ ok, skipped, status, text }` and writes nothing to stdout itself — the CLI and
 * `roadmap-extract --sink hub` say what happened in their own words. No key is a clean skip, never an error.
 */
export async function pushRoadmap(
  items,
  {
    root = REPO_ROOT,
    baseUrl = process.env.GROWTH_ENGINE_URL || 'http://localhost:3000',
    apiKey = apiKeyFrom(),
    fetchFn = fetch,
  } = {}
) {
  if (!apiKey) return { ok: true, skipped: true, status: null, text: '' };
  let res;
  try {
    res = await fetchFn(`${String(baseUrl).replace(/\/$/, '')}/api/v1/roadmap/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(envelopeFor(items, root)),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    // An unreachable engine is a failed push with its reason — never a stack trace (fresh review, #227).
    return { ok: false, skipped: false, status: null, text: `could not reach ${baseUrl}: ${err.message}` };
  }
  return { ok: res.ok, skipped: false, status: res.status, text: await res.text() };
}

/**
 * setup-instruments-connects D8 — the push's own variables from a dotenv file (`frijoles init --ingest` writes them to
 * `.env.local`). Pure, and it reads ONLY these names: nothing is evaluated (a shell `source` would run whatever the file
 * holds), and the last assignment wins, as dotenv does. Quotes are stripped; `export ` is allowed.
 */
export const ENV_FILE_NAMES = ['GROWTH_ENGINE_URL', 'GROWTH_ENGINE_API_KEY', 'SELF_PROJECT_API_KEY'];
export function readEnvFile(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !ENV_FILE_NAMES.includes(m[1])) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value) out[m[1]] = value;
  }
  return out;
}

/** The CLI's report for one push result. Exported so `roadmap-extract --sink hub` says it the same way. */
export function reportPush(result, count) {
  if (result.skipped) {
    // Clean skip, not a failure: a repo without the key must not turn every CI run red over an observability-grade
    // nicety — same stance as the Telegram workflow.
    process.stderr.write(
      'SELF_PROJECT_API_KEY (or GROWTH_ENGINE_API_KEY) not set — skipping the roadmap push cleanly.\n' +
        `  ${count} rows were generated and discarded. Set the project's ingest key to enable this.\n`
    );
    return 0;
  }
  if (!result.ok) {
    // The server's own error body names WHICH field failed and whether it was a version or a shape problem.
    process.stderr.write(`✗ roadmap push failed (${result.status}): ${result.text}\n`);
    return 1;
  }
  writeSync(1, `✓ roadmap pushed (${count} rows): ${result.text}\n`);
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  const urlFlag = args.indexOf('--url');
  const envFlag = args.indexOf('--env-file');
  let fromFile = {};
  if (envFlag !== -1) {
    const path = args[envFlag + 1];
    if (!path) {
      process.stderr.write('--env-file needs a path, for example --env-file .env.local\n');
      process.exitCode = 1;
      return;
    }
    try {
      fromFile = readEnvFile(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
    } catch (err) {
      process.stderr.write(`could not read ${path}: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
  }
  // An explicit --url wins, then the file, then the shell's environment.
  const baseUrl =
    (urlFlag !== -1 ? args[urlFlag + 1] : undefined) ||
    fromFile.GROWTH_ENGINE_URL ||
    process.env.GROWTH_ENGINE_URL ||
    'http://localhost:3000';
  const apiKey = apiKeyFrom({ ...process.env, ...fromFile });
  const items = readExtract();
  if (args.includes('--dry-run')) {
    writeSync(1, `${JSON.stringify(envelopeFor(items), null, 2)}\n`);
    return;
  }
  process.exitCode = reportPush(await pushRoadmap(items, { baseUrl, apiKey }), items.length);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`✗ ${err.message}\n`);
    process.exit(1);
  });
}
