import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASES,
  parseDocFrontmatter,
  serializeFields,
  formatScalar,
  validateEpicFrontmatter,
  validateSprintFrontmatter,
  SPRINT_FIELDS,
  FINOPS_FIELDS,
  validateFinopsFields,
  RESULT_FIELDS,
  VERDICTS,
  validateResultFields,
  isEvidencePointer,
} from './roadmap-contract.mjs';

const sprintDoc = (fields, body = '# E — Sprint 1: One\n') => `---\n${fields}\n---\n${body}`;

const STORY = {
  id: 'S1.1',
  title: 'Agent surface parity',
  as_a: "buyer's agent",
  i_want: 'checkout options to reflect arranged-only listings',
  so_that: "I'm never offered a carrier rail the seller can't fulfil",
  risk: 'low',
  status: 'planned',
};
const SPRINT = {
  epic: 'arranged-only-delivery',
  sprint: 1,
  title: 'Agent surface: parity',
  risk: 'low',
  phase: 'Building',
  stories_total: 1,
  stories: [STORY],
};

test('the per-story block round-trips through serialize → parse unchanged', () => {
  const doc = sprintDoc(serializeFields(SPRINT, SPRINT_FIELDS));
  const parsed = parseDocFrontmatter(doc);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.data, SPRINT);
  assert.equal(parsed.body, '# E — Sprint 1: One\n');
});

test('values that would be ambiguous bare are quoted, and read back identically', () => {
  for (const v of ['null', 'Yes', 'a: b', 'x # y', '42abc', ' lead', "it's", 'say "hi"', 'S1.1', '<role>']) {
    const doc = sprintDoc(`title: ${formatScalar(v)}`);
    assert.equal(parseDocFrontmatter(doc).data.title, v, `round-trip of ${JSON.stringify(v)}`);
  }
  assert.equal(formatScalar(null), 'null');
  assert.equal(formatScalar(3), '3');
});

test('the parser keeps the existing epic README frontmatter readable: inline and indented comments', () => {
  const md = [
    '---',
    'status: shipped   # AUTHORITATIVE epic status (SSOT) — scaffolded | in-progress | shipped | archived.',
    'slug: foo',
    'build_order: null    # integer position in the ONE global build sequence — the SSOT once the epic',
    '                     # exists (the seed value is only a fallback).',
    'phase: Locking architecture',
    '---',
    '# Epic: Foo',
  ].join('\n');
  const { data, error } = parseDocFrontmatter(md);
  assert.equal(error, null);
  assert.deepEqual(data, {
    status: 'shipped',
    slug: 'foo',
    build_order: null,
    phase: 'Locking architecture',
  });
});

