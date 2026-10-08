#!/usr/bin/env node
// check-onboarding-parity.mjs — the Golden Frijoles onboarding text is ONE surface, checked.
//
// ── Why this exists ────────────────────────────────────────────────────────────────────────────
// golden-flags-by-default S1.4's acceptance: the text the agent prints, the install page's CLI
// block and `frijoles init`'s own next-step line must say the same thing. The commands live once, in
// `template/scripts/lib/golden-onboarding.mjs`, and `scripts/preflight.mjs` prints them from there
// — but a README is prose, and prose drifts silently. Three copies of
// `npx @golden-frijoles/cli init` agree right up until one of them is edited, and the one that
// drifts is always the one nobody runs.
//
// So: every shipped surface that tells someone how to wire the flag provider must contain the
// EXACT strings the module defines. A reworded command fails here.
//
// ── `--exec`: presence is not execution, and that distinction cost a real defect ───────────────
// The first version of this file only checked that strings were PRESENT, and the string it was
// welding into five surfaces was `frijoles flags ls --env production` — a command that does not exist.
// `frijoles flags ls` accepts only `--project`, so it exits 1 with a usage error before it ever reaches
// auth. Every surface agreed with every other surface, perfectly, about something untrue.
//
// `--exec` closes that: it RUNS each command the surfaces tell a reader to run and asserts the CLI
// parsed it. `unauthorized` (exit 2) is a PASS — the parser accepted the command and the dispatcher
// then asked for a credential, which is exactly as far as a check like this should get. `invalid`
// (exit 1) is the failure: that is the CLI saying the command does not exist.
//
// It SKIPS, loudly, when no `frijoles` is resolvable — "could not look" is its own outcome and never the
// failure one (LEARNINGS), because a check that goes red when npm is having a bad day is the same
// mistake `preflight.mjs` refuses to make. The skip prints a `::warning::` so a skipped run cannot
// read as a green one on the surface people actually look at.
//
// ⚠️ **AND IT RUNS UNAUTHENTICATED, DELIBERATELY AND BY CONSTRUCTION. Read this before touching
// `probeCommand`.** Two of the three advertised commands are WRITE verbs:
// `frijoles flags create … --all-envs` creates a definition **and activates it in production**, and
// `frijoles flags kill … --env production` kills it there. The first version of this mode spawned the CLI
// with no `env` option, so the child inherited `process.env` and `$HOME` — and the CLI resolves a
// credential from `GOLDEN_FRIJOLES_TOKEN` or from `~/.config/golden-frijoles/credentials.json`.
// On any machine that had run `frijoles login` — including, precisely, the one this epic still owes a
// live `frijoles init` on — a documentation parity check would have written to the product owner's real
// flag catalog. Caught in re-review before it ever ran that way.
//
// So the child gets a scrubbed environment (blank token, `XDG_CONFIG_HOME` and `HOME` pointed at an
// empty temp dir), **and `unauthorized` is now REQUIRED rather than merely accepted**. If the
// isolation ever fails, the probe comes back `ok` — and that FAILS, loudly, instead of passing as
// "well, it parsed". The safe state is asserted, not assumed.
//
// ── The half this cannot check, stated rather than implied ─────────────────────────────────────
// Two of the surfaces are in the Golden Frijoles product repo — its `/install` page
// (`apps/web/lib/cli-install.ts`) and `frijoles init`'s printed next-steps
// (`packages/cli/src/commands/init.ts`). A template cannot import a product's web app to read a
// string, so those are transcribed into the module with their origin named, and re-checked by hand
// at each CLI release. What is NOT left to prose: `preflight.mjs` exercises the real deployment
// with the real variable names, so a rename in the CLI surfaces as a failing preflight rather than
// as a stale sentence.
//
// This script is dobby-foundation's own tooling and does NOT ship to consuming projects — it
// asserts things about this repo's README files, which a spawned project does not have.
//
// Usage: node scripts/check-onboarding-parity.mjs
//
// Zero deps — Node 18+.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLI_BIN,
  CLI_GLOBAL_INSTALL,
  CLI_NPX_INIT,
  INSTALL_PROMPT,
  CLI_NPX_LOGIN,
  compareVersions,
  ENV_KEYS,
  KILL_SWITCH_STORY,
} from '../template/scripts/lib/golden-onboarding.mjs';
import { listSkills } from './check-skill-scripts.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Each surface, and the strings it must carry verbatim.
 *
 * Deliberately not "every surface must carry everything": a README section aimed at someone
 * spawning a project needs the two commands, while the skill reference that plans a kill-switch
 * story needs the creation verb and the activation check. Requiring the union would force noise
 * into each file, and noise is how a doc stops being read.
 */
