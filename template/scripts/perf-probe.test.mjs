import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertResolvedAllowed, guardedLookup, isPrivateAddress, loadProbeConfig, decodeBodyForInspection, extractClientScriptUrls, fixtureUrls, formatReport, measureFixture, parseArgs, probeExitCode, rawRequest, requestTransport, runProbe } from './perf-probe.mjs'

const TARGETS = [
  { id: 'home', label: 'home (signed-out)', path: '/mx' },
  { id: 'pdp', label: 'product page', path: '/mx/l/prod_1' },
  { id: 'image', label: 'cold real image variant', path: '/api/img?url=x&w=160&q=75', image: true },
]

test('fixtureUrls builds from the configured targets; --image-url replaces ONLY the image target', () => {
  const fixtures = fixtureUrls({ baseUrl: 'https://preview.example/', targets: TARGETS })
  assert.deepEqual(fixtures.map((f) => f.url), [
    'https://preview.example/mx', 'https://preview.example/mx/l/prod_1', 'https://preview.example/api/img?url=x&w=160&q=75',
  ])
  assert.equal(fixtures[2].image, true)
  const swapped = fixtureUrls({ baseUrl: 'https://preview.example', imageUrl: 'https://cdn.example/i.jpg', targets: TARGETS })
  assert.equal(swapped[0].url, 'https://preview.example/mx')
  assert.equal(swapped[2].url, 'https://cdn.example/i.jpg')
})

test('loadProbeConfig: no config is an error naming the file — never a default site', () => {
  assert.throws(() => loadProbeConfig({ path: '/nope/perf-probe.config.json', exists: () => false }), /perf-probe\.config\.json not found/)
  const read = (o) => () => JSON.stringify(o)
  assert.throws(() => loadProbeConfig({ exists: () => true, read: read({ baseUrl: 'x', targets: TARGETS }) }), /baseUrl/)
  assert.throws(() => loadProbeConfig({ exists: () => true, read: read({ baseUrl: 'https://a', targets: [] }) }), /targets/)
  assert.throws(() => loadProbeConfig({ exists: () => true, read: read({ baseUrl: 'https://a', targets: [{ id: 'x', label: 'y', path: 'no-slash' }] }) }), /targets\[0\]/)
  assert.equal(loadProbeConfig({ exists: () => true, read: read({ baseUrl: 'https://a', targets: TARGETS }) }).targets.length, 3)
})

test('parseArgs accepts a deployed revision and rejects incomplete flags', () => {
  assert.deepEqual(parseArgs(['--revision', 'abc123', '--json']).revision, 'abc123')
  assert.throws(() => parseArgs(['--image-url']), /requires a value/)
  assert.throws(() => parseArgs(['--revision', '   ']), /requires a non-blank value/)
  assert.throws(() => parseArgs(['--revision=\t']), /requires a non-blank value/)
})

test('raw transport supports local HTTP probes without attempting a TLS handshake', () => {
  const httpRequest = () => 'http'
  const httpsRequest = () => 'https'
  assert.equal(requestTransport('http://127.0.0.1:3000/mx', { httpRequest, httpsRequest }), httpRequest)
  assert.equal(requestTransport('https://shop.example.test/mx', { httpRequest, httpsRequest }), httpsRequest)
  assert.throws(() => requestTransport('ftp://example.test/file', { httpRequest, httpsRequest }), /unsupported URL protocol/)
})

test('rawRequest rejects a response-stream failure instead of crashing or hanging', async () => {
  const transport = (_url, _options, onResponse) => {
    const request = new EventEmitter()
    request.setTimeout = () => {}
    request.destroy = (error) => request.emit('error', error)
    request.end = () => {
      const response = new EventEmitter()
      response.statusCode = 200
      response.headers = { 'content-type': 'text/plain' }
      onResponse(response)
      queueMicrotask(() => {
        response.emit('data', Buffer.from('partial'))
        response.emit('error', new Error('forced response failure'))
      })
    }
    return request
  }
  await assert.rejects(rawRequest('https://example.test/partial', {}, { transport }), /forced response failure/)
})

test('rawRequest forwards protocol-specific injected transports', async () => {
  let called = false
  const httpRequest = (_url, _options, onResponse) => {
    called = true
    const request = new EventEmitter()
    request.setTimeout = () => {}
    request.end = () => {
      const response = new EventEmitter()
      response.statusCode = 200
      response.headers = { 'content-type': 'text/plain' }
      onResponse(response)
      queueMicrotask(() => response.emit('end'))
    }
    return request
  }
  await rawRequest('http://unused.test/fixture', {}, { httpRequest })
  assert.equal(called, true)
})

