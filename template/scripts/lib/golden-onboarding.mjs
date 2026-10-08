// golden-onboarding.mjs — the Golden Frijoles onboarding surface, named ONCE.
//
// ── Why this is a module and not a sentence in three READMEs ───────────────────────────────────
// golden-flags-by-default S1.4's acceptance is that the text the agent prints, the install page's
// CLI block and `frijoles init`'s own next-step line are **one surface**: "the three must say the same
// thing". Two hand-written copies of `npx @golden-frijoles/cli init` agree right up until one of
// them is edited, and the one that drifts is always the one nobody runs.
//
// So every command a consuming project is ever told to type comes from here, and
// `scripts/check-onboarding-parity.mjs` (in dobby-foundation, not shipped) asserts the shipped
// READMEs and AGENTS.md still contain these exact strings.
//
// ── The cross-repo half, stated honestly ──────────────────────────────────────────────────────
// The other two surfaces live in the Golden Frijoles product repo — its `/install` page reads
// `apps/web/lib/cli-install.ts`, and `frijoles init` prints from `packages/cli/src/commands/init.ts`.
// This file cannot import either: they are a different repo, and a template that npm-installs a
// product's web app to read a string would be absurd. The weld there is the same discipline in the
// other direction (`cli-install.test.ts` reads `packages/cli/package.json` off disk). Here the
// values are TRANSCRIBED, each with the file it was transcribed from, and re-checked by hand at
// every CLI release — `ENV_KEYS` below is the pair that matters, and `preflight.mjs` FAILS LOUDLY
// if the CLI writes different names, so a drift is caught by running the tool rather than by
// reading it.
//
// ── The env var names are D6 of the CLI epic, and D3 of this one ──────────────────────────────
// `frijoles init` writes exactly three names, and deliberately does NOT write `flag_sync` or an ingest
// key: a verb whose job is "let this app READ its flags" must not put wider credentials on disk as
// a side effect. `flag_sync` is an operator/deploy credential and belongs in CI secrets — minted on
// purpose with `frijoles keys create --type flag_sync`. Never both in one place.
//
// Zero deps — Node 18+.

/** The published packages. Transcribed from golden-beans `apps/web/lib/cli-install.ts`. */
export const CLI_PACKAGE = '@golden-frijoles/cli';
export const SDK_PACKAGE = '@golden-frijoles/sdk';

/** The binary `npm i -g` puts on PATH. */
export const CLI_BIN = 'frijoles';
/** The CLI's name before 1.0 (plugin-1-0 D2). Still found, so an older install keeps working until it upgrades. */
export const LEGACY_CLI_BIN = 'gf';

/**
 * The minimum CLI this template's contract is written against.
 *
 * It is the version that shipped the write path — `flags create --kill-switch --all-envs`, the verb
 * every kill-switch story in this operating system now names. A project on an older `frijoles` can read
 * flags and cannot complete a kill-switch story, which is a failure worth naming at preflight
 * rather than discovering halfway through one.
 */
export const MIN_CLI_VERSION = '0.1.0';

/**
 * The env var names `frijoles init` writes and the app reads. ONE definition, on purpose (CLI epic D6):
 * the file and its reader are generated together in `frijoles init`, and this is that pair's address on
 * the template side. `preflight.mjs` and `apps/example-app/flags.mjs` both read it from here.
 */
export const ENV_KEYS = {
  url: 'GOLDEN_FRIJOLES_URL',
  flagRead: 'GOLDEN_FRIJOLES_FLAG_READ_KEY',
  environment: 'GOLDEN_FRIJOLES_ENVIRONMENT',
};

/** The file `frijoles init` writes, and refuses to write if it cannot get it into `.gitignore`. */
export const ENV_FILE = '.env.local';

/** The route a `flag_read` key is exercised against — the one that actually serves it. */
export const SNAPSHOT_PATH = 'api/v1/flags/snapshot';

/** The default deployment, matching the CLI's own `DEFAULT_API_URL`. */
export const DEFAULT_API_URL = 'https://goldenfrijoles.com';

/**
 * The ONE command. `npx` first because the promise is "a machine that has never seen it" — a reader
 * who wants the global install finds it one line below, and a reader who only wants to try it will
 * not go looking for the shorter form.
 */
export const CLI_NPX_INIT = `npx ${CLI_PACKAGE} init`;
export const CLI_NPX_LOGIN = `npx ${CLI_PACKAGE} login`;
export const CLI_GLOBAL_INSTALL = `npm i -g ${CLI_PACKAGE}`;

/**
 * The kill-switch story as the commands that complete it — **including the activation step**.
 *
 * D4 of this epic: definitions are catalog-as-code, activations are not. `flags create` does both
 * in one verb (it creates the definition AND activates it in every environment named), which is
 * exactly why the distinction has to be written down somewhere a planner reads: `flags sync`, the
 * catalog-as-code verb, does NOT activate, and a project that syncs its definitions from source
 * control and never activates them serves compile defaults through the fallback chain while its
 * console reads "Never turned on here".
 */
