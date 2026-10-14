#!/usr/bin/env node
// pod-report.mjs — compute a product's outcome report (the Pod Report artifact) from its own repo, and push it.
//
// pod-report · Sprint 2, Story 2.1 built it against a local medusa-bonsai checkout; outcome-report-any-product (2026-10-14)
// made it run in ANY product's repo from the kit. This is the I/O half: it runs git and gh against the checkout, hands the
// result to the pure `lib/pod-metrics.mjs` computation, and pushes the artifact through the client-pushes rail.
//
//   npx -y @golden-frijoles/kit pod-report --push          # in the product's repo; key + URL from .env.local
//   node scripts/pod-report.mjs                            # print the artifact for the repo it runs in
//   node scripts/pod-report.mjs --repo <path> --push        # another checkout
//   node scripts/pod-report.mjs --env-file <path> --push    # the key and URL from that file
//   node scripts/pod-report.mjs --out artifact.json         # write it to a file
//
// ── What this deliberately does NOT compute ───────────────────────────────────────────────────
// Velocity, cost-per-point, change-failure-rate and MTTR are absent by design, not by omission —
// see lib/pod-metrics.mjs's NOT_INSTRUMENTED list, which travels INSIDE the artifact so a renderer
// cannot drop the caveats. The dataset supports none of them, and a fabricated 0% change-failure
// rate would be the most flattering number on the page and the least true.
//
// ── Determinism ───────────────────────────────────────────────────────────────────────────────
// `--generated-at` exists so a rerun can produce a byte-identical artifact (Sprint 2's headline
// acceptance criterion). Without it the timestamp is the only field that differs between runs, and
// a determinism check that ignores one field is not a determinism check.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, writeSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { die, need } from './lib/cross-agent-cli.mjs';
import { projectRoot } from './lib/project-root.mjs';
import { computeDelivery, epicHistory, normalizeStatus } from './lib/pod-metrics.mjs';
import { parseFrontmatter } from './lib/epic-kickoff.mjs';
import { computeMaturityLens } from './lib/maturity-lens.mjs';

/** The artifact's payload contract version. Bump only alongside a renderer migration. */
export const POD_REPORT_SCHEMA_VERSION = 1;

function git(repo, args, { allowFail = true } = {}) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) die(`git ${args.slice(0, 2).join(' ')} failed in ${repo}`);
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

/**
 * Commits, with whether each carries an agent co-author trailer.
 *
 * `%B` (the full body) rather than `%s`, because the trailer lives in the body — reading only the
 * subject would report 0% agent authorship across a repo that is 82% agent-co-authored, which is
 * both wrong and the exact opposite of the truth.
 *
 * The record separator is a literal control character rather than a newline because commit bodies
 * contain newlines; splitting on those would shred every multi-line message into fake commits.
 */
export function readCommits(repo, run = git) {
  const SEP = '\x1e'; // ASCII record separator — cannot occur in a commit message
  const raw = run(repo, ['log', '--no-merges', `--format=%H%x1f%ad%x1f%B${SEP}`, '--date=short']);
  return raw
    .split(SEP)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, date, ...rest] = chunk.split('\x1f');
      const body = rest.join('\x1f');
      const subject = (body ?? '').split('\n')[0];
      return {
        sha,
        date,
        // Matches the trailer with or without a model name ("Co-Authored-By: Claude Opus 4.8").
        agentCoAuthored: /^Co-Authored-By:\s*(?:Claude|OpenAI|GPT|Devin)/im.test(body ?? ''),
        // ── isRevert, which round 6 caught missing ────────────────────────────────────────────
        // `scoreTrustedSelfVerificationLoop` filters on `c.isRevert`; leaving it undefined made
        // revertCount 0 for EVERY repository — a 0% revert rate that means "never computed". It
        // happened to match this dataset (medusa-bonsai genuinely has no reverts), which is exactly
        // how it went unnoticed: accidentally right here, wrong everywhere else.
        //
        // Matched on the SUBJECT only. `git revert` writes "Revert \"original subject\"", but a
        // commit BODY routinely mentions reverting in prose ("Revert path: git revert <sha>"), and
        // this repo's own history contains exactly that false positive.
        isRevert: /^Revert\s+"/i.test(subject) || /^Revert:/i.test(subject),
      };
    });
}

