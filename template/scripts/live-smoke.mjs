#!/usr/bin/env node
/**
 * live-smoke — the scripted, cross-agent-usable default for verifying real, rendered behavior against
 * local/preview/staging/prod, unauthed or authed.
 *
 * Ported from the origin project's app-local script by plugin-audit-and-extraction S1 (D3: port, don't
 * drop). Every project-specific value — the app dir, the environment URLs, the role flows, the auth
 * provider's key names — moved to `live-smoke.config.json` at the repo root. The refusals the origin
 * learned the hard way are kept: authed flows never run against an env marked unsupported (auth providers
 * reject testing tokens for production keys by design), and keys that look like production keys are
 * refused even at --env=local.
 *
 * Wraps the app's existing Playwright harness (`<appDir>/playwright.config.ts`'s `browser` project) — no
 * new browser-driving logic, just env resolution + a structured result an agent can parse.
 *
 * Three modes (exactly one):
 *   --path <url-path> [--flow unauthed|<role>]   ad-hoc: runs e2e/_live/ad-hoc.browser.spec.ts on ONE path
 *   --spec <name>                                 a COMMITTED *.browser.spec.ts whose TEST TITLE matches
 *   --file <path>                                 every test in a committed spec, by file path
 *
 * --env: any key under `envs` in the config, plus `preview` (needs --preview-url). This script starts
 * nothing itself — the target must already be running.
 *
 * Output: exit code (0 = pass), <appDir>/test-results/live-smoke/report.json and screenshot.png for a
 * --path run. Read both back — a 0 with an unexpected screenshot is still worth flagging.
 *
 *   node scripts/live-smoke.mjs --env=local --path=/
 *   node scripts/live-smoke.mjs --env=prod  --path=/pricing
 *   node scripts/live-smoke.mjs --env=local --flow=admin --path=/admin
 *   node scripts/live-smoke.mjs --env=local --spec="home renders"
 */
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, isAbsolute, normalize } from 'node:path';
import { projectRoot } from './lib/project-root.mjs';
import { readSection } from './lib/config.mjs';
import { isMain } from './lib/is-main.mjs';

const REPO_ROOT = projectRoot(); // D2
export const CONFIG_FILENAME = 'live-smoke.config.json';
const OUT_DIR = process.env.LIVE_SMOKE_OUT ?? 'test-results/live-smoke';

/** Strip a matching pair of surrounding quotes (single or double), if present. */
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

/**
 * Pure — parse a .env-style file without printing values or mutating process.env. Handles a leading
 * `export ` and quoted values (both common in a hand-edited .env.local): a plain `KEY=value` parse would
 * pass a literal `"sk_test_..."` (quotes included) to the auth provider and fail with a confusing error.
 */
export function parseDotEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('export ')) trimmed = trimmed.slice('export '.length).trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = unquote(trimmed.slice(eq + 1).trim());
  }
  return out;
}

