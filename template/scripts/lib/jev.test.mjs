// jev.test.mjs — the client, config and decision log (jev-semantic-guards S1.1–S1.3). Jev is injected:
// no spec here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  askJev,
  DEFAULT_MODEL,
  effectiveMode,
  JevConfigError,
  jevContext,
  loadJevConfig,
  logDecision,
  parseJevConfig,
  readApiKey,
  STATE_CHAR_BUDGET,
  textHash,
} from './jev.mjs';
import { _resetAsked } from './config.mjs';

const Q = { is_urgent: { type: 'noul', instructions: 'Urgent?' } };
const ok = (answers = { is_urgent: { type: 'noul', noul: 0.9 } }) => ({
  status: 200,
  json: async () => ({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 1 } }),
  text: async () => '',
  headers: { get: () => null },
});
const status = (s, text = '') => ({
  status: s,
  json: async () => ({}),
  text: async () => text,
  headers: { get: () => null },
});
const seq = (...responses) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
};
const noSleep = async () => {};

test('askJev: a 200 returns ok with answers, usage and the model that answered', async () => {
  const { fetch, calls } = seq(ok());
  const r = await askJev({ state: 'help', questions: Q }, { fetch, key: 'k' });
  assert.equal(r.ok, true);
  assert.equal(r.answers.is_urgent.noul, 0.9);
  assert.equal(r.model, 'jev-1.13.0');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.model, DEFAULT_MODEL, 'pinned model by default, never an alias');
  assert.equal(calls[0].init.headers.authorization, 'Bearer k');
});

for (const [name, response, expect] of [
  ['401', status(401, 'bad key'), /HTTP 401/],
  ['422', status(422, 'malformed'), /HTTP 422/],
  ['500', status(500), /HTTP 500/],
]) {
  test(`askJev: ${name} is could-not-look, never a verdict`, async () => {
    const { fetch, calls } = seq(response);
    const r = await askJev({ state: 's', questions: Q }, { fetch, key: 'k', sleep: noSleep });
    assert.deepEqual([r.ok, r.state], [false, 'could-not-look']);
    assert.match(r.error, expect);
    assert.equal(calls.length, 1, 'non-retryable statuses are not retried');
  });
}

test('askJev: no key is could-not-look and makes no call', async () => {
  const { fetch, calls } = seq(ok());
  const r = await askJev({ state: 's', questions: Q }, { fetch, key: null });
  assert.equal(r.error, 'no key');
  assert.equal(calls.length, 0);
});

test('askJev: 429 then 200 retries with backoff and succeeds', async () => {
  const { fetch, calls } = seq(status(429), ok());
  const waits = [];
  const r = await askJev(
    { state: 's', questions: Q },
    { fetch, key: 'k', sleep: async (ms) => waits.push(ms) }
  );
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(waits.length, 1);
});

for (const s of [429, 529]) {
  test(`askJev: ${s} retries at most twice, then could-not-look`, async () => {
    const { fetch, calls } = seq(status(s));
    const waits = [];
    const r = await askJev(
      { state: 's', questions: Q },
      { fetch, key: 'k', sleep: async (ms) => waits.push(ms) }
    );
    assert.equal(r.state, 'could-not-look');
    assert.match(r.error, new RegExp(`HTTP ${s}`));
    assert.equal(calls.length, 3, 'one call + two retries');
    assert.ok(waits[1] > waits[0], 'exponential backoff');
  });
}

test('askJev: a timeout is could-not-look', async () => {
  const fetch = (url, init) =>
    new Promise((_, reject) =>
      init.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      )
    );
  const r = await askJev({ state: 's', questions: Q }, { fetch, key: 'k', timeoutMs: 5 });
  assert.equal(r.state, 'could-not-look');
  assert.match(r.error, /timeout/);
});

test('askJev: a network error is could-not-look', async () => {
  const { fetch } = seq(new Error('ECONNRESET'));
  const r = await askJev({ state: 's', questions: Q }, { fetch, key: 'k' });
  assert.match(r.error, /network: ECONNRESET/);
});

