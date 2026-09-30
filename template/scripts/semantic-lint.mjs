#!/usr/bin/env node
// semantic-lint.mjs — deterministic selectors pick candidate hunks, Jev judges only those (semantic-lint D1–D9).
//
//   node scripts/semantic-lint.mjs                          the branch against @{upstream}, else origin/main
//   node scripts/semantic-lint.mjs --range <base>...<head>  what the pre-push hook passes, once per pushed ref
//
// Some rules cannot be a regex: "no parallel telemetry pipeline" (AGENTS rule 1) is broken by a usage table under
// another name, an analytics route or a vendor SDK call — paraphrases a regex either misses or flags on every read.
// So the regex only SELECTS (globs + added-line patterns − an allowlist, all data in `lint.rules`), and one Noul per
// selected hunk asks whether it actually breaks the rule. Most pushes select nothing and make no call at all.
//
// Four outcomes, never two (D2): raise, clear, uncertain, and NOT CHECKED — no key, egress off, a timeout, a malformed
// answer, an oversized hunk, past the candidate cap or the time budget. "Could not look" is printed and logged, and is
// never counted as clear.
//
// Raise-only: this adds findings; it never clears another check's finding, and it never blocks. v1 runs in `shadow`
// from the advisory pre-push hook: it logs every decision to .jev/decisions.jsonl as `lint:<rule id>` and prints one
// line per rule. Exit 0 always, except 2 for bad usage or a malformed config — a lint that cannot run must say so, and
// the hook still ignores the code.
//
// Zero deps — Node 18+.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSection } from './lib/config.mjs';
import { jevContext, LINT_THRESHOLD_KEY, loadJevConfig, repoRoot, textHash } from './lib/jev.mjs';
import { globToRegExp } from './lib/review-guard.mjs';

export const QUESTION_ID = 'violates';
export const SEVERITIES = ['blocking', 'should-fix', 'nit'];
/** A hunk this long is not sent (D2/D6): it is rarely one decision, and it is the most code to send off the machine. */
export const HUNK_CHAR_LIMIT = 6_000;
/** A push selecting more than this is a refactor, not a telemetry change; the rest are not checked, and say so. */
export const MAX_CANDIDATES = 20;
/** A git hook must stay a hook: nothing new starts after this, and what is left is not checked. */
export const TIME_BUDGET_MS = 60_000;
const CONCURRENCY = 4;

export class LintConfigError extends Error {}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isUnit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const RULE_KEYS = ['id', 'source', 'severity', 'globs', 'allowlist', 'patterns', 'question'];

/**
 * The `lint` section → rules with their selectors compiled. Pure; throws LintConfigError naming the problem, because a
 * typo in a glob or a pattern would otherwise select nothing and read as a clean push (CODE-QUALITY §7).
 * `null` (no section anywhere) is no rules.
 */
export function parseLintRules(raw) {
  if (raw === null || raw === undefined) return [];
  const fail = (m) => {
    throw new LintConfigError(`lint: ${m}`);
  };
  if (!isObj(raw)) fail('the section must be an object');
  const extra = Object.keys(raw).filter((k) => k !== 'rules' && !k.startsWith('$'));
  if (extra.length) fail(`unknown key(s): ${extra.join(', ')}`);
  if (raw.rules === undefined) return [];
  if (!Array.isArray(raw.rules)) fail('rules must be an array');
  const seen = new Set();
  const strings = (v, where, { nonEmpty }) => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x))
      fail(`${where} must be an array of strings`);
    if (nonEmpty && !v.length) fail(`${where} must not be empty`);
    return v;
  };
  return raw.rules.map((r, i) => {
    if (!isObj(r)) fail(`rules[${i}] must be an object`);
    const at = `rules[${i}]${typeof r.id === 'string' ? ` (${r.id})` : ''}`;
    const unknown = Object.keys(r).filter((k) => !RULE_KEYS.includes(k) && !k.startsWith('$'));
    if (unknown.length) fail(`${at}: unknown key(s): ${unknown.join(', ')}`);
    // The id is also a threshold key in jev.config.json (rails.lint.thresholds.<id>), so it obeys that key's shape.
    if (typeof r.id !== 'string' || !LINT_THRESHOLD_KEY.test(r.id) || r.id === 'default')
      fail(`${at}: id must be lowercase a-z, 0-9 and -, and not "default"`);
    if (seen.has(r.id)) fail(`${at}: duplicate id`);
    seen.add(r.id);
    if (typeof r.source !== 'string' || !r.source) fail(`${at}: source must name the rule it enforces`);
    if (!SEVERITIES.includes(r.severity)) fail(`${at}: severity must be one of ${SEVERITIES.join(' | ')}`);
    const globs = strings(r.globs, `${at}.globs`, { nonEmpty: true });
    const allowlist = strings(r.allowlist ?? [], `${at}.allowlist`, { nonEmpty: false });
    const patterns = strings(r.patterns, `${at}.patterns`, { nonEmpty: true }).map((p) => {
      try {
        return new RegExp(p, 'i');
      } catch (e) {
        return fail(`${at}.patterns: ${JSON.stringify(p)} is not a valid RegExp (${e.message})`);
      }
    });
    const q = r.question;
    if (
      !isObj(q) ||
      typeof q.instructions !== 'string' ||
      !q.instructions ||
      !isObj(q.criteria) ||
      typeof q.criteria.true !== 'string' ||
      typeof q.criteria.false !== 'string'
    )
      fail(`${at}.question must be { instructions, criteria: { true, false } }, all strings`);
    return {
      id: r.id,
      source: r.source,
      severity: r.severity,
      question: {
        instructions: q.instructions,
        criteria: { true: q.criteria.true, false: q.criteria.false },
      },
      match: { globs: globs.map(globToRegExp), allow: allowlist.map(globToRegExp), patterns },
    };
  });
}

