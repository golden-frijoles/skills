#!/usr/bin/env node
// render-prettier-block.mjs — generate template/.prettierignore, the rails' block `frijoles-kit init` merges into a
// project's own .prettierignore (template-scripts-consumer-gates D3).
//
//   node scripts/render-prettier-block.mjs           # (re)write template/.prettierignore
//   node scripts/render-prettier-block.mjs --check   # exit 1 when it is stale
//
// The block lists every file a project copies from template/scripts that Prettier would format (.mjs, .mts, .json,
// .html), as `scripts/<rel>`. Generated, never hand-kept: a hand list goes stale the first time a rail is added, and
// then the consumer's format check fails on exactly the file the block exists to cover. The markers and the
// block's shape live in init.mjs (one copy, read by init itself).
//
// Zero deps — Node 18+.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPrettierBlock } from '../template/scripts/init.mjs';
import { isMain } from './lib/is-main.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPTS_DIR = join(repoRoot, 'template', 'scripts');
export const TARGET = join(repoRoot, 'template', '.prettierignore');
const FORMATTED = /\.(mjs|mts|json|html)$/;

/** The `scripts/`-relative rail paths Prettier would format. */
export function railPaths(dir = SCRIPTS_DIR, base = dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      if (name === 'node_modules') return [];
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return railPaths(full, base);
      return FORMATTED.test(name) ? [relative(base, full).split(sep).join('/')] : [];
    });
}

export function render(paths = railPaths()) {
  return `${renderPrettierBlock(paths)}\n`;
}

if (isMain(import.meta.url)) {
  const out = render();
  if (process.argv.includes('--check')) {
    const committed = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
    if (committed !== out) {
      console.error('template/.prettierignore is stale — run: node scripts/render-prettier-block.mjs (from skills/)');
      process.exit(1);
    }
    console.log('template/.prettierignore matches template/scripts/.');
  } else {
    writeFileSync(TARGET, out);
    console.log(`wrote template/.prettierignore (${out.split('\n').length - 3} rail path(s)).`);
  }
}
