#!/usr/bin/env node
// cross-agent-doctor.mjs — ONE doctor for the reviewer CLIs (ways-of-work-lean-pass S2.5).
//
// ONE file across every consumer since distribute-what-we-use S1 (2026-09-29): a consuming project's doctor (codex +
// agy, the `unavailable` probe class, the strict slug parser) merged with Golden Frijoles' `agy-doctor.mjs`
// (every configured agy model audited via AGY_MODELS_IN_USE, a drift note that names the model). That
// `agy-doctor.mjs` survives only as an alias for `cross-agent-doctor.mjs agy`.
//
// Merged 2026-09-16 from two former files (a codex doctor and an agy doctor): same diagnosis shape, two copies, and
// the review policy now runs ONE external pass — so when the family that was going to review a PR
// cannot run, you want a single command that says which one is broken and what fixes it.
//
//   node scripts/cross-agent-doctor.mjs            # both families
//   node scripts/cross-agent-doctor.mjs codex      # just codex
//   node scripts/cross-agent-doctor.mjs agy --fix  # bump AGY_PINNED after a green contract probe
//
// Exit code 1 if any family needs an operator action. The two pure decision cores below are unchanged
// from the files they came from, and so are their tests (cross-agent-doctor.{codex,agy}.test.mjs) —
// this is a merge, not a rewrite. vibe and claude have no pinned print contract to drift, so they are
// presence-checked by cross-review.mjs itself rather than here.
//
// Zero npm deps — Node 18+ to diagnose; `agy --fix` needs Node 21+ and refuses below it (see agyMain).
// isMain-guarded so importing the pure cores does not run the CLI.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import {
  isCodexAuthError,
  isCodexOutdated,
  CODEX_MODEL,
  AGY_PINNED,
  AGY_MODEL,
  AGY_FALLBACK_MODEL,
  AGY_MODELS_IN_USE,
  codexExecArgs,
  isCodexCapped,
} from './lib/cross-agent-cli.mjs';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';

// ═══ CODEX ════════════════════════════════════════════════════════════════════════════════════
// The codex half — diagnose why the Codex CLI can't run, and name the exact fix.
//
// WHY: `codex` is the DEFAULT cross-agent reviewer (scripts/cross-review.mjs), but it fails in three
// operator-fixable ways that otherwise surface as an opaque `codex exec failed …` and force a manual
// `--agent antigravity`. This makes the diagnosis executable — the agent that hits a codex failure runs
// this and learns which of the three it is:
//
//   node scripts/cross-agent-doctor.mjs codex        # diagnose: present? version? a live `codex exec` probe → class
//
// The three recoverable classes (all confirmed live 2026-07-20 against codex-cli 0.142.5):
//   • auth-lapsed  — token expired/revoked. Fix: `codex login`.
//   • cli-outdated — the installed CLI is too old for the model it runs (its own default, or CODEX_MODEL):
//                    "The 'gpt-5.6-sol' model requires a newer version of Codex." Fix: upgrade codex
//                    (`npm install -g @openai/codex@latest`, or your install channel), OR set
//                    CODEX_MODEL to a model the INSTALLED codex supports as a stopgap (`codex exec -m …`).
//   • missing      — codex not on PATH. Fix: install it.
// Plus 'broken' (a non-auth/non-stale exec error — surfaced verbatim, not masked) and 'ok'.
//
// UNLIKE agy-doctor there is NO --fix: codex is not version-PINNED in the repo (nothing to bump), and
// upgrading a global binary is an environment-specific system mutation this script deliberately won't run
// on its own (same stance agy-doctor takes toward the agy binary itself). It DIAGNOSES and names the fix.
// The runtime already self-heals both recoverable classes by auto-falling-back to Antigravity
// (runWithCodexFallback) — this script is for when you want codex ITSELF back.
//
// NOT wired into a cloud routine (deliberate): a routine sandbox has no codex binary/auth, so codex drift
// can only be observed on a machine where codex runs — the same reason cross-review is local-only.
//
// Zero npm deps — Node 18+. Pure decision logic exported for node:test (isMain-guarded, per LEARNINGS).
// ── Pure decision core (the unit under test) ─────────────────────────────────────────────────────────
// Given the observed facts, decide ONE action. `probe` is the classified result of a live `codex exec`:
//   'ok'       — real stdout, exit 0.
//   'auth'     — non-zero + an auth-lapse signal (isCodexAuthError).
//   'outdated' — non-zero + a stale-CLI signal (isCodexOutdated).
//   'error'    — non-zero for some other reason (surfaced verbatim, never masked).
//   'skipped'  — not probed (binary missing).
export function decideCodexDoctorAction({ present, probe }) {
  if (!present) return { action: 'missing', note: 'codex is not on PATH.' };
  switch (probe) {
    case 'ok':
      return { action: 'ok', note: 'a live `codex exec` probe returned real output.' };
    case 'auth':
      return { action: 'auth-lapsed', note: 'codex is installed but its token has lapsed/was revoked.' };
    case 'outdated':
      return { action: 'cli-outdated', note: 'the installed codex is too old for the model it runs.' };
    case 'capped':
      return {
        action: 'capped',
        note: 'codex is installed and signed in, but the account hit its usage cap.',
      };
    default:
      return { action: 'broken', note: 'a live `codex exec` probe failed for a non-auth, non-stale reason.' };
  }
}

