#!/usr/bin/env node
// intent-outcomes.mjs — does the intent score predict anything? One row per scored epic, across repos (intent-match
// S3.2, D18).
//
//   node scripts/intent-outcomes.mjs                                  this repo
//   node scripts/intent-outcomes.mjs --repo . --repo ../other-project  every repo on the same Roadmap layout
//   node scripts/intent-outcomes.mjs --json                           the rows as JSON
//
// Each row joins three things, all read from files:
//   the SCORE      the epic README's `intent_match:`, else its seed's, else the repo's backfill record
//                  (`Roadmap/00-ideas/intent-backfill.json`, D19) — and whether the ask was verbatim or a proxy
//   the ANSWER     the retrospective's `_Intent: yes | mostly | no_` — the product owner's word, the label
//   CORRECTIONS    DERIVED, never self-reported: stories added after the scaffold (the README's `stories_total`
//                  now vs. in the commit that added it), dated amendments (`Amended YYYY-MM-DD`), disproved scope
//                  (`disprov…`). A plan that needed correcting is evidence the score can be checked against.
//
// The footer says how close the data is to the twenty answered epics the calibration waits for ("n of 20"). This
// reports; it fits nothing (the intent-match no-go) and it gates nothing.
//
// git is only used to read the README as first committed. Its environment is SEALED (GIT_* stripped): run from a
// hook in a linked worktree, an inherited GIT_DIR would point every `git -C <other repo>` at THIS repository.
// Zero deps — Node 18+.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CALIBRATION_N = 20;
export const BACKFILL_PATH = join('Roadmap', '00-ideas', 'intent-backfill.json');

/** Flat frontmatter, comment- and quote-stripped (the epic-dod rule). Pure. */
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''));
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const score = (v) => (/^\d{1,3}$/.test(String(v ?? '')) && Number(v) <= 100 ? Number(v) : null);

/**
 * The answer — the SAME rule as `epic-dod.mjs`'s `intentAnswer` (a spec pins the two together): comments stripped, a
 * line that is exactly `_Intent: yes_` · `_mostly_` · `_no_`. Pure.
 */
export function intentAnswer(retro) {
  const text = String(retro ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const m = /^_Intent:\s*(yes|mostly|no)\s*_\s*$/im.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** Corrections derivable from the README alone. Pure. `firstReadme` is the README as first committed, or null. */
export function corrections(readme, firstReadme) {
  const now = Number(frontmatter(readme).stories_total);
  const then = firstReadme == null ? NaN : Number(frontmatter(firstReadme).stories_total);
  return {
    storiesAdded: Number.isFinite(now) && Number.isFinite(then) ? Math.max(0, now - then) : null,
    amendments: (String(readme).match(/\bAmended \d{4}-\d{2}-\d{2}\b/gi) ?? []).length,
    disproved: (String(readme).match(/\bdisprov\w*/gi) ?? []).length,
  };
}

/** The backfill record, or [] when there is none. A MALFORMED record throws: evidence tooling fails closed. */
export function parseBackfill(text, where = BACKFILL_PATH) {
  if (text == null) return [];
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`${where}: not JSON (${e.message})`);
  }
  if (!Array.isArray(json?.epics)) throw new Error(`${where}: needs an "epics" array`);
  return json.epics.map((e, i) => {
    if (typeof e?.slug !== 'string' || score(e.score) == null)
      throw new Error(`${where}: epics[${i}] needs a slug and a whole-number score 0–100`);
    return { slug: e.slug, score: Number(e.score), ask: e.ask === 'verbatim' ? 'verbatim' : 'proxy' };
  });
}

/**
 * One repo's rows. Pure over its inputs: epics = [{ slug, macro, readme, firstReadme, seed, retro }], backfill =
 * parseBackfill(). Only SCORED epics get a row (D18).
 */
export function rowsFor(repo, epics, backfill = []) {
  const back = new Map(backfill.map((b) => [b.slug, b]));
  // A backfill slug with no epic folder (a typo, a renamed epic) would silently shrink the table: fail closed.
  const known = new Set(epics.map((e) => e.slug));
  const orphans = backfill.filter((b) => !known.has(b.slug)).map((b) => b.slug);
  if (orphans.length)
    throw new Error(
      `${repo}: intent-backfill.json names epics with no Roadmap folder: ${orphans.join(', ')}`
    );
  const rows = [];
  for (const e of epics) {
    const rfm = frontmatter(e.readme);
    const sfm = frontmatter(e.seed ?? '');
    const b = back.get(e.slug);
    const from =
      score(rfm.intent_match) != null
        ? 'readme'
        : score(sfm.intent_match) != null
          ? 'seed'
          : b
            ? 'backfill'
            : null;
    if (!from) continue;
    const value =
      from === 'readme' ? score(rfm.intent_match) : from === 'seed' ? score(sfm.intent_match) : b.score;
    const ask =
      from === 'backfill'
        ? b.ask
        : sfm.intent_ask === 'verbatim'
          ? 'verbatim'
          : sfm.intent_ask === 'proxy'
            ? 'proxy'
            : 'unknown';
    const c = corrections(e.readme, e.firstReadme);
    rows.push({
      repo,
      epic: e.slug,
      macro: e.macro,
      status: rfm.status ?? null,
      score: value,
      source: from,
      ask,
      answer: intentAnswer(e.retro),
      ...c,
      corrected: (c.storiesAdded ?? 0) + c.amendments + c.disproved > 0,
    });
  }
  return rows;
}