/** The one Noul a rule asks, in the shape askJev sends. */
export const questionsFor = (rule) => ({ [QUESTION_ID]: { type: 'noul', ...rule.question } });

/** Pins a recording to the wording that produced it: an edited question must be re-measured, not replayed (D8). */
export const questionHash = (rule) =>
  // `source` is sent in the state beside the question, so it is part of what was measured (fresh review of #200).
  textHash(JSON.stringify({ questions: questionsFor(rule), source: rule.source }));

/**
 * `git diff` text → [{ file, hunks: [{ header, lines: [diff line], added: [line] }] }]. Pure. `lines` keep their +/-/space
 * prefix, as the diff shows them.
 */
export function parseDiff(diffText) {
  const files = [];
  let file = null;
  let hunk = null;
  for (const line of String(diffText).split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = null;
      hunk = null;
      continue;
    }
    // Only a header before the first `@@` is a file header: inside a hunk, an added line whose content starts with
    // `++ ` also reads `+++ …`, and taking it for a new file would drop the rest of the hunk.
    if (!hunk && line.startsWith('+++ ')) {
      // `+++ /dev/null` is a deletion: it adds nothing, so it selects nothing.
      const path = line.slice(4).replace(/\t.*$/, '');
      file = path === '/dev/null' ? null : { file: path.replace(/^b\//, ''), hunks: [] };
      if (file) files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('@@')) {
      hunk = { header: line, lines: [], added: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+')) hunk.added.push(line.slice(1));
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) hunk.lines.push(line);
  }
  return files;
}

/** Lines of a hunk kept around each matching added line. */
export const WINDOW = 15;

/**
 * What is sent for one candidate (D1/D6): the hunk's `@@` header and a window of WINDOW lines either side of each
 * matching added line, overlapping windows merged, gaps marked `…`. Not the whole hunk: a new file is ONE hunk, and
 * measured on 220 commits of this repo's history, 33 of 60 candidate hunks were over HUNK_CHAR_LIMIT — nearly every
 * new route and migration would have been "not checked". Pure.
 */
export function candidateText(hunk, isHit) {
  const keep = new Set();
  hunk.lines.forEach((l, i) => {
    if (!l.startsWith('+') || !isHit(l.slice(1))) return;
    for (let j = Math.max(0, i - WINDOW); j <= Math.min(hunk.lines.length - 1, i + WINDOW); j++) keep.add(j);
  });
  const out = [hunk.header];
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== prev + 1) out.push('…');
    out.push(hunk.lines[i]);
    prev = i;
  }
  if (prev < hunk.lines.length - 1) out.push('…');
  return out.join('\n');
}

/**
 * The deterministic half (D1): every hunk, per rule, in a file its globs match and its allowlist does not, with at
 * least one ADDED line a pattern matches. Removed and context lines never select — deleting a vendor call is not a
 * reason to ask. Duplicates (the same hunk reached through two pushed refs) collapse. Pure.
 */
