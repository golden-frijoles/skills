// doc-format.test.mjs — pure-logic coverage for doc-format.mjs's per-doc-type checkers.
// No file-tree walking / execFileSync here (that's exercised live via `node scripts/doc-format.mjs`
// itself, per Sprint 1's smoke walkthrough) — these are the offense-detection rules in isolation,
// fed literal doc content, mirroring lib/design-token-audit.ts's negative-fixture test shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkEpicReadme,
  checkSprintDoc,
  checkRetrospective,
  unclosedComments,
  fixDodHeading,
  fixSprintStatusLine,
  fixRetroClosedLine,
  applyMechanicalFixes,
} from './doc-format.mjs';

// ── checkEpicReadme ──────────────────────────────────────────────────────────

test('checkEpicReadme: a fully canonical README has zero offenses', () => {
  // Scope-seed link must resolve to a REAL file (existsRelative checks it) — point at this epic's
  // own real seed rather than a fabricated path, so the fixture doesn't depend on mocking fs.
  const content = `---
status: shipped   # AUTHORITATIVE epic status (SSOT) — scaffolded | in-progress | shipped | archived.
slug: doc-format-consistency
---

# Epic: Example epic

> **Area:** 09 · Platform & Infra · **Risk:** Low · **Class:** Chore · **Scope seed:** [\`00-ideas/seeds/doc-format-consistency.md\`](../../00-ideas/seeds/doc-format-consistency.md)

## Why
Reason.

## Definition of Done (epic)
- [ ] Done.
`;
  // The seed file is injected as existing — the test must not depend on which seeds this repo carries.
  assert.deepEqual(checkEpicReadme(content, { exists: () => true }), []);
});

test('checkEpicReadme: missing frontmatter block', () => {
  const offenses = checkEpicReadme(
    '# Epic: No frontmatter\n\n> **Area:** 09 · **Risk:** Low · **Class:** Chore · **Scope seed:** [x](y)\n'
  );
  assert.ok(offenses.some((o) => o.rule === 'frontmatter-missing'));
});

test('checkEpicReadme: invalid status value', () => {
  const content =
    '---\nstatus: done\nslug: x\n---\n\n> **Area:** 09 · **Risk:** Low · **Class:** Chore · **Scope seed:** [x](y)\n\n## Definition of Done (epic)\n';
  const offenses = checkEpicReadme(content);
  assert.ok(offenses.some((o) => o.rule === 'frontmatter-status-invalid'));
});

test('checkEpicReadme: missing Class field', () => {
  const content =
    '---\nstatus: shipped\nslug: x\n---\n\n> **Area:** 09 · **Risk:** Low · **Scope seed:** [x](y)\n\n## Definition of Done (epic)\n';
  const offenses = checkEpicReadme(content);
  assert.ok(offenses.some((o) => o.rule === 'header-missing-class'));
});

test('checkEpicReadme: invalid Class value (a free-text description, not the 4-value enum)', () => {
  const content =
    '---\nstatus: shipped\nslug: x\n---\n\n> **Area:** 09 · **Risk:** Low · **Class:** Remediation / hardening · **Scope seed:** [x](y)\n\n## Definition of Done (epic)\n';
  const offenses = checkEpicReadme(content);
  assert.ok(offenses.some((o) => o.rule === 'header-class-invalid'));
});

test('checkEpicReadme: Scope doc (legacy readyforscope/) flagged distinctly from a missing Scope seed', () => {
  const content =
    '---\nstatus: shipped\nslug: x\n---\n\n> **Area:** 09 · **Risk:** Low · **Class:** Chore · **Scope doc:** [x](../../00-ideas/2.%20readyforscope/x.md)\n\n## Definition of Done (epic)\n';
  const offenses = checkEpicReadme(content);
  assert.ok(offenses.some((o) => o.rule === 'header-scope-doc-legacy'));
  assert.ok(!offenses.some((o) => o.rule === 'header-missing-scope-seed'));
});

