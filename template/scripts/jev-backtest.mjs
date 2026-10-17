#!/usr/bin/env node
// jev-backtest.mjs — replay Jev over every historical cross-review comment (jev-semantic-guards S2.3, D9).
//
//   node scripts/jev-backtest.mjs --repo owner/name [--repo owner/name …] [--limit N] [--out <path>.md]
//   node scripts/jev-backtest.mjs --prose <file.md> [<file.md> …]
//
// `--prose` is the PROSE rail's history: committed close-out prose (retrospectives, posters) replayed through
// `judgeProse` in shadow with the evidence `prose-draft` uses for those files (fix and beneficiary allowed;
// liveness and commitment asked), so the S5 report has real prose decisions, not only fixtures.
//
// Harvests the machine-posted cross-review comments (`### 🔎 Cross-agent review …` / `### 🔐 … security
// lens …`) from each repo, strips the header and markers back to the reviewer's own reply, and asks Jev the
// same question the live guard asks — through the SAME `judgeReviewOutput`, in `shadow`, so every scored
// reply lands in `.jev/decisions.jsonl` exactly as live traffic would (source `backtest:<url>`). It writes a
// disagreement table (regex vs Jev) to `.jev/backtest-<date>.md`.
//
// THE CORPUS IS BIASED, AND THE REPORT SAYS SO. A posted comment is by construction a reply the regex
// ACCEPTED — a rejected reply was never posted, it only reached stderr. So this can find the regex's false
// PASSES (a banner it let through) but never its false FAILS (a real review it threw away). The live log
// and the eval fixtures carry that other half.
//
// Needs `gh` (authenticated) and TYPESAFE_API_KEY. Zero deps — Node 18+.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { judgeProse } from './lib/prose-guard.mjs';
import { judgeReviewOutput } from './lib/review-guard.mjs';
import { loadJevConfig, parseJevConfig, readApiKey, repoRoot } from './lib/jev.mjs';
import { isMain } from './lib/is-main.mjs';

export const REVIEW_TITLE = /^### (?:🔎 Cross-agent review \(|🔐 Cross-agent review — \S+ lens \()/;

/**
 * The reviewer's own reply, recovered from a posted comment: everything after the first `---` rule that
 * buildComment puts between its header and the findings, minus the hidden markers. Pure. null when the
 * body is not a cross-review comment.
 */
export function stripComment(body) {
  const b = String(body ?? '');
  if (!REVIEW_TITLE.test(b)) return null;
  const at = b.indexOf('\n\n---\n\n');
  const reply = at >= 0 ? b.slice(at + 7) : b.split('\n').slice(1).join('\n');
  return reply
    .replace(/<!-- cross-review [^>]*-->/g, '')
    .replace(/<!-- jev:[^\n]*? -->/g, '')
    .trim();
}

/** Jev's side of the comparison at the configured thresholds. Pure. */
export function jevVerdict(noul, { real, notReal }) {
  if (noul == null || !Number.isFinite(noul)) return 'could-not-look';
  if (noul >= real) return 'real';
  if (noul <= notReal) return 'not-real';
  return 'uncertain';
}

/** Harvest cross-review comments from one repo via the REST issue-comments feed. */
/**
 * Who may have posted a cross-review comment: the account `cross-review.mjs` posts as, i.e. the authenticated
 * `gh` user — or an explicit list. Anyone can comment on a public repo, and a forged comment carrying a forged
 * `<!-- jev: -->` marker must not become evidence for the gate (codex security lens, golden-beans #160).
 */
export function reviewAuthors({ spawn = spawnSync, env = process.env } = {}) {
  if (env.JEV_REVIEW_AUTHORS)
    return env.JEV_REVIEW_AUTHORS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const r = spawn('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' });
  const login = r.status === 0 ? String(r.stdout).trim() : '';
  if (!login)
    throw new Error('cannot tell who posts cross-reviews: `gh api user` failed — set JEV_REVIEW_AUTHORS');
  return [login];
}

