// kickoff-cli.test.mjs — the project-root ladder and the epic lookup both kickoff generators share
// (kickoff-generator-path C2). Run: node --test template/scripts/lib/kickoff-cli.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, resolveRepoRoot, findEpicDir } from './kickoff-cli.mjs';

const has = (...dirs) => (p) => dirs.includes(p);

test('--repo-root wins over everything, resolved against cwd', () => {
  const root = resolveRepoRoot({ 'repo-root': 'proj' }, { env: { GF_PROJECT_ROOT: '/elsewhere' }, cwd: '/home', exists: () => false, project: () => '/kit' });
  assert.equal(root, '/home/proj');
});

test('a bare --repo-root (no value) is ignored, not taken as the string "true"', () => {
  const root = resolveRepoRoot(parseArgs(['--repo-root']), { env: {}, cwd: '/p', exists: has('/p/Roadmap'), project: () => '/p' });
  assert.equal(root, '/p');
});

test('GF_PROJECT_ROOT (gf-kit --root) is taken as given, even without a Roadmap/', () => {
  const root = resolveRepoRoot({}, { env: { GF_PROJECT_ROOT: 'other' }, cwd: '/home', exists: () => false, project: () => '/kit' });
  assert.equal(root, '/home/other');
});

test('projectRoot() is used when it holds a Roadmap/ — a project running its own scripts/ from anywhere', () => {
  const root = resolveRepoRoot({}, { env: {}, cwd: '/tmp/x', exists: has('/proj/Roadmap'), project: () => '/proj' });
  assert.equal(root, '/proj');
});

test('the plugin’s vendored copy (projectRoot() = groom/, no Roadmap/) walks up from cwd instead', () => {
  const exists = has('/repo/Roadmap');
  const root = resolveRepoRoot({}, { env: {}, cwd: '/repo/apps/web', exists, project: () => '/plugins/golden-frijoles/skills/groom' });
  assert.equal(root, '/repo');
});

test('nothing found anywhere: cwd', () => {
  assert.equal(resolveRepoRoot({}, { env: {}, cwd: '/nowhere/deep', exists: () => false, project: () => '/kit' }), '/nowhere/deep');
});

test('findEpicDir finds the one macro-area holding the slug, and names what it searched otherwise', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'kickoff-cli-')));
  for (const [macro, slug] of [['01-core', 'alpha'], ['02-x', 'beta'], ['03-y', 'beta']]) {
    mkdirSync(join(repo, 'Roadmap', macro, slug), { recursive: true });
    writeFileSync(join(repo, 'Roadmap', macro, slug, 'README.md'), '# x\n');
  }
  assert.deepEqual(findEpicDir(repo, 'alpha'), { macro: '01-core', dir: join(repo, 'Roadmap', '01-core', 'alpha') });
  assert.match(findEpicDir(repo, 'gamma').error, /no epic found for slug "gamma".*searched: /);
  assert.match(findEpicDir(repo, 'beta').error, /ambiguous slug "beta".*Roadmap\/02-x\/beta, Roadmap\/03-y\/beta/);
  assert.match(findEpicDir(join(repo, 'nope'), 'alpha').error, /no Roadmap\/ dir under/);
});
