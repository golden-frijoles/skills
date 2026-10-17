#!/usr/bin/env node
// check-is-main.mjs — every shipped rail decides "was I run directly?" through lib/is-main.mjs, and nothing else
// (template-scripts-consumer-gates D5).
//
// A hand-rolled check that compares `process.argv[1]` with `import.meta.url` lexically is false when the script is
// reached through a symlinked path (macOS /tmp → /private/tmp, a symlinked checkout), and the script does nothing and
// exits 0. 59 entries spelled it six ways, 34 of them that way. They all call `isMain(import.meta.url)` now, so one
// rule covers every spelling: outside an is-main.mjs, a line that reads `process.argv[1]` with `import.meta.url` within
// three lines of it, or calls `.endsWith(` on it, is a finding.
//
// Scanned: template/scripts, template/optional and plugins/ (vendor/ too: those copies ship). Not scanned: tests,
// this repo's own scripts/ (no consumer runs them) and kit/bin.mjs (already realpath on both sides).
//
// Zero deps. `node scripts/check-is-main.mjs` (CI). Exit 0 clean, 1 a finding, 2 could not look.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SCAN_DIRS = ['template/scripts', 'template/optional', 'plugins'];
export const OWNER = 'is-main.mjs';
const WINDOW = 3;

const ARGV1 = /\bprocess\.argv\[1\]/;
const META = /\bimport\.meta\.url\b/;
const ENDS_WITH = /\bprocess\.argv\[1\]\??\.endsWith\(/;

/** A line with its comment removed; a JSDoc/block-comment continuation line becomes empty. */
function code(line) {
  if (/^\s*(\*|\/\*)/.test(line)) return '';
  return line.replace(/\/\/.*$/, '');
}

/** Pure — the hand-rolled entry checks in one file (1-based lines). */
export function scan(rel, text) {
  if (basename(rel) === OWNER) return [];
  const lines = text.split('\n').map(code);
  const hits = [];
  lines.forEach((line, i) => {
    if (!ARGV1.test(line)) return;
    const near = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1);
    if (ENDS_WITH.test(line) || near.some((l) => META.test(l))) hits.push({ rel, line: i + 1, text: text.split('\n')[i].trim() });
  });
  return hits;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.mjs') && !name.endsWith('.test.mjs') && !name.includes('test-fixture')) out.push(full);
  }
  return out;
}

export function main({ root = repoRoot, dirs = SCAN_DIRS, log = console.log, error = console.error } = {}) {
  const missing = dirs.filter((d) => !existsSync(join(root, d)));
  if (missing.length) {
    error(`check-is-main: could not look: ${missing.join(', ')} not found under ${root}`);
    return 2;
  }
  const hits = dirs.flatMap((d) =>
    walk(join(root, d)).flatMap((abs) => scan(relative(root, abs).split(sep).join('/'), readFileSync(abs, 'utf8')))
  );
  if (!hits.length) {
    log('check-is-main: clean. Every shipped rail decides "run directly?" through lib/is-main.mjs.');
    return 0;
  }
  error(`check-is-main: ${hits.length} hand-rolled entry check(s):\n`);
  for (const h of hits) error(`  ${h.rel}:${h.line}  ${h.text}`);
  error(
    "\n  Use `if (isMain(import.meta.url))`, importing isMain from lib/is-main.mjs (the plugin's own scripts: from" +
      "\n  ./vendor/lib/is-main.mjs). A lexical compare is false behind a symlink, and the script then exits 0 having" +
      '\n  done nothing.'
  );
  return 1;
}

if (isMain(import.meta.url)) process.exitCode = main();
