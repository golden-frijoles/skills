#!/usr/bin/env node
// perf-probe.mjs — raw transfer baseline for the project's production runtime.
//
// Ported from the origin project by plugin-audit-and-extraction S3.2. Fetch and
// Playwright transparently decompress bodies;
// this deliberately uses node:https so byte counts are the bytes received on
// the wire (with an explicit Accept-Encoding), which is what a transfer budget
// must police. It is a reporting read only: --dry-run makes no network call.
//
// WHAT to probe is the project's: perf-probe.config.json at the repo root —
//   { "baseUrl": "https://example.com",
//     "targets": [ { "id": "home", "label": "home (signed-out)", "path": "/" },
//                   { "id": "image", "label": "cold real image variant", "path": "/api/img?…", "image": true } ] }
// Pick REAL, live pages — a fixture that 404s measures an error page. No config → a clear error, never
// a probe of someone else's site.
//
// ── It only requests the hosts a project names (template-scripts-consumer-gates D7) ──────────────
// This runs in CI from a config any PR can edit, so a `baseUrl` of http://169.254.169.254 would point the
// runner at its own cloud metadata service. Three checks, none of which `allowPrivate` widens except the first:
//   1. No private, loopback or link-local address (isPrivateAddress) unless `smoke.perf.allowPrivate: true`
//      — a literal `true`, for probing a local build. Checked before ANY request (each host resolved, every
//      address it returns), and again AT CONNECT: every request's `lookup` is guardedLookup, so the socket
//      connects only to an address that was checked. A name that re-resolves to a private address between
//      the two (DNS rebinding) is refused at connect.
//   2. Client scripts only from the page's own origin. One on another origin is refused and the fixture is
//      red, never silently skipped (skipping would under-count the bytes).
//   3. Redirects are never followed (node:http/https do not; a 3xx is already `absent`).
// Residuals: node:http ignores HTTP(S)_PROXY, so a proxy cannot route around the check; NAT64 64:ff9b::/96
// is not refused (it embeds a public IPv4 on a NAT64 network); whatever sits behind `allowPrivate: true` is
// the operator's choice.

import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'perf-probe.config.json')
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { readSection } from './lib/config.mjs'
import { isMain } from './lib/is-main.mjs'

const MODERN_IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'

/** Read + validate perf-probe.config.json. Throws naming the file — there is no default target. */
export function loadProbeConfig({ path = CONFIG_PATH, exists = existsSync, read = readFileSync } = {}) {
  // `smoke.perf` in golden-frijoles.config.json over the legacy file (D9); validation stays here.
  const { raw, present } = readSection('smoke.perf', { legacyExists: exists, legacyRead: read, legacyPath: path, onLegacyError: (_p, e) => { throw e } })
  if (!present) throw new Error(`${path} not found — copy perf-probe.config.example.json and list your real pages`)
  if (!/^https?:\/\//.test(raw.baseUrl || '')) throw new Error(`${path}: "baseUrl" must be an http(s) URL`)
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) throw new Error(`${path}: "targets" must list at least one page`)
  for (const [i, t] of raw.targets.entries()) {
    if (!t?.id || !t?.label || typeof t.path !== 'string' || !t.path.startsWith('/')) {
      throw new Error(`${path}: "targets[${i}]" needs id, label and a path starting with "/"`)
    }
  }
  return { baseUrl: raw.baseUrl, targets: raw.targets, allowPrivate: raw.allowPrivate === true }
}

