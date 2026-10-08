#!/usr/bin/env node
// check-config-reads.mjs — after golden-frijoles-plugin S4.2, no template rail reads its config file directly.
//
// Every rail now asks lib/config.mjs for its section, which lays golden-frijoles.config.json over the legacy file
// (D9). A rail that goes back to `JSON.parse(readFileSync('review-config.json'))` would silently ignore the new file,
// so a user's `frijoles config set` would stop reaching it. This guard fails on that, in template/scripts/ (X16: consumer
// forks keep their own reads, by design, and are not scanned).
//
// What counts as a direct read: a read (readFileSync / read) whose argument names one of the seven legacy config
// files, or one of the rails' config-path constants. Only lib/config.mjs may do that.
//
// Zero deps. `node scripts/check-config-reads.mjs` (CI). Exit 1 on a direct read.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOT = join(repoRoot, 'template', 'scripts');
export const OWNER = 'lib/config.mjs';

const LEGACY_FILES = [
  'jev\\.config\\.json',
  'reporting\\.config\\.json',
  'live-smoke\\.config\\.json',
  'smoke-triage\\.config\\.json',
  'perf-probe\\.config\\.json',
  'review-config\\.json',
  'fill-ins\\.yml',
];
const PATH_CONSTANTS = ['CONFIG_PATH', 'POLICY_PATH', 'REVIEW_CONFIG_PATH', 'FILLINS_PATH'];

export const RULES = [
  // read(… 'review-config.json' …) / readFileSync(join(__dirname, 'jev.config.json'))
  new RegExp(`\\b(readFileSync|read)\\(\\s*[^)]*['"\`](?:[^'"\`]*/)?(?:${LEGACY_FILES.join('|')})['"\`]`),
  // readFileSync(CONFIG_PATH …) — a rail's own config-path constant read directly
  new RegExp(`\\b(readFileSync|read)\\(\\s*(?:${PATH_CONSTANTS.join('|')})\\b`),
];

/**
 * Each converted rail and the loader call it must make. The patterns above catch a literal filename or a known
 * constant; this catches the REST of the ways a rail could go back to reading its file (a `path` variable, a
 * helper): if the call to the loader is gone, the rail is reading its config some other way (review of #49 —
 * the patterns alone missed 6 of the 8 original reads).
 */
export const RAILS = Object.freeze({
  'lib/jev.mjs': "readSection('jev'",
  'lib/reporting-config.mjs': "readSection('reporting'",
  'live-smoke.mjs': "readSection('smoke'",
  'smoke-triage-scope.mjs': "readSection('smoke.triage'",
  'perf-probe.mjs': "readSection('smoke.perf'",
  'review-route.mjs': "readSection('review'",
  'cross-review.mjs': "readSection('review'",
  'render-ways-of-working.mjs': "readSection('ways'",
});

/** Pure — a registered rail that no longer calls the loader, as a finding (or null). */
export function missingLoader(rel, text) {
  const call = RAILS[rel];
  return call && !text.includes(call) ? { rel, line: 0, text: `does not call ${call}…) any more` } : null;
}

/** Pure — the offending lines of one file (1-based), skipping comments. */
export function scan(rel, text) {
  if (rel === OWNER) return [];
  const hits = [];
  text.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/^\s*\*/.test(code)) return;
    if (RULES.some((re) => re.test(code))) hits.push({ rel, line: i + 1, text: line.trim() });
  });
  return hits;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.mjs') && !name.endsWith('.test.mjs') && !name.includes('test-fixture')) out.push(full);
  }
  return out;
}

function main() {
  const hits = walk(SCAN_ROOT).flatMap((abs) => {
    const rel = relative(SCAN_ROOT, abs);
    const text = readFileSync(abs, 'utf8');
    const gone = missingLoader(rel, text);
    return gone ? [gone, ...scan(rel, text)] : scan(rel, text);
  });
  // A registered rail that was deleted or renamed is a finding too: the table must keep describing the tree.
  for (const rel of Object.keys(RAILS)) {
    try {
      statSync(join(SCAN_ROOT, rel));
    } catch {
      hits.push({ rel, line: 0, text: 'is registered in RAILS but does not exist' });
    }
  }
  if (!hits.length) {
    console.log('check-config-reads: clean. Every template rail reads its config through lib/config.mjs.');
    return 0;
  }
  console.error(`check-config-reads: ${hits.length} direct config read(s) outside ${OWNER}:\n`);
  for (const h of hits) console.error(`  template/scripts/${h.rel}:${h.line}  ${h.text}`);
  console.error(
    `\n  Ask lib/config.mjs for the section instead (readSection('<section>', { legacyPath, onLegacyError })), so` +
      '\n  golden-frijoles.config.json keeps reaching this rail. Validation stays in the rail\'s own parser.'
  );
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith('check-config-reads.mjs')) process.exitCode = main();
