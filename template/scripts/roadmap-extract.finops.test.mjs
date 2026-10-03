// roadmap-extract.finops.test.mjs — the extractor carries an epic's quote and actual (finops S2.1, D6/D20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRows, finopsFields } from './roadmap-extract.mjs';
import { FINOPS_FIELDS } from './lib/roadmap-contract.mjs';

const README = (slug, extra) => `---
status: shipped
slug: ${slug}
title: ${slug}
area: 09-platform-infra
risk: low
type: feature
phase: Shipped
sprints_total: 0
stories_total: 0
${extra}
---
# Epic: ${slug}
`;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'extract-finops-')));
  const epic = (slug, extra) => {
    mkdirSync(join(root, 'Roadmap', '09-platform-infra', slug), { recursive: true });
    writeFileSync(join(root, 'Roadmap', '09-platform-infra', slug, 'README.md'), README(slug, extra));
  };
  mkdirSync(join(root, 'Roadmap', '00-ideas', 'seeds'), { recursive: true });
  epic(
    'quoted',
    'appetite: M\nquote_low_usd: 30\nquote_high_usd: 55\nquote_basis: "M, n=6, p25–p75"\nactual_usd: 38.42\nactual_mtok: 1.9\nactual_basis: "this machine · 2026-10-02"'
  );
  epic('seeded', '');
  writeFileSync(
    join(root, 'Roadmap', '00-ideas', 'seeds', 'seeded.md'),
    '---\nstatus: scaffolded\nappetite: S\nepic: 09-platform-infra/seeded\n---\n# seeded\n'
  );
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

const rowsOf = (root) => buildRows({ root, dates: false, facts: { mode: 'docs', prs: [], branches: [] } });

test('2.1: an epic row carries the six FinOps fields — numbers as numbers, absent as null (never 0)', () => {
  const f = fixture();
  try {
    const rows = rowsOf(f.root);
    const q = rows.find((r) => r.slug === 'quoted' && r.grain === 'Epic');
    assert.deepEqual(Object.fromEntries(FINOPS_FIELDS.map((k) => [k, q[k]])), {
      quote_low_usd: 30,
      quote_high_usd: 55,
      quote_basis: 'M, n=6, p25–p75',
      actual_usd: 38.42,
      actual_mtok: 1.9,
      actual_basis: 'this machine · 2026-10-02',
    });
    const s = rows.find((r) => r.slug === 'seeded' && r.grain === 'Epic');
    for (const k of FINOPS_FIELDS) assert.equal(s[k], null, k);
  } finally {
    f.done();
  }
});

test('2.1 (D20): appetite is the README’s own, else the seed’s', () => {
  const f = fixture();
  try {
    const rows = rowsOf(f.root);
    assert.equal(rows.find((r) => r.slug === 'quoted' && r.grain === 'Epic').appetite, 'M');
    assert.equal(rows.find((r) => r.slug === 'seeded' && r.grain === 'Epic').appetite, 'S');
  } finally {
    f.done();
  }
});

test('finopsFields: a value that is not a number >= 0 is null, not a guess', () => {
  assert.equal(finopsFields({ actual_usd: 'lots' }).actual_usd, null);
  assert.equal(finopsFields({ actual_usd: '-3' }).actual_usd, null);
  assert.equal(finopsFields({ actual_usd: '0' }).actual_usd, 0, 'a real zero stays a zero');
  assert.equal(finopsFields({ quote_basis: '' }).quote_basis, null);
});
