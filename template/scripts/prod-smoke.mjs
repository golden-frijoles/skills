#!/usr/bin/env node
// prod-smoke.mjs — the daily production watchdog's checks, as a reviewable file.
//
// WHY THIS EXISTS AS A FILE. In the project this was ported from, the "prod smoke (daily)" routine
// predated the committed routines in scripts/routines/ and carried its assertions ONLY in the cloud
// routine prompt in the product owner's account — no git source, so no epic could ever update it. That
// cost twice:
//
//   1. market-architecture-foundation (shipped 2026-07-31) moved `/l` → `/mx/l` behind a one-hop
//      308. It updated lib/markets.ts in both repos with golden drift specs and updated the e2e
//      specs — and could not touch this smoke, which had no file to edit. The watchdog went red on
//      2026-08-05 against a route that had been correct for five days.
//   2. The same cutover turned `/` from the marketplace into a market SELECTOR. The homepage check
//      kept returning 200 and stayed green while silently testing a different page, and the real
//      marketplace lost smoke coverage entirely with no signal at all.
//
// (2) is the reason the checks in prod-smoke.checks.mjs assert IDENTITY, not just a status code. A 200 tells you
// something answered; it does not tell you the right thing answered. Every check that guards a
// rendered page therefore carries a structural body marker.
//
// This watchdog earned its keep there — it caught a data defect CI reported green on. That is exactly
// why its assertions belong under review rather than in a text box.
//
// THE RULE THAT CONSTRAINS EVERY EDIT TO THE CHECKS: never make a red smoke pass by weakening it
// (scripts/routines/smoke-triage.prompt.md). When a route moves, re-point the check at the new
// contract and, where the move itself is a contract worth keeping, assert the move too. Do not
// relax an assertion to silence a red run — the origin's precedent was a strict assertion deliberately
// CONFIRMED rather than loosened.
//
// ── THE CHECKS ARE THE PROJECT'S (plugin-audit-and-extraction S3.1) ──────────────────────────────
// This file is the ENGINE: fetch, evaluate, three-valued exit. The assertions live in the project's
// committed scripts/prod-smoke.checks.mjs, which exports `BASE` (the production origin) and `CHECKS`
// (declarative checks — status, media type, identity markers, redirect targets, JSON shape, and
// `dependsOn`/`pathFrom` for a check whose path is derived from another's response). It is a module,
// not JSON, precisely so a derived check can hold code; it is still one reviewed file. Copy
// prod-smoke.checks.example.mjs to start. No checks file → exit 2 ("could not check"), never 0.
//
//   node scripts/prod-smoke.mjs             # run every check, human-readable report
//   node scripts/prod-smoke.mjs --json      # same, machine-readable
//   node scripts/prod-smoke.mjs --base=...  # point at another origin (default: the checks file's BASE)
//
// Exit codes are three-valued on purpose (AGENTS.md — "three states, never two"):
//   0  every check passed
//   1  at least one check FAILED (an assertion was observed false)
//   2  no failures, but at least one check was UNAVAILABLE (could not be observed at all)
// A run that could not check something must never exit 0. "I could not look" is not "it is fine".

import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { isMain } from './lib/is-main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CHECKS_PATH = join(__dirname, 'prod-smoke.checks.mjs');

