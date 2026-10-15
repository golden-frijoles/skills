// owed-ledger.push.test.mjs — owed-on-screen D1–D3: the open owed checks ride the roadmap push.
//
// Fixture repos in a temp dir, so this runs the same from scripts/ and from the template's byte copy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  epicOfOwedFile,
  owedPushItem,
  owedForPush,
  refusalFor,
  OWED_LEDGER_JSON,
  OWED_PUSH_TEXT_MAX,
  OWED_PUSH_MAX_PER_EPIC,
  conformOwedForPush,
} from './owed-ledger.mjs';
import { buildEnvelope, pushRoadmap } from './roadmap-push.mjs';

const OWED = 'owed to the product owner';

/** A throwaway repo: one epic with a retro owing two checks (one cleared), one spec owing one, and the ledger opt-in. */
function fixture({ ledger = true, specs = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'owed-push-'));
  const epic = join(root, 'Roadmap/02-commercial/an-epic');
  mkdirSync(epic, { recursive: true });
  writeFileSync(join(epic, 'README.md'), '# Epic: An epic\n');
  writeFileSync(
    join(epic, 'RETROSPECTIVE.md'),
    [
      '_Closed: 2026-10-01_',
      '',
      `**Checks ${OWED}:**`,
      '',
      '- The _Intent_ answer.',
      '- ✅ The npm publish.',
      '- A signed-in walkthrough of the console.',
      '',
    ].join('\n')
  );
  mkdirSync(join(root, 'Roadmap/00-ideas'), { recursive: true });
  if (ledger) writeFileSync(join(root, OWED_LEDGER_JSON), '{"total":0}\n');
  if (specs) {
    mkdirSync(join(root, 'apps/web/e2e'), { recursive: true });
    writeFileSync(join(root, 'apps/web/e2e/x.spec.ts'), `// a browser smoke stays ${OWED}\n`);
  }
  return root;
}

test('epicOfOwedFile: the epic folder holding the file, only when it is a pushed epic', () => {
  const slugs = new Set(['an-epic']);
  assert.equal(epicOfOwedFile('Roadmap/02-commercial/an-epic/RETROSPECTIVE.md', slugs), 'an-epic');
  assert.equal(epicOfOwedFile('Roadmap/02-commercial/an-epic/sprint-2.md', slugs), 'an-epic');
  assert.equal(epicOfOwedFile('Roadmap/02-commercial/other/RETROSPECTIVE.md', slugs), null);
  assert.equal(epicOfOwedFile('apps/web/e2e/x.spec.ts', slugs), null);
  assert.equal(epicOfOwedFile('Roadmap/README.md', slugs), null);
  assert.equal(epicOfOwedFile(undefined, slugs), null);
});

test('owedPushItem: the push fields only, the text cut to the schema bound', () => {
  const long = 'x'.repeat(OWED_PUSH_TEXT_MAX + 50);
  const item = owedPushItem(
    {
      file: 'apps/web/e2e/x.spec.ts',
      line: 3,
      text: long,
      kind: 'signed-in',
      category: 'auth-path',
      extra: 1,
    },
    new Set()
  );
  assert.deepEqual(Object.keys(item).sort(), ['category', 'epic', 'file', 'kind', 'line', 'text']);
  assert.equal(item.text.length, OWED_PUSH_TEXT_MAX);
  assert.ok(item.text.endsWith('…'));
  assert.equal(item.epic, null);
});