// Human-readable remediation per action — kept beside the decision so the message and the classification
// can't drift. `ctx` carries the observed version + the CODEX_MODEL escape-hatch state.
export function remediation(action, ctx = {}) {
  const model = ctx.codexModel
    ? `CODEX_MODEL="${ctx.codexModel}"`
    : 'CODEX_MODEL (unset — codex uses its own default model)';
  switch (action) {
    case 'ok':
      return null;
    case 'missing':
      return 'Install the Codex CLI (e.g. `npm install -g @openai/codex`), then `codex login`.';
    case 'auth-lapsed':
      return 'Restore the token: `codex login`. (The cross-review runtime already auto-falls-back to Antigravity meanwhile.)';
    case 'capped':
      return (
        'Wait for the cap to reset, or route past codex: `node scripts/review-route.mjs --builder <who> --exclude codex <PR#>`. ' +
        '(cross-review already heals a capped codex onto Antigravity.)'
      );
    case 'cli-outdated':
      return [
        'The installed codex is behind its model requirement. Either:',
        '  1. Upgrade the CLI: `npm install -g @openai/codex@latest` (or your install channel), OR',
        `  2. Stopgap — pin a model the installed CLI supports: set CODEX_MODEL to a listed model so`,
        '     cross-review runs `codex exec -m <model>`. Currently ' + model + '.',
        'Until then, cross-review auto-falls-back to Antigravity on its own.',
      ].join('\n');
    default:
      return 'Non-auth, non-stale codex error — read the probe stderr above; not an auto-diagnosable class.';
  }
}

// ── I/O (thin — the decision core above is what tests exercise) ───────────────────────────────────────
function codex(args, input) {
  return spawnSync('codex', args, { encoding: 'utf8', input: input ?? '', maxBuffer: 16 * 1024 * 1024 });
}

function observeCodex() {
  const ver = codex(['--version']);
  if (ver.error) return { present: false, version: null, probe: 'skipped', probeStderr: '' };
  const version = (((ver.stdout || '') + (ver.stderr || '')).match(/\d+\.\d+\.\d+/) || [null])[0];
  // One real, minimal `codex exec` — the same call cross-review makes (respecting CODEX_MODEL), so the
  // probe sees exactly what the reviewer would. A tiny prompt keeps the token/CLI-version check cheap.
  const r = codex(codexExecArgs('Reply with exactly: OK'), '');
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  let probe;
  if (r.status === 0 && (r.stdout || '').trim()) probe = 'ok';
  else if (isCodexOutdated(out)) probe = 'outdated';
  else if (isCodexCapped(out)) probe = 'capped';
  else if (isCodexAuthError(out)) probe = 'auth';
  else probe = 'error';
  return { present: true, version, probe, probeStderr: (r.stderr || '').trim() };
}