test('checkEpicReadme: no Scope-seed field is NOT flagged when the epic genuinely has no seed file (pre-seeds/-convention epic) — an accepted state, not drift', () => {
  const content =
    '---\nstatus: shipped\nslug: some-epic-with-no-seed-file\n---\n\n> **Area:** 09 · **Risk:** Low · **Class:** Chore\n\n## Definition of Done (epic)\n';
  const offenses = checkEpicReadme(content, { slug: 'some-epic-with-no-seed-file' });
  assert.ok(!offenses.some((o) => o.rule === 'header-missing-scope-seed'));
});

test('checkEpicReadme: no Scope-seed field IS flagged when a real seed file exists for this slug and just is not linked', () => {
  const content =
    '---\nstatus: shipped\nslug: doc-format-consistency\n---\n\n> **Area:** 09 · **Risk:** Low · **Class:** Chore\n\n## Definition of Done (epic)\n';
  const offenses = checkEpicReadme(content, { slug: 'doc-format-consistency', exists: () => true });
  assert.ok(offenses.some((o) => o.rule === 'header-missing-scope-seed'));
});

test('checkEpicReadme: legacy Macro-section header flagged', () => {
  const content =
    '---\nstatus: shipped\nslug: x\n---\n\n> **Macro-section:** [09](../README.md) · **BUILD-ORDER:** #1\n\n## Definition of Done (epic)\n';
  const offenses = checkEpicReadme(content);
  assert.ok(offenses.some((o) => o.rule === 'header-macro-section-legacy'));
});

test('checkEpicReadme: "## Epic Definition of Done" flagged as the legacy heading wording', () => {
  const content =
    '---\nstatus: shipped\nslug: x\n---\n\n> **Area:** 09 · **Risk:** Low · **Class:** Chore · **Scope seed:** [x](../../00-ideas/seeds/x.md)\n\n## Epic Definition of Done\n';
  const offenses = checkEpicReadme(content);
  assert.ok(offenses.some((o) => o.rule === 'dod-heading-legacy'));
});

// ── checkSprintDoc ───────────────────────────────────────────────────────────

test('checkSprintDoc: a canonical plain Status line has zero offenses', () => {
  assert.deepEqual(checkSprintDoc('# Sprint 1\n\n**Status:** ⬜ not started\n\n## Stories\n'), []);
});

test('checkSprintDoc: a blockquote Status line (with Epic backlink) is flagged', () => {
  const offenses = checkSprintDoc(
    '# Sprint 1\n\n> Epic: [X](README.md) · **Risk: LOW**\n> **Status: ✅ SHIPPED**\n'
  );
  assert.ok(offenses.some((o) => o.rule === 'sprint-status-blockquote'));
});

test('checkSprintDoc: Status combined with Risk on one line is flagged', () => {
  const offenses = checkSprintDoc(
    '# Sprint 1\n\n**Epic:** [X](README.md) · **Risk: HIGH** · **Status: shipped**\n'
  );
  assert.ok(offenses.some((o) => o.rule === 'sprint-status-combined'));
});

test('checkSprintDoc: missing Status line entirely is flagged', () => {
  const offenses = checkSprintDoc('# Sprint 1\n\n## Stories\n');
  assert.ok(offenses.some((o) => o.rule === 'sprint-status-missing'));
});

// ── checkRetrospective ───────────────────────────────────────────────────────

test('checkRetrospective: a fully canonical retro has zero offenses', () => {
  const content = `# Example — Retrospective

_Closed: 2026-07-16_

## What shipped
X.

## What went well
Y.

## What we learned
Z.

## Gaps / follow-ups
None.
`;
  assert.deepEqual(checkRetrospective(content), []);
});

test('checkRetrospective: the canonical unclosed scaffold placeholder has zero offenses', () => {
  const content = `# Example — Retrospective

_Closed: <date>_

## What shipped
## What went well
## What we learned
## Gaps / follow-ups
`;
  assert.deepEqual(checkRetrospective(content), []);
});

test('checkRetrospective: a "_Closed: YYYY-MM-DD_" line with trailing content after the italic close is clean (real-world norm, not drift)', () => {
  const content = `# X — Retrospective

_Closed: 2026-06-23_ · **2 sprints** · Risk LOW throughout

## What shipped
## What went well
## What we learned
## Gaps / follow-ups
`;
  assert.deepEqual(checkRetrospective(content), []);
});

