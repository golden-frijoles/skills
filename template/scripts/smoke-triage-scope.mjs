#!/usr/bin/env node
// smoke-triage-scope.mjs — may the nightly smoke-triage routine merge THIS diff by itself?
//
// WHY THIS EXISTS AS A FILE, AND NOT AS A PARAGRAPH IN THE ROUTINE PROMPT.
//
// Routine B (scripts/routines/smoke-triage.prompt.md) used to stop at a draft PR. Three nights
// running — 2026-08-15/16/17 — it produced a draft nobody merged, and the 08-16 and 08-17 drafts
// independently re-diagnosed the SAME defect from scratch. The nightly stayed red the whole time.
// A fixer that cannot land its fix is a fixer that re-does its work every night.
//
// So the routine now merges. The question that decides everything is "merge WHAT?", and that
// question must not be answered by a model reading its own diff at 10:00 UTC with nobody watching.
// It is a deterministic, reviewable predicate, so it lives here with node:test coverage — the same
// reasoning that moved the prod-smoke checks out of a cloud text box and into scripts/prod-smoke.mjs.
//
// TWO INDEPENDENT GATES, BOTH MUST PASS.
//
//   1. SURFACE — every changed path is test scaffolding (e2e/, the Playwright config, the browser
//      smoke workflow). A fix to app/, lib/ or components/ changes what customers get and stays a
//      draft for a human, no matter how green it is. The product owner's call (origin project, 2026-08-17).
//
//   2. NO WEAKENING — the diff must not make the smoke pass by asking it to test less. This is the
//      one that actually needs machinery. "Never weaken the test" has been written in the routine
//      prompt since it was created, and a prompt rule is a request; deleting a red spec is the
//      single cheapest way for any agent to turn a red nightly green, and it looks like a fix in
//      every summary it would write about itself. So it is checked against the patch, not asked for.
//
// Gate 2 deliberately blocks things that are RIGHT but not the routine's to decide. Retiring the
// zero-photo gallery spec on 2026-08-17 was correct — and it was correct because the product owner
// said so, after it had been surfaced to them twice. Blocked-to-draft is not "rejected"; it is the
// same PR, waiting for the person whose call it is. That is the intended cost.
//
// A blocked diff is NEVER discarded and never silently trimmed to fit. The routine opens the draft
// PR exactly as before and pings. Degrading to yesterday's behaviour is the correct failure mode.
//
// ── The policy is the PROJECT's, and it is REQUIRED (plugin-audit-and-extraction D4) ────────────
// Which paths count as test scaffolding, and which calls are assertions, are facts about ONE project's
// layout. The origin hard-coded its own. A template default here would be the worst failure mode in the
// whole epic: a routine in a project whose layout differs would ALLOW merges of things that are not test
// scaffolding, or miss the deletion of that project's own assertion helper. So both live in the
// committed smoke-triage.config.json:
//   { "testSurface": [ { "prefix": "e2e/", "why": "…" }, { "exact": "playwright.config.ts", "why": "…" } ],
//     "assertionCalls": ["expect", "expectListingFound"] }
// and an absent or malformed policy is UNDECIDABLE — never allow, never a default. Fail closed.
//
//   node scripts/smoke-triage-scope.mjs --repo <owner/name> --pr <n>   # decide a live PR
//   node scripts/smoke-triage-scope.mjs --json                          # machine-readable
//
// Exit codes are three-valued (AGENTS.md — "three states, never two"):
//   0  auto-merge ALLOWED
//   1  auto-merge BLOCKED — open/keep the draft PR and ping (a normal, expected outcome)
//   2  UNDECIDABLE — the diff could not be read at all. Never treat this as either answer.

import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readSection } from './lib/config.mjs';
import { isMain } from './lib/is-main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const POLICY_PATH = join(__dirname, '..', 'smoke-triage.config.json');

// ── Gate 1: the test surface ──────────────────────────────────────────────────────────────────
//
// An allow-list, not a deny-list. A deny-list of "app code" silently admits every directory nobody
// thought of — including ones that do not exist yet. Whatever is not named here is app code by
// default, which is the safe direction to be wrong in for a gate that ends in a production deploy.
// The shape of each rule: `{ prefix, why }` or `{ exact, why }`. Supplied by the project's policy.

// The gate's own files. A PR that edits either is judging itself: in a single-repo project the
// routine may read the policy from the very checkout the PR changed, so a PR could widen
// `testSurface` and then be allowed by the widened rule. Whatever the policy says, a change to the
// gate is a human's call — it is checked before the policy is even consulted for these paths.
export const GATE_FILES = ['smoke-triage.config.json', 'scripts/smoke-triage-scope.mjs'];