test('askJev: a state over the 32k budget is could-not-look and never sent', async () => {
  const { fetch, calls } = seq(ok());
  const r = await askJev({ state: 'x'.repeat(STATE_CHAR_BUDGET + 1), questions: Q }, { fetch, key: 'k' });
  assert.match(r.error, /state too large/);
  assert.equal(calls.length, 0);
});

test('askJev: an unparseable body or a missing answer is could-not-look', async () => {
  const bad = { ...ok(), json: async () => JSON.parse('{nope') };
  assert.match(
    (await askJev({ state: 's', questions: Q }, { fetch: seq(bad).fetch, key: 'k' })).error,
    /unparseable/
  );
  const partial = ok({});
  assert.match(
    (await askJev({ state: 's', questions: Q }, { fetch: seq(partial).fetch, key: 'k' })).error,
    /missing answers: is_urgent/
  );
});

test('parseJevConfig: an empty object is the defaults — both rails off, pinned model', () => {
  const c = parseJevConfig({});
  assert.equal(c.model, DEFAULT_MODEL);
  assert.equal(c.rails.review.mode, 'off');
  assert.equal(c.rails.prose.mode, 'off');
  assert.equal(c.rails.review.thresholds.real, 0.85);
});

for (const [name, json, expect] of [
  ['bad mode', { rails: { review: { mode: 'on' } } }, /mode must be one of/],
  ['an alias model', { model: 'jev-latest' }, /alias/],
  ['unknown rail', { rails: { reveiw: { mode: 'jev' } } }, /unknown rail "reveiw"/],
  ['threshold out of range', { rails: { prose: { thresholds: { claim: 2 } } } }, /0…1/],
  ['inverted review band', { rails: { review: { thresholds: { real: 0.1, notReal: 0.9 } } } }, /below/],
  ['shadow without expiry', { rails: { review: { mode: 'shadow' } } }, /shadow must expire/],
  ['egress not boolean', { egress: 'yes' }, /egress/],
]) {
  test(`parseJevConfig: ${name} throws — a malformed config is never silently off`, () => {
    assert.throws(
      () => parseJevConfig(json),
      (e) => e instanceof JevConfigError && expect.test(e.message)
    );
  });
}

test('loadJevConfig: a missing file is the defaults; an unparseable one throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-'));
  assert.equal(loadJevConfig({ root: dir }).rails.review.mode, 'off');
  writeFileSync(join(dir, 'jev.config.json'), '{ "rails": ');
  assert.throws(() => loadJevConfig({ root: dir }), /unparseable/);
});

test('effectiveMode: egress:false or no key behaves exactly as off', () => {
  const c = parseJevConfig({ rails: { review: { mode: 'jev' } } });
  assert.equal(effectiveMode(c, 'review', { key: 'k' }).mode, 'jev');
  assert.equal(effectiveMode(c, 'review', { key: null }).mode, 'off');
  assert.match(effectiveMode(c, 'review', { key: null }).why, /no TYPESAFE_API_KEY/);
  const noEgress = parseJevConfig({ egress: false, rails: { review: { mode: 'jev' } } });
  assert.equal(effectiveMode(noEgress, 'review', { key: 'k' }).mode, 'off');
});

// ── D12/S5.4: egress is a tri-state, and unanswered (null) behaves as no ──────────────────────
test('parseJevConfig: an explicit egress:null survives as null — never coerced to true', () => {
  const c = parseJevConfig({ egress: null, rails: { review: { mode: 'jev' } } });
  assert.equal(c.egress, null);
  // an ABSENT egress key still falls back to true (a consumer's legacy config that never mentions it)
  assert.equal(parseJevConfig({}).egress, true);
  assert.equal(parseJevConfig({ egress: true }).egress, true);
  assert.equal(parseJevConfig({ egress: false }).egress, false);
});