test('checkRetrospective: a "_Closed: YYYY-MM-DD ... _" line with the italic closed at end-of-line is clean', () => {
  const content = `# X — Retrospective

_Closed: 2026-06-09 · 3 sprints, all shipped to prod._

## What shipped
## What went well
## What we learned
## Gaps / follow-ups
`;
  assert.deepEqual(checkRetrospective(content), []);
});

test('checkRetrospective: bold "**Closed ...**" flagged as the legacy format', () => {
  const content =
    '# X — Retrospective\n\n**Closed 2026-06-07.**\n\n## What shipped\n## What went well\n## What we learned\n## Gaps / follow-ups\n';
  const offenses = checkRetrospective(content);
  assert.ok(offenses.some((o) => o.rule === 'retro-closed-bold'));
});

test('checkRetrospective: missing a canonical section is flagged per-section', () => {
  const content = '# X — Retrospective\n\n_Closed: 2026-07-16_\n\n## What shipped\n## What went well\n';
  const offenses = checkRetrospective(content);
  const missing = offenses.filter((o) => o.rule === 'retro-section-missing').map((o) => o.detail);
  assert.equal(missing.length, 2);
  assert.ok(missing.some((d) => d.includes('What we learned')));
  assert.ok(missing.some((d) => d.includes('Gaps / follow-ups')));
});

test('checkRetrospective: non-standard EXTRA sections are not flagged (advisory-optional, not required-absent)', () => {
  const content = `# X — Retrospective

_Closed: 2026-06-03_

## What shipped
## What went well
## What we learned
## Gaps / follow-ups
## Validated but with a caveat
## Engineering debt noted
`;
  assert.deepEqual(checkRetrospective(content), []);
});

// ── mechanical --fix rewrites ─────────────────────────────────────────────────

test('fixDodHeading: legacy "## Epic Definition of Done" is renamed to canonical', () => {
  const content = '# Epic: X\n\n## Epic Definition of Done\n- [ ] Done.\n';
  const fixed = fixDodHeading(content);
  assert.ok(fixed.includes('## Definition of Done (epic)'));
  assert.ok(!fixed.includes('## Epic Definition of Done'));
});

test('fixDodHeading: mismatched wording "## Definition of Done" is renamed to canonical', () => {
  const content = '# Epic: X\n\n## Definition of Done\n- [ ] Done.\n';
  const fixed = fixDodHeading(content);
  assert.ok(fixed.includes('## Definition of Done (epic)'));
});

test('fixDodHeading: content already canonical is left untouched', () => {
  const content = '# Epic: X\n\n## Definition of Done (epic)\n- [ ] Done.\n';
  assert.equal(fixDodHeading(content), content);
});

test('fixSprintStatusLine: blockquote Status (with Epic backlink on a preceding line) collapses to a plain Status line', () => {
  const content =
    '# Sprint 1\n\n> Epic: [X](README.md) · **Risk: LOW**\n> **Status: ✅ SHIPPED**\n\n## Stories\n';
  const fixed = fixSprintStatusLine(content);
  assert.ok(fixed.includes('**Status:** ✅ SHIPPED'));
  assert.ok(!fixed.includes('> Epic:'));
  assert.ok(!fixed.includes('>'));
});

test('fixSprintStatusLine: Status combined with Risk/Epic on one line collapses to Status alone', () => {
  const content = '# Sprint 1\n\n**Epic:** [X](README.md) · **Risk: HIGH** · **Status: shipped**\n';
  const fixed = fixSprintStatusLine(content);
  assert.ok(fixed.includes('**Status:** shipped'));
  assert.ok(!fixed.includes('**Epic:**'));
  assert.ok(!fixed.includes('**Risk:'));
});

test('fixSprintStatusLine: already-canonical plain Status line is left untouched', () => {
  const content = '# Sprint 1\n\n**Status:** ⬜ not started\n\n## Stories\n';
  assert.equal(fixSprintStatusLine(content), content);
});

