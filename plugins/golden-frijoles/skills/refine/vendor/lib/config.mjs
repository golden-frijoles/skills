// config.mjs — one config file a person can read, and one place that decides where each setting comes from
// (golden-frijoles-plugin D9, S4.1).
//
// `golden-frijoles.config.json` at the project root holds every non-secret setting, one section per module. The
// seven legacy files keep working: for each section this module merges the legacy file and the new file's section,
// the NEW FILE WINNING PER TOP-LEVEL KEY, and reports a key set in both as a duplicate (never an error).
//
// What this module deliberately does NOT do: validate a section. Every rail already owns a parser that knows its
// shape and throws its own error (parseJevConfig, validateReportingConfig, live-smoke's validateConfig, …). This
// only resolves SOURCES and hands the merged raw object to that parser, so a rule lives in one place, not two.
//
// Three answers, never two (LEARNINGS): an absent file is a quiet fallback; a present-but-malformed file is a
// CONFIGURATION failure that names the file; and the rail decides what "no section anywhere" means for it.
//
// Secrets never go in this file, only the NAMES of the env vars that hold them. `setKey` refuses a value that looks
// like a credential.
//
// Zero deps. Imported by the kit's `frijoles-kit config` and, via `@golden-frijoles/kit/config`, by the `frijoles` CLI (D10).

import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { kitRoot, projectRoot } from './project-root.mjs';
import { REGISTRY } from './config-registry.mjs';

// One import for every front end (D10): the CLI's doctor and setup read the registry through this module too.
export { REGISTRY, MODULES } from './config-registry.mjs';
// The project root this core reads and writes under, exported so the `frijoles` CLI resolves the SAME directory (D10).
export { projectRoot } from './project-root.mjs';

export const CONFIG_FILENAME = 'golden-frijoles.config.json';

export const SECTIONS = Object.freeze([
  'project',
  'board',
  'verify',
  'roadmap',
  'ways',
  'review',
  'jev',
  'smoke',
  'reporting',
  'deploy',
  'ship',
  'spend',
  'routines',
  'intent',
  'lint',
]);

/**
 * The ONE table of legacy sources: section (or a dotted sub-section) → the file it used to live in, relative to the
 * project root. A rail whose legacy path is computed (reporting's `REPORTING_CONFIG`) passes `legacyPath` instead.
 * `ways` has no legacy file: its setting IS a path, `fillIns`, defaulting to the prose file that stays (X15).
 */
export const LEGACY = Object.freeze({
  jev: 'jev.config.json',
  reporting: 'reporting.config.json',
  smoke: 'live-smoke.config.json',
  'smoke.triage': 'smoke-triage.config.json',
  'smoke.perf': 'perf-probe.config.json',
  review: 'scripts/review-config.json',
});

/** The legacy file for a section, absolute. The one place REPORTING_CONFIG is honoured, for every caller. */
export function legacyPathFor(name, { root = projectRoot(), env = process.env } = {}) {
  if (name === 'reporting' && env.REPORTING_CONFIG) return resolve(root, env.REPORTING_CONFIG);
  return LEGACY[name] ? resolve(root, LEGACY[name]) : null;
}

/** Sub-sections carved out of a parent: reading `smoke` for live-smoke must not hand it the triage/perf policies. */
const CARVED = Object.freeze({ smoke: ['triage', 'perf'] });

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseJsonFile(path, { read, onError }) {
  let text;
  try {
    text = read(path, 'utf8');
  } catch (e) {
    return onError(path, e);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return onError(path, e);
  }
}

const configFail = (path, e) => {
  throw new ConfigError(`${path}: not valid JSON (${e.message})`);
};

/**
 * A config file on the real filesystem must RESOLVE inside the project. `config list` prints what it reads, so a
 * checkout whose golden-frijoles.config.json (or a legacy file) is a symlink to ~/.npmrc or a cloud credentials file
 * would otherwise print or migrate that file (security lens on #49). Injected IO (tests) is not a filesystem: skipped.
 */