/**
 * Epics and their lifecycle dates, from the roadmap docs' own git history.
 *
 * `startedAt` is the first commit that touched the epic's README; `shippedAt` is the first commit
 * whose diff flipped `status:` to `shipped`. Both are real commit timestamps — no estimate, no
 * inferred date. An epic still in flight has a null `shippedAt` and is excluded from lead time
 * rather than counted as taking forever.
 */
export function readEpics(repo, run = git, showMany = catFileBatch) {
  const readmes = run(repo, ['ls-files', 'Roadmap/*/*/README.md'])
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);

  return readmes.map((path) => {
    const slug = path.split('/').slice(-2, -1)[0];
    const startedAt =
      run(repo, ['log', '--diff-filter=A', '--format=%aI', '--reverse', '--', path])
        .split('\n')
        .filter(Boolean)[0] ?? null;

    // ── outcome-report-any-product D1 — `shippedAt` from each revision's PARSED frontmatter ────────────────
    // The old `git log -S 'status: shipped'` counted occurrences of a literal string: a quoted or re-spaced value was
    // invisible to it, and a mention of the phrase anywhere in the README could date the ship. Each revision of this
    // README is now read (one `git cat-file --batch` for all of them) and its frontmatter `status` parsed; the ship is
    // the FIRST revision whose status reads `shipped` (the product owner, 2026-10-14). `startedAt` is unchanged.
    const revisions = readRevisions(repo, path, run, showMany);
    const history = epicHistory(revisions);
    return { slug, path, startedAt, ...history };
  });
}

/** This README's revisions, oldest first, each with its parsed, normalised `status`. Deleted revisions are skipped. */
function readRevisions(repo, path, run, showMany) {
  const rows = run(repo, ['log', '--reverse', '--format=%H%x09%aI%x09%s', '--', path])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [commit, at, ...subject] = line.split('\t');
      return { commit, at, subject: subject.join('\t') };
    });
  const texts = showMany(
    repo,
    rows.map((row) => `${row.commit}:${path}`)
  );
  return rows
    .map((row, i) =>
      texts[i] === null ? null : { ...row, status: normalizeStatus(parseFrontmatter(texts[i]).status) }
    )
    .filter(Boolean);
}

/**
 * The contents of many `<commit>:<path>` objects in ONE `git cat-file --batch` process — `null` for a missing one (the
 * file did not exist at that commit). One process per README rather than one per revision.
 */
