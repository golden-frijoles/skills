// emit-epic-kickoff.test.mjs — pins the pure helpers of the epic-mode kickoff generator.
// Same stance as emit-kickoff.test.mjs: the filesystem walk is thin and exercised by real runs; the
// parsing and ordering are where a silent, plausible-looking wrong output comes from.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sprintNumFromFilename,
  listSprintFiles,
  buildSprintFileList,
  buildSprintBreakdown,
  buildEpicKickoff,
  buildEpicRules,
  compactStory,
  parseEpicRisk,
  EPIC_KICKOFF_TEMPLATE,
} from './emit-epic-kickoff.mjs';

test('sprintNumFromFilename accepts only real sprint files', () => {
  assert.equal(sprintNumFromFilename('sprint-1.md'), 1);
  assert.equal(sprintNumFromFilename('sprint-12.md'), 12);
  assert.equal(sprintNumFromFilename('README.md'), null);
  assert.equal(sprintNumFromFilename('RETROSPECTIVE.md'), null);
  assert.equal(sprintNumFromFilename('sprint-1.md.bak'), null);
  assert.equal(sprintNumFromFilename('sprint-notes.md'), null);
});

test('sprint files sort NUMERICALLY, not lexicographically', () => {
  // The regression this guards: a 10+ sprint epic sorted as strings puts sprint-10 second, which in epic
  // mode means the stacked-branch order in the prompt is wrong — actively harmful, not cosmetic.
  const names = ['sprint-10.md', 'sprint-2.md', 'README.md', 'sprint-1.md', 'RETROSPECTIVE.md'];
  assert.deepEqual(listSprintFiles(names).map((s) => s.num), [1, 2, 10]);
});

test('listSprintFiles drops non-sprint files from the epic dir', () => {
  const names = ['README.md', 'RETROSPECTIVE.md', 'NOTES.md', 'diagram.png', 'sprint-1.md'];
  assert.deepEqual(listSprintFiles(names).map((s) => s.name), ['sprint-1.md']);
});

test('buildSprintFileList names every boundary file in order', () => {
  const sprints = listSprintFiles(['sprint-2.md', 'sprint-1.md', 'sprint-3.md']);
  assert.equal(buildSprintFileList(sprints), 'sprint-1.md, sprint-2.md, sprint-3.md');
  assert.match(buildSprintFileList([]), /no sprint-N\.md files found/);
});

test('buildSprintBreakdown renders one line per sprint, its stories inline', () => {
  const out = buildSprintBreakdown([
    { name: 'sprint-1.md', num: 1, title: 'S1 — Durable payment state', stories: ['Story 1.1 — Persist intent', 'Story 1.2 — Reconcile'] },
    { name: 'sprint-2.md', num: 2, title: 'Block ship before paid', stories: [] },
  ]);
  const [one, two] = out.split('\n');
  assert.equal(one, '- **S1 · Durable payment state** (sprint-1.md): 1.1 Persist intent · 1.2 Reconcile');
  assert.match(two, /^- \*\*S2 · Block ship before paid\*\* \(sprint-2\.md\)/);
  // A sprint with no parsed stories must SAY so — an empty list that looks complete is the failure shape
  // emit-kickoff's em-dash bug produced (a plausible prompt with no stories at all).
  assert.match(two, /no `### Story N\.M — <title>` headings found/);
});

test('compactStory keeps the id and title, drops shipped notes, clips long titles', () => {
  assert.equal(compactStory('Story 4.1 — Per-folder licences ✅ #184. **Decided 2026-09-28:** long'), '4.1 Per-folder licences');
  assert.equal(compactStory(`Story 1.2 — ${'x'.repeat(90)}`).length, '1.2 '.length + 70);
  assert.equal(compactStory('not a story heading'), 'not a story heading');
});

