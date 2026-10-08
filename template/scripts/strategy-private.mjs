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

export const COMMENT_LINE = `# Strategy files are the maker's own. To commit them, change the next line to ${OPT_IN_LINE}`;

/**
 * True when `.gitignore` text carries an opt-in in any spelling git honours (`!Roadmap/00-strategy`, `!/…/`, `!…/**`),
 * or when our own comment is there but the line under it was deleted: both are a maker saying "commit it", and a later
 * coach must never undo either (review of #315). A negation in a NESTED .gitignore is caught by git itself in
 * readFacts (`negatedBy`), not here.
 */
export function hasOptIn(gitignore) {
  const lines = String(gitignore ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim());
  const folder = IGNORE_LINE.replace(/\/$/, '');
  const norm = (l) => l.replace(/^!\/?/, '').replace(/\/(\*\*?)?$/, '');
  if (lines.some((l) => l.startsWith('!') && norm(l) === folder)) return true;
  const at = lines.indexOf(COMMENT_LINE);
  return at !== -1 && !lines.slice(at + 1).some((l) => !l.startsWith('!') && norm(l) === folder);
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
    line: `Strategy files: kept out of git because ${why} (added \`${IGNORE_LINE}\` to .gitignore). To commit them instead, delete that line or change it to \`${OPT_IN_LINE}\`.`,
  };
}

/** Pure — `.gitignore` with the folder appended, keeping whatever was there. */
export function appendIgnore(text) {
  const base = String(text ?? '');
  const sep = base === '' || base.endsWith('\n') ? '' : '\n';
  return `${base}${sep}${COMMENT_LINE}\n${IGNORE_LINE}\n`;
}

/**
 * Run git against `root` only. A hook exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE, and git obeys them over `-C`:
 * left in, a coach run from a hook would check the OUTER repo and could leave a public one unprotected (review of
 * #315; LEARNINGS 2026-10-06 on hooks retargeting git).
 */
function git(root, args, env) {
  const clean = { ...env };
  delete clean.GIT_DIR;
  delete clean.GIT_WORK_TREE;
  delete clean.GIT_INDEX_FILE;
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: clean });
}

/** The facts `decide` needs, read from the repo. `gh` failing for any reason reads as 'unknown'. */
export function readFacts(root, { run = spawnSync, env = process.env } = {}) {
  const isRepo = git(root, ['rev-parse', '--is-inside-work-tree'], env).stdout.trim() === 'true';
  if (!isRepo) return { isRepo };
  const gitignorePath = join(root, '.gitignore');
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const tracked = git(root, ['ls-files', '--', IGNORE_LINE], env).stdout.split('\n').filter(Boolean).length;
  const probe = `${IGNORE_LINE}probe.md`;
  const ignored = git(root, ['check-ignore', '-q', '--no-index', probe], env).status === 0;
  // `-v -n` names the rule that decides the probe even when it is a negation: a `!` rule anywhere, in any
  // .gitignore, is the maker un-ignoring the folder on purpose.
  const negatedBy = git(root, ['check-ignore', '-v', '-n', '--no-index', probe], env).stdout.split('\t')[0];
  // A nested `!` that re-includes the folder can leave git naming no rule at all; the root .gitignore listing the
  // folder while git says it is NOT ignored means the same thing: something un-ignores it on purpose.
  const folder = IGNORE_LINE.replace(/\/$/, '');
  const listed = gitignore.split(/\r?\n/).some(
    (l) =>
      l
        .trim()
        .replace(/^\//, '')
        .replace(/\/(\*\*?)?$/, '') === folder
  );
  const negated = /^[^:]+:\d+:!/.test(negatedBy) || (listed && !ignored);
  const gh = run('gh', ['repo', 'view', '--json', 'visibility', '-q', '.visibility'], {
    cwd: root,
    encoding: 'utf8',
  });
  const raw = gh.status === 0 ? String(gh.stdout).trim().toLowerCase() : '';
  const visibility = ['public', 'private', 'internal'].includes(raw) ? raw : 'unknown';
  return {
    isRepo,
    visibility,
    tracked,
    ignored,
    optedIn: negated || hasOptIn(gitignore),
    gitignorePath,
    gitignore,
  };
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