export function catFileBatch(repo, specs) {
  if (specs.length === 0) return [];
  const r = spawnSync('git', ['cat-file', '--batch'], {
    cwd: repo,
    input: specs.join('\n') + '\n',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) return specs.map(() => null);
  const out = r.stdout;
  const texts = [];
  let offset = 0;
  for (let i = 0; i < specs.length; i++) {
    const headerEnd = out.indexOf(10, offset);
    const header = out.subarray(offset, headerEnd).toString('utf8');
    if (header.endsWith(' missing')) {
      texts.push(null);
      offset = headerEnd + 1;
      continue;
    }
    const size = Number(header.split(' ')[2]);
    texts.push(out.subarray(headerEnd + 1, headerEnd + 1 + size).toString('utf8'));
    offset = headerEnd + 1 + size + 1; // the object, then its trailing newline
  }
  return texts;
}

/** Merged PRs via `gh`. Returns [] when gh is unavailable rather than failing the whole report. */
export function readPullRequests(repo, run = spawnSync) {
  const r = run(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'merged',
      '--limit',
      '500',
      // `comments`, `statusCheckRollup`, `headRefName` and `body` are NOT optional extras — the
      // maturity lens scores review presence, CI enforcement, parallel-branch isolation and
      // risk-tier discipline from exactly these fields. Requesting only the timestamps (as the
      // first version did) handed the lens 98 PRs with no comment data, which it correctly read as
      // "reviewed: no" — reporting a practice as ABSENT when the truth was that it was never
      // measured. A false `not_met` is still a false claim, even when it understates us.
      '--json',
      'number,createdAt,mergedAt,title,body,comments,statusCheckRollup,headRefName,mergedBy',
    ],
    { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0) {
    process.stderr.write(
      '⚠ gh could not list pull requests — cycle time and the deploy-frequency proxy will be omitted.\n' +
        '  They will render as "not instrumented" rather than as zero.\n'
    );
    return [];
  }
  try {
    return JSON.parse(r.stdout || '[]');
  } catch {
    return [];
  }
}

/**
 * Patterns that identify a REVIEWER-AGENT comment.
 *
 * Detected by comment BODY, never by author identity, and that is forced by the data rather than a
 * preference: cross-agent review comments in this dataset are posted under the human maintainer's
 * own account (`user.type: "User"`), so there is no bot login to filter on. Filtering by author
 * would find zero reviewed PRs across a repo that reviews nearly all of them.
 */
const AGENT_REVIEW_PATTERNS = [
  /cross-agent review/i,
  /fresh-reviewer findings/i,
  /judgment-layer review/i,
  /\bcodex\b.{0,20}\breview\b/i,
];

/**
 * Adapt gh's PR shape to the shape the lens scores.
 *
 * This adapter is where a subtle dishonesty crept in and had to be fixed: the lens reads
 * `reviewComments[].isAgentReviewer` and `ciCheckNames`, while gh returns `comments[]` and
 * `statusCheckRollup[]`. Passing gh's raw shape meant the lens saw 98 PRs with no review data and
 * concluded the practice was ABSENT — a `not_met`, which asserts something stronger than
 * "not measured". The two must never be confused, in either direction.
 */
export function normalisePrForLens(pr) {
  const comments = Array.isArray(pr.comments) ? pr.comments : [];
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  const tier = parseRiskTier(pr.body);

  return {
    ...pr,
    reviewComments: comments.map((c) => ({
      ...c,
      isAgentReviewer: AGENT_REVIEW_PATTERNS.some((re) => re.test(c?.body ?? '')),
    })),
    ciCheckNames: checks.map((c) => checkName(c)).filter(Boolean),

    // ── The three fields cross-review caught missing (PR #32, round 2) ────────────────────────
    // `readPullRequests` was already fetching the data these need, and the adapter simply did not
    // map it — so the risk-tier and self-verification criteria read `not_instrumented` on every
    // real repo, capping the ladder at step 1. Exactly the bug class fixed once already in round 1
    // (fetch the data, forget to map it), caught a second time in a different place.
    //
    // Each stays UNDEFINED when genuinely unknowable, never guessed: undefined means "not
    // measured" to the lens, while a wrong default would be a claim.
    riskTier: tier,
    // Only meaningful once a PR is merged. `is_bot` is GitHub's own flag; an agent merging through
    // a human's account is indistinguishable from the human here, and this proxy says so rather
    // than pretending otherwise.
    mergedByIsAgent: pr.mergedAt && pr.mergedBy ? pr.mergedBy.is_bot === true : undefined,
    // Undefined rather than false when NO checks are attached: "this PR ran no checks" and "we
    // don't know whether checks passed" are different facts, and false would assert the first.
    ciPassedBeforeMerge: checks.length > 0 ? checks.every((c) => checkSucceeded(c)) : undefined,
  };
}

/**
 * Pull a declared risk tier out of a PR body.
 *
 * Two spellings, because the dataset genuinely contains both: this repo's template writes
 * `Risk tier:` while the sibling roadmap docs write `**Risk:** LOW`. Coverage is PARTIAL by nature —
 * many PR bodies declare no tier at all — and that is fine: an undeclared tier yields `undefined`,
 * the lens counts only the PRs that did declare one, and nothing is inferred for the rest.
 */
/** Filenames that count as encoded standards, in the order they are preferred. */
export const STANDARDS_FILES = ['CLAUDE.md', 'AGENTS.md'];

// ── The two GitHub check shapes, handled in ONE place ────────────────────────────────────────
// `statusCheckRollup` mixes two entirely different objects: modern CHECK RUNS carry `name` +
// `conclusion`, while classic COMMIT STATUSES carry `context` + `state`. Every field read has to
// account for both, and three separate review rounds each caught a different half-migrated read —
// `conclusion` without `state` (round 3), the helper written but never called (round 4), and the
// NAME still reading only `name` (round 8).
//
// So both accessors now live here, adjacent and named, rather than as inline expressions scattered
// through the adapter. The next field that needs the same treatment has an obvious home.

/** A check's display name, whichever shape it is. */
export function checkName(check) {
  return check?.name ?? check?.context ?? null;
}

/** True when a check reports success, whichever shape it is. */
export function checkSucceeded(check) {
  return String(check?.conclusion ?? check?.state ?? '').toUpperCase() === 'SUCCESS';
}

export function parseRiskTier(body) {
  const m =
    /risk\s*tier\s*[:*]*\s*\**(LOW|MED|MEDIUM|HIGH)|\*\*risk:?\*\*\s*:?\s*(LOW|MED|MEDIUM|HIGH)/i.exec(
      body ?? ''
    );
  if (!m) return undefined;
  const raw = (m[1] || m[2]).toUpperCase();
  return raw === 'MEDIUM' ? 'MED' : raw;
}

/** Whole-history window in days, from the first commit to the last. */
export function windowDays(commits) {
  const dates = commits.map((c) => Date.parse(c.date)).filter((n) => Number.isFinite(n));
  if (dates.length === 0) return 0;
  return Math.max(1, Math.round((Math.max(...dates) - Math.min(...dates)) / 86_400_000));
}

/**
 * The benchmark citations Story 2.3 requires.
 *
 * CITED AND LINKED, never republished: we state what the published level is and where to read it,
 * and we do not reproduce anyone's table. Version-pinned by date so an old artifact stays
 * interpretable against the benchmark it was actually scored against.
 */
export const BENCHMARKS = [
  {
    id: 'dora-2025',
    label: 'DORA — Accelerate State of DevOps 2025',
    url: 'https://dora.dev/research/',
    note: 'Elite performers: change lead time under one day; deployment frequency on demand. Cited, not republished.',
  },
  {
    id: 'linearb-2026',
    label: 'LinearB Engineering Benchmarks 2026',
    url: 'https://linearb.io/resources/engineering-benchmarks',
    note: 'Elite PR cycle time is measured in hours, not days. Cited, not republished.',
  },
  {
    id: 'dx-core-4',
    label: 'DX Core 4',
    url: 'https://getdx.com/research/',
    note: 'Speed, effectiveness, quality and impact are reported together — never speed alone.',
  },
];

export function buildArtifact({ delivery, source, generatedAt, maturity }) {
  return {
    schemaVersion: POD_REPORT_SCHEMA_VERSION,
    generatedAt,
    source,
    delivery,
    benchmarks: BENCHMARKS,
    ...(maturity ? { maturity } : {}),
    // Travels INSIDE the artifact so a renderer cannot silently drop it. The epic's whole ethic:
    // speed is never shown without the honesty about what is not measured.
    caveats: [
      "Every number here is computed from this repository's own git and pull-request history. Nothing is estimated.",
      'The comparison baseline is PUBLISHED BENCHMARKS, not an internal human-era baseline: this dataset has no human-majority era to compare against.',
      'Metrics listed as "not instrumented" are absent because the data cannot support them — not because they are zero.',
      // outcome-report-any-product (the product owner, 2026-10-14): the date source changed; say so where the numbers are.
      "Lead time and throughput read each epic's real status history (since 2026-10-14); earlier reports dated many ships at the epic's creation.",
    ],
  };
}

/**
 * Git provenance of the ANALYSED repo (the medusa-bonsai checkout, not this golden-beans one) — the
 * freshness stamp a push carries. `run` is injectable so a unit test pins the call shape without a
 * real checkout, mirroring `readCommits`/`readEpics` above.
 */
export function gatherSourceRef(repo, run = git) {
  return {
    commit: run(repo, ['rev-parse', 'HEAD']) || null,
    ref: run(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) || null,
  };
}

/**
 * Where to push and with which credential.
 *
 * `POD_REPORT_API_KEY` is checked FIRST, `SELF_PROJECT_API_KEY` second. The two need not agree: the
 * Pod Report is computed from a medusa-bonsai checkout but the tenant that OWNS the pushed artifact
 * is whichever project the key belongs to (resolved server-side from the key, never from this
 * script — same rule as the route). A team dogfooding both rails from one tenant can set only
 * `SELF_PROJECT_API_KEY` and have it cover both; a team pushing the Pod Report to a different
 * tenant than its own roadmap sets `POD_REPORT_API_KEY` to override just this one.
 */
export function resolvePushConfig(env = process.env) {
  return {
    // outcome-report-any-product D4 (decision b): a stranger's push reaches the hosted engine with only its key set.
    baseUrl: env.GROWTH_ENGINE_URL || 'https://goldenfrijoles.com',
    // `GROWTH_ENGINE_API_KEY` last: the name `frijoles init --ingest` writes and `roadmap-push` already reads.
    apiKey: env.POD_REPORT_API_KEY || env.SELF_PROJECT_API_KEY || env.GROWTH_ENGINE_API_KEY || null,
  };
}

/** The variables this script reads from a dotenv file — nothing is evaluated, the last assignment wins (like roadmap-push). */
export const POD_ENV_NAMES = [
  'GROWTH_ENGINE_URL',
  'GROWTH_ENGINE_API_KEY',
  'SELF_PROJECT_API_KEY',
  'POD_REPORT_API_KEY',
];
export function readPodEnvFile(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !POD_ENV_NAMES.includes(m[1])) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value) out[m[1]] = value;
  }
  return out;
}

