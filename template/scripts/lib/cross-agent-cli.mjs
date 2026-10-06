// cross-agent-cli.mjs — the shared CLI plumbing for the cross-agent second-opinion tools.
//
// One source of truth for driving a DIFFERENT model family's CLI (Codex or Antigravity), reused by both:
//   • scripts/cross-review.mjs  — advisory second opinion on a PR diff
//   • scripts/cross-panel.mjs   — advisory second opinion on a proposed plan (a scope/seed doc)
//
// It holds only the family-agnostic mechanics: presence/version checks, the per-CLI context-passing quirks
// (codex takes context on stdin; agy takes the prompt as the `-p` argv value — stdin is NOT the prompt and
// must be at EOF — with a size cap), and the shared-prompt loader. The *framing* of the context (a PR diff
// vs a plan doc) and the output handling
// (post a PR comment vs print a panel) stay in each consuming script. Zero npm deps — Node 18+.
//
// ── Codex → Antigravity auto-fallback ───────────────────────────────────────────────────────────────────
// When the local Codex token has lapsed, `codex exec` exits non-zero with an AUTH error on stderr (e.g.
// "Your session has ended. Please log in again." / "refresh token was revoked" / 401). `runWithCodexFallback`
// detects that specific auth signal (NOT every error — a non-auth break or an empty diff still fails clearly)
// and retries once with Antigravity, returning `{ fellBack: true, from: 'codex', to: 'antigravity' }` so the
// caller can label the output. The trigger lives in the pure, testable `decideCodexFallback`; restoring Codex
// is `codex login` (see scripts/README.md → "Restoring a lapsed Codex token").

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertReviewOutput } from './review-shape.mjs';

// label per agent. Drives both the CLI dispatch and the human-readable header.
export const AGENTS = {
  codex: 'Codex',
  antigravity: 'Antigravity',
  vibe: 'Mistral Vibe',
  claude: 'Claude Code',
};

// The binary each --agent value dispatches to — `antigravity` → `agy` is the one place the flag
// value and the executable name genuinely differ.
export const AGENT_BIN = {
  codex: 'codex',
  antigravity: 'agy',
  devin: 'devin',
  vibe: 'vibe',
  claude: 'claude',
};

// Antigravity's headless CLI is new and its print contract shifts between releases — pin the known-good
// version and FAIL LOUD on a mismatch (checkAgyVersion). 1.0.7→1.0.10 silently changed `--print` so it
// emits NOTHING without an explicit --model, which a soft warn let ship as empty reviews; a hard fail forces
// a human to re-verify the invocation below and bump this deliberately. Bumping = re-test runAntigravity().
//
// Re-verified 2026-07-03 against 1.0.16 (jump from 1.0.10; changelogs 1.0.11-1.0.16 show no print/--model
// changes): `agy -p "<prompt>" --model "<valid model>"` still exits 0 with real stdout — the exact call
// runAntigravity makes. One thing DID get more lenient: omitting --model, or passing an unrecognized model
// name, no longer prints nothing — agy now silently substitutes a default model and still returns output.
// Harmless here since AGY_MODEL/AGY_FALLBACK_MODEL below are always valid, listed model names (checked via
// `agy models`), but it means a future typo in either constant would silently review with the WRONG model
// instead of failing loud — watch for that if either constant is ever edited.
// agy-doctor: last verified 2026-10-06 against 1.3.0.
//   ^ machine-managed marker — `node scripts/cross-agent-doctor.mjs agy --fix` rewrites it (with the constant
//   below) after a green live contract probe. Don't hand-edit the marker's shape.
export const AGY_PINNED = '1.3.0';

// agy's `--print` mode prints NOTHING unless `--model` names a model — and, crucially, it ALSO prints
// nothing (exit 0, empty stdout — the error lands only in agy's log, see --log-file) when the model is
// quota-exhausted or unreachable. Gemini is the ideal reviewer (a different family from BOTH the Claude host
// and the GPT-family codex), so it's the default — but its per-subscription quota is tight and exhausts
// ("RESOURCE_EXHAUSTED 429: Individual quota reached"), so runAntigravity AUTO-FALLS-BACK to
// AGY_FALLBACK_MODEL (GPT-OSS, a separate quota pool that worked on the dev machine) when the primary yields
// empty. Override either via env.
// agy 1.1.5 renamed its model identifiers from display names ("Gemini 3.1 Pro (High)") to slugs
// ("gemini-3.1-pro-high"). Same models, new naming scheme — a mechanical remap, NOT a change of
// which models review. The Gemini-family primary is what gives this gate its model-family contrast
// with Codex; the GPT-OSS fallback is GPT-lineage (so it costs that contrast) and exists only
// because it draws on a separate quota pool when Gemini is exhausted.
// The product owner's call (2026-07-26): agy REVIEWS on the **current Gemini Flash generation at HIGH effort**.
// This was `gemini-3.1-pro-high`, then `gemini-3.6-flash-high`, and is now `gemini-3.8-flash-high`.
//
// ⚠️ **A retired slug fails as a QUOTA CAP, which is the wrong diagnosis and costs a review pass.**
// On 2026-09-09 a review returned no output on the primary AND the fallback, and the CLI's advice
// was "likely a quota cap (RESOURCE_EXHAUSTED 429)" — so the honest report was going to be "agy is
// capped, the second cross-family pass is missing". The product owner's answer was one line: *"agy is not
// exhausted. the model is 3.8 flash."* `agy models` confirmed it: 3.8 is listed, 3.6 is still listed
// too, and an unavailable-but-valid slug answers with silence rather than an error.
//
// The generation moves under this constant and nothing in the repo notices, because both the old and
// the new slug parse. `cross-agent-doctor.mjs agy` validates AGY_MODELS_IN_USE against `agy models`, which
// catches a slug that has been REMOVED — it cannot catch one that is merely a generation behind and
// out of quota. Re-check this line when a review comes back empty on both models before believing
// the cap.
export const AGY_MODEL = process.env.AGY_MODEL || 'gemini-3.8-flash-high';
export const AGY_FALLBACK_MODEL = process.env.AGY_FALLBACK_MODEL || 'gpt-oss-120b-medium';

// ── The PROSE pair lives HERE, not in prose-draft.mjs, and that move fixed a live silent bug ─────
// (2026-07-25.) prose-draft.mjs owned its own constants and still held agy's PRE-1.1.5 display
// names — `'Gemini 3.5 Flash (High)'` / `'GPT-OSS 120B (Medium)'`. Neither has been a valid model
// identifier since the 1.1.5 slug rename, and per the note above agy answers an unrecognized
// `--model` by silently substituting its own default and returning output anyway. So every prose
// draft produced since that rename ran on agy's default model, exit 0, no warning, plausible
// output — the exact failure the paragraph above predicted ("a future typo in either constant
// would silently review with the WRONG model instead of failing loud"). It was predicted, written
// down, and still shipped, because the prediction guarded the constants agy-doctor checks and
// these two lived somewhere it never looked.
//
// The fix is structural, not a re-typing: every agy model this repo configures is now declared in
// THIS file, and `cross-agent-doctor.mjs agy` validates AGY_MODELS_IN_USE (below) against `agy models` in one
// pass. A new consumer that wants its own pair adds it here and inherits the check for free.
//
// Flash (not Pro) for prose is deliberate and unchanged in intent: prose doesn't need Pro-tier
// reasoning and the coordinating agent is the editor. Moved 3.5 → 3.6 because 3.6 shipped and is
// listed; same tier, current generation.
// ── Prose: agy is the FALLBACK behind Devin, and when it runs it runs GPT-OSS only ─────────────
// The division of labour (the product owner, 2026-07-26): **Devin is the dedicated, specialized prose writer**,
// so agy's and Codex's quota stays free for review and building. agy is prose's fallback, and it runs
// the GPT lineage — the register the brief asked for ("an executive-level product-manager report")
// and the one both accepted drafts carried.
//
// ── Why there is NO model-level fallback here, deliberately ────────────────────────────────────
// This used to be a pair: Gemini Flash primary, GPT-OSS fallback. Two silent consequences. Every
// draft came from Gemini unless its quota happened to be exhausted — which is exactly when the two
// drafts the product owner accepted were produced, so the output they liked was the ACCIDENT and the default was
// the regression. And a fallback between two models with very different registers changed the voice
// of the report with no error, no warning, and a footer that said only "agy".
//
// So prose has ONE model. The fallback that matters is at the WRITER level (Devin → agy), and that
// one is named in the footer. A model-level fallback to a Gemini slug would also spend the review
// quota this split exists to protect. If GPT-OSS is briefly unavailable, prose fails and is re-run —
// an honest gap beats a silent change of voice.
export const PROSE_MODEL = process.env.PROSE_MODEL || 'gpt-oss-120b-medium';

// NOTE — there are deliberately NO commit-report-specific model constants. There were two,
// COMMIT_REPORT_MODEL and COMMIT_REPORT_FALLBACK_MODEL, and NOTHING read them: `commit-report.mjs`
// routes through prose-writer → runAgy → PROSE_MODEL. So the constants that appeared to configure the
// commit report configured nothing, while their own comment correctly described the intent ("GPT
// primary").
//
// That is the mechanism behind this whole incident. The documented intent said GPT, the dead constant
// said GPT, and the constant actually in force said Gemini — so the rail could be read three times
// and still misunderstood, and anyone "fixing" the register by editing COMMIT_REPORT_MODEL would have
// seen no effect at all. Deleted rather than wired up: one prose model, in one place.

// Every agy model name this repo pins, as {constant, value} — the list cross-agent-doctor walks. Keeping it
// adjacent to the declarations (rather than rebuilt in the doctor) means adding a model and
// forgetting to register it is a one-line miss in ONE file, visible in review.
export const AGY_MODELS_IN_USE = [
  { constant: 'AGY_MODEL', value: AGY_MODEL },
  { constant: 'AGY_FALLBACK_MODEL', value: AGY_FALLBACK_MODEL },
  { constant: 'PROSE_MODEL', value: PROSE_MODEL },
];

