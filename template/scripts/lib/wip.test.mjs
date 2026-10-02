// wip.test.mjs — WIP is advice at the moment of pulling (board-sinks-and-scrumban S3.4, D9, D22).
// Run: node --test scripts/lib/wip.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wipWarning } from './wip.mjs';

function repo({ wip, building = ['alpha', 'beta'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wip-'));
  for (const slug of ['alpha', 'beta', 'gamma']) {
    const dir = join(root, 'Roadmap', '02-commercial', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'README.md'),
      `---\nstatus: scaffolded\nslug: ${slug}\ntitle: "${slug}"\narea: 02-commercial\nrisk: low\ntype: feature\n---\n\n# Epic: Epic ${slug}\n`
    );
    writeFileSync(join(dir, 'sprint-1.md'), `# Epic ${slug} — Sprint 1: One\n\n**Status:** ⬜ not started\n`);
  }
  if (wip !== undefined)
    writeFileSync(join(root, 'golden-frijoles.config.json'), JSON.stringify({ board: { wip } }));
  const snapshot = {
    mode: 'snapshot',
    branches: building.map((s) => `feat/${s}`),
    prs: [],
    origin: 'snapshot@2026-10-02T09:00:00.000Z',
    generated_at: '2026-10-02T09:00:00.000Z',
  };
  return { root, gather: () => snapshot };
}

test('at the limit: ONE line that names the limit, every card in Building, and how old the facts are', () => {
  const { root, gather } = repo({ wip: { Building: 2 } });
  const line = wipWarning({ root, gather, excluding: 'gamma' });
  assert.match(
    line,
    /^⚠ WIP: Building is at its limit of 2 — Epic alpha; Epic beta \(facts from snapshot of 2026-10-02T09:00:00\.000Z\)\./
  );
  assert.match(line, /The kickoff follows\.$/, 'advice, never a gate');
  assert.ok(!line.includes('\n'), 'one line');
});

test('over the limit says over', () => {
  const { root, gather } = repo({ wip: { Building: 1 } });
  assert.match(wipWarning({ root, gather, excluding: 'gamma' }), /Building is over its limit of 1/);
});

test('under the limit, with no limit configured, or with a malformed one: nothing to say', () => {
  assert.equal(wipWarning(repo({ wip: { Building: 3 } })), null);
  assert.equal(wipWarning(repo()), null, 'no board.wip — the default is no advice');
  assert.equal(wipWarning(repo({ wip: { Building: 'two' } })), null);
});

test('the epic being pulled does not count against the limit it is about to join', () => {
  const { root, gather } = repo({ wip: { Building: 2 } });
  assert.equal(wipWarning({ root, gather, excluding: 'alpha' }), null, 'only beta is OTHER work in Building');
});

test('advice never breaks the kickoff: an unreadable roadmap is silence, not an error', () => {
  const { root, gather } = repo({ wip: { Building: 1 } });
  writeFileSync(
    join(root, 'Roadmap', '02-commercial', 'alpha', 'README.md'),
    '---\nstatus: nonsense\n---\n# Epic: x\n'
  );
  assert.equal(wipWarning({ root, gather }), null);
});
