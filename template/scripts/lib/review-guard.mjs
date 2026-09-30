// review-guard.mjs — the three small decisions the one-external-pass review stack rests on.
//
// Byte-identical in dobby-foundation's template and every consuming project (ways-of-work-lean-pass
// D11). Project-specific values live in `scripts/review-config.json`, never in this file.
//
// ── Since jev-semantic-guards (2026-09-23): Jev DECIDES "is this a real review?"; the regex below is the
// OFFLINE FALLBACK ── `judgeReviewOutput` (section 4) is what cross-review calls. `assertReviewOutput` still
// decides, byte-unchanged, whenever Jev cannot look (no key, egress:false, 429, timeout) or is unsure, and
// always when jev.config.json → rails.review.mode is `off`. Measured on 76 labelled replies: the judge 100%,
// this regex alone 86.8% — it rejected real prose findings and accepted plan transcripts (sprint-5.md).
//
// ── 1. A silent reviewer is a FAILED run (D9) ──────────────────────────────────────────────────────
// With two external passes, a CLI that exited 0 and printed nothing was contradicted by the other one.
// With one, nothing contradicts it: an empty or structureless reply reads exactly like "looks clean".
// That has already happened here — agy 1.0.10 silently changed its print contract and shipped empty
// reviews for weeks. So a reply must carry STRUCTURE: a severity heading, or an explicit clean verdict.
// Anything else fails the run, fails the PR's `cross-review/<lens>` status, and exits non-zero.
// Kept deliberately permissive about wording — a guard that rejects a real review trains people to
// bypass it — and strict only about "is there a review in here at all". Widened 2026-09-16 after a
// sweep of 593 machine-posted reviews found it would have rejected genuine ones: a bulleted or bold
// severity marker (`- **Blocking**: …`), a `**Findings**` heading, a `**Correctness & architecture**`
// prose review, and a bare `**None**` all count. The caller ALSO prints the full rejected reply, so a
// false reject can never destroy a review that cost a real run.
//
// ── 2. The security pass is triggered by PATHS, not by the builder's judgement (D7) ────────────────
// A PR gets the lean security lens when a changed file matches the project's `securityPaths` globs, or
// its body declares `risk: high`. The builder can always add the lens by hand; it cannot skip it.
//
// ── 3. The CLI version is RECORDED, not a hard stop ────────────────────────────────────────────────
// The output guard above is what catches a CLI whose print contract changed. A hard version pin on top
// would take the only external pass offline on every routine CLI update — the "one busy model took a
// whole family offline" failure this repo already recorded for agy. So the version lands in the PR
// comment and status, with a loud note when it differs from the last version verified to produce real
// reviews. (agy keeps its own hard pin in cross-agent-cli.mjs: its print contract has broken twice.)
//
// Zero deps — Node 18+.

import { spawnSync } from 'node:child_process';
import { jevContext } from './jev.mjs';
import { loadQuestions, wireQuestion } from './jev-questions.mjs';

/** Codex CLI version last observed producing a real, structured review. Bump after a verified run. */
export const CODEX_VERIFIED = '0.154.0';

const SEVERITY_HEADING =
  /^\s{0,3}(?:[-*+]\s+|\d+\.\s+|>\s*|\|\s*)?(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:🔴|🟠|🟡|⚪)?\s*(?:blocking|should[- ]fix|nits?|important|critical|findings?|correctness(?:\s*(?:&|and)\s*architecture)?|security(?: review)? findings?)\b/im;
/^\s{0,3}(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:🔴|🟠|🟡|⚪)?\s*(?:blocking|should[- ]fix|nits?|important|critical)\b/im;
const CLEAN_VERDICT =
  /(?:^\s{0,3}(?:[-*+]\s+)?(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:clean|none)\b|\bassessment:\s*(?:\*\*)?\s*clean\b|\bno\s+(?:\*\*)?(?:blocking|security|should[- ]fix|nit)\b[^.\n]{0,80}\b(?:findings|issues|problems)\b|\bno (?:findings|issues|problems)\b|\bnothing (?:to report|found|blocking)\b|\blooks clean\b|\bdiff (?:is|looks) clean\b|\bno concerns\b)/im;
