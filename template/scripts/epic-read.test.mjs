// epic-read.test.mjs — the read (result-record S2.1, D8): drafted by the agent, written only on approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftVerdict, groundedCheck, main, planRead } from './epic-read.mjs';
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

async function run(root, args, { env = {}, fetchFn } = {}) {
  let out = '';
  const code = await main(['--repo-root', root, '--epic', 'reminders', ...args], {
    env,
    fetchFn:
      fetchFn ??
      (async () => {
        throw new Error('no network in tests');
      }),
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
    assert.match(wrote.out, /could not check the metric against the North Star \(no project key/);
    const again = await run(f.root, ['--today', '2026-11-06']);
    assert.match(again.out, /already read: proven on 5 Nov 2026/);
  } finally {
    f.done();
  }
});

test('CLI: with a key it says whether the metric is grounded; a failing engine is "could not check"', async () => {
  const f = fixture([]);
  try {
    const seen = [];
    const ok = await run(f.root, ['--today', '2026-11-05'], {
      env: { SELF_PROJECT_API_KEY: 'k', GROWTH_ENGINE_URL: 'https://engine.test' },
      fetchFn: async (url, init) => {
        seen.push([url, init.headers.Authorization]);
        return {
          ok: true,
          json: async () => ({ metrics: [{ key: 'm', inputs: [{ key: 'invoices_paid_on_time' }] }] }),
        };
      },
    });
    assert.deepEqual(seen, [['https://engine.test/api/v1/north-star', 'Bearer k']]);
    assert.match(ok.out, /grounded: invoices_paid_on_time is one of the project's North Star inputs/);
    const down = await groundedCheck({
      metric: 'x',
      apiKey: 'k',
      baseUrl: 'https://engine.test',
      fetchFn: async () => ({ ok: false, status: 503 }),
    });
    assert.deepEqual(down, { checked: false, why: 'the engine answered 503' });
  } finally {
    f.done();
  }
});