test('fixSprintStatusLine: a bold Status span that wraps onto the NEXT physical line is left untouched (real bug found sweeping deploy-pipeline-tuning — collapsing just line 1 left a dangling ** on line 2)', () => {
  const content =
    "# Sprint 4\n\n**Epic:** [X](README.md) · **Risk: LOW** · **Status: ✅ DONE 2026-07-13 — S4.1\nbuilt, S4.2 explicitly skipped (data doesn't support it).**\n\nBody.\n";
  assert.equal(fixSprintStatusLine(content), content);
});

test('fixSprintStatusLine: a blockquote Status block with substantial multi-line prose (PR links, owed-to notes) is left untouched, not silently discarded (real bug found sweeping feature-flags-inhouse/sprint-1.md)', () => {
  const content = `# Sprint 1

**Epic:** [X](README.md) · **Goal:** something.

> **Status: ✅ MERGED + DEPLOYED 2026-07-01 (product-owner-authorized merge on green, HIGH).**
> S1.1 \`6463a46\` + applied to the shared database · S1.2 \`67ee051\` · S1.3 \`d8c2e22\`.
> Merged: **FE [#150](https://github.com/x/y/pull/150)** (S1.1 + S1.2) → main \`b0582b0\`
>
> **Owed to the product owner (money/auth path):** the live flip smoke below.
`;
  assert.equal(fixSprintStatusLine(content), content);
});

test('fixSprintStatusLine: a short blockquote block with a non-Epic/Risk continuation line (e.g. "Surfaces: ...") is left untouched — a short line is not proof it is disposable (real bug found sweeping promoter-funnel-v2/sprint-5.md, where the Surfaces line was silently discarded)', () => {
  const content =
    '# Sprint 5\n\n> Epic: [X](README.md) · Risk: MED (no new money paths) · Status: ✅ merged 2026-07-03, PR [#168](https://github.com/x/y/pull/168)\n> Surfaces: `/promotor/cerrar`, merchant panel, email.\n\nBody.\n';
  assert.equal(fixSprintStatusLine(content), content);
});

test('fixSprintStatusLine: a short blockquote block that IS purely Epic/Risk backlink noise still collapses cleanly', () => {
  const content =
    '# Sprint 0\n\n> Epic: [X](README.md) · Risk: **HIGH** (entitlement) — **the product owner merges**\n> Status: ✅ closed 2026-07-02 — **not reproducible**\n\nBody.\n';
  const fixed = fixSprintStatusLine(content);
  assert.ok(fixed.includes('**Status:** ✅ closed 2026-07-02 — **not reproducible**'));
  assert.ok(!fixed.includes('Epic:'));
});

test('fixSprintStatusLine: Status leading with Risk trailing on the same line is left untouched — extracting "everything after Status:" would silently fold the Risk field into the kept value instead of dropping it (real bug found sweeping homepage-polish-b/sprint-1.md)', () => {
  const content =
    '# Sprint 1\n\n**Status:** ✅ COMPLETE — merged to `main` 2026-06-12, PR [#84](https://x/pull/84) squash `14fd880` · **Risk:** LOW *(touched shared `lib/types.ts` + renderers — announced in the PR per LEARNINGS)*\n';
  assert.equal(fixSprintStatusLine(content), content);
});

test('fixSprintStatusLine: "**Status:** value" (label bold closes right at the colon) preserves a trailing single "*" italic-close in the value, not stripping it as if it were the label wrapper', () => {
  const content = '# Sprint 1\n\n**Epic:** [X](README.md) · **Status:** shipped *(low risk)*\n';
  const fixed = fixSprintStatusLine(content);
  assert.ok(fixed.includes('**Status:** shipped *(low risk)*'));
  assert.ok(!fixed.includes('**Epic:**'));
});

test('fixSprintStatusLine: a single-line combined Status whose bold span closes mid-sentence (not at value end) is left untouched, not left with a dangling ** (real bug found sweeping feature-flags-inhouse/sprint-3.md)', () => {
  const content =
    '### S3.1 — Something\n> **Status: ✅ MERGED+DEPLOYED 2026-07-01.** FE [x](y) squash `d9eddd1`. **Owed to the product owner:** the live smoke.\n';
  const fixed = fixSprintStatusLine(content);
  assert.equal(fixed, content);
});