test('effectiveMode: egress:null is UNANSWERED, not the same reason as egress:false or no key', () => {
  const c = parseJevConfig({ egress: null, rails: { review: { mode: 'jev' } } });
  const eff = effectiveMode(c, 'review', { key: 'k' });
  assert.equal(eff.mode, 'off');
  assert.equal(eff.why, 'egress not answered');
  assert.equal(eff.unanswered, true);
  // unanswered egress is decided before the key is even looked at — "no key" never masks "unanswered"
  assert.equal(effectiveMode(c, 'review', { key: null }).why, 'egress not answered');
});

test('jevContext: a null-egress config asks the D12 question once (GF-NEEDS-SETTING jev.egress), never touching fetch', () => {
  _resetAsked();
  const dir = mkdtempSync(join(tmpdir(), 'jev-'));
  const writes = [];
  const fetchSpy = async () => {
    throw new Error('fetch must never be called while egress is unanswered');
  };
  const config = parseJevConfig({ egress: null, rails: { review: { mode: 'jev' } } });
  const ctx1 = jevContext('review', { config, key: 'k', root: dir, fetch: fetchSpy, write: (s) => writes.push(s) });
  assert.equal(ctx1.mode, 'off');
  assert.equal(ctx1.why, 'egress not answered');
  assert.equal(writes.length, 1);
  assert.match(writes[0], /^GF-NEEDS-SETTING /);
  const line = JSON.parse(writes[0].slice('GF-NEEDS-SETTING '.length));
  assert.equal(line.key, 'jev.egress');

  // a second rail (prose) hitting the same unanswered key in the same process must not ask twice
  jevContext('prose', { config, key: 'k', root: dir, fetch: fetchSpy, write: (s) => writes.push(s) });
  assert.equal(writes.length, 1, 'the marker is emitted once per process, not once per rail');
  _resetAsked();
});

test('jevContext: egress:true (existing consumers) and egress:false (today) are unaffected by the tri-state', () => {
  const trueCtx = jevContext('review', {
    config: parseJevConfig({ egress: true, rails: { review: { mode: 'jev' } } }),
    key: 'k',
    write: () => assert.fail('egress:true must never emit GF-NEEDS-SETTING'),
  });
  assert.equal(trueCtx.mode, 'jev');
  const falseCtx = jevContext('review', {
    config: parseJevConfig({ egress: false, rails: { review: { mode: 'jev' } } }),
    key: 'k',
    write: () => assert.fail('egress:false must never emit GF-NEEDS-SETTING'),
  });
  assert.equal(falseCtx.mode, 'off');
  assert.equal(falseCtx.why, 'egress disabled (jev.egress: false)');
});

test('readApiKey: env wins, else .env.local at the root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-'));
  assert.equal(readApiKey({ env: {}, root: dir, cwd: dir }), null);
  writeFileSync(join(dir, '.env.local'), 'OTHER=1\nTYPESAFE_API_KEY="abc"\n');
  assert.equal(readApiKey({ env: {}, root: dir, cwd: dir }), 'abc');
  assert.equal(readApiKey({ env: { TYPESAFE_API_KEY: 'env' }, root: dir, cwd: dir }), 'env');
  // Set but empty is "no key", never a fall-through to the .env.local key the person just blanked.
  assert.equal(readApiKey({ env: { TYPESAFE_API_KEY: '' }, root: dir, cwd: dir }), null);
  assert.equal(readApiKey({ env: { TYPESAFE_API_KEY: '  ' }, root: dir, cwd: dir }), null);
});

test('logDecision: one JSONL line with the contract fields, text truncated at 4k', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-'));
  const long = 'y'.repeat(5000);
  assert.equal(
    logDecision(
      {
        rail: 'review',
        mode: 'shadow',
        decider: 'regex',
        regex: true,
        jev: false,
        confidence: 0.1,
        text: long,
        sha: 'abc',
      },
      { root: dir, now: () => 'T' }
    ),
    true
  );
  const line = JSON.parse(readFileSync(join(dir, '.jev', 'decisions.jsonl'), 'utf8').trim());
  assert.deepEqual(Object.keys(line), [
    'rail',
    'mode',
    'decider',
    'regex',
    'jev',
    'confidence',
    'textHash',
    'text',
    'sha',
    'ts',
  ]);
  assert.equal(line.textHash, textHash(long));
  assert.ok(line.text.length < 4100 && line.text.endsWith('[truncated]'));
});

