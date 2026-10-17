#!/usr/bin/env node
// init.mjs — `frijoles-kit init`: adopt any repo by writing the Roadmap/ skeleton (golden-frijoles-plugin S3.2, D2).
//
//   node scripts/init.mjs             # write the skeleton into projectRoot(); never overwrite a file
//
// ── Why ───────────────────────────────────────────────────────────────────────────────────────
// A stranger who pastes the install prompt into an EXISTING repo gets the plugin, but `refine` needs
// somewhere to write on day one — `Roadmap/README.md`, `WAYS-OF-WORKING.md`, `LEARNINGS.md`, and the
// `00-ideas/` funnel. `frijoles-kit init` is that one step: it writes the same skeleton a project spawned
// from `template/` already has, into any repo, copied or installed (D2's two roots).
//
// ── Where the skeleton's SOURCE lives ─────────────────────────────────────────────────────────
// INSTALLED: `kitRoot()/skeleton/` — `scripts/build-kit.mjs` copies `template/<each SKELETON path>`
// into `kit/dist/skeleton/`, reading the very list exported below, so there is one list, not two.
// COPIED: `kitRoot()/../` — when this file runs as `template/scripts/init.mjs` (this repo's own dev
// checkout) that is `template/`, the skeleton's real source; when it runs as a spawned project's own
// `scripts/init.mjs`, that is the project's own root, which already has every file, so every write is
// a no-op `skipped … (exists)` — never a broken read.
//
// ── The one rule ──────────────────────────────────────────────────────────────────────────────
// It NEVER overwrites a file that already exists (it prints `skipped <path> (exists)`), so it is safe
// to run on a partially-adopted repo. It writes nothing outside `Roadmap/`, with ONE exception: the marked
// rails block in `.prettierignore` (below). Its own exit code is 0 whether it wrote anything or not —
// "already adopted" is success, not a no-op failure.
//
// ── The one exception: the rails' `.prettierignore` block (template-scripts-consumer-gates D3) ─────
// A project that copies template/scripts runs its OWN Prettier config over them, and configs differ, so a
// release formatted here can still fail a consumer's check (it did, twice). Decided 2026-10-14 (Daniel):
// consumers ignore the vendored rails. The block lists every rail file; `init` creates `.prettierignore`,
// appends the block, or replaces the block in place. Lines outside the markers are never touched, a
// current block is never rewritten, and a malformed one (two openers, an opener with no closer) is refused,
// never guessed at. The block's source is `<skeleton root>/.prettierignore`, GENERATED from template/scripts
// by skills/scripts/render-prettier-block.mjs.
//
// ── Two guards found by cross-review on #47 ───────────────────────────────────────────────────
// (1) COPIED mode, source === destination: `skeletonRoot()` in copied mode is `kitRoot()/..`, the
// SAME directory `projectRoot()` resolves to (this repo's own dev checkout runs exactly this way).
// So `join(source, rel)` and `join(project, rel)` are the identical path — reproduced by deleting
// one SKELETON file from a template/ checkout and running `node scripts/init.mjs`: the destination
// "doesn't exist" (it was deleted), so the copy proceeds, and the SOURCE (the same path) doesn't
// exist either — `copyFileSync` throws ENOENT instead of a clean skip. A stranger in installed mode
// never hits this (source and project are genuinely different directories there), but the repo's
// own dev loop and any future copied-mode caller can. Treated as `skipped`, same as "exists" — the
// file not being copyable from itself is not a failure this tool should crash on.
// (2) INSTALLED mode, project root resolves to `$HOME`: `projectRoot()` walks up to the nearest
// `Roadmap/` or `.git`. A non-git folder under a dotfiles repo tracked at `$HOME` (a common setup)
// has no closer match, so the walk lands on `$HOME` itself — and writing `Roadmap/` there would
// scatter the skeleton across the operator's actual home directory. Refused outright.
//
// Zero deps — Node 18+.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isInstalled, kitRoot, projectRoot } from './lib/project-root.mjs';
import { isMain } from './lib/is-main.mjs';

/**
 * The Roadmap skeleton `frijoles-kit init` writes, relative both to its source root (template/, or
 * kit/dist/skeleton/ once built) and to the project it writes into. ONE list: `build-kit.mjs` reads
 * this export to populate `kit/dist/skeleton/`, so there is no second copy of the file names to drift.
 */
export const SKELETON = [
  'Roadmap/README.md',
  'Roadmap/WAYS-OF-WORKING.md',
  'Roadmap/LEARNINGS.md',
  'Roadmap/00-ideas/README.md',
  'Roadmap/00-ideas/seeds/.gitkeep',
  'Roadmap/00-ideas/audits/.gitkeep',
];

/**
 * Files `init` MERGES rather than copies: it owns only a marked block inside each (D3), never the file. A
 * second list beside SKELETON, because SKELETON's rule is "never overwrite". `build-kit.mjs` copies these
 * into `kit/dist/skeleton/` too.
 */
export const MERGED = ['.prettierignore'];

export const BLOCK_OPEN = '# >>> golden-frijoles rails (written by frijoles-kit init; edit outside this block) >>>';
export const BLOCK_CLOSE = '# <<< golden-frijoles rails <<<';

/** The rails' block for these `scripts/`-relative paths, sorted. Pure. */
export function renderPrettierBlock(paths) {
  return [BLOCK_OPEN, ...[...paths].sort().map((p) => `scripts/${p}`), BLOCK_CLOSE].join('\n');
}