// Loopback, private, link-local, shared, benchmark, documentation, multicast and reserved ranges. An IPv4-mapped
// IPv6 address (::ffff:a.b.c.d, either spelling) is matched against the IPv4 rules by BlockList itself.
const PRIVATE_RANGES = [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.0.0.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['64:ff9b:1::', 48, 'ipv6'], ['100::', 64, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
]
const PRIVATE = new net.BlockList()
for (const [address, prefix, family] of PRIVATE_RANGES) PRIVATE.addSubnet(address, prefix, family)

/** True for an address the probe must not reach without `allowPrivate`. Anything that is not an IP is refused too. */
export function isPrivateAddress(address) {
  const family = net.isIP(address)
  if (family === 4) return PRIVATE.check(address, 'ipv4')
  if (family === 6) return PRIVATE.check(address, 'ipv6')
  return true
}

/** The host of `url` as an address or a name: brackets dropped from an IPv6 literal. */
export function hostOf(url) {
  const host = new URL(url).hostname
  return host.startsWith('[') ? host.slice(1, -1) : host
}

export function refusal(url, address) {
  return new Error(`refusing ${url}: ${address} is a private, loopback or link-local address. Set smoke.perf.allowPrivate: true to probe a host on your own network.`)
}

/** Throws when `url`'s host is a private IP literal. A name is left to resolveAllowed / guardedLookup. */
export function assertLiteralAllowed(url, { allowPrivate = false } = {}) {
  const host = hostOf(url)
  if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) throw refusal(url, host)
}

/**
 * Before any request: refuse a name when ANY address it resolves to is private. A name that does not resolve is
 * not refused here; its request then fails and the fixture is `unavailable`.
 */
export async function assertResolvedAllowed(url, { allowPrivate = false, lookupAll = (h) => dns.promises.lookup(h, { all: true }) } = {}) {
  assertLiteralAllowed(url, { allowPrivate })
  const host = hostOf(url)
  if (allowPrivate || net.isIP(host)) return
  let addresses
  try {
    addresses = await lookupAll(host)
  } catch {
    return
  }
  const bad = addresses.find((a) => isPrivateAddress(a.address))
  if (bad) throw refusal(url, `${bad.address} (${host})`)
}

/**
 * A `lookup` for http(s).request that checks the address the socket will connect to, so nothing can re-resolve a
 * name between the check and the connect. Serves both callback forms: Node's autoSelectFamily asks for `all`.
 */
export function guardedLookup({ allowPrivate = false, lookup = dns.lookup } = {}) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback
    const opts = typeof options === 'function' ? {} : typeof options === 'number' ? { family: options } : options ?? {}
    lookup(hostname, { ...opts, all: true }, (error, addresses) => {
      if (error) return cb(error)
      const bad = !allowPrivate && addresses.find((a) => isPrivateAddress(a.address))
      if (bad) return cb(refusal(`//${hostname}`, `${bad.address} (${hostname})`))
      if (opts.all) return cb(null, addresses)
      const first = addresses[0]
      return cb(null, first.address, first.family)
    })
  }
}

// `imageUrl`, when given, replaces ONLY the image target's URL (an explicit, named substitution).
export function fixtureUrls({ baseUrl, imageUrl = null, targets }) {
  const base = baseUrl.replace(/\/$/, '')
  return targets.map((t) => ({
    id: t.id,
    label: t.label,
    url: t.image && imageUrl ? imageUrl : `${base}${t.path}`,
    ...(t.image ? { image: true } : {}),
  }))
}

export function parseArgs(argv) {
  const out = { baseUrl: null, imageUrl: null, json: false, dryRun: false, revision: null, help: false }
  const assignValue = (arg, value) => {
    if (!value?.trim()) throw new Error(`${arg} requires a non-blank value`)
    const key = { '--base-url': 'baseUrl', '--image-url': 'imageUrl', '--revision': 'revision' }[arg]
    out[key] = arg === '--revision' ? value.trim() : value
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') out.json = true
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '-h' || arg === '--help') out.help = true
    else if (arg === '--base-url' || arg === '--image-url' || arg === '--revision') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      assignValue(arg, value)
    } else if (arg.startsWith('--base-url=')) assignValue('--base-url', arg.slice('--base-url='.length))
    else if (arg.startsWith('--image-url=')) assignValue('--image-url', arg.slice('--image-url='.length))
    else if (arg.startsWith('--revision=')) assignValue('--revision', arg.slice('--revision='.length))
    else throw new Error(`unknown argument '${arg}'`)
  }
  return out
}