function assertContained(path, root, read) {
  if (read !== readFileSync) return;
  const real = realpathSync(path);
  const within = (dir) => {
    const r = realpathSync(dir);
    return real === r || real.startsWith(r + sep);
  };
  // The kit's own files (a bundled default, read in installed mode) are not the checkout's to redirect.
  if (!within(root) && !within(kitRoot())) {
    throw new ConfigError(`${path} resolves outside the project (${real}); refusing to read it.`);
  }
}

/**
 * REPORTING_CONFIG is the operator's env, not the checkout's: the file it names may live anywhere. Keyed on the PATH,
 * so it holds whether a rail passes that path as `legacyPath` (reporting-config.mjs does) or the table resolves it
 * (copy-in review: the first exemption tested `!legacyPath` and refused the rail's own call).
 */
function operatorPath(name, abs, { root, env }) {
  return name === 'reporting' && !!env.REPORTING_CONFIG && abs === resolve(root, env.REPORTING_CONFIG);
}

/** The project's `golden-frijoles.config.json`, parsed; `null` when absent. Malformed → ConfigError. */
export function readConfigFile({ root = projectRoot(), read = readFileSync, exists = existsSync } = {}) {
  const path = join(root, CONFIG_FILENAME);
  if (!exists(path)) return null;
  assertContained(path, root, read);
  const json = parseJsonFile(path, { read, onError: configFail });
  if (!isObject(json)) throw new ConfigError(`${path}: must be a JSON object of sections`);
  // An unknown section is IGNORED here, never thrown: a file written by a newer kit or CLI must not break the
  // older rails a consumer copied. `loadConfig` reports it, and `setKey` refuses to write one (typos on write).
  return json;
}

/** Pure — sections a config object names that this version doesn't know. */
export function unknownSections(json) {
  return Object.keys(json ?? {}).filter((k) => !k.startsWith('$') && !SECTIONS.includes(k));
}

