// secret-guard.mjs — never POST a reviewer's reply that carries one of this machine's secrets.
//
// ── Why this exists (distribute-what-we-use S1, the fresh pr-reviewer's round 2 on #188) ──────────────
// A reviewer CLI is fed an attacker-controllable diff. The rail removes every tool it can (Vibe runs with
// all tools disabled, Devin is refused, Claude runs `--tools ""`, codex runs `--sandbox read-only
// --ignore-user-config`), but codex's read-only sandbox still lets it READ host files, and there is no
// flag that stops that. An injected diff can therefore ask for `cat .env.local`, and cross-review would
// post the answer as a comment — on a public repo, to anyone.
//
// Refusing codex would leave no working reviewer, so the CHANNEL is closed instead: before anything is
// posted, the reply is checked for (1) any value from the project's own env files or from this process's
// secret-named env vars, and (2) the shapes of the credentials a developer machine commonly holds. A match
// fails the run and posts nothing; the reply is printed locally (it is the operator's own machine) with
// every match redacted, so a false positive costs a look, never a leak.
//
// Deliberately NOT a general secret scanner: GitHub push protection and CodeQL own that for commits. This
// guards one path — a model's text on its way to a PR comment. Zero npm deps.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Shorter values are too likely to occur in ordinary review prose ("development", a port, a flag). */
export const MIN_SECRET_LENGTH = 16;

/** Credential shapes with a distinctive prefix — low false-positive by construction. */
export const SECRET_SHAPES = Object.freeze([
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: 'OpenAI/Anthropic-style key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/ },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Slack webhook', re: /hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/ },
  { name: 'Telegram bot token', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Supabase access token', re: /\bsbp_[a-f0-9]{40}\b/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{16,}\b/ },
  // A signed JWT (header.payload.signature, both JSON parts base64url `eyJ…`): service-role keys are JWTs.
  // An opaque base64 run long enough to carry a key. Real reviews quote code, not 80-char blobs; this is
  // defence in depth against an injected "encode it" (the author-trust check below is the real control).
  { name: 'opaque base64 blob', re: /[A-Za-z0-9+/]{80,}={0,2}/ },
  { name: 'JWT', re: /\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/ },
]);

const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE|CREDENTIAL|WEBHOOK|DSN)/i;

/** `KEY=value` pairs from a dotenv-shaped text; quotes stripped, comments and blanks ignored. */
export function parseEnvValues(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2].trim();
    // A quoted value ends at its closing quote (a trailing `# comment` is dropped); an unquoted one ends
    // before ` #` (dotenv's inline-comment rule).
    const q = /^(['"])(.*?)\1(?:\s+#.*)?$/.exec(raw);
    const v = q ? q[2] : raw.replace(/\s+#.*$/, '').trim();
    if (v) out.push({ key: m[1], value: v });
  }
  return out;
}

const ENV_FILE_RE = /^\.env(?:rc|\..+)?$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.vercel', '.turbo']);

/**
 * Every `.env*` file (and `.envrc`) at the root and up to `depth` directories below it — a monorepo keeps
 * its app's secrets in `apps/<app>/.env.local`, not at the root. `.example` files are templates, not secrets.
 */
export function envFiles(root, { depth = 2, list = readdirSync, exists = existsSync } = {}) {
  const out = [];
  const walk = (dir, left) => {
    let names;
    try {
      names = exists(dir) ? list(dir, { withFileTypes: true }) : [];
    } catch {
      return;
    }
    for (const d of names) {
      const name = typeof d === 'string' ? d : d.name;
      const isDir = typeof d === 'string' ? false : d.isDirectory();
      if (isDir) {
        if (left > 0 && !SKIP_DIRS.has(name)) walk(join(dir, name), left - 1);
      } else if (ENV_FILE_RE.test(name) && !/\.example$/.test(name)) out.push(join(dir, name));
    }
  };
  walk(root, depth);
  return out;
}

/**
 * The operator's own credential stores, by path under $HOME. A collaborator's diff can still steer a reviewer
 * into reading one of these (codex's read-only sandbox reads the whole disk), and their values often have no
 * distinctive shape (an AWS secret access key is 40 plain characters) — so their VALUES are matched verbatim.
 * Only `key = value` / `key: value` style lines are read; nothing is stored or printed.
 */
export const HOME_CREDENTIAL_FILES = Object.freeze([
  '.aws/credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.config/gh/hosts.yml',
  '.docker/config.json',
  '.git-credentials',
  '.codex/auth.json',
]);

/** Pure: every long value on a `key = value`, `key: value`, `"key": "value"` or `login x password y` line. */
export function credentialValues(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    // The value after the LAST `=`/`:` on the line (`//registry.npmjs.org/:_authToken=npm_…` keeps only the
    // token), and the word after `password` (netrc).
    // Trailing base64 `=` padding is part of the value (`_auth=…==`, docker "auth": "…="); a URL remainder
    // (`registry=https://…` → `//registry…`) is configuration, not a secret (round 5 on #188).
    const kv = /[=:]\s*"?([^\s"',=:]{16,}={0,2})"?\s*,?\s*$/.exec(line);
    // Skip ONLY a URL's `scheme://` remainder; a base64 value can itself start with `//` (round 6).
    if (kv && !(kv[1].startsWith('//') && /https?:$/i.test(line.slice(0, kv.index + 1)))) out.push(kv[1]);
    const pw = /\bpassword\s+(\S{16,})/.exec(line);
    if (pw) out.push(pw[1]);
    const url = /https?:\/\/[^:\s]+:([^@\s]{16,})@/.exec(line);
    if (url) out.push(url[1]);
  }
  return out;
}