export const HELP = `perf-probe.mjs — raw compressed transfer baseline

Usage:
  node scripts/perf-probe.mjs [--json] [--base-url <url>] [--image-url <url>] [--revision <id>] [--dry-run]

Fixtures: the targets in perf-probe.config.json (--base-url overrides its baseUrl).
--image-url replaces only the target marked image; it is never silently substituted.
--dry-run prints the configured fixtures and makes no network calls or writes.`

function metric(state, value, detail) {
  return { state, ...(value === undefined ? {} : { value }), ...(detail ? { detail } : {}) }
}

export function requestTransport(url, deps = {}) {
  const protocol = new URL(url).protocol
  if (protocol === 'http:') return deps.httpRequest ?? http.request
  if (protocol === 'https:') return deps.httpsRequest ?? https.request
  throw new Error(`unsupported URL protocol '${protocol}'`)
}

export function rawRequest(url, { headers = {}, timeoutMs = 30_000, allowPrivate = false } = {}, deps = {}) {
  return new Promise((resolve, reject) => {
    // An IP-literal host never reaches `lookup` (Node connects to it directly), so it is checked here.
    assertLiteralAllowed(url, { allowPrivate })
    const startedAt = process.hrtime.bigint()
    const transport = deps.transport ?? requestTransport(url, deps)
    const req = transport(url, {
      method: 'GET',
      lookup: guardedLookup({ allowPrivate, ...(deps.dnsLookup ? { lookup: deps.dnsLookup } : {}) }),
      headers: {
        // https.request does not auto-decompress. Explicitly negotiate normal
        // CDN encodings so the collected chunks are the real transfer payload.
        'accept-encoding': 'gzip, br, deflate',
        'user-agent': 'perf-probe/1.0',
        ...headers,
      },
    }, (res) => {
      const ttfbMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      let bytes = 0
      const chunks = []
      res.on('data', (chunk) => { bytes += chunk.length; chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', () => resolve({
        url,
        statusCode: res.statusCode ?? 0,
        headers: res.headers,
        bytes,
        body: Buffer.concat(chunks),
        ttfbMs,
      }))
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)))
    req.on('error', reject)
    req.end()
  })
}

export function extractClientScriptUrls(html, pageUrl) {
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1])
    .filter((src) => /\/_next\/static\/.+\.js(?:\?|$)/.test(src))
  return [...new Set(srcs.map((src) => new URL(src, pageUrl).toString()))]
}

// Keep `response.bytes` untouched for transfer reporting, but decode a COPY
// only to inspect HTML. Reading raw compressed chunks and parsing compressed
// bytes are separate concerns; conflating them was the exact false-absent
// failure this probe exists to prevent.
export function decodeBodyForInspection(body, contentEncoding = '') {
  const encoding = String(contentEncoding).toLowerCase().trim()
  if (encoding === 'br') return brotliDecompressSync(body).toString('utf8')
  if (encoding === 'gzip') return gunzipSync(body).toString('utf8')
  if (encoding === 'deflate') return inflateSync(body).toString('utf8')
  return body.toString('utf8')
}