// ── The CODEX pair, pinned here for the same reason the agy models are ───────────────────────────
// The product owner's call (2026-07-26): codex reviews on **gpt-5.6-terra at HIGH reasoning effort**.
//
// Until now `execCodex` passed NO --model at all, so every codex review silently inherited whatever
// `~/.codex/config.toml` happened to say. That is the identical shape as the PROSE_MODEL incident
// documented above — a model choice that lives somewhere the repo never looks, changes without a
// signal, and produces plausible output either way. It is arguably worse: an agy typo at least had a
// constant in the repo to be wrong, whereas an ambient config has nothing to review at all, and the
// value differs per machine, so CI and a laptop can disagree with no way to notice.
//
// Passing them explicitly makes the review's model a property of the REPO, and any future change a
// diff. Env-overridable like its agy siblings, so a quota-exhausted day needs no commit.
//
// Verified live 2026-07-26 against codex-cli 0.144.6: `codex exec --model gpt-5.6-terra
// -c model_reasoning_effort=high` reports `model: gpt-5.6-terra` / `reasoning effort: high` in its
// own session banner and returns real output. Reasoning effort rides `-c` because `codex exec` has
// no dedicated flag for it (checked with `codex exec --help`, not from memory — LEARNINGS: never
// build against a documented flag from memory on a young foreign CLI).
//
// `CODEX_MODEL=default` opts OUT of the pin and lets codex pick its BUILT-IN default model. Not the user's
// configured one: reviews run `--ignore-user-config` (see CODEX_REVIEW_FLAGS), so ~/.codex/config.toml —
// its model, and any custom model_provider/base URL — is not read. A setup that needs a custom provider
// cannot use the codex reviewer through this rail; route past it (`review-route.mjs --exclude codex`). It exists for a stranger whose codex
// account is not entitled to the pinned model: that fails loud rather than silently (see execCodex), and
// this is the one-word escape from it. It is an explicit choice, never the fallback for an unset var.
export const CODEX_MODEL = codexModelFrom(process.env.CODEX_MODEL);
export const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || 'high';

/** `CODEX_MODEL`'s value: the pin when unset, `null` (codex's built-in default) for `default`. Pure, for tests. */
export function codexModelFrom(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return 'gpt-5.6-terra';
  return v.toLowerCase() === 'default' ? null : v;
}

// ── The BUILD tiers (2026-07-26) — Codex as a delegation target, not only a reviewer ────────────
// The product owner moved Codex onto a paid account and asked for it to carry delegated BUILD work, so the
// architect stays an architect. That makes "which model" a routing decision per task rather than
// one constant, and routing decisions belong in the repo for the same reason the review pin does:
// an ambient choice differs per machine and changes without a signal.
//
// ── The tier axis is EFFORT, not model — and the first draft of this table got that wrong ──────
// Probed live 2026-07-26 against codex-cli 0.144.6 on the product owner's paid ChatGPT account. `codex models
// list` does not exist in this version, so the roster had to be established by running it.
//
// **Exactly ONE model is entitled: `gpt-5.6-terra`.** Every other plausible slug —
// `gpt-5.6`, `gpt-5.6-mini`, `gpt-5.6-codex`, `gpt-5.6-terra-codex`, `gpt-5.6-terra-mini`,
// `codex-mini` — returns `400 … model is not supported when using Codex with a ChatGPT account`.
//
// This table's first draft listed four DIFFERENT models, because the probe that produced it scored
// success by grepping the output for "OK" instead of checking the exit code, and codex prints its
// session banner (and the model name) before failing. So every slug looked available. The error was
// caught by the delegation rail's own evidence section — a `quick` run reported the task complete-
// looking in its transcript and NOTHING written to the tree — which is precisely the check that rail
// exists for, working on its first real use.
//
// LEARNINGS already carries this rule from the Devin trial: *"a model catalog is not an entitlement
// list."* This is its second instance, with a sharper corollary: **score a CLI probe on its exit
// code, never on a pattern in its output**, because a young CLI prints a plausible banner on the way
// to failing. A bogus slug (`gpt-5.6-definitely-not-real-xyz`) was run as the discriminating case to
// confirm the failure is loud and distinguishable — it is.
//
// So routing is by `model_reasoning_effort`, which is a real axis: `minimal` is rejected as invalid,
// and low/medium/high/xhigh all run and are echoed back in codex's banner (verified per level, not
// assumed). Depth costs latency and tokens, so matching it to the work is still a decision worth
// making per task:
//   deep     — xhigh. Hardest reasoning: gnarly architecture, a subtle concurrency or auth question.
//   build    — high. Substantial multi-file stories. Same effort as the review pin above.
//   standard — medium. The default for a bounded, well-specified LOW-risk story with clear
//              acceptance — the shape WAYS-OF-WORKING calls delegable.
//   quick    — low. Mechanical work: doc edits, scaffolding, a rename across files.
//
// HIGH-risk stories (credentials, migrations, a first mutation surface) are NOT on this table. They
// are architect-only by the sprint doc, and a tier name would invite routing one here by accident.
export const CODEX_BUILD_TIERS = {
  deep: { model: 'gpt-5.6-terra', effort: 'xhigh' },
  build: { model: 'gpt-5.6-terra', effort: 'high' },
  standard: { model: 'gpt-5.6-terra', effort: 'medium' },
  quick: { model: 'gpt-5.6-terra', effort: 'low' },
};

/** Resolve a tier name to {model, effort}, or die listing the valid ones. */
export function resolveCodexTier(tier) {
  const hit = CODEX_BUILD_TIERS[tier];
  if (!hit) {
    die(
      `unknown codex tier "${tier}" — valid tiers: ${Object.keys(CODEX_BUILD_TIERS).join(', ')}. ` +
        `Tiers are declared in scripts/lib/cross-agent-cli.mjs (CODEX_BUILD_TIERS).`
    );
  }
  return hit;
}

// ── WHO MAY REVIEW WHAT: builder family ≠ reviewer family ───────────────────────────────────────
// The product owner's rule (2026-07-26), and it is a sharpening of what LEARNINGS already argues rather than a
// new policy: *"if a builder was from codex then reviewers could be from claude or agy; if the
// builder was claude then reviewers would be codex and/or agy."*
//
// The evidence behind it is this repo's own. pod-report S3 ran FOUR agy rounds on a new credential
// surface and the fourth, aimed deliberately at the auth/tenancy surface, came back CLEAN. Codex
// then opened with a Blocking finding on that same surface. Neither family is better; they are
// blind in different directions, which is the entire reason to run both — and it is why a family
// clearing its own work is the one arrangement that buys nothing.
//
// Now that Codex BUILDS here (scripts/codex-task.mjs) and not only reviews, that failure mode is
// newly reachable: the obvious `--agent codex` on a Codex-built diff is same-family self-review
// wearing a cross-review label, which is worse than no review because it is recorded as one.
//
// Encoded as a REFUSAL rather than a convention, because a convention drifts and this one would
// drift silently — the output looks identical either way. `reviewersFor` is pure and tested.
//
// Cost note (the product owner's standing preference): Claude's tokens go to security/money/architecture and to
// BUILDING, not to routine PR review. So Claude is deliberately NOT in either default reviewer set;
// it is the escalation, named explicitly when a diff earns it, not the baseline.
// `vibe` added 2026-08-25 (the product owner: "Agy, codex and vibe should be enabled for cross family
// reviews"). It was already a first-class REVIEWER in review-route.mjs's preference order and in
// AGENT_FLAG, but it was missing here — so `--builder vibe` was refused as an unknown family, and a
// vibe-built diff could only be reviewed by mislabelling who wrote it. That is the same-family guard
// failing open through a roster gap rather than a logic bug, which is the harder kind to notice.
export const BUILDER_FAMILIES = ['claude', 'codex', 'agy', 'vibe', 'human'];

/**
 * Which reviewer agents may review a diff built by `builder`.
 *
 * `human` and an unknown/unstated builder both get the full set: a human-written diff has no model
 * family to collide with, and refusing to review an unlabelled diff would make the safe path the
 * annoying one, which is how a check gets bypassed.
 */
export function reviewersFor(builder) {
  const b = String(builder || '').toLowerCase();
  // Every set below is "the roster minus the builder's own family". Written out per builder rather
  // than derived, so the policy reads as a decision and a wrong pairing is visible on one line.
  if (b === 'codex') return ['antigravity', 'vibe'];
  if (b === 'agy') return ['codex', 'vibe'];
  if (b === 'vibe') return ['codex', 'antigravity'];
  if (b === 'claude') return ['codex', 'antigravity', 'vibe'];
  return ['codex', 'antigravity', 'vibe'];
}

/** Normalise the reviewer CLI name to the family it belongs to. */
function reviewerFamily(agent) {
  return agent === 'antigravity' ? 'agy' : agent;
}

/**
 * Refuse a same-family review. Returns null when the pairing is fine, or an explanatory message.
 *
 * Deliberately returns the reason instead of dying here, so the caller can decide between a hard
 * failure (an interactive run) and a warning (a batch), and so this stays pure and testable.
 */
export function checkReviewerPairing(builder, agent) {
  const b = String(builder || '').toLowerCase();
  if (!b || b === 'human') return null;
  // An UNRECOGNISED explicit builder is a refusal, not a shrug (cross-review, Codex, PR #38).
  // Unknown values used to fall through to the same "no constraint" branch as an unstated builder,
  // so `--builder codez --agent codex` — a typo — silently disabled the same-family guard and
  // produced a review that looked exactly like a valid one. A guard that a typo can switch off is
  // not a guard; an omitted builder is still permitted, because that is an honest "unstated".
  if (!BUILDER_FAMILIES.includes(b)) {
    return (
      `unknown --builder "${builder}" — expected one of ${BUILDER_FAMILIES.join(', ')}. ` +
      `Refusing rather than defaulting: an unrecognised builder would silently disable the ` +
      `same-family review guard, and the output looks identical either way.`
    );
  }
  if (reviewerFamily(agent) !== b) return null;
  const allowed = reviewersFor(b).join(', ');
  return (
    `refusing a SAME-FAMILY review: this diff was built by "${b}" and "${agent}" is the same model ` +
    `family. A family clearing its own work is the one arrangement that buys nothing — the two ` +
    `families are blind in different directions, which is the whole point of the gate ` +
    `(Roadmap/LEARNINGS.md). Use --agent ${allowed} instead, or pass --builder human if a person ` +
    `wrote this diff.`
  );
}

// agy takes the prompt+context as a single `-p` argv string (stdin is not the prompt). Guard well under the
// OS limit (macOS ARG_MAX is 1 MB incl. env) so a huge input fails clearly instead of an opaque E2BIG.
export const AGY_ARG_LIMIT = 256 * 1024;

