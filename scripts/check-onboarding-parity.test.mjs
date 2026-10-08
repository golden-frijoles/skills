// check-onboarding-parity.test.mjs — a one-word drift in a surface must be caught, and only that.
// Run: node --test scripts/check-onboarding-parity.test.mjs
//
// Importing check-onboarding-parity.mjs must not run anything — no network probe, no process.exit
// — which is exactly what this file's own import proves: the module is `isMain`-guarded, and
// `findParityProblems` is a pure function of its injected `surfaces`/`read`/`root`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carriesLocalConfig, findParityProblems, SURFACES } from './check-onboarding-parity.mjs';

const FIXTURE_ROOT = '/fixture';

/** A minimal one-surface fixture and a `read` stub over an in-memory file map. */
function fixture(files, must = ['golden-frijoles plugin', 'run `claude plugin install`']) {
  const surfaces = [{ file: 'README.md', why: 'the front door', must }];
  const read = (path) => {
    const rel = path.slice(FIXTURE_ROOT.length + 1);
    if (!(rel in files)) throw new Error(`ENOENT: ${rel}`);
    return files[rel];
  };
  return { surfaces, read };
}

test('identical text passes — no problems reported', () => {
  const { surfaces, read } = fixture({
    'README.md': 'Install the golden-frijoles plugin and run `claude plugin install` to get started.',
  });
  const problems = findParityProblems({ surfaces, read, root: FIXTURE_ROOT });
  assert.deepEqual(problems, []);
});

test('a one-word drift in the surface is caught, not just a wholesale rewrite', () => {
  const { surfaces, read } = fixture({
    // "golden-frijoles" → "golden-beans": exactly one word changed, the rest byte-identical.
    'README.md': 'Install the golden-beans plugin and run `claude plugin install` to get started.',
  });
  const problems = findParityProblems({ surfaces, read, root: FIXTURE_ROOT });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].file, 'README.md');
  assert.deepEqual(problems[0].missing, ['golden-frijoles plugin']);
});

test('a missing file is reported as "(the file itself)", not a silent pass', () => {
  const { surfaces, read } = fixture({});
  const problems = findParityProblems({ surfaces, read, root: FIXTURE_ROOT });
  assert.equal(problems.length, 1);
  assert.deepEqual(problems[0].missing, ['(the file itself)']);
});

test('two required strings, one dropped: only the dropped one is named missing', () => {
  const { surfaces, read } = fixture(
    { 'README.md': 'Install the golden-frijoles plugin. Nothing about claude here.' },
    ['golden-frijoles plugin', 'run `claude plugin install`']
  );
  const problems = findParityProblems({ surfaces, read, root: FIXTURE_ROOT });
  assert.deepEqual(problems[0].missing, ['run `claude plugin install`']);
});

test('multiple surfaces: only the drifted one is reported, the clean one is not', () => {
  const surfaces = [
    { file: 'README.md', why: 'front door', must: ['golden-frijoles'] },
    { file: 'SKILL.md', why: 'umbrella skill', must: ['golden-frijoles'] },
  ];
  const files = { 'README.md': 'golden-frijoles is here', 'SKILL.md': 'golden-beans is here (drifted)' };
  const read = (path) => {
    const rel = path.slice(FIXTURE_ROOT.length + 1);
    if (!(rel in files)) throw new Error(`ENOENT: ${rel}`);
    return files[rel];
  };
  const problems = findParityProblems({ surfaces, read, root: FIXTURE_ROOT });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].file, 'SKILL.md');
});

test('importing this module runs nothing — SURFACES is just data, no side effects fired', () => {
  // If the CLI half were not isMain-guarded, importing the module above (at the top of this file)
  // would already have spawned a probe or exited the test process — this assertion is really about
  // having gotten this far at all, plus a sanity check that the real registry is well-formed.
  assert.ok(Array.isArray(SURFACES) && SURFACES.length > 0);
  for (const surface of SURFACES) {
    assert.ok(typeof surface.file === 'string' && surface.file.length > 0);
    assert.ok(Array.isArray(surface.must) && surface.must.length > 0);
  }
});

test('the frijoles config probe runs only on a frijoles that carries it (S5.2): older or unknown is a skip, never a fail', () => {
  assert.equal(carriesLocalConfig('0.1.0'), false);
  assert.equal(carriesLocalConfig('0.2.0-rc.1'), false);
  assert.equal(carriesLocalConfig(null), false);
  assert.equal(carriesLocalConfig('not a version'), false);
  assert.equal(carriesLocalConfig('0.2.0'), true);
  assert.equal(carriesLocalConfig('1.0.0'), true);
});