test('owedForPush: no committed ledger is the opt-out — no field, no note', () => {
  const root = fixture({ ledger: false });
  try {
    assert.deepEqual(owedForPush({ root, epicSlugs: ['an-epic'] }), { owed: null, note: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('owedForPush: the open items, attributed, and as many as the ledger counts', () => {
  const root = fixture();
  try {
    const { owed, note } = owedForPush({ root, epicSlugs: ['an-epic'] });
    assert.equal(note, null);
    // Two open in the retro (the ticked publish is cleared), one in the spec.
    assert.equal(owed.length, 3);
    assert.equal(owed.filter((o) => o.epic === 'an-epic').length, 2);
    assert.equal(owed.filter((o) => o.epic === null).length, 1);
    assert.deepEqual(owed.map((o) => o.kind).sort(), ['judgment', 'signed-in', 'signed-in']);
    assert.ok(owed.every((o) => Number.isInteger(o.line) && o.line > 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('owedForPush: a ledger that cannot be derived is not sent, and says why (the refusal rule, not a zero)', () => {
  const root = fixture({ specs: false });
  try {
    const { owed, note } = owedForPush({ root, epicSlugs: ['an-epic'] });
    assert.equal(owed, null);
    assert.match(note, /owed checks not pushed: no spec directory found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refusalFor: one rule for the CLI and the push', () => {
  const yes = () => true;
  const no = () => false;
  assert.match(refusalFor({ specDirs: [], docDirs: [] }, '/r', yes), /no spec directory/);
  assert.match(refusalFor({ specDirs: ['apps/web/e2e'], docDirs: ['Roadmap'] }, '/r', no), /not found/);
  assert.equal(refusalFor({ specDirs: ['apps/web/e2e'], docDirs: ['Roadmap'] }, '/r', yes), null);
});

test('buildEnvelope: owed rides as one top-level block — absent when null, kept when empty', () => {
  const rows = [{ name: 'An epic', slug: 'an-epic', grain: 'Epic', status: 'Shipped', area: '02' }];
  assert.equal('owed' in buildEnvelope(rows, {}), false);
  assert.equal('owed' in buildEnvelope(rows, { owed: null }), false);
  // [] is a reading ("nothing owed"), not an absence.
  assert.deepEqual(buildEnvelope(rows, { owed: [] }).owed, []);
  const one = [{ epic: 'an-epic', text: 't', kind: 'ops', category: 'other', file: 'f.md', line: 1 }];
  const env = buildEnvelope(rows, { owed: one });
  assert.deepEqual(env.owed, one);
  // Never per row: every `items` reader would carry it.
  assert.ok(env.items.every((r) => !('owed' in r)));
});

test('pushRoadmap sends the owed checks it derived (through the caller, not the helper)', async () => {
  const root = fixture();
  try {
    let sent = null;
    const fetchFn = async (_url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    };
    const rows = [{ name: 'An epic', slug: 'an-epic', grain: 'Epic', status: 'Shipped', area: '02' }];
    const r = await pushRoadmap(rows, { root, apiKey: 'k', baseUrl: 'http://x', fetchFn });
    assert.equal(r.ok, true);
    assert.equal(sent.owed.length, 3);
    assert.equal(sent.owed.filter((o) => o.epic === 'an-epic').length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('conformOwedForPush: what the schema would refuse is left off the push, counted, never a failed push', () => {
  const ok = (over = {}) => ({
    epic: 'e',
    text: 't',
    kind: 'ops',
    category: 'other',
    file: 'Roadmap/02-x/e/sprint-1.md',
    line: 1,
    ...over,
  });
  const items = [
    ok({ epic: null, file: 'apps/web/e2e/(auth)/login.spec.ts' }),
    ok({ epic: null, file: 'apps/web/e2e/[slug]/x.spec.ts' }),
    ok({ epic: null, file: 'apps/web/e2e/a b.spec.ts' }),
    ok({ text: '' }),
    ...Array.from({ length: OWED_PUSH_MAX_PER_EPIC + 1 }, () => ok()),
  ];
  const { kept, note } = conformOwedForPush(items);
  assert.equal(kept.length, OWED_PUSH_MAX_PER_EPIC);
  assert.match(note, /3 with a file path the push cannot carry, 1 with no text, 1 past 100 on one epic/);
  assert.deepEqual(conformOwedForPush([ok()]), { kept: [ok()], note: null });
});
