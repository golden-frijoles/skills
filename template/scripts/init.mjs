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
// to run on a partially-adopted repo. It writes nothing outside `Roadmap/`. Its own exit code is 0
// whether it wrote anything or not — "already adopted" is success, not a no-op failure.
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

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isInstalled, kitRoot, projectRoot } from './lib/project-root.mjs';

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
  console.log(`frijoles-kit init: ${wrote.length} written, ${skipped.length} already present.`);
  return 0;
}

const isMain = process.argv[1] && process.argv[1].endsWith('init.mjs');
if (isMain) process.exitCode = main();
