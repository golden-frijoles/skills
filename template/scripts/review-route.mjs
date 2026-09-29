#!/usr/bin/env node
// review-route.mjs — WHICH families review this PR. One rule, not a table.
//
// ── The rule ──────────────────────────────────────────────────────────────────────────────────────
//   The highest-preference family that did NOT build the diff runs the general pass.
//   If the PR touches a security path, the NEXT eligible family runs the lean security lens.
//   The fresh `pr-reviewer` subagent runs too, in whatever scope the project's review-config.json sets.
//
// That is the whole policy. It replaces a 273-line router with a four-row table, a two-passes-per-PR
// count, a HIGH-only branch on the fresh reviewer, and the REFUND-ASK / --fallback-after / DARK-layer
// protocol (ways-of-work-lean-pass S2.5 + S2.8). A capped family now simply falls to the next one:
// external quota is not worth a human round-trip when the next family is one line away.
//
// ── The two guards that survive, and why ──────────────────────────────────────────────────────────
//   1. A family NEVER reviews its own diff. With several families building, the default agent flag on a
//      Codex-built diff is Codex reviewing Codex — a same-family pass wearing a cross-family label, and
//      a silent downgrade nothing in a hand-driven flow would catch.
//   2. The security lens prefers a DIFFERENT family from the general pass, so the two external reads
//      bring different blind spots. With only one family available it runs both prompts and SAYS SO —
//      a missing layer that reads like a clean one is worse than no layer.
//
// Usage:
//   node scripts/review-route.mjs --builder claude <PR#> [--repo owner/repo] [--security] [--json]
//                                  [--exclude <family>]   # a family is quota-capped: route past it
//
// `--security` forces the lens on; without it the trigger is the PR's own changed paths
// (scripts/review-config.json → securityPaths), which is what makes it un-skippable by judgement.
//
// Zero npm deps — Node 18+. Pure policy exported for node:test; the CLI is a thin shell.

import { spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { die, need, hasCmd, AGENT_BIN } from './lib/cross-agent-cli.mjs';
import { changedFileCount, decideSecurityPass, parseReviewConfig } from './lib/review-guard.mjs';
import { readSection } from './lib/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Every family that can build — which is exactly why guard 1 exists. */
export const BUILDERS = ['claude', 'codex', 'agy', 'vibe'];

/**
 * Preference order. One editable list, not roles hardcoded per pass.
 * codex first: the strongest observed review signal here. agy and vibe are independent quota pools.
 * claude LAST — not because it reviews badly, but because Claude capacity is usually the thing BUILDING.
 */
export const PREFERENCE = ['codex', 'agy', 'vibe', 'claude'];

/** `cross-review.mjs --agent` takes the long name for antigravity; the rest match. */
export const AGENT_FLAG = { codex: 'codex', agy: 'antigravity', vibe: 'vibe', claude: 'claude' };

/**
 * THE POLICY. Pure — no I/O, no availability probing — so it reads as one decision and is pinned by tests.
 * Returns { general, security, notes }. `security` is null when the lens is not triggered.
 */
export function planReview({ builder, available = PREFERENCE, securityPass = false }) {
  if (!BUILDERS.includes(builder))
    throw new Error(`unknown builder '${builder}' (expected: ${BUILDERS.join(' | ')})`);
  const eligible = PREFERENCE.filter((f) => f !== builder && available.includes(f));
  const general = eligible[0] ?? null;
  // Prefer a different family for the security lens; fall back to the general one rather than skipping.
  const security = securityPass ? (eligible[1] ?? general) : null;

  const notes = [];
  if (general)
    notes.push(
      `${general} runs the general pass because ${builder} built it — a family never reviews its own diff.`
    );
  else
    notes.push(
      `NO external family is available: the cross-family layer is DARK for this PR. Say so in the PR body rather than letting a missing layer look like a clean one.`
    );
  if (securityPass) {
    if (security && security !== general)
      notes.push(
        `${security} runs the security lens — a different family from the general pass, so the two reads have different blind spots.`
      );
    else if (security)
      notes.push(
        `${security} runs BOTH passes (no second family available) — two prompts, one family. Record that in the PR body: family independence is short here.`
      );
    else notes.push(`The security lens is triggered but no family can run it. Say so in the PR body.`);
  }
  notes.push(
    'The fresh `pr-reviewer` subagent runs as well — context independence is a different axis from family independence.'
  );
  return { builder, general, security, notes };
}

/** The exact commands to run, in order. Pure. */
export function renderPlan(plan, pr, repo) {
  // `--builder` rides along so cross-review's pairing guard (and its codex→agy heal re-check) fire in
  // normal use, not only when someone remembers to pass it (distribute-what-we-use S1, pr-reviewer B3).
  const arg = (f) =>
    `node scripts/cross-review.mjs ${pr}${repo ? ` --repo ${repo}` : ''} --agent ${AGENT_FLAG[f]} --builder ${plan.builder}`;
  const l = [
    `Review plan — PR #${pr}${repo ? ` (${repo})` : ''}`,
    `  built by:       ${plan.builder}`,
    `  general pass:   ${plan.general || '⚠ NONE AVAILABLE'}`,
    `  security lens:  ${plan.security || 'not triggered'}`,
    '',
  ];
  for (const n of plan.notes) l.push(`  · ${n}`);
  l.push('');
  l.push('  Run:');
  if (plan.general) l.push(`    ${arg(plan.general)}`);
  if (plan.security) l.push(`    ${arg(plan.security)} --lens security`);
  l.push(`    then: use the pr-reviewer subagent on PR #${pr}`);
  return l.join('\n');
}

/** Changed files + body for the security trigger. Degrades to "not triggered" only with a loud note. */
function prFacts(pr, repo, deps = {}) {
  const run = deps.spawn ?? spawnSync;
  const args = ['pr', 'view', String(pr), '--json', 'files,body'];
  if (repo) args.push('--repo', repo);
  const r = run('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    return { files: j.files || [], body: j.body || '' };
  } catch {
    return null;
  }
}

function main() {
  const argv = process.argv.slice(2);
  let builder = null;
  let pr = null;
  let repo = null;
  let json = false;
  let forceSecurity = false;
  let tierIgnored = false;
  const excluded = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--builder') builder = need(argv[++i], '--builder');
    else if (a === '--repo') repo = need(argv[++i], '--repo');
    else if (a === '--json') json = true;
    else if (a === '--security') forceSecurity = true;
    else if (a === '--tier') {
      // Accepted so an old invocation does not die, but SAID OUT LOUD: the tier no longer selects
      // reviewers, and silently ignoring it would let an old `--tier high` call believe it had asked
      // for the security lens.
      argv[++i];
      tierIgnored = true;
    } else if (a === '--exclude') excluded.push(need(argv[++i], '--exclude'));
    else if (!a.startsWith('-') && pr === null) pr = a;
    else die(`unknown argument '${a}'`);
  }
  if (!builder) die('--builder is required (who wrote the diff): ' + BUILDERS.join(' | '));
  if (!pr) die('a PR number is required');
  if (!BUILDERS.includes(builder)) die(`unknown --builder '${builder}' (expected: ${BUILDERS.join(' | ')})`);

  // The `review` section of golden-frijoles.config.json over scripts/review-config.json (D9).
  const { raw: reviewRaw, present: reviewPresent } = readSection('review', {
    legacyPath: join(__dirname, 'review-config.json'),
    onLegacyError: (_p, e) => {
      throw e;
    },
  });
  if (!reviewPresent)
    die('scripts/review-config.json not found, and golden-frijoles.config.json has no review section');
  const config = parseReviewConfig(reviewRaw);
  let securityPass = forceSecurity;
  let trigger = forceSecurity ? 'forced with --security' : null;
  if (!forceSecurity) {
    const facts = prFacts(pr, repo);
    if (!facts) {
      // Three states, never two: "I could not check" is not "no security path touched".
      die(
        `could not read PR #${pr}'s changed files — the security trigger is UNKNOWN, not false. Re-run when gh works, or pass --security.`
      );
    }
    const decision = decideSecurityPass({
      files: facts.files,
      body: facts.body,
      securityPaths: config.securityPaths,
      totalFiles: changedFileCount({ pr, repo }),
    });
    securityPass = decision.run;
    trigger = decision.reason;
  }
  // `hasCmd` says INSTALLED, not UNCAPPED — a quota-capped CLI is present and answers `--version`.
  // There is no way to know a family is capped without spending a run on it, so the fallback is
  // operator-driven and one command long: re-run with `--exclude <family>` and the next one is routed.
  // (cross-review.mjs additionally self-heals the common case: a dead codex token falls to agy mid-run.)
  const available = PREFERENCE.filter((f) => hasCmd(AGENT_BIN[AGENT_FLAG[f]]) && !excluded.includes(f));
  const plan = planReview({ builder, available, securityPass });
  if (tierIgnored) {
    process.stderr.write(
      '⚠ --tier is ignored: the risk tier no longer selects reviewers. The security lens is triggered by ' +
        'the changed paths (scripts/review-config.json) or a `risk: high` PR body — pass --security to force it.\n'
    );
  }
  if (json) {
    writeSync(
      1,
      `${JSON.stringify({ pr, repo, trigger, reviewScope: config.reviewScope, ...plan }, null, 2)}\n`
    );
    return;
  }
  writeSync(
    1,
    `${renderPlan(plan, pr, repo)}\n\n  security trigger: ${trigger}\n  review scope:     ${config.reviewScope}\n`
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