test('extractClientScriptUrls resolves and de-duplicates only Next client chunks', () => {
  const html = '<script src="/_next/static/a.js"></script><script src="/_next/static/a.js"></script><script src="/other.js"></script>'
  assert.deepEqual(extractClientScriptUrls(html, 'https://shop.example.test/mx'), ['https://shop.example.test/_next/static/a.js'])
  assert.deepEqual(extractClientScriptUrls("<script src='/_next/static/b.js' id=\"single-quoted\"></script>", 'https://shop.example.test/mx'), ['https://shop.example.test/_next/static/b.js'])
})

test('decodeBodyForInspection parses compressed HTML without changing wire-byte measurement', () => {
  const html = '<script src="/_next/static/a.js"></script>'
  const compressed = gzipSync(Buffer.from(html))
  assert.ok(compressed.byteLength < Buffer.byteLength(html) + 30)
  assert.equal(decodeBodyForInspection(compressed, 'gzip'), html)
})

test('measureFixture reports raw transfer metrics and sums unique route client chunks', async () => {
  const requests = []
  const response = (url, bytes, body, headers = {}) => ({ url, statusCode: 200, bytes, body: Buffer.from(body), ttfbMs: 12.34, headers })
  const result = await measureFixture({ id: 'home', label: 'home', url: 'https://example.test/mx' }, {
    request: async (url) => {
      requests.push(url)
      if (url.endsWith('/mx')) return response(url, 100, '<script src="/_next/static/a.js"></script><script src="/_next/static/b.js"></script>', { 'cf-cache-status': 'HIT', 'content-type': 'text/html' })
      return response(url, url.endsWith('a.js') ? 10 : 20, '')
    },
  })
  assert.equal(result.ttfb_ms.value, 12.3)
  assert.equal(result.cf_cache_status.value, 'HIT')
  assert.equal(result.total_transfer_bytes.value, 100)
  assert.equal(result.client_js_transfer_bytes.value, 30)
  assert.equal(requests.length, 3)
})

test('measureFixture records an unreachable target as unavailable instead of a confident empty row', async () => {
  const result = await measureFixture({ id: 'shop', label: 'shop', url: 'https://example.test/mx/s/shop' }, { request: async () => { throw new Error('DNS lookup failed') } })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.total_transfer_bytes.state, 'unavailable')
  assert.match(formatReport({ measured_at: '2026-08-22T00:00:00.000Z', deployed_revision: { state: 'present', value: 'abc' }, fixtures: [result], unavailable: 1 }), /not a green run/)
})

test('a reachable non-2xx locked fixture is absent and makes the baseline exit nonzero', async () => {
  const report = await runProbe({ targets: TARGETS, baseUrl: 'https://example.test', imageUrl: 'https://example.test/api/img?url=x&w=160&q=75', revision: 'abc' }, {
    request: async (url) => ({ url, statusCode: 404, bytes: 0, body: Buffer.alloc(0), ttfbMs: 5, headers: {} }),
    now: () => new Date('2026-08-22T00:00:00.000Z'),
  })
  assert.equal(report.unavailable, 0)
  assert.equal(report.absent, TARGETS.length)
  assert.equal(probeExitCode(report), 1)
  assert.match(formatReport(report), /non-2xx or invalid measurement/)
})

test('a 3xx first hop is absent, never a false low-byte successful fixture', async () => {
  const result = await measureFixture({ id: 'pdp', label: 'PDP', url: 'https://example.test/mx/l/id' }, {
    request: async (url) => ({ url, statusCode: 302, bytes: 12, body: Buffer.alloc(0), ttfbMs: 3, headers: { location: '/mx/l/id/' } }),
  })
  assert.equal(result.status, 'absent')
  assert.equal(result.total_transfer_bytes.value, 12)
  assert.equal(probeExitCode({ unavailable: 0, absent: 1 }), 1)
})

