#!/usr/bin/env node
// jev-report.mjs — turn shadow into a decision (jev-semantic-guards S5.1).
//
//   node scripts/jev-report.mjs [--log <decisions.jsonl> …] [--repo owner/name …] [--json <out.json>]
//   node scripts/jev-report.mjs --append-labels <labelled.json>
//
// Reads every guard decision there is — one or more `.jev/decisions.jsonl` logs (this repo's by default) and
// the hidden `<!-- jev:{…} -->` markers on cross-review comments in each `--repo` (the only record a cloud
// routine leaves) — and prints, per rail: decisions, agreement %, uncertain %, could-not-look %, and a
// disagreement table with a `label:` column. The product owner labels only the disagreements.
//
// `--json` writes the disagreements as fixture CANDIDATES (`label: null`). Fill in `label` — review: true if
// the reply really was a review; prose: the list of codes that truly apply — and pass the file to
// `--append-labels`, which appends every labelled row to `jev-eval.fixtures.json` without a recording. Then
// `node scripts/jev-eval.mjs --live` records Jev's answers for them; until it does, the offline replay fails
// on the unrecorded rows — which is the point: a label nobody measured is not evidence.
//
// Zero deps — Node 18+.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJevConfig, repoRoot } from './lib/jev.mjs';
import { parseJevMarker } from './lib/review-guard.mjs';
import { harvest } from './jev-backtest.mjs';
import { FIXTURES_PATH } from './jev-eval.mjs';

/** Parse JSONL, skipping blank and malformed lines (counted, never fatal). Pure. */
export function parseLog(text) {
  let bad = 0;
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      bad++;
    }
  }
  return { rows, bad };
}

/** A semantic-lint decision: `rail: 'lint:<rule id>'`. */
export const isLint = (r) => typeof r?.rail === 'string' && /^lint:[a-z0-9][a-z0-9-]*$/.test(r.rail);

export const LINT_OUTCOMES = ['raise', 'uncertain', 'clear', 'not-checked'];

/**
 * The shadow report for semantic-lint (C5): per rule, how many candidates were raised, uncertain, cleared or not
 * checked, and the raised/uncertain ones to label. There is no regex verdict to agree with — the selector only picks —
 * so the owed promote/tune/drop decision reads these counts and the labels. A row with no known outcome is not
 * evidence and is dropped, never counted as clear. Pure.
 */
export function summarizeLint(rows) {
  const out = {};
  const toLabel = [];
  for (const r of rows.filter(isLint)) {
    const o = r.evidence?.outcome;
    if (!LINT_OUTCOMES.includes(o)) continue;
    const s = (out[r.rail] ??= { n: 0, raise: 0, uncertain: 0, clear: 0, 'not-checked': 0 });
    s.n++;
    s[o]++;
    if (o === 'raise' || o === 'uncertain')
      toLabel.push({ rail: r.rail, outcome: o, p: r.confidence, file: r.evidence?.file ?? null, text: r.text });
  }
  return { summary: out, toLabel };
}

export function renderLint({ summary, toLabel }) {
  if (!Object.keys(summary).length) return '';
  const lines = [
    '## Semantic lint',
    '',
    '| rule | candidates | raise | uncertain | clear | not checked |',
    '|---|---|---|---|---|---|',
  ];
  for (const [rail, s] of Object.entries(summary))
    lines.push(
      `| ${rail} | ${s.n} | ${pct(s.raise, s.n)} | ${pct(s.uncertain, s.n)} | ${pct(s.clear, s.n)} | ${pct(s['not-checked'], s.n)} |`
    );
  lines.push('', '### Raised or uncertain — label these', '', toLabel.length ? '| rule | outcome | p | file | excerpt | label: |' : '_None._');
  if (toLabel.length) lines.push('|---|---|---|---|---|---|');
  for (const c of toLabel)
    lines.push(
      `| ${c.rail} | ${c.outcome} | ${c.p} | ${c.file} | ${String(c.text ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 90)} | |`
    );
  return lines.join('\n');
}

