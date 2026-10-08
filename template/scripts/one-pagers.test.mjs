// one-pagers.test.mjs — the three sheets, derived from synthetic strategy files (coaches-v2 D10). Zero deps.
// The fixture is a made-up café-scheduling app: a real maker's strategy never goes into a public test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BMC_CREDIT,
  NOT_WRITTEN,
  PERSONA_FIELDS,
  readStrategy,
  renderCanvas,
  renderPersona,
  renderValueSheet,
  splitLabel,
} from './one-pagers.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'one-pagers.mjs');

const NARRATIVE = (status = 'agreed') => `---
kind: pmf-narrative
status: ${status}
updated: 2026-10-08
---

# PMF Narrative — Rota

## Initial insight

Owners rebuild the week by hand.

## Problem to solve

**Outcome:** Every shift covered before the day starts (agreed)
**Motivation:** A no-show costs a Saturday's takings (sourced: https://example.org/survey)
**Gaps:**
- Next week's rota starts from zero (hypothesis)
- Swaps go through the manager (sourced: https://example.org/forum)

## Target audience

**Now:** Independent cafés with 5–15 staff (agreed)
**Future:** Small restaurant groups (hypothesis)

### Persona

- **Role:** Café owner-manager
- **Stage:** One site, 3 years in (agreed)
- **Goals:** A rota done in ten minutes (sourced: https://example.org/interviews)
- **Frustrations:** <role-play anecdote never confirmed>
- **Words to use:** shifts, cover, swaps

## Value proposition

**Tagline:** The rota that fills itself.
- Next week drafted from last week (true today)
- Staff swap without you in the middle (aspirational)

## Competitive advantage

**Short term:** Beats the WhatsApp group on setup time (true today)
**Long term:** Switching costs once the history lives here (aspirational)

## Growth strategy

**Now:** Door-to-door on one high street (agreed)
**Later:** Staff invite their next employer (hypothesis)

## Business model

**Revenue:** Monthly subscription per site (agreed)
**Pricing:** <price>
**Costs:** SMS reminders and hosting (sourced: https://example.org/pricing)
**Key partners:** Payroll tools (hypothesis)
`;

const NORTH_STAR = `---
kind: north-star
status: draft
updated: 2026-10-08
---

# North Star — Rota

## North Star metric

**Covered shifts**: shifts filled 24 hours ahead, per active site per week.
`;

const RISK = `---
kind: risk-validation
status: agreed
---

## Highest domino

**Dimension:** Business model

**Hypothesis:** Owners pay monthly for something WhatsApp does free.
`;

const s = (o = {}) => readStrategy({ narrative: NARRATIVE(), northStar: NORTH_STAR, risk: RISK, ...o });

test('splitLabel takes the trailing label, with a source; anything else has none', () => {
  assert.deepEqual(splitLabel('Fast (true today)'), { text: 'Fast', label: 'true today', source: null });
  assert.deepEqual(splitLabel('Pays (sourced: https://x.y/z)'), {
    text: 'Pays',
    label: 'sourced',
    source: 'https://x.y/z',
  });
  assert.deepEqual(splitLabel('Plain claim'), { text: 'Plain claim', label: null, source: null });
  assert.equal(splitLabel('A (maybe)').label, null);
});

test('the persona poster labels every line, and an unlabelled one reads hypothesis, never as fact (F34)', () => {
  const st = s();
  assert.deepEqual(
    st.persona.map((r) => r.field),
    PERSONA_FIELDS
  );
  const role = st.persona.find((r) => r.field === 'Role');
  assert.equal(role.label, 'hypothesis', 'no label written → hypothesis');
  assert.equal(
    st.persona.find((r) => r.field === 'Frustrations').text,
    null,
    'a <placeholder> is not written'
  );
  const { html, md } = renderPersona(st);
  assert.match(html, /<h1>Rota: Persona: Café owner-manager<\/h1>/);
  assert.match(
    html,
    /<h2>Words to use<\/h2><p>shifts, cover, swaps <span class="chip hyp">hypothesis<\/span>/
  );
  assert.match(html, new RegExp(`<h2>Frustrations</h2><p><span class="muted">${NOT_WRITTEN}</span>`));
  assert.match(
    md,
    /## Goals\n\nA rota done in ten minutes _\(sourced: https:\/\/example\.org\/interviews\)_/
  );
  assert.doesNotMatch(md, /role-play anecdote/);
});