async function codexMain() {
  const obs = observeCodex();
  const { action, note } = decideCodexDoctorAction(obs);
  const line = (s) => process.stdout.write(`${s}\n`);

  line(
    `codex — ${obs.present ? `installed ${obs.version || '(unparsed version)'}` : 'NOT INSTALLED'} · CODEX_MODEL ${CODEX_MODEL ? `="${CODEX_MODEL}"` : '=default (codex built-in; user config ignored)'}`
  );
  if (obs.present) line(`live probe: ${obs.probe}`);
  line(`  → ${note}`);

  const fix = remediation(action, { codexModel: CODEX_MODEL });
  if (action === 'ok') {
    line('✓ codex is healthy — no fallback needed.');
    return;
  }
  if (obs.probe === 'error' && obs.probeStderr) {
    line('  probe stderr (tail):');
    line('    ' + obs.probeStderr.split('\n').slice(-3).join('\n    '));
  }
  line('✗ ' + action + ':');
  line(
    fix
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n')
  );
  process.exitCode = 1;
}

// ═══ ANTIGRAVITY (agy) ════════════════════════════════════════════════════════════════════════
// agy-doctor.mjs — diagnose & self-heal drift between the Antigravity CLI and our pinned contract.
//
// WHY: `agy` is under constant development and its headless print contract has broken on minor bumps
// before (1.0.10 shipped empty reviews for weeks). The shared rail (scripts/lib/cross-agent-cli.mjs)
// therefore PINS the version and FAIL-LOUDS on mismatch — safe, but every agy self-update stalls
// cross-review until a human re-verifies the contract and bumps AGY_PINNED by hand. This script makes
// that re-verification executable, so the agent that hits the pin failure is AUTHORIZED to clear it:
//
//   node scripts/cross-agent-doctor.mjs agy          # diagnose: version vs pin, help contract, models, live probes
//   node scripts/cross-agent-doctor.mjs agy --fix    # on clean version drift: bump AGY_PINNED + run the test suite
//
// What --fix will and will NOT do:
//   • WILL bump the pin — only when the installed version differs AND the live contract probe is green
//     (`agy --help` still shows -p/--model, both pinned models still listed by `agy models`, and at
//     least one live `-p`/`--model` probe returns real output). A failed probe still fails loud with
//     what broke — that's the 1.0.10 protection, kept.
//   • WILL NOT swap models. A vanished/renamed pinned model is reported with the current `agy models`
//     list; choosing a reviewer model is a judgment call (edit AGY_MODEL/AGY_FALLBACK_MODEL or set the
//     env overrides). It also never upgrades/downgrades the agy binary itself.
//   • WILL NOT commit or push. After --fix, commit the one-line bump via the normal flow (LOW tier —
//     docs/tooling). A script pushing branches from arbitrary checkouts would recreate the
//     shared-worktree collision class LEARNINGS warns about; agents already own the commit/PR flow.
//
// NOT wired into ops-nightly (deliberate): a cloud routine sandbox has no agy binary and agy has no
// headless auth (the same fact that keeps cross-review local-only), so drift can only be observed —
// and fixed — on a machine where agy runs. The distribution point is checkAgyVersion's own failure
// message, which names this command.
//
// Zero npm deps — Node 21+ (the --fix flow's `node --test 'scripts/lib/*.test.mjs' 'scripts/*.test.mjs'` relies on the test
// runner's own glob expansion under spawnSync(..., {shell:false}), which Node added in 21; below that,
// the literal, unexpanded pattern silently matches nothing). Pure decision logic exported for node:test
// (isMain-guarded, per LEARNINGS).
const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_PATH = join(__dirname, 'lib', 'cross-agent-cli.mjs');

