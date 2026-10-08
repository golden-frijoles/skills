#!/usr/bin/env node
// check-skill-scripts.mjs — does a consuming project actually have the scripts its skills wrap?
//
// ── Why this exists ────────────────────────────────────────────────────────────────────────────
// Each skill in plugins/golden-frijoles/skills/ wraps a repo-local `scripts/<name>.mjs` that
// deliberately does NOT ship inside the plugin (plugins are copied to a cache dir on install, so a
// skill cannot reach `../scripts/`). The consuming project supplies it. That contract was written
// down in prose — inside each SKILL.md's `description` and a "Distribution note" paragraph — and
// prose is not checkable, so nothing noticed that EIGHT of the ten skills had no script anywhere:
// not in a consuming project, and not in `template/` either. Every project spawned from this repo
// got eight skills that could never run, and the harness-portability bet swept sixteen files
// without catching it.
//
// The fix is structural, not a re-reading: every skill now DECLARES its dependency in frontmatter
// (`requires_scripts:`), and this script is the one registry-walker that checks them. A new skill
// inherits the check instead of needing someone to remember it. (LEARNINGS: "the fix for a
// predicted-but-unguarded failure is structural — put every instance in ONE registry the checker
// walks".)
//
// ── The closure check (plugin-audit-and-extraction S1) ─────────────────────────────────────────
// Existence of the ENTRY script is not enough: pmo-report declared five files and actually needed
// fifteen. So for every declared .mjs that is present, this walks its relative-import closure inside
// the target's scripts/ and fails on (a) an import that does not exist — a ported script with a hole
// in its closure — and (b) an import the skill does not declare. `requires_scripts:` therefore has to
// match reality, which is the only way a consuming project can audit a skill without reading source.
//
// ── What it does NOT do ────────────────────────────────────────────────────────────────────────
// It checks EXISTENCE, not correctness. A present script that is broken, or wraps a different
// contract than the skill expects, passes here. Data files a script reads by path (prompt bodies,
// templates) are declared by hand — only `import` edges are walked. This is a floor.
//
// ── Usage ──────────────────────────────────────────────────────────────────────────────────────
//   node scripts/check-skill-scripts.mjs                      # audit template/ (the CI gate)
//   node scripts/check-skill-scripts.mjs --repo-root ~/dobby/golden-beans
//   node scripts/check-skill-scripts.mjs --repo-root <path> --json
//   node scripts/check-skill-scripts.mjs --kit                  # the BUILT kit (after scripts/build-kit.mjs)
//
// Exit 0 = no NEW breakage. Exit 1 = a skill is missing a script that isn't recorded debt, a skill
// declares nothing at all, or a recorded gap has quietly been closed without updating the ledger.
//
// A permanently-red check is worse than no check — it trains everyone to scroll past it. So a skill
// with a genuinely known gap can be recorded in KNOWN_ABSENT with a reason and reported as `debt`, not
// failure. The ledger is EMPTY today (see its comment). What always fails: an undeclared skill, a NEW
// missing script, an import-closure hole or understatement, and a stale KNOWN_ABSENT entry. Same
// discipline as check-plugin-leaks.mjs's ALLOW list — the ledger has to keep describing the repo as it is.
//
// Against a CONSUMING project (--repo-root) this reports what that project would need to run every
// advertised skill as the template ships it; a project on an older or forked copy of a rail shows up here
// until it migrates, which is the point.
//
// Zero deps — Node 18+.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, normalize, isAbsolute } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const SKILLS_DIR = join(repoRoot, 'plugins', 'golden-frijoles', 'skills');

// Skills that legitimately wrap nothing repo-local. Each needs a written reason, same discipline as
// check-plugin-leaks.mjs's ALLOW list — an entry with no reason is the thing to catch in review.
// A skill listed here that DOES declare requires_scripts is a stale entry and fails, so the list
// has to keep describing the plugin as it actually is.
export const NO_SCRIPTS_EXPECTED = {
  // Empty since coaches-v2 S2 (0.42.0): the three strategy coaches used to run nothing (think-skills D1); they now run
  // `strategy-private.mjs` before their first write, so they declare it like every other script-wrapping skill.
};