export function selectCandidates(files, rules) {
  const out = [];
  const seen = new Set();
  for (const rule of rules)
    for (const { file, hunks } of files) {
      if (!rule.match.globs.some((re) => re.test(file))) continue;
      if (rule.match.allow.some((re) => re.test(file))) continue;
      for (const h of hunks) {
        const hits = rule.match.patterns
          .filter((re) => h.added.some((l) => re.test(l)))
          .map((re) => re.source);
        if (!hits.length) continue;
        const text = candidateText(h, (l) => rule.match.patterns.some((re) => re.test(l)));
        const key = `${rule.id}\0${file}\0${textHash(text)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ rule, file, hunk: text, hits });
      }
    }
  return out;
}

/** D2 — one statistic per rule. Only a probability in [0,1] is a verdict (LEARNINGS: `Number(true)` once passed). */
export function outcomeOf(p, threshold) {
  if (!isUnit(p)) return null;
  if (p >= threshold) return 'raise';
  // `1 - p >= t`, not `p <= 1 - t`: 1 - 0.8 is 0.19999…, which put p = 0.2 in the uncertain band.
  if (1 - p >= threshold) return 'clear';
  return 'uncertain';
}

/** A rule's threshold: its own key in rails.lint.thresholds, else `default`. */
export const thresholdFor = (rail, ruleId) => rail.thresholds[ruleId] ?? rail.thresholds.default;

/**
 * Ask about one candidate. Never throws (askJev does not, and a non-probability is not-checked).
 * Returns { outcome: raise|clear|uncertain|not-checked, p, error }.
 */
export async function judgeCandidate(c, { ask, threshold }) {
  const res = await ask({
    state: { rule: c.rule.id, source: c.rule.source, file: c.file, hunk: c.hunk },
    questions: questionsFor(c.rule),
  });
  if (!res?.ok) return { outcome: 'not-checked', p: null, error: res?.error ?? 'no response' };
  const raw = res.answers?.[QUESTION_ID]?.noul;
  const outcome = outcomeOf(raw, threshold);
  if (!outcome) return { outcome: 'not-checked', p: null, error: `invalid noul (${JSON.stringify(raw)})` };
  return { outcome, p: Math.round(raw * 1000) / 1000, error: null };
}

/** The reason a person reads. `no key` is the words the smoke walkthrough and the hook's users look for. */
const reasonFor = (why) => (why === 'no TYPESAFE_API_KEY' ? 'no key' : why);

/**
 * Judge every candidate under the caps and the budget (D2), log each decision (D7). Returns the results in candidate
 * order. `notChecked` (a reason) short-circuits every call: Jev could not legitimately be asked at all.
 */
export async function judgeAll(
  candidates,
  { ask, log, rail, mode, sha, notChecked = null, now = Date.now, budgetMs = TIME_BUDGET_MS }
) {
  const deadline = now() + budgetMs;
  const results = new Array(candidates.length);
  const judgeOne = async (i) => {
    const c = candidates[i];
    let r;
    if (notChecked) r = { outcome: 'not-checked', p: null, error: notChecked };
    else if (i >= MAX_CANDIDATES)
      r = { outcome: 'not-checked', p: null, error: `over the ${MAX_CANDIDATES}-candidate cap` };
    else if (c.hunk.length > HUNK_CHAR_LIMIT)
      r = { outcome: 'not-checked', p: null, error: `hunk over ${HUNK_CHAR_LIMIT} chars (${c.hunk.length})` };
    else if (now() >= deadline)
      r = { outcome: 'not-checked', p: null, error: `time budget (${budgetMs / 1000}s) spent` };
    else r = await judgeCandidate(c, { ask, threshold: thresholdFor(rail, c.rule.id) });
    results[i] = r;
    log({
      rail: `lint:${c.rule.id}`,
      mode,
      decider: r.outcome === 'not-checked' ? 'not-checked' : 'jev',
      regex: null,
      jev: r.outcome === 'not-checked' ? null : r.outcome === 'raise',
      confidence: r.p,
      text: c.hunk,
      source: `${c.file}@${sha ?? 'unknown'}`,
      evidence: { file: c.file, outcome: r.outcome, hits: c.hits },
      error: r.error,
    });
  };
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) await judgeOne(next++);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));
  return results;
}

/** D9 — one line per rule, plus one finding line per raise in `jev` mode. Pure. */
export function summarize(candidates, results, { mode }) {
  const lines = [];
  const byRule = new Map();
  candidates.forEach((c, i) => {
    if (!byRule.has(c.rule.id)) byRule.set(c.rule.id, []);
    byRule.get(c.rule.id).push({ c, r: results[i] });
  });
  for (const [id, rows] of byRule) {
    const of = (o) => rows.filter((x) => x.r.outcome === o);
    const raised = of('raise');
    const nc = of('not-checked');
    if (nc.length === rows.length) {
      const reasons = [...new Set(nc.map((x) => reasonFor(x.r.error)))];
      lines.push(
        `semantic-lint: not checked (${reasons.join('; ')}) — lint:${id}, ${rows.length} candidate(s) logged, none judged`
      );
      continue;
    }
    const parts = [];
    if (raised.length)
      parts.push(
        `${raised.length} ${mode === 'jev' ? 'raised' : 'would raise'} (${raised.map((x) => `p=${x.r.p} ${x.c.file}`).join(', ')})`
      );
    for (const o of ['uncertain', 'clear']) if (of(o).length) parts.push(`${of(o).length} ${o}`);
    if (nc.length)
      parts.push(
        `${nc.length} not checked (${[...new Set(nc.map((x) => reasonFor(x.r.error)))].join('; ')})`
      );
    const tail = mode === 'jev' ? 'logged' : 'logged, not shown as findings';
    lines.push(
      `semantic-lint (${mode}): lint:${id} — ${rows.length} candidate(s): ${parts.join(', ')} · ${tail}`
    );
    if (mode === 'jev')
      for (const { c, r } of raised)
        lines.push(`  [${c.rule.severity}] ${c.file}: p=${r.p} — may break ${c.rule.source}`);
  }
  return lines;
}

const USAGE = 'usage: node scripts/semantic-lint.mjs [--range <base>...<head>]…';

/** Pure — `--range` values, or { error }. */
export function parseArgs(argv) {
  const ranges = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--range' && argv[i + 1] && !argv[i + 1].startsWith('--')) ranges.push(argv[++i]);
    else return { error: `unexpected argument ${JSON.stringify(argv[i])}` };
  }
  return { ranges };
}

/**
 * The CLI with every side effect injected (specs never touch git, the network or the real log). Returns the exit code.
 * io: { root, jevConfig(), lintSection(), defaultRange(), diff(range), headSha(range), context(config), stdout, stderr }
 */
export async function run(argv, io) {
  const args = parseArgs(argv);
  if (args.error) {
    io.stderr(`semantic-lint: ${args.error}\n${USAGE}\n`);
    return 2;
  }
  let config;
  let rules;
  try {
    config = io.jevConfig();
    // Off exits before anything else — before the rules are read and, above all, before jevContext, whose unanswered-
    // egress ask must never fire on a stranger's push for a rail they never turned on (D6).
    if (config.rails.lint.mode === 'off') {
      io.stdout('semantic-lint: off (jev.rails.lint.mode)\n');
      return 0;
    }
    rules = parseLintRules(io.lintSection());
  } catch (e) {
    io.stderr(`semantic-lint: not run — ${e.message}\n`);
    return 2;
  }
  if (!rules.length) {
    io.stdout('semantic-lint: no rules (lint.rules is empty)\n');
    return 0;
  }
  const ranges = args.ranges.length ? args.ranges : [io.defaultRange()];
  let files = [];
  try {
    for (const range of ranges) files = files.concat(parseDiff(io.diff(range)));
  } catch (e) {
    // Could not look is never a pass: say it, even though there is nothing to log per candidate.
    io.stdout(`semantic-lint: not checked (could not read the diff: ${String(e.message).split('\n')[0]})\n`);
    return 0;
  }
  const candidates = selectCandidates(files, rules);
  const mode = config.rails.lint.mode;
  if (!candidates.length) {
    io.stdout(`semantic-lint (${mode}): nothing to judge — no added line matched a rule's selector\n`);
    return 0;
  }
  const ctx = io.context(config);
  const results = await judgeAll(candidates, {
    ask: ctx.ask,
    log: ctx.log,
    rail: config.rails.lint,
    mode,
    sha: io.headSha(ranges[ranges.length - 1]),
    notChecked: ctx.mode === 'off' ? ctx.why : null,
  });
  for (const line of summarize(candidates, results, { mode })) io.stdout(`${line}\n`);
  return 0;
}

const git = (root, args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

async function main() {
  const root = repoRoot();
  const code = await run(process.argv.slice(2), {
    jevConfig: () => loadJevConfig({ root }),
    lintSection: () => readSection('lint', { root }).raw,
    defaultRange: () => {
      try {
        git(root, ['rev-parse', '--verify', '--quiet', '@{upstream}']);
        return '@{upstream}...HEAD';
      } catch {
        return 'origin/main...HEAD';
      }
    },
    diff: (range) =>
      // Pinned, not inherited from the person's git config: the default core.quotePath turns a non-ASCII path into
      // "b/…\303\261.ts", and a custom diff.dstPrefix changes `b/` — either one made a real candidate match no glob
      // and read as "nothing to judge" (fresh review of #200).
      git(root, [
        '-c',
        'core.quotePath=false',
        'diff',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '-U3',
        '--no-color',
        '--no-ext-diff',
        '--diff-filter=d',
        range,
      ]),
    headSha: (range) => {
      try {
        return git(root, ['rev-parse', '--short=12', range.split('...').pop() || 'HEAD']).trim();
      } catch {
        return null;
      }
    },
    context: (config) => jevContext('lint', { root, config }),
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
  });
  process.exitCode = code;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
  main().catch((e) => {
    // A hook caller ignores the code, but a person running it by hand must see a crash as one.
    process.stderr.write(`semantic-lint: ${e?.stack || e}\n`);
    process.exitCode = 2;
  });