export const SURFACES = [
  {
    file: 'README.md',
    why: 'the front door: how a consumer wires the provider after installing the plugin, and the install prompt itself',
    must: [
      CLI_NPX_LOGIN,
      CLI_NPX_INIT,
      CLI_GLOBAL_INSTALL,
      'node scripts/preflight.mjs',
      ...KILL_SWITCH_STORY,
      INSTALL_PROMPT,
    ],
  },
  {
    file: 'plugins/golden-frijoles/skills/golden-frijoles/SKILL.md',
    why: 'the umbrella skill: the first thing a stranger’s agent reads must carry the same install prompt it just ran',
    must: [INSTALL_PROMPT],
  },
  {
    file: 'template/README.md',
    why: 'the spawn checklist: the step that links a fresh project to a Golden Frijoles project',
    must: [CLI_NPX_LOGIN, CLI_NPX_INIT, CLI_GLOBAL_INSTALL, 'node scripts/preflight.mjs'],
  },
  {
    file: 'template/AGENTS.md',
    why: 'the cannot-be-violated rule an agent reads at session start',
    must: [
      'Feature flags are Golden Frijoles. Never build a parallel flag store.',
      'node scripts/preflight.mjs',
      ENV_KEYS.url,
      ENV_KEYS.flagRead,
      ENV_KEYS.environment,
      `${CLI_BIN} flags create`,
      'NOT ENFORCED',
    ],
  },
  {
    file: 'plugins/golden-frijoles/skills/groom/references/kill-switch.md',
    why: 'Stage 6b: the mechanism a kill-switch story is planned against',
    must: [
      `${CLI_BIN} flags create <domain>.<feature>_enabled --kill-switch --all-envs`,
      `${CLI_BIN} flags get <domain>.<feature>_enabled`,
      'node scripts/preflight.mjs',
    ],
  },
  {
    file: 'template/references/flags-runtime.md',
    why: 'the runtime rules: fail-soft, Edge placement, credential placement',
    must: [ENV_KEYS.flagRead, 'flag_sync', 'CI secrets'],
  },
];

/**
 * Run one command the surfaces advertise and decide whether the CLI PARSED it.
 *
 * `<domain>.<feature>_enabled` is a placeholder in the docs; the CLI validates flag keys, so the
 * probe substitutes a syntactically valid one. What is being checked is the command's SHAPE — verb
 * path and flags — not that a particular flag exists.
 */