/**
 * The secret VALUES this machine could leak for this project: every value in the root's `.env*` files (a
 * dotenv file is secrets by convention; nested ones too, see envFiles), plus this process's env vars whose NAME says secret. Values
 * shorter than MIN_SECRET_LENGTH are skipped. Unreadable files are skipped — could not look is not a leak.
 */
export function collectSecretValues({
  root = process.cwd(),
  env = process.env,
  home = homedir(),
  read = readFileSync,
  list = readdirSync,
  exists = existsSync,
} = {}) {
  const values = new Set();
  for (const rel of home ? HOME_CREDENTIAL_FILES : []) {
    try {
      const p = join(home, rel);
      if (exists(p)) for (const v of credentialValues(read(p, 'utf8'))) values.add(v);
    } catch {
      /* unreadable: skip */
    }
  }
  for (const file of envFiles(root, { list, exists })) {
    try {
      for (const { value } of parseEnvValues(read(file, 'utf8')))
        if (value.length >= MIN_SECRET_LENGTH) values.add(value);
    } catch {
      /* unreadable: skip */
    }
  }
  for (const [k, v] of Object.entries(env || {}))
    if (SECRET_KEY_RE.test(k) && typeof v === 'string' && v.length >= MIN_SECRET_LENGTH) values.add(v);
  return [...values];
}

/**
 * Pure: which secrets does `text` carry? Returns `{ leaks: [{kind, name}], redacted }`, where `redacted`
 * is `text` with every match replaced by `[REDACTED <name>]`. Names only — never the value itself.
 */
export function findSecretLeaks(text, { values = [] } = {}) {
  let redacted = String(text || '');
  const leaks = [];
  for (const v of values) {
    if (v && redacted.includes(v)) {
      leaks.push({ kind: 'env-value', name: `an env value (${v.length} chars)` });
      redacted = redacted.split(v).join('[REDACTED env value]');
    }
  }
  for (const { name, re } of SECRET_SHAPES) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    if (g.test(redacted)) {
      leaks.push({ kind: 'shape', name });
      redacted = redacted.replace(new RegExp(re.source, g.flags), `[REDACTED ${name}]`);
    }
  }
  return { leaks, redacted };
}

// ── Who wrote the diff decides whether a reviewer may read it at all (codex security lens on #188) ─────
// No reviewer flag stops codex READING host files, and no string matcher catches a secret the model was
// told to encode. What closes the realistic threat on a public repo is the input: a hostile diff comes from
// someone without write access (a fork PR). So cross-review refuses such a PR unless the operator says so.

/** Repo permissions that can already push code here — their diff is not a new attacker. */
export const TRUSTED_PERMISSIONS = Object.freeze(['admin', 'maintain', 'write']);

/**
 * Pure: may a reviewer read this PR? `permission` is the author's repo permission as GitHub reports it
 * (`null` when it could not be read — treated as untrusted: could-not-look must not open the door).
 */
export function decideAuthorTrust({ permission, allowUntrusted = false }) {
  if (TRUSTED_PERMISSIONS.includes(permission)) return { ok: true, why: `author has ${permission} access` };
  if (allowUntrusted)
    return {
      ok: true,
      why: `author has ${permission ?? 'unknown'} access — allowed by --allow-untrusted-author`,
    };
  return {
    ok: false,
    why:
      `the PR author has ${permission ?? 'UNKNOWN'} access to this repo. A reviewer fed an outsider's diff can be ` +
      `steered by it into reading this machine's files; review it only after reading the diff yourself, then ` +
      `re-run with --allow-untrusted-author.`,
  };
}