test('the canvas: nine blocks from the narrative, "Not written yet" where it is silent, and the CC credit', () => {
  const { html, md } = renderCanvas(s());
  for (const h of [
    'Key partners',
    'Key activities',
    'Key resources',
    'Value propositions',
    'Customer relationships',
    'Channels',
    'Customer segments',
    'Cost structure',
    'Revenue streams',
  ])
    assert.ok(md.includes(`## ${h}`), h);
  assert.ok(html.includes('Strategyzer.com') && md.includes(BMC_CREDIT));
  assert.match(md, /## Key activities\n\n_Not written yet_/);
  assert.match(md, /- Now: Independent cafés with 5–15 staff _\(agreed\)_/);
  assert.match(
    md,
    /## Revenue streams\n\n- Monthly subscription per site _\(agreed\)_\n\n/,
    'a <placeholder> price is left out'
  );
  assert.doesNotMatch(html, /class="draft"/, 'an agreed narrative is not watermarked');
});

test('the value proposition sheet is our own layout, carries the North Star, and lists what is not claimed yet', () => {
  const { html, md } = renderValueSheet(s());
  assert.doesNotMatch(`${html}\n${md}`, /value proposition canvas/i, 'never the reserved canvas name');
  assert.match(md, /\*\*Covered shifts\*\*: shifts filled 24 hours ahead/);
  assert.match(
    md,
    /- Owners pay monthly for something WhatsApp does free. _\(hypothesis\)_ \(riskiest assumption \(Business model\)\)/
  );
  assert.match(md, /- Staff swap without you in the middle _\(aspirational\)_ \(aspirational benefit\)/);
  assert.match(html, /class="draft"/, 'the North Star is still draft, so the sheet is watermarked');
});

test('a draft narrative watermarks every sheet it feeds; HTML in a file is escaped', () => {
  const st = s({ narrative: NARRATIVE('draft').replace('Café owner-manager', '<script>x</script>') });
  for (const r of [renderCanvas, renderPersona]) assert.match(r(st).html, /<div class="draft"/);
  assert.match(renderPersona(st).md, /^# Rota: Persona: <script>x<\/script> \(draft\)/);
  assert.doesNotMatch(renderPersona(st).html, /<script>x<\/script>/);
  assert.match(renderPersona(st).html, /&lt;script&gt;x&lt;\/script&gt;/);
});

test('the CLI writes six files from a project, and says so plainly when there is no narrative yet', () => {
  const root = mkdtempSync(join(tmpdir(), 'one-pagers-'));
  const env = { ...process.env, GF_PROJECT_ROOT: root };
  try {
    const empty = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env });
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /nothing to render yet/);

    const dir = join(root, 'Roadmap', '00-strategy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pmf-narrative.md'), NARRATIVE());
    writeFileSync(join(dir, 'north-star.md'), NORTH_STAR);
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(join(dir, 'one-pagers')).sort(), [
      'business-model-canvas.html',
      'business-model-canvas.md',
      'persona-poster.html',
      'persona-poster.md',
      'value-proposition-sheet.html',
      'value-proposition-sheet.md',
    ]);
    assert.match(r.stdout, /marked draft/);
    assert.match(
      readFileSync(join(dir, 'one-pagers', 'value-proposition-sheet.md'), 'utf8'),
      /Covered shifts/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the narrative template itself renders nothing but "Not written yet": no placeholder ever reaches a sheet', () => {
  // This spec runs from skills/template/scripts and from the monorepo's byte copy in scripts/: find the template from either.
  const tail = ['plugins', 'golden-frijoles', 'skills', 'pmf-narrative', 'templates', 'pmf-narrative.md'];
  const here = dirname(SCRIPT);
  const path = [join(here, '..', '..', ...tail), join(here, '..', 'skills', ...tail)].find((p) =>
    existsSync(p)
  );
  assert.ok(path, 'the narrative template is reachable');
  const template = readFileSync(path, 'utf8');
  const st = readStrategy({ narrative: template });
  const block = template.slice(template.indexOf('### Persona'), template.indexOf('## Value proposition'));
  const listed = [...block.matchAll(/^- \*\*([^*]+):\*\*/gm)].map((m) => m[1]);
  assert.deepEqual(listed, PERSONA_FIELDS, 'the template lists exactly the fields the renderer reads');
  for (const r of [renderCanvas, renderValueSheet, renderPersona]) {
    const { md } = r(st);
    assert.doesNotMatch(md, /<[a-z][^>]*>/i, `${r.name}: a placeholder leaked`);
  }
});