/**
 * The wire envelope for POST /api/v1/reports/pod/push.
 *
 * Git provenance travels under `pushSource`, NOT `source` — the artifact already owns `source` for
 * Story 2.1's dataset provenance (repo/commits/epics/mergedPrs/windowDays), which the renderer reads
 * to show what the numbers were measured over. An earlier draft of this function put the push's
 * commit/ref in that slot, which meant every PUSHED report rendered its dataset counts empty while a
 * locally printed one looked perfect. Two separate keys makes that collision unrepresentable
 * (lib/pod-report-schema.ts strips exactly `pushSource` and keeps the rest).
 */
export function buildPushEnvelope(artifact, { commit, ref } = {}) {
  return { ...artifact, pushSource: { commit: commit ?? null, ref: ref ?? null } };
}

/**
 * Fetch task-lifecycle facts from the engine — the ladder evidence for the step-4 criterion.
 *
 * signals-loop Story 3.3b (Amendment 4.3). This script analyses a git repository and has no database
 * access, but "has an agent actually closed real feedback, with evidence?" is a fact only the engine
 * holds. So it asks, using the credential it already carries for pushing the artifact.
 *
 * ── Returns undefined, never a zeroed object, on ANY failure ──────────────────────────────────
 * `undefined` means "not measured" and the lens renders `not_instrumented`; a zeroed object would
 * mean "measured, found none" and render `not_met` — a materially stronger claim, and one about
 * ourselves. Exactly the distinction the surrounding code already makes for `skillsProvenance`.
 *
 * Never throws and never fails the report: an optional criterion that cannot be scored must degrade
 * to "not instrumented", not take the whole artifact down with it.
 */