test('a missing client chunk is absent and cannot produce a green partial JS total', async () => {
  const response = (url, statusCode, bytes, body, headers = {}) => ({ url, statusCode, bytes, body: Buffer.from(body), ttfbMs: 2, headers })
  const result = await measureFixture({ id: 'home', label: 'home', url: 'https://example.test/mx' }, {
    request: async (url) => url.endsWith('/mx')
      ? response(url, 200, 100, '<script src="/_next/static/missing.js"></script>', { 'content-type': 'text/html' })
      : response(url, 404, 9, 'not found'),
  })
  assert.equal(result.status, 'absent')
  assert.equal(result.client_js_transfer_bytes.state, 'absent')
})

test('a fixed-format image returning the wrong type is absent', async () => {
  const result = await measureFixture({ id: 'image', label: 'image', url: 'https://example.test/api/img?url=x&w=640&q=75&f=webp&v=2', image: true }, {
    request: async (url) => ({ url, statusCode: 200, bytes: 10, body: Buffer.alloc(10), ttfbMs: 2, headers: { 'content-type': 'image/avif' } }),
  })
  assert.equal(result.status, 'absent')
  assert.equal(result.content_type.state, 'absent')
})

test('a fixed-format image accepts legal Content-Type parameters', async () => {
  const result = await measureFixture({ id: 'image', label: 'image', url: 'https://example.test/api/img?url=x&w=640&q=75&f=webp&v=2', image: true }, {
    request: async (url) => ({ url, statusCode: 200, bytes: 10, body: Buffer.alloc(10), ttfbMs: 2, headers: { 'content-type': 'image/webp; charset=binary' } }),
  })
  assert.equal(result.status, 'present')
  assert.equal(result.content_type.value, 'image/webp')
})

test('a jpg image format expects the standard image/jpeg media type', async () => {
  const result = await measureFixture({ id: 'image', label: 'image', url: 'https://example.test/api/img?url=x&w=640&q=75&f=jpg&v=2', image: true }, {
    request: async (url) => ({ url, statusCode: 200, bytes: 10, body: Buffer.alloc(10), ttfbMs: 2, headers: { 'content-type': 'image/jpeg' } }),
  })
  assert.equal(result.status, 'present')
})

test('measureFixture forwards protocol-specific transport dependencies to rawRequest', async () => {
  const httpRequest = (_url, _options, onResponse) => {
    const request = new EventEmitter()
    request.setTimeout = () => {}
    request.end = () => {
      const response = new EventEmitter()
      response.statusCode = 200
      response.headers = { 'content-type': 'image/webp' }
      onResponse(response)
      queueMicrotask(() => {
        response.emit('data', Buffer.alloc(10))
        response.emit('end')
      })
    }
    return request
  }
  const result = await measureFixture({ id: 'image', label: 'image', url: 'http://unused.test/api/img?url=x&w=640&q=75&f=webp&v=2', image: true }, { httpRequest })
  assert.equal(result.status, 'present')
})

test('a legacy image returning HTML is absent even without a fixed-format expectation', async () => {
  const result = await measureFixture({ id: 'image', label: 'image', url: 'https://example.test/api/img?url=x&w=640&q=75', image: true }, {
    request: async (url) => ({ url, statusCode: 200, bytes: 10, body: Buffer.from('<html>'), ttfbMs: 2, headers: { 'content-type': 'text/html' } }),
  })
  assert.equal(result.status, 'absent')
  assert.equal(result.content_type.state, 'absent')
})

test('a page with no Next client scripts is absent, never a green zero-measurement row', async () => {
  const result = await measureFixture({ id: 'home', label: 'home', url: 'https://example.test/mx' }, {
    request: async (url) => ({ url, statusCode: 200, bytes: 20, body: Buffer.from('<html><main>fallback</main></html>'), ttfbMs: 2, headers: { 'content-type': 'text/html' } }),
  })
  assert.equal(result.status, 'absent')
  assert.equal(result.client_js_transfer_bytes.state, 'absent')
})

test('a probe without an identified deployed revision exits nonzero', () => {
  assert.equal(probeExitCode({ unavailable: 0, absent: 0, deployed_revision: { state: 'unavailable' } }), 1)
  assert.equal(probeExitCode({ unavailable: 0, absent: 0, deployed_revision: { state: 'present', value: '   ' } }), 1)
})

test('failure diagnostics name invalid measurements and an unidentified revision honestly', () => {
  const output = formatReport({
    measured_at: '2026-08-22T00:00:00.000Z',
    deployed_revision: { state: 'unavailable', detail: 'missing' },
    fixtures: [],
    unavailable: 0,
    absent: 1,
  })
  assert.match(output, /non-2xx or invalid measurement/)
  assert.match(output, /deployed revision was not identified/)
  assert.doesNotMatch(formatReport({ measured_at: '2026-08-22T00:00:00.000Z', deployed_revision: { state: 'unavailable' }, fixtures: [], unavailable: 0, absent: 0 }), /undefined/)
})

