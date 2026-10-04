// kickoff-cli.mjs — the argv, project-root and epic-lookup half both kickoff generators share
// (kickoff-generator-path C2).
//
// `emit-epic-kickoff.mjs` and `emit-kickoff.mjs` run in THREE places, the same bytes in each:
//   • a project's own `scripts/` (copied from the template),
//   • the kit's `dist/` (`npx -y @golden-frijoles/kit emit-epic-kickoff …`, far from the project),
//   • the groom skill's `vendor/` inside the plugin (the build-view mod's `/build`, and groom's Stage 8).
// `projectRoot()` answers the first two. For the third it answers `groom/`, which holds no Roadmap/, so the root takes
// one more rung (see `resolveRepoRoot`). The epic lookup lived twice, byte-for-byte, in the two CLIs; it lives here.
//
// Zero deps; no side effects at import.

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findProjectRoot, projectRoot } from './project-root.mjs';

/** `--key value` pairs; a flag with no value (or followed by another flag) is `true`. */
export function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { a[key] = true; }
      else { a[key] = next; i++; }
    }
  }
  return a;
}

/**
 * The project whose Roadmap/ the kickoff is built from, first match wins:
 *   1. `--repo-root <path>` (the mod always passes it),
 *   2. `GF_PROJECT_ROOT` (`gf-kit --root` sets it), taken as given: a person named it,
 *   3. `projectRoot()` when it holds a Roadmap/ (a project's own `scripts/`, or the installed kit's walk from cwd),
 *      — a copied set answers its own parent, so the template's own copy here answers `skills/template/` (whose
 *        skeleton Roadmap/ has no epics); that is project-root.mjs's copied-mode rule, and no doc runs that copy,
 *   4. the nearest directory holding Roadmap/ or .git, walking up from cwd (the plugin's vendored copy),
 *   5. cwd.
 * Pure over its options for the spec.
 */
export function resolveRepoRoot(
  args,
  { env = process.env, cwd = process.cwd(), exists = existsSync, project = () => projectRoot({ env, cwd, exists }) } = {}
) {
  const flag = args['repo-root'];
  if (flag && flag !== true) return resolve(cwd, String(flag));
  if (env.GF_PROJECT_ROOT) return resolve(cwd, env.GF_PROJECT_ROOT);
  const root = project();
  if (exists(join(root, 'Roadmap'))) return root;
  return findProjectRoot(cwd, { exists }) ?? resolve(cwd);
}

/**
 * Search Roadmap/*\/<slug>/ under repoRoot — the macro-area prefix isn't knowable from the slug alone.
 * Returns `{ macro, dir }`, or `{ error }` naming what was searched (zero hits, or more than one).
 */
export function findEpicDir(repoRoot, slug, { exists = existsSync, list = readdirSync } = {}) {
  const roadmapDir = join(repoRoot, 'Roadmap');
  if (!exists(roadmapDir)) return { error: `no Roadmap/ dir under "${repoRoot}" (pass --repo-root <path>)` };
  let macros;
  try {
    macros = list(roadmapDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    return { error: `couldn't read ${roadmapDir}: ${e.message}` };
  }
  const hits = macros.filter((m) => exists(join(roadmapDir, m, slug, 'README.md')));
  if (hits.length === 0) {
    return { error: `no epic found for slug "${slug}" under any Roadmap/*/ dir in "${repoRoot}" (searched: ${macros.join(', ') || '(none)'})` };
  }
  if (hits.length > 1) {
    return { error: `ambiguous slug "${slug}" — found under multiple macro-areas: ${hits.map((m) => `Roadmap/${m}/${slug}`).join(', ')}` };
  }
  return { macro: hits[0], dir: join(roadmapDir, hits[0], slug) };
}
