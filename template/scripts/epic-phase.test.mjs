// epic-phase.test.mjs — the architecture lock as a command (live-build-view S2.3, D10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockEpic, setField, getField } from './epic-phase.mjs';
import { parseDocFrontmatter, validateEpicFrontmatter } from './lib/roadmap-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = '2026-10-03T20:34:34Z';

// The shape scaffold-epic writes: a phase line carrying a comment and two comment-only continuation lines.
const README = (body = '## Architecture lock\n- **D1 — One check.** …\n') => `---
status: in-progress  # AUTHORITATIVE epic status (SSOT)
phase: Shaping       # the executive ladder — Shaping | Locking architecture | Building | Verifying | In review | Shipped.
                     # WRITTEN at each cadence event, never inferred. Shipped = merged AND deployed.
slug: demo
title: "Demo"
area: 09-platform-infra
risk: low
type: feature
sprints_total: 1
stories_total: 1
---

# Epic: Demo

${body}`;
const SPRINT1 = `---
epic: demo
sprint: 1
title: "One"
risk: low
phase: Shaping
stories_total: 1
stories:
  - id: S1.1
    title: "x"
---
# Sprint 1
`;

test('lock: phase Building + a quoted locked_at after the phase block; sprint 1 Building; nothing else moves', () => {
  const res = lockEpic({ readme: README(), sprint1: SPRINT1, now: NOW });
  assert.equal(res.ok, true);
  const lines = res.readme.split('\n');
  assert.match(lines[2], /^phase: Building {7}# the executive ladder/, 'the comment keeps its column');
  assert.match(lines[3], /^ {21}# WRITTEN at each cadence event/);
  assert.equal(lines[4], `locked_at: "${NOW}"`, 'inserted after the phase block, not inside its comment');
  assert.equal(res.readme.split('\n').length, README().split('\n').length + 1, 'one line added, none lost');
  assert.match(res.sprint1, /^phase: Building$/m);
  assert.equal(res.sprint1.replace('phase: Building', 'phase: Shaping'), SPRINT1);
  // The stamped README satisfies the contract it joins.
  const parsed = parseDocFrontmatter(res.readme);
  assert.equal(parsed.data.locked_at, NOW);
  assert.equal(parsed.data.phase, 'Building');
  assert.deepEqual(
    validateEpicFrontmatter(parsed).filter((o) => /locked-at|phase/.test(o.rule)),
    []
  );
});

test('lock refuses a README with nothing locked, and a second lock', () => {
  const none = lockEpic({
    readme: README('## Why\nno decisions yet (a D10 alone does not count)\n'),
    sprint1: SPRINT1,
    now: NOW,
  });
  assert.equal(none.ok, false);
  assert.match(none.why, /names no D1/);
  const once = lockEpic({ readme: README(), sprint1: SPRINT1, now: NOW });
  const twice = lockEpic({ readme: once.readme, sprint1: once.sprint1, now: '2026-10-04T00:00:00Z' });
  assert.equal(twice.ok, false);
  assert.match(twice.why, /already locked at 2026-10-03T20:34:34Z/);
});

test('the contract rejects a locked_at that is not an ISO date-time', () => {
  const bad = parseDocFrontmatter(README().replace('slug: demo', 'slug: demo\nlocked_at: "last tuesday"'));
  assert.deepEqual(
    validateEpicFrontmatter(bad)
      .map((o) => o.rule)
      .filter((r) => r.includes('locked')),
    ['contract-locked-at-invalid']
  );
});

test('setField / getField: a value without a comment, an absent key appended', () => {
  assert.equal(setField('a: 1\nb: 2', 'b', '3'), 'a: 1\nb: 3');
  assert.equal(setField('a: 1', 'c', '"x"'), 'a: 1\nc: "x"');
  assert.equal(
    getField('locked_at: "2026-10-03T20:34:34Z"   # stamped', 'locked_at'),
    '2026-10-03T20:34:34Z'
  );
  assert.equal(getField('x: 1', 'locked_at'), null);
});

test('the CLI: locks the epic in a repo, refuses the second time, says usage on nonsense', () => {
  const root = mkdtempSync(join(tmpdir(), 'epic-phase-'));
  const dir = join(root, 'Roadmap', '09-platform-infra', 'demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), README());
  writeFileSync(join(dir, 'sprint-1.md'), SPRINT1);
  const run = (...a) => spawnSync('node', [join(HERE, 'epic-phase.mjs'), ...a], { encoding: 'utf8' });
  const first = run('lock', '--epic', 'demo', '--repo-root', root, '--now', NOW);
  assert.equal(first.status, 0, first.stderr);
  assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /locked_at: "2026-10-03T20:34:34Z"/);
  assert.match(readFileSync(join(dir, 'sprint-1.md'), 'utf8'), /phase: Building/);
  assert.equal(run('lock', '--epic', 'demo', '--repo-root', root).status, 1);
  assert.equal(run('lock', '--epic', 'nope', '--repo-root', root).status, 2);
  assert.equal(run('unlock', '--epic', 'demo').status, 2);
  assert.equal(
    run('lock', '--epic', 'demo', '--repo-root', root, '--now', 'yesterday').status,
    2,
    '--now is validated'
  );
  assert.equal(
    run('lock', '--epic', 'demo', '--repo-root', root, '--now', '2026-13-45T25:00Z').status,
    2,
    'by the contract (a real date), not a regex'
  );
  // A path is not a slug: nothing outside Roadmap/ is read or written (vibe security lens, #241).
  mkdirSync(join(root, 'apps', 'web'), { recursive: true });
  writeFileSync(join(root, 'apps', 'web', 'README.md'), README().replace('slug: demo', 'slug: web'));
  assert.equal(run('lock', '--epic', '../../apps/web', '--repo-root', root, '--now', NOW).status, 2);
  assert.doesNotMatch(readFileSync(join(root, 'apps', 'web', 'README.md'), 'utf8'), /locked_at/);
});