test('fixRetroClosedLine: bold "**Closed 2026-06-07.**" converts to italic, preserving trailing content', () => {
  const content = '# X — Retrospective\n\n**Closed 2026-06-07.**\n\n## What shipped\n';
  const fixed = fixRetroClosedLine(content);
  assert.ok(fixed.includes('_Closed: 2026-06-07.'));
  assert.ok(
    fixed
      .split('\n')
      .find((l) => l.startsWith('_Closed:'))
      .endsWith('_')
  );
  assert.ok(!fixed.includes('**Closed'));
});

test('fixRetroClosedLine: already-italic content is left untouched (nothing bold to fix)', () => {
  const content = '# X — Retrospective\n\n_Closed: 2026-07-16_\n\n## What shipped\n';
  assert.equal(fixRetroClosedLine(content), content);
});

test('fixRetroClosedLine: a "**Closed <date>.**" line that is really the FIRST line of a soft-wrapped multi-line paragraph is left untouched — rewriting just line 1 would strand the continuation lines as an orphaned fragment (real bug found sweeping delivery-money-polish/RETROSPECTIVE.md)', () => {
  const content =
    '# X — Retrospective\n\n**Closed 2026-06-09.** Three sprints, all shipped to prod. HIGH-risk (refunds / payments / fulfillment /\norder state) — the product owner merged every PR.\n\n## What shipped\n';
  assert.equal(fixRetroClosedLine(content), content);
});

test('applyMechanicalFixes: a sprint doc with a fixable Status line reports the fixed rule and clean output', () => {
  const content = '# Sprint 1\n\n**Epic:** [X](README.md) · **Risk: HIGH** · **Status: shipped**\n';
  const { content: fixed, fixedRules } = applyMechanicalFixes(content, 'sprint');
  assert.ok(fixedRules.includes('sprint-status-blockquote/sprint-status-combined'));
  assert.deepEqual(checkSprintDoc(fixed), []);
});

test('applyMechanicalFixes: a retrospective with a fixable Closed line and all sections present ends up fully clean', () => {
  const content =
    '# X — Retrospective\n\n**Closed 2026-06-07.**\n\n## What shipped\n## What went well\n## What we learned\n## Gaps / follow-ups\n';
  const { content: fixed, fixedRules } = applyMechanicalFixes(content, 'retrospective');
  assert.ok(fixedRules.includes('retro-closed-bold'));
  assert.deepEqual(checkRetrospective(fixed), []);
});

// ── Relaxed after triage against a second project (plugin-audit-and-extraction S2.4) ──────────────

test('checkRetrospective: the close line stays strict — shared with epic-dod, and immune to "not closed yet"', () => {
  const body =
    '\n\n## What shipped\nX.\n\n## What went well\nY.\n\n## What we learned\nZ.\n\n## Gaps / follow-ups\nNone.\n';
  for (const close of ['> Epic not closed yet — last touched 2026-07-20', '**Shipped:** 2026-08-20']) {
    const codes = checkRetrospective(`# X — Retrospective\n\n${close}${body}`).map((o) => o.rule);
    assert.ok(
      codes.some((c) => c.startsWith('retro-closed')),
      `${close} must not pass as a close line`
    );
  }
  assert.deepEqual(checkRetrospective(`# X — Retrospective\n\n_Closed: 2026-08-20_ · shipped${body}`), []);
});

test('checkRetrospective: canonical sections match by stem — a subtitle or a synonym is the same section', () => {
  const content =
    '# X\n\n_Closed: 2026-07-16_\n\n## What shipped\n## What worked\n## What we learned the hard way\n## Gaps, stated rather than implied\n';
  assert.deepEqual(checkRetrospective(content), []);
  const missing = checkRetrospective('# X\n\n_Closed: 2026-07-16_\n\n## What shipped\n## Notes\n');
  assert.deepEqual(missing.map((o) => o.detail).sort(), [
    'missing canonical section "## Gaps / follow-ups"',
    'missing canonical section "## What we learned"',
    'missing canonical section "## What went well"',
  ]);
});

