// project-root.mjs — the three path classes every kit script resolves through (golden-frijoles-plugin D2).
//
// A script in this set runs in one of two places:
//   • COPIED:    the project's own `scripts/<x>.mjs` (a project spawned from the template, or a deliberate fork).
//   • INSTALLED: `@golden-frijoles/kit`, run by `npx … gf-kit <x>` from npm's cache, far from the project.
// The same bytes run in both. What differs is only where "the project" and "my own files" are, so every
// path goes through exactly one of:
//
//   kitRoot()          the directory holding this script set: the project's `scripts/` when copied, the kit's
//                      `dist/` when installed. Kit assets (templates, task prompts, benchmarks) and SIBLING
//                      scripts a script spawns resolve here. Never the project's files.
//   projectRoot()      the user's project. `GF_PROJECT_ROOT` wins. Otherwise, COPIED: exactly `scripts/..`, as
//                      every script computed it before this module existed. INSTALLED: walk up from cwd to the
//                      nearest dir holding `Roadmap/` or `.git`, falling back to cwd.
//   projectAsset(rel)  a file the PROJECT owns but the kit supplies a default for (a TEMPLATE FILL-IN persona, a
//                      lessons file that grows per project, a per-project enforcement list): the project's
//                      `scripts/<rel>` when it has one, else the kit's copy. In copied mode those are one file.
//
// Why copied mode does NOT walk up from cwd: this repo's CI runs `node template/scripts/<x>.mjs` from the repo
// root, and consumers' tests pass explicit roots. A walk from cwd would silently retarget both at a different
// directory. The mode is a detected fact (the kit's package.json sits above dist/), never a guess.
//
// `--root <dir>` is parsed by kit/bin.mjs only, which exports it as GF_PROJECT_ROOT — no script's own argument
// parser ever sees a new flag. Zero deps; no side effects at import.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT_PACKAGE_NAME = '@golden-frijoles/kit';

const HERE = dirname(fileURLToPath(import.meta.url)); // <set>/lib

/** The directory holding this script set: the project's `scripts/` (copied) or the kit's `dist/` (installed). */
export function kitRoot() {
  return resolve(HERE, '..');
}

/** True when this set runs from the published kit rather than a project's own `scripts/`. */
export function isInstalled({ root = kitRoot(), read = readFileSync, exists = existsSync } = {}) {
  const pkg = join(root, '..', 'package.json');
  if (!exists(pkg)) return false;
  try {
    return JSON.parse(read(pkg, 'utf8')).name === KIT_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/** Walk up from `start` to the nearest directory holding `Roadmap/` or `.git`; null when there is none. */
export function findProjectRoot(start, { exists = existsSync } = {}) {
  let dir = resolve(start);
  for (;;) {
    if (exists(join(dir, 'Roadmap')) || exists(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The user's project. See the header for the precedence. */
export function projectRoot({
  env = process.env,
  cwd = process.cwd(),
  root = kitRoot(),
  installed = isInstalled({ root }),
  exists = existsSync,
} = {}) {
  if (env.GF_PROJECT_ROOT) return resolve(cwd, env.GF_PROJECT_ROOT);
  if (!installed) return resolve(root, '..');
  return findProjectRoot(cwd, { exists }) ?? resolve(cwd);
}

/** A project-owned file with a kit default: the project's `scripts/<rel>` if present, else the kit's `<rel>`. */
export class ProjectAssetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectAssetError';
  }
}

export function projectAsset(
  rel,
  { project = projectRoot(), root = kitRoot(), exists = existsSync, real = realpathSync } = {}
) {
  const own = join(project, 'scripts', rel);
  if (!exists(own)) return join(root, rel);
  // A project-owned asset is read into prompts some rails send to an external model, so it must be the project's
  // own file. A symlink that leaves the project (to .env.local's neighbours, ~/.ssh, …) is refused loudly: it is
  // a configuration problem a person has to look at, never something to follow (golden-frijoles-plugin X20).
  const realOwn = real(own);
  const realProject = real(project);
  if (realOwn !== realProject && !realOwn.startsWith(realProject + sep)) {
    throw new ProjectAssetError(`${own} resolves outside the project (${realOwn}); refusing to read it.`);
  }
  // The REAL path, already checked: returning the symlink would let it be swapped between this check and the read.
  return realOwn;
}
