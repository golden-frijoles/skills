#!/usr/bin/env node
// pack-skills.mjs — package skills as `.skill` archives so Cowork can install them.
//
// ── Why this exists ────────────────────────────────────────────────────────────────────────────
// A consuming project enables this plugin in its `.claude/settings.json` (`extraKnownMarketplaces`
// + `enabledPlugins`). That is CLAUDE CODE's mechanism, and it works: every Claude Code session in
// that repo loads the plugin. **Cowork does not read it.** Cowork loads its own installed-plugin
// set from the desktop app, so a project can have `golden-frijoles` enabled for years and Cowork will
// never see it.
//
// Which matters most for exactly one skill: `refine` is titled "the planning front door (Cowork)"
// and states the role split "Cowork plans, Claude Code builds." The one skill written FOR Cowork
// was the one Cowork could not load.
//
// Cowork installs a skill from a `.skill` file — a zip of a skill directory containing SKILL.md,
// which renders in chat with a "Save skill" button. This script produces those, deterministically,
// for every skill in the plugin.
//
// ── Why a hand-rolled zip writer ───────────────────────────────────────────────────────────────
// This repo ships with no package.json, no lockfile and no install step by design, and shelling out
// to `zip(1)` would add a system-binary dependency whose absence fails at the worst moment. A
// STORE-only (uncompressed) zip is a small, fully-specified format and skill directories are a few
// KB of text, so compression buys nothing worth a dependency.
//
// Archives are byte-for-byte reproducible: entries are sorted and every timestamp is pinned to the
// DOS epoch. Re-running produces an identical file, so `.skill` output is diffable and a rebuild
// with no source change is a no-op rather than noise.
//
// ── Usage ──────────────────────────────────────────────────────────────────────────────────────
//   node scripts/pack-skills.mjs                     # all skills -> dist/
//   node scripts/pack-skills.mjs --skill refine       # just one
//   node scripts/pack-skills.mjs --out /tmp/skills   # somewhere else
//
// Zero deps — Node 18+.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const SKILLS_DIR = join(repoRoot, 'plugins', 'golden-frijoles', 'skills');

// ── CRC32 ──────────────────────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ── store-only ZIP ─────────────────────────────────────────────────────────────────────────────
// Timestamps pinned to the DOS epoch (1980-01-01 00:00) so output is reproducible. Cowork reads
// the entries, not their mtimes.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/**
 * @param {{name: string, data: Buffer}[]} entries — `name` uses forward slashes, per the spec.
 * @returns {Buffer}
 */
export function zipStore(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of sorted) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    // `>>> 0` is load-bearing: `<<` yields a SIGNED int32, and 0o100644 << 16 overflows to a
    // negative number that writeUInt32LE rejects outright.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: regular file, 0644
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** Every file under `dir`, recursively, as archive-relative POSIX paths under `prefix`. */
export function collect(dir, prefix, { readFile = readFileSync } = {}) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      if (entry === '.DS_Store') continue; // macOS noise; never part of a skill
      const abs = join(current, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else {
        const rel = relative(dir, abs).split(sep).join('/');
        out.push({ name: `${prefix}/${rel}`, data: readFile(abs) });
      }
    }
  };
  walk(dir);
  return out;
}

function main(argv) {
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx !== -1 ? argv[outIdx + 1] : join(repoRoot, 'dist');
  const skillIdx = argv.indexOf('--skill');
  const only = skillIdx !== -1 ? argv[skillIdx + 1] : null;

  if (skillIdx !== -1 && !only) {
    console.error('pack-skills: --skill needs a name');
    return 2;
  }

  const names = readdirSync(SKILLS_DIR)
    .filter((n) => statSync(join(SKILLS_DIR, n)).isDirectory())
    .filter((n) => existsSync(join(SKILLS_DIR, n, 'SKILL.md')))
    .filter((n) => !only || n === only)
    .sort();

  if (!names.length) {
    console.error(only ? `pack-skills: no skill named "${only}"` : 'pack-skills: no skills found');
    return 2;
  }

  mkdirSync(outDir, { recursive: true });

  for (const name of names) {
    const entries = collect(join(SKILLS_DIR, name), name);
    // The install path keys off SKILL.md at the archive's skill-directory root. Assert it rather
    // than trusting the walk — a `.skill` that installs as an empty skill is worse than a failure.
    if (!entries.some((e) => e.name === `${name}/SKILL.md`)) {
      console.error(`pack-skills: ${name} produced no ${name}/SKILL.md — refusing to write it`);
      return 1;
    }
    const target = join(outDir, `${name}.skill`);
    writeFileSync(target, zipStore(entries));
    const bytes = statSync(target).size;
    console.log(`  ${name}.skill  ${entries.length} file(s), ${(bytes / 1024).toFixed(1)} KiB`);
  }

  console.log(
    `\n${names.length} archive(s) in ${relative(repoRoot, outDir) || outDir}/.` +
    '\n\nTo install in Cowork: present the .skill file in chat and click "Save skill".' +
    '\nClaude Code does NOT need this — it loads the plugin from the marketplace entry in the' +
    "\nproject's .claude/settings.json."
  );
  return 0;
}

const isMain = process.argv[1] && process.argv[1].endsWith('pack-skills.mjs');
if (isMain) process.exitCode = main(process.argv.slice(2));
