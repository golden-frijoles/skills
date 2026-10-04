#!/usr/bin/env node
// check-release.mjs — a version bump IS the release (D4, D5): this is the mechanical half.
//
//   node scripts/check-release.mjs                  # the ALWAYS check: plugin.json / CHANGELOG.md agree
//   node scripts/check-release.mjs --base <ref>      # + the PR check: a shipped-surface diff bumped it
//
// ── Why ───────────────────────────────────────────────────────────────────────────────────────
// D4: "a change to anything a user receives that doesn't bump the version never reaches them" —
// Claude Code pins on `plugin.json`'s `version`, so a merge that touches a shipped file without
// moving that number is invisible to every consumer still tracking `main`. This is the guard: on a
// PR, a diff that touches `plugins/**`, `kit/**` (S2 on) or the kit's script closure must also move
// the version forward past the base branch's. Always (PR or not), `plugin.json`'s version, the newest
// `CHANGELOG.md` heading, and `kit/package.json`'s version (once S2 adds it) must all agree — that
// triple is what `RELEASING.md`'s three-line procedure and `.github/workflows/release.yml` both trust.
//
// The kit closure is NEVER a copied list here (a copy drifts the moment a skill's `requires_scripts:`
// changes) — it is derived live from `check-skill-scripts.mjs`'s own `listSkills` +
// `parseRequiresScripts`, the same registry that guard walks.
//
// Zero deps — Node 18+.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { listSkills, parseRequiresScripts } from './check-skill-scripts.mjs';
import { SKELETON } from '../template/scripts/init.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
export const PLUGIN = join(repoRoot, 'plugins', 'golden-frijoles', '.claude-plugin', 'plugin.json');
export const KIT_PACKAGE = join(repoRoot, 'kit', 'package.json'); // S2 — absent today; checked only if present
export const CHANGELOG = join(repoRoot, 'CHANGELOG.md');
export const SKILLS_DIR = join(repoRoot, 'plugins', 'golden-frijoles', 'skills');