test('buildEpicRules picks only the rules this epic needs', () => {
  assert.equal(buildEpicRules({ risk: 'LOW', texts: ['Copy change on the landing page.'] }), '');
  const high = buildEpicRules({ risk: 'HIGH', texts: ['Nothing new is modelled. No new table, no migration.'] });
  assert.match(high, /High risk/);
  assert.doesNotMatch(high, /Migration/, 'a negated mention is not a migration');
  assert.match(buildEpicRules({ risk: 'LOW', texts: ['Adds `supabase/migrations/2026…_x.sql`.'] }), /Migration:.*BEFORE merging/);
  assert.match(buildEpicRules({ risk: 'LOW', texts: ['Gate on `checkout.stripe_enabled`.'] }), /Flag:.*ACTIVATE/);
  // Every scaffolded README's DoD mentions a kill-switch; that alone must not add the flag rule.
  assert.equal(buildEpicRules({ risk: 'LOW', texts: ['- [ ] **Kill-switch (only if one was planned)**'] }), '');
});

test('parseEpicRisk reads the header line and defaults to high when absent', () => {
  assert.equal(parseEpicRisk('> **Area:** 02-x · **Risk:** low · **Class:** Chore'), 'low');
  assert.equal(parseEpicRisk('> **Area:** 02-x · **Risk:** HIGH · **Class:** Feature'), 'high');
  // "When unsure, treat it as high" — an under-declared risk is what skips the mandatory fresh reviewer.
  assert.equal(parseEpicRisk('# Epic: no header line here'), 'high');
});

test('buildEpicKickoff substitutes every placeholder the template uses', () => {
  const templateText = [
    'Epic {{SLUG}} under {{MACRO}} — "{{EPIC_TITLE}}", risk {{RISK}}.',
    '{{SPRINT_COUNT}} sprints: {{SPRINT_FILE_LIST}}',
    '{{SPRINT_BREAKDOWN}}',
  ].join('\n');
  const out = buildEpicKickoff({
    macro: '02-checkout',
    slug: 'checkout-hardening',
    epicTitle: 'Checkout hardening',
    risk: 'HIGH',
    sprints: [{ name: 'sprint-1.md', num: 1, title: 'S1', stories: ['Story 1.1 — A'] }],
    templateText,
  });
  assert.match(out, /Epic checkout-hardening under 02-checkout — "Checkout hardening", risk HIGH\./);
  assert.match(out, /1 sprints: sprint-1\.md/);
  assert.match(out, /- \*\*S1\*\* \(sprint-1\.md\): 1\.1 A/);
  // An unresolved placeholder must be VISIBLE in the output rather than silently blanked — same rule the
  // sibling generator's `sub()` follows.
  assert.doesNotMatch(out, /\{\{(MACRO|SLUG|EPIC_TITLE|RISK|SPRINT_COUNT)\}\}/);
});

test('the real template renders with no leftover placeholders', async () => {
  const templateText = EPIC_KICKOFF_TEMPLATE;

  const out = buildEpicKickoff({
    macro: '09-platform-infra',
    slug: 'demo',
    epicTitle: 'Demo',
    risk: 'LOW',
    sprints: [
      { name: 'sprint-1.md', num: 1, title: 'One', stories: ['Story 1.1 — A'] },
      { name: 'sprint-2.md', num: 2, title: 'Two', stories: ['Story 2.1 — B'] },
    ],
    templateText,
  });
  assert.doesNotMatch(out, /\{\{\w+\}\}/, 'template has a placeholder the generator does not supply');
  // The non-negotiables that went missing when kickoffs were hand-composed — the reason this generator exists.
  assert.match(out, /ONE orchestrated run/);
  assert.match(out, /Lock first/);
  assert.match(out, /\*\*Stack\*\*/);
  assert.match(out, /review-route\.mjs/);
  assert.match(out, /Merge on green/);
  assert.match(out, /Done means shipped/);
  // intent-match D16: the lock step names the optional reader for THIS epic, and says it never waits.
  assert.match(out, /node scripts\/intent-reader\.mjs --epic demo\b/);
  assert.match(out, /reader skipped/);
  // live-build-view D10/D13: the lock is a COMMAND, named for this epic; the prompt never restates a doc it points at.
  assert.match(out, /node scripts\/epic-phase\.mjs lock --epic demo\b/);
  assert.doesNotMatch(out, /integration, review\s+and rollback boundaries/, '*Epic-mode builds* already says it');
  assert.ok(out.split(/\s+/).length < 450, 'the prompt stays lean — the doctrine lives in WAYS-OF-WORKING');
});