// JSON media types. `application/*+json` is legal and common, so it is matched by suffix rather
// than enumerated — but `application/jsonp` and `text/notjson` are NOT JSON and must not pass, which
// is exactly what substring matching on "json" let through.
export function isJsonMediaType(mediaType) {
  if (!mediaType) return false;
  // The shape is validated before the suffix is trusted: `garbage+json` has no type/subtype at all
  // and is not a media type, so accepting it on the strength of its ending would be the same
  // substring mistake one level down.
  if (!/^[a-z0-9][a-z0-9!#$&^_.-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType)) return false;
  if (mediaType === 'application/json' || mediaType === 'text/json') return true;
  // Safe on the whole string once the shape holds: a valid media type has its `/` before the
  // subtype, so nothing but the subtype can carry the suffix.
  return mediaType.endsWith('+json');
}

// The JavaScript media types, as an explicit allow-list. Substring matching accepted
// `text/notjavascript`; this compares the parsed type, so only real ones pass.
export const JS_MEDIA_TYPES = [
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/ecmascript',
  'application/ecmascript',
];

/**
 * Pure: does this Content-Security-Policy permit an arbitrary third-party site to frame the page?
 *
 * Parsed, not substring-matched, and the distinction is the whole point: `frame-ancestors 'none'`
 * contains the text "frame-ancestors", and `frame-ancestors *.acme.example` even contains
 * "frame-ancestors *", yet both forbid the third-party framing a seller's embed depends on. Only a
 * bare `*` in the source list actually permits it.
 */
export function framesAllowedFromAnywhere(csp) {
  if (!csp) return false;

  // A header can carry MULTIPLE comma-separated policies (that is how several CSP headers arrive
  // merged), and a browser enforces every one of them — framing is permitted only if they ALL
  // permit it. Reading just the first directive accepted
  // `frame-ancestors *; default-src 'self', frame-ancestors 'none'`, which no browser will frame.
  const directives = String(csp)
    .split(',')
    .map((policy) =>
      policy
        .split(';')
        .map((d) => d.trim())
        .find((d) => /^frame-ancestors\b/i.test(d))
    )
    .filter(Boolean);

  // No directive anywhere = framing is not PROVEN. This check exists to prove it, not to assume it.
  if (directives.length === 0) return false;
  return directives.every((d) => d.split(/\s+/).slice(1).includes('*'));
}

/**
 * Pure: work out the path a check should hit, given the results of the checks before it.
 *
 * Returns one of three shapes, and which one matters:
 *   `{ path, expect? }`      — go and look; `expect` merges over the check's static expectations
 *   `{ unavailable: reason }` — we could not determine what to look at
 *   `{ failed: reason }`      — we determined it, and what we saw is already wrong
 *
 * A dependent check whose DEPENDENCY did not pass is unavailable, never failed: reporting "the
 * iframe is broken" when we never learned which iframe to look at would be a confident falsehood.
 * But a dependency that passed while emitting something invalid is a real, observed failure — see
 * the blank-slug branch in the embed check above.
 */
export function resolvePath(check, priorResults) {
  if (!check.dependsOn) return { path: check.path };

  const dep = priorResults.find((r) => r.id === check.dependsOn);
  if (!dep) return { unavailable: `dependency "${check.dependsOn}" did not run` };
  if (dep.status !== 'pass') {
    return { unavailable: `dependency "${check.dependsOn}" was ${dep.status}` };
  }
  return check.pathFrom(dep.body);
}

/**
 * Pure: reduce a Location header to the path+query the check asserts against.
 *
 * HTTP permits either form, and a framework or CDN can switch between them without changing
 * behaviour at all — `Location: https://<prod>/mx/l` is the same one-hop redirect as
 * `Location: /mx/l`. Comparing the raw string would redden on correct output, which is the guard
 * failure mode AGENTS.md singles out as worse than missing a fault. A CROSS-ORIGIN absolute target
 * is deliberately left un-normalized: sending buyers to another origin is a real difference, and it
 * must not quietly compare equal to a local path.
 *
 * "Same origin" means same origin as the BASE BEING CHECKED, not as production. Hardcoding
 * a default base here made `--base=https://staging.<prod>` report every absolute redirect
 * as cross-origin and fail a correct run — a false red on the one flag that exists to point this
 * script somewhere other than prod.
 */
export function normalizeLocation(location, base) {
  // The empty guard IS load-bearing: `new URL(null, base)` resolves happily to a "/null" path, so
  // without it a MISSING Location header would silently become a plausible-looking one.
  if (!location || !base) return location;
  try {
    // Resolved as a URI REFERENCE against the checked URL, which handles all three legal forms
    // uniformly: absolute, root-relative, and protocol-relative (`//host/path` — legal, resolved by
    // every browser to the same target, and previously compared as a literal string and failed).
    const url = new URL(location, base);
    if (url.origin !== new URL(base).origin) return location;
    return `${url.pathname}${url.search}`;
  } catch {
    return location;
  }
}

/** Pure: read a dotted path out of a parsed document, undefined if any segment is absent. */
export function readJsonPath(doc, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), doc);
}

