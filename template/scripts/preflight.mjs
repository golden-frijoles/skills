#!/usr/bin/env node
// preflight.mjs — "this project uses Golden Frijoles for flags" is a CHECK, not a sentence.
//
// ── Why this exists ────────────────────────────────────────────────────────────────────────────
// Every `risk: high` epic in this operating system has to answer the kill-switch question, and the
// answer names a flag mechanism. For a project spawned from this template that mechanism is Golden
// Frijoles — one flag provider, no parallel flag store (see AGENTS.md's rules). A mandate written
// only in prose is a hope: the first project to skip it does so silently, and nothing anywhere goes
// red. This script is the mandate as a property of the system.
//
// It follows `permissions-smoke.mjs`'s shape on purpose — a reviewable file that ASSERTS, rather
// than a paragraph that claims.
//
// ── D1: fail LOUD at init, fail SOFT at runtime. Read this before changing a status ────────────
// This is the single most important line in the epic that produced this file, and getting it
// backwards breaks every consuming project's CI.
//
//   • ABSENT CONFIGURATION is a hard failure (exit 1). No `.env.local`, no URL, no `flag_read` key,
//     no CLI, an out-of-date CLI — every one of these is a thing a person has not done yet, it is
//     true until someone acts, and re-running changes nothing. Saying so loudly is the whole job.
//
//   • A REJECTED CREDENTIAL is a hard failure too (exit 1). A 401 is not an outage: the key is
//     revoked, expired or for another project, and the remedy is another `frijoles init`.
//
//   • AN UNREACHABLE DEPLOYMENT IS A WARNING (exit 0). A transient outage, a captive-portal proxy,
//     a 404 from a deployment with flag serving switched off, an offline laptop on a plane — none
//     of them mean the project is misconfigured, and none of them may break a build, a test run or
//     a deploy. The SDK is built for exactly this: `createFlagProvider` resolves SYNCHRONOUSLY
//     against a caller-supplied default, so an unreachable Golden degrades to compile-time defaults
//     and the app keeps serving. A preflight that went red here would hand every consuming project
//     a dependency that can fail their pipeline when someone else's deployment hiccups — which is a
//     dependency nobody should accept, mandate or not.
//
// **There is deliberately no `--strict`.** A flag that turns the warning into a failure would be
// pasted into a CI file within the week, and the promise above would be gone with nobody deciding
// to give it up. If you want the probe skipped, `--offline` skips it; if you want an outage to page
// someone, that belongs in monitoring, not in a preflight.
//
// ── Where this runs: at init and at session start, NOT as a CI gate ───────────────────────────
// `.env.local` is gitignored — deliberately, it holds a live credential — so a CI checkout does not
// have one and this check would fail there for a reason that is not a defect. Run it on a fresh
// spawn, at session start, and after `frijoles init`. If you DO want it in CI, inject the same variables
// from CI secrets (the reader below falls back to the process environment for exactly that) and
// pass `--offline` if your runner has no egress.
//
// ── What it does NOT prove ─────────────────────────────────────────────────────────────────────
// That any particular flag exists, or that it is ACTIVATED. Definitions are catalog-as-code and
// activations are not (D4) — `frijoles flags get <key>` is the verb that answers that, per flag and per
// environment, and a kill-switch story names it as its own step. `—` in its SERVING column means
// never activated here.
//
// ── Usage ──────────────────────────────────────────────────────────────────────────────────────
//   node scripts/preflight.mjs              # the full check, including the live snapshot probe
//   node scripts/preflight.mjs --offline    # skip the probe (deterministic; for CI and for planes)
//   node scripts/preflight.mjs --json       # the same result as data
//
// Zero deps — Node 18+.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLI_BIN,
  LEGACY_CLI_BIN,
  CLI_NPX_INIT,
  CLI_GLOBAL_INSTALL,
  DEFAULT_API_URL,
  ENV_FILE,
  ENV_KEYS,
  MIN_CLI_VERSION,
  SDK_PACKAGE,
  SNAPSHOT_PATH,
  compareVersions,
  onboardingLines,
  readEnvValue,
} from './lib/golden-onboarding.mjs';
import { projectRoot } from './lib/project-root.mjs';