function probeCommand(cliPath, command, scrubbedEnv) {
  const argv = command
    .replace(/\s+#.*$/, '')
    .replace(/<domain>\.<feature>_enabled/g, 'preflight.parity_probe')
    .trim()
    .split(/\s+/)
    .slice(1); // drop the `frijoles`
  const run = spawnSync(cliPath, [...argv, '--json'], {
    encoding: 'utf8',
    timeout: 30_000,
    // The whole safety property of this mode, in one option. See the header.
    env: scrubbedEnv,
  });
  if (run.error) return { ok: false, why: `could not run: ${run.error.message}` };
  let body = {};
  try {
    body = JSON.parse(run.stdout || '{}');
  } catch {
    return { ok: false, why: `unparseable --json output: ${(run.stdout || '').slice(0, 120)}` };
  }
  // `invalid` is the CLI saying "this command does not exist" — the defect this mode exists for.
  if (body.code === 'invalid') return { ok: false, why: body.error ?? 'usage error' };
  // Anything OTHER than `unauthorized` means the credential scrub did not hold, and two of these
  // three commands WRITE. Refuse rather than report a pass.
  if (body.code !== 'unauthorized') {
    return {
      ok: false,
      why:
        `expected \`unauthorized\` and got \`${body.code ?? 'ok'}\` — the credential isolation FAILED, ` +
        'and this command may have written to a real flag catalog. Do not re-run until the env scrub ' +
        'in probeCommand() is fixed.',
    };
  }
  return { ok: true, why: 'unauthorized (parsed, then refused for want of a credential)' };
}

const CLAUDE_BIN = 'claude';

/**
 * Same vocabulary as the kit's own run rule (render-skill-adverts.mjs's kit block): the signs of a
 * network/registry problem rather than a real defect. Used to decide SKIP vs FAIL for the install-
 * prompt probes below — they hit the real network (npm's registry, GitHub), so "could not look" has
 * to be a real, checked outcome here, not just for a missing binary (LEARNINGS: "could not look is
 * its own exit code, never the failure one").
 */
function looksLikeNetworkTrouble(text) {
  return /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|E404|proxy|network error|could not resolve/i.test(
    text || ''
  );
}

/** sha256 of a file, or the literal 'absent' when it doesn't exist — the negative control's baseline. */
function fingerprint(path) {
  if (!existsSync(path)) return 'absent';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// eslint-disable-next-line no-control-regex -- the ANSI CSI escape itself is what's being stripped.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Strip ANSI colour/cursor escapes from a captured CLI transcript.
 *
 * ⚠️ **CI red, found live.** Outside an interactive TTY `skills@1.7.0` still colours skill names
 * (`isatty()` is true enough for it under a pty, but the real trigger is simpler: it checks for an
 * "agent" session and colours regardless) — a listed entry actually reads
 * `│    \x1b[36mgolden-frijoles\x1b[39m`, not the plain `│    golden-frijoles` the exact-entry regex
 * expected. `NO_COLOR=1`/`FORCE_COLOR=0` in the child's env (below) is the honest fix — asking the
 * tool not to colour in the first place — and this strip is the belt to that braces, for whatever
 * a future version decides `NO_COLOR` doesn't cover.
 */
function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '');
}

/**
 * The three install-prompt `--exec` probes (S3.4, D8): does `npx skills` actually list
 * `golden-frijoles`, and does the two-command Claude Code install actually install it — in an
 * ISOLATED config, proven isolated by a negative control against the real one.
 *
 * ⚠️ Same discipline as `probeCommand` above: `claude plugin marketplace add` / `plugin install` are
 * WRITE verbs against local config state, so they run with `HOME`, `XDG_CONFIG_HOME` and
 * `CLAUDE_CONFIG_DIR` all pointed at one empty temp dir (D8's addition to the onboarding-parity
 * shape), and the negative control — the REAL `~/.claude/plugins/installed_plugins.json`'s hash
 * unchanged — is asserted, not assumed, exactly as `check-onboarding-parity.mjs`'s original `frijoles`
 * probe asserts `unauthorized` rather than merely accepting it.
 *
 * Each binary that cannot be resolved, and each command whose output looks like a network/registry
 * problem, SKIPS with a `::warning::` — never fails for that. A real "not listed yet" (the live repo
 * pre-merge, still under the old marketplace name) is NOT a skip: it is reported as a failure, because
 * that is exactly the state the contract says this check must be honest about, not paper over.
 */