export function die(msg) {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(1);
}

export function need(val, flag) {
  if (val === undefined || val.startsWith('-')) die(`${flag} requires a value`);
  return val;
}

// `cmd --version` exits non-zero only when the binary is missing (spawn .error) — a clean presence check.
export function ensureCmd(cmd, fix) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  if (r.error) die(fix);
}

// Non-fatal sibling of ensureCmd: true if the binary is on PATH, false otherwise. Used by the fallback to
// decide whether Antigravity is even available before retrying — no die().
export function hasCmd(cmd) {
  return !spawnSync(cmd, ['--version'], { encoding: 'utf8' }).error;
}

export function ensureGh() {
  ensureCmd('gh', 'gh not found — install GitHub CLI (https://cli.github.com), then `gh auth login`.');
  const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
  if (r.status !== 0) die('gh is not authenticated — run `gh auth login`.');
}

// ── Branch → PR resolution + stale-HEAD guard (the "wrong-branch tax" fix) ───────────────────────────────
// cross-review takes an explicit <PR#> but never ties it to the current branch or checks the head SHA, so
// the FIRST run regularly reviews the wrong or a stale diff and gets rerun. These helpers let the command
// resolve the PR from the branch and refuse a stale local HEAD. They live here (the shared rail) so the
// resolver is a single source of truth alongside the Codex-fallback plumbing both scripts already import.

// Module-local git I/O: returns trimmed stdout, or null on any non-zero/spawn error (a clean "couldn't").
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

// Module-local gh I/O returning the structured result (so callers/tests can read stderr to classify failure).
function ghJson(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// First 8 chars of a SHA, for human-readable guard messages. Null-safe → 'unknown' (never empty parens
// like `local HEAD ()` when `git rev-parse` couldn't read a SHA).
export function shortSha(sha) {
  return sha ? sha.slice(0, 8) : 'unknown';
}

// Pure stale-HEAD decision — the unit under test (no I/O, like decideCodexFallback). Given the local HEAD
// SHA, the PR's head SHA, and whether --force was passed, decide whether to proceed:
//   'match'          — SHAs equal → proceed silently.
//   'mismatch-force' — differ but --force → proceed with a warning.
//   'mismatch-block' — differ, no --force → refuse (review would be stale).
export function decideHeadGuard({ localHead, prHeadOid, force }) {
  if (localHead && prHeadOid && localHead === prHeadOid) return 'match';
  return force ? 'mismatch-force' : 'mismatch-block';
}

// ── Cost guard: skip the review on a trivial diff ────────────────────────────────────────────────────────
// "Every PR" must not mean paying for a Codex pass on a typo or a docs-only change. This is the pure,
// testable decision (the unit under test, like decideHeadGuard) — the script fetches the changed-file stats
// (`gh pr view --json files`) and passes them here. Returns { skip, reason }.
//
// A file counts as docs/text (cheap to skip wholesale) when it matches DOC_FILE_RE. Otherwise we sum the
// changed lines (additions+deletions) and skip only below `minLines`. So a docs-only PR of any size skips,
// a tiny code tweak skips, but a real code change of any size is reviewed.
const DOC_FILE_RE = /(\.(md|mdx|txt|rst)$)|(^|\/)(LICENSE|CODEOWNERS|\.gitignore)$/i;

export function isDocFile(path) {
  return DOC_FILE_RE.test(path || '') || /(^|\/)docs\//i.test(path || '');
}

/**
 * Drop documentation/text file hunks from a diff, leaving only code.
 *
 * ── Why this exists, and why the SCOPE has to be reported ─────────────────────────────────────
 * agy takes its whole prompt as one argv string (stdin is not the prompt), so it is bounded by
 * AGY_ARG_LIMIT — and a sprint-sized PR crosses it. signals-loop Sprint 3 hit 259 KB against a
 * 256 KB cap and the review simply refused to run, which on a HIGH-risk credential surface is the
 * worst possible time to lose the second family's read.
 *
 * This repo's PRs are comment-dense by house style and carry sprint docs, so prose is usually the
 * majority of the bytes and dropping it is enough. The reviewer then sees every line of code and
 * none of the documentation.
 *
 * **That is a REAL reduction in scope, not a formatting detail.** A reviewer who cannot see the
 * sprint doc cannot check the code against its stated acceptance criteria, and one who cannot see a
 * migration's comment cannot catch a comment asserting a property the SQL does not enforce — a
 * defect class this repo has hit repeatedly. So callers must state the subset in the posted comment
 * (cross-review.mjs does), because a review labelled as covering a PR while having seen two thirds
 * of it is worse than an absent review: the next reader stops there.
 */
export function stripDocFileDiffs(diffText) {
  if (!diffText) return { diff: diffText, strippedFiles: [] };
  const chunks = diffText.split(/(?=^diff --git )/m);
  const strippedFiles = [];
  const kept = [];
  for (const chunk of chunks) {
    const header = chunk.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (!header) {
      kept.push(chunk);
      continue;
    }
    const path = header[2] || header[1];
    if (isDocFile(path)) {
      strippedFiles.push(path);
      continue;
    }
    kept.push(chunk);
  }
  return { diff: kept.join(''), strippedFiles };
}

/**
 * Keep only the diff hunks whose path matches one of `patterns` (substring match).
 *
 * ── Why a targeted subset is sometimes the ONLY way to get the second family ──────────────────
 * agy takes its prompt in argv, so it is bounded by AGY_ARG_LIMIT. A long-running PR grows past
 * that even after `stripDocFileDiffs` — signals-loop Sprint 3 reached 270 KB of pure code across
 * seven review rounds — and at that point the choice is a scoped review or none at all.
 *
 * Scoping is the better answer for a HIGH-risk PR specifically, because the risk is concentrated:
 * a credential surface and a mutation path are worth a full read from both families, while a
 * landing-page component is not what the second opinion is for.
 *
 * It is still a REDUCTION, and callers must say so in the posted comment — a review that appears to
 * cover a PR while having seen four files is worse than an absent one.
 */
export function filterDiffToPaths(diffText, patterns) {
  if (!diffText || !patterns?.length) return { diff: diffText, keptFiles: [], droppedFiles: [] };
  const chunks = diffText.split(/(?=^diff --git )/m);
  const keptFiles = [];
  const droppedFiles = [];
  const kept = [];
  for (const chunk of chunks) {
    const header = chunk.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (!header) {
      kept.push(chunk);
      continue;
    }
    const path = header[2] || header[1];
    if (patterns.some((pat) => path.includes(pat))) {
      keptFiles.push(path);
      kept.push(chunk);
    } else {
      droppedFiles.push(path);
    }
  }
  return { diff: kept.join(''), keptFiles, droppedFiles };
}

export function decideTrivialSkip({ files, minLines = 10 } = {}) {
  if (!Array.isArray(files) || files.length === 0) return { skip: true, reason: 'empty diff' };
  if (files.every((f) => isDocFile(f.path))) return { skip: true, reason: 'docs-only diff' };
  const lines = files.reduce((n, f) => n + (f.additions || 0) + (f.deletions || 0), 0);
  if (lines < minLines)
    return {
      skip: true,
      reason: `trivial diff (${lines} changed line${lines === 1 ? '' : 's'} < ${minLines})`,
    };
  return { skip: false };
}

// ── Diff-size guard: strip generated files before they blow a reviewer's context window ────────────────────
// Found live (deploy-pipeline-tuning epic, 2026-07-11): a PR whose diff includes a large auto-generated file
// (a first-time-committed package-lock.json, ~12–19K lines) blew Codex's context window —
// `ERROR: Codex ran out of room in the model's context window` — and the failure surfaced as an opaque
// `codex exec failed (non-auth): 0` (the "0" is codex's own trailing token-count line, picked up by
// `lastLine()`, not a real exit code the caller can act on). Worked around by hand that day
// (`git diff origin/main...HEAD -- . ':(exclude)package-lock.json'` piped directly into `codex exec -`,
// bypassing this script); fixed here so the NEXT PR that touches a lockfile doesn't need the same manual
// detour. This repo committing per-app lockfiles is now Sprint 1's established convention, so this is a
// recurring case, not a one-off.
//
// Strips whole per-file diff hunks (each starts with `diff --git a/X b/Y`) for known generated-file
// basenames, replacing each with a one-line placeholder so the reviewer still sees THAT the file changed —
// just not its (often huge, low-signal) content. Pure string logic, no git/gh dependency, so it's directly
// unit-testable against a hand-built diff fixture.
// `jev-eval.fixtures.json` (jev-semantic-guards): recorded Jev answers that `jev-eval --live` rewrites — ~100 KB of
// machine-written JSON that alone pushed a 20-file PR past agy's/vibe's 256 KB argv limit.
const GENERATED_FILE_RE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|reports-data\.json|jev-eval\.fixtures\.json)$/;

export function stripGeneratedFileDiffs(diffText, { extraPatterns = [] } = {}) {
  if (!diffText) return { diff: diffText, strippedFiles: [] };
  const isGenerated = (path) =>
    GENERATED_FILE_RE.test(path || '') || extraPatterns.some((re) => re.test(path || ''));

  // Split on the `diff --git a/X b/Y` boundary, keeping the delimiter with each chunk (lookahead split).
  const chunks = diffText.split(/(?=^diff --git )/m);
  const strippedFiles = [];
  const kept = chunks.map((chunk) => {
    const header = chunk.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (!header) return chunk; // preamble before the first `diff --git` (rare, but don't drop it)
    const path = header[2] || header[1];
    if (!isGenerated(path)) return chunk;
    strippedFiles.push(path);
    return `diff --git a/${path} b/${path}\n(generated file — diff omitted to fit the reviewer's context window; see the real file in the PR)\n`;
  });
  return { diff: kept.join(''), strippedFiles };
}