export async function measureFixture(fixture, deps = { request: rawRequest }, { allowPrivate = false } = {}) {
  const request = deps.request ?? rawRequest
  try {
    const response = await request(fixture.url, { allowPrivate, ...(fixture.image ? { headers: { accept: MODERN_IMAGE_ACCEPT } } : {}) }, deps)
    const cache = response.headers['cf-cache-status']
    const result = {
      id: fixture.id,
      label: fixture.label,
      url: fixture.url,
      // A redirect is a different first-hop response, not proof that the
      // locked page/image was measured. Count only a direct 2xx as present so
      // a short redirect body cannot masquerade as a low-byte baseline.
      status: response.statusCode >= 200 && response.statusCode < 300 ? 'present' : 'absent',
      http_status: response.statusCode,
      ttfb_ms: metric('present', Number(response.ttfbMs.toFixed(1))),
      cf_cache_status: cache ? metric('present', String(cache)) : metric('absent'),
      total_transfer_bytes: metric('present', response.bytes),
      client_js_transfer_bytes: metric('absent'),
      content_type: response.headers['content-type']
        ? metric('present', String(response.headers['content-type']).split(';', 1)[0].trim().toLowerCase())
        : metric('absent'),
    }

    if (fixture.image) {
      if (!String(result.content_type.value ?? '').startsWith('image/')) {
        result.status = 'absent'
        result.content_type = metric('absent', result.content_type.value, 'expected an image response')
        return result
      }
      const requestedFormat = new URL(fixture.url).searchParams.get('f')
      const expectedFormat = requestedFormat === 'jpg' ? 'jpeg' : requestedFormat
      const expectedType = expectedFormat ? `image/${expectedFormat}` : null
      if (expectedType && result.content_type.value !== expectedType) {
        result.status = 'absent'
        result.content_type = metric('absent', result.content_type.value, `expected ${expectedType}`)
      }
      return result
    }
    let html
    try {
      html = decodeBodyForInspection(response.body, response.headers['content-encoding'])
    } catch (error) {
      result.client_js_transfer_bytes = metric('unavailable', undefined, `could not inspect compressed HTML: ${error instanceof Error ? error.message : String(error)}`)
      result.status = 'unavailable'
      return result
    }
    const scripts = extractClientScriptUrls(html, fixture.url)
    if (scripts.length === 0) {
      result.client_js_transfer_bytes = metric('absent', undefined, 'no Next client scripts found in the HTML')
      result.status = 'absent'
      return result
    }
    // Only the page's own origin (D7): a script elsewhere is refused, and the fixture is red rather than under-counted.
    const pageOrigin = new URL(fixture.url).origin
    const foreign = scripts.find((src) => new URL(src).origin !== pageOrigin)
    if (foreign) {
      result.client_js_transfer_bytes = metric('absent', undefined, `client script on another origin refused: ${foreign}`)
      result.status = 'absent'
      return result
    }
    try {
      const transfers = await Promise.all(scripts.map((src) => request(src, { allowPrivate }, deps)))
      const failed = transfers.find((item) => item.statusCode < 200 || item.statusCode >= 300)
      if (failed) {
        result.client_js_transfer_bytes = metric('absent', undefined, `client script returned HTTP ${failed.statusCode}: ${failed.url}`)
        result.status = 'absent'
        return result
      }
      result.client_js_transfer_bytes = metric('present', transfers.reduce((total, item) => total + item.bytes, 0))
    } catch (error) {
      result.client_js_transfer_bytes = metric('unavailable', undefined, error instanceof Error ? error.message : String(error))
      result.status = 'unavailable'
    }
    return result
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      id: fixture.id,
      label: fixture.label,
      url: fixture.url,
      status: 'unavailable',
      ttfb_ms: metric('unavailable', undefined, detail),
      cf_cache_status: metric('unavailable', undefined, detail),
      total_transfer_bytes: metric('unavailable', undefined, detail),
      client_js_transfer_bytes: metric('unavailable', undefined, detail),
      content_type: metric('unavailable', undefined, detail),
    }
  }
}