// ── Pure decision core (the unit under test) ─────────────────────────────────────────────────────────
// Given the observed facts, decide ONE action, most severe first:
//   'contract-broken' — the -p/--model interface itself changed, or agy errored on a live probe, or NO
//                       model produced output. A version bump must NOT be blessed; human re-verify.
//   'model-drift'     — a pinned model is no longer listed by `agy models` (rename/retirement). Reported,
//                       never auto-swapped.
//   'bump'            — version differs from the pin and the full contract probe is green → safe to bump.
//   'quota-warn'      — contract fine (version matches or bump already decided against), but the PRIMARY
//                       model returned empty on the live probe (quota/transient) while the fallback
//                       carried it — exactly the degrade runAntigravity handles; informational.
//   'ok'              — everything matches and probes green.
// `probes` values: 'ok' (real stdout) | 'empty' (exit 0, no output — the quota signature)
//                 | 'unavailable' (non-zero, but the provider said it is busy — see UPSTREAM_UNAVAILABLE)
//                 | 'error'
// (non-zero exit) | 'skipped'.
/**
 * Provider-side "busy, try later" signatures.
 *
 * 🚨 WHY THIS EXISTS. `agy -p … --model gpt-oss-120b-medium` began exiting 1 with
 * "Our servers are experiencing high traffic right now, please try again in a
 * minute." The probe classified any non-zero exit as 'error', 'error' means
 * "the interface changed", and that verdict refuses to bump the pin — so a
 * TRANSIENT CAPACITY BLIP ON ONE MODEL took the whole agy review family offline
 * and kept it there. Observed live 2026-08-19: the epic's cross-family pass ran
 * with two families instead of three for exactly this reason.
 *
 * The interface was never broken: `--help` still showed the print contract, both
 * slugs were still listed by `agy models`, and the primary model answered fine.
 * Three states were not enough — "I could not reach it" is not "it changed", and
 * collapsing them is the same mistake this codebase keeps recording.
 *
 * Kept deliberately NARROW. Anything that does not match stays 'error', so an
 * unrecognized flag or an unknown model slug — which also exit non-zero — still
 * break the contract loudly. A guard that swallowed every failure would be worse
 * than the bug it fixes.
 */
export const UPSTREAM_UNAVAILABLE = [
  /experiencing high traffic/i,
  /please try again/i,
  /server is busy/i,
  /temporarily unavailable/i,
  /\b(?:429|503)\b/,
  /rate.?limit/i,
  /overloaded/i,
];

/** Whether a non-zero probe was the provider being busy rather than the CLI changing. */
export function isUpstreamUnavailable(output) {
  const text = String(output || '');
  return UPSTREAM_UNAVAILABLE.some((re) => re.test(text));
}

/**
 * agy's "you are signed out" answer. Observed live 2026-09-29 (agy 1.2.13, right after an auto-update):
 * `agy models` prints "Error: Please sign in to view available models. Launch the CLI without arguments
 * to sign in.", and every `-p` probe waits 60 s for an OAuth code, then "authentication timed out".
 * Read as a contract, that is every model "NOT LISTED" plus two probe errors — a CONTRACT-BROKEN verdict
 * for what is really an operator action. Could-not-look is its own state (LEARNINGS), so it is checked
 * first, and the probes are skipped (each one would otherwise burn a minute waiting for a login).
 */
export function isAgySignedOut(output) {
  return /please sign in|sign in to view|waiting for authentication|authentication (?:timed out|failed)/i.test(
    String(output || '')
  );
}