/**
 * Pure: why `value` fails to be a non-empty `kind`, or null when it is fine.
 * A bare presence check is not enough — a field can be present, non-empty AND the wrong shape.
 */
export function describeShapeProblem(value, kind) {
  if (value === undefined || value === null) return 'is missing';
  if (kind === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      return `is ${Array.isArray(value) ? 'an array' : typeof value}, expected an object`;
    }
    return Object.keys(value).length === 0 ? 'is an empty object' : null;
  }
  if (kind === 'array') {
    if (!Array.isArray(value)) return `is ${typeof value}, expected an array`;
    return value.length === 0 ? 'is an empty array' : null;
  }
  if (typeof value !== kind) return `is ${typeof value}, expected ${kind}`;
  return String(value).length === 0 ? 'is empty' : null;
}

/**
 * Pure: the media type from a Content-Type header — lowercased, parameters stripped.
 * `text/javascript; charset=utf-8` -> `text/javascript`.
 */
export function parseMediaType(contentType) {
  if (!contentType) return null;
  return String(contentType).split(';')[0].trim().toLowerCase();
}

/** Pure: does this expectation need the response body at all? */
export function wantsBody(want) {
  return Boolean(
    want.bodyIsJson ||
    want.bodyIncludes?.length ||
    want.bodyExcludes?.length ||
    want.bodyJsonMatches ||
    want.bodyJsonIncludes ||
    want.bodyJsonRequires ||
    want.bodyJsonPaths
  );
}

/**
 * Pure: compare one observation against one check's expectations.
 *
 * `observation` is either `{ status, location, body }` or `{ error }` — a transport-level error
 * (DNS, TLS, timeout, connection refused) is UNAVAILABLE, not a failure. We did not observe the
 * assertion to be false; we failed to observe it at all. Collapsing the two would report an
 * outage in our own sandbox as an outage in production.
 */