function installPromptExecChecks() {
  let failed = false;
  // WHICH tree the prompt's commands run against. By default, THIS checkout: that is the tree the PR ships, so the
  // gate can go green before merge (checking the live repo made a PR that adds the umbrella skill un-mergeable
  // under a required check: it could only pass once it had already merged). `--live` runs them against the
  // published repo, which is the post-merge verification recorded in the sprint walkthrough.
  const live = process.argv.includes('--live');
  const source = live ? 'golden-frijoles/skills' : repoRoot;
  const label = live ? 'golden-frijoles/skills' : '<this checkout>';

  // ── 1. `npx skills add golden-frijoles/skills --list` lists `golden-frijoles` ─────────────────
  const npxProbe = spawnSync('npx', ['--version'], { encoding: 'utf8', timeout: 20_000 });
  if (npxProbe.error) {
    console.log('::warning::check-onboarding-parity --exec: `npx skills --list` SKIPPED — no `npx` resolvable.');
  } else {
    const list = spawnSync('npx', ['-y', 'skills@1.7.0', 'add', source, '--list'], {
      encoding: 'utf8',
      timeout: 90_000,
      // Outside an agent session skills@1.7.0 colours skill names (`\x1b[36mgolden-frijoles\x1b[39m`),
      // which a plain-text regex never matches. Ask it not to, in both vocabularies (LEARNINGS: "a
      // young foreign CLI's interface shape isn't what you'd assume" — this one reads NO_COLOR).
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    const output = stripAnsi(`${list.stdout || ''}${list.stderr || ''}`);
    // Strip the repo argument ("golden-frijoles/skills", echoed in the CLI's own "Source: …" banner)
    // before testing — a naive substring match on `output` was caught passing on THAT echo alone,
    // with zero skills actually listed under the name. Presence of the repo name is not presence of
    // the skill (LEARNINGS: presence is not execution) — only a SEPARATE "golden-frijoles" token,
    // the skill's own list entry, counts.
    const withoutRepoArg = output.split(source).join('').replace(/golden-frijoles\/skills/g, '');
    if (list.error || (list.status !== 0 && looksLikeNetworkTrouble(output))) {
      console.log(
        `::warning::check-onboarding-parity --exec: \`npx skills --list\` SKIPPED — could not look: ` +
          `${(list.error?.message ?? output).slice(0, 200)}`
      );
    } else if (!/^[│|\s]*golden-frijoles\s*$/m.test(withoutRepoArg)) {
      // A whole list ENTRY, not a token: `\b` treats a hyphen as a boundary, so `golden-frijoles-renamed`, a path
      // or a description passed the looser test (caught by mutation in review, the builder's own class of bug).
      console.error(
        `  ❌ npx skills add ${label} --list  →  "golden-frijoles" is not in the listed skills:\n` +
          `     ${output.trim().split('\n').slice(0, 8).join('\n     ')}`
      );
      failed = true;
    } else {
      console.log(`  ✅ npx skills add ${label} --list  →  golden-frijoles listed`);
    }
  }

  // ── 2 & 3. claude plugin marketplace add + install, isolated, with a negative control ─────────
  const claudeProbe = spawnSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  if (claudeProbe.error) {
    console.log(
      `::warning::check-onboarding-parity --exec: the \`claude plugin …\` probe SKIPPED — no \`${CLAUDE_BIN}\` resolvable.`
    );
    return failed ? 1 : 0;
  }

  const realInstalledPlugins = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const before = fingerprint(realInstalledPlugins);

  const isolatedHome = mkdtempSync(join(tmpdir(), 'gf-parity-claude-plugin-'));
  const isolatedEnv = { ...process.env, HOME: isolatedHome, XDG_CONFIG_HOME: isolatedHome, CLAUDE_CONFIG_DIR: isolatedHome };

  const addMarketplace = spawnSync(CLAUDE_BIN, ['plugin', 'marketplace', 'add', source], {
    encoding: 'utf8',
    timeout: 90_000,
    env: isolatedEnv,
  });
  const install = spawnSync(CLAUDE_BIN, ['plugin', 'install', 'golden-frijoles@golden-frijoles'], {
    encoding: 'utf8',
    timeout: 90_000,
    env: isolatedEnv,
  });
  const addOutput = `${addMarketplace.stdout || ''}${addMarketplace.stderr || ''}`;
  const installOutput = `${install.stdout || ''}${install.stderr || ''}`;

  // The negative control runs REGARDLESS of the outcome above — it is what proves the isolation
  // held, and a leak here is the worst possible outcome of this whole mode: a documentation parity
  // check that mutated the operator's real plugin config.
  const after = fingerprint(realInstalledPlugins);
  if (before !== after) {
    console.error(
      '  ❌ NEGATIVE CONTROL FAILED — the isolated claude-plugin probe touched the REAL ' +
        `${realInstalledPlugins} (was ${before}, now ${after}). Do not re-run until the env scrub above is fixed.`
    );
    return 1; // overrides everything else: a real leak is reported on its own, nothing else matters here
  }
  console.log(`  ✅ negative control — ${realInstalledPlugins} unchanged (${before})`);

  if (
    (addMarketplace.error || (addMarketplace.status !== 0 && looksLikeNetworkTrouble(addOutput))) ||
    (install.error || (install.status !== 0 && looksLikeNetworkTrouble(installOutput)))
  ) {
    console.log(
      '::warning::check-onboarding-parity --exec: the `claude plugin …` probe SKIPPED — could not look: ' +
        `${(addMarketplace.error?.message ?? install.error?.message ?? `${addOutput}${installOutput}`).slice(0, 200)}`
    );
    return failed ? 1 : 0;
  }

  const isolatedInstalledPlugins = join(isolatedHome, 'plugins', 'installed_plugins.json');
  // The exact plugin id, not a substring: a checkout path or a marketplace URL can contain "golden-frijoles" too.
  const listsIt =
    existsSync(isolatedInstalledPlugins) &&
    readFileSync(isolatedInstalledPlugins, 'utf8').includes('"golden-frijoles@golden-frijoles"');
  if (!listsIt) {
    console.error(
      `  ❌ claude plugin marketplace add ${label} && claude plugin install golden-frijoles@golden-frijoles\n` +
        `     → golden-frijoles is not listed in the isolated config afterwards.\n` +
        `     marketplace add: ${addOutput.trim().slice(0, 300)}\n` +
        `     install:         ${installOutput.trim().slice(0, 300)}`
    );
    failed = true;
  } else {
    console.log('  ✅ claude plugin marketplace add + install  →  golden-frijoles listed in the isolated config');
  }

  return failed ? 1 : 0;
}

/**
 * The FOURTH `--exec` probe (codex should-fix, cross-review of #47): the prompt's OTHER
 * installation method — "if you're in another agent, run `npx skills add … --skill '*'`" — must
 * actually install every skill, not merely list them. `--list` proves the catalogue is visible;
 * it proves nothing about the write path a real "another agent" reader takes.
 *
 * Runs `-a codex -y` (a real, non-interactive agent choice, skipping the picker) in a throwaway
 * project directory, with an isolated `HOME`/`XDG_CONFIG_HOME` so it cannot read or write a real
 * `~/.agents/skills/` (this CLI's own config lives there too). Asserts every skill directory this
 * repo actually declares (`listSkills()` — the same registry `check-skill-scripts.mjs` walks, never
 * a hand-typed pair) landed under `.agents/skills/<name>/SKILL.md` in the project dir — not just
 * `golden-frijoles` and `groom`, though those two are named explicitly in the failure message since
 * they are the ones a stranger's very first prompt depends on.
 */
function installPromptCodexInstallCheck() {
  const npxProbe = spawnSync('npx', ['--version'], { encoding: 'utf8', timeout: 20_000 });
  if (npxProbe.error) {
    console.log(
      "::warning::check-onboarding-parity --exec: the codex `npx skills add --skill '*'` probe SKIPPED — no `npx` resolvable."
    );
    return 0;
  }

  const live = process.argv.includes('--live');
  const source = live ? 'golden-frijoles/skills' : repoRoot;
  const label = live ? 'golden-frijoles/skills' : '<this checkout>';

  const projectDir = mkdtempSync(join(tmpdir(), 'gf-parity-codex-install-'));
  const isolatedHome = mkdtempSync(join(tmpdir(), 'gf-parity-codex-home-'));
  const isolatedEnv = {
    ...process.env,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: isolatedHome,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };

  const install = spawnSync('npx', ['-y', 'skills@1.7.0', 'add', source, '--skill', '*', '-a', 'codex', '-y'], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 120_000,
    env: isolatedEnv,
  });
  const output = stripAnsi(`${install.stdout || ''}${install.stderr || ''}`);
  if (install.error || (install.status !== 0 && looksLikeNetworkTrouble(output))) {
    console.log(
      "::warning::check-onboarding-parity --exec: the codex `npx skills add --skill '*'` probe SKIPPED — " +
        `could not look: ${(install.error?.message ?? output).slice(0, 200)}`
    );
    return 0;
  }

  const expected = listSkills();
  const missing = expected.filter((name) => !existsSync(join(projectDir, '.agents', 'skills', name, 'SKILL.md')));
  // Named even though they're already covered by `missing` above — the failure message should say
  // outright whether the two surfaces a stranger's FIRST prompt depends on made it, not just "3 of
  // 11 missing" and leave the reader to go check which three.
  const criticalMissing = ['golden-frijoles', 'groom'].filter((name) => missing.includes(name));
  if (missing.length) {
    console.error(
      `  ❌ npx skills add ${label} --skill '*' -a codex -y  →  missing under .agents/skills/: ${missing.join(', ')}` +
        (criticalMissing.length ? ` (including ${criticalMissing.join(' and ')}, the prompt's own setup path)` : '') +
        `\n     ${output.trim().split('\n').slice(-15).join('\n     ')}`
    );
    return 1;
  }
  console.log(
    `  ✅ npx skills add ${label} --skill '*' -a codex -y  →  all ${expected.length} skill(s) installed under ` +
      '.agents/skills/, including golden-frijoles and groom'
  );
  return 0;
}

/** The CLI version that first carries `frijoles config` (golden-frijoles-plugin S5.2, D10). */
export const LOCAL_CONFIG_SINCE = '0.2.0';
const LOCAL_CONFIG_COMMAND = 'frijoles config list --json';

/**
 * The local-command probe (S5.2): `frijoles config` reads and writes only the project's
 * golden-frijoles.config.json, so unlike the kill-switch story it must SUCCEED without a credential —
 * exit 0 and parseable JSON, in an empty temp project under the same scrubbed HOME. It SKIPS (a
 * `::warning::`, returns null) when the resolved `frijoles` predates the command: the docs and the CLI ship
 * separately (D14), and an older CLI on PATH is "could not look", not a defect.
 */
/** Pure — does the resolved `frijoles` carry `frijoles config`? An unknown or unparseable version is "could not tell": skip. */
export function carriesLocalConfig(version) {
  const cmp = version ? compareVersions(version, LOCAL_CONFIG_SINCE) : null;
  return cmp !== null && cmp >= 0;
}

function localConfigProbe(cliPath, version, scrubbedEnv) {
  if (!carriesLocalConfig(version)) {
    console.log(
      `::warning::check-onboarding-parity --exec: \`${LOCAL_CONFIG_COMMAND}\` SKIPPED — the resolved \`${CLI_BIN}\` ` +
        `is ${version ?? 'of an unknown version'}, and the command ships in ${LOCAL_CONFIG_SINCE}.`
    );
    return null;
  }
  const project = mkdtempSync(join(tmpdir(), 'gf-parity-config-'));
  const run = spawnSync(cliPath, ['config', 'list', '--json'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 30_000,
    env: scrubbedEnv,
  });
  if (run.error) return { ok: false, why: `could not run: ${run.error.message}` };
  if (run.status !== 0) return { ok: false, why: `exit ${run.status}: ${(run.stderr || run.stdout || '').trim().slice(0, 160)}` };
  try {
    JSON.parse(run.stdout);
  } catch {
    return { ok: false, why: `unparseable --json output: ${(run.stdout || '').slice(0, 120)}` };
  }
  return { ok: true, why: 'exit 0 and parseable JSON, with no credential (a local command)' };
}

function execCheck() {
  const candidates = [CLI_BIN, join(repoRoot, 'node_modules', '.bin', CLI_BIN)];
  let cliVersion = null;
  const cliPath = candidates.find((candidate) => {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 20_000 });
    if (probe.error || probe.status !== 0) return false;
    cliVersion = (/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(probe.stdout || '') ?? [null])[0];
    return true;
  });
  if (!cliPath) {
    // `::warning::` so a SKIP is visible in the one place people read — the checks list. Printing
    // only to stdout made a skipped run indistinguishable from a passing one, which is the same
    // ambiguous-green shape this whole mode exists to end.
    console.log(
      `::warning::check-onboarding-parity --exec was SKIPPED, not passed — no \`${CLI_BIN}\` resolvable.`
    );
    console.log(
      `check-onboarding-parity --exec: SKIPPED — no \`${CLI_BIN}\` resolvable. ${CLI_GLOBAL_INSTALL} to run it.\n` +
        '  "Could not look" is not the failure outcome; this is a release-time check, not a gate on npm being up.'
    );
    return 0;
  }

  // An empty config home, so `~/.config/golden-frijoles/credentials.json` cannot be found, and a
  // blank token, which `resolveAuth` treats as absent (it trims, then tests for truthiness).
  const emptyHome = mkdtempSync(join(tmpdir(), 'gf-parity-no-credentials-'));
  const scrubbedEnv = {
    ...process.env,
    GOLDEN_FRIJOLES_TOKEN: '',
    XDG_CONFIG_HOME: emptyHome,
    HOME: emptyHome,
  };

  const failures = [];
  for (const command of KILL_SWITCH_STORY) {
    const result = probeCommand(cliPath, command, scrubbedEnv);
    console.log(`  ${result.ok ? '✅' : '❌'} ${command.replace(/\s+#.*$/, '')}  →  ${result.why}`);
    if (!result.ok) failures.push({ command, why: result.why });
  }
  const local = localConfigProbe(cliPath, cliVersion, scrubbedEnv);
  if (local) {
    console.log(`  ${local.ok ? '✅' : '❌'} ${LOCAL_CONFIG_COMMAND}  →  ${local.why}`);
    if (!local.ok) failures.push({ command: LOCAL_CONFIG_COMMAND, why: local.why });
  }
  if (!failures.length) {
    console.log(
      `check-onboarding-parity --exec: every advertised command was PARSED by ${cliPath}, and every one of them ` +
        'stopped at the credential check — nothing was written.'
    );
    return 0;
  }
  console.error('\ncheck-onboarding-parity --exec: the docs advertise a command the CLI does not have.\n');
  for (const failure of failures) console.error(`    ${failure.command}\n      ${failure.why}`);
  console.error('\n  Fix it in template/scripts/lib/golden-onboarding.mjs and propagate. Presence in every');
  console.error('  surface is not the same as the command existing — that is the defect this mode exists for.\n');
  return 1;
}

