#!/usr/bin/env node
// cross-review.mjs — the cross-agent judgment-layer review for a pull-request diff.
//
// Pipes `gh pr diff <PR#>` into the external Antigravity reviewer with the shared prompt
// (scripts/cross-review.prompt.md = the five AGENTS rules + WAYS single-pass discipline) and prints the
// findings. It is dev tooling, not app code, and it is deliberately:
//   • SINGLE-PASS — one read, no debate / iterate-to-convergence loop (our #1 token sink, out of scope).
//   • THE JUDGMENT-LAYER REVIEW (updated 2026-07-23, WAYS-OF-WORKING "Review & merge — cross-agent") —
//     running this with --agent antigravity replaces spawning an internal same-family reviewer for
//     ordinary PRs. High-risk work adds an independent Devin pass outside this script. A Blocking finding must
//     be resolved (fixed, or explicitly triaged) before merge — this is no longer background-only noise.
//     It still isn't a second CI: CI decides green/red mechanically, this decides whether the diff holds
//     up, and the risk-tier rule still decides *who* clicks merge.
//
// Usage:
//   node scripts/cross-review.mjs [PR#] --agent codex --builder <family> [--repo owner/repo] [--force] [--dry-run]
//     [--skip-trivial] [--min-lines N]
//
// --skip-trivial is the CI cost guard: skip (exit 0, no comment) when the PR is docs-only or under
// --min-lines (default 10) changed lines, so "every PR" doesn't pay for a review on a typo. Off by default
// so the manual command always reviews.
//
// <PR#> is OPTIONAL: with none, the command resolves the open PR for the CURRENT branch (so the FIRST run
// reviews the right diff, no rerun) and refuses a stale local HEAD unless --force. An explicit <PR#> still
// overrides (and bypasses the stale guard — the deliberate escape hatch).
//
// Default posts the findings as a labeled PR comment; --dry-run prints instead.
// `gh` resolves the repo from the current directory; pass --repo to target another (e.g. the app repo).
// Zero npm deps — Node 18+. CLI plumbing is shared with cross-panel.mjs via scripts/lib/cross-agent-cli.mjs.
//
// The diff is passed through stripGeneratedFileDiffs() before it reaches the reviewer CLI — a large
// auto-generated file (a committed package-lock.json, ~12–19K lines) blew Codex's context window live
// (deploy-pipeline-tuning epic, 2026-07-11); the reviewer still sees THAT the file changed, just not its
// (huge, low-signal) content. See that function's header comment in cross-agent-cli.mjs for the full story.
// --include-lockfiles opts back into the raw, unstripped diff for the rare case of reviewing a hand-edited
// lockfile itself.

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readSection } from './lib/config.mjs';
import { projectRoot } from './lib/project-root.mjs';
import { collectSecretValues, decideAuthorTrust, findSecretLeaks } from './lib/secret-guard.mjs';
import {
  AGENTS,
  headSidePaths,
  die,
  need,
  ensureCmd,
  ensureGh,
  checkAgyVersion,
  loadPromptBody,
  runAntigravity,
  runWithCodexFallback,
  runVibe,
  AGY_MODEL,
  codexModelFrom,
  CODEX_REASONING_EFFORT,
  CLAUDE_REVIEW_MODEL,
  runClaudeCode,
  AGENT_BIN,
  resolveCurrentPr,
  currentHeadSha,
  decideHeadGuard,
  decideTrivialSkip,
  stripGeneratedFileDiffs,
  stripDocFileDiffs,
  buildFileContext,
  renderFileContext,
  filterDiffToPaths,
  AGY_ARG_LIMIT,
  VIBE_ARG_LIMIT,
  shortSha,
  checkReviewerPairing,
  reviewersFor,
  BUILDER_FAMILIES,
} from './lib/cross-agent-cli.mjs';
import {
  changedFileCount,
  cliVersionNote,
  decideSecurityPass,
  parseReviewConfig,
  isReReview,
  postReviewStatus,
  reviewMarker,
  RE_REVIEW_NOTE,
  jevMarker,
  judgeReviewOutput,
} from './lib/review-guard.mjs';
import { jevContext } from './lib/jev.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVIEW_CONFIG_PATH = join(__dirname, 'review-config.json');
const PROMPT_PATH = join(__dirname, 'cross-review.prompt.md');
// `--lens security` swaps the prompt ONLY ��� agent selection, the fallback chain, --skip-trivial and the
// output guard are untouched, so the lens cannot regress the rail that reviews every other PR.
const SECURITY_PROMPT_PATH = join(__dirname, 'cross-review.security.prompt.md');
export const LENSES = ['security'];

// THROWS rather than die()s: a pure function that exits cannot be unit-tested, and silently falling back
// to the general prompt would let an operator believe a security pass ran when a general one did.
export function promptPathFor(lens) {
  if (!lens) return PROMPT_PATH;
  if (!LENSES.includes(lens)) throw new Error(`unknown lens '${lens}' (expected: ${LENSES.join(' | ')})`);
  return SECURITY_PROMPT_PATH;
}