export function decideDoctorAction({
  installed,
  pinned,
  helpOk,
  primaryListed,
  fallbackListed,
  probes,
  unlistedModels = [],
  signedOut = false,
}) {
  const notes = [];
  if (!installed)
    return {
      action: 'contract-broken',
      notes: [
        '`agy --version` output didn\'t contain a parseable X.Y.Z — a version this blind cannot be bumped (would write the literal string "null" as the pin).',
      ],
    };
  if (!helpOk)
    return {
      action: 'contract-broken',
      notes: ['`agy --help` no longer shows the -p/--model print contract.'],
    };
  // Signed out AFTER the checks that need no login (pr-reviewer S2): a help-contract break is visible
  // signed in or not, and must never be reported as merely "could not look".
  if (signedOut)
    return {
      action: 'signed-out',
      notes: [
        'agy is signed out, so models and the print contract could not be checked (not a contract break).',
      ],
    };
  if (probes.primary === 'error' || probes.fallback === 'error')
    return {
      action: 'contract-broken',
      notes: [
        'a live `agy -p … --model …` probe exited non-zero (not the quota signature — a real interface error).',
      ],
    };
  // 'unavailable' is the provider being busy, NOT the interface changing — so it
  // must never break the contract on its own. But a version whose ONLY evidence
  // is two unreachable models has not been demonstrated to work, so that pairing
  // is still not blessable.
  const blind = (p) => p === 'empty' || p === 'unavailable';
  if (blind(probes.primary) && blind(probes.fallback))
    return {
      action: 'contract-broken',
      notes: [
        'NEITHER model produced output on the live probe (quota exhaustion and/or provider capacity) — a version this blind cannot be blessed; re-run later or re-verify by hand.',
      ],
    };
  // Report each drifted constant ONCE, preferring the entry that names the offending model. Building the
  // descriptive entries (every agy model this repo configures — AGY_MODELS_IN_USE, not just the review
  // pair) FIRST and only then filling gaps from the bare flags makes the precedence explicit rather than an
  // accident of array order (Golden Frijoles' agy-doctor; cross-review caught the wrong duplicate kept).
  const described = new Map(unlistedModels.map((m) => [m.constant, `${m.constant} ("${m.value}")`]));
  for (const [flag, isListed] of [
    ['AGY_MODEL', primaryListed],
    ['AGY_FALLBACK_MODEL', fallbackListed],
  ]) {
    if (!isListed && !described.has(flag)) described.set(flag, flag);
  }
  const missing = [...described.values()];
  if (missing.length) {
    return {
      action: 'model-drift',
      notes: [
        `${missing.join(' and ')} no longer listed by \`agy models\` — pick a replacement (env override or edit the constant); not auto-swapped. ` +
          `NOTE: agy does NOT fail on an unknown --model; it silently substitutes its default, so an unlisted name here means that tool has been quietly running on the wrong model.`,
      ],
    };
  }
  if (probes.primary === 'empty')
    notes.push(
      'the primary model returned empty on the live probe (quota/transient) — the fallback carried it.'
    );
  if (probes.primary === 'unavailable')
    notes.push(
      'the primary model reported provider capacity trouble — the fallback carried it. Not an interface problem.'
    );
  if (probes.fallback === 'unavailable')
    notes.push(
      'the FALLBACK model reported provider capacity trouble. The primary answered, so the contract is intact — but the second quota pool is unavailable right now, which is the whole point of having one. Re-check before relying on it.'
    );
  if (installed !== pinned) return { action: 'bump', notes };
  if (notes.length) return { action: 'quota-warn', notes };
  return { action: 'ok', notes };
}

// Pure string transform: rewrite the AGY_PINNED constant + the doctor-managed "last verified" marker
// line in the lib source. Throws (never half-writes) if either anchor is missing or ambiguous.
export function bumpPinnedSource(source, newVersion, date) {
  const pinRe = /^export const AGY_PINNED = '[^']+';$/m;
  const markerRe = /^\/\/ agy-doctor: last verified [0-9-]+ against \S+\.$/m;
  if (!pinRe.test(source))
    throw new Error('AGY_PINNED constant line not found — lib shape changed, bump by hand.');
  if (!markerRe.test(source))
    throw new Error('agy-doctor marker line not found — lib shape changed, bump by hand.');
  return source
    .replace(pinRe, `export const AGY_PINNED = '${newVersion}';`)
    .replace(markerRe, `// agy-doctor: last verified ${date} against ${newVersion}.`);
}

// agy 1.1.11 changed `agy models` from one slug per line to tabular
// "slug<TAB>display name" rows. Compare the first field only; comparing the whole
// display row produces a false model-drift result even while both live probes pass.
export function parseAgyModelSlugs(output) {
  return (
    String(output ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !/^fetching available models/i.test(line))
      // 1.1.11 rows are tab-separated. Legacy output is one complete slug per
      // line. Never take the first whitespace word from prose: a status line
      // such as "gemini-… is unavailable" must not prove that model is listed.
      .flatMap((line) => {
        const tab = line.indexOf('\t');
        const candidate = tab === -1 ? line : line.slice(0, tab).trim();
        // A tab is the 1.1.11 row boundary, so its first field may be a simple
        // alphabetic slug. A legacy bare line has no structural marker: require
        // model-ID punctuation/digits so arbitrary prose cannot prove a listing.
        const valid =
          tab === -1
            ? /^(?=.*[0-9._:/-])[a-z0-9][a-z0-9._:/-]*$/.test(candidate)
            : /^[a-z0-9][a-z0-9._:/-]*$/.test(candidate);
        return valid ? [candidate] : [];
      })
  );
}

