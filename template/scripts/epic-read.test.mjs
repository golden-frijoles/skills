// epic-read.test.mjs — the read (result-record S2.1, D8): drafted by the agent, written only on approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftVerdict, fetchEvidence, main, planRead, runGf } from './epic-read.mjs';
import { parseDocFrontmatter, validateEpicFrontmatter } from './lib/roadmap-contract.mjs';

const TARGET = {
  target_metric: 'invoices_paid_on_time',
  target_from: 61,
  target_to: 70,
  read_date: '2026-11-04',
};
const plan = (over = {}) =>
  planRead({ fm: TARGET, shippedAt: '2026-10-04', shipped: true, today: '2026-11-05', ...over });

test('the draft: reached or passed → proven, short → disproven, no number → unclear; direction from → to', () => {
  assert.equal(draftVerdict({ from: 61, to: 70, actual: 72 }), 'proven');
  assert.equal(draftVerdict({ from: 61, to: 70, actual: 70 }), 'proven', 'meeting the target is reaching it');
  assert.equal(draftVerdict({ from: 61, to: 70, actual: 69.9 }), 'disproven');
  assert.equal(draftVerdict({ from: 44, to: 30, actual: 29 }), 'proven', 'a target that goes down');
  assert.equal(draftVerdict({ from: 44, to: 30, actual: 31 }), 'disproven');
  assert.equal(draftVerdict({ from: 61, to: 70, actual: null }), 'unclear');
  assert.equal(
    draftVerdict({ from: null, to: null, actual: 5 }),
    'unclear',
    'a target with no numbers cannot be met'
  );
});

test('before the read date it says when the read is due and stops', () => {
  const p = plan({ today: '2026-11-03' });
  assert.equal(p.state, 'not-due');
  assert.equal(p.readDate, '2026-11-04');
  const derived = plan({ fm: { ...TARGET, read_date: null }, today: '2026-10-20' });
  assert.deepEqual([derived.state, derived.readDate, derived.derived], ['not-due', '2026-11-03', true]);
});

test('not shipped, or already read: nothing to draft', () => {
  assert.equal(plan({ shipped: false }).state, 'not-shipped');
  assert.equal(
    plan({ fm: { ...TARGET, verdict: 'proven', verdict_at: '2026-11-04' } }).state,
    'already-read'
  );
});

test('a draft with its evidence is ready; proven or disproven without evidence is refused as needs-input', () => {
  const ready = plan({ actual: 72, evidence: 'north-star:invoices_paid_on_time@2026-11-04' });
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.fields, {
    verdict: 'proven',
    verdict_actual: 72,
    verdict_evidence: 'north-star:invoices_paid_on_time@2026-11-04',
    verdict_at: '2026-11-05',
  });
  assert.equal(plan({ actual: 72 }).state, 'needs-input');
  const vague = plan({ actual: 72, evidence: 'it went up' });
  assert.equal(vague.state, 'refused', 'evidence that points nowhere is refused by the contract');
  assert.match(vague.reasons.join(), /points somewhere/);
});

test('no number: unclear, and it needs the reason', () => {
  assert.equal(plan().state, 'needs-input');
  const p = plan({ evidence: 'traffic too low to tell (n = 18)' });
  assert.equal(p.state, 'ready');
  assert.deepEqual([p.fields.verdict, p.fields.verdict_actual], ['unclear', null]);
});

test('the owner’s word over the draft, said as such; a bad --verdict is refused', () => {
  const p = plan({ actual: 72, evidence: 'ab:reminders', verdict: 'unclear' });
  assert.deepEqual([p.state, p.owner, p.drafted, p.fields.verdict], ['ready', true, 'proven', 'unclear']);
  assert.equal(plan({ verdict: 'provn' }).state, 'refused');
});

test('more than 90 days after shipping: written, and marked late', () => {
  const p = plan({ today: '2027-01-10', actual: 72, evidence: 'https://example.com/r' });
  assert.deepEqual([p.state, p.late], ['ready', true]);
  assert.equal(plan({ actual: 72, evidence: 'https://example.com/r' }).late, false);
});

test('a shipped epic with no target: an owner verdict with evidence, one at a time', () => {
  const none = planRead({ fm: {}, shippedAt: '2026-01-01', shipped: true, today: '2026-11-05' });
  assert.equal(none.state, 'needs-input');
  assert.match(none.need, /no target/);
  const owner = planRead({
    fm: {},
    shippedAt: '2026-01-01',
    shipped: true,
    today: '2026-11-05',
    verdict: 'proven',
    actual: 40,
    evidence: 'https://example.com/report',
  });
  assert.equal(owner.state, 'ready');
});

// ── the CLI, on a real README ───────────────────────────────────────────────────────────────────────────────────