/(?:^\s{0,3}(?:#{1,6}\s*)?(?:\*\*|__)?\s*clean\b|\bassessment:\s*(?:\*\*)?\s*clean\b|\bno (?:blocking |security )?(?:findings|issues|problems)\b|\bnothing (?:to report|found|blocking)\b|\blooks clean\b|\bdiff (?:is|looks) clean\b|\bno concerns\b)/im;
// A reviewer that emitted a raw tool call instead of a review — observed twice from vibe on real PRs
// (`read_file{"path": …}`, `write_file…{"file_path": …}`). Its JSON can CONTAIN review-shaped words, so
// this is checked first and wins.
const TOOL_TRANSCRIPT = /^\s*[a-z_]+\S*\s*\{\s*"/i;

/**
 * THE GUARD. Pure. Returns { ok, reason }.
 * ok when the reply has a severity heading or an explicit clean verdict; fails on empty, whitespace,
 * or prose with neither (a CLI banner, an error page, a truncated tool transcript).
 */
export function assertReviewOutput(text) {
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, reason: 'the reviewer returned no output' };
  if (TOOL_TRANSCRIPT.test(t))
    return { ok: false, reason: `the reviewer emitted a raw tool call, not a review ("${t.slice(0, 80)}")` };
  if (SEVERITY_HEADING.test(t)) return { ok: true, reason: 'severity-structured findings' };
  if (CLEAN_VERDICT.test(t)) return { ok: true, reason: 'explicit clean verdict' };
  return {
    ok: false,
    reason: `the reviewer's reply has no severity heading and no clean verdict — not a review (first line: "${t.split('\n')[0].slice(0, 120)}")`,
  };
}

/** Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char. Anchored, case-sensitive. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Does this PR get the security lens? Pure.
 * files: [{ path }] or strings · body: PR body · securityPaths: globs from review-config.json.
 */
/** `gh pr view --json files` returns at most this many files, silently. */
export const GRAPHQL_FILE_CAP = 100;

/**
 * The files that DEFINE the security trigger always trigger it, whatever `securityPaths` says. The list is read from
 * the reviewer's checkout, which may be the PR's own branch: a PR that narrows `review.securityPaths` in
 * golden-frijoles.config.json (or scripts/review-config.json) must get the lens on exactly that change, or it could
 * switch the lens off for itself (security lens on #49).
 */
export const ALWAYS_SECURITY_PATHS = Object.freeze([
  'golden-frijoles.config.json',
  'scripts/review-config.json',
  // The code that reads that config and makes the decision is the trigger too: a PR that edits the loader or the
  // router could make the settings say anything (security lens on #49, round 4).
  'scripts/lib/config.mjs',
  'scripts/lib/review-guard.mjs',
  'scripts/review-route.mjs',
  'scripts/cross-review.mjs',
]);

export function decideSecurityPass({ files = [], body = '', securityPaths = [], totalFiles = null }) {
  const paths = files.map((f) => (typeof f === 'string' ? f : f.path)).filter(Boolean);
  const res = [...ALWAYS_SECURITY_PATHS, ...securityPaths].map(globToRegExp);
  const matched = paths.filter((p) => res.some((r) => r.test(p)));
  if (matched.length)
    return {
      run: true,
      reason: `touches security paths: ${matched.slice(0, 5).join(', ')}${matched.length > 5 ? ` (+${matched.length - 5})` : ''}`,
      matched,
    };
  // Requires the punctuation or the word "tier": plain prose like "a low-risk, high-value change" is not
  // a declaration.
  if (/\brisk\s*tier\s*[:=]\s*\**\s*high\b|\brisk\s*[:=]\s*\**\s*high\b/i.test(body))
    return { run: true, reason: 'PR body declares risk: high', matched: [] };
  // `gh pr view --json files` silently caps at 100 files — measured on a 108-file PR. A security file
  // sorted past #100 would read as "no security path touched": a confident false negative on exactly
  // the large refactor that most needs the lens. An incomplete list is UNKNOWN, and unknown forces the
  // lens ON rather than off.
  if (Number.isInteger(totalFiles) && totalFiles > paths.length)
    return {
      run: true,
      reason: `file list truncated (${paths.length} of ${totalFiles} changed files seen) — lens forced on`,
      matched: [],
    };
  // The REST count could not be read AND the list is at the GraphQL cap: truncation cannot be ruled out,
  // and an unreadable total must not FAIL OPEN. Found independently by codex on two PRs and by the
  // security lens itself. Under the cap the list is complete, so a missing count changes nothing there.
  if (totalFiles == null && paths.length >= GRAPHQL_FILE_CAP)
    return {
      run: true,
      reason: `${paths.length} files listed (the gh cap) and the true count could not be read — lens forced on`,
      matched: [],
    };
  return { run: false, reason: 'no security path touched and no risk: high declared', matched: [] };
}

/**
 * Validate a parsed `scripts/review-config.json`. Pure; throws with a named problem rather than
 * defaulting — a missing config silently meaning "review nothing" is the confident-empty failure.
 */
export function parseReviewConfig(json) {
  const scopes = ['every-pr', 'security-paths-only'];
  if (!json || typeof json !== 'object') throw new Error('review-config.json: not an object');
  if (!scopes.includes(json.reviewScope))
    throw new Error(`review-config.json: reviewScope must be one of ${scopes.join(' | ')}`);
  if (
    !Array.isArray(json.securityPaths) ||
    !json.securityPaths.length ||
    json.securityPaths.some((g) => typeof g !== 'string' || !g)
  ) {
    throw new Error('review-config.json: securityPaths must be a non-empty array of globs');
  }
  return { reviewScope: json.reviewScope, securityPaths: json.securityPaths };
}

/**
 * The PR's TRUE changed-file count, from the REST endpoint (the GraphQL-backed `gh pr view --json files`
 * silently caps at 100). null when it cannot be read — never a guess; the trigger treats null as "no
 * extra signal" and the caller has already failed loudly if it could not read the file list at all.
 */
export function changedFileCount({ pr, repo = null }, deps = {}) {
  const run = deps.spawn ?? spawnSync;
  let fullRepo = repo;
  if (!fullRepo) {
    const view = run('gh', ['pr', 'view', String(pr), '--json', 'url'], { encoding: 'utf8' });
    if (view.status !== 0) return null;
    try {
      fullRepo = new URL(JSON.parse(view.stdout).url).pathname.split('/').slice(1, 3).join('/');
    } catch {
      return null;
    }
  }
  const r = run('gh', ['api', `repos/${fullRepo}/pulls/${pr}`, '--jq', '.changed_files'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const n = Number(String(r.stdout).trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The `gh api` argv that sets a commit status. Pure, so the shape is pinned by a test. */
export function commitStatusArgs({ repo, sha, state, lens, description }) {
  const context = `cross-review/${lens || 'general'}`;
  return [
    'api',
    '--method',
    'POST',
    `repos/${repo}/statuses/${sha}`,
    '-f',
    `state=${state}`,
    '-f',
    `context=${context}`,
    '-f',
    `description=${String(description).slice(0, 140)}`,
  ];
}

/**
 * Post the status for a PR head. I/O shell with injectable spawn. Returns { posted, detail } and never
 * throws: a status that could not be posted is reported by the caller, it does not mask the verdict.
 */
export function postReviewStatus({ pr, repo, state, lens, description, sha = null }, deps = {}) {
  const run = deps.spawn ?? spawnSync;
  let head = sha;
  let fullRepo = repo;
  if (!head || !fullRepo) {
    const view = run(
      'gh',
      ['pr', 'view', String(pr), '--json', 'headRefOid,url', ...(repo ? ['--repo', repo] : [])],
      { encoding: 'utf8' }
    );
    if (view.status !== 0)
      return {
        posted: false,
        detail: `could not resolve PR #${pr} head: ${(view.stderr || '').trim().split('\n')[0]}`,
      };
    try {
      const j = JSON.parse(view.stdout);
      head = head || j.headRefOid;
      if (!fullRepo) fullRepo = new URL(j.url).pathname.split('/').slice(1, 3).join('/');
    } catch {
      return { posted: false, detail: 'unparseable gh pr view output' };
    }
  }
  // A partial `gh pr view` payload used to reach `head.slice(...)` and throw out of a function whose
  // contract is that it never throws — masking the review verdict behind a stack trace.
  if (typeof head !== 'string' || head.length < 7)
    return { posted: false, detail: `no usable head sha for PR #${pr}` };
  if (!fullRepo) return { posted: false, detail: `no repo for PR #${pr}` };
  const r = run('gh', commitStatusArgs({ repo: fullRepo, sha: head, state, lens, description }), {
    encoding: 'utf8',
  });
  if (r.status !== 0)
    return { posted: false, detail: `gh api statuses failed: ${(r.stderr || '').trim().split('\n')[0]}` };
  return { posted: true, detail: `${state} on ${fullRepo}@${head.slice(0, 7)}` };
}

/** The reviewer CLI's version, for the record. Three states: a version, 'unknown', never a guess. */
export function cliVersionNote(agent, deps = {}) {
  const run = deps.spawn ?? spawnSync;
  const bin = { codex: 'codex', antigravity: 'agy', vibe: 'vibe', claude: 'claude' }[agent] || agent;
  const r = run(bin, ['--version'], { encoding: 'utf8' });
  const m = /\d+\.\d+\.\d+/.exec(`${r.stdout || ''}${r.stderr || ''}`);
  if (!m) return `${bin} version unknown`;
  if (agent === 'codex' && m[0] !== CODEX_VERIFIED) {
    return `${bin} ${m[0]} — ⚠ NOT the last verified version (${CODEX_VERIFIED}); the output guard still applied. Bump CODEX_VERIFIED in scripts/lib/review-guard.mjs after a clean run.`;
  }
  return `${bin} ${m[0]}`;
}

/** The hidden marker every review comment carries, so a later run knows WHAT was reviewed. */
export function reviewMarker({ lens = null, sha = null } = {}) {
  return `\n<!-- cross-review lens=${lens || 'general'} sha=${sha || 'unknown'} -->`;
}

/**
 * Re-review convergence (D8): Important-findings-only when this lens has ALREADY reviewed a DIFFERENT
 * commit. A retry on the SAME commit — the first run died posting its status, say — is not a re-review,
 * and suppressing its Should-fix and nits would silently shrink the only pass that PR ever got.
 * A comment with no marker predates them and is treated as a re-review: the conservative side.
 */
export function isReReview(commentBodies = [], lens = null, headSha = null) {
  const title =
    lens === 'security' ? /^### 🔐 Cross-agent review — security lens/m : /^### 🔎 Cross-agent review \(/m;
  const wanted = lens || 'general';
  return commentBodies.some((body) => {
    const b = String(body);
    if (!title.test(b)) return false;
    const m = /<!-- cross-review lens=(\S+) sha=(\S+) -->/.exec(b);
    if (!m) return true;
    if (m[1] !== wanted) return false;
    return !headSha || m[2] !== headSha;
  });
}

export const RE_REVIEW_NOTE =
  '\n\n## RE-REVIEW\nA previous pass already reviewed this PR and the author has pushed changes since. Report **Blocking and Should-fix findings only** — no nits, and do not repeat a finding the author has already fixed or answered on the PR.\n';

// ── 4. Jev decides the SEMANTIC question (jev-semantic-guards D4/D5) ────────────────────────────────
// `assertReviewOutput` above is a regex asking a language question — "did the reviewer actually review?" —
// and on 2026-09-19 it answered it wrong in both directions: it REJECTED a real finding written as plain
// prose, and ACCEPTED `## Findings` followed by "(reviewer timed out before completing analysis)". Jev
// (TypeSafe's calibrated typed-judgement model) got both right. So the judge below asks Jev, by
// `jev.config.json → rails.review.mode`:
//   off    → exactly `assertReviewOutput`; no call, no log line. The kill-switch.
//   shadow → the regex decides; Jev is asked and BOTH verdicts are logged (.jev/decisions.jsonl + marker).
//   jev    → Jev decides at noul ≥ thresholds.real / ≤ thresholds.notReal; the regex decides in the band
//            between ("uncertain") or when Jev could not look (no key, 429, timeout…). Never a guess.
// Two SHAPES stay mechanical and are decided before Jev is asked: an empty reply and a raw tool-call
// transcript. Those are not language judgements, and a model has nothing to add to them.
// `reason` always names who decided, so a regex fallback can never be read as a Jev verdict.

/** Reviewer replies are truncated to this for Jev (the 32k-token state budget), with a note. */
export const REVIEW_STATE_CHARS = 60_000;

// The questions are DATA (compiled-prompts D2): `lib/jev-questions/review.json`, each with its measurement beside it.
// Their wording was measured, not guessed: "Is this a genuine review?" scored a real prose finding 0.73, and
// "Does it contain an assessment of a code change?" left terse clean verdicts ("Clean.", "Blocking: None.") in the
// uncertain band; naming the terse verdicts and the failure shapes fixed both (2026-09-23). A recording pins the
// wording by hash, so an edit fails `node scripts/jev-eval.mjs` until `--live` re-measures it.
export const REVIEW_QUESTIONS = Object.fromEntries(
  loadQuestions('review').map((q) => [q.id, wireQuestion(q)])
);

/**
 * The state Jev sees: the reply, or — when it would not fit — its HEAD and TAIL with a note between. The tail
 * matters most: a reviewer states its verdict last, and a head-only cut of a 124k-character reply showed Jev
 * nothing but a file-list preamble (2026-09-23 backtest). Pure.
 */
export function reviewState(text) {
  const t = String(text ?? '');
  if (t.length <= REVIEW_STATE_CHARS) return t;
  const head = Math.floor(REVIEW_STATE_CHARS / 3);
  const tail = REVIEW_STATE_CHARS - head;
  return `${t.slice(0, head)}\n\n[… ${t.length - REVIEW_STATE_CHARS} characters omitted from the middle for length …]\n\n${t.slice(-tail)}`;
}

/**
 * Pure: the decision, given the regex verdict, Jev's result and the rail config. Exported so the eval
 * harness and the specs pin the policy without a network.
 */
export function decideReview({ regex, jev, mode, thresholds, error = null }) {
  const base = { mode, regexOk: regex.ok, jev: jev ?? null, error };
  if (mode === 'off') return { ...base, ok: regex.ok, decider: 'regex', reason: regex.reason };
  if (mode === 'shadow')
    return {
      ...base,
      ok: regex.ok,
      decider: 'regex',
      reason: `${regex.reason} — decided by regex (shadow${jev ? `; jev ${jev.noul.toFixed(2)}` : `; jev could not look (${error})`})`,
    };
  if (!jev)
    return {
      ...base,
      ok: regex.ok,
      decider: 'regex',
      reason: `${regex.reason} — decided by regex: jev could not look (${error})`,
    };
  if (jev.noul >= thresholds.real)
    return {
      ...base,
      ok: true,
      decider: 'jev',
      reason: `a real review (${jev.severity}) — decided by jev (${jev.noul.toFixed(2)})`,
    };
  if (jev.noul <= thresholds.notReal)
    return {
      ...base,
      ok: false,
      decider: 'jev',
      reason: `the reviewer's reply is not a review — decided by jev (${jev.noul.toFixed(2)}); first line: "${String(regex.firstLine ?? '').slice(0, 120)}"`,
    };
  return {
    ...base,
    ok: regex.ok,
    decider: 'regex',
    reason: `${regex.reason} — decided by regex: jev uncertain (${jev.noul.toFixed(2)})`,
  };
}

/**
 * THE JUDGE. async; never throws on a Jev failure (a malformed jev.config.json DOES throw — loudly).
 * Returns { ok, reason, decider, mode, regexOk, jev: {noul, severity, model} | null, error }.
 * opts: { sha, source } for the log. deps: see jevContext (config, key, ask, log, root).
 */
export async function judgeReviewOutput(text, opts = {}, deps = {}) {
  const t = String(text ?? '').trim();
  const regex = { ...assertReviewOutput(t), firstLine: t.split('\n')[0] };
  const ctx = jevContext('review', deps);
  const mechanical = !t || TOOL_TRANSCRIPT.test(t);
  if (ctx.mode === 'off' || mechanical) {
    const d = decideReview({ regex, jev: null, mode: 'off', thresholds: ctx.rail.thresholds });
    // Configured for Jev but it cannot be asked (no key, egress:false): say so, so the fallback never reads
    // like the configured path. The kill-switch itself (`mode: off`) stays exactly assertReviewOutput.
    const degraded = !mechanical && ctx.configured !== 'off';
    return {
      ...d,
      mode: ctx.mode,
      why: mechanical ? 'mechanical shape' : ctx.why,
      ...(degraded ? { reason: `${d.reason} — decided by regex: jev could not look (${ctx.why})` } : {}),
    };
  }
  const res = await ctx.ask({ state: reviewState(t), questions: REVIEW_QUESTIONS });
  // Only a real probability is a verdict. `Number()` would turn `true`, "1" or 5 into a Jev-decided PASS and
  // null or "" into a FAIL (fresh review, PR #35) — any other shape is could-not-look and the regex decides.
  const raw = res.ok ? res.answers?.is_real_review?.noul : undefined;
  const valid = typeof raw === 'number' && raw >= 0 && raw <= 1;
  const jev = res.ok
    ? { noul: raw, severity: res.answers?.severity?.choice ?? null, model: res.model }
    : null;
  const d = decideReview({
    regex,
    jev: valid ? jev : null,
    mode: ctx.mode,
    thresholds: ctx.rail.thresholds,
    error: res.ok ? (valid ? null : `invalid noul (${JSON.stringify(raw)})`) : res.error,
  });
  ctx.log({
    rail: 'review',
    mode: d.mode,
    decider: d.decider,
    regex: regex.ok,
    jev: d.jev ? d.jev.noul >= 0.5 : null,
    confidence: d.jev ? d.jev.noul : null,
    text: t,
    sha: opts.sha ?? null,
    source: opts.source ?? null,
    error: d.error,
  });
  return d;
}

/**
 * The hidden marker a posted cross-review comment carries, so a verdict made in a cloud routine (whose
 * .jev/ log dies with the session) can be harvested later with `gh api`. Never carries the reply text.
 */
export function jevMarker(verdict) {
  // `model` comes from the API response; a `-->` in it would close the comment early (fresh review, PR #35).
  const payload = {
    mode: verdict?.mode ?? 'off',
    decider: verdict?.decider ?? 'regex',
    // The regex's OWN verdict. Once Jev decides, a posted comment is no longer proof the regex accepted the
    // reply — without this, the report would count Jev-only passes as agreement (review of PR #39).
    regexOk: typeof verdict?.regexOk === 'boolean' ? verdict.regexOk : null,
    noul: typeof verdict?.jev?.noul === 'number' ? Number(verdict.jev.noul.toFixed(3)) : null,
    severity: verdict?.jev?.severity ?? null,
    model: verdict?.jev?.model ?? null,
  };
  return `\n<!-- jev:${JSON.stringify(payload).replace(/--/g, '-\\u002d')} -->`;
}

/**
 * Parse a jev marker back out of a comment body (the S5 report's harvest). null when absent. The LAST marker
 * wins: the reviewer's reply comes before the real one, and a reply shaped by the diff could carry a forged
 * marker (fresh review, PR #35).
 */
export function parseJevMarker(body) {
  const all = [...String(body ?? '').matchAll(/<!-- jev:(\{.*?\}) -->/g)];
  const m = all[all.length - 1];
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
