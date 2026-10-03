// scaffold-epic.test.mjs — the scaffolder's output is held to the frontmatter contract
// (build-visualization-claude-mods S1). The contract module lives in the template's scripts/lib/,
// which a plugin cannot import at runtime; this test (repo-local, not shipped behaviour) is what
// keeps the two in step, alongside CI's doc-format run over a freshly scaffolded epic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    ['---\nslug: tmp-check\nintent_match: 72\n---\n', '72'],
    ['---\nslug: tmp-check\nintent_match: 72   # advisory\n---\n', '72'],
    ['---\nslug: tmp-check\nintent_match: null\n---\n', 'null'],
    ['---\nslug: tmp-check\nintent_match: 140\n---\n', 'null'],
    ['---\nslug: tmp-check\nintent_match: seventy\n---\n', 'null'],
    ['---\nslug: tmp-check\n---\nintent_match: 90\n', 'null'],
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
  const seed = '---\nslug: tmp-check\n---\n## Appetite\nM\nquote: $24–35 (M, n=4, p25–p75)\n';
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