/** Walk a dotted path into an object; undefined when any step is missing. */
function dig(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (!isObject(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * One section, merged. `name` may be dotted (`smoke.triage`).
 *
 * Returns `{ raw, sources, duplicates }`: `raw` is `null` when neither the new file nor the legacy file has it (the
 * rail decides what that means), otherwise the legacy object with the new file's top-level keys laid over it.
 *
 * `legacyPath` overrides the table (absolute, or relative to the root). `onLegacyError(path, error)` lets a rail keep
 * throwing ITS OWN error for an unparseable legacy file, so a legacy-only repo behaves byte-identically.
 */
export function readSection(
  name,
  {
    root = projectRoot(),
    read = readFileSync,
    exists = existsSync,
    legacyPath,
    env = process.env,
    onLegacyError = configFail,
    // A rail's injected IO has always meant "my legacy file", and its tests rely on that, so it answers ONLY for
    // the legacy file. The new file is looked up with `read`/`exists` (the real filesystem unless a test injects
    // those too).
    legacyRead = read,
    legacyExists = exists,
  } = {}
) {
  const file = readConfigFile({ root, read, exists });
  let fromNew = file ? dig(file, name) : undefined;
  if (fromNew !== undefined && !isObject(fromNew)) {
    throw new ConfigError(`${join(root, CONFIG_FILENAME)}: "${name}" must be an object`);
  }
  if (fromNew && CARVED[name]) {
    fromNew = Object.fromEntries(Object.entries(fromNew).filter(([k]) => !CARVED[name].includes(k)));
  }
  // `null` in the new file means "unset", never "override the legacy value with null": saving a registry default
  // of null (jev.egress) must not re-enable something a legacy file had turned off.
  if (fromNew) fromNew = Object.fromEntries(Object.entries(fromNew).filter(([, v]) => v !== null));

  const legacyAbs = legacyPath ? resolve(root, legacyPath) : legacyPathFor(name, { root, env });
  let fromLegacy;
  if (legacyAbs && legacyExists(legacyAbs)) {
    // REPORTING_CONFIG is the operator's env, not the checkout's: it may name a file anywhere.
    if (!operatorPath(name, legacyAbs, { root, env })) assertContained(legacyAbs, root, legacyRead);
    fromLegacy = parseJsonFile(legacyAbs, { read: legacyRead, onError: onLegacyError });
  }

  const sources = [];
  if (fromLegacy !== undefined) sources.push(legacyAbs);
  if (fromNew !== undefined) sources.push(join(root, CONFIG_FILENAME));
  // `present` is the rail's absence test, never `raw === null`: a legacy file holding JSON null is PRESENT and
  // malformed, and must reach the rail's own parser (which throws), not fall back to defaults.
  if (fromLegacy === undefined && fromNew === undefined) return { raw: null, present: false, sources, duplicates: [] };
  if (fromNew === undefined) return { raw: fromLegacy, present: true, sources, duplicates: [] };
  if (fromLegacy === undefined) return { raw: { ...fromNew }, present: true, sources, duplicates: [] };
  // A legacy file that isn't an object is the rail's parser's error to report, even when the new file has keys.
  if (!isObject(fromLegacy)) return { raw: fromLegacy, present: true, sources, duplicates: [] };
  const duplicates = Object.keys(fromNew).filter((k) => k in fromLegacy && !k.startsWith('$'));
  return { raw: { ...fromLegacy, ...fromNew }, present: true, sources, duplicates };
}

/** Every section's effective value, for `list`/`doctor`. Never throws for an absent file. */
export function loadConfig({ root = projectRoot(), read = readFileSync, exists = existsSync } = {}) {
  const sections = {};
  const sources = {};
  const duplicates = [];
  const unknown = unknownSections(readConfigFile({ root, read, exists }));
  for (const name of [...SECTIONS, ...Object.keys(LEGACY).filter((k) => k.includes('.'))]) {
    const r = readSection(name, { root, read, exists });
    if (r.raw === null) {
      // Present but JSON null is malformed, not "no settings" (copy-in review).
      if (r.present) throw new ConfigError(`${r.sources[0] ?? name}: "${name}" must be an object, not null`);
      continue;
    }
    sections[name] = redactSecrets(name, r.raw);
    sources[name] = r.sources;
    for (const k of r.duplicates) duplicates.push(`${name}.${k}`);
  }
  return { sections, sources, duplicates, unknown };
}

/** The effective value of a dotted key (`review.reviewScope`), falling back to the registry default. */
export function getKey(key, opts = {}) {
  const [head, ...rest] = key.split('.');
  // A dotted sub-section with its own legacy file (smoke.triage.*) is resolved as that sub-section.
  const sub = rest.length && LEGACY[`${head}.${rest[0]}`] ? `${head}.${rest.shift()}` : head;
  const { raw } = readSection(sub, opts);
  const value = rest.length ? dig(raw ?? {}, rest.join('.')) : raw ?? undefined;
  if (value !== undefined) return redactSecrets(key, value);
  const reg = REGISTRY.find((r) => r.key === key);
  return reg ? reg.default : undefined;
}

// ── Writing ─────────────────────────────────────────────────────────────────────────────────────

const TOKEN_PREFIXES = /^(sk-|sk_|ghp_|gho_|ghs_|github_pat_|xox[abpr]-|AKIA|eyJ|npm_|glpat-|tsk_|gf_pat_)/;
// A URL carrying a password in its userinfo (postgres://user:pass@host/db).
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
const TELEGRAM_BOT_TOKEN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\//;
const SECRET_KEY = /(token|secret|password|apikey|api_key|privatekey|webhook)$/i;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Pure — does this key/value pair look like a credential rather than the NAME of an env var? A token prefix only
 * counts on a value long enough to be a token (`sk-shop` or `npm_utils` is a name, not a key).
 */
export function looksLikeSecret(key, raw) {
  if (typeof raw !== 'string') return false;
  // Trimmed: the patterns are anchored, so ' sk-…' or a pasted token with a trailing newline slipped past them
  // (security lens on golden-beans #164). Whitespace is never what makes a value safe.
  const value = raw.trim();
  if (TOKEN_PREFIXES.test(value) && value.length >= 20) return true;
  if (TELEGRAM_BOT_TOKEN.test(value) || SLACK_WEBHOOK.test(value) || URL_WITH_PASSWORD.test(value)) return true;
  const leaf = key.split('.').pop();
  return SECRET_KEY.test(leaf) && !ENV_NAME.test(value);
}

export const REDACTED = '<redacted: looks like a secret; keep it in .env.local>';

/**
 * Pure — `value` with every secret-looking string replaced by REDACTED. `loadConfig` and `getKey` are what
 * `config list/get` and `frijoles doctor` PRINT, and a legacy file may still hold a literal token the write guard never saw
 * (copy-in review). Rails read through `readSection`, which is never redacted.
 */
export function redactSecrets(key, value) {
  if (Array.isArray(value)) return value.map((v, i) => redactSecrets(`${key}.${i}`, v));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactSecrets(`${key}.${k}`, v)]));
  if (looksLikeSecret(key, value)) return REDACTED;
  // Stricter than the write guard, because over-redacting a display costs nothing: under a secret-named key, only a
  // value shaped like an env var NAME with an underscore (TELEGRAM_BOT_TOKEN) is shown. `ABCDEF1234567890` matched
  // the looser env-name exemption and was printed (review of #53).
  const leaf = key.split('.').pop();
  if (typeof value === 'string' && SECRET_KEY.test(leaf) && !/^[A-Z][A-Z0-9]*_[A-Z0-9_]*$/.test(value.trim())) return REDACTED;
  return value;
}