export function evaluateCheck(check, observation, base) {
  const result = { id: check.id, name: check.name };

  if (observation?.error) {
    return { ...result, status: 'unavailable', detail: `could not reach it: ${observation.error}` };
  }

  const { status, location, body, headers } = observation;
  const want = check.expect;
  const problems = [];

  if (status !== want.status) {
    problems.push(`expected HTTP ${want.status}, got ${status}`);
  }
  if (want.location !== undefined) {
    const got = normalizeLocation(location, base);
    if (got !== want.location) {
      problems.push(
        `expected redirect to "${want.location}", got ${location ? `"${location}"` : 'no Location header'}`
      );
    }
  }
  // Body-dependent assertions are evaluated ONLY when the body was actually read. An unread body
  // is not a wrong body: judging `null` as "not parseable JSON" would convert a stalled read into a
  // confident claim about content nobody saw. The bodyError branch at the end reports it honestly.
  const bodyWasRead = !observation.bodyError;
  if (want.bodyIsJson && bodyWasRead) {
    try {
      JSON.parse(body ?? '');
    } catch {
      problems.push('body is not parseable JSON, despite the response announcing JSON');
    }
  }
  // Structural field assertions on a JSON document. A substring match cannot tell the manifest from
  // an error object that merely quotes the manifest's name.
  if (
    (want.bodyJsonMatches || want.bodyJsonIncludes || want.bodyJsonRequires || want.bodyJsonPaths) &&
    bodyWasRead
  ) {
    let doc;
    try {
      doc = JSON.parse(body ?? '');
    } catch {
      doc = undefined; // bodyIsJson already reported the parse failure; don't say it twice.
    }
    if (doc !== undefined) {
      for (const [field, expected] of Object.entries(want.bodyJsonMatches ?? {})) {
        if (doc?.[field] !== expected) {
          problems.push(
            `JSON field "${field}" is ${JSON.stringify(doc?.[field])}, expected ${JSON.stringify(expected)}`
          );
        }
      }
      for (const [field, kind] of Object.entries(want.bodyJsonRequires ?? {})) {
        const value = doc?.[field];
        const problem = describeShapeProblem(value, kind);
        if (problem) problems.push(`JSON field "${field}" ${problem}`);
      }
      for (const [path, kind] of Object.entries(want.bodyJsonPaths ?? {})) {
        const problem = describeShapeProblem(readJsonPath(doc, path), kind);
        if (problem) problems.push(`JSON path "${path}" ${problem}`);
      }
      for (const [field, required] of Object.entries(want.bodyJsonIncludes ?? {})) {
        const value = doc?.[field];
        if (!Array.isArray(value)) {
          problems.push(`JSON field "${field}" is not an array`);
          continue;
        }
        for (const entry of required) {
          if (!value.includes(entry)) {
            problems.push(`JSON field "${field}" does not include ${JSON.stringify(entry)}`);
          }
        }
      }
    }
  }
  if (want.mediaTypeIsJson && !isJsonMediaType(parseMediaType(headers?.['content-type']))) {
    const actual = parseMediaType(headers?.['content-type']);
    problems.push(
      actual
        ? `media type is ${JSON.stringify(actual)}, which is not a JSON media type`
        : 'no content-type header, so the media type could not be checked'
    );
  }
  if (want.mediaTypeIn) {
    const actual = parseMediaType(headers?.['content-type']);
    if (!actual) {
      problems.push('no content-type header, so the media type could not be checked');
    } else if (!want.mediaTypeIn.includes(actual)) {
      problems.push(
        `media type is ${JSON.stringify(actual)}, expected one of ${JSON.stringify(want.mediaTypeIn)}`
      );
    }
  }
  if (want.framesFromAnywhere && !framesAllowedFromAnywhere(headers?.['content-security-policy'])) {
    const csp = headers?.['content-security-policy'];
    problems.push(
      csp
        ? `content-security-policy is ${JSON.stringify(csp)}, which does not permit third-party framing`
        : 'no content-security-policy header, so third-party framing is not proven'
    );
  }
  for (const [name, needle] of Object.entries(want.headerIncludes ?? {})) {
    // Lowercased on BOTH sides: `observe` stores header names lowercased, so a check spelling one
    // `Content-Type` would look up a key that is never there and report a missing header on a
    // response that carried it.
    const value = headers?.[name.toLowerCase()];
    // A needle may be a single substring or a SET of acceptable ones (the JavaScript media types
    // are a set) — any one matching satisfies the expectation.
    const accepted = Array.isArray(needle) ? needle : [needle];
    if (value === undefined || value === null) {
      problems.push(`missing the ${name} header (expected it to contain ${JSON.stringify(needle)})`);
    } else if (!accepted.some((n) => String(value).toLowerCase().includes(String(n).toLowerCase()))) {
      problems.push(
        `${name} is ${JSON.stringify(String(value))}, expected it to contain ${JSON.stringify(needle)}`
      );
    }
  }
  for (const needle of bodyWasRead ? (want.bodyIncludes ?? []) : []) {
    if (!(body ?? '').includes(needle)) {
      problems.push(`body is missing the marker ${JSON.stringify(needle)}`);
    }
  }
  for (const needle of bodyWasRead ? (want.bodyExcludes ?? []) : []) {
    if ((body ?? '').includes(needle)) {
      problems.push(`body unexpectedly contains ${JSON.stringify(needle)}`);
    }
  }

  // A concrete observed failure OUTRANKS an incomplete read: if the status or headers already prove
  // the check false, say so, even though the body never arrived.
  if (problems.length > 0) {
    return { ...result, status: 'fail', detail: problems.join('; ') };
  }

  // Nothing was observed false, but a body-dependent expectation could not be evaluated at all —
  // that is the third state, not a pass. Claiming pass here would be the "I could not check, so it
  // must be fine" collapse this whole script exists to prevent.
  if (observation.bodyError && wantsBody(want)) {
    return {
      ...result,
      status: 'unavailable',
      detail: `HTTP ${status}, but the body could not be read (${observation.bodyError}) — its identity assertions were not evaluated`,
    };
  }

  return { ...result, status: 'pass', detail: `HTTP ${status}`, body };
}