const REPO = projectRoot(); // D2

const PROBE_TIMEOUT_MS = 5_000;

/** `ok` passes, `fail` exits 1, `warn` is reported and passes, `skipped` could not run. */
const ORDER = ['cli', 'cli-version', 'sdk', 'project', 'flag-read-key', 'snapshot'];

/**
 * The whole decision, as a pure function of what was found.
 *
 * Every impure act — spawning `frijoles`, reading `.env.local`, the HTTP probe — happens in `main()` and
 * arrives here as data, so all six states the sprint names (no project · no key · CLI absent · CLI
 * outdated · all good · unreachable) are unit-testable without a network, a CLI or a filesystem.
 *
 * @param {object} input
 * @param {{ found: boolean, version: string|null, source: string|null }} input.cli
 * @param {{ found: boolean, source: string|null }} input.sdk
 * @param {{ exists: boolean, path: string, url: string|null, key: string|null, environment: string|null }} input.env
 * @param {{ state: 'live'|'dead'|'wrong-environment'|'unreachable'|'skipped', detail: string, environment?: string|null }} input.probe
 */
export function evaluatePreflight({ cli, sdk = { found: false, source: null }, env, probe }) {
  const checks = [];

  // ── 1. is the CLI there at all ────────────────────────────────────────────────────────────
  if (!cli.found) {
    checks.push({
      id: 'cli',
      status: 'fail',
      detail: `\`${CLI_BIN}\` is not on PATH and not in node_modules/.bin. ${CLI_GLOBAL_INSTALL} — or use \`npx\`, which needs no install.`,
    });
  } else {
    checks.push({ id: 'cli', status: 'ok', detail: `Found at ${cli.source}.` });
  }

  // ── 2. and is it new enough to complete a kill-switch story ───────────────────────────────
  if (!cli.found) {
    checks.push({ id: 'cli-version', status: 'skipped', detail: 'No CLI to version-check.' });
  } else {
    const cmp = compareVersions(cli.version, MIN_CLI_VERSION);
    if (cmp === null) {
      // "We could not tell" is a third answer. Refusing to run on an unreadable version string
      // would fail projects using a fork or a local build for no safety gain.
      checks.push({
        id: 'cli-version',
        status: 'warn',
        detail: `Could not read a version from \`${CLI_BIN} --version\` (${cli.version ?? 'no output'}). Wanted >= ${MIN_CLI_VERSION}.`,
      });
    } else if (cmp < 0) {
      checks.push({
        id: 'cli-version',
        status: 'fail',
        detail: `${CLI_BIN} ${cli.version} is older than ${MIN_CLI_VERSION}, which is the version that can create a flag in every environment. ${CLI_GLOBAL_INSTALL}@latest.`,
      });
    } else {
      checks.push({ id: 'cli-version', status: 'ok', detail: `${cli.version} (>= ${MIN_CLI_VERSION}).` });
    }
  }

  // ── 3. can the APP actually read a flag — is the SDK installed ────────────────────────────
  // ⚠️ **Added after review.** The CLI and the SDK are different halves: `frijoles` creates and kills
  // flags, the SDK reads them. Without this check a project reached FIVE GREEN CHECKS, including a
  // live snapshot, while every flag resolved to its call-site default forever — because nothing had
  // ever installed `@golden-frijoles/sdk`. The seam imports it dynamically (deliberately: that is
  // what lets it load in a checkout with no node_modules), so its absence is one log line rather
  // than a crash, which is exactly why a check has to say it out loud.
  //
  // A WARNING, not a failure, and that is D1 applied consistently: "you have not run `npm install`
  // yet" is the ordinary state of a fresh clone, and this check must not fail a spawn's first
  // minute. But it is counted, and the summary line below refuses to say a plain PASS while it
  // stands.
  if (sdk.found) {
    checks.push({ id: 'sdk', status: 'ok', detail: `${SDK_PACKAGE} resolves from ${sdk.source}.` });
  } else {
    checks.push({
      id: 'sdk',
      status: 'warn',
      detail: `${SDK_PACKAGE} is not installed — the flag seam will load, and EVERY flag will resolve to its call-site default. \`npm install ${SDK_PACKAGE}\` in the app that reads flags.`,
    });
  }

  // ── 4. is a project linked ────────────────────────────────────────────────────────────────
  if (!env.exists) {
    checks.push({
      id: 'project',
      status: 'fail',
      detail: `No ${ENV_FILE} at ${env.path}. Nothing links this repository to a Golden Frijoles project.`,
    });
  } else if (!env.url) {
    checks.push({
      id: 'project',
      status: 'fail',
      detail: `${ENV_FILE} exists but carries no ${ENV_KEYS.url}. It was not written by \`${CLI_BIN} init\`.`,
    });
  } else if (!env.environment) {
    // ⚠️ **Added after review.** Without this the CI-secrets path (URL and key injected, environment
    // not) reported a clean ✅ while the app had nothing to assert against: the probe's
    // mismatch check is skipped when there is no configured environment to compare a snapshot to,
    // so a production key paired with an unstated environment passed silently. The seam no longer
    // invents `development` in that case — it lets the first snapshot establish the environment —
    // but "nobody said which environment this is" is still a configuration gap worth naming.
    checks.push({
      id: 'project',
      status: 'warn',
      detail: `${ENV_KEYS.url}=${env.url}, but ${ENV_KEYS.environment} is unset — nothing asserts WHICH environment this project reads, so a mismatch cannot be detected. \`${CLI_BIN} init --env <environment>\` writes it.`,
    });
  } else {
    checks.push({
      id: 'project',
      status: 'ok',
      detail: `${ENV_KEYS.url}=${env.url} (${ENV_KEYS.environment}=${env.environment}).`,
    });
  }

  // ── 5. is there a read credential ─────────────────────────────────────────────────────────
  if (!env.exists) {
    checks.push({ id: 'flag-read-key', status: 'skipped', detail: `No ${ENV_FILE} to read a key from.` });
  } else if (!env.key) {
    checks.push({
      id: 'flag-read-key',
      status: 'fail',
      // Named, never printed. This file's output is the thing people paste into an issue.
      detail: `${ENV_FILE} carries no ${ENV_KEYS.flagRead}. Flags cannot be read without one.`,
    });
  } else {
    checks.push({
      id: 'flag-read-key',
      status: 'ok',
      detail: `${ENV_KEYS.flagRead} present (value never printed).`,
    });
  }

  // ── 6. does the credential actually resolve a snapshot — the only check that can lie ──────
  // D1 lives here. `dead` and `wrong-environment` are configuration; `unreachable` is weather.
  const probeStatus = {
    live: 'ok',
    dead: 'fail',
    'wrong-environment': 'fail',
    unreachable: 'warn',
    skipped: 'skipped',
  }[probe.state];
  checks.push({ id: 'snapshot', status: probeStatus ?? 'warn', detail: probe.detail });

  const failed = checks.filter((c) => c.status === 'fail');
  const warned = checks.filter((c) => c.status === 'warn');
  return {
    ok: failed.length === 0,
    warnings: warned.length,
    exitCode: failed.length === 0 ? 0 : 1,
    // The remedy is printed whenever the project is not wired — which is exactly the set of
    // failures `frijoles init` fixes. A stale CLI is not one of them, so it does not drag the install
    // block in behind it.
    showOnboarding: failed.some((c) => c.id === 'project' || c.id === 'flag-read-key' || c.id === 'snapshot'),
    checks,
  };
}

