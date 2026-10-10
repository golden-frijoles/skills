// scaffold-epic.test.mjs — the scaffolder's output is held to the frontmatter contract
// (build-visualization-claude-mods S1). The contract module lives in the template's scripts/lib/,
// which a plugin cannot import at runtime; this test (repo-local, not shipped behaviour) is what
// keeps the two in step, alongside CI's doc-format run over a freshly scaffolded epic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EPIC_FIELDS,
  SPRINT_FIELDS,
  STORY_FIELDS,
  parseDocFrontmatter,
  validateEpicFrontmatter,
  validateSprintFrontmatter,
} from '../../../../template/scripts/lib/roadmap-contract.mjs';

const SCAFFOLD = join(dirname(fileURLToPath(import.meta.url)), 'scaffold-epic.mjs');

function scaffold(extra = [], { seed = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'scaffold-'));
  mkdirSync(join(root, 'Roadmap'));
  if (seed != null) {
    mkdirSync(join(root, 'Roadmap', '00-ideas', 'seeds'), { recursive: true });
    writeFileSync(join(root, 'Roadmap', '00-ideas', 'seeds', 'tmp-check.md'), seed);
  }
  execFileSync(
    'node',
    [SCAFFOLD, '--slug', 'tmp-check', '--area', '09', '--macro', '09-platform-infra', '--title', 'Tmp: "check" # x', ...extra],
    { cwd: root, stdio: 'pipe' }
  );
  return { root, dir: join(root, 'Roadmap', '09-platform-infra', 'tmp-check') };
}