/** Pure: roll per-check results into the run verdict + exit code. */
export function summarize(results) {
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const unavailable = results.filter((r) => r.status === 'unavailable').length;

  // Order matters: a failure outranks an unavailability, and neither is ever green.
  let exitCode = 0;
  if (failed > 0) exitCode = 1;
  else if (unavailable > 0) exitCode = 2;

  return { total: results.length, passed, failed, unavailable, exitCode };
}

/** Pure: render the report a human (or the routine) reads. */
export function formatReport(results, summary, base) {
  const icon = { pass: '✅', fail: '❌', unavailable: '⚠️ ' };
  const lines = [`prod smoke — ${base}`, ''];

  for (const r of results) {
    lines.push(`${icon[r.status]} ${r.name} — ${r.detail}`);
  }

  lines.push('');
  // The verdict word carries the same three states the exit code does. Calling an all-unavailable
  // run "FAILED" would report production as broken when the truth is that we could not look at it —
  // the exact collapse this script exists to avoid.
  const tally = `${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.unavailable} unavailable`;
  let verdict;
  if (summary.exitCode === 0) {
    verdict = `PASSED ${summary.passed}/${summary.total} checks`;
  } else if (summary.failed > 0) {
    verdict = `FAILED — ${tally}`;
  } else if (summary.passed === 0) {
    verdict = `UNAVAILABLE — ${tally}. Nothing was observed broken; nothing was observed working either.`;
  } else {
    // The mixed case needs its own sentence. Saying "nothing was observed working" after reporting
    // seven passes is simply false, and the routine copies this line into the product owner's alert — so the
    // wrong words here become the wrong words on his phone at 4am.
    verdict = `UNAVAILABLE — ${tally}. What was checked looked healthy; ${summary.unavailable} check(s) could not be observed at all.`;
  }
  lines.push(verdict);

  if (summary.unavailable > 0) {
    lines.push('');
    lines.push(
      'An UNAVAILABLE check was not observed at all — it is not evidence that the thing is healthy.'
    );
  }
  return lines.join('\n');
}

// ---- I/O shell ----