const BANNER =
  '> **Cross-agent review — every finding is fixed, or answered on this PR, before merge. This does not authorize one.** ' +
  'CI and the risk-tier merge rule remain the only merge authority. A fresh `pr-reviewer` pass covers context independence; ' +
  'this is the family-independence pass: one single-pass read by a model family that did not build the diff.';

const HELP = `cross-review.mjs — the cross-agent judgment-layer review for a PR diff.

Usage:
  node scripts/cross-review.mjs [PR#] --agent codex --builder <family> [--repo owner/repo] [--force] [--dry-run]

[PR#] is optional — omit it to review the open PR for the CURRENT branch.

Flags:
  --agent <name>       reviewer CLI: ${Object.keys(AGENTS).join(' | ')} (default: codex)
  --paths a,b,c        review ONLY files whose path contains one of these. The reduced
                       scope is STATED in the posted comment.
  --code-only          drop doc/markdown hunks so a big diff fits agy's 256 KB argv cap.
                       The reduced scope is STATED in the posted comment.
  --allow-untrusted-author  review a PR whose author lacks write access (read the diff first).
  --builder <family>   who WROTE this diff: ${BUILDER_FAMILIES.join(' | ')}. Refuses a
                       same-family review (a family cannot clear its own work).
  --repo  owner/repo   target a specific repo (default: the repo of the current directory)
  --force              proceed even when local HEAD differs from the resolved PR head (auto-resolve only)
  --skip-trivial       skip (exit 0, no comment) when the PR is docs-only or under --min-lines changed lines
  --min-lines N        trivial-diff threshold for --skip-trivial (default: 10)
  --include-lockfiles  send the RAW diff, including generated files (package-lock.json, yarn.lock, etc.) —
                       normally stripped to a placeholder to avoid blowing the reviewer's context window
  --dry-run            print the comment instead of posting it (alias: --no-comment)
  -h, --help           show this help

With no [PR#], resolves the branch's PR via \`gh pr view\` and refuses a stale local HEAD unless --force.
An explicit [PR#] overrides resolution and bypasses the stale guard.

The judgment-layer review — not a second CI. CI (green/red) + the risk-tier rule (who merges) decide the rest.`;

function parseArgs(argv) {
  const out = {
    pr: null,
    agent: 'codex',
    builder: process.env.CROSS_REVIEW_BUILDER || '',
    codeOnly: false,
    allowUntrustedAuthor: false,
    paths: [],
    repo: null,
    force: false,
    dryRun: false,
    skipTrivial: false,
    minLines: 10,
    lens: null,
    includeLockfiles: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run' || a === '--no-comment') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--skip-trivial') out.skipTrivial = true;
    else if (a === '--include-lockfiles') out.includeLockfiles = true;
    else if (a === '--min-lines') out.minLines = parseMinLines(need(argv[++i], '--min-lines'));
    else if (a.startsWith('--min-lines=')) out.minLines = parseMinLines(a.slice('--min-lines='.length));
    else if (a === '--code-only') out.codeOnly = true;
    else if (a === '--allow-untrusted-author') out.allowUntrustedAuthor = true;
    else if (a === '--paths')
      out.paths = need(argv[++i], '--paths')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    else if (a === '--builder') out.builder = need(argv[++i], '--builder');
    else if (a.startsWith('--builder=')) out.builder = a.slice('--builder='.length);
    else if (a === '--lens') out.lens = need(argv[++i], '--lens');
    else if (a.startsWith('--lens=')) out.lens = a.slice('--lens='.length);
    else if (a === '--agent') out.agent = need(argv[++i], '--agent');
    else if (a.startsWith('--agent=')) out.agent = a.slice('--agent='.length);
    else if (a === '--repo') out.repo = need(argv[++i], '--repo');
    else if (a.startsWith('--repo=')) out.repo = a.slice('--repo='.length);
    else if (!a.startsWith('-') && out.pr === null) out.pr = a;
    else die(`unknown argument '${a}' (try --help)`);
  }
  return out;
}

function parseMinLines(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) die(`--min-lines must be a non-negative integer, got '${v}'.`);
  return n;
}

function ghDiff(pr, repo) {
  const args = ['pr', 'diff', String(pr)];
  if (repo) args.push('--repo', repo);
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    const first = (r.stderr || '').trim().split('\n')[0] || 'unknown error';
    die(`gh pr diff failed for #${pr}: ${first}`);
  }
  if (!r.stdout || !r.stdout.trim()) die(`PR #${pr} has an empty diff (wrong number or repo?).`);
  return r.stdout;
}

// Changed-file stats for the cost guard: [{ path, additions, deletions }, …]. Returns [] on any failure so
// the guard degrades to "not trivial" (review runs) rather than silently skipping on a transient gh hiccup.
function ghFiles(pr, repo) {
  const args = ['pr', 'view', String(pr), '--json', 'files'];
  if (repo) args.push('--repo', repo);
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return [];
  try {
    return JSON.parse(r.stdout || '{}').files || [];
  } catch {
    return [];
  }
}

/**
 * The PR's head commit SHA, or null when it cannot be resolved.
 *
 * Deliberately tolerant about RESOLVING: a `gh` hiccup returns null rather than aborting a review.
 * It is NOT tolerant about substituting — when the head cannot be resolved, the caller omits the
 * file context instead of reading a different version of it from the working tree. Getting that
 * backwards is what produced a confidently-wrong Blocking finding on PR #118.
 */
