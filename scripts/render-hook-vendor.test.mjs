// render-hook-vendor.test.mjs — the build view's bundled resolver stays the template's bytes (distribute-what-we-use D5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLES, vendorDrift, vendorManifest, writeVendor, ENTRY } from './render-hook-vendor.mjs';

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
  assert.deepEqual(vendorManifest(), [
    'build-state.mjs',
    'lib/roadmap-contract.mjs',
    'lib/session-journal.mjs',
    'lib/work-branch.mjs',
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
    const manifest = vendorManifest({ entry: bundle.entry });
    assert.deepEqual(vendorDrift({ manifest, vendorDir: bundle.vendorDir }), { stale: [], extra: [] }, bundle.name);
  }
});

test('the groom kickoff bundle is the epic kickoff builder and nothing else (board-sinks-and-scrumban D17)', () => {
  const groom = BUNDLES.find((b) => b.entry === 'lib/epic-kickoff.mjs');
  assert.ok(groom, 'a bundle for lib/epic-kickoff.mjs');
  assert.match(groom.vendorDir, /plugins\/golden-frijoles\/skills\/groom\/vendor$/);
  assert.deepEqual(vendorManifest({ entry: groom.entry }), ['lib/epic-kickoff.mjs']);
});