/** Pure — every dotted path under `key` whose value looks like a secret, walking nested objects and arrays. */
export function findSecrets(key, value) {
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecrets(`${key}.${i}`, v));
  if (isObject(value)) return Object.entries(value).flatMap(([k, v]) => findSecrets(`${key}.${k}`, v));
  return looksLikeSecret(key, value) ? [key] : [];
}

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function writeAtomic(path, obj) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Set a dotted key in the project's config file (created if absent). The first segment must be a known section.
 * A value that looks like a credential is refused: put the env var's NAME here, never its value.
 */
export function setKey(key, value, { root = projectRoot(), read = readFileSync, exists = existsSync, write = writeAtomic } = {}) {
  const parts = key.split('.');
  if (parts.length < 2 || !SECTIONS.includes(parts[0])) {
    throw new ConfigError(`"${key}": a key is <section>.<name>, with section one of ${SECTIONS.join(', ')}`);
  }
  if (parts.some((p) => FORBIDDEN_SEGMENTS.has(p) || p === '')) throw new ConfigError(`"${key}": not a valid key`);
  const secrets = findSecrets(key, value);
  if (secrets.length) {
    throw new ConfigError(
      `"${secrets[0]}" looks like a secret. Secrets never go in ${CONFIG_FILENAME}: keep the value in .env.local ` +
        'and put the env var NAME here (e.g. "TYPESAFE_API_KEY").'
    );
  }
  const file = readConfigFile({ root, read, exists }) ?? {};
  // A write deeper than <section>.<name> must not WIPE the legacy siblings of what it changes: the new file's
  // top-level key replaces the legacy one wholesale (D9), so seed it from the effective merged value first.
  if (parts.length > 2) {
    const [section, top] = parts;
    const own = file[section]?.[top];
    if (own === undefined) {
      const effective = readSection(section, { root, read, exists }).raw?.[top];
      if (isObject(effective)) {
        file[section] = isObject(file[section]) ? file[section] : {};
        file[section][top] = structuredClone(effective);
      }
    }
  }
  let cur = file;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts.at(-1)] = value;
  write(join(root, CONFIG_FILENAME), file);
  return file;
}