/** Pure — parse "x.y.z" into [x,y,z] of numbers. Throws on anything else — never silently coerced. */
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  if (!m) throw new Error(`not a semver x.y.z: ${JSON.stringify(v)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Pure — -1 / 0 / 1, comparing two semver strings NUMERICALLY ("0.10.0" > "0.9.0", not lexicographic). */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/**
 * Pure — plugin.json's version field. Throws if absent (an unversioned shipped plugin is a bug) and if it is
 * anything but a strict `x.y.z`: this value becomes a git tag, a release title and a RegExp, so it is validated
 * where it is read rather than escaped at each use (security lens on #44).
 */
export function pluginVersion(pluginJsonText) {
  const v = JSON.parse(pluginJsonText).version;
  if (!v) throw new Error('plugin.json: no version field');
  parseVersion(v); // throws on anything but x.y.z
  return v;
}

/** Pure — the newest `## [x.y.z]` heading in CHANGELOG.md. `## [Unreleased]` has no version and is skipped. */
export function newestChangelogVersion(changelogText) {
  const m = changelogText.match(/^##\s*\[(\d+\.\d+\.\d+)\]/m);
  if (!m) throw new Error('CHANGELOG.md: no "## [x.y.z]" heading found');
  return m[1];
}

/**
 * Pure — the body text of one version's CHANGELOG.md section (between its `## [x.y.z]` heading and
 * the next `## ` heading, or end of file), trimmed. `.github/workflows/release.yml` uses this as the
 * GitHub Release body, so the release notes are never hand-typed a second time.
 */
export function changelogSection(changelogText, version) {
  parseVersion(version); // strict x.y.z — nothing but digits and dots ever reaches the RegExp below
  const re = new RegExp(`^##\\s*\\[${version.replace(/\./g, '\\.')}\\][^\\n]*\\n`, 'm');
  const start = changelogText.search(re);
  if (start === -1) throw new Error(`CHANGELOG.md: no "## [${version}]" heading found`);
  const afterHeading = start + changelogText.slice(start).match(re)[0].length;
  const rest = changelogText.slice(afterHeading);
  const next = rest.search(/^##\s/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/**
 * Pure — every file a version bump must cover: `plugins/**`, `kit/**` (S2 on) and what the kit carries: its script
 * closure (every skill's declared `requires_scripts:`, resolved against `template/scripts/` — the
 * root `check-skill-scripts.mjs` audits by default, and its own guard proves declared === actual), plus the Roadmap
 * skeleton `gf-kit init` writes (`init.mjs`'s `SKELETON`, the one list build-kit copies into `dist/skeleton/`).
 * Before kickoff-generator-path S2 the skeleton was missing here, so an edit to `template/Roadmap/WAYS-OF-WORKING.md`
 * changed what the kit hands a new project without asking for the version that would publish it.
 */
export function kitClosureFiles({ skillsDir = SKILLS_DIR, read = readFileSync, skeleton = SKELETON } = {}) {
  const files = new Set();
  for (const skill of listSkills(skillsDir)) {
    const declared = parseRequiresScripts(read(join(skillsDir, skill, 'SKILL.md'), 'utf8'));
    for (const rel of declared || []) files.add(`template/scripts/${rel}`);
  }
  for (const rel of skeleton) files.add(`template/${rel}`);
  return files;
}

/** Pure — does this changed-file list touch anything a version bump must cover? */
export function touchesShippedSurface(changedFiles, closureFiles) {
  return changedFiles.some((f) => f.startsWith('plugins/') || f.startsWith('kit/') || closureFiles.has(f));
}

/**
 * Pure — the always-on consistency rule (D4): plugin.json = CHANGELOG's newest heading = kit/package.json (once
 * the kit exists). Returns the problems, [] when consistent. A plugin-only bump is exactly what this catches.
 */
export function consistencyErrors({ plugin, changelog, kit = null }) {
  const errors = [];
  if (plugin !== changelog) errors.push(`plugin.json version "${plugin}" != CHANGELOG.md newest heading "${changelog}".`);
  if (kit !== null && kit !== plugin) errors.push(`kit/package.json version "${kit}" != plugin.json version "${plugin}".`);
  return errors;
}

/** Pure — the highest `vX.Y.Z` among git tag names; null when there is none. */
export function highestTagVersion(tagNames) {
  const versions = tagNames
    .map((t) => t.trim().match(/^v(\d+\.\d+\.\d+)$/))
    .filter(Boolean)
    .map((m) => m[1]);
  return versions.reduce((max, v) => (max === null || compareVersions(v, max) > 0 ? v : max), null);
}

function gitDiffNames(base) {
  // Three-dot, not two: only what THIS branch changed since it forked from base, never the inverse of
  // whatever base gained meanwhile (LEARNINGS: "the two-dot diff lies when your branch is behind").
  const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: repoRoot, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

// null = the path did not exist at base at all (a brand-new versioned plugin, e.g. this very rename PR)
// — that is trivially a forward move, not a failure to look.
function pluginVersionAtRef(ref) {
  const rel = relative(repoRoot, PLUGIN);
  let text;
  try {
    text = execFileSync('git', ['show', `${ref}:${rel}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
  return pluginVersion(text);
}

function main(argv) {
  const current = pluginVersion(readFileSync(PLUGIN, 'utf8'));

  // ── Read-only helper modes for release.yml — no checking, just print and exit. ────────────────
  if (argv.includes('--print-version')) {
    process.stdout.write(`${current}\n`);
    return 0;
  }
  if (argv.includes('--print-section')) {
    process.stdout.write(`${changelogSection(readFileSync(CHANGELOG, 'utf8'), current)}\n`);
    return 0;
  }

  const baseIdx = argv.indexOf('--base');
  const base = baseIdx !== -1 ? argv[baseIdx + 1] : null;
  let failed = false;

  // ── Always: plugin.json, CHANGELOG.md's newest heading, and kit/package.json (once it exists) agree.
  const changelog = newestChangelogVersion(readFileSync(CHANGELOG, 'utf8'));
  const kit = existsSync(KIT_PACKAGE) ? JSON.parse(readFileSync(KIT_PACKAGE, 'utf8')).version : null;
  for (const e of consistencyErrors({ plugin: current, changelog, kit })) {
    console.error(`check-release: ${e}`);
    failed = true;
  }

  // ── At release time (release.yml): never cut a version BELOW one already released. Equal is fine —
  // that is a push that did not bump, and the workflow's own tag check turns it into a no-op.
  if (argv.includes('--against-tags')) {
    const tags = execFileSync('git', ['tag', '-l', 'v*'], { cwd: repoRoot, encoding: 'utf8' }).split('\n');
    const highest = highestTagVersion(tags);
    if (highest !== null && compareVersions(current, highest) < 0) {
      console.error(`check-release: plugin.json version "${current}" is below the newest release tag v${highest}.`);
      failed = true;
    }
  }

  // ── On a PR: a shipped-surface diff must have moved the version forward past the base branch's.
  if (base) {
    const changed = gitDiffNames(base);
    const closure = kitClosureFiles();
    if (touchesShippedSurface(changed, closure)) {
      const baseVersion = pluginVersionAtRef(base);
      if (baseVersion !== null && compareVersions(current, baseVersion) <= 0) {
        console.error(
          `check-release: plugins/**, kit/** or the kit's script closure changed, but the version did ` +
            `not move forward (${baseVersion} -> ${current}). Bump plugin.json's version and add a ` +
            'CHANGELOG.md section — see RELEASING.md.'
        );
        failed = true;
      } else {
        const from = baseVersion === null ? '(new at base)' : baseVersion;
        console.log(`check-release: shipped surface changed, version moved ${from} -> ${current}. ok.`);
      }
    } else {
      console.log('check-release: no shipped-surface change against the base — no bump required.');
    }
  }

  if (!failed) console.log(`check-release: plugin.json and CHANGELOG.md agree at ${current}.`);
  return failed ? 1 : 0;
}

// realpath, not resolve: on macOS a temp or symlinked path (/var → /private/var) never equals the module
// URL, and a plain comparison makes the CLI a silent no-op.
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));