/**
 * Where the block sits in `text`: `{ start, end }` line indexes (inclusive), `null` when absent. Throws on a
 * malformed block, which a merge must never guess about. Pure.
 */
export function findBlock(text) {
  const lines = text.split('\n');
  const opens = lines.flatMap((l, i) => (l.trim() === BLOCK_OPEN ? [i] : []));
  const closes = lines.flatMap((l, i) => (l.trim() === BLOCK_CLOSE ? [i] : []));
  if (!opens.length && !closes.length) return null;
  if (opens.length !== 1 || closes.length !== 1 || closes[0] < opens[0]) {
    throw new Error(
      `.prettierignore has ${opens.length} rails-block opener(s) and ${closes.length} closer(s) — expected one of each, in order. ` +
        'Fix the markers by hand (or delete the block), then run init again.'
    );
  }
  return { start: opens[0], end: closes[0] };
}

/** `existing` (or null: no file) with `block` merged in. Pure; returns the text unchanged when current. */
export function mergePrettierBlock(existing, block) {
  if (existing == null || existing === '') return `${block}\n`;
  const at = findBlock(existing);
  if (!at) return `${existing}${existing.endsWith('\n') ? '' : '\n'}\n${block}\n`;
  const lines = existing.split('\n');
  return [...lines.slice(0, at.start), ...block.split('\n'), ...lines.slice(at.end + 1)].join('\n');
}

/**
 * Merge the rails' block from `source/.prettierignore` into `project/.prettierignore`. Returns 'wrote',
 * 'current' or 'no-source'. Throws on a malformed block in either file.
 */
export function upsertPrettierBlock({
  project = projectRoot(),
  source = skeletonRoot(),
  exists = existsSync,
  read = (p) => readFileSync(p, 'utf8'),
  write = writeFileSync,
  log = () => {},
} = {}) {
  const from = join(source, '.prettierignore');
  const dest = join(project, '.prettierignore');
  if (!exists(from)) {
    log('skipped .prettierignore (source is absent)');
    return 'no-source';
  }
  const src = read(from);
  const at = findBlock(src);
  if (!at) throw new Error(`${from} carries no rails block — the kit is malformed`);
  const block = src.split('\n').slice(at.start, at.end + 1).join('\n');
  const before = exists(dest) ? read(dest) : null;
  const after = mergePrettierBlock(before, block);
  if (after === before) {
    log('skipped .prettierignore (rails block current)');
    return 'current';
  }
  write(dest, after);
  log(`wrote .prettierignore (rails block${before == null ? ', new file' : ''})`);
  return 'wrote';
}

/** Where the skeleton's SOURCE files live: `kitRoot()/skeleton` when installed, `kitRoot()/..` when copied. */
export function skeletonRoot({ root = kitRoot(), installed = isInstalled({ root }) } = {}) {
  return installed ? join(root, 'skeleton') : join(root, '..');
}

/**
 * Write the skeleton into `project`, never overwriting. Pure given its injected fs functions.
 * Returns `{ wrote, skipped }`, each a list of the SKELETON-relative paths.
 */
export function initSkeleton({
  project = projectRoot(),
  source = skeletonRoot(),
  files = SKELETON,
  exists = existsSync,
  mkdir = mkdirSync,
  copy = copyFileSync,
  log = () => {},
} = {}) {
  const wrote = [];
  const skipped = [];
  for (const rel of files) {
    const dest = join(project, rel);
    if (exists(dest)) {
      skipped.push(rel);
      log(`skipped ${rel} (exists)`);
      continue;
    }
    const from = join(source, rel);
    // Copied mode's source and destination roots can be the identical directory (see the header) —
    // a source that is the destination, or that simply isn't there, is a skip, never a crash. The
    // destination not existing (checked above) does NOT imply the source exists: they can be the
    // same absent path.
    if (from === dest || !exists(from)) {
      skipped.push(rel);
      log(`skipped ${rel} (${from === dest ? 'source is the destination' : 'source is absent'})`);
      continue;
    }
    mkdir(dirname(dest), { recursive: true });
    copy(from, dest);
    wrote.push(rel);
    log(`wrote ${rel}`);
  }
  return { wrote, skipped };
}

/**
 * True when `project` resolves to the operator's own home directory — the one place `frijoles-kit init`
 * must never write, even though `projectRoot()`'s walk-up can legitimately land there (a non-git
 * folder under a dotfiles repo tracked at `$HOME`). Pure given its injected `home`.
 */
export function isHomeDirectory({ project = projectRoot(), home = homedir() } = {}) {
  return resolve(project) === resolve(home);
}

function main() {
  const project = projectRoot();
  if (isHomeDirectory({ project })) {
    console.error(
      `frijoles-kit init: refusing to run — the resolved project root is your home directory (${project}).\n` +
        '  This usually means no Roadmap/ or .git was found between the current directory and $HOME,\n' +
        '  and $HOME itself is a git repo (a dotfiles checkout, for example). Run this from inside a\n' +
        '  real project — a directory with its own .git — or pass --root explicitly.'
    );
    return 2;
  }
  const { wrote, skipped } = initSkeleton({ project, log: (line) => console.log(line) });
  try {
    upsertPrettierBlock({ project, log: (line) => console.log(line) });
  } catch (e) {
    console.error(`frijoles-kit init: ${e.message}`);
    return 1;
  }
  console.log(`frijoles-kit init: ${wrote.length} written, ${skipped.length} already present.`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
