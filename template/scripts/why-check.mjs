#!/usr/bin/env node
// why-check.mjs — does this Why read in full and in plain words? (why-as-a-story D2)
//
//   node scripts/why-check.mjs "<the Why>"         check a sentence
//   node scripts/why-check.mjs --seed <seed.md>    check a seed's (or an epic README's) `hypothesis`
//
// Exit 0: it fits the build view and reads as plain words. Exit 1: the problems, one per line. Exit 2: usage.
// Whether it reads as a STORY is a judgment, asked by intent-match (advisory); this checks only what a script can tell.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseDocFrontmatter,
  whyProblems,
  wrapWords,
  WHY_LINES_MAX,
  WHY_ROOM,
} from './lib/roadmap-contract.mjs';

const USAGE = 'usage: why-check "<the Why>" | why-check --seed <seed.md>';

/** argv → { text } | { error }. Pure, except reading the seed file it names. */
export function whyFromArgs(argv, read = (p) => readFileSync(p, 'utf8')) {
  if (argv[0] === '--seed') {
    if (!argv[1]) return { error: USAGE };
    let md;
    try {
      md = read(argv[1]);
    } catch (e) {
      return { error: `why-check: cannot read ${argv[1]} (${e.code ?? e.message})` };
    }
    const { data } = parseDocFrontmatter(md);
    const text = data?.hypothesis;
    if (text === undefined || text === null || text === 'null')
      return { error: `why-check: ${argv[1]} has no hypothesis` };
    return { text: String(text) };
  }
  if (argv.length !== 1 || argv[0].startsWith('--')) return { error: USAGE };
  return { text: argv[0] };
}

export function main(argv, out = process.stdout, err = process.stderr) {
  const parsed = whyFromArgs(argv);
  if (parsed.error) {
    err.write(`${parsed.error}\n`);
    return 2;
  }
  const problems = whyProblems(parsed.text);
  if (problems.length) {
    out.write(`The Why needs another pass:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    return 1;
  }
  const lines = wrapWords(parsed.text, WHY_ROOM, Infinity).length;
  out.write(`The Why reads in full (${lines} of ${WHY_LINES_MAX} lines) and in plain words.\n`);
  return 0;
}

const isMain = (() => {
  try {
    return (
      !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (isMain) process.exit(main(process.argv.slice(2)));