/** One row per (rail, text): a replayed backtest must not count twice. The newest entry wins. Pure. */
export function dedupe(rows) {
  const by = new Map();
  // One key per thing judged: a comment URL whether it came from the backtest (`backtest:<url>`) or a marker
  // (`marker:<url>`), else the text hash. Keying on the raw source counted one comment twice (PR #39).
  // A lint row's source is `<file>@<sha>`, which two hunks of one file share and one hunk re-pushed does not: the file
  // plus the hunk's own hash is the thing judged (semantic-lint C5) — the hash alone merged identical windows in two
  // files (fresh review of #200).
  const key = (r) =>
    isLint(r)
      ? `${r.rail}:${r.evidence?.file ?? ''}:${r.textHash}`
      : `${r.rail}:${r.source ? String(r.source).replace(/^(?:backtest|marker):/, '') : r.textHash}`;
  // Newest by timestamp, not by input order: several --log files and markers arrive in any order (codex, #192).
  const byTime = [...rows].sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
  for (const r of byTime) by.set(key(r), r);
  return [...by.values()];
}

const sortedJson = (a) => JSON.stringify([...(a ?? [])].sort());

/**
 * Classify one decision. Pure. review → 'agree' | 'disagree' | 'uncertain' | 'could-not-look';
 * prose → 'agree' | 'disagree' | 'could-not-look'.
 */
export function classify(row, thresholds) {
  if (row.rail === 'review') {
    const noul = row.confidence;
    if (typeof noul !== 'number' || row.error) return 'could-not-look';
    if (noul >= thresholds.review.real) return row.regex === true ? 'agree' : 'disagree';
    if (noul <= thresholds.review.notReal) return row.regex === false ? 'agree' : 'disagree';
    return 'uncertain';
  }
  if (!Array.isArray(row.jev) || (row.error && !row.jev.length)) return 'could-not-look';
  return sortedJson(row.regex) === sortedJson(row.jev) ? 'agree' : 'disagree';
}

/**
 * Markers from posted comments → review rows. The regex's verdict is the marker's own `regexOk`. An older
 * marker has none: in `off`/`shadow` a posted comment WAS regex-accepted, so `true` is sound there; a `jev`
 * marker without it cannot say what the regex thought, so it is skipped rather than guessed (PR #39).
 */
export function markerRows(comments) {
  return (
    comments
      .map((c) => ({ c, m: parseJevMarker(c.body) }))
      // A marker from a run where Jev WAS configured but could not look (noul null, mode shadow|jev) is a
      // could-not-look decision, not a missing one (codex, #192). `off` markers are no decision at all.
      .filter(({ m }) => m && (m.mode === 'shadow' || m.mode === 'jev'))
      .filter(({ m }) => typeof m.regexOk === 'boolean' || m.mode !== 'jev')
      .map(({ c, m }) => ({
        rail: 'review',
        mode: m.mode,
        decider: m.decider,
        regex: typeof m.regexOk === 'boolean' ? m.regexOk : true,
        jev: m.noul >= 0.5,
        confidence: typeof m.noul === 'number' ? m.noul : null,
        error: typeof m.noul === 'number' ? null : 'jev could not look',
        ts: c.created ?? null,
        textHash: c.url,
        text: c.reply ?? '',
        source: `marker:${c.url}`,
      }))
  );
}

/** Summaries + disagreement candidates. Pure. */
export function summarize(rows, thresholds) {
  const out = {};
  const candidates = [];
  for (const rail of ['review', 'prose']) {
    const rs = rows.filter((r) => r.rail === rail);
    const counts = { agree: 0, disagree: 0, uncertain: 0, 'could-not-look': 0 };
    for (const r of rs) {
      const k = classify(r, thresholds);
      counts[k]++;
      if (k === 'disagree')
        candidates.push(
          rail === 'review'
            ? {
                rail,
                id: `shadow-${r.textHash}`,
                label: null,
                text: r.text,
                source: r.source ?? 'shadow log',
                regex: r.regex,
                jev: r.confidence,
              }
            : {
                rail,
                id: `shadow-${r.textHash}`,
                label: null,
                draft: r.text,
                evidence: r.evidence ?? { minWords: 1 },
                source: r.source ?? 'shadow log',
                regex: r.regex,
                jev: r.jev,
              }
        );
    }
    const judged = counts.agree + counts.disagree;
    out[rail] = { n: rs.length, ...counts, agreement: judged ? counts.agree / judged : null };
  }
  return { summary: out, candidates };
}

const pct = (x, n) => (n ? `${((100 * x) / n).toFixed(1)}%` : 'n/a');