function resolvePrHeadOid(pr, repo) {
  const args = ['pr', 'view', String(pr), '--json', 'headRefOid', '-q', '.headRefOid'];
  if (repo) args.push('--repo', repo);
  const out = spawnSync('gh', args, { encoding: 'utf8' });
  if (out.status !== 0) return null;
  const oid = String(out.stdout || '').trim();
  return /^[0-9a-f]{40}$/.test(oid) ? oid : null;
}

// agy 1.0.7 has no stdin, so the diff rides embedded in the argv string.
function agyArgv(prompt, diff) {
  return `${prompt}\n\n## PR diff to review\n\n\`\`\`diff\n${diff}\n\`\`\`\n`;
}

// ── This dispatches on `agent`, and did not until 2026-07-26 ─────────────────────────────────
// It used to be `return runAntigravity(...)` unconditionally, which was harmless only while the
// argument guard above rejected every value except 'antigravity'. The moment Codex was re-enabled
// as a reviewer, `--agent codex` produced an AGY review posted under a comment header reading
// "Cross-agent review (Codex)" — the label came from AGENTS[agent] while the text came from
// whatever runReview felt like running.
//
// That is precisely the failure Roadmap/LEARNINGS.md records as "an audit label that can be chosen
// by picking an endpoint is worse than no audit log", and it is worse here than in the original
// incident: the entire value of this rail is model-FAMILY contrast, so a mislabeled review doesn't
// just misfile a record, it silently reports two independent reads where only one happened. A
// reviewer trusting the label would conclude the other family had cleared the diff.
//
// Each CLI takes its context differently — codex and claude on STDIN, agy and vibe as one argv string.
// See lib/cross-agent-cli.mjs; keeping that difference in one place is why the wrappers live there.
//
// Note the explicit `die` on an unknown agent. This used to end in a bare `return runAntigravity(...)`,
// i.e. "anything that isn't codex is agy". That was harmless while the roster was two families, and
// became a real bug the moment it grew: `--agent vibe` would have run AGY and posted the findings under
// a Mistral label. A cross-family review that names the wrong family is worse than none — a later
// reviewer trusting the label would conclude a family had cleared the diff when it never read it.
// Returns { findings, fellBack }. codex self-heals to agy on a lapsed token or a stale CLI
// (runWithCodexFallback), and `builder` is re-checked against that fallback family so the heal can never
// turn into a same-family review (distribute-what-we-use D1).
function runReview(agent, prompt, diff, { builder = '', onModel } = {}) {
  const stdinContext = `## PR diff to review\n\n\`\`\`diff\n${diff}\n\`\`\`\n`;
  if (agent === 'codex')
    return runWithCodexFallback(
      {
        prompt,
        stdin: stdinContext,
        antigravityArgv: agyArgv(prompt, diff),
        builder,
      },
      {
        // The heal is still an agy run, so it gets agy's version-pin check like `--agent antigravity` does
        // (pr-reviewer S3): a drifted print contract would otherwise review silently on the heal path.
        runAntigravity: (argv) => {
          checkAgyVersion();
          return runAntigravity(argv, { onModel });
        },
      }
    );
  if (agent === 'antigravity')
    return { findings: runAntigravity(agyArgv(prompt, diff), { onModel }), fellBack: false };
  if (agent === 'vibe') return { findings: runVibe(agyArgv(prompt, diff)), fellBack: false };
  if (agent === 'claude') return { findings: runClaudeCode(prompt, stdinContext), fellBack: false };
  die(`unknown --agent '${agent}'; use ${Object.keys(AGENTS).join('|')}`);
}

/**
 * The posted comment. Signature `(agentLabel, findings, fellBack, opts)` — the template's and that consumer's; the
 * older `(agentLabel, findings, opts)` shape is still accepted, so no caller breaks (distribute-what-we-use D1).
 *
 * `model` is recorded because the reviewer model is MACHINE-LOCAL state that no artifact used to capture:
 * if it drifts, review strength changes family and nothing notices. When it genuinely cannot be resolved
 * the comment says so, rather than printing a default that may be wrong (a consuming project).
 */
export function buildComment(agentLabel, findings, fellBack = false, opts = {}) {
  if (fellBack !== null && typeof fellBack === 'object') [fellBack, opts] = [false, fellBack];
  const { lens = null, model, version = null, reReview = false, securityOwed = null } = opts;
  // When codex fell back, make it unmistakable so nobody reads an Antigravity review as a Codex one.
  const header = fellBack ? `${AGENTS.antigravity} — Codex unavailable` : agentLabel;
  const title = lens
    ? `### 🔐 Cross-agent review — ${lens} lens (${header})`
    : `### 🔎 Cross-agent review (${header})`;
  // The reviewer CLI's version and model are recorded, not enforced — see lib/review-guard.mjs. `model`
  // left undefined means the caller did not try; `null` means it tried and could not resolve.
  const parts = [];
  if (model !== undefined) parts.push(`Model: ${model || 'unrecorded — resolve failed'}`);
  if (version) parts.push(version);
  const attribution = parts.length ? `\n\n_${parts.join(' · ')}._` : '';
  const limit =
    lens === 'security'
      ? `\n\n> **Scope of this pass:** one advisory, single-pass read by a different model family, triggered by the changed paths. It is **not** static analysis, not exhaustive, and not a required check. A clean result here is not a security guarantee.`
      : '';
  // A general pass on a security-path PR must not read as the whole review.
  const owed = securityOwed
    ? `\n\n> ⚠ **The security lens is OWED on this PR** (${securityOwed}) and has not run here. This general pass is not a substitute for it.`
    : '';
  const convergence = reReview
    ? `\n\n> **Re-review:** Blocking/Should-fix findings only — earlier nits are deliberately not repeated.`
    : '';
  return `${title}\n\n${BANNER}${attribution}${limit}${owed}${convergence}\n\n---\n\n${findings}\n`;
}