test('every WAYS-OF-WORKING section the template points at exists', async () => {
  // The prompt points at the process instead of restating it. A pointer to a renamed section would leave the
  // builder with neither, so the pointer is checked against the shared WAYS-OF-WORKING template.
  const { readFileSync, existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const tpl = EPIC_KICKOFF_TEMPLATE;
  const ways = ['../../../../Roadmap/WAYS-OF-WORKING.template.md', '../../../../template/Roadmap/WAYS-OF-WORKING.template.md']
    .map((p) => join(here, p))
    .find(existsSync);
  assert.ok(ways, 'WAYS-OF-WORKING.template.md not found next to the plugin');
  const headings = readFileSync(ways, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => l.slice(3));
  const named = [...tpl.matchAll(/(?<!\*)\*([A-Z][^*\n]+)\*(?!\*)/g)].map((m) => m[1]); // *italic* only
  assert.ok(named.length >= 3, `expected the template to name its sections, found: ${named.join(', ')}`);
  for (const section of named)
    assert.ok(headings.some((h) => h.startsWith(section)), `WAYS-OF-WORKING has no "## ${section}…" section`);
});

test('S1.4 — the kickoff STARTS with pushing the epic branch (board-sinks-and-scrumban D13/D17)', () => {
  const out = buildEpicKickoff({
    macro: '09-platform-infra',
    slug: 'demo',
    epicTitle: 'Demo',
    risk: 'LOW',
    sprints: [{ name: 'sprint-1.md', num: 1, title: 'One', stories: ['Story 1.1 — A'] }],
    templateText: EPIC_KICKOFF_TEMPLATE,
  });
  const [first, second] = out.split('\n');
  // The push is the trigger that moves the card to Building — it must come before any other instruction.
  assert.match(first, /^Start by pushing the epic branch, before anything else/);
  assert.equal(
    second,
    '`git switch -c feat/demo origin/main && git push -u origin feat/demo` (resuming? `git switch feat/demo`).'
  );
});

test('S3.4 — at the WIP limit the CLI warns in ONE stderr line and still prints the whole kickoff (advice, never a gate)', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = mkdtempSync(join(tmpdir(), 'kickoff-wip-'));
  for (const slug of ['busy', 'next']) {
    const dir = join(root, 'Roadmap', '02-commercial', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), `---\nstatus: scaffolded\nslug: ${slug}\n---\n\n# Epic: Epic ${slug}\n\n**Risk:** low\n`);
    writeFileSync(join(dir, 'sprint-1.md'), `# Epic ${slug} — Sprint 1: One\n\n**Status:** ⬜ not started\n\n### Story 1.1 — A\n`);
  }
  writeFileSync(join(root, 'golden-frijoles.config.json'), JSON.stringify({ board: { wip: { Building: 1 } } }));
  mkdirSync(join(root, '.golden-frijoles'));
  writeFileSync(
    join(root, '.golden-frijoles', 'board.json'),
    JSON.stringify({ generated_at: '2026-10-02T09:00:00.000Z', branches: ['feat/busy'], prs: [] })
  );
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'emit-epic-kickoff.mjs');
  const r = spawnSync(process.execPath, [cli, '--epic', 'next', '--repo-root', root], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  const warnings = r.stderr.split('\n').filter((l) => l.startsWith('⚠ WIP'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Building is at its limit of 1 — Epic busy/);
  assert.match(r.stdout, /^Start by pushing the epic branch/);
  assert.match(r.stdout, /git switch -c feat\/next origin\/main/);
});
