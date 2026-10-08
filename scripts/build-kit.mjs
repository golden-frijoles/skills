#!/usr/bin/env node
// build-kit.mjs — build @golden-frijoles/kit's dist/ from the skills' declared closure (golden-frijoles-plugin D1).
//
//   node scripts/build-kit.mjs            # wipe kit/dist/, copy the closure, print what went in
//   node scripts/build-kit.mjs --list     # print the manifest (relative paths), build nothing
//
// ── Why it is built, not committed ──────────────────────────────────────────────────────────────
// template/scripts/ is the one source of every script a skill runs. A committed kit/ copy would be a second
// source that drifts, which is the exact fork problem this repo exists to end. So the kit is GENERATED from
// the single list that already says what the skills need: each SKILL.md's `requires_scripts:`. That list is
// already held to the real import closure by check-skill-scripts.mjs, so the kit can be neither short (a
// skill's script missing from npm) nor padded. kit/dist/ is gitignored by the repo's `dist/` rule.
//
// The layout mirrors a project's scripts/ exactly: dist/<entry>.mjs, dist/lib/…, dist/pmo/…. That is what
// lets the same bytes run copied or installed (D2: kitRoot() is simply "the directory holding lib/").
//
// Zero deps — Node 18+.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSkills, parseRequiresScripts } from './check-skill-scripts.mjs';
import { SKELETON } from '../template/scripts/init.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SKILLS_DIR = join(repoRoot, 'plugins', 'golden-frijoles', 'skills');
export const SOURCE_DIR = join(repoRoot, 'template', 'scripts');
export const TEMPLATE_DIR = join(repoRoot, 'template');
export const KIT_DIR = join(repoRoot, 'kit');
// Shipped beside the scripts so the package carries its own license terms (npm also reads the root LICENSE of
// the package dir, which for kit/ is this copy).
export const LEGAL_FILES = ['LICENSE', 'NOTICE'];

/** Pure (given `read`) — the sorted union of every skill's declared `requires_scripts`. */
export function kitManifest({ skillsDir = SKILLS_DIR, read = readFileSync } = {}) {
  const files = new Set();
  for (const skill of listSkills(skillsDir)) {
    const declared = parseRequiresScripts(read(join(skillsDir, skill, 'SKILL.md'), 'utf8'));
    for (const rel of declared ?? []) files.add(rel);
  }
  return [...files].sort();
}

/**
 * Build dist/. Throws, naming every absent file, before writing anything.
 *
 * Alongside the script closure, it copies the S3.2 Roadmap skeleton (`init.mjs`'s own `SKELETON`
 * export — one list, read here and by `frijoles-kit init` itself) from `template/<rel>` into
 * `kit/dist/skeleton/<rel>`, which is where `skeletonRoot()` looks for it in installed mode.
 */
export function buildKit({
  manifest = kitManifest(),
  sourceDir = SOURCE_DIR,
  templateDir = TEMPLATE_DIR,
  skeleton = SKELETON,
  kitDir = KIT_DIR,
  legalDir = repoRoot,
  exists = existsSync,
} = {}) {
  const missing = manifest.filter((rel) => !exists(join(sourceDir, rel)));
  const missingLegal = LEGAL_FILES.filter((f) => !exists(join(legalDir, f)));
  const missingSkeleton = skeleton.filter((rel) => !exists(join(templateDir, rel)));
  if (missing.length || missingLegal.length || missingSkeleton.length) {
    throw new Error(
      `build-kit: declared but absent — ${[
        ...missing.map((m) => `template/scripts/${m}`),
        ...missingLegal,
        ...missingSkeleton.map((m) => `template/${m}`),
      ].join(', ')}`
    );
  }
  const dist = join(kitDir, 'dist');
  rmSync(dist, { recursive: true, force: true });
  for (const rel of manifest) {
    mkdirSync(dirname(join(dist, rel)), { recursive: true });
    copyFileSync(join(sourceDir, rel), join(dist, rel));
  }
  for (const f of LEGAL_FILES) copyFileSync(join(legalDir, f), join(dist, f));
  for (const rel of skeleton) {
    const dest = join(dist, 'skeleton', rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(templateDir, rel), dest);
  }
  return { dist, files: manifest, skeleton };
}

/**
 * A complete, private kit in `dir` (the committed kit/ files + a fresh dist/), for specs. Tests run in parallel,
 * and two that rebuilt the shared kit/dist/ raced each other (one wiped it while the other was packing it).
 */
export const KIT_COMMITTED = ['package.json', 'bin.mjs', 'README.md'];
export function stageKit(dir) {
  mkdirSync(dir, { recursive: true });
  for (const f of KIT_COMMITTED) copyFileSync(join(KIT_DIR, f), join(dir, f));
  return buildKit({ kitDir: dir });
}

function main(argv) {
  if (argv.includes('--list')) {
    process.stdout.write(`${kitManifest().join('\n')}\n`);
    return 0;
  }
  try {
    const { dist, files, skeleton } = buildKit();
    console.log(
      `build-kit: ${files.length} file(s) + ${LEGAL_FILES.join(', ')} + ${skeleton.length} skeleton file(s) → ${dist}`
    );
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('build-kit.mjs');
if (isMain) process.exitCode = main(process.argv.slice(2));