// ── The debt ledger ────────────────────────────────────────────────────────────────────────────
// Skills whose scripts have NEVER shipped anywhere: not in template/, not in any consuming project.
// Discovered 2026-08-06 when the prose contract was made machine-readable. They live in the origin
// project this repo was extracted from; the extraction moved the skills and left the scripts behind.
//
// Listed here so the check is GREEN on today's known state and RED on anything new. Two rules keep
// it honest, both enforced below:
//   • a skill here that becomes satisfied is a STALE entry and fails — pay the debt, delete the line
//   • a skill here that is missing a script NOT listed for it still fails
//
// Removing a line without supplying the script does not make the problem go away; it makes it
// invisible, which is the exact failure this whole guard exists to end.
// Counts below are the TRANSITIVE closure of relative imports, resolved from the origin project's
// scripts/ on 2026-08-06 — not a hand-read of each file's first import block. The previous version
// of this ledger was written that way and undercounted badly: it said pmo-report needed "four
// scripts/lib/ helpers" (actual: 14 files, including weekly-recap.mjs itself) and that standup-post
// needed "lib/log-branch.mjs" (actual: 11). A debt ledger that understates the debt is worse than
// no ledger — it makes the remaining work look like an afternoon and gets scheduled as one.
export const KNOWN_ABSENT = {
  // EMPTY since 2026-09-18 (plugin-audit-and-extraction S1). The debt was PAID, not reworded away:
  //   • weekly-recap (+7), standup-post (+11), pmo-report (+14) — ported into template/scripts/ as one
  //     unit behind one config seam (reporting.config.json, scripts/lib/reporting-config.mjs).
  //   • live-smoke — reclassified "project-local by design" on 2026-09-17, then ported anyway (D3):
  //     template/scripts/live-smoke.mjs + live-smoke.config.json, driving the now-runnable
  //     apps/example-app harness.
  // The guard proves it: a line re-added here for any of them fails as a STALE entry, because every
  // script it names is present. Add a line only for a genuinely new, reasoned gap.
};

/**
 * Pull `requires_scripts:` out of a SKILL.md's YAML frontmatter.
 *
 * Deliberately a small hand-rolled reader rather than a YAML dependency: this repo ships with no
 * package.json and no install step by design (see .github/workflows/ci.yml), and the shape we
 * accept is exactly one block sequence of plain scalars. Anything else should fail loudly here
 * rather than be silently coerced into a wrong answer.
 *
 * Returns null when the file has no frontmatter or no `requires_scripts:` key — distinct from []
 * ("declared, and the answer is none"). The caller treats those two differently on purpose.
 */
export function parseRequiresScripts(source) {
  if (!source.startsWith('---\n')) return null;
  const close = source.indexOf('\n---\n', 3);
  if (close === -1) return null;
  const frontmatter = source.slice(4, close + 1);

  const lines = frontmatter.split('\n');
  const start = lines.findIndex((l) => /^requires_scripts:\s*$/.test(l));
  if (start === -1) return null;

  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (!item) break; // dedent — the block ended, and the next key begins
    out.push(item[1]);
  }
  return out;
}

/** Every skill directory that has a SKILL.md, sorted for stable output. */
export function listSkills(skillsDir = SKILLS_DIR) {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter((name) => {
      const p = join(skillsDir, name);
      return statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md'));
    })
    .sort();
}

/**
 * Resolve one skill's declaration against a target project's scripts/ dir.
 *
 * `declared === null` (no frontmatter key) is an ERROR, not a pass. That is the whole point: the
 * prose-only era looked exactly like "no dependencies" to any checker, and eight broken skills rode
 * that ambiguity. An intentional no-dependency skill says so in NO_SCRIPTS_EXPECTED.
 */