/** Is `frijoles` runnable, and what does it say its version is? */
export function findCli({ cwd = REPO, spawn = spawnSync } = {}) {
  const candidates = [
    { source: `${CLI_BIN} (PATH)`, command: CLI_BIN },
    { source: `node_modules/.bin/${CLI_BIN}`, command: join(cwd, 'node_modules', '.bin', CLI_BIN) },
    // An install from before 1.0 has only the old name. Found, but said, so the version check can ask for an upgrade.
    { source: `${LEGACY_CLI_BIN} (PATH, the old name)`, command: LEGACY_CLI_BIN },
    { source: `node_modules/.bin/${LEGACY_CLI_BIN} (the old name)`, command: join(cwd, 'node_modules', '.bin', LEGACY_CLI_BIN) },
  ];
  for (const candidate of candidates) {
    const result = spawn(candidate.command, ['--version'], { encoding: 'utf8', timeout: 20_000 });
    if (result.error || result.status !== 0) continue;
    return { found: true, version: String(result.stdout ?? '').trim() || null, source: candidate.source };
  }
  return { found: false, version: null, source: null };
}

/**
 * Is `@golden-frijoles/sdk` resolvable from anywhere this repo's apps would import it?
 *
 * Node resolution walks UP from the importer, so an SDK in the repo root's `node_modules` serves
 * every app; one installed only inside `apps/<name>/node_modules` serves that app. Both are normal,
 * so both are looked at, and the answer names WHERE it was found rather than just that it was.
 */
