#!/usr/bin/env node
// routine-bootstrap.mjs — render one reviewed routine prompt with this project's declared fill-ins.
//
// The prompts deliberately mix project values with values a routine learns while it runs. Replacing every
// angle-bracket string would turn `<date>` or `<PR#>` into stale prose before the first run, so this table is
// the one authority for the distinction. A missing project value refuses before stdout: a partly-filled prompt
// pasted into /schedule is a cloud-side configuration bug that is hard to see and harder to unwind.
//
//   node scripts/routine-bootstrap.mjs <name>
//   node scripts/routine-bootstrap.mjs --list
//
// Exit codes: 0 rendered, 1 missing fill-ins/configuration, 2 bad routine name or usage. Zero deps; Node 18+.

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSection } from './lib/config.mjs';
import { loadPromptBody } from './lib/cross-agent-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROUTINES_DIR = join(HERE, 'routines');

// Includes every token in the seven prompts and their runbook. `source: 'runbook'` records tokens that are
// documentation examples rather than substitutions in a rendered prompt; keeping them here makes a new token a
// visible classification decision. The three descriptive TEMPLATE FILL-IN markers have separate keys because a
// single generic replacement would leave unrelated framework, rules, and deploy advice in the wrong prompt.
export const ROUTINE_TOKENS = Object.freeze([
  { token: '<root-repo>', kind: 'fill-in', key: 'root-repo' },
  { token: '<app-repo>', kind: 'fill-in', key: 'app-repo' },
  { token: '<api-repo>', kind: 'fill-in', key: 'api-repo', source: 'runbook' },
  { token: '<your-org>', kind: 'fill-in', key: 'your-org' },
  { token: '<appDir>', kind: 'fill-in', key: 'appDir' },
  { token: '<PROD_URL>', kind: 'fill-in', key: 'PROD_URL' },
  { token: '<PROD_DOMAIN>', kind: 'fill-in', key: 'PROD_DOMAIN' },
  { token: '<vercelProject>', kind: 'fill-in', key: 'vercelProject' },
  { token: '<stalePreviewAgeDays>', kind: 'fill-in', key: 'stalePreviewAgeDays' },
  { token: '<rule one>', kind: 'fill-in', key: 'rule one' },
  { token: '<rule two>', kind: 'fill-in', key: 'rule two' },
  {
    token: "TEMPLATE FILL-IN: name your framework's async gotchas here, e.g. which request APIs are async",
    kind: 'fill-in',
    key: 'async-gotchas',
  },
  {
    token:
      'TEMPLATE FILL-IN: list them here,\nnumbered, exactly as AGENTS.md states them, so this reviewer checks the same rules the builders follow.\nThe shape the origin project\'s list took, for reference: which system owns which data ("the commerce\nengine owns all orders and payments — never a second table for them"), which layer is never replaced\n("the auth provider is the auth layer — no custom auth pages"), which interfaces must stay accurate (an\nAPI/agent surface), and the copy/locale rule for user-visible text.',
    kind: 'fill-in',
    key: 'rules-context',
  },
  {
    token: "TEMPLATE FILL-IN: the frontend's deploy path, e.g. build → hosting service",
    kind: 'fill-in',
    key: 'deploy-path',
  },
  { token: '<date>', kind: 'runtime' },
  { token: '<id>', kind: 'runtime' },
  { token: '<trigger-id>', kind: 'runtime' },
  { token: '<name>', kind: 'runtime' },
  { token: '<your-file>', kind: 'runtime' },
  { token: '<repo>', kind: 'runtime' },
  { token: '<PR#>', kind: 'runtime' },
  { token: '<PR>', kind: 'runtime' },
  { token: '<N>', kind: 'runtime' },
  { token: '<one-line reason>', kind: 'runtime' },
  { token: '<the files you touched>', kind: 'runtime' },
  { token: '<the spec>', kind: 'runtime' },
  { token: '<your message>', kind: 'runtime' },
  { token: '<[a-z-]*-repo>', kind: 'runtime', source: 'runbook' },
  { token: 'TEMPLATE FILL-IN', kind: 'runtime', source: 'runbook' },
]);

export function routineNames(dir = ROUTINES_DIR, readDir = readdirSync) {
  // A missing routines/ is "no routines", reported by the CLI's usage line — never a stack trace (agy on #191).
  if (!existsSync(dir)) return [];
  return readDir(dir)
    .filter((name) => name.endsWith('.prompt.md'))
    .map((name) => name.replace(/\.prompt\.md$/, ''))
    .sort();
}

