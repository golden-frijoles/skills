// jev.mjs — the ONE place that knows the TypeSafe System One API (jev-semantic-guards D1–D3).
//
// Jev answers typed questions (Noul / Choice / Score) about a `state` with calibrated probabilities. The
// review and prose guards use it for the LANGUAGE judgements their regexes kept getting wrong, and keep
// the regexes as the fallback. Three rules shape every line below:
//
//   1. THREE STATES, NEVER TWO. No key, a 401/422, a 429/529 after backoff, a timeout, a network error, an
//      unparseable body or an over-budget state are all `{ ok:false, state:'could-not-look', error }`.
//      "Jev was unreachable" must never read as a verdict — the caller falls back to today's regex.
//      askJev never throws.
//   2. A PINNED MODEL. Gates use `jev-1.13.0`, never `jev-latest`: an alias moves when a release ships,
//      so the answers behind a gate would change without a diff (the agy-pin lesson, applied to a model).
//      Bump it deliberately, after `node scripts/jev-eval.mjs --live`.
//   3. ONE COMMITTED SWITCH. `jev.config.json → rails.<rail>.mode: off | shadow | jev`. A missing file is
//      the defaults (everything off); a MALFORMED file throws, so a typo never silently means "off".
//      `egress:false` or no key makes the effective mode `off`, with the reason.
//   4. EGRESS IS A TRI-STATE, AND UNANSWERED BEHAVES AS NO (golden-frijoles-plugin D12, S5.4). `egress`
//      is `true | false | null`. The template ships `null`: a stranger's diffs never leave their machine
//      until they say so. `null` and `false` both make the effective mode `off`; `null` ADDITIONALLY
//      emits the D11 ask (`needSetting('jev.egress', { blocking: false })`) once per process, so an agent
//      asks the question instead of the guard silently staying off forever. The fallback reason for `null`
//      is `egress not answered`: `review-guard.mjs` wraps it into the reason `jev could not look (egress not
//      answered)`, and `prose-guard.mjs`'s judgeProse returns it as `why`. Existing consumers keep their committed `egress: true`.
//
// Zero deps — Node 18+ (global fetch). Everything with I/O takes injectable deps, so specs never touch the
// network.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { projectRoot } from './project-root.mjs';
import { needSetting, readSection } from './config.mjs';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-1.13.0';
export const MODES = ['off', 'shadow', 'jev'];
export const RAILS = ['review', 'prose'];

/** 32k tokens covers state + the longest question. ~4 chars/token, with headroom for the question. */
export const STATE_CHAR_BUDGET = 110_000;
export const DEFAULT_TIMEOUT_MS = 8_000;
const RETRY_STATUSES = new Set([429, 529]);
const MAX_RETRIES = 2;

/** The project root — the directory that holds `jev.config.json` (D2: `projectRoot()`, wherever this set runs). */
export const repoRoot = () => projectRoot();

export const DEFAULT_CONFIG = Object.freeze({
  model: DEFAULT_MODEL,
  egress: true,
  rails: {
    // Modes stay `off` for a repo with NO jev.config.json: it never opted in to sending text to Jev. The
    // thresholds are the MEASURED ones (jev-semantic-guards S5.2, sprint-5.md), not the pitch's starting guesses.
    review: { mode: 'off', thresholds: { real: 0.85, notReal: 0.3 }, shadowExpires: null },
    prose: { mode: 'off', thresholds: { claim: 0.8 }, shadowExpires: null },
  },
});

export class JevConfigError extends Error {}

const isUnit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * Validate a parsed jev.config.json against the defaults. Pure; throws JevConfigError naming the problem.
 * Unknown rails are refused (a misspelt rail would otherwise be a switch wired to nothing).
 */