/**
 * Pure — validate a policy object. Returns `{ ok: true, policy }` or `{ ok: false, reason }`. Never
 * throws and never fills a gap with a default: a policy that is not fully specified is not a policy.
 */
export function validatePolicy(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'no smoke-triage policy' };
  const { testSurface, assertionCalls } = raw;
  if (!Array.isArray(testSurface) || testSurface.length === 0) {
    return { ok: false, reason: '"testSurface" must list at least one { prefix | exact, why } rule' };
  }
  for (const [i, r] of testSurface.entries()) {
    // Exactly one key PRESENT, and it a non-empty string — `{ exact, prefix: 5 }` is malformed, not an
    // exact rule with some noise beside it (it used to throw further down, which exits 1, not 2).
    const kinds = ['prefix', 'exact'].filter((k) => r?.[k] !== undefined);
    if (kinds.length !== 1 || typeof r[kinds[0]] !== 'string' || !r[kinds[0]]) {
      return {
        ok: false,
        reason: `"testSurface[${i}]" needs exactly one of "prefix" / "exact", a non-empty string`,
      };
    }
    if (typeof r.why !== 'string' || !r.why.trim())
      return { ok: false, reason: `"testSurface[${i}]" needs a "why"` };
    const value = r[kinds[0]];
    // A directory prefix's trailing slash is legitimate, but it must not skip the path check: strip it,
    // then normalize, so `../e2e/` or `a//b/` is refused like any other non-plain path.
    const bare = kinds[0] === 'prefix' && value.endsWith('/') ? value.slice(0, -1) : value;
    if (normalizeRepoPath(bare) === null) {
      return { ok: false, reason: `"testSurface[${i}]" is not a plain repo-relative path` };
    }
  }
  if (
    !Array.isArray(assertionCalls) ||
    assertionCalls.length === 0 ||
    assertionCalls.some((c) => !/^[A-Za-z_$][\w$]*$/.test(c))
  ) {
    return {
      ok: false,
      reason: '"assertionCalls" must list the assertion function names (at least "expect")',
    };
  }
  return { ok: true, policy: { testSurface, assertionCalls } };
}

/** Read the committed policy. Missing or malformed → `{ ok: false, reason }` naming the file. */
export function loadPolicy({ path = POLICY_PATH, exists = existsSync, read = readFileSync } = {}) {
  // `smoke.triage` in golden-frijoles.config.json over the legacy policy file (D9). This rail answers, never
  // throws, so a malformed legacy file is still an { ok: false } verdict, and validation stays here.
  let raw;
  let present;
  try {
    ({ raw, present } = readSection('smoke.triage', {
      legacyExists: exists,
      legacyRead: read,
      legacyPath: path,
      onLegacyError: (_p, e) => {
        throw Object.assign(new Error(e.message), { legacyInvalid: true });
      },
    }));
  } catch (e) {
    return { ok: false, reason: e.legacyInvalid ? `${path} is not valid JSON (${e.message})` : e.message };
  }
  if (!present)
    return {
      ok: false,
      reason: `${path} not found — the merge gate has no policy, so it cannot allow anything`,
    };
  const v = validatePolicy(raw);
  return v.ok ? v : { ok: false, reason: `${path}: ${v.reason}` };
}

/**
 * Normalize before matching, because `e2e/../app/page.tsx` starts with `e2e/` and is app code.
 * Returns null for anything that is not a plain repo-relative forward-slash path — absolute paths,
 * traversal that escapes the root, backslashes, empty segments. Null is REJECTED by the caller
 * rather than skipped: an unparseable path is a path we did not check, not a path that is fine.
 */
export function normalizeRepoPath(raw) {
  if (typeof raw !== 'string') return null;
  const path = raw.trim();
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null;
  const out = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') return null; // `a//b` and `./a` are not shapes git emits
    if (segment === '..') return null; // never resolve — just refuse
    out.push(segment);
  }
  return out.join('/');
}

export function isTestSurface(rawPath, testSurface) {
  const path = normalizeRepoPath(rawPath);
  if (path === null || !Array.isArray(testSurface)) return false;
  return testSurface.some((rule) => (rule.exact ? path === rule.exact : path.startsWith(rule.prefix)));
}