async function fetchTaskLifecycle({ baseUrl, apiKey }) {
  if (!apiKey) return undefined;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/reports/pod/lifecycle`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      process.stderr.write(
        `⚠ lifecycle facts unavailable (HTTP ${res.status}) — scoring as not instrumented.\n`
      );
      return undefined;
    }
    const body = await res.json();
    // The endpoint distinguishes "the seam is dark / unreadable" (instrumented:false) from a real
    // reading. Honour that rather than treating a null payload as a zero.
    if (!body?.ok || !body.instrumented || !body.taskLifecycle) return undefined;
    return body.taskLifecycle;
  } catch (err) {
    process.stderr.write(
      `⚠ lifecycle facts unreachable (${err?.message ?? err}) — scoring as not instrumented.\n`
    );
    return undefined;
  }
}

async function main() {
  const args = process.argv.slice(2);
  // outcome-report-any-product D4: the repo it is RUN in (the project root), not a fixed checkout on one machine.
  let repo = projectRoot();
  let out, generatedAt, envFile;
  let push = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo') repo = need(args[++i], '--repo');
    else if (args[i] === '--env-file') envFile = need(args[++i], '--env-file');
    else if (args[i] === '--out') out = need(args[++i], '--out');
    else if (args[i] === '--generated-at') generatedAt = need(args[++i], '--generated-at');
    else if (args[i] === '--push') push = true;
    else die(`unknown arg ${args[i]}`);
  }

  repo = resolve(repo.replace(/^~/, process.env.HOME ?? '~'));
  if (!existsSync(repo)) {
    die(`no checkout at ${repo}. Run it inside the product's repo, or pass --repo <path>.`);
  }

  // The push's key and URL: --env-file, else the repo's own `.env.local` when it has one (where `frijoles init --ingest`
  // writes them). The file wins over the shell, so the key and the URL come from the same place (as roadmap-push).
  const envPath = envFile ? resolve(envFile) : resolve(repo, '.env.local');
  let fromFile = {};
  if (envFile || existsSync(envPath)) {
    try {
      fromFile = readPodEnvFile(readFileSync(envPath, 'utf8'));
    } catch (err) {
      die(`could not read ${envPath}: ${err.message}`);
    }
  }
  const pushEnv = { ...process.env, ...fromFile };

  const commits = readCommits(repo);
  if (commits.length === 0) die(`no commits found in ${repo} — is it a git checkout?`);

  const epics = readEpics(repo);
  const prs = readPullRequests(repo);
  const days = windowDays(commits);

  // Story 2.4 — the maturity lens, computed from the SAME inputs Story 2.1 already loaded. No new
  // data source, per the amendment: what cannot be derived from git/PR data renders as
  // "not instrumented" rather than being gathered from somewhere new.
  // Pass ONLY what was genuinely gathered. `undefined` means "not measured" and the lens renders it
  // as not-instrumented; an empty array would mean "measured, found none" and would render as
  // not_met — a stronger claim than the data supports. That distinction is the whole point of this
  // epic, and it is why `skillsProvenance` is undefined rather than [].
  //
  // No top-level `ciCheckNames`: the scorers read it PER PR (`input.prs[i].ciCheckNames`), which
  // normalisePrForLens sets. Passing it at the top level as well looked reassuring and did nothing
  // — cross-review caught the dead argument.
  // signals-loop Story 3.3b — the one input that does NOT come from git. Fetched from the engine
  // with the push credential, and `undefined` on any failure so the criterion degrades to
  // "not instrumented" rather than to a zero we did not measure.
  const taskLifecycle = await fetchTaskLifecycle(resolvePushConfig(pushEnv));

  const maturity = computeMaturityLens({
    prs: prs.map(normalisePrForLens),
    commits,
    taskLifecycle,
    // BOTH, and each carries a distinct fact. `hasClaudeMd` is the measured-ness signal — a real
    // boolean means "we looked", and its absence means "we did not", which is the not_met vs
    // not_instrumented distinction this whole epic turns on. `standardsFile` names WHICH file was
    // found, so the evidence pointer resolves: a pointer reading "CLAUDE.md" for a repo whose file
    // is AGENTS.md does not resolve, quietly breaking the lens's central promise (round 3).
    //
    // Collapsing these two into one field was tried first and regressed the row from not_met to
    // not_instrumented — turning "we checked and there is none" back into "we never checked".
    hasClaudeMd: STANDARDS_FILES.some((f) => existsSync(`${repo}/${f}`)),
    standardsFile: STANDARDS_FILES.find((f) => existsSync(`${repo}/${f}`)),
    skillsProvenance: undefined,
  });

  // ONE clock read for the whole artifact. Two calls to `new Date()` — one inside computeDelivery,
  // one at the top level — meant `artifact.generatedAt` and `artifact.delivery.generatedAt`
  // disagreed by milliseconds on every default run: a single artifact quietly claiming two
  // generation times. Harmless-looking, and wrong in a document whose headline property is that the
  // same inputs produce the same output (cross-review round 7).
  const stamp = generatedAt ?? new Date().toISOString();

  const artifact = buildArtifact({
    maturity,
    delivery: computeDelivery({ prs, epics, commits, windowDays: days, generatedAt: stamp }),
    source: {
      // The checkout's directory name, NOT a hardcoded string. It was `'medusa-bonsai'` literally,
      // which meant `--repo` pointed anywhere else still produced an artifact CLAIMING to measure
      // medusa-bonsai — a false provenance line on a document whose entire value is that every
      // number is traceable. Found the first time the script was run against a second repository
      // (golden-beans' own, for the demo-safe landing artifact), which is the only way it could have
      // been found: with one dataset the constant was indistinguishable from correct.
      //
      // The basename is also the key `app/hub/report-components.tsx`'s REPO_PR_BASE map uses to
      // decide whether an evidence pointer resolves to a real URL, so a wrong name there silently
      // downgrades every `pr` pointer to plain text rather than linking it.
      repo: basename(repo),
      commits: commits.length,
      epics: epics.length,
      mergedPrs: prs.length,
      windowDays: days,
    },
    generatedAt: stamp,
  });

  const json = JSON.stringify(artifact, null, 2);
  if (out) {
    writeFileSync(out, `${json}\n`);
    process.stderr.write(`✓ wrote ${out}\n`);
  } else {
    writeSync(1, `${json}\n`);
  }

  if (push) {
    const { baseUrl, apiKey } = resolvePushConfig(pushEnv);
    if (!apiKey) {
      // Clean skip, not a failure — same stance as scripts/roadmap-push.mjs: a repo without the
      // secret configured must not turn a run red over an observability-grade nicety. This is NOT
      // the bug this story fixes: the old code printed a warning and exited 0 on EVERY --push,
      // whether or not the push actually happened. Here, a skip and a failure are distinguishable —
      // only the missing-credential case exits clean; an attempted-and-failed push does not (below).
      process.stderr.write(
        'POD_REPORT_API_KEY / SELF_PROJECT_API_KEY not set — skipping the pod_report push cleanly.\n' +
          '  The artifact was computed and discarded. Set one of these to enable this.\n'
      );
      return;
    }

    const envelope = buildPushEnvelope(artifact, gatherSourceRef(repo));
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/reports/pod/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await res.text();
    if (!res.ok) {
      // The server's own error body names WHICH field failed and whether it was a version or a
      // shape problem. Printing it and exiting non-zero is the whole point of this story: the old
      // behaviour swallowed exactly this and reported success regardless.
      process.stderr.write(`✗ pod_report push failed (${res.status}): ${text}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`✓ pod_report pushed: ${text}\n`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`✗ ${err.message}\n`);
    process.exit(1);
  });
}