export function render({ summary, candidates }) {
  const lines = [
    '| rail | decisions | agreement | uncertain | could not look | disagreements |',
    '|---|---|---|---|---|---|',
  ];
  for (const [rail, s] of Object.entries(summary))
    lines.push(
      `| ${rail} | ${s.n} | ${s.agreement == null ? 'n/a' : `${(100 * s.agreement).toFixed(1)}%`} | ${pct(s.uncertain, s.n)} | ${pct(s['could-not-look'], s.n)} | ${s.disagree} |`
    );
  lines.push(
    '',
    '## Disagreements',
    '',
    candidates.length ? '| rail | id | regex | jev | excerpt | label: |' : '_None._'
  );
  if (candidates.length) lines.push('|---|---|---|---|---|---|');
  for (const c of candidates) {
    const excerpt = String(c.text ?? c.draft ?? '')
      .replace(/\s+/g, ' ')
      .replace(/\|/g, '\\|')
      .slice(0, 90);
    lines.push(
      `| ${c.rail} | ${c.id} | ${JSON.stringify(c.regex)} | ${JSON.stringify(c.jev)} | ${excerpt} | |`
    );
  }
  return lines.join('\n');
}

/** Append labelled candidates to the fixtures (unrecorded). Pure over its inputs; returns the new fixtures. */
export function appendLabels(fixtures, labelled) {
  const next = { review: [...(fixtures.review ?? [])], prose: [...(fixtures.prose ?? [])] };
  const seen = new Set([...next.review, ...next.prose].map((f) => f.id));
  let added = 0;
  for (const c of labelled) {
    if (c.label == null || seen.has(c.id)) continue;
    if (!['review', 'prose'].includes(c.rail)) {
      process.stderr.write(`jev-report: skipped ${c.id ?? '(no id)'} — rail must be review or prose\n`);
      continue;
    }
    // The report-only columns (regex, jev) are dropped; `_`-prefixed so a consumer's no-unused-vars lint passes.
    const { rail, regex: _regex, jev: _jev, ...fx } = c;
    next[rail].push({ ...fx, recorded: null, decision: null });
    added++;
  }
  return { fixtures: next, added };
}

async function main() {
  const argv = process.argv.slice(2);
  const all = (flag) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]] : []));
  const root = repoRoot();
  const labelsIx = argv.indexOf('--append-labels');
  if (labelsIx >= 0) {
    const labelled = JSON.parse(readFileSync(resolve(argv[labelsIx + 1]), 'utf8'));
    const { fixtures, added } = appendLabels(JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')), labelled);
    writeFileSync(FIXTURES_PATH, `${JSON.stringify(fixtures, null, 2)}\n`);
    process.stdout.write(
      `appended ${added} labelled fixture(s) — now run: node scripts/jev-eval.mjs --live\n`
    );
    return;
  }
  const config = loadJevConfig({ root });
  const logs = all('--log').length
    ? all('--log').map((p) => resolve(p))
    : [join(root, '.jev', 'decisions.jsonl')];
  let rows = [];
  let bad = 0;
  for (const p of logs) {
    if (!existsSync(p)) {
      process.stderr.write(`(no log at ${p})\n`);
      continue;
    }
    const parsed = parseLog(readFileSync(p, 'utf8'));
    rows.push(...parsed.rows);
    bad += parsed.bad;
  }
  for (const repo of all('--repo')) rows.push(...markerRows(harvest(repo)));
  // Only rows that are decisions of a known rail count; `{}` or a foreign line is not evidence (codex, #192).
  rows = dedupe(rows.filter((r) => r && (r.rail === 'review' || r.rail === 'prose' || isLint(r))));
  // No decisions is not a report: a missing log must never read as a completed, all-clear one (codex, PR #39).
  if (!rows.length) {
    process.stderr.write('jev-report: no decisions found in any --log or --repo — nothing to report.\n');
    process.exit(1);
  }
  const thresholds = { review: config.rails.review.thresholds, prose: config.rails.prose.thresholds };
  const report = summarize(rows, thresholds);
  process.stdout.write(`${render(report)}\n`);
  const lint = renderLint(summarizeLint(rows));
  if (lint) process.stdout.write(`\n${lint}\n`);
  if (bad) process.stderr.write(`(${bad} malformed log line(s) skipped)\n`);
  const jsonIx = argv.indexOf('--json');
  if (jsonIx >= 0)
    writeFileSync(resolve(argv[jsonIx + 1]), `${JSON.stringify(report.candidates, null, 2)}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
  main().catch((e) => {
    process.stderr.write(`jev-report: ${e.message}\n`);
    process.exit(1);
  });