test('logDecision: a write failure warns and returns false — it never throws', () => {
  const warned = [];
  const r = logDecision(
    { rail: 'prose', mode: 'jev', decider: 'jev', text: 't' },
    {
      append: () => {
        throw new Error('EROFS');
      },
      mkdir: () => {},
      warn: (m) => warned.push(m),
    }
  );
  assert.equal(r, false);
  assert.match(warned[0], /EROFS.*decision stands/);
});

test('jevContext: resolves the effective mode once, from injected config and key', () => {
  const ctx = jevContext('prose', {
    config: parseJevConfig({ rails: { prose: { mode: 'jev' } } }),
    key: null,
  });
  assert.equal(ctx.mode, 'off');
  assert.equal(ctx.configured, 'jev');
});

// ── Fresh-review findings on PR #34 ─────────────────────────────────────────────────────────────────
test('askJev never throws: undefined, circular or BigInt state, and a fetch that resolves nothing', async () => {
  const circular = {};
  circular.self = circular;
  for (const [state, fetch] of [
    [undefined, seq(ok()).fetch],
    [circular, seq(ok()).fetch],
    [{ n: 1n }, seq(ok()).fetch],
    ['s', async () => undefined],
  ]) {
    const r = await askJev({ state, questions: Q }, { fetch, key: 'k' });
    assert.equal(r.state, 'could-not-look', `state=${String(state)}`);
  }
  assert.equal((await askJev(undefined, { key: 'k' })).state, 'could-not-look');
});

test('askJev: the timeout covers a body that stalls after the headers arrive', async () => {
  const fetch = async (url, init) => ({
    status: 200,
    headers: { get: () => null },
    text: async () => '',
    json: () =>
      new Promise((_, reject) =>
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      ),
  });
  const t0 = Date.now();
  const r = await askJev({ state: 's', questions: Q }, { fetch, key: 'k', timeoutMs: 20 });
  assert.match(r.error, /timeout after 20ms/);
  assert.ok(Date.now() - t0 < 1000);
});

for (const [name, json, expect] of [
  ['a typo that would keep egress on', { egres: false }, /unknown key\(s\) in the top level: egres/],
  ['a rail that is a string', { rails: { review: 'jev' } }, /rails.review must be an object/],
  ['a mis-cased mode key', { rails: { review: { Mode: 'jev' } } }, /unknown key\(s\) in rails.review: Mode/],
  ['rails as an array', { rails: [] }, /rails must be an object/],
  ['an unknown threshold', { rails: { prose: { thresholds: { claims: 0.4 } } } }, /thresholds: claims/],
]) {
  test(`parseJevConfig: ${name} is refused, never silently defaulted`, () => {
    assert.throws(
      () => parseJevConfig(json),
      (e) => e instanceof JevConfigError && expect.test(e.message)
    );
  });
}

test('parseJevConfig: $-prefixed keys are comments and allowed', () => {
  assert.equal(
    parseJevConfig({ $comment: 'x', rails: { review: { $why: 'y', mode: 'off' } } }).rails.review.mode,
    'off'
  );
});

test('jevContext never hands the API key to a caller that might log it', () => {
  const ctx = jevContext('review', { config: parseJevConfig({}), key: 'secret' });
  assert.ok(!JSON.stringify(ctx).includes('secret'));
  assert.equal(ctx.hasKey, true);
});

test('logDecision writes the log owner-only (it can quote private code)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-'));
  logDecision({ rail: 'review', mode: 'jev', decider: 'jev', text: 't' }, { root: dir });
  assert.equal(statSync(join(dir, '.jev', 'decisions.jsonl')).mode & 0o777, 0o600);
});

