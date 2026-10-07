#!/usr/bin/env node
// plugin-checksums.mjs — a SHA-256 for every file in the plugin release (account-from-the-terminal S1.1,
// canvas First run frame 2).
//
//   node scripts/plugin-checksums.mjs            # (re)write SHA256SUMS
//   node scripts/plugin-checksums.mjs --check    # exit 1 if SHA256SUMS is stale, missing or padded
//   node scripts/plugin-checksums.mjs --verify <dir>   # check a downloaded release against SHA256SUMS
//
// ── Why a file in the repo, and not only a release asset ────────────────────────────────────────
// install.md lists these sums so an agent can compare a release before installing it, and the page is
// rendered from this file — never typed by hand. Committed, the sums travel with the tag they describe:
// the commit that bumps plugin.json carries the sums of exactly that tree, and `--check` fails CI the
// moment a plugin file changes without them. release.yml also attaches the file to the GitHub Release.
//
// The format is `shasum -a 256 -c`'s own (`<hex>  <path>`, paths from the repo root), so a reader can
// check a clone with a tool they already have. The file is outside `plugins/`, so it never lists itself.
//
// Zero deps — Node 18+.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_DIR = join('plugins', 'golden-frijoles');
export const SUMS_FILE = 'SHA256SUMS';

function walk(root, dir, out) {
  for (const name of readdirSync(join(root, dir)).sort()) {
    const rel = join(dir, name);
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, out);
    else out.push(rel.split(sep).join('/'));
  }
  return out;
}

/** Every file under the plugin, as `{ path, sha256 }`, sorted by path. */
export function pluginChecksums(root = repoRoot) {
  return walk(root, PLUGIN_DIR, [])
    .sort()
    .map((path) => ({ path, sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') }));
}

export function renderSums(entries) {
  return entries.map(({ path, sha256 }) => `${sha256}  ${path}\n`).join('');
}

export function parseSums(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      if (!match) throw new Error(`${SUMS_FILE}: not a checksum line: ${line}`);
      return { sha256: match[1], path: match[2] };
    });
}

/**
 * Compare a release folder with a sums list. Every listed file must match, and the plugin folder must
 * hold nothing the list does not name — an added file is as much a change as an edited one.
 */
export function verifyRelease(dir, sumsText) {
  const expected = parseSums(sumsText);
  const actual = new Map(pluginChecksums(dir).map((entry) => [entry.path, entry.sha256]));
  const problems = [];
  for (const { path, sha256 } of expected) {
    if (!actual.has(path)) problems.push(`missing: ${path}`);
    else if (actual.get(path) !== sha256) problems.push(`changed: ${path}`);
    actual.delete(path);
  }
  for (const path of actual.keys()) problems.push(`not in the list: ${path}`);
  return { ok: problems.length === 0, problems };
}

function main(argv) {
  const sumsPath = join(repoRoot, SUMS_FILE);
  if (argv[0] === '--verify') {
    if (!argv[1]) {
      console.error('usage: plugin-checksums.mjs --verify <release folder>');
      return 2;
    }
    const { ok, problems } = verifyRelease(argv[1], readFileSync(sumsPath, 'utf8'));
    if (ok) console.log(`plugin-checksums: every file in ${argv[1]} matches ${SUMS_FILE}.`);
    else console.error(`plugin-checksums: ${argv[1]} does not match ${SUMS_FILE}:\n  ${problems.join('\n  ')}`);
    return ok ? 0 : 1;
  }
  const rendered = renderSums(pluginChecksums());
  if (argv[0] === '--check') {
    const current = existsSync(sumsPath) ? readFileSync(sumsPath, 'utf8') : '';
    if (current === rendered) return 0;
    console.error(`plugin-checksums: ${SUMS_FILE} is stale. Run: node scripts/plugin-checksums.mjs`);
    return 1;
  }
  writeFileSync(sumsPath, rendered);
  console.log(`plugin-checksums: wrote ${relative(process.cwd(), sumsPath) || SUMS_FILE}.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