export function harvest(repo, { spawn = spawnSync, authors = null } = {}) {
  const allowed = new Set(authors ?? reviewAuthors({ spawn }));
  const r = spawn(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${repo}/issues/comments?per_page=100`,
      '--jq',
      // `// ""` — a deleted or system comment has a null body, and `null | test(...)` is a jq error that
      // would abort the whole harvest (agy, golden-beans #159). `--jq` prints each object as one line.
      '.[] | select((.body // "") | test("^### (🔎|🔐) Cross-agent review")) | {url: .html_url, created: .created_at, author: .user.login, body: .body}',
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  if (r.status !== 0) throw new Error(`gh api failed for ${repo}: ${(r.stderr || '').trim().split('\n')[0]}`);
  return String(r.stdout)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => allowed.has(c.author))
    .map((c) => ({ ...c, repo, reply: stripComment(c.body) }))
    .filter((c) => c.reply !== null);
}

/** Render the report. Pure. rows: [{ repo, url, created, regexOk, noul, severity, verdict, firstLine }]. */
export function renderReport({ rows, date, thresholds, model, repos }) {
  const count = (f) => rows.filter(f).length;
  const disagree = rows.filter(
    (r) => (r.verdict === 'real') !== r.regexOk && r.verdict !== 'uncertain' && r.verdict !== 'could-not-look'
  );
  const esc = (s) =>
    String(s ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\s+/g, ' ')
      .slice(0, 110);
  return [
    `# Jev backtest — cross-review comments, ${date}`,
    '',
    `Repos: ${repos.join(', ')} · model \`${model}\` · thresholds real ≥ ${thresholds.real}, not-real ≤ ${thresholds.notReal}`,
    '',
    '> **Corpus bias:** every row is a reply the regex ACCEPTED (a rejected reply is never posted). This finds',
    "> the regex's false passes, never its false fails.",
    '',
    `| scored | regex accepted | jev real | jev not-real | jev uncertain | could not look | disagreements |`,
    `|---|---|---|---|---|---|---|`,
    `| ${rows.length} | ${count((r) => r.regexOk)} | ${count((r) => r.verdict === 'real')} | ${count((r) => r.verdict === 'not-real')} | ${count((r) => r.verdict === 'uncertain')} | ${count((r) => r.verdict === 'could-not-look')} | ${disagree.length} |`,
    '',
    '## Disagreements (regex vs Jev)',
    '',
    disagree.length ? '| comment | regex | jev (noul) | severity | first line | label: |' : '_None._',
    ...(disagree.length ? ['|---|---|---|---|---|---|'] : []),
    ...disagree.map(
      (r) =>
        `| [${r.repo}](${r.url}) | ${r.regexOk ? 'review' : 'not'} | ${r.verdict} (${r.noul?.toFixed(2)}) | ${r.severity ?? ''} | ${esc(r.firstLine)} | |`
    ),
    '',
    '## Uncertain (the regex decided these under `mode: jev`)',
    '',
    ...(rows
      .filter((r) => r.verdict === 'uncertain')
      .map((r) => `- [${r.repo}](${r.url}) — ${r.noul.toFixed(2)} — ${esc(r.firstLine)}`) || []),
    '',
  ].join('\n');
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    })
  );
  return out;
}

/** The evidence `prose-draft.mjs` applies to internal close-out artifacts. */
export const CLOSE_OUT_EVIDENCE = {
  allowsFixClaim: true,
  allowsBeneficiary: true,
  allowsMarkdown: true,
  liveFlags: [],
  maxWords: 100_000,
  minWords: 1,
};