/**
 * The model that answered, for the comment's attribution line. `usedAgyModel` is what runAntigravity
 * actually ran (its onModel callback), which beats the configured pair. Returns null when codex's model
 * cannot be determined — a missing attribution is safer than a false one (a consuming project).
 */
export function resolveReviewModel(agent, fellBack, deps = {}) {
  const { env = process.env, readCfg = defaultReadCodexConfig, usedAgyModel = null } = deps;
  if (fellBack || agent === 'antigravity') return `agy ${usedAgyModel || env.AGY_MODEL || AGY_MODEL}`;
  if (agent === 'vibe') return env.VIBE_MODEL || env.VIBE_ACTIVE_MODEL || 'vibe configured default';
  if (agent === 'claude') return env.CLAUDE_REVIEW_MODEL || CLAUDE_REVIEW_MODEL;
  // The same resolution execCodex uses: unset → the pin. `default` → codex's BUILT-IN default: the review
  // runs `--ignore-user-config`, so ~/.codex/config.toml is not what ran, and naming its model would be a
  // false attribution (pr-reviewer round 3 on #188). `readCfg` is kept only so old callers' deps still parse.
  void readCfg;
  const pinned = 'codexModel' in deps ? deps.codexModel : codexModelFrom(env.CODEX_MODEL);
  if (pinned) return `${pinned} (effort: ${env.CODEX_REASONING_EFFORT || CODEX_REASONING_EFFORT})`;
  return `codex built-in default (effort: ${env.CODEX_REASONING_EFFORT || CODEX_REASONING_EFFORT}; user config ignored)`;
}

function defaultReadCodexConfig() {
  try {
    return readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8');
  } catch {
    return null;
  }
}

/** Comment bodies already on the PR, for re-review convergence. [] on any failure (degrade to first pass). */
/** The PR author's permission on the repo (admin/maintain/write/triage/read/none), or null if unreadable. */
function prAuthorPermission(pr, repo) {
  const view = spawnSync(
    'gh',
    ['pr', 'view', String(pr), '--json', 'author', '-q', '.author.login', ...(repo ? ['--repo', repo] : [])],
    { encoding: 'utf8' }
  );
  const login = String(view.stdout || '').trim();
  if (view.status !== 0 || !login) return null;
  const perm = spawnSync(
    'gh',
    ['api', `repos/${repo || '{owner}/{repo}'}/collaborators/${login}/permission`, '-q', '.permission'],
    { encoding: 'utf8' }
  );
  const p = String(perm.stdout || '').trim();
  return perm.status === 0 && p ? p : null;
}

/** The PR body, for the `risk: high` half of the security trigger. '' on any failure. */
function ghBody(pr, repo) {
  const args = ['pr', 'view', String(pr), '--json', 'body'];
  if (repo) args.push('--repo', repo);
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return '';
  try {
    return JSON.parse(r.stdout || '{}').body || '';
  } catch {
    return '';
  }
}

/**
 * The project's review config: `golden-frijoles.config.json` → `review` when present, else the legacy
 * `scripts/review-config.json` (the wave-2 loader, readSection). A missing/invalid config is FATAL:
 * defaulting it would silently mean "never run the security lens".
 */
export function loadReviewConfig(path = REVIEW_CONFIG_PATH) {
  try {
    const { raw, present } = readSection('review', {
      legacyPath: path,
      onLegacyError: (_p, e) => {
        throw e;
      },
    });
    if (!present) throw new Error(`${path} not found`);
    return parseReviewConfig(raw);
  } catch (e) {
    die(
      `scripts/review-config.json is missing or invalid (${e.message}). It decides which PRs get the security lens — a default would silently mean "never".`
    );
  }
}

/** The PR head sha, pinned before the review runs. null when gh cannot say — never a guess. */
function ghHeadSha(pr, repo) {
  const args = ['pr', 'view', String(pr), '--json', 'headRefOid'];
  if (repo) args.push('--repo', repo);
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout || '{}').headRefOid || null;
  } catch {
    return null;
  }
}

function ghComments(pr, repo) {
  const args = ['pr', 'view', String(pr), '--json', 'comments'];
  if (repo) args.push('--repo', repo);
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return [];
  try {
    return (JSON.parse(r.stdout || '{}').comments || []).map((c) => c.body || '');
  } catch {
    return [];
  }
}