// ── I/O helpers (thin, injectable-free — the decision core above is what tests exercise) ─────────────
function agy(args, input) {
  return spawnSync('agy', args, { encoding: 'utf8', input: input ?? '', maxBuffer: 16 * 1024 * 1024 });
}

function observeAgy() {
  const ver = agy(['--version']);
  // Missing is a reported state, never a process.exit: `cross-agent-doctor.mjs` with no family argument
  // still owes the codex line.
  if (ver.error) return null;
  const installed = (((ver.stdout || '') + (ver.stderr || '')).match(/\d+\.\d+\.\d+/) || [null])[0];
  // agy prints --help to STDERR (confirmed live 1.0.16) — read both streams for robustness.
  const helpR = agy(['--help']);
  const help = (helpR.stdout || '') + (helpR.stderr || '');
  const helpOk = /^\s*-p\b/m.test(help) && /--model\b/.test(help);
  const modelsR = agy(['models']);
  const modelsOutput = (modelsR.stdout || '') + (modelsR.stderr || '');
  const models = modelsOutput
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const modelSlugs = parseAgyModelSlugs(modelsOutput);
  const probe = (model) => {
    const r = agy(['-p', 'Reply with exactly: OK', '--model', model]);
    // A non-zero exit is an interface break ONLY if the provider did not just say
    // it was busy. See `UPSTREAM_UNAVAILABLE` for the incident this distinction
    // comes from.
    if (r.status !== 0) {
      return isUpstreamUnavailable((r.stdout || '') + (r.stderr || '')) ? 'unavailable' : 'error';
    }
    return (r.stdout || '').trim() ? 'ok' : 'empty';
  };
  if (isAgySignedOut(modelsOutput)) {
    return {
      installed,
      pinned: AGY_PINNED,
      helpOk,
      signedOut: true,
      primaryListed: false,
      fallbackListed: false,
      unlistedModels: [],
      models: [],
      probes: { primary: 'skipped', fallback: 'skipped' },
    };
  }
  const probes = { primary: probe(AGY_MODEL), fallback: 'skipped' };
  // Probe the fallback only when needed for the decision (primary empty/error, or a version bump needs
  // the fuller picture) — each probe is a real model call.
  if (probes.primary !== 'ok' || installed !== AGY_PINNED) probes.fallback = probe(AGY_FALLBACK_MODEL);
  return {
    installed,
    pinned: AGY_PINNED,
    helpOk,
    primaryListed: modelSlugs.includes(AGY_MODEL),
    fallbackListed: modelSlugs.includes(AGY_FALLBACK_MODEL),
    // Checked cheaply against the already-fetched list — no extra model calls, so auditing every
    // configured agy model (not just the review pair) costs nothing.
    unlistedModels: AGY_MODELS_IN_USE.filter((m) => !modelSlugs.includes(m.value)),
    models,
    probes,
  };
}

