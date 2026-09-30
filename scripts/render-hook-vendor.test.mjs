// render-hook-vendor.test.mjs — the build view's bundled resolver stays the template's bytes (distribute-what-we-use D5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vendorDrift, vendorManifest, writeVendor, ENTRY } from './render-hook-vendor.mjs';

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
  assert.deepEqual(vendorManifest(), ['build-state.mjs', 'lib/roadmap-contract.mjs', 'lib/session-journal.mjs']);
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

test('the committed bundle matches template/scripts right now', () => {
  assert.deepEqual(vendorDrift(), { stale: [], extra: [] });
});
