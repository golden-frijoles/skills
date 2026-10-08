// Tests for check-skill-scripts.mjs — the pure halves only (frontmatter parsing + resolution).
// Filesystem access is injected via `exists`, so these run anywhere with no fixtures on disk.
//
// Run: node --test scripts/check-skill-scripts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  audit,
  importClosure,
  parseRequiresScripts,
  resolveSkill,
  NO_SCRIPTS_EXPECTED,
  KNOWN_ABSENT,
} from './check-skill-scripts.mjs';

const fm = (body) => `---\nname: x\n${body}\n---\n\n# Heading\n`;

test('parses a plain block sequence', () => {
  assert.deepEqual(parseRequiresScripts(fm('requires_scripts:\n  - a.mjs\n  - lib/b.mjs')), [
    'a.mjs',
    'lib/b.mjs',
  ]);
});

test('skips comment lines inside the block', () => {
  const src = fm('requires_scripts:\n  # why these\n  - a.mjs\n  # another note\n  - b.mjs');
  assert.deepEqual(parseRequiresScripts(src), ['a.mjs', 'b.mjs']);
});

test('stops at the next frontmatter key rather than swallowing it', () => {
  const src = fm('requires_scripts:\n  - a.mjs\nallowed-tools: Bash\nother: 1');
  assert.deepEqual(parseRequiresScripts(src), ['a.mjs']);
});

test('a multi-line folded description before the key does not confuse it', () => {
  const src = fm('description: >\n  wraps scripts/decoy.mjs in prose\nrequires_scripts:\n  - real.mjs');
  assert.deepEqual(parseRequiresScripts(src), ['real.mjs']);
});

// The distinction the whole guard rests on: "declared none" vs "never declared".
test('returns null — not [] — when the key is absent', () => {
  assert.equal(parseRequiresScripts(fm('description: hi')), null);
});

test('returns null when there is no frontmatter at all', () => {
  assert.equal(parseRequiresScripts('# Just a heading\n'), null);
});

test('returns null when frontmatter is never closed', () => {
  assert.equal(parseRequiresScripts('---\nrequires_scripts:\n  - a.mjs\n'), null);
});

// ── resolution ────────────────────────────────────────────────────────────────────────────────

const resolve = (declared, have = []) =>
  resolveSkill({
    skill: 's',
    declared,
    scriptsDir: '/p/scripts',
    exists: (p) => have.includes(p.replace('/p/scripts/', '')),
  });

test('ok when every declared script is present', () => {
  const r = resolve(['a.mjs', 'lib/b.mjs'], ['a.mjs', 'lib/b.mjs']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.missing, []);
});

test('missing lists only the absent ones, and keeps the present ones', () => {
  const r = resolve(['a.mjs', 'b.mjs', 'c.mjs'], ['b.mjs']);
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.missing, ['a.mjs', 'c.mjs']);
  assert.deepEqual(r.present, ['b.mjs']);
});

test('a nested lib/ path is checked as a path, not by basename', () => {
  // A basename-only check would call this satisfied by a top-level log-branch.mjs.
  const r = resolve(['lib/log-branch.mjs'], ['log-branch.mjs']);
  assert.equal(r.status, 'missing');
});

// This is the regression the guard exists for: prose-only skills looked exactly like
// "no dependencies" to any checker, and eight broken skills rode that ambiguity.
test('an undeclared skill FAILS rather than passing silently', () => {
  const r = resolve(null);
  assert.equal(r.status, 'undeclared');
  assert.match(r.note, /requires_scripts/);
});

test('declaring an empty list is a pass — that is an explicit answer', () => {
  assert.equal(resolve([]).status, 'ok');
});

// ── the debt ledger ───────────────────────────────────────────────────────────────────────────

// The ledger is EMPTY today (the debt was paid in plugin-audit-and-extraction S1), so these fixtures
// inject one rather than borrowing a real entry — the rules must stay enforced with nothing recorded.
const LEDGER = { 'recorded-skill': 'fixture — a reasoned gap, recorded so CI is not permanently red' };
const resolveNamed = (skill, declared, have = []) =>
  resolveSkill({
    skill,
    declared,
    scriptsDir: '/p/scripts',
    exists: (p) => have.includes(p.replace('/p/scripts/', '')),
    ledger: LEDGER,
  });

test('a recorded gap reports as debt, not failure — CI must not be permanently red', () => {
  const r = resolveNamed('recorded-skill', ['nope.mjs']);
  assert.equal(r.status, 'debt');
});