export function parseJevConfig(json) {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  // Unknown keys are REFUSED, not ignored: `{ "egres": false }` meant to stop data leaving, and ignoring it
  // would keep egress on — a typo must fail loud, never silently mean something (fresh review, PR #34).
  const refuseUnknown = (obj, allowed, where) => {
    const extra = Object.keys(obj).filter((k) => !allowed.includes(k) && !k.startsWith('$'));
    if (extra.length)
      throw new JevConfigError(`jev.config.json: unknown key(s) in ${where}: ${extra.join(', ')}`);
  };
  if (!isObj(json)) throw new JevConfigError('jev.config.json: not an object');
  refuseUnknown(json, ['model', 'egress', 'rails'], 'the top level');
  const model = json.model ?? DEFAULT_MODEL;
  if (typeof model !== 'string' || !model)
    throw new JevConfigError('jev.config.json: model must be a string');
  if (/latest|preview/.test(model))
    throw new JevConfigError(
      `jev.config.json: model "${model}" is an alias — pin a version such as ${DEFAULT_MODEL}`
    );
  // Tri-state (D12): `true | false | null`. An explicit `null` must survive as `null` — `??` would
  // silently turn it back into `true`, which is exactly the "unanswered defaults to send" bug this
  // decision exists to close. Only an ABSENT key falls back to `true` (today's behaviour for a
  // consumer's committed config that never mentions egress at all).
  const egress = Object.prototype.hasOwnProperty.call(json, 'egress') ? json.egress : true;
  if (egress !== true && egress !== false && egress !== null)
    throw new JevConfigError('jev.config.json: egress must be true, false or null');
  if (json.rails !== undefined && !isObj(json.rails))
    throw new JevConfigError('jev.config.json: rails must be an object');
  const rails = {};
  for (const name of Object.keys(json.rails ?? {}))
    if (!RAILS.includes(name))
      throw new JevConfigError(`jev.config.json: unknown rail "${name}" (known: ${RAILS.join(', ')})`);
  for (const name of RAILS) {
    const d = DEFAULT_CONFIG.rails[name];
    const r = json.rails?.[name] ?? {};
    if (!isObj(r)) throw new JevConfigError(`jev.config.json: rails.${name} must be an object`);
    refuseUnknown(r, ['mode', 'thresholds', 'shadowExpires'], `rails.${name}`);
    const mode = r.mode ?? d.mode;
    if (!MODES.includes(mode))
      throw new JevConfigError(`jev.config.json: rails.${name}.mode must be one of ${MODES.join(' | ')}`);
    if (r.thresholds !== undefined && !isObj(r.thresholds))
      throw new JevConfigError(`jev.config.json: rails.${name}.thresholds must be an object`);
    refuseUnknown(r.thresholds ?? {}, Object.keys(d.thresholds), `rails.${name}.thresholds`);
    const thresholds = { ...d.thresholds, ...(r.thresholds ?? {}) };
    for (const [k, v] of Object.entries(thresholds))
      if (!isUnit(v)) throw new JevConfigError(`jev.config.json: rails.${name}.thresholds.${k} must be 0…1`);
    if (name === 'review' && thresholds.notReal >= thresholds.real)
      throw new JevConfigError('jev.config.json: rails.review.thresholds.notReal must be below .real');
    const shadowExpires = r.shadowExpires ?? null;
    if (shadowExpires !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(shadowExpires)))
      throw new JevConfigError(`jev.config.json: rails.${name}.shadowExpires must be YYYY-MM-DD`);
    if (mode === 'shadow' && !shadowExpires)
      throw new JevConfigError(
        `jev.config.json: rails.${name} is in shadow with no shadowExpires — shadow must expire (set a date ≤21 days out)`
      );
    rails[name] = { mode, thresholds, shadowExpires };
  }
  return { model, egress, rails };
}

/** Read `<root>/jev.config.json`. Missing ⇒ defaults; unreadable or malformed ⇒ throws. */
export function loadJevConfig({ root = repoRoot(), read = readFileSync, exists = existsSync } = {}) {
  // The `jev` section of golden-frijoles.config.json over the legacy jev.config.json (D9); validation stays here.
  const { raw, present } = readSection('jev', {
    root,
    legacyRead: read,
    legacyExists: exists,
    onLegacyError: (_path, e) => {
      throw new JevConfigError(`jev.config.json: unparseable (${e.message})`);
    },
  });
  // Absent everywhere → the defaults (every rail off). A PRESENT legacy file holding JSON null is malformed: the
  // parser throws.
  // No config at all is UNANSWERED, not "yes" (distribute-what-we-use D7). parseJevConfig({}) keeps
  // egress:true for a legacy FILE that never mentions it, but a stranger with no file has told us nothing,
  // and D12's promise is that nothing leaves the machine before an explicit `egress: true`.
  if (!present) return parseJevConfig({ egress: null });
  // D12: a section that never gives egress a non-null value is UNANSWERED, never `true`. readSection treats a
  // `null` in golden-frijoles.config.json as unset, so without this a new-file `egress: null` (or a migrated
  // template config) reached parseJevConfig as a MISSING key and became `true` — sending with nobody's yes
  // (review of the S5 diff). Only parseJevConfig called directly keeps the absent → true fallback.
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw.egress === undefined || raw.egress === null))
    return parseJevConfig({ ...raw, egress: null });
  return parseJevConfig(raw);
}

