// roadmap-push — pure envelope/extract tests.
//
// The envelope is what the server validates, so it is what is worth pinning here. Two specific
// hazards get their own cases:
//
//   1. `undefined` vs `null` in `source`. JSON.stringify silently DROPS undefined keys, so a
//      "commit: undefined" becomes an absent field rather than an explicit null — harder to
//      diagnose from the server side, and a different shape than the schema documents.
//   2. Empty extract output. Roadmap/LEARNINGS.md: treat empty output from a young CLI as FAILURE,
//      never as success. Pushing an empty roadmap would store a permanently-wrong immutable
//      artifact, and the migration rejects it anyway — better to fail here with a readable message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBoard,
  buildEnvelope,
  readExtract,
  repoBlobBase,
  ROADMAP_SCHEMA_VERSION,
} from './roadmap-push.mjs';

const rows = [
  { name: 'An epic', slug: 'an-epic', grain: 'Epic', status: 'Shipped', area: '01 Growth Engine' },
];

test('buildEnvelope carries the schema version, provenance and the rows', () => {
  const env = buildEnvelope(rows, {
    commit: 'abc1234',
    ref: 'main',
    generatedAt: '2026-07-25T00:00:00.000Z',
  });
  assert.equal(env.schemaVersion, ROADMAP_SCHEMA_VERSION);
  assert.equal(env.generatedAt, '2026-07-25T00:00:00.000Z');
  assert.deepEqual(env.source, { commit: 'abc1234', ref: 'main' });
  assert.deepEqual(env.items, rows);
});

test('buildEnvelope emits explicit nulls, never undefined, so JSON.stringify cannot drop them', () => {
  const env = buildEnvelope(rows);
  assert.equal(env.source.commit, null);
  assert.equal(env.source.ref, null);
  const round = JSON.parse(JSON.stringify(env));
  assert.ok('commit' in round.source, 'commit must survive serialisation as an explicit null');
  assert.ok('ref' in round.source, 'ref must survive serialisation as an explicit null');
});

test('buildEnvelope defaults generatedAt to a valid ISO instant', () => {
  const env = buildEnvelope(rows);
  assert.ok(!Number.isNaN(Date.parse(env.generatedAt)), `not a parseable instant: ${env.generatedAt}`);
});

test('readExtract treats EMPTY generator output as failure, not as an empty roadmap', () => {
  assert.throws(() => readExtract(() => ({ status: 0, stdout: '   ', stderr: '' })), /empty as failure/i);
});

test('readExtract refuses an empty array — an immutable empty artifact is unfixable', () => {
  assert.throws(
    () => readExtract(() => ({ status: 0, stdout: '[]', stderr: '' })),
    /refusing to push an empty/i
  );
});

test('readExtract surfaces a generator crash with its own last line', () => {
  assert.throws(
    () => readExtract(() => ({ status: 1, stdout: '', stderr: 'boom\nsomething specific broke' })),
    /something specific broke/
  );
});

test('readExtract parses real extract output', () => {
  const out = JSON.stringify(rows);
  assert.deepEqual(
    readExtract(() => ({ status: 0, stdout: out, stderr: '' })),
    rows
  );
});

// This file ships in the kit and the template too (board-sinks-and-scrumban S3.2), where the engine's source and this
// repo's workflow are not in the checkout — those two pins run where the files are, and say why they skip elsewhere.
const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SCHEMA = join(HERE, '..', 'apps', 'web', 'lib', 'roadmap-artifact-schema.ts');
const PUSH_WORKFLOW = join(HERE, '..', '.github', 'workflows', 'roadmap-push.yml');

test(
  'the script and the server agree on ROADMAP_SCHEMA_VERSION',
  { skip: !existsSync(ENGINE_SCHEMA) && 'the engine source is not in this checkout' },
  () => {
    // The constant is duplicated because this zero-dependency .mjs cannot import the TypeScript module
    // behind Next's `@/` alias. Duplication is acceptable ONLY while something proves the two agree —
    // otherwise the client happily pushes a version the server will 400 on, and the failure appears at
    // deploy time rather than here.
    const ts = readFileSync(ENGINE_SCHEMA, 'utf8');
    const m = ts.match(/export const ROADMAP_SCHEMA_VERSION = (\d+)/);
    assert.ok(m, 'could not find ROADMAP_SCHEMA_VERSION in the schema module — did it move?');
    assert.equal(
      Number(m[1]),
      ROADMAP_SCHEMA_VERSION,
      'scripts/roadmap-push.mjs and lib/roadmap-artifact-schema.ts disagree on the schema version'
    );
  }
);

// ── board-sinks-and-scrumban S1.3 ─────────────────────────────────────────────────────────────────────────

test('readExtract runs the ONE extractor with live facts (D15, D14)', () => {
  let argv = null;
  readExtract((cmd, args) => {
    argv = [cmd, ...args];
    return { status: 0, stdout: '[{"slug":"a"}]', stderr: '' };
  });
  assert.match(argv[1], /roadmap-extract\.mjs$/);
  assert.deepEqual(
    argv.slice(2),
    ['--live', '--require-live'],
    'a failed gather must fail, not publish docs-only'
  );
});