export function findSdk({ cwd = REPO } = {}) {
  const bases = [join(cwd, 'package.json')];
  try {
    for (const name of readdirSync(join(cwd, 'apps'))) {
      const manifest = join(cwd, 'apps', name, 'package.json');
      if (existsSync(manifest)) bases.push(manifest);
    }
  } catch {
    /* no apps/ directory — a single-app project resolves from the root */
  }
  for (const base of bases) {
    try {
      createRequire(base).resolve(SDK_PACKAGE);
      return { found: true, source: relativeish(cwd, base) };
    } catch {
      /* not resolvable from this base; try the next */
    }
  }
  return { found: false, source: null };
}

function relativeish(root, manifest) {
  return manifest.startsWith(root) ? manifest.slice(root.length + 1) || manifest : manifest;
}

/**
 * Read `.env.local`, falling back to the process environment for anything it does not carry.
 *
 * The file first, because that is what the running app reads on a developer's machine — reporting
 * on a shell variable the app will never see would make this check lie in the most confusing
 * direction. The process environment second, because a CI runner has no `.env.local` and injects
 * the same three names from secrets; `exists` then reports the ENVIRONMENT as the source rather
 * than pretending a file was found.
 *
 * See `readEnvValue` for why the LAST assignment in the file wins.
 */
export function readEnvFile(path, processEnv = process.env) {
  const fromEnv = {
    url: processEnv[ENV_KEYS.url]?.trim() || null,
    key: processEnv[ENV_KEYS.flagRead]?.trim() || null,
    environment: processEnv[ENV_KEYS.environment]?.trim() || null,
  };
  const hasEnv = Boolean(fromEnv.url || fromEnv.key);

  let contents = null;
  if (existsSync(path)) {
    try {
      contents = readFileSync(path, 'utf8');
    } catch {
      // Unreadable is not "absent": it reads as an empty file, and the checks below then fail on
      // the missing URL and key with the remedy attached.
      contents = '';
    }
  }
  if (contents === null) {
    return { exists: hasEnv, path: hasEnv ? 'the process environment' : path, ...fromEnv };
  }
  return {
    exists: true,
    path,
    url: readEnvValue(contents, ENV_KEYS.url) ?? fromEnv.url,
    key: readEnvValue(contents, ENV_KEYS.flagRead) ?? fromEnv.key,
    environment: readEnvValue(contents, ENV_KEYS.environment) ?? fromEnv.environment,
  };
}

/**
 * Exercise the `flag_read` key against the route that actually serves it.
 *
 * Four answers, and the fourth is the one D1 turns on:
 *   live               — a snapshot came back, for the environment this project says it is.
 *   dead               — 401. Unknown, revoked, expired. Configuration: re-run `frijoles init`.
 *   wrong-environment  — it resolves, for a DIFFERENT environment. A `flag_read` key is scoped to
 *                        one, so this is a production config holding a development credential with
 *                        nothing anywhere saying so — the worst shape a flag bug has.
 *   unreachable        — anything else: a network failure, a timeout, a 404 from a deployment with
 *                        flag serving switched off, a proxy's HTML. Reported, never guessed at,
 *                        and never a failure.
 */