test('--dry-run is fully read-only: it returns fixtures without invoking the injected network reader', async () => {
  let calls = 0
  const report = await runProbe({ dryRun: true, targets: TARGETS, baseUrl: 'https://example.test' }, { request: async () => { calls += 1 }, now: () => new Date('2026-08-22T00:00:00.000Z') })
  assert.equal(report.dry_run, true)
  assert.equal(calls, 0)
  assert.equal(probeExitCode(report), 0)
})

test('runProbe with no flags takes baseUrl + targets from the config (the CLI default path)', async () => {
  const report = await runProbe(parseArgs(['--dry-run']), {
    loadConfig: () => ({ baseUrl: 'https://cfg.example', targets: TARGETS }),
    request: async () => { throw new Error('dry run must not fetch') },
  })
  assert.equal(report.fixtures[0].url, 'https://cfg.example/mx')
  const over = await runProbe(parseArgs(['--dry-run', '--base-url', 'https://flag.example']), {
    loadConfig: () => ({ baseUrl: 'https://cfg.example', targets: TARGETS }),
  })
  assert.equal(over.fixtures[0].url, 'https://flag.example/mx')
})

// ── Only the hosts a project names (template-scripts-consumer-gates D7) — one test per refusal ─────────────

const PUBLIC = [{ address: '104.21.10.238', family: 4 }]
const neverRequest = async () => { throw new Error('a refused probe must make no request') }
const probe = (baseUrl, extra = {}, deps = {}) =>
  runProbe({ targets: [{ id: 'home', label: 'home', path: '/' }], baseUrl, revision: 'abc', ...extra }, { request: neverRequest, lookupAll: async () => PUBLIC, ...deps })

for (const [url, address] of [
  ['http://127.0.0.1:3000', '127.0.0.1'],
  ['http://169.254.169.254', '169.254.169.254'],
  ['http://10.0.0.1', '10.0.0.1'],
  ['http://[::ffff:127.0.0.1]', '::ffff:7f00:1'],
  ['http://2130706433', '127.0.0.1'], // the URL parser normalises a decimal IPv4
]) {
  test(`refuses ${url} before any request, naming the address and the opt-in`, async () => {
    await assert.rejects(probe(url), (e) => e.message.includes(address) && /smoke\.perf\.allowPrivate: true/.test(e.message))
    await assert.rejects(probe(url, { dryRun: true }), /refusing/, 'a dry run refuses a literal too, with no network')
  })
}

test('refuses a hostname that resolves to a private address (any of its addresses)', async () => {
  const lookupAll = async () => [...PUBLIC, { address: '10.0.0.1', family: 4 }]
  await assert.rejects(probe('https://internal.example', {}, { lookupAll }), /10\.0\.0\.1 \(internal\.example\)/)
})

test('refuses at connect when the name re-resolves to a private address after the check (rebinding)', async () => {
  const lookup = guardedLookup({ lookup: (_h, _o, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]) })
  const refused = await new Promise((resolve) => lookup('rebind.example', { all: true }, (err) => resolve(err)))
  assert.match(refused.message, /169\.254\.169\.254 \(rebind\.example\)/)
  // …and a public answer passes through in both callback forms
  const ok = guardedLookup({ lookup: (_h, _o, cb) => cb(null, PUBLIC) })
  assert.deepEqual(await new Promise((r) => ok('a.example', { all: true }, (e, a) => r(a))), PUBLIC)
  assert.deepEqual(await new Promise((r) => ok('a.example', {}, (e, a, f) => r([a, f]))), ['104.21.10.238', 4])
})

test('rawRequest really connects through the guarded lookup: a name resolving to loopback never connects', async () => {
  const server = createServer((_req, res) => res.end('should not be reached'))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  try {
    const dnsLookup = (_h, opts, cb) => cb(null, opts.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4)
    await assert.rejects(rawRequest(`http://looks-public.example:${port}/`, {}, { dnsLookup }), /refusing .*127\.0\.0\.1/)
    const allowed = await rawRequest(`http://looks-public.example:${port}/`, { allowPrivate: true }, { dnsLookup })
    assert.equal(allowed.statusCode, 200)
  } finally {
    server.close()
  }
})

