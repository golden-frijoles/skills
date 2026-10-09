// bets-grounded.test.mjs — the grounded_bets_share count and its push (grounded-bets D2–D4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  INPUT_KEY,
  engineInputKeys,
  isGrounded,
  monthOf,
  northStarInputKeys,
  pushShare,
  readProject,
  shareByMonth,
} from './bets-grounded.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS = ['grounded_bets_share', 'proving_workspaces'];
const target = { target_metric: 'grounded_bets_share', target_from: 0, target_to: 0.6 };

test('D3: the month comes from the ledger name; the backfill has none', () => {
  assert.equal(monthOf('wave-2026-10'), '2026-10');
  assert.equal(monthOf('wave-2026-10-04-launch'), '2026-10');
  assert.equal(monthOf('wave-2026-09-16-plugin.md'), '2026-09');
  assert.equal(monthOf('wave-backfill'), null);
  assert.equal(monthOf('wave-2026-1'), null);
});

test('D2: grounded is a North Star input target with a from and a to, whatever the field says', () => {
  assert.equal(isGrounded(target, KEYS), true);
  assert.equal(
    isGrounded({ ...target, read_date: null }, KEYS),
    true,
    'a blank read date is the 30-day default'
  );
  assert.equal(isGrounded({ ...target, target_metric: 'free text' }, KEYS), false);
  assert.equal(isGrounded({ target_metric: 'grounded_bets_share', target_from: 0 }, KEYS), false);
  assert.equal(isGrounded({ grounded: 'true' }, KEYS), false);
  assert.equal(isGrounded(target, []), false, 'no strategy: nothing can be grounded');
});

test('D3: a month counts features and spikes, leaves out bugs, chores and the backfill, and reports an unbacked true', () => {
  const docs = new Map([
    ['a', { underwritten_by: 'wave-2026-10', type: 'feature', ...target }],
    ['b', { underwritten_by: 'wave-2026-10-04-launch', type: 'feature' }],
    ['c', { underwritten_by: 'wave-2026-10', type: 'chore', ...target }],
    ['d', { underwritten_by: 'wave-2026-10', type: 'Bug' }],
    ['e', { underwritten_by: 'wave-2026-10', type: 'spike', grounded: 'true' }],
    ['f', { underwritten_by: 'wave-backfill', type: 'feature', ...target }],
    ['g', { underwritten_by: null, type: 'feature', ...target }],
    ['h', { underwritten_by: 'wave-2026-09-24', type: 'feature' }],
  ]);
  const rows = shareByMonth({ docs, inputKeys: KEYS });
  assert.deepEqual(
    rows.map((r) => r.month),
    ['2026-09', '2026-10']
  );
  const oct = rows[1];
  assert.equal(oct.total, 3);
  assert.deepEqual(oct.grounded, ['a']);
  assert.deepEqual(oct.excluded, ['c', 'd']);
  assert.deepEqual(oct.unbacked, ['e']);
  assert.equal(oct.share, 0.3333);
  assert.deepEqual(
    shareByMonth({ docs, inputKeys: KEYS, month: '2026-09' }).map((r) => r.share),
    [0]
  );
});

test('the reader: a bet is its seed (the funding stamp) overlaid by its epic README (authoritative)', () => {
  const root = mkdtempSync(join(tmpdir(), 'bets-grounded-'));
  try {
    const w = (path, text) => {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    w(
      'Roadmap/00-ideas/seeds/x.md',
      '---\nslug: x\nunderwritten_by: wave-2026-10\ntype: feature\ntarget_metric: null\n---\n'
    );
    w(
      'Roadmap/09-infra/x/README.md',
      '---\nstatus: shipped\ntype: feature\ntarget_metric: grounded_bets_share\ntarget_from: 0\ntarget_to: 0.6\n---\n'
    );
    w(
      'Roadmap/00-strategy/north-star.md',
      '# NS\n\n## Sync payload\n\n```json\n{"metric":{"key":"m"},"inputs":[{"key":"grounded_bets_share"},{"key":"<input_key>"}]}\n```\n'
    );
    const { docs, inputKeys } = readProject(root);
    assert.deepEqual(inputKeys, ['grounded_bets_share'], 'an unfilled template key is not an input');
    assert.equal(docs.get('x').underwritten_by, 'wave-2026-10');
    assert.equal(docs.get('x').target_metric, 'grounded_bets_share');
    assert.deepEqual(
      shareByMonth({ docs, inputKeys }).map((r) => r.share),
      [1]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('northStarInputKeys: no payload, or one that does not parse, is no inputs', () => {
  assert.deepEqual(northStarInputKeys(''), []);
  assert.deepEqual(northStarInputKeys('## Sync payload\n\n```json\n{oops\n```\n'), []);
});

const row = { month: '2026-10', total: 15, grounded: ['a'], excluded: [], unbacked: [], share: 0.0667 };
function fakeFetch(reply, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply), { status });
  };
  return { calls, fetchImpl };
}

test('D4: the push posts today’s share for this month, with the project’s own key first', async () => {
  const f = fakeFetch({ ok: true, inserted: 1, skippedDuplicates: 0, mismatchedDuplicates: [] });
  const env = {
    SELF_PROJECT_API_KEY: 'gk_self',
    GROWTH_ENGINE_API_KEY: 'gk_other',
    GROWTH_ENGINE_URL: 'https://e.test/',
  };
  const r = await pushShare({
    rows: [row],
    inputKeys: KEYS,
    env,
    fetchImpl: f.fetchImpl,
    today: '2026-10-09',
  });
  assert.equal(r.ok, true);
  assert.equal(r.line, `pushed ${INPUT_KEY} = 0.0667 for 2026-10-09`);
  assert.equal(f.calls[0].url, 'https://e.test/api/v1/inputs/grounded_bets_share/values');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer gk_self');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {
    values: [{ occurredOn: '2026-10-09', value: 0.0667 }],
  });
});

