// doc-format.contract.test.mjs — the frontmatter contract, enforced end to end
// (build-visualization-claude-mods S2.1). Each test copies the real checker into a throwaway repo with
// a fixture Roadmap/ and runs `--check` exactly as CI does: a compliant epic passes, and each failure
// mode (a missing epic field, an invalid phase, a sprint with no frontmatter) fails, naming the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// The board extractor, as this repo ships it: the template's is self-contained, while a consumer's may be a
// thin delegate to its own roadmap-to-notion.mjs — copy that too when it is there.
const EXTRACTOR_FILES = ['roadmap-extract.mjs', 'roadmap-to-notion.mjs'].filter((f) =>
  existsSync(join(HERE, f))
);

const README = (fm) => `---
status: in-progress
slug: fixture-epic
${fm}
---

# Epic: Fixture epic

> **Area:** 09-platform-infra · **Risk:** low · **Class:** Chore

## Definition of Done (epic)
- [ ] done
`;
const EPIC_FM = `phase: Building
title: Fixture epic
area: 09-platform-infra
risk: low
type: chore
sprints_total: 1
stories_total: 1`;
const SPRINT = (fm) => `${fm}# Fixture epic — Sprint 1: One

**Status:** 🏗 In progress

### Story 1.1 — First
**As a** maintainer, **I want** a check, **so that** drift fails.
`;
const SPRINT_FM = `---
epic: fixture-epic
sprint: 1
title: One
risk: low
phase: Building
stories_total: 1
stories:
  - id: S1.1
    title: First
    as_a: maintainer
    i_want: a check
    so_that: drift fails
    risk: low
    status: in-progress
---
`;

function repo({ readme = README(EPIC_FM), sprint = SPRINT(SPRINT_FM) } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'doc-format-contract-'));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  for (const f of ['doc-format.mjs', 'doc-format.enforced.json', ...EXTRACTOR_FILES])
    copyFileSync(join(HERE, f), join(root, 'scripts', f));
  copyFileSync(
    join(HERE, 'lib', 'roadmap-contract.mjs'),
    join(root, 'scripts', 'lib', 'roadmap-contract.mjs')
  );
  // roadmap-extract.mjs resolves the project through lib/project-root.mjs (golden-frijoles-plugin D2) and computes
  // each row's stage through the board-sinks-and-scrumban libs (D13/D14/D17).
  for (const lib of [
    'project-root.mjs',
    'stage.mjs',
    'work-branch.mjs',
    'stage-facts.mjs',
    'epic-kickoff.mjs',
  ])
    copyFileSync(join(HERE, 'lib', lib), join(root, 'scripts', 'lib', lib));
  writeFileSync(join(root, 'scripts', 'doc-format.enforced.json'), '{ "enforced": ["Roadmap/"] }\n');
  const epic = join(root, 'Roadmap', '09-platform-infra', 'fixture-epic');
  mkdirSync(epic, { recursive: true });
  writeFileSync(join(epic, 'README.md'), readme);
  writeFileSync(join(epic, 'sprint-1.md'), sprint);
  return root;
}

function check(root, extra = []) {
  const r = spawnSync('node', ['scripts/doc-format.mjs', '--check', ...extra], {
    cwd: root,
    encoding: 'utf8',
  });
  rmSync(root, { recursive: true, force: true });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('a compliant epic passes --check', () => {
  const { code, out } = check(repo());
  assert.equal(code, 0, out);
  assert.match(out, /doc-format --check: clean/);
});

test('an epic README missing a required field fails, naming the file and the field', () => {
  const { code, out } = check(repo({ readme: README(EPIC_FM.replace('title: Fixture epic\n', '')) }));
  assert.equal(code, 1, out);
  assert.match(out, /fixture-epic\/README\.md/);
  assert.match(out, /\[contract-epic-field-missing\] no `title:`/);
});

test('an invalid phase value fails', () => {
  const { code, out } = check(
    repo({ sprint: SPRINT(SPRINT_FM.replace('phase: Building', 'phase: Nonsense')) })
  );
  assert.equal(code, 1, out);
  assert.match(out, /fixture-epic\/sprint-1\.md/);
  assert.match(out, /\[contract-phase-invalid\] phase: "Nonsense"/);
});

test('a sprint-N.md with no frontmatter fails', () => {
  const { code, out } = check(repo({ sprint: SPRINT('') }));
  assert.equal(code, 1, out);
  assert.match(out, /\[contract-sprint-frontmatter-missing\]/);
});

test('an epic whose declared totals disagree with its sprints fails', () => {
  const { code, out } = check(
    repo({ readme: README(EPIC_FM.replace('stories_total: 1', 'stories_total: 4')) })
  );
  assert.equal(code, 1, out);
  assert.match(out, /stories_total: 4, but its sprints declare 1 stories/);
});

test('an archived epic is frozen: no contract findings even with no new fields at all', () => {
  const readme = README('').replace('status: in-progress', 'status: archived');
  const { code, out } = check(repo({ readme, sprint: SPRINT('') }));
  assert.equal(code, 0, out);
});

test('the single-file path (--files, the pre-commit hook) enforces the contract too', () => {
  const root = repo({ sprint: SPRINT('') });
  const { code, out } = check(root, ['--files', 'Roadmap/09-platform-infra/fixture-epic/sprint-1.md']);
  assert.equal(code, 1, out);
  assert.match(out, /\[contract-sprint-frontmatter-missing\]/);
});

test('the single-file path re-checks the epic totals when a sprint edit changes them', () => {
  const twoStories = SPRINT_FM.replace('stories_total: 1', 'stories_total: 2')
    .replace('---\n', '---\n')
    .replace(
      '    status: in-progress\n---',
      '    status: in-progress\n  - id: S1.2\n    title: Second\n    as_a: null\n    i_want: null\n    so_that: null\n    risk: low\n    status: planned\n---'
    );
  const root = repo({ sprint: SPRINT(twoStories) });
  const { code, out } = check(root, ['--files', 'Roadmap/09-platform-infra/fixture-epic/sprint-1.md']);
  assert.equal(code, 1, out);
  assert.match(out, /fixture-epic\/README\.md: stories_total: 1, but its sprints declare 2 stories/);
});