/** The footer: how many rows are labelled, of the twenty the calibration waits for. Pure. */
export function summary(rows, repoCount) {
  const answered = rows.filter((r) => r.answer);
  const proxy = answered.filter((r) => r.ask === 'proxy').length;
  const waiting = rows.filter((r) => !r.answer && r.status === 'shipped').length;
  return {
    scored: rows.length,
    answered: answered.length,
    proxy,
    waiting,
    line:
      `${answered.length} of ${CALIBRATION_N}: ${answered.length} scored epic(s) answered (${proxy} with a proxy ask), ` +
      `${rows.length} scored across ${repoCount} repo(s); ${waiting} shipped but unanswered. ` +
      (answered.length >= CALIBRATION_N
        ? 'Enough to fit the thresholds.'
        : `Thresholds are fitted at ${CALIBRATION_N}.`),
  };
}

export function formatTable(rows) {
  const head = ['repo', 'epic', 'score', 'ask', 'answer', '+stories', 'amended', 'disproved'];
  const body = rows.map((r) => [
    r.repo,
    r.epic,
    String(r.score),
    r.ask === 'proxy' ? 'proxy ⚑' : r.ask,
    r.answer ?? '—',
    r.storiesAdded == null ? '?' : String(r.storiesAdded),
    String(r.amendments),
    String(r.disproved),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) =>
    cells
      .map((c, i) => c.padEnd(w[i]))
      .join('  ')
      .trimEnd();
  return [line(head), ...body.map(line)].join('\n');
}

// ── I/O ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** process.env without GIT_DIR and friends — see the header. */
export function sealedEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (/^GIT_/.test(k)) delete out[k];
  return out;
}

/** The README exactly as the commit that ADDED it wrote it, or null (no git, never committed, unreadable). */
export function firstCommitted(repoDir, relPath, exec = spawnSync) {
  const git = (args) => exec('git', ['-C', repoDir, ...args], { encoding: 'utf8', env: sealedEnv() });
  const log = git(['log', '--diff-filter=A', '--format=%H', '--', relPath]);
  if (log.status !== 0) return null;
  const sha = String(log.stdout).trim().split('\n').filter(Boolean).pop();
  if (!sha) return null;
  const show = git(['show', `${sha}:${relPath}`]);
  return show.status === 0 ? String(show.stdout) : null;
}

/** Every epic under <repo>/Roadmap/<macro>/<slug>/README.md, with its seed and retro. */
export function readRepo(repoDir, { exec = spawnSync } = {}) {
  const roadmap = join(repoDir, 'Roadmap');
  if (!existsSync(roadmap)) throw new Error(`${repoDir}: no Roadmap/ — not a repo on this layout`);
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  const epics = [];
  for (const macro of readdirSync(roadmap, { withFileTypes: true })) {
    if (!macro.isDirectory() || macro.name === '00-ideas') continue;
    for (const ep of readdirSync(join(roadmap, macro.name), { withFileTypes: true })) {
      if (!ep.isDirectory()) continue;
      const readmePath = join(roadmap, macro.name, ep.name, 'README.md');
      const readme = read(readmePath);
      if (readme == null) continue;
      epics.push({
        slug: ep.name,
        macro: macro.name,
        readme,
        seed: read(join(roadmap, '00-ideas', 'seeds', `${ep.name}.md`)),
        retro: read(join(roadmap, macro.name, ep.name, 'RETROSPECTIVE.md')),
        readmePath: relative(repoDir, readmePath),
      });
    }
  }
  const backfill = parseBackfill(
    read(join(repoDir, BACKFILL_PATH)),
    join(basename(resolve(repoDir)), BACKFILL_PATH)
  );
  // Only a scored epic's first commit is worth a git call.
  const scoredSlugs = new Set(rowsFor('', epics, backfill).map((r) => r.epic));
  for (const e of epics)
    e.firstReadme = scoredSlugs.has(e.slug) ? firstCommitted(repoDir, e.readmePath, exec) : null;
  return { epics, backfill };
}

export function parseArgs(argv) {
  const repos = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') repos.push(argv[++i]);
    else if (argv[i] === '--json') json = true;
    else return { error: `unknown argument ${argv[i]}` };
  }
  if (repos.some((r) => !r)) return { error: '--repo needs a path' };
  return { repos: repos.length ? repos : ['.'], json };
}

export function run(argv, io = {}) {
  const { out = (t) => process.stdout.write(t), err = (t) => process.stderr.write(t), read = readRepo } = io;
  const args = parseArgs(argv);
  if (args.error) {
    err(
      `intent-outcomes: ${args.error}\nusage: node scripts/intent-outcomes.mjs [--repo <path>]... [--json]\n`
    );
    return 1;
  }
  const rows = [];
  for (const r of args.repos) {
    let data;
    try {
      data = read(r);
    } catch (e) {
      // One unreadable repo is "could not look" for the whole report: a table that silently drops a repo would
      // report a smaller n as if it were the whole of it.
      err(`intent-outcomes: could not look — ${e.message}\n`);
      return 2;
    }
    rows.push(...rowsFor(basename(resolve(r)), data.epics, data.backfill));
  }
  const s = summary(rows, args.repos.length);
  if (args.json) out(`${JSON.stringify({ rows, ...s }, null, 2)}\n`);
  else
    out(
      `${rows.length ? formatTable(rows) : '(no scored epics yet)'}\n\n${s.line}\n⚑ = the ask is a proxy (D8): weigh or drop it when fitting.\n`
    );
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = run(process.argv.slice(2));