/**
 * Pure (given `read`) — every surface whose `must` strings are not all present, verbatim, in its
 * file. `[]` means every surface agrees with `template/scripts/lib/golden-onboarding.mjs`.
 *
 * Exported and side-effect-free (no `console`, no `process.exit`) so
 * `check-onboarding-parity.test.mjs` can import this module for its logic alone — the CLI half
 * below is `isMain`-guarded specifically so that import never runs a network probe or exits the
 * test process (LEARNINGS: a script with a co-located test file must guard its `main()` call).
 */
export function findParityProblems({ surfaces = SURFACES, read = readFileSync, root = repoRoot } = {}) {
  const problems = [];
  for (const surface of surfaces) {
    let text;
    try {
      text = read(join(root, surface.file), 'utf8');
    } catch {
      problems.push({ file: surface.file, missing: ['(the file itself)'], why: surface.why });
      continue;
    }
    const missing = surface.must.filter((needle) => !text.includes(needle));
    if (missing.length) problems.push({ file: surface.file, missing, why: surface.why });
  }
  return problems;
}

/** Print `findParityProblems`'s result and return the exit code. The only place this file prints it. */
function reportParityProblems(problems, surfaceCount) {
  if (!problems.length) {
    console.log(
      `check-onboarding-parity: clean (${surfaceCount} surfaces carry the canonical commands from template/scripts/lib/golden-onboarding.mjs).`
    );
    return 0;
  }
  console.error('\ncheck-onboarding-parity: the onboarding surfaces have drifted apart.\n');
  for (const problem of problems) {
    console.error(`  ${problem.file}`);
    console.error(`  ${'-'.repeat(problem.file.length)}`);
    console.error(`  ${problem.why}\n`);
    for (const missing of problem.missing) console.error(`    missing: ${missing}`);
    console.error('');
  }
  console.error('  These strings are defined ONCE, in template/scripts/lib/golden-onboarding.mjs, and');
  console.error('  printed from there by scripts/preflight.mjs. If a command genuinely changed, change');
  console.error('  it in the module and update every surface — not the other way around.\n');
  return 1;
}

function main(argv) {
  if (argv.includes('--exec')) {
    const gfExit = execCheck();
    console.log('\n  — the install prompt itself (npx skills --list, claude plugin marketplace add + install) —\n');
    const installPromptExit = installPromptExecChecks();
    console.log("\n  — the OTHER install path actually installs (npx skills add --skill '*' -a codex -y) —\n");
    const codexInstallExit = installPromptCodexInstallCheck();
    return gfExit || installPromptExit || codexInstallExit ? 1 : 0;
  }
  return reportParityProblems(findParityProblems(), SURFACES.length);
}

// realpath, not resolve: on macOS a temp or symlinked path (/var → /private/var) never equals the
// module URL, and a plain comparison makes the CLI a silent no-op (same pattern as
// render-skill-adverts.mjs / check-release.mjs).
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));
