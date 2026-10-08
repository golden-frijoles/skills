// Tests for pack-skills.mjs — the zip writer's pure halves.
//
// The archive is also validated end-to-end by CI, which unpacks one with a REAL `unzip` rather
// than trusting a reader we wrote ourselves. These cover the parts a round-trip can't localise.
//
// Run: node --test scripts/pack-skills.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, zipStore, collect } from './pack-skills.mjs';

const u32 = (buf, off) => buf.readUInt32LE(off);

test('crc32 matches the standard check vector', () => {
  // The universally published CRC-32/ISO-HDLC check value for "123456789".
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('crc32 of empty input is 0', () => {
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('crc32 is unsigned — never a negative int32', () => {
  // A signed result is the classic JS bit-shift bug; it would be written into the header as-is.
  for (const s of ['', 'a', 'skill', 'ÿþ', 'x'.repeat(1000)]) {
    const c = crc32(Buffer.from(s, 'utf8'));
    assert.ok(c >= 0 && c <= 0xffffffff, `${JSON.stringify(s.slice(0, 8))} -> ${c}`);
  }
});

test('writes the local, central and EOCD signatures', () => {
  const zip = zipStore([{ name: 'a/SKILL.md', data: Buffer.from('hi') }]);
  assert.equal(u32(zip, 0), 0x04034b50); // local file header
  assert.equal(u32(zip, zip.length - 22), 0x06054b50); // end of central directory
  assert.ok(zip.includes(Buffer.from([0x50, 0x4b, 0x01, 0x02])), 'central directory header');
});

test('EOCD entry count matches the number of files', () => {
  const zip = zipStore([
    { name: 'a/one.md', data: Buffer.from('1') },
    { name: 'a/two.md', data: Buffer.from('2') },
    { name: 'a/three.md', data: Buffer.from('3') },
  ]);
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt16LE(eocd + 8), 3);
  assert.equal(zip.readUInt16LE(eocd + 10), 3);
});

test('the central directory offset in the EOCD points at a real central header', () => {
  const zip = zipStore([{ name: 'a/SKILL.md', data: Buffer.from('hello world') }]);
  const cdOffset = u32(zip, zip.length - 22 + 16);
  assert.equal(u32(zip, cdOffset), 0x02014b50);
});

test('external attributes are a valid unsigned value', () => {
  // Regression: `0o100644 << 16` is a NEGATIVE signed int32 and writeUInt32LE throws on it. The
  // whole packer died on its first real run for exactly this.
  const zip = zipStore([{ name: 'a/SKILL.md', data: Buffer.from('x') }]);
  const cdOffset = u32(zip, zip.length - 22 + 16);
  const attrs = u32(zip, cdOffset + 38);
  assert.ok(attrs > 0 && attrs <= 0xffffffff);
  assert.equal(attrs >>> 16, 0o100644);
});

test('store method: compressed size equals uncompressed size', () => {
  const data = Buffer.from('some skill content that is not compressed');
  const zip = zipStore([{ name: 'a/SKILL.md', data }]);
  assert.equal(zip.readUInt16LE(8), 0); // method 0 = store
  assert.equal(u32(zip, 18), data.length);
  assert.equal(u32(zip, 22), data.length);
});

test('entries are sorted, so output does not depend on input order', () => {
  const a = zipStore([
    { name: 'z.md', data: Buffer.from('z') },
    { name: 'a.md', data: Buffer.from('a') },
  ]);
  const b = zipStore([
    { name: 'a.md', data: Buffer.from('a') },
    { name: 'z.md', data: Buffer.from('z') },
  ]);
  assert.deepEqual(a, b);
});

test('the same input twice produces byte-identical archives', () => {
  const make = () => zipStore([{ name: 'a/SKILL.md', data: Buffer.from('reproducible') }]);
  assert.deepEqual(make(), make());
});

test('an empty archive is still structurally valid', () => {
  const zip = zipStore([]);
  assert.equal(zip.length, 22);
  assert.equal(u32(zip, 0), 0x06054b50);
  assert.equal(zip.readUInt16LE(8), 0);
});

test('collect prefixes entries with the skill name and uses forward slashes', () => {
  const names = collect(
    new URL('../plugins/golden-frijoles/skills/refine', import.meta.url).pathname,
    'refine'
  ).map((e) => e.name);
  assert.ok(names.includes('refine/SKILL.md'), 'SKILL.md must sit at the skill-dir root');
  assert.ok(names.includes('refine/templates/scope-seed.md'), 'nested files are included');
  assert.ok(
    names.every((n) => !n.includes('\\')),
    'zip entry names are always POSIX-separated'
  );
});