test('enforced list: exact paths and trailing-slash prefixes; no file enforces nothing', async () => {
  const { isEnforced, loadEnforced } = await import('./doc-format.mjs');
  assert.ok(isEnforced('Roadmap/09-x/y/README.md', ['Roadmap/']));
  assert.ok(isEnforced('Roadmap/09-x/y/README.md', ['Roadmap/09-x/y/README.md']));
  assert.ok(!isEnforced('Roadmap/09-x/y/README.md', ['Roadmap/09-x/y/sprint-1.md', 'Roadmap/01-']));
  assert.deepEqual(loadEnforced('/nonexistent/doc-format.enforced.json').entries, []);
});

// ── Sprint files with frontmatter (build-visualization-claude-mods) ──────────────────────────────
// A sprint or story titled "Status: …" lives in the frontmatter now; the prose Status line is the one
// that counts. Found by the fresh reviewer on dobby-foundation#25 by scaffolding `--sprints 'Status: board'`.
const FM_SPRINT =
  '---\nepic: e\nsprint: 1\ntitle: "Status: board"\nstories:\n  - id: S1.1\n    i_want: "a Status: line"\n---\n';

test('checkSprintDoc: a "Status:" inside the frontmatter is not mistaken for the prose Status line', () => {
  assert.deepEqual(
    checkSprintDoc(`${FM_SPRINT}# E — Sprint 1: Status: board\n\n**Status:** ⬜ not started\n`),
    []
  );
  assert.deepEqual(
    checkSprintDoc(`${FM_SPRINT}# E — Sprint 1: x\n\n## Stories\n`).map((o) => o.rule),
    ['sprint-status-missing']
  );
});

test('fixSprintStatusLine: rewrites the prose Status line, never a frontmatter line', () => {
  const doc = `${FM_SPRINT}# E\n\n> **Epic:** x · **Risk:** low\n> **Status:** ✅ shipped\n`;
  const fixed = fixSprintStatusLine(doc);
  assert.ok(fixed.startsWith(FM_SPRINT), 'frontmatter untouched');
  assert.match(fixed, /^\*\*Status:\*\* ✅ shipped$/m);
});

// ── unclosedComments (think-skills S1: two epic READMEs rendered as one big comment) ─────────

test('unclosedComments: an <!-- that never closes is reported with its line', () => {
  const doc =
    '# Epic\n\n> header\n<!-- Class (above) is…\n     a longer description belongs in ## Why\nThe why paragraph.\n';
  assert.deepEqual(
    unclosedComments(doc).map((o) => o.rule),
    ['unclosed-html-comment']
  );
  assert.match(unclosedComments(doc)[0].detail, /^line 4 /);
});

test('unclosedComments: a closed comment, single- or multi-line, is fine — and a later unclosed one still fires', () => {
  assert.deepEqual(unclosedComments('a <!-- one --> b\n<!-- two\nlines -->\n## Why\n'), []);
  assert.equal(unclosedComments('<!-- ok -->\ntext\n<!-- never closed\n').length, 1);
});

test('unclosedComments: a comment quoted in code is an example, not a comment', () => {
  assert.deepEqual(unclosedComments('the comment carries a `<!-- jev:{…}` marker\n'), []);
  assert.deepEqual(unclosedComments('```\n<!-- jev:{"mode":"shadow"\n```\nafter\n'), []);
  assert.deepEqual(unclosedComments('a ``<!-- jev`` marker\n'), []);
  assert.deepEqual(unclosedComments('````md\n```\n<!-- quoted\n```\n````\nafter\n'), []);
});

test('unclosedComments: every epic doc type runs it', () => {
  const broken = '<!-- never closed\n';
  for (const offenses of [
    checkEpicReadme(broken, { slug: 'x', exists: () => false }),
    checkSprintDoc(broken),
    checkRetrospective(broken),
  ]) {
    assert.ok(offenses.some((o) => o.rule === 'unclosed-html-comment'));
  }
});
