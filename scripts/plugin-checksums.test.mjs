// plugin-checksums.test.mjs — install.md's sums are the release's bytes, and a changed release fails the comparison.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_DIR, parseSums, pluginChecksums, renderSums, verifyRelease } from './plugin-checksums.mjs';

function fixtureRelease() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-release-'));
  mkdirSync(join(root, PLUGIN_DIR, 'skills', 'a'), { recursive: true });
  writeFileSync(join(root, PLUGIN_DIR, 'skills', 'a', 'SKILL.md'), '# a\n');
  writeFileSync(join(root, PLUGIN_DIR, 'plugin.json'), '{"version":"1.0.0"}\n');
  writeFileSync(join(root, 'README.md'), 'outside the plugin\n');
  return root;
}

test('every plugin file is listed, sorted, and nothing outside the plugin is', () => {
  const root = fixtureRelease();
  const paths = pluginChecksums(root).map((entry) => entry.path);
  assert.deepEqual(paths, ['plugins/golden-frijoles/plugin.json', 'plugins/golden-frijoles/skills/a/SKILL.md']);
});

test('the rendered list is shasum -c format and parses back to itself', () => {
  const entries = pluginChecksums(fixtureRelease());
  const text = renderSums(entries);
  assert.match(text, /^[0-9a-f]{64} {2}plugins\/golden-frijoles\/plugin\.json\n/);
  assert.deepEqual(parseSums(text), entries.map(({ path, sha256 }) => ({ sha256, path })));
});

test('an untouched release matches its own list', () => {
  const root = fixtureRelease();
  assert.deepEqual(verifyRelease(root, renderSums(pluginChecksums(root))), { ok: true, problems: [] });
});

test('a release with one changed file fails the comparison, and names the file', () => {
  const root = fixtureRelease();
  const sums = renderSums(pluginChecksums(root));
  writeFileSync(join(root, PLUGIN_DIR, 'skills', 'a', 'SKILL.md'), '# a, edited\n');
  assert.deepEqual(verifyRelease(root, sums), { ok: false, problems: ['changed: plugins/golden-frijoles/skills/a/SKILL.md'] });
});

test('an added file fails too: the list is the whole release', () => {
  const root = fixtureRelease();
  const sums = renderSums(pluginChecksums(root));
  writeFileSync(join(root, PLUGIN_DIR, 'skills', 'a', 'extra.mjs'), 'export {}\n');
  assert.deepEqual(verifyRelease(root, sums), {
    ok: false,
    problems: ['not in the list: plugins/golden-frijoles/skills/a/extra.mjs'],
  });
});
