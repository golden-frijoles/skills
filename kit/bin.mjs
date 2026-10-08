#!/usr/bin/env node
// frijoles-kit — run one of the Golden Frijoles skills' scripts in the current project (golden-frijoles-plugin D1–D3).
//
//   frijoles-kit <name> [args…]        run dist/<name>.mjs against the project you're standing in
//   frijoles-kit --root <dir> <name>   …against <dir> instead (exported to the script as GF_PROJECT_ROOT)
//   frijoles-kit --list                the scripts this kit carries
//   frijoles-kit --version
//
// The script is SPAWNED, never imported: every entry guards `main()` behind an isMain check on process.argv[1]
// and several end with process.exit, so an import() would silently run nothing. stdio, the exit code and a
// terminating signal all pass through untouched. Zero dependencies.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, 'dist');

export function listScripts(dist = DIST) {
  if (!existsSync(dist)) return [];
  return readdirSync(dist)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .map((f) => f.slice(0, -'.mjs'.length))
    .sort();
}

/** Pure — split frijoles-kit's own flags from the script's. Only flags BEFORE the script name belong to frijoles-kit. */
export function parseArgs(argv) {
  const out = { root: null, list: false, version: false, help: false, name: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (out.name === null) {
      if (a === '--root') {
        out.root = argv[++i] ?? '';
        continue;
      }
      if (a.startsWith('--root=')) {
        out.root = a.slice('--root='.length);
        continue;
      }
      if (a === '--list') out.list = true;
      else if (a === '--version' || a === '-v') out.version = true;
      else if (a === '--help' || a === '-h') out.help = true;
      else out.name = a;
      continue;
    }
    out.rest.push(a);
  }
  return out;
}

const USAGE = 'usage: frijoles-kit [--root <dir>] <script> [args…]   ·   frijoles-kit --list   ·   frijoles-kit --version';

/**
 * plugin-1-0 D2 — started as the old name `gf-kit`? One line on stderr (stdout is a script's own output, often parsed),
 * until the date `scripts/check-deprecations.mjs` enforces. Pure, so the test pins it.
 */
export function deprecatedNameNotice(invokedPath) {
  const name = String(invokedPath ?? '').split(/[\\/]/).pop() ?? '';
  if (name.replace(/\.(cmd|ps1|js|mjs|cjs)$/i, '') !== 'gf-kit') return null;
  return 'gf-kit is now frijoles-kit. gf-kit stops working on 2026-12-31 (or in kit 1.1.0).\n';
}

function main(argv) {
  const args = parseArgs(argv);
  const scripts = listScripts();
  if (args.version) {
    process.stdout.write(`${JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version}\n`);
    return 0;
  }
  if (args.list) {
    process.stdout.write(`${scripts.join('\n')}\n`);
    return 0;
  }
  if (args.help || !args.name) {
    process.stdout.write(`${USAGE}\n`);
    return args.help ? 0 : 2;
  }
  if (args.root === '') {
    process.stderr.write('frijoles-kit: --root needs a directory\n');
    return 2;
  }
  // A plain name from the list only — never a path, so nothing outside dist/ can be reached through it.
  if (!scripts.includes(args.name)) {
    process.stderr.write(`frijoles-kit: no script "${args.name}". This kit carries:\n  ${scripts.join('\n  ')}\n`);
    return 2;
  }
  const env = { ...process.env };
  if (args.root !== null) {
    // ABSOLUTE, resolved once here: scripts spawn siblings with `cwd: <project>`, and a relative root would be
    // re-resolved against that cwd in every child (fresh review of #45: pmo-report read zero rows, silently).
    const root = resolve(args.root);
    if (!existsSync(root)) {
      process.stderr.write(`frijoles-kit: --root ${args.root}: no such directory\n`);
      return 2;
    }
    env.GF_PROJECT_ROOT = root;
  }
  const run = spawnSync(process.execPath, [join(DIST, `${args.name}.mjs`), ...args.rest], { stdio: 'inherit', env });
  if (run.error) {
    process.stderr.write(`frijoles-kit: could not start ${args.name}: ${run.error.message}\n`);
    return 1;
  }
  if (run.signal) process.kill(process.pid, run.signal);
  return run.status ?? 1;
}

// npm installs `frijoles-kit` as a symlink in node_modules/.bin, so compare real paths on both sides.
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const notice = deprecatedNameNotice(process.argv[1]);
  if (notice) process.stderr.write(notice);
  process.exitCode = main(process.argv.slice(2));
}