export function resolveSkill({
  skill,
  declared,
  scriptsDir,
  exists,
  read = null,
  ledger = KNOWN_ABSENT,
  exemptions = NO_SCRIPTS_EXPECTED,
  kitFallback = false,
}) {
  const exempt = Object.prototype.hasOwnProperty.call(exemptions, skill);

  if (declared === null) {
    return exempt
      ? { skill, status: 'exempt', missing: [], present: [] }
      : {
          skill,
          status: 'undeclared',
          missing: [],
          present: [],
          note: 'no requires_scripts: in frontmatter — declare it, or add a reasoned '
              + 'NO_SCRIPTS_EXPECTED entry',
        };
  }

  if (exempt) {
    return {
      skill,
      status: 'stale-exemption',
      missing: [],
      present: [],
      note: `listed in NO_SCRIPTS_EXPECTED but declares ${declared.length} script(s) — remove the entry`,
    };
  }

  // D3 (golden-frijoles-plugin): in a consuming project the run rule decides PER SCRIPT — a top-level
  // `scripts/<x>.mjs` that exists locally runs locally, one that doesn't runs from the self-contained kit. So
  // judge each invocable script the same way (fresh review of #45: keying off the first declared .mjs passed a
  // repo whose stale local build-order.mjs then crashed). A local one needs its whole import closure here; an
  // absent one needs nothing. Declared data files are required only while something of the skill runs locally.
  if (kitFallback) {
    const invocable = declared.filter((rel) => rel.endsWith('.mjs') && !rel.includes('/'));
    const local = invocable.filter((rel) => exists(join(scriptsDir, rel)));
    if (!local.length) return { skill, status: 'kit', missing: [], present: [], kitRuns: invocable };
    const needed = new Set(local);
    for (const rel of local) {
      if (!read) continue;
      const c = importClosure(rel, { scriptsDir, read, exists });
      for (const f of c.files) needed.add(f);
      for (const b of c.broken) needed.add(b.to); // an import that isn't there is exactly what's missing
    }
    // With no reader to walk imports, be conservative: every declared non-invocable file is needed locally.
    for (const rel of declared) if (!rel.endsWith('.mjs') || (!read && rel.includes('/'))) needed.add(rel);
    const missingLocal = [...needed].filter((rel) => !exists(join(scriptsDir, rel))).sort();
    const kitRuns = invocable.filter((rel) => !local.includes(rel));
    if (missingLocal.length) {
      return {
        skill,
        status: 'missing',
        missing: missingLocal,
        present: local,
        note: `runs ${local.join(', ')} locally, but its closure is incomplete`,
      };
    }
    return { skill, status: 'ok', missing: [], present: local, kitRuns };
  }

  const missing = declared.filter((rel) => !exists(join(scriptsDir, rel)));
  const present = declared.filter((rel) => exists(join(scriptsDir, rel)));
  const recorded = Object.prototype.hasOwnProperty.call(ledger, skill);

  if (!missing.length) {
    // A recorded gap that is now satisfied must be struck from the ledger, or the ledger starts
    // describing a repo that no longer exists and stops being worth reading.
    return recorded
      ? {
          skill,
          status: 'stale-debt',
          missing: [],
          present,
          note: 'listed in KNOWN_ABSENT but every script is present now — delete the entry',
        }
      : closureStatus({ skill, declared, present, scriptsDir, exists, read });
  }

  return { skill, status: recorded ? 'debt' : 'missing', missing, present };
}

// Static and dynamic RELATIVE imports only — bare specifiers (node:*, packages) are not ours to supply.
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * Pure (given `read`/`exists`) — the relative-import closure of one script, as paths relative to
 * scriptsDir. `broken` lists edges whose target does not exist. An import that climbs out of scripts/
 * is reported as broken too: a skill's scripts must be self-contained in the consuming project.
 */
export function importClosure(entry, { scriptsDir, read, exists }) {
  const files = new Set();
  const broken = [];
  const stack = [entry];
  while (stack.length) {
    const rel = stack.pop();
    if (files.has(rel)) continue;
    files.add(rel);
    let src;
    try {
      src = read(join(scriptsDir, rel), 'utf8');
    } catch {
      continue; // absence of the entry itself is reported by the caller as `missing`
    }
    for (const m of src.matchAll(IMPORT_RE)) {
      const target = normalize(join(dirname(rel), m[1]));
      if (target.startsWith('..') || isAbsolute(target)) {
        broken.push({ from: rel, to: m[1] });
        continue;
      }
      if (!exists(join(scriptsDir, target))) {
        broken.push({ from: rel, to: target });
        continue;
      }
      stack.push(target);
    }
  }
  files.delete(entry);
  return { files: [...files].sort(), broken };
}