test('a line outside the YAML subset is a reported parse error, not a silent skip', () => {
  const parsed = parseDocFrontmatter(sprintDoc('title: ok\n  stray: indented with no list'));
  assert.match(parsed.error, /not in the contract's YAML subset/);
  assert.deepEqual(
    validateSprintFrontmatter(parsed, { n: 1 }).map((o) => o.rule),
    ['contract-parse']
  );
});

test('a doc with no frontmatter parses to hasFrontmatter:false and an untouched body', () => {
  const parsed = parseDocFrontmatter('# Title\n\nbody');
  assert.equal(parsed.hasFrontmatter, false);
  assert.equal(parsed.body, '# Title\n\nbody');
});

test('the ladder: every one of the six phases is accepted, and nothing else is', () => {
  assert.equal(PHASES.length, 6);
  for (const phase of PHASES) {
    const parsed = parseDocFrontmatter(sprintDoc(serializeFields({ ...SPRINT, phase }, SPRINT_FIELDS)));
    assert.deepEqual(validateSprintFrontmatter(parsed, { n: 1, slug: SPRINT.epic }), [], phase);
  }
  for (const phase of ['Nonsense', 'Merged', 'shipped', 'In Review']) {
    const parsed = parseDocFrontmatter(sprintDoc(serializeFields({ ...SPRINT, phase }, SPRINT_FIELDS)));
    assert.deepEqual(
      validateSprintFrontmatter(parsed, { n: 1 }).map((o) => o.rule),
      ['contract-phase-invalid'],
      phase
    );
  }
});

test('a sprint file with no frontmatter fails the contract', () => {
  const rules = validateSprintFrontmatter(parseDocFrontmatter('# E — Sprint 1: One\n'), { n: 1 }).map(
    (o) => o.rule
  );
  assert.deepEqual(rules, ['contract-sprint-frontmatter-missing']);
});

test('sprint cross-checks: totals, epic slug, sprint number, story ids, statuses, missing keys', () => {
  const bad = {
    ...SPRINT,
    epic: 'other-epic',
    sprint: 2,
    stories_total: 3,
    stories: [
      { ...STORY, status: 'shipped' },
      { ...STORY, risk: 'medium' },
      { id: 'S9.1', title: 'x' },
    ],
  };
  const rules = validateSprintFrontmatter(
    parseDocFrontmatter(sprintDoc(serializeFields(bad, SPRINT_FIELDS))),
    {
      n: 1,
      slug: SPRINT.epic,
    }
  ).map((o) => o.rule);
  for (const r of [
    'contract-sprint-epic-mismatch',
    'contract-sprint-number-mismatch',
    'contract-story-status-invalid',
    'contract-risk-invalid',
    'contract-story-id-duplicate',
    'contract-story-id-invalid',
    'contract-story-field-missing',
  ]) {
    assert.ok(rules.includes(r), `expected ${r} in ${rules.join(', ')}`);
  }
  const short = { ...SPRINT, stories_total: 2 };
  assert.deepEqual(
    validateSprintFrontmatter(parseDocFrontmatter(sprintDoc(serializeFields(short, SPRINT_FIELDS))), {
      n: 1,
    }).map((o) => o.rule),
    ['contract-total-mismatch']
  );
});

test('a user-story value may be an explicit null (unknown), but the key must be present', () => {
  const unknown = { ...SPRINT, stories: [{ ...STORY, as_a: null, i_want: null, so_that: null }] };
  const parsed = parseDocFrontmatter(sprintDoc(serializeFields(unknown, SPRINT_FIELDS)));
  assert.deepEqual(validateSprintFrontmatter(parsed, { n: 1 }), []);
});

const epicDoc = (fm) =>
  parseDocFrontmatter(
    `---\n${Object.entries(fm)
      .map(([k, v]) => `${k}: ${formatScalar(v)}`)
      .join('\n')}\n---\n`
  );
const EPIC = {
  status: 'in-progress',
  slug: 'foo',
  title: 'Foo',
  area: '09-platform-infra',
  risk: 'low',
  type: 'feature',
  phase: 'Building',
  sprints_total: 2,
  stories_total: 5,
};

test('epic README: compliant passes; each missing field, bad enum and wrong total is named', () => {
  assert.deepEqual(validateEpicFrontmatter(epicDoc(EPIC), { sprintCount: 2, storyCount: 5 }), []);
  const { title: _title, ...noTitle } = EPIC;
  assert.deepEqual(validateEpicFrontmatter(epicDoc(noTitle)), [
    { rule: 'contract-epic-field-missing', detail: 'no `title:`' },
  ]);
  const rules = validateEpicFrontmatter(
    epicDoc({ ...EPIC, phase: 'Nonsense', type: 'Feature', risk: 'medium' }),
    {
      sprintCount: 3,
      storyCount: 4,
    }
  ).map((o) => o.rule);
  assert.deepEqual(rules, [
    'contract-phase-invalid',
    'contract-risk-invalid',
    'contract-type-invalid',
    'contract-total-mismatch',
    'contract-total-mismatch',
  ]);
});

test('an archived epic is frozen record — exempt from the new fields', () => {
  assert.deepEqual(validateEpicFrontmatter(epicDoc({ status: 'archived', slug: 'old' })), []);
});

test('an empty stories list round-trips as a list, not null', () => {
  const empty = { ...SPRINT, stories_total: 0, stories: [] };
  const parsed = parseDocFrontmatter(sprintDoc(serializeFields(empty, SPRINT_FIELDS)));
  assert.deepEqual(parsed.data.stories, []);
  assert.deepEqual(validateSprintFrontmatter(parsed, { n: 1 }), []);
});

test('a trailing comment is allowed after a quoted value too', () => {
  const { data, error } = parseDocFrontmatter(sprintDoc(`title: "x # y"   # note\nrisk: 'low'  # tier`));
  assert.equal(error, null);
  assert.equal(data.title, 'x # y');
  assert.equal(data.risk, 'low');
});

test('a bare `stories:` (null) or a scalar is not a list, and fails (golden-beans#156, codex)', () => {
  for (const v of ['', 'null', 'none']) {
    const parsed = parseDocFrontmatter(
      sprintDoc(`epic: e\nsprint: 1\ntitle: t\nrisk: low\nphase: Building\nstories_total: 0\nstories: ${v}`)
    );
    assert.deepEqual(
      validateSprintFrontmatter(parsed, { n: 1 }).map((o) => o.rule),
      ['contract-stories-invalid'],
      JSON.stringify(v)
    );
  }
});

// ── finops D6/D17 — decimals, and the six quote/actual fields ──────────────────────────────────────

test('finops D17: a bare decimal reads as a number and writes back bare; an integer stays an integer', () => {
  const p = parseDocFrontmatter(
    '---\nactual_usd: 38.42\nactual_mtok: 1.9 # tokens\nbuild_order: 40\nv: "1.5"\n---\n'
  );
  assert.equal(p.error, null);
  assert.equal(p.data.actual_usd, 38.42);
  assert.equal(p.data.actual_mtok, 1.9);
  assert.equal(p.data.build_order, 40);
  assert.equal(p.data.v, '1.5', 'a quoted decimal stays a string');
  assert.equal(formatScalar(38.42), '38.42');
  assert.equal(
    formatScalar('1.5'),
    '"1.5"',
    'a decimal-looking STRING is quoted so it reads back as a string'
  );
  const back = parseDocFrontmatter(`---\n${serializeFields({ a: 38.42, b: '1.5' }, ['a', 'b'])}\n---\n`);
  assert.deepEqual(back.data, { a: 38.42, b: '1.5' });
});

test('finops D6: the six fields are declared once, and each bad value is named', () => {
  assert.deepEqual(FINOPS_FIELDS, [
    'quote_low_usd',
    'quote_high_usd',
    'quote_basis',
    'actual_usd',
    'actual_mtok',
    'actual_basis',
  ]);
  assert.deepEqual(validateFinopsFields({}), [], 'absent is fine — an unquoted epic is not a zero');
  assert.deepEqual(
    validateFinopsFields({
      quote_low_usd: 30,
      quote_high_usd: 55,
      quote_basis: 'M, n=6, p25–p75',
      actual_usd: 38.42,
      actual_mtok: 1.9,
      actual_basis: 'this machine',
    }),
    []
  );
  const rules = (fm) => validateFinopsFields(fm).map((o) => o.detail);
  assert.match(rules({ actual_usd: 'lots' }).join(), /actual_usd: "lots" is not a number/);
  assert.match(rules({ actual_mtok: -1 }).join(), /actual_mtok: "-1"/);
  assert.match(rules({ quote_basis: 5 }).join(), /quote_basis: "5" is not a string/);
  assert.match(rules({ quote_low_usd: 60, quote_high_usd: 55 }).join(), /above quote_high_usd/);
  assert.match(rules({ quote_low_usd: 60 }).join(), /needs both/);
});

test('finops D6: validateEpicFrontmatter carries the FinOps check', () => {
  const md =
    '---\nstatus: shipped\ntitle: T\narea: 09-x\nrisk: low\ntype: feature\nphase: Shipped\nsprints_total: 1\nstories_total: 1\nactual_usd: nope\n---\n';
  const offenses = validateEpicFrontmatter(parseDocFrontmatter(md));
  assert.deepEqual(
    offenses.map((o) => o.rule),
    ['contract-finops-invalid']
  );
});

// ── result-record D1/D2 — the target and the verdict ──────────────────────────────────────────────

const EPIC_HEAD =
  'status: shipped\ntitle: T\narea: 09-x\nrisk: low\ntype: feature\nphase: Shipped\nsprints_total: 1\nstories_total: 1';

test('result-record D1: the nine fields are declared once; no target at all is fine', () => {
  assert.deepEqual(RESULT_FIELDS, [
    'hypothesis',
    'target_metric',
    'target_from',
    'target_to',
    'read_date',
    'verdict',
    'verdict_actual',
    'verdict_evidence',
    'verdict_at',
  ]);
  assert.deepEqual(VERDICTS, ['proven', 'disproven', 'unclear']);
  assert.deepEqual(validateResultFields({}), [], 'a missing target is "no target", never an error');
});

test('result-record D1: a full record read off real frontmatter passes', () => {
  const md = `---\n${EPIC_HEAD}\nhypothesis: "Reminders get invoices paid on time"\ntarget_metric: invoices_paid_on_time\ntarget_from: 61\ntarget_to: 70\nread_date: 2026-11-04\nverdict: proven\nverdict_actual: 72.5\nverdict_evidence: "north-star:invoices_paid_on_time@2026-11-04"\nverdict_at: 2026-11-04\n---\n`;
  assert.deepEqual(validateEpicFrontmatter(parseDocFrontmatter(md)), []);
});

test('result-record D1: verdict: provn fails the contract, through validateEpicFrontmatter', () => {
  const md = `---\n${EPIC_HEAD}\nverdict: provn\nverdict_at: 2026-11-04\nverdict_evidence: "https://x.test/1"\n---\n`;
  const offenses = validateEpicFrontmatter(parseDocFrontmatter(md));
  assert.deepEqual(offenses.map((o) => o.rule), ['contract-result-invalid']);
  assert.match(offenses[0].detail, /verdict: "provn" is not one of proven \| disproven \| unclear/);
});

test('result-record D1: each bad value is named', () => {
  const details = (fm) => validateResultFields(fm).map((o) => o.detail).join(' / ');
  assert.match(details({ target_metric: 'x', target_from: '61%', target_to: 70 }), /target_from: "61%" is not a number/);
  const T = { target_metric: 'x', target_from: 1, target_to: 2 };
  assert.match(details({ target_metric: 'x', target_from: 61 }), /target_to is missing/);
  assert.match(details({ target_from: 10, target_to: 20 }), /target_metric is missing/, 'never silently never due');
  assert.match(details({ read_date: '2026-11-01' }), /target_metric is missing/);
  assert.match(details({ target_metric: 'x' }), /target_from is missing/, 'a metric alone has no direction');
  assert.deepEqual(validateResultFields({ hypothesis: 'a sentence is not a target' }), []);
  assert.match(details({ ...T, target_from: 5, target_to: 5 }), /has to move the number/);
  assert.match(details({ ...T, read_date: '2026-02-30' }), /read_date: "2026-02-30" is not a day/);
  assert.match(details({ ...T, read_date: '4 Nov' }), /read_date: "4 Nov"/);
  assert.match(details({ hypothesis: 3 }), /hypothesis: "3" is not text/);
  assert.match(details({ verdict_actual: 72 }), /verdict_actual is set but there is no verdict/);
  assert.match(details({ verdict: 'unclear' }), /needs verdict_at/);
  assert.match(details({ verdict: 'unclear', verdict_at: '2026-11-04' }), /needs verdict_evidence/);
  assert.deepEqual(
    validateResultFields({ verdict: 'unclear', verdict_at: '2026-11-04', verdict_evidence: 'traffic too low (n = 18)' }),
    [],
    'unclear takes a reason, not a pointer'
  );
  assert.deepEqual(validateResultFields({ target_metric: 'x', target_from: 44, target_to: 30.5 }), [], 'a target may go down');
});

test('result-record D2: proven or disproven without evidence that points somewhere is refused', () => {
  const base = { verdict: 'disproven', verdict_actual: 43, verdict_at: '2026-10-28' };
  assert.match(
    validateResultFields({ ...base, verdict_evidence: 'it felt flat' }).map((o) => o.detail).join(),
    /needs evidence that points somewhere/
  );
  assert.match(
    validateResultFields({ verdict: 'proven', verdict_at: '2026-10-28', verdict_evidence: 'ab:smart-defaults' })
      .map((o) => o.detail)
      .join(),
    /needs verdict_actual/
  );
  for (const ok of ['ab:smart-defaults', 'north-star:setup_completion@2026-10-28', 'https://example.com/r/12'])
    assert.deepEqual(validateResultFields({ ...base, verdict_evidence: ok }), [], ok);
});

test('result-record D2: the pointer grammar, syntax only', () => {
  assert.equal(isEvidencePointer('https://x.test/a?b=1'), true);
  assert.equal(isEvidencePointer('north-star:grounded_bets_share@2026-11-04'), true);
  assert.equal(isEvidencePointer('ab:checkout-v2'), true);
  assert.equal(isEvidencePointer('http://x.test'), false, 'https only');
  assert.equal(isEvidencePointer('https:///'), false, 'a link must parse, with a host');
  assert.equal(isEvidencePointer('north-star:x@2026-02-30'), false, 'a real day');
  assert.equal(isEvidencePointer('north-star:x'), false, 'a reading has a day');
  assert.equal(isEvidencePointer('ab:'), false);
  assert.equal(isEvidencePointer('see the dashboard'), false);
  assert.equal(isEvidencePointer(null), false);
});