function postComment(pr, repo, body) {
  const args = ['pr', 'comment', String(pr)];
  if (repo) args.push('--repo', repo);
  args.push('--body-file', '-'); // pipe the body on stdin → no shell-escaping pitfalls
  const r = spawnSync('gh', args, { input: body, encoding: 'utf8' });
  if (r.status !== 0) {
    const first = (r.stderr || '').trim().split('\n')[0] || 'unknown error';
    die(`gh pr comment failed for #${pr}: ${first}`);
  }
  return (r.stdout || '').trim(); // gh prints the comment URL
}

async function main() {
  let {
    pr,
    agent,
    repo,
    force,
    dryRun,
    skipTrivial,
    minLines,
    includeLockfiles,
    lens,
    help,
    builder,
    codeOnly,
    allowUntrustedAuthor,
    paths,
  } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write(HELP + '\n');
    process.exit(0);
  }
  if (pr !== null && !/^\d+$/.test(String(pr))) die(`PR number must be numeric, got '${pr}'.`);
  // ── Codex re-enabled as a PRIMARY reviewer, 2026-07-26 ──────────────────────────────────────
  // This guard dated from the 2026-07-23 cadence, when Codex was reserved for the builder/architect
  // seat and Agy was the sole review rail. Two things changed it back.
  //
  // First, evidence: on PR #33 Codex opened with a BLOCKING finding on an auth/tenancy surface that
  // four consecutive Agy rounds had read past and finally declared clean — plus two Should-fix the
  // other family had also missed. Roadmap/LEARNINGS.md draws the conclusion: neither family is
  // better, they are blind in different directions, and the rule is to stop when a round from the
  // OTHER family comes back clean, not when your usual reviewer does. A guard that makes the other
  // family unreachable defeats that rule by construction.
  //
  // Second, the constraint that motivated it (Codex quota) has lifted, and Roadmap/WAYS-OF-WORKING's
  // routing table already lists Codex first in the review row. This script was the last place still
  // enforcing the superseded cadence — the docs and the tool disagreed, and the tool won silently,
  // which is exactly the drift class this repo keeps paying for.
  if (!Object.prototype.hasOwnProperty.call(AGENTS, agent)) {
    die(`unknown reviewer '${agent}'; expected one of ${Object.keys(AGENTS).join('|')}`);
  }

  // ── Builder family ≠ reviewer family (the product owner, 2026-07-26) ───────────────────────────────────
  // Newly reachable now that Codex BUILDS here as well as reviews: `--agent codex` on a Codex-built
  // diff is same-family self-review wearing a cross-review label, which is worse than no review
  // because it gets recorded as one. A hard refusal rather than a warning — the output looks
  // identical either way, so a warning is a thing nobody notices. See reviewersFor().
  const pairingError = checkReviewerPairing(builder, agent);
  if (pairingError) die(pairingError);
  if (builder) {
    process.stderr.write(
      `Builder: ${builder} → reviewer '${agent}' OK (eligible: ${reviewersFor(builder).join(', ')}).\n`
    );
  }

  if (lens && !LENSES.includes(lens)) die(`unknown --lens '${lens}'; use ${LENSES.join('|')}`);

  ensureGh();

  // No <PR#> → resolve the open PR for the current branch and guard against a stale local HEAD, so the
  // FIRST run reviews the right diff. An explicit <PR#> skips both (the deliberate escape hatch).
  if (pr === null) {
    const resolved = resolveCurrentPr({ repo });
    pr = String(resolved.number);
    process.stderr.write(`Resolved PR #${pr} from branch \`${resolved.headRefName}\`.\n`);

    const localHead = currentHeadSha();
    const action = decideHeadGuard({ localHead, prHeadOid: resolved.headRefOid, force });
    if (action === 'mismatch-block') {
      die(
        `local HEAD (${shortSha(localHead)}) differs from PR #${pr} head (${shortSha(resolved.headRefOid)}) ` +
          `— push first, or pass --force (or an explicit <PR#>) to review anyway.`
      );
    }
    if (action === 'mismatch-force') {
      process.stderr.write(
        `⚠ local HEAD (${shortSha(localHead)}) differs from PR #${pr} head ` +
          `(${shortSha(resolved.headRefOid)}) — proceeding due to --force.\n`
      );
    }
  }
  // An outsider's diff never reaches a reviewer unasked (lib/secret-guard.mjs → decideAuthorTrust).
  const trust = decideAuthorTrust({
    permission: prAuthorPermission(pr, repo),
    allowUntrusted: allowUntrustedAuthor,
  });
  if (!trust.ok) die(trust.why);
  process.stderr.write(`Author check: ${trust.why}.\n`);

  // The security lens is triggered by the CHANGED PATHS, not by judgement (ways-of-work-lean-pass D7).
  // The router prints both commands, but a hand-run general pass must not silently stand in for a missing
  // security pass — so this run says so, on stderr AND in the posted comment where a PR reader sees it.
  let securityOwed = null;
  if (!lens) {
    const cfg = loadReviewConfig();
    const decision = decideSecurityPass({
      files: ghFiles(pr, repo),
      body: ghBody(pr, repo),
      securityPaths: cfg.securityPaths,
      totalFiles: changedFileCount({ pr, repo }),
    });
    if (decision.run) {
      securityOwed = decision.reason;
      process.stderr.write(
        `⚠ this PR triggers the security lens (${decision.reason}) — run: node scripts/cross-review.mjs ${pr}${repo ? ` --repo ${repo}` : ''} --agent <another-family>${builder ? ` --builder ${builder}` : ''} --lens security\n`
      );
    }
  }

  // Cost guard (CI): bail before installing/running the reviewer when the diff is trivial/docs-only.
  if (skipTrivial) {
    const { skip, reason } = decideTrivialSkip({ files: ghFiles(pr, repo), minLines });
    if (skip) {
      process.stderr.write(`cross-review skipped (${reason}) — PR #${pr}.\n`);
      process.exit(0);
    }
  }

  // jev-semantic-guards: resolve the Jev config BEFORE a review is paid for — a malformed jev.config.json
  // throws, and throwing after the reviewer ran would lose its reply and strand the status at `pending`.
  jevContext('review');

  // Pin the commit being reviewed BEFORE the reviewer runs: a push mid-review would otherwise move the
  // status onto a commit nobody read, and the re-review check needs to tell a new commit from a retry.
  const reviewedSha = ghHeadSha(pr, repo);

  // Post PENDING before the CLI is even checked. A version-pin mismatch or a dead token exits the
  // script BEFORE the guard runs (observed live on PR #177, where the agy pin refused the run), and an
  // ABSENT status is indistinguishable from "never ran". A stuck `pending` is visibly not-clean.
  if (!dryRun)
    postReviewStatus({
      pr,
      repo,
      state: 'pending',
      lens,
      sha: reviewedSha,
      description: `${AGENTS[agent]} reviewing…`,
    });

  // Presence-check the CLI we're ACTUALLY about to run. This used to hard-require `agy` on every run
  // regardless of --agent, which was a harmless quirk while agy was the default and codex the only
  // alternative — and becomes a wrong failure now that the roster is four families: without this,
  // `--agent claude` on a machine with no Antigravity installed would die complaining about agy.
  if (agent === 'antigravity') {
    ensureCmd('agy', 'agy not found — install the Antigravity CLI and authenticate it, then retry.');
    checkAgyVersion();
  } else if (agent === 'codex') {
    ensureCmd(
      'codex',
      'codex not found — install Codex CLI (https://github.com/openai/codex) and `codex login`.'
    );
  } else if (agent === 'vibe') {
    ensureCmd(
      AGENT_BIN.vibe,
      'vibe not found — install the Mistral Vibe CLI (`uv tool install mistral-vibe`) and authenticate it, then retry.'
    );
  } else if (agent === 'claude') {
    ensureCmd(
      AGENT_BIN.claude,
      'claude not found — install Claude Code (https://claude.com/claude-code) and run `claude auth login`, then retry.'
    );
  }

  // Re-review convergence (D8): a prior pass for THIS lens means Blocking/Important only.
  const reReview = isReReview(ghComments(pr, repo), lens, reviewedSha);
  const prompt = loadPromptBody(promptPathFor(lens)) + (reReview ? RE_REVIEW_NOTE : '');
  const rawDiff = ghDiff(pr, repo);
  let diff = rawDiff;
  if (!includeLockfiles) {
    const stripped = stripGeneratedFileDiffs(rawDiff);
    diff = stripped.diff;
    if (stripped.strippedFiles.length) {
      process.stderr.write(
        `Omitted ${stripped.strippedFiles.length} generated file diff(s) to fit the reviewer's context ` +
          `window: ${stripped.strippedFiles.join(', ')} (pass --include-lockfiles to send the raw diff).\n`
      );
    }
  }
  // ── The code-only subset, and its honesty requirement ───────────────────────────────────────
  // Both argv-based reviewers get THEIR OWN cap. They are the same 256 KB today, which is exactly
  // why hardcoding agy's went unnoticed — the two would diverge silently the day either CLI changed,
  // and vibe would be handed a budget computed against another tool's limit (cross-review, Agy,
  // PR #119). Resolved once, here, so the scope notes and the budget cannot disagree.
  const argvLimit = agent === 'vibe' ? VIBE_ARG_LIMIT : AGY_ARG_LIMIT;

  // agy takes its prompt in argv, so a sprint-sized PR can exceed that cap and the review
  // refuses to run — which on a high-risk diff is exactly when losing the second family hurts most.
  // Dropping prose usually fits it. But a reviewer who cannot see the sprint doc cannot check the
  // code against its acceptance criteria, so the reduced scope is recorded and posted with the
  // findings rather than left implicit.
  let scopeNote = null;
  if (codeOnly) {
    const codeOnlyDiff = stripDocFileDiffs(diff);
    diff = codeOnlyDiff.diff;
    scopeNote =
      `**Scope: CODE ONLY.** ${codeOnlyDiff.strippedFiles.length} documentation file(s) were ` +
      `withheld from this reviewer to fit a ${argvLimit / 1024} KB input budget, so it did ` +
      `NOT see the sprint docs, the epic README or any migration prose — it could not check the ` +
      `code against its own stated acceptance criteria. Withheld: ` +
      `${codeOnlyDiff.strippedFiles.join(', ') || '(none)'}.`;
    process.stderr.write(`Code-only: withheld ${codeOnlyDiff.strippedFiles.length} doc file(s).\n`);
  }

  if (paths.length > 0) {
    const scoped = filterDiffToPaths(diff, paths);
    diff = scoped.diff;
    const note =
      `**Scope: ${scoped.keptFiles.length} FILE(S) ONLY.** This reviewer was given a targeted ` +
      `subset of the PR — the diff exceeds a ${argvLimit / 1024} KB input budget in full, so ` +
      `the alternative was no second-family review at all. It saw: ` +
      `${scoped.keptFiles.join(', ')}. It did NOT see ${scoped.droppedFiles.length} other changed ` +
      `file(s), and could not check any of this against the sprint docs.`;
    scopeNote = scopeNote ? `${scopeNote}\n\n${note}` : note;
    process.stderr.write(
      `Scoped to ${scoped.keptFiles.length} file(s), dropped ${scoped.droppedFiles.length}.\n`
    );
  }

  // ── Attach the full current text of the files this diff touches ─────────────────────────────
  // Only for the two DIFF-ONLY reviewers. `claude` runs deliberately tool-less over stdin and
  // `codex` takes context on stdin without an argv cap, so neither needs (or is helped by) this.
  //
  // Three wrong findings in two days came from a reviewer reasoning about code it could not see —
  // a helper "not defined" that was defined eight lines above the hunk being the clearest. See
  // buildFileContext's header for why agy and vibe get attachment rather than repo access.
  let fileContext = '';
  if (agent === 'antigravity' || agent === 'vibe') {
    // Whatever argv budget the diff has not already spent, less a margin for the prompt and the
    // fences. Under-filling is the safe direction: a review that runs on less context still runs.
    const budget = Math.max(0, argvLimit - Buffer.byteLength(diff, 'utf8') - 16 * 1024);
    const touched = headSidePaths(diff);
    // ── Read from the PR's HEAD COMMIT, not the working tree ──────────────────────────────────
    // This used to be `readFileSync(path)`, i.e. whatever branch happens to be checked out. With
    // stacked sprint branches — this repo's DEFAULT shape (WAYS-OF-WORKING §6) — that is routinely a
    // DIFFERENT branch than the PR under review, and the reviewer then receives the PR's diff
    // alongside another branch's file contents.
    //
    // Not hypothetical: reviewing PR #118 while checked out on its `-s2` child, Mistral Vibe raised a
    // confident Blocking finding that the diff "would fail to compile", because an import present in
    // the diff was absent from the file text it was handed. It reasoned correctly from contradictory
    // inputs. That is this very block's own failure mode inverted (see its header: "three wrong
    // findings in two days came from a reviewer reasoning about code it could not see") — and the
    // inverted form is worse, because the reviewer is confidently wrong rather than visibly blind.
    //
    // The stale-HEAD guard above does NOT cover this: it runs only when <PR#> is omitted, and an
    // explicit <PR#> is documented as skipping it. So the content is pinned here independently, and
    // falls back to the working tree only for an object this clone does not have — saying so.
    const prHeadOid = resolvePrHeadOid(pr, repo);
    // The head object may not be in this clone at all — an unfetched branch, or a FORK PR, whose
    // head `git fetch origin` never brings down. Try once, explicitly, before giving up on it.
    if (prHeadOid) {
      const have = spawnSync('git', ['cat-file', '-e', `${prHeadOid}^{commit}`]);
      if (have.status !== 0) spawnSync('git', ['fetch', '--quiet', 'origin', prHeadOid]);
    }
    const unavailable = [];
    const readAtPrHead = (path) => {
      if (prHeadOid) {
        const shown = spawnSync('git', ['show', `${prHeadOid}:${path}`], {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
        if (shown.status === 0) return shown.stdout;
      }
      // ── OMIT, never substitute the working tree ───────────────────────────────────────────────
      // The first version fell back to `readFileSync` with a warning. Codex was right to call that
      // (PR #119, round 3): a warning on stderr does not stop the review, so the reviewer still
      // receives the PR's diff beside another branch's file — the exact defect this change exists to
      // remove, reintroduced in its own fallback. Fork PRs make it likely rather than rare.
      //
      // Throwing is the omit path: buildFileContext already catches a failing reader and skips that
      // file. Less context is the safe direction — a reviewer that cannot see a file says so;
      // a reviewer shown the WRONG file states a defect that does not exist.
      unavailable.push(path);
      throw new Error(`not available at PR head: ${path}`);
    };
    const selection = buildFileContext(touched, readAtPrHead, budget);
    if (unavailable.length > 0) {
      process.stderr.write(
        `\u26a0 ${unavailable.length} file(s) could not be read at PR #${pr}'s head` +
          `${prHeadOid ? ` (${shortSha(prHeadOid)})` : ' (head could not be resolved)'} and were ` +
          `OMITTED rather than read from the working tree: ${unavailable.join(', ')}\n`
      );
    }
    fileContext = renderFileContext(selection);
    if (selection.attached.length || selection.omitted.length) {
      process.stderr.write(
        `Attached ${selection.attached.length} whole file(s) (${Math.round(selection.bytes / 1024)} KB); ` +
          `${selection.omitted.length} did not fit the budget.\n`
      );
    }
  }

  let usedAgyModel = null;
  const { findings, fellBack } = runReview(
    agent,
    fileContext ? `${prompt}\n\n${fileContext}` : prompt,
    diff,
    { builder, onModel: (m) => (usedAgyModel = m) }
  );
  // The family that actually answered: after a codex→agy heal, the comment must not say "Codex".
  const answered = fellBack ? 'antigravity' : agent;
  const reviewerLabel = fellBack ? `${AGENTS.antigravity} — Codex unavailable` : AGENTS[agent];

  // Never PUBLISH a reply that carries this machine's secrets (lib/secret-guard.mjs): a reviewer fed an
  // injected diff can still read host files (codex's read-only sandbox allows reads). Checked FIRST, before
  // the output guard — that guard quotes the reply's opening text in a PUBLIC status description, and asks
  // Jev about the reply (egress) — so a secret-carrying reply reaches neither (pr-reviewer round 3 on #188).
  // The status posted here names no reply text. The reply is printed locally, redacted.
  const secrets = findSecretLeaks(findings, { values: collectSecretValues({ root: projectRoot() }) });
  if (secrets.leaks.length) {
    const what = secrets.leaks.map((l) => l.name).join(', ');
    if (!dryRun)
      postReviewStatus({
        pr,
        repo,
        state: 'failure',
        lens,
        description: `${reviewerLabel}: reply withheld — it carried secret-shaped text`,
        sha: reviewedSha,
      });
    process.stderr.write(
      `\n───── ${reviewerLabel}'s reply, WITHHELD (redacted: ${what}) ─────\n${secrets.redacted}\n───── end of reply ─────\n`
    );
    die(
      `${reviewerLabel}'s reply carried ${what} and was NOT posted. If this is a real leak, rotate the ` +
        `credential and treat the diff as hostile; if it is a false positive, post the redacted text by hand.`
    );
  }

  // THE GUARD (ways-of-work-lean-pass D9). With one external pass, a CLI that exits 0 with nothing to say
  // reads exactly like a clean review and nothing contradicts it. A structureless reply FAILS the run and
  // fails the PR's `cross-review/<lens>` status rather than posting a comment that looks like a pass.
  // jev-semantic-guards D5: Jev decides "is this a real review?" per jev.config.json → rails.review.mode;
  // `assertReviewOutput` is the fallback when Jev cannot look or is unsure, and the whole of it when `off`.
  const verdict = await judgeReviewOutput(findings, { sha: reviewedSha });
  process.stderr.write(`review guard: ${verdict.reason}\n`);
  if (!verdict.ok) {
    if (!dryRun) {
      const st = postReviewStatus({
        pr,
        repo,
        state: 'failure',
        lens,
        description: `${reviewerLabel}: ${verdict.reason}`,
        sha: reviewedSha,
      });
      process.stderr.write(
        st.posted
          ? `✗ marked cross-review/${lens || 'general'} FAILED on PR #${pr}.\n`
          : `✗ could not post the failing status (${st.detail}).\n`
      );
    }
    // NEVER destroy a reply the run paid for: a false reject would otherwise cost a full re-run, which is
    // exactly how a guard trains people to bypass it.
    process.stderr.write(
      `\n───── ${reviewerLabel}'s full reply, rejected by the output guard ─────\n${findings || '(empty)'}\n───── end of reply ─────\n`
    );
    die(`${reviewerLabel} did not return a review: ${verdict.reason}`);
  }

  const body =
    buildComment(AGENTS[agent], scopeNote ? `${scopeNote}\n\n---\n\n${findings}` : findings, fellBack, {
      lens,
      model: resolveReviewModel(agent, fellBack, { usedAgyModel }),
      version: cliVersionNote(answered),
      reReview,
      securityOwed,
    }) +
    reviewMarker({ lens, sha: reviewedSha }) +
    jevMarker(verdict);
  if (dryRun) {
    process.stdout.write(body);
    process.stderr.write('\n(dry-run — no comment posted)\n');
  } else {
    const url = postComment(pr, repo, body);
    process.stderr.write(`✓ Review comment posted${url ? `: ${url}` : ''}\n`);
    const st = postReviewStatus({
      pr,
      repo,
      state: 'success',
      lens,
      description: `review produced by ${reviewerLabel} (${verdict.reason}) — not a verdict`,
      sha: reviewedSha,
    });
    process.stderr.write(
      st.posted
        ? `✓ cross-review/${lens || 'general'} status: success.\n`
        : `⚠ review posted but its status did not (${st.detail}).\n`
    );
  }
}

// Guarded so importing this module for its pure helpers does not run a review.
// realpath on both sides: through a symlinked path a plain compare is false and the script exits 0 having
// done nothing (#189 review).
const isMain = (() => {
  try {
    return (
      !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (isMain)
  main().catch((e) => {
    process.stderr.write(`cross-review: ${e?.message || e}\n`);
    process.exit(1);
  });