function closureStatus({ skill, declared, present, scriptsDir, exists, read }) {
  if (!read) return { skill, status: 'ok', missing: [], present };
  const declaredSet = new Set(declared);
  const broken = [];
  const undeclared = new Set();
  for (const rel of declared.filter((d) => d.endsWith('.mjs'))) {
    const c = importClosure(rel, { scriptsDir, read, exists });
    broken.push(...c.broken);
    for (const f of c.files) if (!declaredSet.has(f)) undeclared.add(f);
  }
  if (broken.length) {
    return {
      skill,
      status: 'broken-import',
      missing: [],
      present,
      note: `a declared script imports something absent: ${broken.map((b) => `${b.from} → ${b.to}`).join(', ')}`,
    };
  }
  if (undeclared.size) {
    return {
      skill,
      status: 'undeclared-dependency',
      missing: [],
      present,
      note: `imported but not in requires_scripts: ${[...undeclared].sort().join(', ')}`,
    };
  }
  return { skill, status: 'ok', missing: [], present };
}

export function audit({
  target,
  scriptsDir = join(target, 'scripts'),
  skillsDir = SKILLS_DIR,
  exists = existsSync,
  read = readFileSync,
  kitFallback = false,
} = {}) {
  return listSkills(skillsDir).map((skill) =>
    resolveSkill({
      skill,
      declared: parseRequiresScripts(readFileSync(join(skillsDir, skill, 'SKILL.md'), 'utf8')),
      scriptsDir,
      exists,
      read,
      kitFallback,
    })
  );
}