test('refuses a client script on another origin: the fixture is red, and the script is never requested', async () => {
  const requested = []
  const request = async (url) => {
    requested.push(url)
    return { url, statusCode: 200, headers: { 'content-type': 'text/html' }, bytes: 10, body: Buffer.from('<script src="https://evil.example/_next/static/chunks/a.js"></script><script src="/_next/static/chunks/b.js"></script>'), ttfbMs: 1 }
  }
  const result = await measureFixture({ id: 'home', label: 'home', url: 'https://shop.example/mx' }, { request })
  assert.equal(result.status, 'absent')
  assert.match(result.client_js_transfer_bytes.detail, /another origin refused: https:\/\/evil\.example/)
  assert.deepEqual(requested, ['https://shop.example/mx'])
})

test('passes: a public address on the 172.16/12 boundary, and allowPrivate: true probes a real local server', async () => {
  assert.equal(isPrivateAddress('172.67.164.209'), false, 'a CDN address just outside 172.16/12 is public')
  assert.equal(isPrivateAddress('172.31.255.255'), true)
  assert.equal(isPrivateAddress('not-an-ip'), true, 'anything that is not an IP fails closed')
  await assert.doesNotReject(assertResolvedAllowed('https://shop.example', { lookupAll: async () => [{ address: '172.67.164.209', family: 4 }] }))
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<script src="/_next/static/chunks/x.js"></script>') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const report = await runProbe({ targets: [{ id: 'home', label: 'home', path: '/' }], baseUrl: base, revision: 'abc', allowPrivate: true })
    assert.equal(report.fixtures[0].status, 'present', JSON.stringify(report.fixtures[0]))
  } finally {
    server.close()
  }
})

test('loadProbeConfig: only a literal true opts in', () => {
  const read = (o) => () => JSON.stringify(o)
  const base = { baseUrl: 'http://127.0.0.1:3000', targets: TARGETS }
  assert.equal(loadProbeConfig({ exists: () => true, read: read({ ...base, allowPrivate: true }) }).allowPrivate, true)
  for (const v of ['true', 1, 'yes', null]) {
    assert.equal(loadProbeConfig({ exists: () => true, read: read({ ...base, allowPrivate: v }) }).allowPrivate, false, String(v))
  }
})

test('never through an environment proxy: NODE_USE_ENV_PROXY cannot route a refused name around the check', async () => {
  const seen = []
  const proxy = createServer((req, res) => { seen.push(req.url); res.end('via proxy') })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${proxy.address().port}`
  const child = `import { rawRequest } from ${JSON.stringify(fileURLToPath(new URL('./perf-probe.mjs', import.meta.url)))};
const dnsLookup = (_h, o, cb) => cb(null, o.all ? [{ address: '10.0.0.1', family: 4 }] : '10.0.0.1', 4);
try { const r = await rawRequest('http://looks-public.example/', { timeoutMs: 3000 }, { dnsLookup }); console.log('STATUS', r.statusCode) } catch (e) { console.log('REFUSED', e.message) }`
  try {
    const out = await new Promise((resolve) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: url, http_proxy: url } })
      let o = ''
      c.stdout.on('data', (d) => (o += d))
      c.stderr.on('data', (d) => (o += d))
      c.on('close', () => resolve(o))
    })
    assert.match(out, /REFUSED refusing .*10\.0\.0\.1/, out)
    assert.deepEqual(seen, [], 'the proxy must receive nothing')
  } finally {
    proxy.close()
  }
})

test('rawRequest refuses a private IP literal itself, before the transport is called (Node skips lookup for literals)', async () => {
  let called = 0
  const transport = () => { called += 1 }
  await assert.rejects(rawRequest('http://169.254.169.254/latest/meta-data/', {}, { transport }), /refusing .*169\.254\.169\.254/)
  assert.equal(called, 0)
})

test('guardedLookup: an empty answer is ENOTFOUND, never a crash; IPv4-compatible ::/96 is refused', async () => {
  const empty = guardedLookup({ lookup: (_h, _o, cb) => cb(null, []) })
  const err = await new Promise((r) => empty('x.example', {}, (e) => r(e)))
  assert.equal(err.code, 'ENOTFOUND')
  assert.equal(isPrivateAddress('::a9fe:a9fe'), true)
})