test('repoBlobBase maps the origin remote to the https blob base doc links resolve against', () => {
  assert.equal(
    repoBlobBase('git@github.com:danybgoode/golden-frijoles.git'),
    'https://github.com/danybgoode/golden-frijoles/blob/main/'
  );
  assert.equal(repoBlobBase('https://github.com/o/r.git', 'trunk'), 'https://github.com/o/r/blob/trunk/');
  assert.equal(
    repoBlobBase('https://x-access-token:abc@github.com/o/r'),
    'https://github.com/o/r/blob/main/'
  );
  assert.equal(
    repoBlobBase('https://gitlab.com/o/r.git'),
    null,
    'an unknown host is left out, never guessed'
  );
  assert.equal(repoBlobBase(null), null);
  assert.equal(repoBlobBase('https://github.com/o/r', 'main"><script>'), null);
});

test('buildBoard keeps positive integer limits only, and is null when there is nothing to send', () => {
  assert.equal(buildBoard({ wip: null, repo: null }), null);
  assert.deepEqual(buildBoard({ wip: { Building: 2, QA: 0, Shipped: 9 }, repo: null }), {
    wip: { Building: 2 },
  });
  assert.deepEqual(buildBoard({ wip: { Building: 2, QA: 3 }, repo: 'https://github.com/o/r/blob/main/' }), {
    wip: { Building: 2, QA: 3 },
    repo: 'https://github.com/o/r/blob/main/',
  });
});

test('buildEnvelope omits an empty board rather than sending null (the unchanged-board check compares content)', () => {
  assert.equal('board' in buildEnvelope([{ slug: 'a' }], { commit: 'abc1234', ref: 'main' }), false);
  const e = buildEnvelope([{ slug: 'a' }], { board: { wip: { Building: 2 } } });
  assert.deepEqual(e.board, { wip: { Building: 2 } });
});

test(
  'roadmap-push.yml: the board re-pushes on the events that move a card, from main, newest-wins (D18)',
  { skip: !existsSync(PUSH_WORKFLOW) && 'this repo’s workflow is not in this checkout' },
  () => {
    const text = readFileSync(PUSH_WORKFLOW, 'utf8');
    const on = text.slice(text.indexOf('\non:'), text.indexOf('\npermissions:'));
    for (const trigger of ['push:', 'create:', 'delete:', 'pull_request:', 'workflow_dispatch:'])
      assert.ok(on.includes(`\n  ${trigger}`), `triggers on ${trigger}`);
    assert.match(on, /types: \[opened, reopened, ready_for_review, converted_to_draft, closed\]/);
    assert.match(on, /push:\n {4}branches: \[main\]/, 'a push re-renders the board only from main');
    assert.match(text, /\n {2}pull-requests: read\n/);
    const job = text.slice(text.indexOf('\n  push-roadmap:'), text.indexOf('\n  push-pod-report:'));
    assert.match(
      job,
      /group: roadmap-push\n\s+cancel-in-progress: false/,
      'ONE group, so the newest board wins'
    );
    assert.match(job, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/, "always main's docs");
    assert.match(job, /fetch-depth: 0/, 'status_date needs history');
    assert.doesNotMatch(job, /run: npm ci/, 'the push is zero-dependency');
    assert.match(job, /head\.repo\.full_name == github\.repository/, 'fork PRs never run it');
    assert.match(job, /run: node scripts\/roadmap-push\.mjs/);
  }
);

// ── board-sinks-and-scrumban S3.2 — the push, in-process ─────────────────────────────────────────────────────────

test("apiKeyFrom reads the SDK name first and this repo's CI name as a fallback", async () => {
  const { apiKeyFrom } = await import('./roadmap-push.mjs');
  assert.equal(apiKeyFrom({ GROWTH_ENGINE_API_KEY: 'a', SELF_PROJECT_API_KEY: 'b' }), 'a');
  assert.equal(apiKeyFrom({ SELF_PROJECT_API_KEY: 'b' }), 'b');
  assert.equal(apiKeyFrom({}), null);
});

test('pushRoadmap: no key is a clean skip that sends nothing; with a key it POSTs to /api/v1/roadmap/push', async () => {
  const { pushRoadmap } = await import('./roadmap-push.mjs');
  const calls = [];
  const fetchFn = async (url, init) => (
    calls.push({ url, init }),
    { ok: true, status: 200, text: async () => '{"ok":true}' }
  );
  const skipped = await pushRoadmap([{ slug: 'a' }], { apiKey: null, fetchFn });
  assert.deepEqual([skipped.ok, skipped.skipped, calls.length], [true, true, 0]);
  const sent = await pushRoadmap([{ slug: 'a' }], {
    apiKey: 'k',
    baseUrl: 'https://engine.example/',
    fetchFn,
  });
  assert.deepEqual([sent.ok, sent.status], [true, 200]);
  assert.equal(calls[0].url, 'https://engine.example/api/v1/roadmap/push');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.items, [{ slug: 'a' }]);
  assert.equal(body.schemaVersion, 1);
});