/** Pure — validate the config shape. Throws with the offending key named. */
export function validateConfig(raw, path = CONFIG_FILENAME) {
  const fail = (m) => {
    throw new Error(`${path}: ${m}`);
  };
  if (!raw || typeof raw !== 'object') fail('must be a JSON object');
  if (typeof raw.appDir !== 'string' || !raw.appDir)
    fail('"appDir" must name the app directory (e.g. "apps/web")');
  // Relative and inside the repo: live-smoke reads <appDir>/.env.local, so an appDir that climbs out of the
  // repo would read some other tree's secrets. (Cross-review finding on PR #20.)
  if (isAbsolute(raw.appDir) || normalize(raw.appDir).split(/[\\/]/)[0] === '..') {
    fail('"appDir" must be a relative path inside the repo (e.g. "apps/web")');
  }
  const envs = raw.envs ?? {};
  if (!Object.keys(envs).length) fail('"envs" must map at least one env name to a base URL');
  for (const [k, v] of Object.entries(envs)) {
    if (k === 'preview') fail('"envs.preview" is reserved — preview URLs come from --preview-url');
    if (!/^https?:\/\//.test(v)) fail(`"envs.${k}" must be an http(s) URL`);
  }
  const flows = raw.flows ?? {};
  for (const [k, v] of Object.entries(flows)) {
    if (k === 'unauthed') fail('"flows.unauthed" is implicit — list only role flows');
    if (!v || typeof v.identityEnv !== 'string')
      fail(`"flows.${k}.identityEnv" must name the env var holding that role's test identity`);
  }
  const auth = raw.auth ?? {};
  return {
    appDir: raw.appDir,
    envs,
    flows,
    auth: {
      requiredEnv: auth.requiredEnv ?? [],
      forbidKeyPattern: auth.forbidKeyPattern ?? null,
      unsupportedEnvs: auth.unsupportedEnvs ?? [],
    },
    previewBypassEnv: raw.previewBypassEnv ?? null,
  };
}

function sameOrigin(path) {
  const probe = 'https://target.invalid';
  try {
    return new URL(path, probe).origin === probe;
  } catch {
    return false;
  }
}

/**
 * Pure — turn args + config + the resolvable environment into a run plan, or an error string. Every
 * refusal the script makes is decided here so a test can pin it without spawning a browser.
 */
export function planRun({ args, config, env = {}, dotenv = {} }) {
  const flow = args.flow ?? 'unauthed';
  const flowNames = ['unauthed', ...Object.keys(config.flows)];
  if (!flowNames.includes(flow))
    return { error: `--flow must be one of ${flowNames.join('|')} (got "${flow}")` };

  // A path, not a URL: `//host/x` is protocol-relative and would silently smoke a DIFFERENT host than the
  // resolved --env, and a scheme would override it outright. (Cross-review finding on PR #20.)
  // Checked by RESOLUTION, not by prefix: `/\\host` resolves to another origin too (WHATWG treats `\\` as
  // `/`), so the rule is simply that the path must land on the base URL's own origin.
  if (
    args.path != null &&
    (typeof args.path !== 'string' || !args.path.startsWith('/') || !sameOrigin(args.path))
  ) {
    return {
      error: `--path must be a path on the target env, starting with a single "/" (got "${args.path}")`,
    };
  }

  const modes = [args.path, args.spec, args.file].filter(Boolean);
  if (modes.length === 0)
    return { error: 'pass --path=<url-path> (ad-hoc), --spec=<name>, or --file=<path> (a committed spec)' };
  if (modes.length > 1) return { error: 'pass exactly one of --path, --spec, --file' };

  const envName = args.env ?? Object.keys(config.envs)[0];
  let baseURL;
  if (envName === 'preview') {
    if (!args['preview-url']) return { error: '--env=preview requires --preview-url=<https://...>' };
    baseURL = args['preview-url'];
  } else {
    baseURL = config.envs[envName];
    if (!baseURL)
      return {
        error: `unknown --env "${envName}" (expected ${[...Object.keys(config.envs), 'preview'].join('|')})`,
      };
  }

  const childEnv = { PLAYWRIGHT_BASE_URL: baseURL };
  if (envName === 'preview' && config.previewBypassEnv) {
    const bypass = env[config.previewBypassEnv];
    if (!bypass)
      return { error: `--env=preview needs ${config.previewBypassEnv} set in the shell environment` };
    childEnv[config.previewBypassEnv] = bypass;
  }

  if (flow !== 'unauthed') {
    // The env constraint FIRST — a specific refusal beats a generic "need keys" message when both apply.
    if (config.auth.unsupportedEnvs.includes(envName)) {
      return {
        error:
          `--flow=${flow} against --env=${envName} is not supported — auth providers reject testing tokens ` +
          'for production keys by design. Use a dev/test environment for authed flows.',
      };
    }
    for (const key of config.auth.requiredEnv) {
      const value = env[key] ?? dotenv[key];
      if (!value)
        return { error: `an authed --flow needs ${key} resolvable from the shell or <appDir>/.env.local` };
      // Defense-in-depth beyond the env check: the same rejection happens at --env=local when .env.local
      // carries production keys. Catch it here with a clear message, not deep inside a sign-in helper.
      if (config.auth.forbidKeyPattern && value.includes(config.auth.forbidKeyPattern)) {
        return {
          error:
            `${key} looks like a PRODUCTION key (contains "${config.auth.forbidKeyPattern}") — authed ` +
            'live-smoke flows only work with a dev/test auth instance.',
        };
      }
      childEnv[key] = value;
    }
    const identityEnv = config.flows[flow].identityEnv;
    const identity = env[identityEnv] ?? dotenv[identityEnv];
    if (identity) childEnv[identityEnv] = identity;
    childEnv[`LIVE_SMOKE_IDENTITY_ENV_${flow.toUpperCase()}`] = identityEnv;
  }

  let playwrightArgs;
  if (args.path) {
    Object.assign(childEnv, { LIVE_SMOKE_PATH: args.path, LIVE_SMOKE_FLOW: flow, LIVE_SMOKE_OUT: OUT_DIR });
    playwrightArgs = ['playwright', 'test', '--project=browser', 'e2e/_live/ad-hoc.browser.spec.ts'];
  } else if (args.spec) {
    playwrightArgs = ['playwright', 'test', '--project=browser', '-g', args.spec];
  } else {
    playwrightArgs = ['playwright', 'test', '--project=browser', args.file];
  }
  return { envName, baseURL, flow, childEnv, playwrightArgs };
}

export function loadConfig({ root = REPO_ROOT } = {}) {
  const path = join(root, CONFIG_FILENAME);
  // The `smoke` section of golden-frijoles.config.json over the legacy file (D9); validation stays here.
  const { raw, present } = readSection('smoke', {
    root,
    onLegacyError: (_p, e) => {
      throw e;
    },
  });
  if (!present) {
    throw new Error(
      `${path} not found — live-smoke refuses to guess which app and which URLs to smoke.\n` +
        `  Copy live-smoke.config.example.json to ${CONFIG_FILENAME}, fill it in, and commit it.`
    );
  }
  return validateConfig(raw, path);
}

function die(message) {
  console.error(`live-smoke: ${message}`);
  process.exit(2);
}

function main() {
  const { values: args } = parseArgs({
    options: {
      env: { type: 'string' },
      flow: { type: 'string', default: 'unauthed' },
      path: { type: 'string' },
      spec: { type: 'string' },
      file: { type: 'string' },
      'preview-url': { type: 'string' },
    },
  });
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    die(e.message);
  }
  const appRoot = join(REPO_ROOT, config.appDir);
  if (
    !existsSync(join(appRoot, 'playwright.config.ts')) &&
    !existsSync(join(appRoot, 'playwright.config.js'))
  ) {
    die(`${config.appDir} has no playwright.config — live-smoke wraps the app's own Playwright harness`);
  }
  const dotenvPath = join(appRoot, '.env.local');
  const dotenv = existsSync(dotenvPath) ? parseDotEnv(readFileSync(dotenvPath, 'utf8')) : {};

  const plan = planRun({ args, config, env: process.env, dotenv });
  if (plan.error) die(plan.error);

  if (args.path) {
    // Clear a PREVIOUS run's evidence first — a skipped or crashed-before-navigating run leaves no fresh
    // report, and the readback below would otherwise present stale evidence as current.
    rmSync(join(appRoot, OUT_DIR, 'report.json'), { force: true });
    rmSync(join(appRoot, OUT_DIR, 'screenshot.png'), { force: true });
  }

  const target = args.path ? `path=${args.path}` : args.spec ? `spec="${args.spec}"` : `file=${args.file}`;
  console.log(`live-smoke: env=${plan.envName} baseURL=${plan.baseURL} flow=${plan.flow} ${target}`);

  const result = spawnSync('npx', plan.playwrightArgs, {
    cwd: appRoot,
    env: { ...process.env, ...plan.childEnv },
    stdio: 'inherit',
  });

  if (args.path) {
    const reportPath = join(appRoot, OUT_DIR, 'report.json');
    if (existsSync(reportPath)) {
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      console.log(`live-smoke: report at ${reportPath}`);
      console.log(
        `live-smoke: screenshot at ${report.screenshot ? join(appRoot, report.screenshot) : '(none)'}`
      );
      if (report.consoleErrors?.length) {
        console.log(
          `live-smoke: ${report.consoleErrors.length} browser console error(s) captured — see report.json`
        );
      }
    } else {
      console.log(
        'live-smoke: no report.json written (the spec likely skipped or crashed before navigating)'
      );
    }
  }
  process.exit(result.status ?? 1);
}

if (isMain(import.meta.url)) main();
