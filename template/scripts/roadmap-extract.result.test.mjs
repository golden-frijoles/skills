// roadmap-extract.result.test.mjs — the extractor carries an epic's target and verdict (result-record S1.3, D5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRows, resultFields } from './roadmap-extract.mjs';
import { RESULT_FIELDS } from './lib/roadmap-contract.mjs';

test('S1.3: every result field is on the row, typed; absent is null, never 0', () => {
  const out = resultFields(
    {
      hypothesis: 'Reminders get invoices paid on time',
      target_metric: 'invoices_paid_on_time',
      target_from: '61',
      target_to: '70.5',
      read_date: '2026-11-04',
      verdict: 'proven',
      verdict_actual: '72',
      verdict_evidence: 'north-star:invoices_paid_on_time@2026-11-04',
      verdict_at: '2026-11-04',
    },
    '2026-10-04'
  );
  for (const key of RESULT_FIELDS) assert.ok(key in out, key);
  assert.equal(out.target_from, 61);
  assert.equal(out.target_to, 70.5);
  assert.equal(out.verdict_actual, 72);
  assert.equal(out.read_date, '2026-11-04');
  assert.equal(out.read_date_derived, false);
  assert.equal(out.read_late, false);
  const empty = resultFields({}, null);
  for (const key of RESULT_FIELDS) assert.equal(empty[key], null, key);
  assert.equal(empty.read_date_derived, false);
});

test('S1.3: a bad value reads as null (doc-format names it), not as something the board would show', () => {
  const out = resultFields(
    { target_from: '61%', target_to: 'null', verdict: 'provn', read_date: '4 Nov', verdict_at: '2026-02-30' },
    null
  );
  assert.equal(out.target_from, null);
  assert.equal(out.target_to, null);
  assert.equal(out.verdict, null);
  assert.equal(out.read_date, null);
  assert.equal(out.verdict_at, null);
});

test('S1.3: no read_date → the derived one (shipped + 30), labelled derived; only with a target', () => {
  const targeted = resultFields({ target_metric: 'x', target_from: '1', target_to: '2' }, '2026-10-04');
  assert.equal(targeted.read_date, '2026-11-03');
  assert.equal(targeted.read_date_derived, true);
  const untargeted = resultFields({}, '2026-10-04');
  assert.equal(untargeted.read_date, null, 'an epic shipped with no target is never given a read date');
  assert.equal(untargeted.read_date_derived, false);
  const unshipped = resultFields({ target_metric: 'x' }, null);
  assert.equal(unshipped.read_date, null);
});

test('S1.3: a verdict more than 90 days after shipping is marked late', () => {
  const late = resultFields(
    { target_metric: 'x', verdict: 'unclear', verdict_at: '2027-01-10', verdict_evidence: 'n = 18' },
    '2026-10-04'
  );
  assert.equal(late.read_late, true);
});

test('S1.3: buildRows puts the fields on the Epic row, read off a real README', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'extract-result-')));
  try {
    const dir = join(root, 'Roadmap', '09-platform-infra', 'reminders');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, 'Roadmap', '00-ideas', 'seeds'), { recursive: true });
    writeFileSync(
      join(dir, 'README.md'),
      [
        '---',
        'status: scaffolded',
        'slug: reminders',
        'title: reminders',
        'area: 09-platform-infra',
        'risk: low',
        'type: feature',
        'phase: Shaping',
        'sprints_total: 0',
        'stories_total: 0',
        'hypothesis: "Reminders: invoices paid on time"',
        'target_metric: invoices_paid_on_time   # a North Star input',
        'target_from: 61',
        'target_to: 70',
        'read_date: 2026-11-04',
        'verdict: null',
        '---',
        '# Epic: reminders',
        '',
      ].join('\n')
    );
    const rows = buildRows({ root, dates: false, facts: { mode: 'docs', prs: [], branches: [] } });
    const row = rows.find((r) => r.slug === 'reminders' && r.grain === 'Epic');
    assert.equal(row.hypothesis, 'Reminders: invoices paid on time');
    assert.equal(row.target_metric, 'invoices_paid_on_time');
    assert.equal(row.target_from, 61);
    assert.equal(row.target_to, 70);
    assert.equal(row.read_date, '2026-11-04');
    assert.equal(row.verdict, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