// True when a codex/agy response signals it ran out of context-window room — a DIFFERENT failure class from
// an auth lapse (retrying with a fallback model would likely hit the exact same overflow, since the input
// size is the problem, not the model). Checked against both stdout and stderr since codex's own trailing
// diagnostics ("tokens used\n0") can land on either depending on the failure path, which is what made this
// failure mode read as an opaque `(non-auth): 0` before this check existed. Kept as a named, tested export so
// the message stays actionable instead of falling through to the generic non-auth failure text.
// True when an agy failure is TRANSIENT — provider capacity, rate limiting or a passing upstream
// blip — as opposed to a real interface error (bad flag, crash, unknown subcommand). Only a
// transient failure justifies spending the fallback model, which draws on a separate capacity pool.
//
// Kept deliberately TIGHT. A loose pattern here is actively harmful: it would convert genuine
// breakage (the 1.0.10 class of contract change this whole file exists to catch) into a silent
// retry on a second model, which is exactly how empty reviews shipped for weeks. Every phrase below
// is one observed live, and anything unrecognized still fails loud.
export function isTransientAgyError(stderr) {
  return /high traffic|temporarily unavailable|try again (in a|later)|rate ?limit|too many requests|RESOURCE_EXHAUSTED|\b(429|500|502|503|504)\b|overloaded|capacity|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(
    stderr || ''
  );
}

// WHICH transient failure, because the two that matter mean opposite things to the person reading the error
// (probed live, agy 1.2.16, 2026-10-04 — it now exits 3 and says why on stderr):
//   quota     "RESOURCE_EXHAUSTED (code 429): Individual quota reached … Resets in 155h5m1s." Every Gemini tier
//             shares one pool, and it is a weekly window: waiting a minute does nothing.
//   capacity  "UNAVAILABLE (code 503): No capacity available for model gpt-oss-120b-medium" / "high traffic,
//             please try again in a minute". The SAME call answered fine 14 s later.
// Both used to end in one message that said "quota", so agents reported agy capped while it worked on their
// next task. Returns 'quota' | 'capacity' | null; a null on a transient error is some other blip.
export function agyFailureKind(output) {
  const text = output || '';
  if (/RESOURCE_EXHAUSTED|quota (?:reached|exceeded|exhausted)/i.test(text)) return 'quota';
  if (/no capacity|high traffic|UNAVAILABLE \(code 503\)|overloaded/i.test(text)) return 'capacity';
  return null;
}

function agyQuotaReset(output) {
  return /Resets in ([0-9hms]+)/i.exec(output || '')?.[1] ?? null;
}

// How often, and how long apart, a 'capacity' answer is retried on the same model before moving on.
export const AGY_CAPACITY_RETRIES = Number(process.env.AGY_CAPACITY_RETRIES ?? 2);
export const AGY_CAPACITY_WAIT_MS = Number(process.env.AGY_CAPACITY_WAIT_MS ?? 30_000);