/**
 * Fold every legacy file into the new file's sections (new file wins per key). Legacy files are NEVER touched —
 * they keep working as fallbacks. Keys that look like secrets are skipped and reported, never copied.
 * Returns `{ config, folded, skipped }`; `dryRun` writes nothing.
 */
export function migrate({
  root = projectRoot(),
  read = readFileSync,
  exists = existsSync,
  write = writeAtomic,
  env = process.env,
  dryRun = false,
} = {}) {
  const config = readConfigFile({ root, read, exists }) ?? {};
  const folded = [];
  const skipped = [];
  for (const name of Object.keys(LEGACY)) {
    const abs = legacyPathFor(name, { root, env });
    if (!exists(abs)) continue;
    if (!operatorPath(name, abs, { root, env })) assertContained(abs, root, read);
    const legacy = parseJsonFile(abs, { read, onError: configFail });
    if (!isObject(legacy)) continue;
    const [head, sub] = name.split('.');
    // A section that exists but is not an object is the user's to fix, never silently replaced (copy-in review).
    const notObject = (v, at) => {
      if (v !== undefined && !isObject(v)) throw new ConfigError(`${join(root, CONFIG_FILENAME)}: "${at}" must be an object`);
    };
    notObject(config[head], head);
    config[head] = config[head] ?? {};
    if (sub) notObject(config[head][sub], name);
    const target = sub ? (config[head][sub] = config[head][sub] ?? {}) : config[head];
    for (const [k, v] of Object.entries(legacy)) {
      if (k.startsWith('$') || k.startsWith('_')) continue; // comments/notes stay with the legacy file
      if (k in target) continue; // the new file wins
      const secrets = findSecrets(`${name}.${k}`, v);
      if (secrets.length) {
        skipped.push(...secrets); // the whole key stays behind: a partial copy of a credentials block helps nobody
        continue;
      }
      target[k] = v;
      folded.push(`${name}.${k}`);
    }
  }
  for (const head of Object.keys(config)) if (isObject(config[head]) && !Object.keys(config[head]).length) delete config[head];
  if (!dryRun && folded.length) write(join(root, CONFIG_FILENAME), config);
  return { config, folded, skipped };
}

// ── The ask protocol (D11) ──────────────────────────────────────────────────────────────────────

export const NEEDS_SETTING = 'GF-NEEDS-SETTING';
export const EXIT_NEEDS_SETTING = 7;

/** Pure — the one stderr line an agent looks for. */
export function needsSettingLine(entry) {
  return `${NEEDS_SETTING} ${JSON.stringify({ key: entry.key, question: entry.question, default: entry.default })}`;
}

/**
 * A script needs a registered setting that is unset. Prints the protocol line once per process. `blocking` exits 7
 * (the script cannot continue without an answer); otherwise it returns the registry default and carries on.
 * A set key returns its value and prints nothing.
 */
const asked = new Set();
export function needSetting(
  key,
  { blocking = false, root = projectRoot(), read = readFileSync, exists = existsSync, write = (s) => process.stderr.write(s), exit = process.exit } = {}
) {
  const entry = REGISTRY.find((r) => r.key === key);
  if (!entry) throw new ConfigError(`needSetting("${key}"): not in the registry (lib/config-registry.mjs)`);
  const [head, ...rest] = key.split('.');
  const { raw } = readSection(head, { root, read, exists });
  const value = rest.length ? dig(raw ?? {}, rest.join('.')) : raw;
  const isSet = value !== undefined && value !== null;
  if (isSet) return value;
  if (!asked.has(key)) {
    asked.add(key);
    write(`${needsSettingLine(entry)}\n`);
  }
  if (blocking) exit(EXIT_NEEDS_SETTING);
  return entry.default;
}

/** Test seam: forget which keys this process already asked about. */
export function _resetAsked() {
  asked.clear();
}