function fixture(extra) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'epic-read-')));
  const dir = join(root, 'Roadmap', '09-platform-infra', 'reminders');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, 'Roadmap', '00-ideas', 'seeds'), { recursive: true });
  const readme = join(dir, 'README.md');
  writeFileSync(
    readme,
    [
      '---',
      'status: shipped',
      'phase: Shipped',
      'slug: reminders',
      'title: "Overdue reminders"',
      'area: 09-platform-infra',
      'risk: low',
      'type: feature',
      'sprints_total: 0',
      'stories_total: 0',
      'target_metric: invoices_paid_on_time',
      'target_from: 61',
      'target_to: 70',
      'read_date: 2026-11-04',
      'verdict: null        # stamped by epic-read',
      'verdict_actual: null',
      'verdict_evidence: null',
      'verdict_at: null',
      ...extra,
      '---',
      '# Epic: Overdue reminders',
      '',
    ].join('\n')
  );
  return { root, readme, done: () => rmSync(root, { recursive: true, force: true }) };
}

// A spawn that answers like gf would, from a table of `args joined` → { status, body } (or `enoent`).
function gfStub(table, seen = []) {
  return (bin, args) => {
    seen.push([bin, ...args]);
    const key = args.filter((a) => a !== '--json').join(' ');
    const hit = Object.entries(table).find(([k]) => key.startsWith(k));
    if (!hit) return { error: Object.assign(new Error('spawn gf ENOENT'), { code: 'ENOENT' }) };
    const [, answer] = hit;
    return { status: answer.status ?? 0, stdout: JSON.stringify(answer.body), stderr: '' };
  };
}

const NO_GF = () => ({ error: Object.assign(new Error('spawn gf ENOENT'), { code: 'ENOENT' }) });

async function run(root, args, { env = {}, spawnFn = NO_GF } = {}) {
  let out = '';
  const code = await main(['--repo-root', root, '--epic', 'reminders', ...args], {
    env,
    spawnFn,
    stdout: { write: (s) => (out += s) },
  });
  return { code, out };
}

test('CLI: before the date it stops; without --write it never writes; --write stamps a contract-valid record', async () => {
  const f = fixture([]);
  try {
    const before = readFileSync(f.readme, 'utf8');
    const early = await run(f.root, ['--today', '2026-11-01']);
    assert.equal(early.code, 0);
    assert.match(early.out, /read due 4 Nov 2026/);
    const draft = await run(f.root, [
      '--today',
      '2026-11-05',
      '--actual',
      '72',
      '--evidence',
      'ab:reminders',
    ]);
    assert.equal(draft.code, 0);
    assert.match(draft.out, /verdict: {2}proven/);
    assert.match(draft.out, /Not written/);
    assert.equal(readFileSync(f.readme, 'utf8'), before, 'no --write, no write');
    const refused = await run(f.root, ['--today', '2026-11-05', '--actual', '72', '--write']);
    assert.equal(refused.code, 1, 'asked to write with no evidence');
    assert.equal(readFileSync(f.readme, 'utf8'), before);
    const wrote = await run(f.root, [
      '--today',
      '2026-11-05',
      '--actual',
      '72',
      '--evidence',
      'ab:reminders',
      '--write',
    ]);
    assert.equal(wrote.code, 0);
    const parsed = parseDocFrontmatter(readFileSync(f.readme, 'utf8'));
    assert.equal(parsed.data.verdict, 'proven');
    assert.equal(parsed.data.verdict_actual, 72);
    assert.equal(parsed.data.verdict_evidence, 'ab:reminders');
    assert.equal(parsed.data.verdict_at, '2026-11-05');
    assert.deepEqual(validateEpicFrontmatter(parsed), []);
    assert.doesNotMatch(wrote.out, /could not fetch/, 'the owner gave --actual: nothing is fetched over it');
    const again = await run(f.root, ['--today', '2026-11-06']);
    assert.match(again.out, /already read: proven on 5 Nov 2026/);
  } finally {
    f.done();
  }
});

const READINGS = (latest) => ({
  ok: true,
  project: 'acme',
  input: { key: 'invoices_paid_on_time', name: 'Paid on time', valueSource: 'external_push' },
  readings: latest ? [latest] : [],
  latest,
});