async function proseBacktest(files, root) {
  if (!files.length) {
    process.stderr.write(
      'usage: node scripts/jev-backtest.mjs --prose <file.md> [<file.md> …] — no files given\n'
    );
    process.exit(2);
  }
  const key = readApiKey({ root });
  const base = loadJevConfig({ root });
  if (!key || !base.egress) {
    process.stderr.write('jev-backtest --prose needs TYPESAFE_API_KEY and egress:true.\n');
    process.exit(2);
  }
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const config = parseJevConfig({
    model: base.model,
    egress: base.egress,
    rails: { ...base.rails, prose: { ...base.rails.prose, mode: 'shadow', shadowExpires: tomorrow } },
  });
  let agree = 0;
  const rows = await mapLimit(files, 6, async (f) => {
    const v = await judgeProse(readFileSync(f, 'utf8'), CLOSE_OUT_EVIDENCE, { config, key, root });
    const same = JSON.stringify([...v.regexCodes].sort()) === JSON.stringify([...(v.jevCodes ?? [])].sort());
    agree += same;
    return { f, regex: v.regexCodes, jev: v.jevCodes, errors: v.errors ?? [] };
  });
  for (const r of rows.filter((x) => JSON.stringify(x.regex.sort()) !== JSON.stringify((x.jev ?? []).sort())))
    process.stdout.write(
      `disagree  ${r.f}  regex=[${r.regex}] jev=[${r.jev}]${r.errors.length ? ` (${r.errors[0]})` : ''}\n`
    );
  process.stdout.write(
    `prose backtest: ${rows.length} file(s) scored in shadow · ${agree} agree · ${rows.length - agree} disagree\n`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const proseIx = argv.indexOf('--prose');
  if (proseIx >= 0)
    return proseBacktest(
      argv.slice(proseIx + 1).filter((a) => !a.startsWith('--')),
      repoRoot()
    );
  const repos = argv.flatMap((a, i) =>
    a === '--repo' && argv[i + 1] && !argv[i + 1].startsWith('--') ? [argv[i + 1]] : []
  );
  const limitIx = argv.indexOf('--limit');
  const limit = limitIx >= 0 ? Number(argv[limitIx + 1]) : Infinity;
  const outIx = argv.indexOf('--out');
  const outArg = outIx >= 0 ? argv[outIx + 1] : null;
  if (!repos.length || (outIx >= 0 && (!outArg || outArg.startsWith('--') || !outArg.endsWith('.md')))) {
    process.stderr.write(
      'usage: node scripts/jev-backtest.mjs --repo owner/name [--repo …] [--limit N] [--out <path>.md]\n'
    );
    process.exit(2);
  }
  const root = repoRoot();
  const key = readApiKey({ root });
  if (!key) {
    process.stderr.write('jev-backtest needs TYPESAFE_API_KEY (env or .env.local).\n');
    process.exit(2);
  }
  const base = loadJevConfig({ root });
  // egress:false means no text leaves this machine — the backtest sends every historical reply, so it obeys
  // it too (fresh review, PR #35).
  if (!base.egress) {
    process.stderr.write(
      'jev-backtest: jev.config.json sets egress:false — refusing to send replies to Jev.\n'
    );
    process.exit(2);
  }
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  // Shadow, so the log records it exactly as live shadow traffic — the regex's verdict stays the outcome.
  const config = parseJevConfig({
    model: base.model,
    egress: base.egress,
    rails: { ...base.rails, review: { ...base.rails.review, mode: 'shadow', shadowExpires: tomorrow } },
  });

  const comments = repos.flatMap((r) => harvest(r)).slice(0, limit);
  process.stderr.write(`harvested ${comments.length} cross-review comment(s) from ${repos.join(', ')}\n`);
  const rows = await mapLimit(comments, 8, async (c) => {
    const v = await judgeReviewOutput(c.reply, { source: `backtest:${c.url}` }, { config, key, root });
    return {
      repo: c.repo,
      url: c.url,
      created: c.created,
      regexOk: v.regexOk,
      noul: v.jev ? v.jev.noul : null,
      severity: v.jev?.severity ?? null,
      verdict: jevVerdict(v.jev ? v.jev.noul : null, config.rails.review.thresholds),
      firstLine: c.reply.split('\n').find((l) => l.trim()) ?? '',
      error: v.error,
    };
  });
  const date = new Date().toISOString().slice(0, 10);
  const out = outIx >= 0 ? resolve(outArg) : join(root, '.jev', `backtest-${date}.md`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    renderReport({ rows, date, thresholds: config.rails.review.thresholds, model: config.model, repos })
  );
  writeFileSync(
    /\.md$/.test(out) ? out.replace(/\.md$/, '.json') : `${out}.json`,
    `${JSON.stringify(rows, null, 2)}\n`
  );
  process.stdout.write(`${out}\n`);
}

if (isMain(import.meta.url))
  main().catch((e) => {
    process.stderr.write(`jev-backtest: ${e.message}\n`);
    process.exit(1);
  });