const present = (value) => (typeof value === 'string' ? value.trim().length > 0 : value != null);

export function fillInsForPrompt(body) {
  return ROUTINE_TOKENS.filter((entry) => entry.kind === 'fill-in' && body.includes(entry.token));
}

export function renderPrompt(body, values) {
  let rendered = body;
  for (const entry of fillInsForPrompt(body)) {
    if (present(values?.[entry.key])) rendered = rendered.split(entry.token).join(String(values[entry.key]));
  }
  return rendered;
}

export function missingFillIns(body, values) {
  return fillInsForPrompt(body).filter((entry) => !present(values?.[entry.key]));
}

/** Pure: placeholders the table does not know — `<TEMPLATE FILL-IN…`/`TEMPLATE FILL-IN:` markers, and `<token>`s. */
export function unclassifiedTokens(text) {
  const known = new Set(ROUTINE_TOKENS.map((e) => e.token));
  const found = new Set();
  // Remove every CLASSIFIED marker first, so a new marker beside a known one is still seen (#191 review).
  let rest = text;
  for (const e of ROUTINE_TOKENS) if (e.kind === 'fill-in') rest = rest.split(e.token).join('');
  if (/<TEMPLATE FILL-IN|TEMPLATE FILL-IN:/.test(rest)) found.add('TEMPLATE FILL-IN');
  for (const m of text.matchAll(/<([A-Za-z][A-Za-z0-9_ #.-]{0,40})>/g)) if (!known.has(m[0])) found.add(m[0]);
  return [...found];
}

export function promptPath(name, dir = ROUTINES_DIR) {
  return join(dir, `${name}.prompt.md`);
}

/** CLI seam: all I/O is injected so the refusal contract can be tested without a checkout. */
export function runRoutineBootstrap(
  argv,
  {
    root,
    routinesDir = ROUTINES_DIR,
    names = routineNames(routinesDir),
    readSectionFor = readSection,
    loadBody = loadPromptBody,
    out = (text) => process.stdout.write(text),
    err = (text) => process.stderr.write(text),
  } = {}
) {
  if (argv.length === 1 && argv[0] === '--list') {
    out(`${names.join('\n')}\n`);
    return 0;
  }
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    err(`Usage: node scripts/routine-bootstrap.mjs <name> | --list\nValid routines: ${names.join(', ')}\n`);
    return 2;
  }
  const name = argv[0];
  if (!names.includes(name)) {
    err(`Unknown routine "${name}". Valid routines: ${names.join(', ')}\n`);
    return 2;
  }

  // CRLF-safe: the multi-line fill-in markers are matched with \n (agy on #191).
  const body = loadBody(promptPath(name, routinesDir)).replace(/\r\n/g, '\n');
  let values;
  try {
    const section = readSectionFor('routines', root === undefined ? {} : { root });
    values = section.raw ?? {};
  } catch (error) {
    err(`routine-bootstrap: could not read routines from golden-frijoles.config.json: ${error.message}\n`);
    return 1;
  }
  const missing = missingFillIns(body, values);
  if (missing.length) {
    err(
      'routine-bootstrap: refusing to print a partly-filled prompt. Set every missing golden-frijoles.config.json routines key:\n'
    );
    for (const entry of missing) err(`  ${entry.key} (for ${entry.token})\n`);
    return 1;
  }
  const rendered = renderPrompt(body, values);
  // Grep-to-zero, whatever the table knows (check-template-drift's syntax): a TEMPLATE FILL-IN marker, or an
  // angle-bracket token nobody classified, refuses — a new token must be a visible decision, never a pass.
  const unclassified = unclassifiedTokens(rendered);
  if (unclassified.length) {
    err(
      `routine-bootstrap: refusing — unclassified placeholder(s) left in "${name}": ${unclassified.join(', ')}. ` +
        'Classify each in ROUTINE_TOKENS (fill-in or runtime).\n'
    );
    return 1;
  }
  const leftovers = fillInsForPrompt(rendered);
  if (leftovers.length) {
    err(
      `routine-bootstrap: refusing to print a prompt with unresolved fill-ins: ${leftovers.map((entry) => entry.token).join(', ')}\n`
    );
    return 1;
  }
  out(`${rendered}\n`);
  return 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    // Symlinked kit entrypoints otherwise compare a link on one side to a real module path on the other and silently do nothing.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

// No explicit root: readSection's default (projectRoot) honours GF_PROJECT_ROOT and walks up from a subdirectory,
// like every other kit script (#191 review).
if (isMain) process.exitCode = runRoutineBootstrap(process.argv.slice(2));