test('D4: every skip is clean and says why, and sends nothing', async () => {
  const f = fakeFetch({});
  const env = { SELF_PROJECT_API_KEY: 'k' };
  const skip = (args) =>
    pushShare({ rows: [row], inputKeys: KEYS, env, fetchImpl: f.fetchImpl, today: '2026-10-09', ...args });
  assert.match((await skip({ inputKeys: ['proving_workspaces'] })).line, /has no grounded_bets_share input/);
  assert.match((await skip({ today: '2026-11-01' })).line, /no counted bets in 2026-11/);
  assert.match((await skip({ env: {} })).line, /no SELF_PROJECT_API_KEY or GROWTH_ENGINE_API_KEY/);
  assert.equal(f.calls.length, 0);
});

test('D4: a second push the same day is reported, never an error; a refusal is a failure with its reason', async () => {
  const env = { SELF_PROJECT_API_KEY: 'k' };
  const same = fakeFetch({
    ok: true,
    inserted: 0,
    skippedDuplicates: 1,
    mismatchedDuplicates: ['2026-10-09'],
  });
  const r1 = await pushShare({
    rows: [row],
    inputKeys: KEYS,
    env,
    fetchImpl: same.fetchImpl,
    today: '2026-10-09',
  });
  assert.equal(r1.ok, true);
  assert.match(r1.line, /the first value of a day stands/);
  const refused = fakeFetch({ ok: false, error: 'unknown input' }, 404);
  const r2 = await pushShare({
    rows: [row],
    inputKeys: KEYS,
    env,
    fetchImpl: refused.fetchImpl,
    today: '2026-10-09',
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.line, 'push failed (404): unknown input');
});

test('verifier #334: with the strategy private, the engine names the input keys; no key is a skip, a failure an error', async () => {
  const env = { SELF_PROJECT_API_KEY: 'gk_self', GROWTH_ENGINE_URL: 'https://e.test' };
  const ok = fakeFetch({
    ok: true,
    metrics: [{ key: 'proven_bets', inputs: [{ key: 'grounded_bets_share' }, { key: 'x' }] }],
  });
  assert.deepEqual(await engineInputKeys({ env, fetchImpl: ok.fetchImpl }), {
    keys: ['grounded_bets_share', 'x'],
  });
  assert.equal(ok.calls[0].url, 'https://e.test/api/v1/north-star');
  assert.equal(ok.calls[0].init.headers.Authorization, 'Bearer gk_self');
  assert.match((await engineInputKeys({ env: {}, fetchImpl: ok.fetchImpl })).skip, /no SELF_PROJECT_API_KEY/);
  assert.equal(ok.calls.length, 1, 'no key: no request');
  assert.match(
    (await engineInputKeys({ env, fetchImpl: fakeFetch({ ok: false }, 500).fetchImpl })).error,
    /could not be read \(500\)/
  );
  const boom = async () => {
    throw new Error('fetch failed gk_self');
  };
  const failed = await engineInputKeys({ env, fetchImpl: boom });
  assert.match(failed.error, /network error/);
  assert.doesNotMatch(JSON.stringify(failed), /gk_self/);
});

test('verifier #334: --push exits 1 naming the cause when the engine cannot be read, and 0 when there is no key', () => {
  const root = mkdtempSync(join(tmpdir(), 'bets-grounded-cli-'));
  try {
    const run = (env) =>
      spawnSync(process.execPath, [join(HERE, 'bets-grounded.mjs'), '--root', root, '--push'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, ...env },
      });
    const down = run({ SELF_PROJECT_API_KEY: 'k', GROWTH_ENGINE_URL: 'http://127.0.0.1:9' });
    assert.equal(down.status, 1);
    assert.match(down.stderr, /push failed: the engine's North Star could not be read/);
    const nokey = run({});
    assert.equal(nokey.status, 0);
    assert.match(nokey.stderr, /push skipped: no SELF_PROJECT_API_KEY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