// ── D12 through the loader: the new file's null must not become `true` (review of the S5 diff) ──────────────
test('loadJevConfig: egress:null in golden-frijoles.config.json with no legacy file is unanswered — fetch is never called', async () => {
  _resetAsked();
  const dir = mkdtempSync(join(tmpdir(), 'jev-'));
  writeFileSync(
    join(dir, 'golden-frijoles.config.json'),
    JSON.stringify({ jev: { egress: null, rails: { review: { mode: 'jev' }, prose: { mode: 'jev' } } } })
  );
  const config = loadJevConfig({ root: dir });
  assert.equal(config.egress, null);
  let fetches = 0;
  const writes = [];
  const ctx = jevContext('prose', {
    config,
    key: 'k',
    root: dir,
    fetch: async () => {
      fetches += 1;
      throw new Error('must not send');
    },
    write: (s) => writes.push(s),
  });
  assert.equal(ctx.mode, 'off');
  assert.equal(fetches, 0);
  assert.equal(writes.length, 1, 'the question is asked once');
  _resetAsked();
});

test('loadJevConfig: a section that never mentions egress is unanswered too; an explicit true still sends', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-'));
  writeFileSync(join(dir, 'golden-frijoles.config.json'), JSON.stringify({ jev: { rails: { review: { mode: 'jev' } } } }));
  assert.equal(loadJevConfig({ root: dir }).egress, null);
  writeFileSync(join(dir, 'jev.config.json'), JSON.stringify({ egress: true, rails: { review: { mode: 'jev' } } }));
  assert.equal(loadJevConfig({ root: dir }).egress, true, 'a consumer committed true: unchanged');
});

// ── distribute-what-we-use S3.1 (D7): the stranger with NO config is asked, and nothing is sent ─────────
// Two bugs made D12's ask dead code for exactly that user: (1) no config at all loaded as
// parseJevConfig({}), whose egress defaults to TRUE; (2) effectiveMode returned "configured off" (every
// rail's default) before it ever looked at egress. Observed failing on the code before this fix.
test('D7: no config at all → egress is UNANSWERED (null), not true', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-none-'));
  assert.equal(loadJevConfig({ root: dir }).egress, null);
});

test('D7: no config at all → the first guarded run asks once, stays off, and never calls fetch', () => {
  _resetAsked();
  const dir = mkdtempSync(join(tmpdir(), 'jev-none-'));
  const writes = [];
  let fetches = 0;
  const ctx = jevContext('review', {
    root: dir,
    key: 'k',
    fetch: async () => {
      fetches += 1;
      throw new Error('must not send before egress: true');
    },
    write: (s) => writes.push(s),
  });
  assert.equal(ctx.mode, 'off');
  assert.equal(writes.length, 1, 'GF-NEEDS-SETTING jev.egress is emitted');
  assert.equal(JSON.parse(writes[0].slice('GF-NEEDS-SETTING '.length)).key, 'jev.egress');
  assert.equal(fetches, 0);
  _resetAsked();
});

test('D7: egress unanswered + a rail left at its default "off" still asks (the default mode never hides it)', () => {
  _resetAsked();
  const writes = [];
  const ctx = jevContext('prose', {
    config: parseJevConfig({ egress: null }),
    key: 'k',
    root: mkdtempSync(join(tmpdir(), 'jev-')),
    write: (s) => writes.push(s),
  });
  assert.equal(ctx.mode, 'off');
  assert.equal(writes.length, 1);
  _resetAsked();
});

test('D7: egress:false never asks and never sends, whatever the rail mode', () => {
  for (const mode of ['off', 'jev']) {
    const ctx = jevContext('review', {
      config: parseJevConfig({ egress: false, rails: { review: mode === 'jev' ? { mode } : {} } }),
      key: 'k',
      write: () => assert.fail('egress:false must never emit GF-NEEDS-SETTING'),
    });
    assert.equal(ctx.mode, 'off');
  }
});
