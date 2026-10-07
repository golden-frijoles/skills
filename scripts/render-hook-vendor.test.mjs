// render-hook-vendor.test.mjs — the build view's bundled resolver stays the template's bytes (distribute-what-we-use D5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLES, bundleManifest, vendorDrift, vendorManifest, writeVendor, ENTRY } from './render-hook-vendor.mjs';

function fixture() {
  const src = mkdtempSync(join(tmpdir(), 'vendor-src-'));
  mkdirSync(join(src, 'lib'));
  writeFileSync(join(src, ENTRY), "import { a } from './lib/a.mjs';\nexport const x = a;\n");
  writeFileSync(join(src, 'lib', 'a.mjs'), "import { b } from './b.mjs';\nexport const a = b;\n");
  writeFileSync(join(src, 'lib', 'b.mjs'), 'export const b = 1;\n');
  writeFileSync(join(src, 'unrelated.mjs'), 'export const u = 0;\n');
  return { src, vendor: mkdtempSync(join(tmpdir(), 'vendor-out-')) };
}

test('the manifest is the entry plus its real import closure — nothing hand-listed, nothing extra', () => {
  const { src } = fixture();
  assert.deepEqual(vendorManifest({ sourceDir: src }), ['build-state.mjs', 'lib/a.mjs', 'lib/b.mjs']);
});

test('the real manifest bundles build-state and exactly the libs it imports', () => {
  // board-sinks-and-scrumban S3.1: the build view reads its stage from the extractor's rows, so its closure is the
  // extractor's too (and the push the extractor imports for `--sink hub`).
  assert.deepEqual(vendorManifest(), [
    'build-state.mjs',
    'lib/board-text.mjs',
    'lib/config-registry.mjs',
    'lib/config.mjs',
    'lib/epic-kickoff.mjs',
    'lib/project-root.mjs',
    'lib/result-dates.mjs',
    'lib/roadmap-contract.mjs',
    'lib/session-journal.mjs',
    'lib/stage-facts.mjs',
    'lib/stage.mjs',
    'lib/work-branch.mjs',
    'roadmap-extract.mjs',
    'roadmap-push.mjs',
  ]);
});

test('drift: a missing bundle, a one-byte change and a padded file are all caught; a fresh write is clean', () => {
  const { src, vendor } = fixture();
  const manifest = vendorManifest({ sourceDir: src });
  assert.equal(vendorDrift({ manifest, sourceDir: src, vendorDir: vendor }).stale.length, 3, 'nothing written yet');
  writeVendor({ manifest, sourceDir: src, vendorDir: vendor });
  assert.deepEqual(vendorDrift({ manifest, sourceDir: src, vendorDir: vendor }), { stale: [], extra: [] });
  writeFileSync(join(vendor, 'lib', 'b.mjs'), 'export const b = 2;\n');
  assert.deepEqual(vendorDrift({ manifest, sourceDir: src, vendorDir: vendor }).stale, ['lib/b.mjs']);
  writeVendor({ manifest, sourceDir: src, vendorDir: vendor });
  writeFileSync(join(vendor, 'stray.mjs'), '');
  assert.deepEqual(vendorDrift({ manifest, sourceDir: src, vendorDir: vendor }).extra, ['stray.mjs']);
});

test('the committed bundles match template/scripts right now', () => {
  for (const bundle of BUNDLES) {
    const manifest = bundleManifest(bundle);
    assert.deepEqual(vendorDrift({ manifest, vendorDir: bundle.vendorDir }), { stale: [], extra: [] }, bundle.name);
  }
});

test('the groom kickoff bundle is the two generators, their template and their closure (D17, S3.4, kickoff-generator-path C1)', () => {
  const groom = BUNDLES.find((b) => b.name === 'the groom kickoff bundle');
  assert.ok(groom, 'a groom kickoff bundle');
  assert.equal(groom.entry, 'emit-epic-kickoff.mjs');
  assert.match(groom.vendorDir, /plugins\/golden-frijoles\/skills\/groom\/vendor$/);
  const files = bundleManifest(groom);
  for (const f of [
    'emit-epic-kickoff.mjs',
    'emit-kickoff.mjs',
    'templates/kickoff.md',
    'lib/kickoff-cli.mjs',
    'lib/epic-kickoff.mjs',
    'lib/wip.mjs',
    'roadmap-extract.mjs',
    'lib/stage.mjs',
    'lib/config.mjs',
  ])
    assert.ok(files.includes(f), `${f} in the groom bundle`);
});

test('groom holds NO hand-kept generator beside its vendored copy (kickoff-generator-path C1)', () => {
  // A second hand-edited copy at groom/emit-*.mjs is the fork this bundle exists to end.
  const groomDir = join(BUNDLES.find((b) => b.name === 'the groom kickoff bundle').vendorDir, '..');
  for (const f of ['emit-epic-kickoff.mjs', 'emit-kickoff.mjs', 'templates/kickoff.md'])
    assert.equal(existsSync(join(groomDir, f)), false, `groom/${f} must not exist — the copy is groom/vendor/${f}`);
});