// ── Gate 2: weakening detection ───────────────────────────────────────────────────────────────
//
// Each pattern below is a way to make a red suite green without fixing anything. They are matched
// against ADDED lines (`+`) in the unified diff, except DELETED_ASSERTION which is the mirror case:
// an assertion that used to run and now does not.
//
// `test.slow()` is deliberately absent. Raising a timeout budget is a legitimate fix the repo has
// shipped (#349) and blocking it would make the routine useless for the most common real failure.
// Timeouts are also self-correcting: a budget that is too generous still fails when the thing is
// genuinely broken. Skips and deletions are not — they stop asking the question entirely.
export const WEAKENING_PATTERNS = [
  { id: 'skip-added', re: /(^|[^\w.])test\.skip\s*\(/, why: 'test.skip() added — the spec stops running' },
  {
    id: 'describe-skip-added',
    re: /(^|[^\w.])(test|describe)\.describe\.skip\s*\(|(^|[^\w.])describe\.skip\s*\(/,
    why: 'a whole describe block skipped',
  },
  {
    id: 'fixme-added',
    re: /(^|[^\w.])test\.fixme\s*\(/,
    why: 'test.fixme() added — the spec is marked as expected-to-fail',
  },
  {
    id: 'only-added',
    re: /(^|[^\w.])(test|describe)\.only\s*\(/,
    why: 'test.only() added — every OTHER spec in the file stops running',
  },
  {
    id: 'serial-added',
    re: /mode:\s*['"`]serial['"`]/,
    why: 'serial mode added — a failure there logs as "did not run", which reads as green-by-skip',
  },
];

/** An assertion that ran yesterday and does not run today — built from the policy's assertion names. */
export function deletedAssertionRule(assertionCalls) {
  const names = assertionCalls.map((n) => n.replace(/[$]/g, '\\$')).join('|');
  return {
    id: 'assertion-deleted',
    re: new RegExp(`(^|[^\\w.])(${names})\\s*\\(`),
    why: 'an assertion was removed — the spec now tests less than it did',
  };
}

/**
 * Read one file's unified-diff patch for weakenings.
 *
 * A file with NO patch is not a clean file. GitHub omits `patch` for binary blobs and for diffs
 * past its size cap, and "I could not read the diff" must not resolve to "the diff is fine" —
 * that is the confident-empty-result failure AGENTS.md rule 5 bans. It returns `readable: false`,
 * which the caller turns into UNDECIDABLE, not into a pass.
 */
export function inspectPatch(file, deletedAssertion) {
  const findings = [];
  const patch = file?.patch;
  if (typeof patch !== 'string' || patch === '') {
    // A pure rename/mode change legitimately carries no patch and changes no behaviour.
    if (file?.status === 'renamed' && (file?.changes ?? 0) === 0) return { readable: true, findings };
    return { readable: false, findings };
  }

  if (file.status === 'removed') {
    findings.push({ id: 'file-deleted', path: file.filename, why: 'a spec file was deleted outright' });
  }

  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue; // headers, not content
    const body = line.slice(1);
    if (line.startsWith('+')) {
      for (const p of WEAKENING_PATTERNS) {
        if (p.re.test(body)) findings.push({ id: p.id, path: file.filename, why: p.why, line: body.trim() });
      }
    } else if (line.startsWith('-')) {
      if (deletedAssertion.re.test(body)) {
        findings.push({
          id: deletedAssertion.id,
          path: file.filename,
          why: deletedAssertion.why,
          line: body.trim(),
        });
      }
    }
  }
  return { readable: true, findings };
}

// ── The decision ──────────────────────────────────────────────────────────────────────────────

/**
 * @param {Array<{filename: string, status?: string, patch?: string, changes?: number}>} files
 *        exactly the shape of `GET /repos/{owner}/{repo}/pulls/{n}/files`.
 * @returns {{verdict: 'allow'|'block'|'undecidable', exitCode: 0|1|2, blockers: object[], surface: string[], appCode: string[]}}
 */
export function decideAutoMerge(files, policy) {
  // FAIL CLOSED (D4). No valid policy means no answer — checked FIRST, before a single file is read.
  const checked = validatePolicy(policy);
  if (!checked.ok) {
    return {
      verdict: 'undecidable',
      exitCode: 2,
      surface: [],
      appCode: [],
      blockers: [
        {
          id: 'no-policy',
          why: `${checked.reason} — refusing to authorize any merge without the project's own policy`,
        },
      ],
    };
  }
  const { testSurface, assertionCalls } = checked.policy;
  const deletedAssertion = deletedAssertionRule(assertionCalls);

  // An empty file list is UNDECIDABLE, never `allow`. A PR with no files is not a safe PR; it is a
  // symptom — a bad ref, a failed API call, a truncated page. "Exited green having run nothing"
  // is the exact failure this repo deletes scripts for.
  if (!Array.isArray(files) || files.length === 0) {
    return {
      verdict: 'undecidable',
      exitCode: 2,
      surface: [],
      appCode: [],
      blockers: [
        {
          id: 'no-files',
          why: 'the PR reported zero changed files — the diff was not read, so nothing was checked',
        },
      ],
    };
  }

  const surface = [];
  const appCode = [];
  const blockers = [];
  let undecidable = false;

  for (const file of files) {
    const path = file?.filename;
    if (GATE_FILES.includes(normalizeRepoPath(path))) {
      blockers.push({
        id: 'gate-self-modification',
        path,
        why: 'this PR changes the merge gate itself (its policy or its script) — a gate cannot authorize its own change',
      });
    }
    if (isTestSurface(path, testSurface)) surface.push(path);
    else {
      appCode.push(path ?? String(path));
      blockers.push({
        id: 'outside-test-surface',
        path: path ?? String(path),
        why: 'not test scaffolding — a change here reaches production, so a human reads it',
      });
    }

    const { readable, findings } = inspectPatch(file, deletedAssertion);
    if (!readable) {
      undecidable = true;
      blockers.push({
        id: 'patch-unreadable',
        path,
        why: 'GitHub returned no patch for this file (binary or too large) — it could not be checked',
      });
    }
    blockers.push(...findings);
  }

  if (undecidable) return { verdict: 'undecidable', exitCode: 2, blockers, surface, appCode };
  if (blockers.length > 0) return { verdict: 'block', exitCode: 1, blockers, surface, appCode };
  return { verdict: 'allow', exitCode: 0, blockers: [], surface, appCode };
}

export function formatReport(decision) {
  const lines = [];
  const headline = {
    allow: 'ALLOW — auto-merge permitted: test scaffolding only, nothing weakened',
    block: 'BLOCK — open/keep the DRAFT PR and ping the product owner',
    undecidable: 'UNDECIDABLE — the diff could not be fully read; treat as BLOCK and say so',
  }[decision.verdict];
  lines.push(`smoke-triage scope: ${headline}`);
  if (decision.surface.length)
    lines.push(`  test surface (${decision.surface.length}): ${decision.surface.join(', ')}`);
  if (decision.appCode.length)
    lines.push(`  app code (${decision.appCode.length}): ${decision.appCode.join(', ')}`);
  for (const b of decision.blockers) {
    lines.push(`  ✗ [${b.id}]${b.path ? ` ${b.path}` : ''} — ${b.why}${b.line ? `\n      ${b.line}` : ''}`);
  }
  return lines.join('\n');
}

// ── I/O shell ─────────────────────────────────────────────────────────────────────────────────
//
// REST only, via gh. `gh pr view --json` reaches GraphQL internally, which is blocked in at least
// one live routine sandbox (scripts/lib/gh-rest.mjs records the same constraint).

async function fetchFiles(repo, pr, deps) {
  const { execFileSync } = deps;
  const out = execFileSync('gh', ['api', '--paginate', `repos/${repo}/pulls/${pr}/files`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // --paginate concatenates JSON arrays; stitch them back into one.
  return JSON.parse(
    `[${out
      .trim()
      .replace(/\]\s*\[/g, ',')
      .replace(/^\[|\]$/g, '')}]`
  );
}

export async function main(argv, deps = {}) {
  const { values } = parseArgs({
    args: argv,
    options: { repo: { type: 'string' }, pr: { type: 'string' }, json: { type: 'boolean', default: false } },
    allowPositionals: false,
  });
  if (!values.repo || !values.pr) {
    process.stderr.write('usage: smoke-triage-scope.mjs --repo <owner/name> --pr <number> [--json]\n');
    return 2;
  }

  const policy = (deps.loadPolicy ?? loadPolicy)();
  if (!policy.ok) {
    const message = `UNDECIDABLE — ${policy.reason}`;
    process.stdout.write(
      values.json ? `${JSON.stringify({ verdict: 'undecidable', error: message })}\n` : `${message}\n`
    );
    return 2;
  }

  let files;
  try {
    const { execFileSync } = await import('node:child_process');
    files = await fetchFiles(values.repo, values.pr, { execFileSync, ...deps });
  } catch (error) {
    // Could not ask. That is state 2 — not "nothing to worry about".
    const message = `UNDECIDABLE — could not read PR ${values.repo}#${values.pr}: ${error.message}`;
    process.stdout.write(
      values.json ? `${JSON.stringify({ verdict: 'undecidable', error: message })}\n` : `${message}\n`
    );
    return 2;
  }

  const decision = decideAutoMerge(files, policy.policy);
  process.stdout.write(
    values.json ? `${JSON.stringify(decision, null, 2)}\n` : `${formatReport(decision)}\n`
  );
  return decision.exitCode;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