export async function runProbe(options, deps = { request: rawRequest, now: () => new Date() }) {
  // CLI flags override the config only where GIVEN — parseArgs defaults unset flags to null, and a plain
  // spread would let those nulls wipe the config's baseUrl.
  const config = options.targets ? options : (deps.loadConfig ?? loadProbeConfig)()
  const fixtures = fixtureUrls({
    targets: options.targets ?? config.targets,
    baseUrl: options.baseUrl ?? config.baseUrl,
    imageUrl: options.imageUrl ?? null,
  })
  const allowPrivate = options.allowPrivate ?? config.allowPrivate ?? false
  // Refuse before ANY request (D7). A dry run makes no network call, so it checks only the literal addresses.
  for (const fixture of fixtures) assertLiteralAllowed(fixture.url, { allowPrivate })
  if (options.dryRun) return { dry_run: true, fixtures }
  for (const url of new Set(fixtures.map((f) => new URL(f.url).origin))) {
    await assertResolvedAllowed(url, { allowPrivate, ...(deps.lookupAll ? { lookupAll: deps.lookupAll } : {}) })
  }
  const results = []
  for (const fixture of fixtures) results.push(await measureFixture(fixture, deps, { allowPrivate }))
  const revision = typeof options.revision === 'string' ? options.revision.trim() : ''
  return {
    measured_at: (deps.now ?? (() => new Date()))().toISOString(),
    deployed_revision: revision ? metric('present', revision) : metric('unavailable', undefined, 'pass --revision with the deployed Git SHA'),
    fixtures: results,
    unavailable: results.filter((result) => result.status === 'unavailable').length,
    absent: results.filter((result) => result.status === 'absent').length,
  }
}

// A reachable 404/500 is not the same condition as an unreachable target,
// but either means this baseline did not observe every locked fixture and must
// never exit green.
export function probeExitCode(report) {
  if (report.dry_run) return 0
  const revision = report.deployed_revision
  const identifiedRevision = revision?.state === 'present' && typeof revision.value === 'string' && revision.value.trim()
  return report.unavailable || report.absent || !identifiedRevision ? 1 : 0
}

export function formatReport(report) {
  if (report.dry_run) return `DRY RUN — no network calls or writes\n${report.fixtures.map((f) => `- ${f.id}: ${f.url}`).join('\n')}\n`
  const lines = [
    `Performance probe — ${report.measured_at}`,
    `Deployed revision: ${report.deployed_revision.state === 'present' ? report.deployed_revision.value : `unavailable (${report.deployed_revision.detail ?? 'not identified'})`}`,
    '',
    '| Fixture | Status | TTFB | CF cache | Transfer | Client JS |',
    '|---|---|---:|---|---:|---:|',
  ]
  const display = (value, suffix = '') => value.state === 'present' ? `${value.value}${suffix}` : value.state
  for (const item of report.fixtures) {
    lines.push(`| ${item.label} | ${item.status} | ${display(item.ttfb_ms, ' ms')} | ${display(item.cf_cache_status)} | ${display(item.total_transfer_bytes, ' B')} | ${display(item.client_js_transfer_bytes, ' B')} |`)
  }
  if (report.unavailable) lines.push(`\nUNAVAILABLE: ${report.unavailable} fixture(s) could not be measured; this is not a green run.`)
  if (report.absent) lines.push(`\nFAILED: ${report.absent} locked fixture(s) returned a non-2xx or invalid measurement; this is not a green run.`)
  if (report.deployed_revision.state !== 'present') lines.push(`\nFAILED: deployed revision was not identified; pass --revision with the live Git SHA.`)
  return `${lines.join('\n')}\n`
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) return process.stdout.write(`${HELP}\n`)
    const report = await runProbe(options)
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
    if (!options.dryRun && probeExitCode(report)) {
      const reasons = [
        report.unavailable ? `${report.unavailable} unreachable or unreadable` : null,
        report.absent ? `${report.absent} non-2xx or invalid measurement` : null,
        report.deployed_revision.state !== 'present' ? 'deployed revision unidentified' : null,
      ].filter(Boolean).join('; ')
      process.stderr.write(`perf-probe: locked fixture failure (${reasons}); see rows above.\n`)
      process.exitCode = 1
    }
  } catch (error) {
    process.stderr.write(`perf-probe: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (isMain(import.meta.url)) main()