export const KILL_SWITCH_STORY = [
  `${CLI_BIN} flags create <domain>.<feature>_enabled --kill-switch --all-envs`,
  `${CLI_BIN} flags get <domain>.<feature>_enabled    # ← the ACTIVATION check: PRODUCTION must not read "—"`,
  `${CLI_BIN} flags kill <domain>.<feature>_enabled --env production`,
];

/**
 * How to read the activation check's answer, in the CLI's OWN vocabulary.
 *
 * ⚠️ **This line shipped wrong once, and the way it was wrong is worth keeping.** It said
 * `frijoles flags ls --env production` and told the reader to look for the words *"never turned on"*. Two
 * separate errors: `frijoles flags ls` accepts only `--project` and prints all three environments as
 * columns, so `--env` is a hard usage error that exits 1 before it ever reaches auth; and *"never
 * turned on here"* is the **web console's** wording, while the CLI's `describeServing` prints `—`.
 * A reader following it literally would have run a command that cannot run, looking for a string
 * the tool never prints.
 *
 * It survived because it was verified the way prose gets verified — the string was present in every
 * surface, and `check-onboarding-parity.mjs` was about to weld it into five files. **Presence is not
 * execution.** A command a doc tells someone to run is checked by running it.
 */
export const SERVING_LEGEND = [
  '—                    never activated here. The consumer is serving its call-site default.',
  'off (nothing served) activated, then deactivated. Also the call-site default.',
  '<value>  v<n>        activated, and this is what a context with no attributes actually gets.',
];

/**
 * The block an agent prints when a project has no linked Golden Frijoles project.
 *
 * Returned as an array of lines rather than one string so a caller can indent it, prefix it or push
 * it into an existing report without re-wrapping. `preflight.mjs` prints it verbatim on a hard
 * failure; the READMEs carry it as a fenced block; `check-onboarding-parity.mjs` asserts they match.
 */
export function onboardingLines() {
  return [
    'This project has no Golden Frijoles project linked, so it cannot create a kill-switch.',
    'Two commands fix that — the second writes .env.local and prints the snippet that reads it:',
    '',
    `  ${CLI_NPX_LOGIN}`,
    `  ${CLI_NPX_INIT}`,
    '',
    `(${CLI_GLOBAL_INSTALL} puts \`${CLI_BIN}\` on your PATH. Every command takes --json.)`,
  ];
}

/**
 * Compare two dotted versions. Returns <0, 0 or >0 — `null` when either is unparseable, because
 * "we could not tell" and "it is older" lead to different actions and must not collapse.
 *
 * Deliberately not semver-complete: prerelease tags are compared as "has one = older than the same
 * numbers without one", which is the only prerelease rule this check needs and the only one it can
 * get right without a dependency in a repo that has none.
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] - right.nums[i];
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/**
 * The ONE install prompt a stranger pastes into their agent (golden-frijoles-plugin S3.3/S3.4;
 * account-from-the-terminal S1.2, D2).
 *
 * golden-beans `apps/web/lib/install-prompt.ts` is the SOURCE: `installPrompt(siteUrl)`, built from
 * `getSiteUrl()` there because the prompt now sends the agent to read `<site>/install.md` before it
 * installs anything. This is its transcription against the PRODUCTION origin — never a preview URL —
 * and golden-beans' `install-prompt.test.ts` imports this constant and asserts it equals
 * `installPrompt('https://goldenfrijoles.com')`, so a one-sided edit goes red there.
 * `scripts/check-onboarding-parity.mjs` asserts this string appears VERBATIM in the repo README.md and
 * the `golden-frijoles` umbrella SKILL.md. Never hand-edit this without the source changing first.
 */
export const INSTALL_PROMPT =
  'Set up Golden Frijoles in this project. ' +
  '1. Read https://goldenfrijoles.com/install.md before installing anything. ' +
  '2. Tell me in a few lines what it installs, what changes on this machine and which services it contacts. ' +
  'Offer me a security review, and wait for my go-ahead. ' +
  '3. Install it the way install.md says for the agent you are. ' +
  '4. Run the golden-frijoles skill and start its setup.';

/**
 * The value of `name` in a dotenv file, or null.
 *
 * ⚠️ **The LAST assignment wins.** `dotenv` assigns in file order, so a later line overrides an
 * earlier one — and a reader that returns the FIRST will confidently report on a value the running
 * app does not use. Two duplicate lines is not exotic: it is what a hand-edit plus a re-run of
 * `frijoles init` produces. Same rule, same reason, as the CLI's own `readEnvValue`.
 *
 * No interpolation, deliberately: this reads a file to decide whether a credential is present, and
 * expanding `$VAR` would make that answer depend on the environment doing the reading.
 */
export function readEnvValue(contents, name) {
  let found = null;
  for (const line of String(contents).split('\n')) {
    const match = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`).exec(line);
    if (!match) continue;
    const raw = match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    found = raw === '' ? null : raw;
  }
  return found;
}