/** Fetch one URL without following redirects, so a 308 stays observable as a 308. */
async function observe(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { redirect: 'manual', signal: controller.signal });
    // Header names are case-insensitive on the wire; lowercase them once here so the check table
    // can spell them one way and the pure evaluator never has to care.
    const headers = {};
    for (const [name, value] of res.headers) headers[name.toLowerCase()] = value;
    const observed = { status: res.status, location: res.headers.get('location'), headers };

    // The body is read SEPARATELY so a stalled body cannot discard a status we already have. A 500
    // whose body then times out is an observed failure — reporting it as "could not reach it" would
    // route a concrete production fault down the unavailability path and lose the 500 entirely.
    try {
      return { ...observed, body: await res.text() };
    } catch (bodyErr) {
      return { ...observed, body: null, bodyError: String(bodyErr?.message ?? bodyErr) };
    }
  } catch (err) {
    return {
      error: err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run every check against `base`. Degrades per check: one unreachable URL marks itself unavailable
 * and the run carries on, so a single dead endpoint never hides the state of the other seven.
 */
export async function runChecks(base, deps = {}) {
  const { checks } = deps;
  if (!Array.isArray(checks) || checks.length === 0) throw new Error('runChecks: no checks given');
  // Normalized here too, not only in main(): a programmatic caller passing a trailing slash would
  // otherwise build `https://host//embed.js`, and a doubled path segment is its own bug hunt.
  const origin = String(base).replace(/\/$/, '');
  const results = [];
  for (const check of checks) {
    const resolved = resolvePath(check, results);
    if (resolved.unavailable) {
      results.push({ id: check.id, name: check.name, status: 'unavailable', detail: resolved.unavailable });
      continue;
    }
    if (resolved.failed) {
      results.push({ id: check.id, name: check.name, status: 'fail', detail: resolved.failed });
      continue;
    }
    const observation = await observe(`${origin}${resolved.path}`, deps);
    // Derived expectations (the embed check's per-shop identity marker) merge over the static ones.
    const effective = resolved.expect ? { ...check, expect: { ...check.expect, ...resolved.expect } } : check;
    results.push(evaluateCheck(effective, observation, origin));
  }
  return results;
}

/**
 * Load the project's checks module. Every way it can fail — absent, a syntax error, no `CHECKS`, an
 * empty `CHECKS` — is "could not look" (state 2), NEVER state 1: exit 1 means an assertion was
 * OBSERVED false, and the triage routine treats it as a production regression. A typo in the checks
 * file must not page anyone about production.
 * Returns `{ ok: true, BASE, CHECKS }` or `{ ok: false, error }`. `importer` is injectable for tests.
 */
export async function loadChecks(
  path = CHECKS_PATH,
  { exists = existsSync, importer = (p) => import(pathToFileURL(p).href) } = {}
) {
  if (!exists(path)) {
    return {
      ok: false,
      error:
        `${path} not found — no assertions to run.\n` +
        '  Copy scripts/prod-smoke.checks.example.mjs to scripts/prod-smoke.checks.mjs and fill in your checks.',
    };
  }
  let mod;
  try {
    mod = await importer(path);
  } catch (e) {
    return { ok: false, error: `${path} failed to load (${e.message}) — no assertions ran.` };
  }
  if (!Array.isArray(mod?.CHECKS) || mod.CHECKS.length === 0) {
    return { ok: false, error: `${path} exports no CHECKS (or an empty array) — no assertions to run.` };
  }
  return { ok: true, BASE: mod.BASE, CHECKS: mod.CHECKS };
}

async function main() {
  const { values } = parseArgs({
    options: { json: { type: 'boolean' }, base: { type: 'string' } },
    allowPositionals: false,
  });
  // No usable checks is "could not look", which is state 2 — never a green run over nothing.
  const loaded = await loadChecks();
  if (!loaded.ok) {
    console.error(`prod-smoke: ${loaded.error}`);
    process.exitCode = 2;
    return;
  }
  const { BASE, CHECKS } = loaded;
  if (!values.base && !BASE) {
    console.error('prod-smoke: prod-smoke.checks.mjs exports no BASE and no --base was given.');
    process.exitCode = 2;
    return;
  }
  const base = (values.base ?? BASE).replace(/\/$/, '');

  const results = await runChecks(base, { checks: CHECKS });
  const summary = summarize(results);

  if (values.json) {
    // Drop the retained bodies — they exist only to feed dependent checks, and a full page of HTML
    // in the report would bury the result it is supposed to communicate.
    const slim = results.map(({ body: _body, ...rest }) => rest);
    console.log(JSON.stringify({ base, summary, results: slim }, null, 2));
  } else {
    console.log(formatReport(results, summary, base));
  }
  // `process.exitCode` rather than `process.exit()`: the latter tears the process down immediately
  // and can TRUNCATE stdout when it is a pipe rather than a TTY. The report is the routine's whole
  // diagnostic input — a half-written one would have it triaging a failure it cannot fully read.
  process.exitCode = summary.exitCode;
}

// NOT a top-level await: main() imports the project's prod-smoke.checks.mjs, which imports helpers
// (JS_MEDIA_TYPES) from THIS module. Awaiting here would leave this module mid-evaluation while that
// import waits on it — a deadlock that exits 13 with an "unsettled top-level await" warning.
// Anything main() throws past that is also "could not look": an unhandled rejection would exit 1,
// which the triage routine would read as a production regression.
if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(`prod-smoke: could not run the checks — ${e.stack || e.message}`);
    process.exitCode = 2;
  });
}