test('the epic README is born with every contract field, valid, with true totals', () => {
  const { root, dir } = scaffold(['--risk', 'low', '--type', 'chore', '--sprints', 'One: first;Two;Three']);
  try {
    const parsed = parseDocFrontmatter(readFileSync(join(dir, 'README.md'), 'utf8'));
    assert.equal(parsed.error, null);
    for (const key of ['status', 'slug', 'build_order', ...EPIC_FIELDS]) assert.ok(key in parsed.data, key);
    assert.equal(parsed.data.title, 'Tmp: "check" # x');
    assert.equal(parsed.data.area, '09-platform-infra');
    assert.equal(parsed.data.type, 'chore');
    assert.equal(parsed.data.phase, 'Shaping');
    assert.deepEqual(validateEpicFrontmatter(parsed, { sprintCount: 3, storyCount: 3 }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every sprint-N.md is born with frontmatter and a parser-owned per-story block', () => {
  const { root, dir } = scaffold(['--risk', 'high', '--sprints', 'One;Two: second']);
  try {
    for (const n of [1, 2]) {
      const parsed = parseDocFrontmatter(readFileSync(join(dir, `sprint-${n}.md`), 'utf8'));
      for (const key of SPRINT_FIELDS) assert.ok(key in parsed.data, `sprint-${n}: ${key}`);
      assert.equal(parsed.data.sprint, n);
      assert.equal(parsed.data.risk, 'high');
      const [story] = parsed.data.stories;
      for (const key of STORY_FIELDS) assert.ok(key in story, `sprint-${n} story: ${key}`);
      assert.equal(story.id, `S${n}.1`);
      assert.deepEqual(validateSprintFrontmatter(parsed, { n, slug: 'tmp-check' }), []);
      // The human-readable prose is still there.
      assert.match(parsed.body, new RegExp(`^### Story ${n}\\.1 — `, 'm'));
      assert.match(parsed.body, /^\*\*As a\*\* <role>/m);
    }
    assert.equal(parseDocFrontmatter(readFileSync(join(dir, 'sprint-2.md'), 'utf8')).data.title, 'Two: second');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a risk outside the two tiers is refused before anything is written', () => {
  assert.throws(() => scaffold(['--risk', 'medium', '--sprints', 'One']), /--risk must be low\|high/);
});

// intent-match S2: the seed's advisory score is copied, never invented.
test('intent_match: copied from the seed when it is a whole number 0–100, otherwise null', () => {
  const cases = [
    [null, 'null'],
    ['---\nslug: tmp-check\nunderwritten_by: wave-x\nintent_match: 72\n---\n', '72'],
    ['---\nslug: tmp-check\nunderwritten_by: wave-x\nintent_match: 72   # advisory\n---\n', '72'],
    ['---\nslug: tmp-check\nunderwritten_by: wave-x\nintent_match: null\n---\n', 'null'],
    ['---\nslug: tmp-check\nunderwritten_by: wave-x\nintent_match: 140\n---\n', 'null'],
    ['---\nslug: tmp-check\nunderwritten_by: wave-x\nintent_match: seventy\n---\n', 'null'],
    ['---\nslug: tmp-check\nunderwritten_by: wave-x\n---\nintent_match: 90\n', 'null'],
  ];
  for (const [seed, want] of cases) {
    const { root, dir } = scaffold(['--risk', 'low', '--sprints', 'One'], { seed });
    try {
      const readme = readFileSync(join(dir, 'README.md'), 'utf8');
      assert.match(readme, new RegExp(`^intent_match: ${want}\\s`, 'm'), JSON.stringify(seed));
      assert.equal(parseDocFrontmatter(readme).error, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('finops 2.3: the quote comes from --quote, else the seed’s quote: line; absent is null, never 0 — and it validates', () => {
  const seed = '---\nslug: tmp-check\nunderwritten_by: wave-x\n---\n## Appetite\nM\nquote: $24–35 (M, n=4, p25–p75)\n';
  const cases = [
    [[], null, ['null', 'null', 'null']],
    [[], seed, ['24', '35', '"M, n=4, p25–p75"']],
    [['--quote', '30-55', '--quote-basis', 'M, n=6, p25–p75'], seed, ['30', '55', '"M, n=6, p25–p75"']],
    [['--quote', '$12.5–40'], null, ['12.5', '40', 'null']],
  ];
  for (const [extra, s, [lo, hi, basis]] of cases) {
    const { root, dir } = scaffold(['--risk', 'low', '--sprints', 'One', ...extra], { seed: s });
    try {
      const readme = readFileSync(join(dir, 'README.md'), 'utf8');
      assert.match(readme, new RegExp(`^quote_low_usd: ${lo.replace('.', '\\.')}\\s`, 'm'), JSON.stringify(extra));
      assert.match(readme, new RegExp(`^quote_high_usd: ${hi}\\s*$`, 'm'));
      assert.match(readme, new RegExp(`^quote_basis: ${basis.replace(/[()]/g, '\\$&')}\\s*$`, 'm'));
      const parsed = parseDocFrontmatter(readme);
      assert.equal(parsed.error, null);
      assert.deepEqual(validateEpicFrontmatter(parsed, { sprintCount: 1, storyCount: 1 }), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('finops 2.3: a malformed --quote is refused before anything is written', () => {
  assert.throws(() => scaffold(['--risk', 'low', '--sprints', 'One', '--quote', '55-30']));
  assert.throws(() => scaffold(['--risk', 'low', '--sprints', 'One', '--quote', 'lots']));
  assert.throws(() => scaffold(['--risk', 'low', '--sprints', 'One', '--quote']), undefined, 'a value-less --quote');
  assert.throws(() => scaffold(['--risk', 'low', '--sprints', 'One', '--quote', '0-0']), undefined, 'a $0 quote');
  assert.throws(() => scaffold(['--risk', 'low', '--sprints', 'One', '--quote', '0.001-0.004']), undefined, 'rounds to $0');
  const { root, dir } = scaffold(['--risk', 'low', '--sprints', 'One', '--quote', '30.456-55.004']);
  try {
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    assert.match(readme, /^quote_low_usd: 30\.46\s/m);
    assert.match(readme, /^quote_high_usd: 55\s*$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// fund-at-approval S1.3 + S1.5 (F33): a funded seed scaffolds with --slug alone; an unfunded one is refused.
const SEED = [
  '---',
  'title: "Fixed: a chore"',
  'slug: tmp-seed',
  'status: queued',
  'area: "09"',
  'type: chore',
  'appetite: S',
  'underwritten_by: wave-2026-10',
  'risk: low',
  'epic: null',
  'build_order: 61',
  '---',
  '',
  '## Acceptance criteria',
  '- The first check holds, with `code` in it.',
  '- The second check is long enough to wrap onto the next line of the seed, as a refined pitch',
  '  usually does, and must come out as one story.',
  '',
  '## Open risks / research',
  '- Not a story.',
  '',
].join('\n');

function scaffoldSeed(seedText, extra = []) {
  const root = mkdtempSync(join(tmpdir(), 'scaffold-seed-'));
  mkdirSync(join(root, 'Roadmap', '00-ideas', 'seeds'), { recursive: true });
  mkdirSync(join(root, 'Roadmap', '09-platform-infra'));
  mkdirSync(join(root, 'Roadmap', 'bets'));
  writeFileSync(join(root, 'Roadmap', 'bets', 'wave-2026-10.md'), '# Cycle\n');
  writeFileSync(join(root, 'Roadmap', '00-ideas', 'seeds', 'tmp-seed.md'), seedText);
  const r = spawnSync('node', [SCAFFOLD, '--slug', 'tmp-seed', ...extra], { cwd: root, encoding: 'utf8' });
  return { root, r, dir: join(root, 'Roadmap', '09-platform-infra', 'tmp-seed') };
}

test('F33: --slug alone scaffolds a funded seed: one sprint, its acceptance criteria as stories, build_order kept', () => {
  const { root, r, dir } = scaffoldSeed(SEED);
  try {
    assert.equal(r.status, 0, r.stderr);
    const readme = parseDocFrontmatter(readFileSync(join(dir, 'README.md'), 'utf8'));
    assert.equal(readme.data.title, 'Fixed: a chore');
    assert.equal(readme.data.type, 'chore');
    assert.equal(readme.data.risk, 'low');
    assert.equal(readme.data.build_order, 61);
    assert.deepEqual(validateEpicFrontmatter(readme, { sprintCount: 1, storyCount: 2 }), []);
    const sprint = parseDocFrontmatter(readFileSync(join(dir, 'sprint-1.md'), 'utf8'));
    assert.deepEqual(validateSprintFrontmatter(sprint, { n: 1, slug: 'tmp-seed' }), []);
    assert.deepEqual(sprint.data.stories.map((s) => s.id), ['S1.1', 'S1.2']);
    assert.equal(sprint.data.stories[0].i_want, 'The first check holds, with `code` in it.');
    assert.match(sprint.data.stories[1].i_want, /next line of the seed, as a refined pitch usually does, and must come out as one story\.$/);
    assert.match(sprint.body, /^### Story 1\.2 — The second check/m);
    assert.doesNotMatch(sprint.body, /Not a story|^### Story 1\.1 — <title>$/m);
    // The seed leaves the funnel, and the commit line carries the cycle row with the scaffold.
    const seed = readFileSync(join(root, 'Roadmap', '00-ideas', 'seeds', 'tmp-seed.md'), 'utf8');
    assert.match(seed, /^status: scaffolded$/m);
    assert.match(seed, /^epic: "09-platform-infra\/tmp-seed"$/m);
    assert.match(r.stdout, /git commit -- .*'Roadmap\/bets\/wave-2026-10\.md'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unfunded seed is refused before anything is written, and the refusal names fund.mjs', () => {
  const { root, r, dir } = scaffoldSeed(SEED.replace('underwritten_by: wave-2026-10', 'underwritten_by: null'));
  try {
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not funded/);
    assert.match(r.stderr, /fund\.mjs" --slug tmp-seed/);
    assert.equal(existsSync(dir), false);
    assert.match(readFileSync(join(root, 'Roadmap', '00-ideas', 'seeds', 'tmp-seed.md'), 'utf8'), /^status: queued$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review #271: criteria holding $-patterns are copied verbatim; no seed → no seed path in the commit; path segments are refused', () => {
  const { root, r, dir } = scaffoldSeed(SEED.replace('- The first check holds, with `code` in it.', () => "- Costs $& and $' stay literal."));
  try {
    assert.equal(r.status, 0, r.stderr);
    const sprint = readFileSync(join(dir, 'sprint-1.md'), 'utf8');
    assert.match(sprint, /\*\*Acceptance:\*\* Costs \$& and \$' stay literal\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const bare = mkdtempSync(join(tmpdir(), 'scaffold-bare-'));
  mkdirSync(join(bare, 'Roadmap'));
  try {
    const ok = spawnSync('node', [SCAFFOLD, '--slug', 'no-seed', '--area', '09', '--macro', '09-x', '--title', 'T', '--sprints', 'One'], { cwd: bare, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.doesNotMatch(ok.stdout, /seeds\/no-seed\.md/);
    const bad = spawnSync('node', [SCAFFOLD, '--slug', '../escape', '--area', '09', '--macro', '09-x', '--title', 'T', '--sprints', 'One'], { cwd: bare, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--slug must match/);
    assert.match(spawnSync('node', [SCAFFOLD, '--slug', 'ok', '--area', '09', '--macro', '../09-x', '--title', 'T', '--sprints', 'One'], { cwd: bare, encoding: 'utf8' }).stderr, /--macro must match/);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('review #271: numbered acceptance items and an "## Acceptance checks" heading become stories too', () => {
  const numbered = SEED.replace(/## Acceptance criteria\n[\s\S]*?\n\n/, () => '## Acceptance checks (the product owner runs these)\n1. First numbered.\n2) Second numbered,\n   wrapped.\n\n');
  const { root, r, dir } = scaffoldSeed(numbered);
  try {
    assert.equal(r.status, 0, r.stderr);
    const sprint = parseDocFrontmatter(readFileSync(join(dir, 'sprint-1.md'), 'utf8'));
    assert.deepEqual(sprint.data.stories.map((s) => s.i_want), ['First numbered.', 'Second numbered, wrapped.']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// result-record S1.1 (D3): the seed's target travels into the README, as the quote does; no target scaffolds null.
test('result-record D3: a scaffolded epic carries the seed’s target fields, and the contract accepts them', () => {
  const seed = [
    '---',
    'slug: tmp-check',
    'underwritten_by: wave-x',
    'hypothesis: "Reminders: invoices get paid on time"',
    'target_metric: invoices_paid_on_time   # a North Star input',
    'target_from: 61',
    'target_to: 70.5',
    'read_date: 2026-11-04',
    '---',
    '# tmp',
    '',
  ].join('\n');
  for (const [s, want] of [
    [
      seed,
      {
        hypothesis: 'Reminders: invoices get paid on time',
        target_metric: 'invoices_paid_on_time',
        target_from: 61,
        target_to: 70.5,
        read_date: '2026-11-04',
      },
    ],
    [null, { hypothesis: null, target_metric: null, target_from: null, target_to: null, read_date: null }],
  ]) {
    const { root, dir } = scaffold(['--risk', 'low', '--sprints', 'One'], { seed: s });
    try {
      const parsed = parseDocFrontmatter(readFileSync(join(dir, 'README.md'), 'utf8'));
      assert.equal(parsed.error, null);
      for (const [k, v] of Object.entries(want)) assert.equal(parsed.data[k], v, k);
      for (const k of ['verdict', 'verdict_actual', 'verdict_evidence', 'verdict_at'])
        assert.equal(parsed.data[k], null, `${k} is born null`);
      assert.deepEqual(validateEpicFrontmatter(parsed, { sprintCount: 1, storyCount: 1 }), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// one-epic-page D11: the flag decided at Stage 6b travels from the seed into the README; no seed or no flag → null.
test('one-epic-page D11: a scaffolded epic carries the seed’s flag_key, and the contract accepts it', () => {
  const seed = (key) =>
    ['---', 'slug: tmp-check', 'underwritten_by: wave-x', `flag_key: ${key}`, '---', '# tmp', ''].join('\n');
  for (const [s, want, ok] of [
    [seed('auth.terminal_sign_in_enabled'), 'auth.terminal_sign_in_enabled', true],
    [seed('null'), null, true],
    [null, null, true],
    [seed('Not A Key'), 'Not A Key', false],
  ]) {
    const { root, dir } = scaffold(['--risk', 'low', '--sprints', 'One'], { seed: s });
    try {
      const parsed = parseDocFrontmatter(readFileSync(join(dir, 'README.md'), 'utf8'));
      assert.equal(parsed.error, null);
      assert.equal(parsed.data.flag_key, want);
      const offenses = validateEpicFrontmatter(parsed, { sprintCount: 1, storyCount: 1 });
      if (ok) assert.deepEqual(offenses, [])
      else assert.deepEqual(offenses.map((o) => o.rule), ['contract-flag-key-invalid']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('grounded-bets D1: a scaffolded epic carries the seed’s grounding and persona, and the contract accepts it', () => {
  const seed = (lines) => ['---', 'slug: tmp-check', 'underwritten_by: wave-x', ...lines, '---', '# tmp', ''].join('\n');
  for (const [s, want] of [
    [seed(['grounded: true', 'persona: "solo founders, shipping weekly"']), { grounded: 'true', reason: null, persona: 'solo founders, shipping weekly' }],
    [seed(['grounded: false', 'grounded_reason: "a launch blocker"']), { grounded: 'false', reason: 'a launch blocker', persona: null }],
    // a reason without false is dropped, never copied into an invalid README; a typo is null, not forwarded
    [seed(['grounded: yes', 'grounded_reason: "stray"']), { grounded: null, reason: null, persona: null }],
    [null, { grounded: null, reason: null, persona: null }],
  ]) {
    const { root, dir } = scaffold(['--risk', 'low', '--sprints', 'One'], { seed: s });
    try {
      const parsed = parseDocFrontmatter(readFileSync(join(dir, 'README.md'), 'utf8'));
      assert.equal(parsed.error, null);
      assert.equal(parsed.data.grounded, want.grounded);
      assert.equal(parsed.data.grounded_reason, want.reason);
      assert.equal(parsed.data.persona, want.persona);
      assert.deepEqual(validateEpicFrontmatter(parsed, { sprintCount: 1, storyCount: 1 }), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('one-bet-wired D1: a scaffolded epic carries the seed’s bet measurement, and the contract accepts it', () => {
  const seed = ['---', 'slug: tmp-check', 'underwritten_by: wave-x', 'flag_key: shop.one_step_enabled', 'target_segment: everyone', 'adopted_event: order_placed', 'retention_days: 14', '---', '# tmp', ''].join('\n');
  const { root, dir } = scaffold(['--risk', 'low', '--sprints', 'One'], { seed });
  try {
    const parsed = parseDocFrontmatter(readFileSync(join(dir, 'README.md'), 'utf8'));
    assert.equal(parsed.error, null);
    assert.deepEqual(
      [parsed.data.target_segment, parsed.data.adopted_event, parsed.data.retained_event, parsed.data.retention_days, parsed.data.satisfied_event],
      ['everyone', 'order_placed', null, 14, null]
    );
    assert.deepEqual(validateEpicFrontmatter(parsed, { sprintCount: 1, storyCount: 1 }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