/** Parse `KEY=value` lines. Enough for .env.local; quotes stripped. */
export function envFileValue(text, key) {
  for (const line of String(text).split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] === key) return m[2].trim().replace(/^(['"])(.*)\1$/, '$2') || null;
  }
  return null;
}

/**
 * The API key: env first, then `.env.local` at the repo root, then the cwd. null when none. A variable that is SET
 * but empty (`TYPESAFE_API_KEY= node scripts/…`) means "no key" and stops the lookup: that is how a person turns Jev
 * off for one command, and falling through to `.env.local` made the command quietly use the key they had just
 * blanked (intent-match S1 smoke, 2026-09-29).
 */
export function readApiKey({
  env = process.env,
  root = repoRoot(),
  cwd = process.cwd(),
  read = readFileSync,
  exists = existsSync,
} = {}) {
  if (env.TYPESAFE_API_KEY !== undefined) return env.TYPESAFE_API_KEY.trim() || null;
  for (const dir of [root, cwd]) {
    const p = join(dir, '.env.local');
    if (!exists(p)) continue;
    try {
      const v = envFileValue(read(p, 'utf8'), 'TYPESAFE_API_KEY');
      if (v) return v;
    } catch {
      /* unreadable env file = no key from it */
    }
  }
  return null;
}

/**
 * The mode a rail ACTUALLY runs in, and why. `off` whenever Jev cannot legitimately be asked — egress
 * disabled or no key — so a missing key degrades to today's behaviour instead of logging failures.
 */
export function effectiveMode(config, rail, { key } = {}) {
  const configured = config.rails[rail].mode;
  // Unanswered (D12) is decided FIRST, before the rail's mode: every rail defaults to `off`, so checking
  // the mode first made the ask unreachable for exactly the user it was written for (D7). Distinct from a
  // deliberate `false` so the caller can ask once instead of staying silently off forever;
  // `unanswered: true` is jevContext's cue to fire the D11 protocol. Nothing is sent either way.
  if (config.egress === null) return { mode: 'off', configured, why: 'egress not answered', unanswered: true };
  if (configured === 'off') return { mode: 'off', configured, why: 'configured off' };
  if (!config.egress) return { mode: 'off', configured, why: 'egress disabled (jev.egress: false)' };
  if (!key) return { mode: 'off', configured, why: 'no TYPESAFE_API_KEY' };
  return { mode: configured, configured, why: `configured ${configured}` };
}

const could = (error) => ({ ok: false, state: 'could-not-look', error });

/** Serialized state size, the thing the 32k budget is about. */
export const stateSize = (state) => (typeof state === 'string' ? state : JSON.stringify(state)).length;

/**
 * Ask Jev. Returns `{ ok:true, answers, usage, model }` or `{ ok:false, state:'could-not-look', error }`.
 * Never throws. deps: { fetch, key, model, timeoutMs, sleep }.
 */
export async function askJev(req, deps = {}) {
  // The whole body is guarded: a circular or undefined `state`, a BigInt, a fetch that resolves to nothing —
  // any of them used to throw out of here and take the review down with it instead of falling back to the
  // regex (fresh review, PR #34). "Never throws" is the contract every caller relies on.
  try {
    return await askJevUnguarded(req ?? {}, deps);
  } catch (e) {
    return could(`internal: ${e?.message || e}`);
  }
}

async function askJevUnguarded({ state, questions }, deps) {
  const {
    fetch: doFetch = globalThis.fetch,
    key = readApiKey(),
    model = DEFAULT_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = deps;
  if (!key) return could('no key');
  if (typeof doFetch !== 'function') return could('no fetch in this runtime');
  const ids = Object.keys(questions ?? {});
  if (!ids.length) return could('no questions');
  if (state === undefined || state === null) return could('no state');
  if (stateSize(state) > STATE_CHAR_BUDGET) return could(`state too large (${stateSize(state)} chars)`);

  const body = JSON.stringify({ state, model, questions });
  for (let attempt = 0; ; attempt++) {
    // ONE deadline per attempt, covering the body read too: clearing it once headers arrived let a stalled
    // body hang until the runtime's own ~300 s body timeout (fresh review, PR #34).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let outcome;
    try {
      outcome = await attemptOnce({ doFetch, body, key, signal: ctrl.signal, ids, model });
    } catch (e) {
      outcome = {
        done: could(ctrl.signal.aborted ? `timeout after ${timeoutMs}ms` : `network: ${e?.message || e}`),
      };
    } finally {
      clearTimeout(timer);
    }
    if (outcome.retry && attempt < MAX_RETRIES) {
      await sleep(outcome.retryAfterMs ?? 250 * 2 ** attempt);
      continue;
    }
    return outcome.done ?? could(`HTTP ${outcome.status}`);
  }
}

/** One HTTP attempt, body included. Returns { done } or { retry, status, retryAfterMs }. May throw (caller maps). */
async function attemptOnce({ doFetch, body, key, signal, ids, model }) {
  const res = await doFetch(JEV_ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body,
    signal,
  });
  if (!res || typeof res.status !== 'number') return { done: could('no response') };
  if (RETRY_STATUSES.has(res.status)) {
    const after = Number(res.headers?.get?.('retry-after'));
    return {
      retry: true,
      status: res.status,
      retryAfterMs: Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 4000) : undefined,
    };
  }
  if (res.status !== 200) {
    let detail = '';
    try {
      detail = String(await res.text()).slice(0, 160);
    } catch {
      /* no body */
    }
    return { done: could(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`) };
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    if (signal.aborted) throw e;
    return { done: could('unparseable response body') };
  }
  const answers = json?.answers;
  const missing = ids.filter((id) => !answers || typeof answers[id] !== 'object' || answers[id] === null);
  if (missing.length) return { done: could(`response missing answers: ${missing.slice(0, 3).join(', ')}`) };
  return { done: { ok: true, answers, usage: json.usage ?? null, model: json.model ?? model } };
}

/** A stable, short content hash — the log's join key without having to compare whole texts. */
export const textHash = (text) =>
  createHash('sha256')
    .update(String(text ?? ''))
    .digest('hex')
    .slice(0, 16);

export const LOG_TEXT_LIMIT = 4000;

/**
 * Append one decision to `<root>/.jev/decisions.jsonl`. A write failure WARNS and returns false: the log is
 * evidence about a decision, never a reason to change or abort one.
 */
export function logDecision(entry, deps = {}) {
  const {
    root = repoRoot(),
    append = appendFileSync,
    mkdir = mkdirSync,
    now = () => new Date().toISOString(),
    warn = (m) => process.stderr.write(`${m}\n`),
  } = deps;
  try {
    const text = String(entry.text ?? '');
    const line = {
      rail: entry.rail,
      mode: entry.mode,
      decider: entry.decider,
      regex: entry.regex ?? null,
      jev: entry.jev ?? null,
      confidence: entry.confidence ?? null,
      textHash: textHash(text),
      text: text.length > LOG_TEXT_LIMIT ? `${text.slice(0, LOG_TEXT_LIMIT)}…[truncated]` : text,
      ...(entry.sha ? { sha: entry.sha } : {}),
      ...(entry.source ? { source: entry.source } : {}),
      ...(entry.evidence ? { evidence: entry.evidence } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ts: now(),
    };
    const dir = join(root, '.jev');
    // Owner-only: the log quotes reviewer replies and drafts, which can quote private code (PR #35 security lens).
    mkdir(dir, { recursive: true, mode: 0o700 });
    append(join(dir, 'decisions.jsonl'), `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return true;
  } catch (e) {
    warn(`⚠ jev: could not write the decision log (${e?.message || e}) — the decision stands.`);
    return false;
  }
}

/**
 * Everything a judge needs, resolved once: config, key, effective mode. deps can override any of it (specs).
 * A malformed config THROWS here — loud, never silently off.
 */
export function jevContext(rail, deps = {}) {
  const root = deps.root ?? repoRoot();
  const config = deps.config ?? loadJevConfig({ root });
  const key = 'key' in deps ? deps.key : readApiKey({ root });
  const eff = effectiveMode(config, rail, { key });
  // D11's ask protocol, fired exactly once (needSetting's own dedup): egress was never answered, so
  // tell the agent to ask instead of leaving the guard silently off forever. Non-blocking — a judge
  // still returns a decision this run, via the regex fallback the caller already has for `mode:'off'`.
  if (eff.unanswered) {
    (deps.needSetting ?? needSetting)('jev.egress', {
      blocking: false,
      root,
      ...(deps.read ? { read: deps.read } : {}),
      ...(deps.exists ? { exists: deps.exists } : {}),
      ...(deps.write ? { write: deps.write } : {}),
    });
  }
  return {
    root,
    config,
    hasKey: Boolean(key),
    ...eff,
    rail: config.rails[rail],
    ask: deps.ask ?? ((req) => askJev(req, { key, model: config.model, fetch: deps.fetch })),
    log: deps.log ?? ((entry) => logDecision(entry, { root })),
  };
}