test('S3.3: with gf signed in, the read arrives with the number and its pointer; --write approves it', async () => {
  const f = fixture([]);
  try {
    const seen = [];
    const spawnFn = gfStub(
      { 'north-star readings invoices_paid_on_time': { body: READINGS({ date: '2026-11-04', value: 72 }) } },
      seen
    );
    const draft = await run(f.root, ['--today', '2026-11-05', '--project', 'acme'], {
      env: { GF_BIN: '/x/gf' },
      spawnFn,
    });
    assert.deepEqual(seen[0], [
      '/x/gf',
      'north-star',
      'readings',
      'invoices_paid_on_time',
      '--to',
      '2026-11-04', // complete days only: the day before the read (today's count is partial)
      '--project',
      'acme',
      '--json',
    ]);
    assert.match(draft.out, /grounded: invoices_paid_on_time is one of the project's North Star inputs/);
    assert.match(draft.out, /fetched: {2}72 on 4 Nov 2026/);
    assert.match(draft.out, /verdict: {2}proven/);
    assert.match(draft.out, /evidence: north-star:invoices_paid_on_time@2026-11-04/);
    const wrote = await run(f.root, ['--today', '2026-11-05', '--write'], { spawnFn });
    assert.equal(wrote.code, 0);
    const fm = parseDocFrontmatter(readFileSync(f.readme, 'utf8')).data;
    assert.deepEqual(
      [fm.verdict, fm.verdict_actual, fm.verdict_evidence],
      ['proven', 72, 'north-star:invoices_paid_on_time@2026-11-04']
    );
  } finally {
    f.done();
  }
});

test('S3.3: the owner’s --actual wins — nothing is fetched over it', async () => {
  const f = fixture([]);
  try {
    const seen = [];
    await run(f.root, ['--today', '2026-11-05', '--actual', '65', '--evidence', 'ab:x'], {
      spawnFn: gfStub({}, seen),
    });
    assert.deepEqual(seen, []);
  } finally {
    f.done();
  }
});

test('S3.3: an owner reason or verdict is their answer — nothing is fetched over it (fresh review, #293)', async () => {
  const f = fixture([]);
  try {
    const seen = [];
    const spawnFn = gfStub(
      { 'north-star readings': { body: READINGS({ date: '2026-11-04', value: 72 }) } },
      seen
    );
    const reason = await run(f.root, ['--today', '2026-11-05', '--evidence', 'traffic too low (n = 18)'], {
      spawnFn,
    });
    assert.deepEqual(seen, []);
    assert.match(reason.out, /verdict: {2}unclear/);
    await run(f.root, ['--today', '2026-11-05', '--verdict', 'unclear', '--evidence', 'n = 18'], { spawnFn });
    assert.deepEqual(seen, []);
  } finally {
    f.done();
  }
});

test('S3.3: a wrong project is "could not fetch", never "not grounded"', async () => {
  const f = fixture([]);
  try {
    const out = await run(f.root, ['--today', '2026-11-05', '--project', 'typo'], {
      spawnFn: gfStub({
        'north-star readings': {
          status: 3,
          body: { ok: false, code: 'not_found', error: 'No project `typo` is available.' },
        },
      }),
    });
    assert.doesNotMatch(out.out, /not grounded/);
    assert.match(out.out, /could not fetch the number: No project `typo` is available/);
  } finally {
    f.done();
  }
});

test('S3.3: every failure falls back to asking, with its reason', async () => {
  const f = fixture([]);
  try {
    const missing = await run(f.root, ['--today', '2026-11-05']);
    assert.match(missing.out, /could not fetch the number: gf is not installed/);
    assert.match(missing.out, /needs: Ask the owner/);
    const signedOut = await run(f.root, ['--today', '2026-11-05'], {
      spawnFn: gfStub({
        'north-star readings': { status: 2, body: { ok: false, code: 'unauthorized', error: 'x' } },
      }),
    });
    assert.match(signedOut.out, /could not fetch the number: gf is not signed in \(run gf login\)/);
    const unknown = await run(f.root, ['--today', '2026-11-05'], {
      spawnFn: gfStub({
        'north-star readings': {
          status: 3,
          body: { ok: false, code: 'not_found', error: 'No North Star input' },
        },
      }),
    });
    assert.match(unknown.out, /not grounded: invoices_paid_on_time/);
    const empty = await run(f.root, ['--today', '2026-11-05'], {
      spawnFn: gfStub({ 'north-star readings': { body: READINGS(null) } }),
    });
    assert.match(empty.out, /could not fetch the number: no reading of invoices_paid_on_time yet/);
    assert.equal(parseDocFrontmatter(readFileSync(f.readme, 'utf8')).data.verdict, null, 'nothing written');
  } finally {
    f.done();
  }
});

test('S3.3: a reading from before the epic shipped is not evidence for it; a recorded decision becomes the pointer', () => {
  const run = gfStub({
    'north-star readings': { body: READINGS({ date: '2026-09-30', value: 60 }) },
    'experiments decision smart-defaults': {
      body: {
        ok: true,
        decisions: { state: 'decided', current: { outcome: 'ship_treatment', chosenVariantKey: 'b' } },
      },
    },
  });
  const old = fetchEvidence({
    metric: 'm',
    today: '2026-11-05',
    shippedAt: '2026-10-04',
    run: (a) => runGf(a, { spawnFn: run, env: {} }),
  });
  assert.equal(old.fetched, false);
  assert.match(old.why, /no reading of m since it shipped \(the latest is 2026-09-30\)/);
  const withAb = fetchEvidence({
    metric: 'm',
    experiment: 'smart-defaults',
    today: '2026-11-05',
    shippedAt: '2026-09-01',
    run: (a) => runGf(a, { spawnFn: run, env: {} }),
  });
  assert.deepEqual(
    [withAb.actual, withAb.evidence, withAb.decision.outcome],
    [60, 'ab:smart-defaults', 'ship_treatment']
  );
});