// The reason behind an EMPTY answer. agy can still exit 0 with nothing on stdout, and then the only record of why
// is its own log (seen on PR #267's security lens, 2026-10-04, which answered on the re-run). The last real error
// line, skipping the side calls that fail without costing the answer (telemetry, conversation-title generation).
export function agyLogError(log) {
  const errors = String(log || '')
    .split('\n')
    .filter((l) => /^E\d{4} /.test(l) && !/telemetry|title generation|recordTrajectory/i.test(l));
  const last = errors.pop();
  return last ? last.replace(/^E\S+ \S+\s+\d+ \S+\] /, '').slice(0, 240) : null;
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isContextWindowOverflow(output) {
  // ['’] covers both a straight and a "smart"/curly apostrophe — CLIs are inconsistent about which they emit.
  return /ran out of room in the model['’]?s context window/i.test(output || '');
}

// gh stderr signalling "this branch has no associated PR" — kept TIGHT to gh's actual no-PR message so a
// repo/remote/auth misconfig (e.g. a bad --repo) falls through to the generic error instead of being masked
// as "no open PR" and sending the operator chasing the wrong fix.
function isNoPrError(stderr) {
  return /no (?:open )?pull requests? found/i.test(stderr || '');
}

// Resolve the open PR for the CURRENT branch via `gh pr view --json …`. Injectable (`deps`) so a pure
// node:test can mock gh + git with no network. Returns { number, headRefName, headRefOid }, or fail()s with a
// clear, actionable message (detached HEAD / no open PR / gh error) — never a stack trace.
export function resolveCurrentPr({ repo } = {}, deps = {}) {
  const { runGit = git, runGh = ghJson, fail = die } = deps;

  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD')
    return fail('detached HEAD / not on a branch — checkout the PR branch or pass <PR#> explicitly.');

  const args = ['pr', 'view', '--json', 'number,state,headRefName,headRefOid'];
  if (repo) args.push('--repo', repo);
  const res = runGh(args);
  if (!res.ok) {
    if (isNoPrError(res.stderr))
      return fail(`no open PR for branch \`${branch}\` — push/open one or pass <PR#>.`);
    return fail(`gh pr view failed for branch \`${branch}\`: ${lastLine(res.stderr)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return fail(`could not parse \`gh pr view\` output for branch \`${branch}\`.`);
  }
  if (!parsed || typeof parsed.number !== 'number')
    return fail(`\`gh pr view\` returned no PR number for branch \`${branch}\`.`);
  // gh resolves a MERGED/CLOSED PR too (e.g. a reused branch name) — only an OPEN PR is a valid review target.
  if (parsed.state && parsed.state !== 'OPEN')
    return fail(
      `no open PR for branch \`${branch}\` (found #${parsed.number}, state ${parsed.state}) — ` +
        `push/open one or pass <PR#>.`
    );
  return { number: parsed.number, headRefName: parsed.headRefName, headRefOid: parsed.headRefOid };
}

// The local HEAD SHA (`git rev-parse HEAD`), or null if it can't be read. Injectable for tests.
export function currentHeadSha(deps = {}) {
  const { runGit = git } = deps;
  return runGit(['rev-parse', 'HEAD']);
}

// FAIL LOUD on an unknown/mismatched agy version. The print contract enforced by runAntigravity (the --model
// requirement + the argv framing) is version-specific, so a silent warn is what let 1.0.10 ship empty reviews
// for weeks. A match is silent; an unparseable or mismatched version die()s with a fix-naming message. Deps
// are injectable (spawn/fail/pinned) so a node:test can exercise both outcomes without a real agy or exiting.
// NOTE: cross-review.mjs calls this only on the explicit `--agent antigravity` path; the codex→agy fallback
// runs agy directly (kept intact) — the runAntigravity --model fix already restores its output regardless.
export function checkAgyVersion(deps = {}) {
  const { spawn = spawnSync, fail: failFn = die, pinned = AGY_PINNED } = deps;
  const r = spawn('agy', ['--version'], { encoding: 'utf8' });
  const m = ((r.stdout || '') + (r.stderr || '')).trim().match(/\d+\.\d+\.\d+/);
  if (!m)
    return failFn(`could not determine agy version (expected ${pinned}) — is the Antigravity CLI installed?`);
  if (m[0] !== pinned)
    return failFn(
      `agy ${m[0]} != pinned ${pinned} — the print/--model contract may have shifted. ` +
        `Run \`node scripts/cross-agent-doctor.mjs agy --fix\` (authorized for agents: it re-verifies the live ` +
        `contract and bumps the pin only on a green probe), then commit the bump. ` +
        `Manual path: re-verify runAntigravity() against \`agy --help\`, then bump AGY_PINNED to ${m[0]}.`
    );
}

// Load a shared `*.prompt.md`. The doc opens with an HTML-comment header; the prompt is everything below
// the first `---` line. Returns the trimmed body, or dies with a clear message.
export function loadPromptBody(path) {
  if (!existsSync(path)) die(`shared prompt missing at ${path}`);
  const raw = readFileSync(path, 'utf8');
  const marker = raw.indexOf('\n---');
  const body = (marker === -1 ? raw : raw.slice(marker + '\n---'.length)).trim();
  if (!body) die(`shared prompt at ${path} is empty.`);
  return body;
}

// `opts.soft` makes a runner return null (with a stderr warning) instead of die()-ing on failure — used
// for non-essential passes (e.g. cross-panel's contradiction synthesis) that should degrade, not abort.
function fail(soft, msg) {
  if (soft) {
    process.stderr.write(`⚠ ${msg}\n`);
    return null;
  }
  die(msg);
}

// Last non-empty line of a stderr blob — the human-readable tail used in failure messages.
function lastLine(stderr) {
  return (stderr || '').trim().split('\n').filter(Boolean).pop() || 'unknown error';
}

// Low-level codex exec: prompt rides as an argv string, context is piped on stdin (codex appends it as a
// <stdin> block). Returns the raw spawn result — callers decide how to interpret status/stdout/stderr.
function execCodex(prompt, stdin) {
  // --model and the reasoning-effort override are passed EXPLICITLY rather than inherited from
  // ~/.codex/config.toml. See CODEX_MODEL's header comment: an ambient model choice is the same
  // silent-rot surface that made every prose draft run on the wrong model for a release cycle, with
  // the added problem that an ambient value differs per machine.
  //
  // Unlike agy, an unrecognized codex --model FAILS LOUD (non-zero exit with the model name in
  // stderr) rather than substituting a default — verified 2026-07-26 — so a rotted pin here surfaces
  // as a broken review rather than a quietly downgraded one. That is why this needs no doctor probe
  // of its own, where the agy pins do.
  return spawnSync('codex', codexExecArgs(prompt), {
    input: stdin,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The `codex exec` argv. Pure, for tests: `model: null` means codex's built-in default (CODEX_MODEL=default).
 *
 * ── The reviewer is locked down, not trusted (distribute-what-we-use S1, pr-reviewer round 2 on #188) ──
 * Codex reads an attacker-controllable diff. Without these flags it ran with whatever ~/.codex/config.toml
 * said — observed: `sandbox: workspace-write`, `approval: on-request`, and the user's MCP servers started
 * (a database one among them). Pinned instead, and observed live with codex-cli 0.158.0:
 *   --sandbox read-only    no writes and no network from commands the model runs;
 *   --ignore-user-config   no user MCP servers, no ambient profile (auth still comes from CODEX_HOME);
 *   --ephemeral            no session file written for a review.
 * The banner then reads `sandbox: read-only`, `approval: never`, with no MCP worker. What remains is READ
 * access to the host — no codex flag removes it — which is why cross-review refuses to post a reply that
 * carries a secret (lib/secret-guard.mjs). Reduced, not closed; said so in the CHANGELOG.
 * Also used by lib/prose-writer.mjs's codex path, where read-only is equally right.
 */
export const CODEX_REVIEW_FLAGS = Object.freeze([
  '--sandbox',
  'read-only',
  '--ignore-user-config',
  // A hostile PR's checkout is on disk while it is reviewed; its execpolicy `.rules` must not load either.
  '--ignore-rules',
  '--ephemeral',
]);

export function codexExecArgs(prompt, { model = CODEX_MODEL, effort = CODEX_REASONING_EFFORT } = {}) {
  // Effort is independent of the model: `CODEX_MODEL=default` changes WHICH model, not how hard it thinks
  // (codex round 4 on #188).
  const pin = [...(model ? ['--model', model] : []), '-c', `model_reasoning_effort=${effort}`];
  return ['exec', ...CODEX_REVIEW_FLAGS, ...pin, prompt];
}

// codex exec wrapper preserving the original contract: returns trimmed stdout, or fail()s (die unless soft).
export function runCodex(prompt, stdin, opts = {}) {
  const r = execCodex(prompt, stdin);
  if (r.status !== 0) return fail(opts.soft, `codex exec failed: ${lastLine(r.stderr)}`);
  return (r.stdout || '').trim();
}

// Soft, STRUCTURED codex run — never dies. Exposes stderr so the caller can tell an auth failure (token
// lapsed → fall back) from a non-auth failure (real break → surface it). This is the "degrade, don't die"
// soft mode made structured; runCodex stays the string-returning variant for its existing direct callers.
export function tryCodex(prompt, stdin) {
  const r = execCodex(prompt, stdin);
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  return {
    ok: r.status === 0,
    text: stdout.trim(),
    authFailed: r.status !== 0 && isCodexAuthError(stderr),
    // See stripGeneratedFileDiffs' header comment: checked on both streams because codex's own trailing
    // diagnostics can land on either, depending on the exact failure path.
    contextOverflow: r.status !== 0 && (isContextWindowOverflow(stdout) || isContextWindowOverflow(stderr)),
    // Stale CLI: the installed codex is too old for the model it is asked to run. Like an auth lapse,
    // codex cannot run here and agy can, so it triggers the same one-shot fallback. A distinct flag (not
    // folded into authFailed) so the banner names the real cause and points at the doctor.
    cliOutdated: r.status !== 0 && isCodexOutdated(`${stdout}\n${stderr}`),
    capped: r.status !== 0 && isCodexCapped(`${stdout}\n${stderr}`),
    stderr,
  };
}

// True when codex fails because the INSTALLED CLI is too old for the model it runs — a distinct class from
// an auth lapse or a context overflow. Confirmed live by a consuming project (2026-07-20, codex-cli 0.142.5):
//   "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI…"
// Kept tight to the upgrade signal so a bad-model-name typo (a different 400) is not masked as "upgrade".
// True when the account cannot use the requested model (an entitlement refusal, not a stale binary).
export function isCodexModelUnavailable(output) {
  return /model (?:is )?not (?:supported|available|found)|not supported when using codex|does not have access to (?:the )?model|unknown model/i.test(
    output || ''
  );
}

// True when codex refused because the account hit its usage cap (observed 2026-09-29, codex-cli 0.158.0:
// "You've hit your usage limit"). Codex cannot run here and agy draws on a different pool, so it heals like
// an auth lapse or a stale CLI.
export function isCodexCapped(output) {
  return /hit your usage limit|usage limit reached|rate limit exceeded for your plan/i.test(output || '');
}

export function isCodexOutdated(output) {
  // Also: a codex too old to know the review's lockdown flags (clap: "unexpected argument '--ignore-rules'").
  return /unexpected argument '--(?:ignore-user-config|ignore-rules|ephemeral|sandbox)'|requires a newer version of codex|upgrade to the latest (?:app or )?cli|update codex|codex (?:is )?out of date/i.test(
    output || ''
  );
}

// True when codex's stderr carries an AUTHENTICATION failure (lapsed/revoked/expired token) — the only
// signal that should trigger the Antigravity fallback. Confirmed against a live revoked token (2026-06-21):
// "Failed to refresh token: 401 Unauthorized … refresh_token_invalidated", "Your session has ended. Please
// log in again.", "your refresh token was revoked. Please log out and sign in again." Kept tight to auth so
// a genuine non-auth error (empty diff, internal break) falls through and fails clearly instead.
export function isCodexAuthError(stderr) {
  return /refresh[_ ]?token|session has ended|log ?in again|sign in again|401 unauthorized|token (?:was|is|could not be) (?:revoked|refreshed|expired|invalid)|not authenticated|unauthorized/i.test(
    stderr || ''
  );
}

// Pure fallback decision — the unit under test. Given the outcome of a codex attempt and whether agy is
// available, return the action to take. No I/O, no exit.
export function decideCodexFallback({
  codexOk,
  authFailed,
  cliOutdated = false,
  capped = false,
  contextOverflow,
  agyAvailable,
  fallbackPairingError = null,
}) {
  if (codexOk) return 'use-codex';
  // Checked BEFORE the recoverable classes: an overflow is distinct from auth/stale-CLI (retrying with a
  // fallback model wouldn't help — the input itself is too big), so it gets its own clear message rather
  // than falling through to the generic "(non-auth): <cryptic tail line>" text.
  if (contextOverflow) return 'fail-context-overflow';
  // Both an auth lapse AND a too-old CLI mean "codex can't run here, agy can" → the same one-shot fallback.
  if (!authFailed && !cliOutdated && !capped) return 'fail-non-auth';
  if (!agyAvailable) return 'fail-both-dead';
  // The fallback CHANGES the reviewing family. When agy built the diff, falling back to agy would be a
  // same-family review wearing a cross-family label, so it fails loud instead (distribute-what-we-use D1).
  if (fallbackPairingError) return 'fail-fallback-same-family';
  return 'fallback';
}

// Orchestrate codex with a one-shot Antigravity fallback on an auth lapse or a stale CLI. `builder` (who
// wrote the diff, optional) is re-checked against the FALLBACK family. `deps` is injectable so a pure
// node:test can mock both runners (no network). Returns { findings, fellBack[, from, to] }.
export function runWithCodexFallback({ prompt, stdin, antigravityArgv, builder = '' }, deps = {}) {
  const {
    tryCodex: tryCodexFn = tryCodex,
    runAntigravity: runAntigravityFn = runAntigravity,
    hasCmd: hasCmdFn = hasCmd,
    fail: failFn = die,
    warn = (m) => process.stderr.write(`${m}\n`),
  } = deps;

  const codex = tryCodexFn(prompt, stdin);
  const fallbackPairingError = checkReviewerPairing(builder, 'antigravity');
  const action = decideCodexFallback({
    codexOk: codex.ok,
    authFailed: codex.authFailed,
    cliOutdated: codex.cliOutdated,
    capped: codex.capped,
    contextOverflow: codex.contextOverflow,
    agyAvailable: hasCmdFn('agy'),
    fallbackPairingError,
  });

  // The two recoverable causes want different operator guidance — a lapsed token vs a stale binary — so the
  // banner/fatal text branches on the flag even though the ACTION (fall back to agy) is the same.
  const cause = codex.capped
    ? {
        blurb: 'Codex hit its usage cap',
        restore: 'wait for the cap to reset, or route past it with --exclude codex',
      }
    : codex.cliOutdated
      ? {
          blurb: 'Codex CLI is behind its model requirement',
          restore: 'upgrade codex (see `node scripts/cross-agent-doctor.mjs codex`)',
        }
      : { blurb: 'Codex token revoked', restore: '`codex login`' };

  switch (action) {
    case 'use-codex':
      return { findings: codex.text, fellBack: false };
    case 'fail-context-overflow':
      return failFn(
        "codex exec failed: the diff is too large for Codex's context window. " +
          'This is usually a large auto-generated file (a lockfile, a minified bundle, a snapshot) — ' +
          "stripGeneratedFileDiffs() already excludes the known lockfile patterns by default, so if you're " +
          'seeing this, either that allowlist needs a new pattern for this file, or the PR has a genuinely ' +
          'large hand-written diff that needs splitting.'
      );
    case 'fail-non-auth':
      // A pinned model this codex account cannot use fails here, not as auth — so name the escape. Matched on
      // the entitlement error itself: codex's banner prints `model: …` on EVERY run, so the bare word would
      // advise dropping the pin on any failure (pr-reviewer round 2, S2).
      return failFn(
        `codex exec failed (non-auth): ${lastLine(codex.stderr)}` +
          (isCodexModelUnavailable(codex.stderr) && CODEX_MODEL
            ? ` — if this account cannot use "${CODEX_MODEL}", re-run with CODEX_MODEL=default (codex's built-in default).`
            : '')
      );
    case 'fail-both-dead':
      return failFn(
        `${cause.blurb} AND Antigravity unavailable — restore Codex (${cause.restore}), ` +
          'or install + authenticate the Antigravity CLI (agy).'
      );
    case 'fail-fallback-same-family':
      return failFn(
        `${cause.blurb}, and the only fallback is Antigravity — ${fallbackPairingError} ` +
          `Restore Codex (${cause.restore}), or re-route past codex with ` +
          `\`node scripts/review-route.mjs --builder ${builder} --exclude codex <PR#>\`.`
      );
    case 'fallback':
    default:
      warn(`⚠ ${cause.blurb} → falling back to Antigravity. Restore: ${cause.restore}.`);
      return {
        findings: runAntigravityFn(antigravityArgv),
        fellBack: true,
        from: 'codex',
        to: 'antigravity',
      };
  }
}

// The argv for one agy print-mode call. Exported so a caller that needs its OWN spawn (a hard timeout, one model, no
// fallback line — the intent reader, intent-match C4) builds the identical invocation instead of a second copy of it.
export function agyArgs(fullArgv, model = AGY_MODEL) {
  return ['-p', fullArgv, '--model', model];
}

// One `agy -p "<prompt>" --model "<MODEL>"` invocation. The prompt+framed context ride in `fullArgv` (stdin is
// NOT the prompt and must be at EOF — input:'' gives an immediate EOF or print mode blocks forever). Returns
// the raw spawn result; the caller classifies status/stdout.
function execAgy(fullArgv, model, spawn, logFile) {
  return spawn('agy', [...agyArgs(fullArgv, model), ...(logFile ? ['--log-file', logFile] : [])], {
    input: '',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

// ── Whole-file context for the diff-only reviewers ───────────────────────────────────────────────────────
// Both agy and vibe are handed a DIFF. A diff shows changed lines and a few of context, which is why
// this rail has produced the same wrong finding three times in two days: "the helper is not defined
// in this test file" (defined eight lines above the hunk), "an audit action carries no project_id"
// (the source passes one), "imported from a file the diff never creates" (a lower PR creates it).
// Every one is a reviewer reasoning about code it could not see.
//
// vibe briefly got repo ACCESS instead (read_file + grep, 2026-08-07); that was removed because it let an
// injected diff read host files (see VIBE_READ_ONLY_TOOLS), so vibe is attached-to like agy. **agy could
// never have had it**: its only permission lever is `--dangerously-skip-permissions`, which is
// all-or-nothing — there is no --enabled-tools equivalent to scope it to reads — and without it agy
// simply BLOCKS in `-p` mode waiting for an approval that never comes (measured: no output after
// 9 minutes, with and without `--mode plan`). Granting an external CLI blanket tool approval in this
// repo would also be strictly worse than what vibe got, because a permission skip covers shell and
// network too, not just file writes.
//
// So the missing context is ATTACHED instead of fetched. It is deterministic, needs no permission
// grant, cannot hang, and puts exactly the thing the reviewer kept guessing about in front of it.
//
// ── The byte budget is not optional, and neither is the manifest ────────────────────────────────
// agy's argv cap is 256 KB. Measured on real PRs from this repo: a small PR is ~35 KB with full text
// attached, a sprint-sized one is ~302 KB — over the cap. So attachment is BOUNDED, smallest files
// first (more files for the same bytes), and every file that did not fit is NAMED.
//
// Naming them matters more than including them. A reviewer given some files and not others, with no
// list, would conclude an unattached file does not exist — which is the exact failure this function
// exists to fix, made worse. The manifest says what was attached, what was not, and why.
/**
 * The HEAD-side paths of every file a unified diff touches, excluding deletions.
 *
 * ── Why the `b/` side, and why deletions are dropped ─────────────────────────────────────────
 * Callers attach whole-file context read from the PR's HEAD commit. The `a/` (pre-image) path is
 * the wrong side for that: on a RENAME it is the OLD name, which does not exist at head — so the
 * lookup misses, the file is silently dropped from the reviewer's context, and the code looks like
 * it attached it. A DELETED file has no head-side content at all, so asking for it can only fail.
 *
 * Both were live: `cross-review.mjs` used `/^diff --git a\/(\S+) b\/\S+$/gm` and read the `a/`
 * capture (cross-review, Codex, PR #119).
 *
 * Split per file rather than scanning the whole diff, because `+++ /dev/null` marks a deletion only
 * for the file header it belongs to — matched globally it would suppress unrelated files.
 */
export function headSidePaths(diff) {
  return String(diff || '')
    .split(/^diff --git /m)
    .slice(1)
    .map((chunk) => {
      // The `+++` file marker lives in the HEADER, before the first `@@` hunk. Scanning the whole
      // chunk was wrong: inside a hunk, an ADDED line is rendered with a leading `+`, so a source
      // line whose literal text is `++ /dev/null` produces the byte-identical `+++ /dev/null` and
      // would silently drop a file that was never deleted (cross-review, Codex, PR #119, round 3).
      // This file's own fixtures contain such strings, so the hazard is not theoretical here.
      const hunkStart = chunk.search(/^@@ /m);
      const header = hunkStart === -1 ? chunk : chunk.slice(0, hunkStart);
      // TWO deletion signals, because neither covers every case on its own:
      //   `deleted file mode` — git emits it for every deletion, text or BINARY.
      //   `+++ /dev/null`     — the text-diff marker.
      // A BINARY deletion has no `+++` line at all (it renders as
      // `Binary files a/x and /dev/null differ`), so checking only the marker attached a path that
      // cannot exist at head and then reported it as "unavailable" — a misleading warning about a
      // file that is correctly absent (cross-review, Codex, PR #119, round 4).
      if (/^deleted file mode /m.test(header) || /^\+\+\+ \/dev\/null$/m.test(header)) return null;
      return headPathFromDiffHeader(chunk.split('\n', 1)[0]);
    })
    .filter((path) => path !== null);
}

/**
 * The `b/` path out of one `diff --git` header line, handling Git's quoting.
 *
 * Git quotes a pathname whenever it contains a space, a control character or a non-ASCII byte, and
 * then C-escapes it: `diff --git "a/my file.ts" "b/my file.ts"`. The first version of this function
 * treated a quoted header as unparseable and dropped the file — silently omitting it from the
 * reviewer's context, which is precisely the defect this whole seam exists to remove (cross-review,
 * Codex, PR #119, round 2). Losing a renamed file and losing an accented one are the same bug.
 */
function headPathFromDiffHeader(header) {
  const sides = splitDiffHeaderSides(header);
  if (sides === null) return null;
  const head = unquoteGitPath(sides.head);
  return head !== null && head.startsWith('b/') ? head.slice(2) : null;
}

/** The two raw (still-quoted) sides of a `diff --git` header, or null if it does not parse. */
function splitDiffHeaderSides(header) {
  const text = String(header || '');
  // Quoted sides are unambiguous — read the closing quote, honouring backslash escapes.
  if (text.startsWith('"')) {
    const end = findClosingQuote(text, 0);
    if (end === -1) return null;
    const rest = text.slice(end + 1).trimStart();
    return rest === '' ? null : { pre: text.slice(0, end + 1), head: rest };
  }
  // Unquoted `a/…`: the head side starts at the LAST ` b/` or ` "b/`, because an unquoted path
  // cannot contain a space and therefore cannot itself contain " b/".
  const marker = text.lastIndexOf(' b/') >= 0 ? text.lastIndexOf(' b/') : text.lastIndexOf(' "b/');
  if (marker === -1) return null;
  return { pre: text.slice(0, marker), head: text.slice(marker + 1) };
}

function findClosingQuote(text, openIndex) {
  for (let i = openIndex + 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '"') return i;
  }
  return -1;
}

/**
 * Reverse Git's C-style path quoting.
 *
 * Octal escapes are the reason this collects BYTES before decoding: git emits a non-ASCII character
 * as one escape per UTF-8 byte (`é` → `\303\251`), so decoding each escape as its own character
 * would produce mojibake rather than the filename. An unquoted path is returned unchanged.
 */
function unquoteGitPath(raw) {
  const text = String(raw || '');
  if (!text.startsWith('"')) return text;
  const end = findClosingQuote(text, 0);
  if (end === -1) return null;
  const body = text.slice(1, end);
  const bytes = [];
  const SIMPLE = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      for (const byte of Buffer.from(body[i], 'utf8')) bytes.push(byte);
      continue;
    }
    const next = body[++i];
    if (next === undefined) return null;
    if (next >= '0' && next <= '7') {
      const octal = body.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(octal)) return null;
      bytes.push(parseInt(octal, 8));
      i += 2;
      continue;
    }
    if (!(next in SIMPLE)) return null;
    bytes.push(SIMPLE[next]);
  }
  return Buffer.from(bytes).toString('utf8');
}

export function buildFileContext(paths, readFile, budgetBytes, opts = {}) {
  const { maxFiles = 40 } = opts;
  const seen = new Set();
  const candidates = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    let text = null;
    try {
      text = readFile(path);
    } catch {
      // Deleted by the PR, or renamed away. Not an error: the diff already shows the removal, and a
      // file that no longer exists has no "current contents" to attach.
      continue;
    }
    if (typeof text === 'string') candidates.push({ path, text, bytes: Buffer.byteLength(text, 'utf8') });
  }

  // Smallest first: for a fixed budget this attaches the most FILES, and the finding class being
  // fixed is "the reviewer could not see file X at all" — breadth beats depth.
  candidates.sort((a, b) => a.bytes - b.bytes || a.path.localeCompare(b.path));

  const attached = [];
  const omitted = [];
  let used = 0;
  for (const file of candidates) {
    const framed = file.bytes + file.path.length + 24; // fence + heading overhead
    if (attached.length >= maxFiles || used + framed > budgetBytes) {
      omitted.push(file.path);
      continue;
    }
    attached.push(file);
    used += framed;
  }

  return { attached, omitted, bytes: used };
}

/** Render what buildFileContext selected, including the honest manifest. Empty string when nothing fit. */
export function renderFileContext({ attached, omitted }) {
  if (attached.length === 0 && omitted.length === 0) return '';
  const lines = [
    '## Current full contents of the files this diff touches',
    '',
    'A diff shows changed lines and a few of context. These are the COMPLETE current files, so you',
    'can check whether a symbol is defined elsewhere in the file, or imported from somewhere the',
    'diff does not show, before reporting it as missing.',
    '',
  ];
  if (omitted.length) {
    lines.push(
      `**${omitted.length} file(s) did NOT fit the size budget and are not below. Their absence here says` +
        ` nothing about whether they exist:** ${omitted.join(', ')}.`,
      ''
    );
  }
  for (const file of attached) {
    lines.push(`### ${file.path}`, '', '```', file.text, '```', '');
  }
  return lines.join('\n');
}

// agy 1.0.10 print mode: --model is REQUIRED (or `--print` exits 0 with NO output), and a quota-exhausted /
// unreachable model ALSO exits 0 with empty stdout (the 429 lands only in agy's log). So an empty result is a
// real failure, not success — we try AGY_MODEL first and, on empty, retry once with AGY_FALLBACK_MODEL (a
// separate quota pool) so a Gemini quota exhaustion degrades to GPT-OSS instead of silently blanking the review.
// We enforce the argv size cap up front (clear message, not an opaque E2BIG). `deps.spawn` is injectable for tests.
export function runAntigravity(fullArgv, opts = {}, deps = {}) {
  const { spawn = spawnSync, warn = (m) => process.stderr.write(`${m}\n`), sleep = sleepSync } = deps;
  if (Buffer.byteLength(fullArgv, 'utf8') > AGY_ARG_LIMIT) {
    return fail(
      opts.soft,
      `input too large for antigravity (${Math.round(Buffer.byteLength(fullArgv) / 1024)} KB > ` +
        `${AGY_ARG_LIMIT / 1024} KB; agy takes the prompt in argv, not stdin) — use --agent codex instead.`
    );
  }

  // opts.models lets a caller pick its own primary→fallback pair (e.g. prose-draft
  // runs a cheaper Flash model) without forking the retry/empty-output plumbing.
  // Default: the review pair above — existing callers are byte-identical in behavior.
  const modelPair = opts.models?.length
    ? [...new Set(opts.models)]
    : AGY_MODEL === AGY_FALLBACK_MODEL
      ? [AGY_MODEL]
      : [AGY_MODEL, AGY_FALLBACK_MODEL];
  const tried = [];
  const causes = []; // one plain line per model that did not answer, for the final message
  const logDir = mkdtempSync(join(tmpdir(), 'agy-log-'));
  try {
    for (const model of modelPair) {
      const logFile = join(logDir, `${model}.log`);
      let r = execAgy(fullArgv, model, spawn, logFile);
      for (let retry = 1; retry <= AGY_CAPACITY_RETRIES; retry += 1) {
        if (r.status === 0 || agyFailureKind(`${r.stderr || ''}\n${r.stdout || ''}`) !== 'capacity') break;
        warn(
          `⚠ agy "${model}" has no capacity right now (not quota) → retry ${retry}/${AGY_CAPACITY_RETRIES} in ${Math.round(AGY_CAPACITY_WAIT_MS / 1000)}s.`
        );
        sleep(AGY_CAPACITY_WAIT_MS);
        r = execAgy(fullArgv, model, spawn, logFile);
      }
      if (r.status !== 0) {
        const last = (r.stderr || '').trim().split('\n').filter(Boolean).pop() || 'unknown error';
        // A non-zero exit is USUALLY a real agy error (bad flags, crash) — surface those directly
        // rather than burning the fallback on them.
        //
        // But not always, and this cost a real run to learn (2026-07-25, commit-report's first live
        // use after merge): `gpt-oss-120b-medium` answered "Our servers are experiencing high traffic
        // right now, please try again in a minute" with a NON-ZERO exit. That is precisely the
        // situation the second model exists for — a different provider with a separate capacity pool
        // — and the old branch refused to try it, because the fallback was wired only to the
        // EMPTY-output signal. Same transient condition, different exit code, no fallback.
        // Classify on the FULL output, not on `last`. `last` is only the final non-empty stderr line,
        // chosen because it makes the best human-readable message — but agy can emit the transient
        // notice followed by a stack trace or a trailing status line, which would push the phrase we
        // match on out of view and abort instead of falling back (cross-review, PR #29). Both streams
        // are checked because agy is already known to split diagnostics across them inconsistently —
        // the same reason isContextWindowOverflow is called on stdout and stderr above.
        const failureOutput = `${r.stderr || ''}\n${r.stdout || ''}`;
        const kind = agyFailureKind(failureOutput);
        const cause =
          kind === 'quota'
            ? `quota reached${agyQuotaReset(failureOutput) ? `, resets in ${agyQuotaReset(failureOutput)}` : ''}`
            : kind === 'capacity'
              ? `no capacity after ${AGY_CAPACITY_RETRIES + 1} tries (transient, NOT quota; re-run in a few minutes)`
              : last;
        causes.push(`"${model}": ${cause}`);
        if (isTransientAgyError(failureOutput) && model !== modelPair[modelPair.length - 1]) {
          warn(`⚠ agy "${model}" is unavailable (${cause}) → trying the fallback model.`);
          tried.push(model);
          continue;
        }
        return fail(opts.soft, `agy -p failed — ${causes.join('; ')}`);
      }
      const out = (r.stdout || '').trim();
      if (out) {
        if (model !== modelPair[0])
          warn(`⚠ agy "${modelPair[0]}" did not answer (${causes[0]}) → used "${model}".`);
        // Tell the caller WHICH model answered. Added because the prose rail's footer said "agy",
        // which cannot distinguish the primary from the fallback — so a silent switch between two
        // models with very different registers was unattributable in the channel, and that is exactly
        // the confusion that took a human to notice. Optional and side-effect-only, so every existing
        // caller keeps its byte-identical string return.
        opts.onModel?.(model);
        return out;
      }
      const why = agyLogError(readOrNull(logFile));
      causes.push(
        `"${model}": empty output${why ? ` — agy's log says: ${why}` : ' and no error in its log'}`
      );
      tried.push(model);
    }
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
  if (causes.some((c) => c.includes("agy's log says")))
    return fail(opts.soft, `agy returned no review — ${causes.join('; ')}`);
  return fail(
    opts.soft,
    `agy returned no output for ${tried.map((m) => `"${m}"`).join(' and ')} — likely a quota cap ` +
      `("RESOURCE_EXHAUSTED 429") or an unavailable model. Set AGY_MODEL / AGY_FALLBACK_MODEL to a model ` +
      `\`agy models\` lists with remaining quota, or use --agent codex.`
  );
}

// ── Mistral Vibe (`vibe`) ────────────────────────────────────────────────────────────────────────────────
// Vibe's non-interactive path is `--prompt` ("programmatic mode"): it skips the Textual chat UI, disables
// interactive tools, and exits when done. Three flags matter for a reviewer and each is deliberate:
//
//   --agent plan   Vibe ships several approval agents (default · plan · accept-edits · auto-approve) and
//                  programmatic mode DEFAULTS TO `auto-approve` — i.e. a reviewer that could silently edit
//                  the working tree. `plan` is the read-only one. This is not a nicety: an advisory review
//                  that mutates the repo it is reviewing is the exact failure the "advisory only" contract
//                  exists to prevent, so the flag is passed unconditionally and is not overridable by env.
//   --max-turns    Vibe's own docs recommend bounding run length. A single-pass review needs very few.
//   --output text  json/streaming are for structured consumers; we want the prose findings on stdout.
//   --trust        Programmatic mode still ENFORCES folder trust but cannot show the confirmation prompt,
//                  so an untrusted directory would otherwise stall or refuse. `--trust` grants trust for
//                  this invocation only (it does not write ~/.vibe/trusted_folders.toml).
//
// ⚠ CONTRACT NOT YET PROBED AGAINST A LIVE BINARY. Everything above comes from Mistral's published CLI
// docs, not from a run on this machine — and this repo's own rule is that a roster is PROBED, never
// assumed (a CLI that self-reports a capability it does not have has burned us before; see the agy
// version pin above, where a silent `--print` contract change shipped empty reviews for weeks). Before
// relying on vibe in a real review, run the probe once and record the result here:
//
//   node scripts/cross-review.mjs <PR#> --agent vibe --dry-run
//
// A green probe prints real findings. An EMPTY result is a FAILURE, not a pass — see runVibe below, which
// treats empty stdout as an error exactly like the agy path does, for the same reason (a quota-capped or
// misconfigured CLI can exit 0 with nothing).
// vibe-probe: verified 2026-08-25 against vibe 2.24.2 — `node scripts/cross-review.mjs 118 --agent vibe
//   --builder claude --code-only --dry-run` returned a real, substantive review (Blocking: None,
//   Should-fix: None, and one Nit that independently spotted an unrelated version-pin commit riding
//   the branch). NOT empty, which is the failure this probe exists to catch. The four flags above
//   (--agent plan / --max-turns / --output text / --trust) behaved as the docs describe.
//
// `vibe-acp` is the WRONG entry point for this use case and is deliberately not wired: it starts a
// JSON-RPC server that speaks the Agent Client Protocol over stdio for IDE extensions (Zed et al.). It
// expects a long-lived client session, not a one-shot prompt, so a script would have to implement an ACP
// client to get a single review out of it. `vibe --prompt` is the scripting/CI path, and it is the one
// Mistral documents for exactly this.
export const VIBE_ARG_LIMIT = 256 * 1024;
// 4 → 12 (2026-08-07) → 24 (the template's live-probed budget). With every tool disabled a turn cannot
// be spent on a tool call, so a higher ceiling costs nothing when it is not needed; the alternative is an
// intermittently missing review. `--max-price` / `--max-tokens` exist if a real cost bound is ever wanted.
export const VIBE_MAX_TURNS = process.env.VIBE_MAX_TURNS || '24';
// The reviewer's ENTIRE toolset: nothing. Kept as an exported (empty) list so the argv contract stays a
// named, tested fact rather than a literal buried in runVibe.
//
// ── Why the read-only allow-list was removed (distribute-what-we-use D1, 2026-09-29) ─────────────────
// From 2026-08-07 this was ['read_file', 'grep'] with `--auto-approve`, which cured a blind reviewer.
// a consuming project's probe of 2026-08-08 (vibe 2.23.3) found why that is unsafe: vibe checks auto-approval
// BEFORE its sensitive-file and outside-workdir prompts, and `read_file` takes absolute paths. A malicious
// PR diff could therefore instruct the reviewer to read `.env.local` or a host key into its findings,
// which cross-review then POSTS as a comment — on a public repo, to anyone. Where two copies of this
// rail disagreed on a safety property, the stricter one wins.
//
// The blindness this once cured is cured differently now: cross-review attaches the touched files'
// head-side contents (buildFileContext) to the prompt, so the reviewer sees the surrounding code without
// being able to ask for any path it likes.
export const VIBE_READ_ONLY_TOOLS = Object.freeze([]);
// Optional: pin a model with `VIBE_MODEL`. Left unset by default so vibe uses the account's configured
// default — unlike agy, an unset model here is not known to blank the output.
export const VIBE_MODEL = process.env.VIBE_MODEL || null;

// ── Claude Code (`claude`) as a plain CLI reviewer ───────────────────────────────────────────────────────
// Sonnet by default: review is a single read of a bounded diff, and the routing policy reserves the
// strongest model for the *fresh subagent* pass on high-risk work (see review-route.mjs). Override with
// CLAUDE_REVIEW_MODEL.
//
// The invocation is deliberately tool-less. `--tools ""` removes every built-in tool and
// `--strict-mcp-config` (with no `--mcp-config`) loads no MCP servers, so the reviewer can do exactly one
// thing: read the diff piped to it on stdin and write findings to stdout. It cannot edit the tree it is
// reviewing, cannot shell out, and cannot wander into unrelated files — the same "single pass, advisory,
// no writes" contract the other three CLIs get, enforced by flags rather than by hope.
// `--bare` skips hook/skill/plugin/MCP/CLAUDE.md auto-discovery so a scripted call starts fast and, more
// importantly, so the review is not silently reshaped by whatever config the host repo happens to carry.
export const CLAUDE_REVIEW_MODEL = process.env.CLAUDE_REVIEW_MODEL || 'sonnet';

// One `vibe --prompt "<prompt+context>" --agent plan --output text` invocation. Like agy, vibe takes the
// whole thing as an argv string, so the same size cap applies (and for the same reason: a clear message
// beats an opaque E2BIG). `--agent plan` is NOT optional, and `--disabled-tools '*'` is equally
// non-optional: plan mode describes intended behaviour, while the tool filter enforces that an injected
// diff cannot read host files, shell out or mutate anything (see VIBE_READ_ONLY_TOOLS for why the
// read-only allow-list this used to carry was removed). No `--auto-approve`: there is nothing to approve.
//
// Empty stdout is treated as a FAILURE, not as "no findings". Every CLI on this roster can exit 0 having
// produced nothing when it is quota-capped or misconfigured, and a review that silently becomes empty is
// worse than one that errors — it reads as a clean pass. `deps.spawn` is injectable for tests.
// The argv for one vibe call, read-only (every tool disabled). Exported for the same reason as agyArgs (C4).
export function vibeArgs(fullArgv) {
  const args = [
    '--prompt',
    fullArgv,
    '--agent',
    'plan',
    '--output',
    'text',
    '--max-turns',
    String(VIBE_MAX_TURNS),
    '--trust',
    '--disabled-tools',
    '*',
  ];
  if (VIBE_MODEL) args.push('--model', VIBE_MODEL);
  return args;
}

export function runVibe(fullArgv, opts = {}, deps = {}) {
  const { spawn = spawnSync } = deps;
  if (Buffer.byteLength(fullArgv, 'utf8') > VIBE_ARG_LIMIT) {
    return fail(
      opts.soft,
      `input too large for vibe (${Math.round(Buffer.byteLength(fullArgv) / 1024)} KB > ` +
        `${VIBE_ARG_LIMIT / 1024} KB; vibe takes the prompt in argv, not stdin) — use --agent codex instead.`
    );
  }

  const r = spawn('vibe', vibeArgs(fullArgv), { input: '', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error)
    return fail(
      opts.soft,
      `vibe not found or failed to spawn (${r.error.message}) — install the Mistral Vibe CLI ` +
        `(\`uv tool install mistral-vibe\`) and authenticate it, or use --agent codex/antigravity.`
    );
  if (r.status !== 0) {
    const detail = lastLine(r.stderr) || lastLine(r.stdout);
    // Name the remedy for the one failure that is ours, not the CLI's. A turn-limit stop means the
    // agent ran out of budget mid-review; it is not a quota cap and re-running rarely helps.
    const hint = /turn limit/i.test(`${r.stderr || ''}${r.stdout || ''}`)
      ? ` — the agent ran out of turns, not quota. Raise VIBE_MAX_TURNS (currently ${VIBE_MAX_TURNS}) and re-run.`
      : '';
    return fail(opts.soft, `vibe --prompt failed: ${detail}${hint}`);
  }

  const out = (r.stdout || '').trim();
  if (!out)
    return fail(
      opts.soft,
      `vibe returned no output — likely a quota cap, an auth lapse, or an untrusted folder. Verify with ` +
        `\`vibe --prompt "say OK" --output text --trust\`; if that is empty too, re-authenticate. ` +
        `(An empty result is a failure, never "no findings" — see runVibe's header.)`
    );
  // ── A TRUNCATED review is a failure too, and it is the dangerous shape ────────────────────────
  // On PR #121 vibe exhausted its turn budget mid-read and exited 0 with a bare tool call as its
  // entire output — `read_file{"file_path": …}`. Both guards above passed (status 0, output
  // non-empty), so the runner posted it to the PR, where it renders as a review with no findings.
  // An empty result at least LOOKS wrong; a truncated one reads as a clean pass and quietly removes
  // a family from the gate.
  //
  // Detected by shape rather than by scanning for an error string: a real review always contains a
  // findings heading, because the prompt demands one. Anything that does not is not a review.
  if (isTruncatedReview(out)) {
    return fail(
      opts.soft,
      `vibe requested a disabled tool or stopped between turns — no review was produced (its output is a ` +
        `bare tool call, or has no findings section). Re-run; if it recurs, raise VIBE_MAX_TURNS ` +
        `(currently ${VIBE_MAX_TURNS}). Posting this would look like a clean pass.`
    );
  }
  return out;
}

/**
 * Does this look like a stopped-mid-review rather than a review?
 *
 * Two signals, both cheap and neither dependent on the model's wording:
 *   1. the output STARTS with a tool call (`read_file{…}`, `grep {…}`) — the literal shape vibe emits
 *      when it is cut off between turns, or when it asks for a tool that is disabled;
 *   2. it is not a review by review-guard's own test: no severity heading and no clean verdict.
 *
 * (2) used to be its own list — Blocking / Should-fix / Nit only — so `Clean.`, the one-line verdict the
 * prompt asks for on a clean diff, failed here as "truncated" before review-guard ever saw it. Every clean
 * vibe review died that way (reproduced on PR #265, 2026-10-04). One definition of "a review" now.
 *
 * Exported for the unit layer: this is the guard whose absence let a non-review reach a PR.
 */
export function isTruncatedReview(out) {
  const text = String(out || '').trim();
  if (/^\w+\s*\{/.test(text)) return true;
  return !assertReviewOutput(text).ok;
}

// One `claude -p "<prompt>"` invocation with the context piped on stdin (same shape as codex, which is why
// cross-review can hand both runners the identical prompt/stdin pair). Tool-less and MCP-less by
// construction — see CLAUDE_REVIEW_MODEL's header for why each flag is there.
//
// NOTE ON SAME-FAMILY REVIEW: nothing in this function knows who built the diff. The refusal lives one
// level up: review-route never routes a family to its own diff, and cross-review refuses `--agent claude`
// when `--builder claude` is stated (checkReviewerPairing). Without a stated builder, the caller owns it.
//
// AUTH NOTE: `--bare` skips keychain/OAuth reads, so this path authenticates with ANTHROPIC_API_KEY.
export function runClaudeCode(prompt, stdin, opts = {}, deps = {}) {
  const { spawn = spawnSync } = deps;
  const args = [
    '-p',
    prompt,
    '--model',
    CLAUDE_REVIEW_MODEL,
    '--tools',
    '',
    '--strict-mcp-config',
    '--output-format',
    'text',
    '--no-session-persistence',
    '--bare',
  ];

  const r = spawn('claude', args, { input: stdin, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error)
    return fail(
      opts.soft,
      `claude not found or failed to spawn (${r.error.message}) — install Claude Code ` +
        `(https://claude.com/claude-code) and set ANTHROPIC_API_KEY (this path runs \`--bare\`), or use --agent codex/antigravity.`
    );
  if (r.status !== 0) return fail(opts.soft, `claude -p failed: ${lastLine(r.stderr)}`);

  const out = (r.stdout || '').trim();
  if (!out)
    return fail(
      opts.soft,
      `claude returned no output — likely a usage cap or a missing ANTHROPIC_API_KEY (this path runs \`--bare\`), ` +
        `or use --agent codex/antigravity/vibe. (An empty result is a failure, never "no findings".)`
    );
  return out;
}

// ── Devin — a PROSE WRITER here, never a reviewer (independent quota pool) ────────────────────────────────
// lib/prose-writer.mjs drafts with Devin first (plugin-audit-and-extraction S1). It is deliberately NOT in
// AGENTS, so `cross-review.mjs --agent devin` is refused. A consuming project used it as a third review pool;
// distribute-what-we-use S1's security lens found why that is unsafe: `devin -p` auto-approves read-only
// tools (`--permission-mode auto`), there is no flag that disables them, and even `--sandbox` "can read
// everything except paths hidden by Deny(Read(...)) rules" (`devin --help`, 3000.11.3). A reviewer fed an
// attacker's PR diff could be steered into reading `.env.local` into a comment posted on the PR — the same
// hole closed for Vibe (see VIBE_READ_ONLY_TOOLS). Its prose drafts are fed this repo's own docs and git log.
// `devin -p --prompt-file <file>` runs non-interactively and prints the response. The prompt (framing +
// diff) rides in a FILE, not argv, so there is NO size cap to guard — the whole reason to prefer prompt-file
// over agy's argv path for large diffs. Empty stdout is a failure (a quota-capped devin, like agy, exits 0
// with nothing). Uses the account default model. `deps` is injectable so a node:test drives it without a
// real devin binary or touching the real filesystem.
/**
 * The line of devin's stderr that says what went wrong. Devin ends its errors with a JSON detail block, so the LAST
 * line is a bare `}` — which is all the 📝 rail logged for ten days while the real line read "Your weekly usage quota
 * has been exhausted". Prefer the first `Error:` line, else the last line that is not JSON punctuation.
 */
export function devinErrorLine(stderr) {
  const lines = String(stderr || '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const error = lines.find((l) => /^error\b/i.test(l));
  if (error) return error.replace(/:?\s*\{\s*$/, '');
  return lines.filter((l) => !/^[{}\[\],]+$/.test(l)).pop() || 'unknown error';
}

export function runDevin(prompt, opts = {}, deps = {}) {
  const { spawn = spawnSync, writeFile = writeFileSync, mkdtemp = mkdtempSync, rm = rmSync } = deps;
  let dir;
  try {
    dir = mkdtemp(join(tmpdir(), 'xrev-devin-'));
  } catch (e) {
    return fail(opts.soft, `could not create a temp dir for devin's prompt file: ${e.message}`);
  }
  const file = join(dir, 'prompt.md');
  try {
    writeFile(file, prompt, 'utf8');
    const r = spawn('devin', ['-p', '--prompt-file', file], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error)
      return fail(
        opts.soft,
        `devin not found or failed to spawn (${r.error.message}) — install the Devin CLI or use --agent codex/antigravity.`
      );
    if (r.status !== 0) return fail(opts.soft, `devin -p failed: ${devinErrorLine(r.stderr)}`);
    const out = (r.stdout || '').trim();
    if (!out) {
      return fail(
        opts.soft,
        `devin returned no output — likely a quota cap or auth lapse (run \`devin auth\`), or use --agent codex/antigravity.`
      );
    }
    return out;
  } finally {
    // Best-effort cleanup — a leaked temp prompt file must never fail the review.
    try {
      rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
