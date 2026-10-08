#!/usr/bin/env node
// strategy-private.mjs — keep the maker's strategy out of a public repo unless they chose to commit it (coaches-v2 D9).
//
//   node scripts/strategy-private.mjs ensure     decide, act at most once, print one line for the maker
//   node scripts/strategy-private.mjs check      the same decision, never writes
//
// ── Why ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The coaches write positioning, pricing and the riskiest assumption to `Roadmap/00-strategy/`. On a public repo the
// next `git add .` publishes them, and nothing asked (dogfood F2). So before a coach's first write this adds the
// folder to `.gitignore` when the repo is public, or when its visibility can't be read: "couldn't tell" must fail
// towards private, because the cost of a wrong guess is one-way.
//
// It never takes away a choice the maker already made:
//   • a file under the folder is already committed  → they commit strategy here; leave it
//   • `.gitignore` says `!Roadmap/00-strategy/`      → the explicit opt-in; leave it (a re-run must not undo it)
//   • the folder is already ignored                 → nothing to do
//
// Exit codes: 0 decided (whether or not it wrote) · 2 usage.
// Zero deps — Node 18+.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from './lib/project-root.mjs';
import { STRATEGY_DIR } from './lib/strategy-files.mjs';

export const IGNORE_LINE = `${STRATEGY_DIR.split('\\').join('/')}/`;
export const OPT_IN_LINE = `!${IGNORE_LINE}`;

/** True when `.gitignore` text carries the explicit opt-in, with or without a leading slash. */
export function hasOptIn(gitignore) {
  return String(gitignore ?? '')
    .split(/\r?\n/)
    .some((line) => line.trim().replace(/^!\//, '!') === OPT_IN_LINE);
}

/**
 * Pure — what to do. `visibility` is 'public' | 'private' | 'internal' | 'unknown'; `isRepo` false when there is no
 * git repository at all. Returns { write: boolean, line: string }.
 */
export function decide({ isRepo, visibility, tracked, ignored, optedIn }) {
  if (!isRepo)
    return {
      write: false,
      line: 'Strategy files: not a git repository, so there is nothing to keep out of git.',
    };
  if (optedIn)
    return {
      write: false,
      line: `Strategy files: you chose to commit them (\`${OPT_IN_LINE}\` in .gitignore).`,
    };
  if (tracked > 0)
    return {
      write: false,
      line: `Strategy files: ${tracked} already committed here, so they stay committed. To stop, run \`git rm -r --cached ${IGNORE_LINE}\` and add \`${IGNORE_LINE}\` to .gitignore.`,
    };
  if (ignored) return { write: false, line: 'Strategy files: already kept out of git.' };
  if (visibility === 'private' || visibility === 'internal')
    return {
      write: false,
      line: `Strategy files: this repo is ${visibility}, so they can be committed with it.`,
    };
  const why = visibility === 'public' ? 'this repo is public' : "this repo's visibility couldn't be read";
  return {
    write: true,
    line: `Strategy files: kept out of git because ${why} (added \`${IGNORE_LINE}\` to .gitignore). To commit them instead, change that line to \`${OPT_IN_LINE}\`.`,
  };
}

/** Pure — `.gitignore` with the folder appended, keeping whatever was there. */
export function appendIgnore(text) {
  const base = String(text ?? '');
  const sep = base === '' || base.endsWith('\n') ? '' : '\n';
  return `${base}${sep}# Strategy files are the maker's own. To commit them, change the next line to ${OPT_IN_LINE}\n${IGNORE_LINE}\n`;
}

function git(root, args, env) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env });
}

/** The facts `decide` needs, read from the repo. `gh` failing for any reason reads as 'unknown'. */
export function readFacts(root, { run = spawnSync, env = process.env } = {}) {
  const isRepo = git(root, ['rev-parse', '--is-inside-work-tree'], env).stdout.trim() === 'true';
  if (!isRepo) return { isRepo };
  const gitignorePath = join(root, '.gitignore');
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const tracked = git(root, ['ls-files', '--', IGNORE_LINE], env).stdout.split('\n').filter(Boolean).length;
  const ignored = git(root, ['check-ignore', '-q', '--no-index', `${IGNORE_LINE}probe.md`], env).status === 0;
  const gh = run('gh', ['repo', 'view', '--json', 'visibility', '-q', '.visibility'], {
    cwd: root,
    encoding: 'utf8',
  });
  const raw = gh.status === 0 ? String(gh.stdout).trim().toLowerCase() : '';
  const visibility = ['public', 'private', 'internal'].includes(raw) ? raw : 'unknown';
  return { isRepo, visibility, tracked, ignored, optedIn: hasOptIn(gitignore), gitignorePath, gitignore };
}

function main(argv) {
  const cmd = argv[0];
  if (cmd !== 'ensure' && cmd !== 'check') {
    process.stderr.write('usage: strategy-private.mjs ensure | check\n');
    return 2;
  }
  const facts = readFacts(projectRoot());
  const d = decide(facts);
  if (d.write && cmd === 'ensure') writeFileSync(facts.gitignorePath, appendIgnore(facts.gitignore));
  process.stdout.write(
    `${cmd === 'check' && d.write ? d.line.replace('kept out of git', 'would be kept out of git').replace('added', 'would add') : d.line}\n`
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = main(process.argv.slice(2));