test('a NEW missing script on an unrecorded skill still fails', () => {
  const r = resolveNamed('brand-new-skill', ['nope.mjs']);
  assert.equal(r.status, 'missing');
});

test('a recorded gap that has been closed fails as a stale ledger entry', () => {
  // Paying the debt without striking the line leaves the ledger describing a repo that no longer
  // exists — which is how an ALLOW/KNOWN list stops being worth reading.
  const r = resolveNamed('recorded-skill', ['a.mjs'], ['a.mjs']);
  assert.equal(r.status, 'stale-debt');
  assert.match(r.note, /delete the entry/);
});

// Smoke-walkthrough step 4, as a test: the four skills this epic paid for are really present in the
// template, so re-adding ANY of them to the ledger fails. That is what separates "the debt was paid"
// from "the line was deleted".
test('the PAID debts: re-adding report (was weekly-recap / standup-post / pmo-report) / live-smoke to the ledger fails as stale', () => {
  const template = new URL('../template/', import.meta.url).pathname;
  const skillsDir = new URL('../plugins/golden-frijoles/skills/', import.meta.url).pathname;
  // plugin-1-0 S3.2: the three report skills are one, `report`, whose requires_scripts is their union.
  for (const skill of ['report', 'live-smoke']) {
    const declared = parseRequiresScripts(readFileSync(join(skillsDir, skill, 'SKILL.md'), 'utf8'));
    const r = resolveSkill({
      skill,
      declared,
      scriptsDir: join(template, 'scripts'),
      exists: existsSync,
      read: readFileSync,
      ledger: { [skill]: 'fixture — pretending the debt is still open' },
    });
    assert.equal(r.status, 'stale-debt', `${skill} would not be flagged stale — is it really paid?`);
  }
});

test('the real ledger is empty and the whole plugin audits clean against template/', () => {
  assert.deepEqual(KNOWN_ABSENT, {});
  const results = audit({ target: new URL('../template/', import.meta.url).pathname });
  // `exempt` passes, as it does in the guard itself, but only for the skills NO_SCRIPTS_EXPECTED names with a reason
  // (think-skills D1 added the first three) — never as a way for any other skill to go quiet.
  const bad = results.filter((r) => r.status !== 'ok' && !(r.status === 'exempt' && Object.hasOwn(NO_SCRIPTS_EXPECTED, r.skill)));
  assert.deepEqual(bad, [], `not ok: ${JSON.stringify(bad)}`);
  assert.deepEqual(
    results.filter((r) => r.status === 'exempt').map((r) => r.skill).sort(),
    Object.keys(NO_SCRIPTS_EXPECTED).sort()
  );
});

// ── the closure check ─────────────────────────────────────────────────────────────────────────

const FILES = {
  'entry.mjs': "import { a } from './lib/a.mjs';\nimport x from 'node:fs';\n",
  'lib/a.mjs': "export { b } from './b.mjs';\nconst lazy = () => import('./c.mjs');\n",
  'lib/b.mjs': 'export const b = 1;\n',
  'lib/c.mjs': 'export const c = 1;\n',
};
const fsOf = (files) => ({
  scriptsDir: '/p/scripts',
  exists: (p) => Object.hasOwn(files, p.replace('/p/scripts/', '')),
  read: (p) => {
    const rel = p.replace('/p/scripts/', '');
    if (!Object.hasOwn(files, rel)) throw new Error('ENOENT');
    return files[rel];
  },
});

test('importClosure follows static, re-export and dynamic relative imports, and ignores bare specifiers', () => {
  const c = importClosure('entry.mjs', fsOf(FILES));
  assert.deepEqual(c.files, ['lib/a.mjs', 'lib/b.mjs', 'lib/c.mjs']);
  assert.deepEqual(c.broken, []);
});

test('a declaration that understates the closure FAILS — the old ledger undercounted exactly this way', () => {
  const r = resolveSkill({ skill: 's', declared: ['entry.mjs', 'lib/a.mjs'], ...fsOf(FILES) });
  assert.equal(r.status, 'undeclared-dependency');
  assert.match(r.note, /lib\/b\.mjs, lib\/c\.mjs/);
});

test('a present entry whose import is absent FAILS as a broken closure (a partial port is dark)', () => {
  const files = { ...FILES };
  delete files['lib/c.mjs'];
  const r = resolveSkill({ skill: 's', declared: ['entry.mjs', 'lib/a.mjs', 'lib/b.mjs'], ...fsOf(files) });
  assert.equal(r.status, 'broken-import');
  assert.match(r.note, /lib\/a\.mjs → lib\/c\.mjs/);
});