export async function probeSnapshot({ url, key, environment, fetchImpl = globalThis.fetch }) {
  const base = (url || DEFAULT_API_URL).replace(/\/+$/, '');
  const endpoint = `${base}/${SNAPSHOT_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(endpoint, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 401) {
      return {
        state: 'dead',
        detail: `${endpoint} rejected the ${ENV_KEYS.flagRead} (401). It is revoked, expired, or for another project.`,
      };
    }
    if (!response.ok) {
      return {
        state: 'unreachable',
        detail: `${endpoint} answered ${response.status}. Could not verify the key — NOT treated as a failure (D1).`,
      };
    }
    const body = await response.json();
    // ⚠️ **`contractVersion` is checked before anything in the body is believed** (added after
    // review). Any 200 carrying parseable JSON with an `environment` string — a captive portal, a
    // proxy's error document, a different service on the same host — would otherwise land as
    // `wrong-environment`, which FAILS. That is the one shape of weather that could still break a
    // build, which is the one thing D1 forbids. An unrecognised body is `unreachable`.
    if (body?.contractVersion !== 1) {
      return {
        state: 'unreachable',
        detail: `${endpoint} answered 200 but not with a flag snapshot (contractVersion ${JSON.stringify(body?.contractVersion)}). Could not verify the key — NOT treated as a failure (D1).`,
      };
    }
    const served = typeof body?.environment === 'string' ? body.environment : null;
    if (environment && served && served !== environment) {
      return {
        state: 'wrong-environment',
        detail: `The key resolves ${served}, but ${ENV_KEYS.environment} says ${environment}. Re-run \`${CLI_BIN} init --env ${environment}\`.`,
        environment: served,
      };
    }
    return {
      state: 'live',
      detail: `Resolved snapshot v${body?.snapshotVersion ?? '?'} for ${served ?? 'an unnamed environment'} (${Array.isArray(body?.flags) ? body.flags.length : '?'} flags).`,
      environment: served,
    };
  } catch (err) {
    const why =
      err?.name === 'AbortError' ? `no answer in ${PROBE_TIMEOUT_MS}ms` : (err?.message ?? String(err));
    return {
      state: 'unreachable',
      detail: `Could not reach ${endpoint} (${why}). NOT a failure — the SDK resolves against your compile-time defaults (D1).`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The human rendering. The JSON mode emits the same object, so neither can drift from the other. */
export function render(result) {
  const mark = { ok: '✅', fail: '❌', warn: '⚠️ ', skipped: '➖' };
  const lines = ['', 'Golden Frijoles preflight', '========================='];
  for (const id of ORDER) {
    const check = result.checks.find((c) => c.id === id);
    if (!check) continue;
    lines.push(`${mark[check.status] ?? '  '} ${check.id.padEnd(14)} ${check.detail}`);
  }
  lines.push('');
  if (result.showOnboarding) lines.push(...onboardingLines(), '');
  // A plain "PASS" over a warning is how the SDK-not-installed case stayed invisible: five ticks, a
  // live snapshot, and no flag ever resolving. The count rides in the summary line.
  lines.push(
    result.ok
      ? result.warnings
        ? `preflight: PASS with ${result.warnings} warning(s) — read them; a ⚠️ here is something that will not fail your build and may still mean no flag ever resolves.`
        : 'preflight: PASS — this project can create and read a Golden Frijoles kill-switch.'
      : `preflight: FAIL — ${result.checks.filter((c) => c.status === 'fail').length} check(s). ${CLI_NPX_INIT}`
  );
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const offline = argv.includes('--offline');
  const asJson = argv.includes('--json');

  const cli = findCli();
  const sdk = findSdk();
  const env = readEnvFile(join(REPO, ENV_FILE));

  let probe = { state: 'skipped', detail: 'Not probed.' };
  if (offline) {
    probe = { state: 'skipped', detail: '--offline: the live snapshot probe was not run.' };
  } else if (!env.key) {
    probe = { state: 'skipped', detail: `No ${ENV_KEYS.flagRead} to exercise.` };
  } else {
    probe = await probeSnapshot({ url: env.url, key: env.key, environment: env.environment });
  }

  const result = evaluatePreflight({ cli, sdk, env, probe });
  console.log(asJson ? JSON.stringify(result, null, 2) : render(result));
  return result.exitCode;
}

// `process.argv[1]` rather than an import.meta.url comparison: this file is also imported by its
// test, which must not run main().
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(await main());
}
