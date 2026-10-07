// roadmap-extract.flag.test.mjs — the extractor carries an epic's flag (one-epic-page S2.3, D11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRows, flagFields } from './roadmap-extract.mjs';
import { validateFlagKey } from './lib/roadmap-contract.mjs';

test('S2.3: flag_key is a flag key or null; the blank spellings this file’s reader yields are null, not a key', () => {
  assert.equal(
    flagFields({ flag_key: 'auth.terminal_sign_in_enabled' }, '').flag_key,
    'auth.terminal_sign_in_enabled'
  );
  // A quoted `flag_key: "null"` arrives as the STRING "null", which fits the key grammar — the trap this guards.
  for (const blank of ['null', '~', '', '  ', undefined])
    assert.equal(flagFields({ flag_key: blank }, '').flag_key, null);
  for (const bad of ['Auth.Enabled', '2fa_enabled', 'has space', 'x'.repeat(129)])
    assert.equal(flagFields({ flag_key: bad }, '').flag_key, null, bad);
});

test('S2.3: flag_note is the README’s own **Flag:** line, without its markdown; absent → null', () => {
  const readme =
    '# Epic\n\n**Flag:** none. Risk low (navigation and `labels`). Rollback is a **revert**.\n\nMore.';
  assert.equal(
    flagFields({}, readme).flag_note,
    'none. Risk low (navigation and labels). Rollback is a revert.'
  );
  assert.equal(flagFields({}, '# Epic\n\nNo flag line here.').flag_note, null);
  assert.equal(flagFields({}, '**Flag:**   \n').flag_note, null, 'an empty line is no note');
  assert.equal(flagFields({}, `**Flag:** ${'a'.repeat(400)}`).flag_note.length, 280);
});

test('S2.3: the contract names a flag_key that is not a key, and accepts a key or null', () => {
  assert.deepEqual(validateFlagKey({ flag_key: 'checkout.v2_enabled' }), []);
  assert.deepEqual(validateFlagKey({ flag_key: null }), []);
  assert.deepEqual(validateFlagKey({}), []);
  assert.deepEqual(
    validateFlagKey({ flag_key: 'Not A Key' }).map((o) => o.rule),
    ['contract-flag-key-invalid']
  );
});

test('S2.3: buildRows puts flag_key and flag_note on the Epic row, read off a real README', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'extract-flag-')));
  try {
    const dir = join(root, 'Roadmap', '09-platform-infra', 'reminders');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, 'Roadmap', '00-ideas', 'seeds'), { recursive: true });
    const readme = (key) =>
      [
        '---',
        'status: scaffolded',
        'slug: reminders',
        'title: reminders',
        'area: 09-platform-infra',
        'risk: high',
        'type: feature',
        'phase: Shaping',
        'sprints_total: 0',
        'stories_total: 0',
        `flag_key: ${key}`,
        '---',
        '# Epic: reminders',
        '',
        '**Flag:** `invoices.reminders_enabled`, a kill-switch, armed in every env.',
        '',
      ].join('\n');
    writeFileSync(join(dir, 'README.md'), readme('invoices.reminders_enabled'));
    const facts = { mode: 'docs', prs: [], branches: [] };
    const row = buildRows({ root, dates: false, facts }).find(
      (r) => r.slug === 'reminders' && r.grain === 'Epic'
    );
    assert.equal(row.flag_key, 'invoices.reminders_enabled');
    assert.equal(row.flag_note, 'invoices.reminders_enabled, a kill-switch, armed in every env.');
    writeFileSync(join(dir, 'README.md'), readme('null'));
    const none = buildRows({ root, dates: false, facts }).find(
      (r) => r.slug === 'reminders' && r.grain === 'Epic'
    );
    assert.equal(none.flag_key, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