test('an import that climbs out of scripts/ is broken — a skill\'s scripts must be self-contained', () => {
  const r = resolveSkill({
    skill: 's',
    declared: ['entry.mjs'],
    ...fsOf({ 'entry.mjs': "import '../app/thing.mjs';\n" }),
  });
  assert.equal(r.status, 'broken-import');
});

test('the full closure declared (data files alongside) is ok', () => {
  const r = resolveSkill({
    skill: 's',
    declared: ['entry.mjs', 'lib/a.mjs', 'lib/b.mjs', 'lib/c.mjs'],
    ...fsOf({ ...FILES, 'prompt.md': 'x' }),
  });
  assert.equal(r.status, 'ok');
});

test('every KNOWN_ABSENT entry carries a reason a reviewer can act on', () => {
  for (const [skill, reason] of Object.entries(KNOWN_ABSENT)) {
    assert.equal(typeof reason, 'string', `${skill} needs a reason`);
    assert.ok(reason.length > 20, `${skill}'s reason is too thin to review: ${reason}`);
  }
});

test('the ledger only names skills that actually exist in the plugin', () => {
  // A ledger entry for a deleted skill is dead weight that reads as real debt forever.
  const skillsDir = new URL('../plugins/golden-frijoles/skills/', import.meta.url).pathname;
  for (const skill of Object.keys(KNOWN_ABSENT)) {
    assert.ok(
      existsSync(join(skillsDir, skill, 'SKILL.md')),
      `KNOWN_ABSENT names "${skill}", which has no SKILL.md`
    );
  }
});

test('a stale NO_SCRIPTS_EXPECTED entry fails instead of masking a real declaration', () => {
  const r = resolveSkill({
    skill: 'ghost',
    declared: ['a.mjs'],
    scriptsDir: '/p/scripts',
    exists: () => true,
  });
  // 'ghost' is not exempt today, so this asserts the ordinary path...
  assert.equal(r.status, 'ok');
  // ...and the exemption list itself must stay honest about the plugin as it is.
  for (const [skill, reason] of Object.entries(NO_SCRIPTS_EXPECTED)) {
    assert.equal(typeof reason, 'string', `${skill} needs a written reason`);
    assert.ok(reason.length > 10, `${skill}'s exemption reason is too thin to review`);
  }
});

// ── D3: a consuming project may run a skill from the kit (golden-frijoles-plugin S2.4) ──────────────
test('kitFallback: no local copy of any of its scripts means the skill runs wholly from the kit', () => {
  const r = resolveSkill({
    skill: 'vercel-prune',
    declared: ['vercel-prune-previews.mjs'],
    scriptsDir: '/p/scripts',
    exists: () => false,
    kitFallback: true,
  });
  assert.equal(r.status, 'kit');
});

test('kitFallback judges PER SCRIPT: a stale local build-order.mjs with no lib/ fails, whatever the first entry is', () => {
  const files = { '/p/scripts/build-order.mjs': "import './lib/roadmap-status-buckets.mjs';\n" };
  const r = resolveSkill({
    skill: 'refine',
    declared: ['cross-panel.mjs', 'build-order.mjs', 'lib/roadmap-status-buckets.mjs'],
    scriptsDir: '/p/scripts',
    exists: (p) => p in files,
    read: (p) => files[p],
    kitFallback: true,
  });
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.missing, ['lib/roadmap-status-buckets.mjs']);
});

test('kitFallback: a whole local script plus kit-served others is ok, and says which come from the kit', () => {
  const files = { '/p/scripts/build-order.mjs': "import './lib/b.mjs';\n", '/p/scripts/lib/b.mjs': '' };
  const r = resolveSkill({
    skill: 'build-order-sync',
    declared: ['build-order-sync.mjs', 'build-order.mjs', 'lib/b.mjs'],
    scriptsDir: '/p/scripts',
    exists: (p) => p in files,
    read: (p) => files[p],
    kitFallback: true,
  });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.kitRuns, ['build-order-sync.mjs']);
});

test('kitFallback: a PRESENT entry means the project runs its own copy, and its closure must be whole', () => {
  const r = resolveSkill({
    skill: 's',
    declared: ['s.mjs', 'lib/x.mjs'],
    scriptsDir: '/p/scripts',
    exists: (p) => p === '/p/scripts/s.mjs',
    kitFallback: true,
  });
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.missing, ['lib/x.mjs']);
});

test('without kitFallback (the template, the built kit) an absent entry is still a failure', () => {
  const r = resolveSkill({ skill: 's', declared: ['s.mjs'], scriptsDir: '/t/scripts', exists: () => false });
  assert.equal(r.status, 'missing');
});