async function agyMain() {
  const fix = process.argv.includes('--fix');
  const obs = observeAgy();
  if (!obs) {
    process.stdout.write(
      'agy — ✗ not installed (not on PATH). Install the Antigravity CLI, sign in, then re-run.\n'
    );
    process.exitCode = 1;
    return;
  }
  // 'skipped' → 'ok' is safe BY CONSTRUCTION, not convention: observe() skips the fallback probe only
  // when the primary probed 'ok' AND installed === pinned — and with installed === pinned the decision
  // can never reach 'bump', so a bump is never blessed on an unprobed fallback. (If observe()'s skip
  // condition ever changes, revisit this substitution.)
  const decision = decideDoctorAction({
    ...obs,
    probes: {
      primary: obs.probes.primary,
      fallback: obs.probes.fallback === 'skipped' ? 'ok' : obs.probes.fallback,
    },
  });

  const line = (s) => process.stdout.write(`${s}\n`);
  line(
    `agy-doctor — installed ${obs.installed} · pinned ${obs.pinned} · help contract ${obs.helpOk ? 'ok' : 'BROKEN'}`
  );
  // Every configured name, not just the review pair — a silently-substituted model is visible at a glance.
  // Signed out, nothing was listed or probed, so printing the names as "listed" would be a false pass.
  if (!obs.signedOut) {
    for (const m of AGY_MODELS_IN_USE) {
      const listed = !obs.unlistedModels.some((u) => u.constant === m.constant);
      line(`  ${listed ? '·' : '✗'} ${m.constant} = "${m.value}"${listed ? '' : '  ← NOT LISTED'}`);
    }
    line(`live probe: primary ${obs.probes.primary} · fallback ${obs.probes.fallback}`);
  }
  for (const n of decision.notes) line(`  note: ${n}`);

  switch (decision.action) {
    case 'signed-out':
      line(
        '✗ could not look: agy is signed out. Run `agy` once with no arguments to sign in, then re-run this doctor.'
      );
      process.exitCode = 1;
      return;
    case 'ok':
      line('✓ no drift — pin, models, and print contract all verified live.');
      return;
    case 'quota-warn':
      line(
        '✓ no drift (transient primary-model quota noted above — runAntigravity degrades to the fallback on its own).'
      );
      return;
    case 'model-drift':
      line(`✗ model drift. Current \`agy models\`:\n  ${obs.models.join('\n  ')}`);
      line(
        'Pick a replacement: set AGY_MODEL / AGY_FALLBACK_MODEL env, or edit the constants in scripts/lib/cross-agent-cli.mjs. Not auto-fixed (judgment call).'
      );
      process.exitCode = 1;
      return;
    case 'contract-broken':
      line(
        '✗ contract broken — do NOT bump the pin. Re-verify `agy -p "<prompt>" --model "<model>"` by hand against `agy --help`.'
      );
      process.exitCode = 1;
      return;
    case 'bump': {
      // --fix runs `node --test '<glob>'`, whose glob expansion Node added in 21; below that the pattern matches
      // nothing and a pin would be bumped with no tests run. Refuse rather than bless blind (cross-review, #188).
      if (fix && Number(process.versions.node.split('.')[0]) < 21) {
        line(
          `✗ --fix needs Node 21+ (this is ${process.versions.node}): it runs the test suite after bumping. Not bumped.`
        );
        process.exitCode = 1;
        return;
      }
      if (!fix) {
        line(
          `→ version drift with a GREEN contract probe: safe to bump. Run \`node scripts/cross-agent-doctor.mjs agy --fix\` to update AGY_PINNED ${obs.pinned} → ${obs.installed}.`
        );
        return;
      }
      const src = readFileSync(LIB_PATH, 'utf8');
      const today = new Date().toISOString().slice(0, 10);
      writeFileSync(LIB_PATH, bumpPinnedSource(src, obs.installed, today));
      line(`✓ AGY_PINNED bumped ${obs.pinned} → ${obs.installed} (probe green; marker dated ${today}).`);
      const t = spawnSync(process.execPath, ['--test', 'scripts/lib/*.test.mjs', 'scripts/*.test.mjs'], {
        encoding: 'utf8',
        cwd: resolve(__dirname, '..'),
        shell: false,
      });
      if (t.status !== 0) {
        line('✗ test suite FAILED after the bump — review before committing:');
        process.stdout.write(
          (t.stdout || '')
            .split('\n')
            .filter((l) => /not ok|fail/i.test(l))
            .slice(0, 10)
            .join('\n') + '\n'
        );
        process.exitCode = 1;
        return;
      }
      line('✓ scripts test suite green. Next: commit the one-line bump (LOW tier) via the normal flow —');
      line(
        '  branch `chore/agy-pin-bump-' +
          obs.installed +
          '`, path-limited commit of scripts/lib/cross-agent-cli.mjs, PR.'
      );
      return;
    }
  }
}

// ── The dispatcher ───────────────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const families = argv.filter((a) => !a.startsWith('-'));
  const want = families.length ? families : ['codex', 'agy'];
  for (const f of want) {
    if (!['codex', 'agy'].includes(f)) {
      process.stderr.write(`unknown family '${f}' — expected codex | agy\n`);
      process.exitCode = 1;
      return;
    }
  }
  for (const f of want) {
    if (f !== want[0]) process.stdout.write('\n');
    if (f === 'codex') await codexMain();
    else await agyMain();
  }
}

// realpath on both sides: through a symlinked path a plain compare is false and the doctor would exit 0
// having checked nothing (#189 review).
const isMain = (() => {
  try {
    return (
      !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (isMain) await main();