function main(argv) {
  const rootIdx = argv.indexOf('--repo-root');
  // --kit: audit the BUILT package (kit/dist/ is laid out like a project's scripts/). Run after build-kit.mjs.
  const kit = argv.includes('--kit');
  const target = kit ? join(repoRoot, 'kit') : rootIdx !== -1 ? argv[rootIdx + 1] : join(repoRoot, 'template');
  const scriptsDir = kit ? join(target, 'dist') : join(target, 'scripts');
  const asJson = argv.includes('--json');

  if (rootIdx !== -1 && !target) {
    console.error('check-skill-scripts: --repo-root needs a path');
    return 2;
  }
  if (!existsSync(target)) {
    console.error(`check-skill-scripts: no such directory: ${target}`);
    return 2;
  }

  // Only a CONSUMING project can fall back to the kit; the template and the built kit must be whole.
  const results = audit({ target, scriptsDir, kitFallback: rootIdx !== -1 && !kit });
  const PASSING = new Set(['ok', 'exempt', 'debt', 'kit']);
  const bad = results.filter((r) => !PASSING.has(r.status));
  const debt = results.filter((r) => r.status === 'debt');

  if (asJson) {
    process.stdout.write(JSON.stringify({ target, results, ok: bad.length === 0 }, null, 2) + '\n');
    return bad.length ? 1 : 0;
  }

  const label = relative(repoRoot, target) || target;
  console.log(`check-skill-scripts: ${results.length} skill(s) against ${relative(repoRoot, scriptsDir) || scriptsDir}/\n`);

  for (const r of results) {
    if (r.status === 'ok') {
      const viaKit = r.kitRuns?.length ? ` (from the kit: ${r.kitRuns.join(', ')})` : '';
      console.log(`  ok        ${r.skill} — ${r.present.length} script(s) present${viaKit}`);
    } else if (r.status === 'kit') {
      console.log(`  kit       ${r.skill} — no local copy of ${r.kitRuns.join(', ')}, so it runs from @golden-frijoles/kit`);
    } else if (r.status === 'exempt') {
      console.log(`  exempt    ${r.skill} — ${NO_SCRIPTS_EXPECTED[r.skill]}`);
    } else if (r.status === 'debt') {
      console.log(`  debt      ${r.skill} — ${r.missing.join(', ')} (${KNOWN_ABSENT[r.skill]})`);
    } else if (r.status === 'missing') {
      console.log(`  MISSING   ${r.skill} — ${r.missing.join(', ')}`);
    } else {
      console.log(`  ${r.status.toUpperCase().padEnd(9)} ${r.skill} — ${r.note}`);
    }
  }

  if (!bad.length) {
    if (debt.length) {
      console.log(
        `\n✓ no new breakage — but ${debt.length} skill(s) still cannot run here.` +
        '\n  Each is recorded in KNOWN_ABSENT with a reason. They are DARK, not working:' +
        '\n  a skill whose script is absent must say so and STOP, never reimplement it inline.'
      );
    } else if (results.some((r) => r.status === 'kit' || r.kitRuns?.length)) {
      // Not "every declared script is present" — some aren't, by design (fresh review of #45).
      console.log('\n✓ no breakage: every script is either whole locally or served by @golden-frijoles/kit.');
    } else {
      console.log('\n✓ every declared script is present.');
    }
    return 0;
  }

  // Report each failure class in its own words — "8 skills broken" is misleading when the real
  // finding is "8 debts were paid and nobody updated the ledger", and a wrong summary is how a
  // reader stops trusting the tool.
  const byStatus = (s) => bad.filter((r) => r.status === s);
  const lines = [`\n✗ ${bad.length} skill(s) need attention against ${label}.`];

  const newlyMissing = byStatus('missing');
  if (newlyMissing.length) {
    const scripts = [...new Set(newlyMissing.flatMap((r) => r.missing))].sort();
    lines.push(
      `\n  ${newlyMissing.length} NEWLY BROKEN — absent and not recorded debt: ${scripts.join(', ')}`,
      '  A skill whose script is absent must say so and STOP — never reimplement its logic inline.',
      '  Supply the script (template/scripts/ covers every future project), or correct the skill\'s',
      '  requires_scripts: if the declaration is wrong. Do NOT silence this with a KNOWN_ABSENT entry.'
    );
  }
  const stale = [...byStatus('stale-debt'), ...byStatus('stale-exemption')];
  if (stale.length) {
    lines.push(
      `\n  ${stale.length} STALE LEDGER ENTR${stale.length === 1 ? 'Y' : 'IES'} — the debt was paid:`,
      `  ${stale.map((r) => r.skill).join(', ')}`,
      '  Delete them from KNOWN_ABSENT / NO_SCRIPTS_EXPECTED so the ledger keeps describing reality.'
    );
  }
  const brokenImports = byStatus('broken-import');
  if (brokenImports.length) {
    lines.push(
      `\n  ${brokenImports.length} BROKEN CLOSURE — a present script imports a file that is not there:`,
      ...brokenImports.map((r) => `  ${r.skill}: ${r.note}`),
      '  The entry script exists but cannot load. Port the missing file with it — a partial port is dark.'
    );
  }
  const undeclaredDeps = byStatus('undeclared-dependency');
  if (undeclaredDeps.length) {
    lines.push(
      `\n  ${undeclaredDeps.length} UNDERSTATED DECLARATION${undeclaredDeps.length === 1 ? '' : 'S'} — requires_scripts: omits an import:`,
      ...undeclaredDeps.map((r) => `  ${r.skill}: ${r.note}`),
      '  Add them. A declaration that understates the closure is how the old ledger said "four helpers"',
      '  for a skill that needed fourteen files.'
    );
  }
  const undeclared = byStatus('undeclared');
  if (undeclared.length) {
    lines.push(
      `\n  ${undeclared.length} UNDECLARED — no requires_scripts: in frontmatter:`,
      `  ${undeclared.map((r) => r.skill).join(', ')}`,
      '  Silence is what let eight broken skills ship. Declare the dependency, even if it is empty.'
    );
  }
  console.error(lines.join('\n'));
  return 1;
}

const isMain = process.argv[1] && process.argv[1].endsWith('check-skill-scripts.mjs');
if (isMain) process.exitCode = main(process.argv.slice(2));
