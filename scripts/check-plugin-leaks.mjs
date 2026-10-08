#!/usr/bin/env node
// check-plugin-leaks.mjs — the grep-to-zero guard against origin-project residue.
//
// This repo is a PORTABLE plugin + template. It was extracted from one project (`medusa-bonsai`) and
// spent months quietly carrying that project's app paths, repo names, auth provider, chat bot, Vercel
// project and the product owner's personal name. A consuming project had to read around someone else's
// project to use its own tooling. The harness-portability bet (#7) cleared 16 files of it.
//
// Residue comes back one careless sentence at a time — usually written by someone (or some agent)
// working in the origin project, where naming it feels natural. This guard makes that a red CI check
// instead of a discovery six months later.
//
// It is deliberately DUMB — a line-level regex sweep. It cannot tell a leak from provenance, so the
// judgment lives in ALLOW below: every deliberate match is listed with its reason. Adding to ALLOW is
// a normal, reviewable act; doing it without a reason is the thing to catch in review.
//
// Zero deps — Node 18+. Run: `node scripts/check-plugin-leaks.mjs`
//
// NOTE: this script and its CI workflow are NOT scanned (they necessarily contain the patterns). Same
// carve-out golden-beans' check-template-drift.mjs makes for its own header.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, extname, basename, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// Everything a consuming project actually receives: the plugin, the spawn template, the marketplace
// manifest, and the front-door README. `scripts/` is excluded — it is this repo's own tooling, not
// shipped, and this file lives there. LICENSE + NOTICE ship too (S1.1): a stray project name in either
// is the same residue as anywhere else.
const SCAN_ROOTS = ['plugins', 'template', '.claude-plugin', 'kit'];
const SCAN_FILES = ['README.md', 'LICENSE', 'NOTICE'];

// Text formats this repo actually ships. Anything else (an image, a lockfile) is skipped rather than
// guessed at — every shipped file here is one of these today, and a new format is a deliberate add.
const TEXT_EXT = new Set([
  '.md', '.json', '.mjs', '.js', '.ts', '.tsx', '.yml', '.yaml', '.sh', '.txt', '.example', '.gitkeep',
]);
// Extensionless files this repo ships (git hooks).
const TEXT_NAMES = new Set(['pre-commit', 'pre-push', 'pre-push.example', 'post-merge', 'post-checkout']);

export const RULES = [
  {
    name: 'origin-project residue',
    pattern: /miyagi|medusa|despacho|honest-eel|smalldocs/i,
    why: 'Names the project this plugin was extracted from. A consuming project cannot act on it — '
       + 'state the SHAPE it needs (a repo list, an auth provider, a chat destination) as a named '
       + 'TEMPLATE FILL-IN instead, and keep the concrete values in that project\'s own docs.',
  },
  {
    name: 'personal name',
    pattern: /\bDaniel\b/,
    why: 'Role names survive a change of person; personal names do not. Use "the product owner". '
       + '(The author fields in plugin.json / marketplace.json are the exception — see ALLOW.)',
  },
  {
    name: 'decommissioned flag tooling',
    pattern: /flagsmith|edge config/i,
    why: 'Both are decommissioned. A template that names dead tooling is worse than one that names '
       + 'none: it sends a fresh agent to build against something that no longer exists. Point at '
       + 'Golden Frijoles \u2014 the flag provider this template ships wired \u2014 and at '
       + 'references/flags-runtime.md for how it is placed.',
  },
  {
    // golden-flags-by-default S1.3. The leak that produced that epic lived in this very repo for
    // months and NO rule here caught it: the groom skill told every consuming project to extend
    // `lib/flags.ts` `DEFAULT_FLAGS` \u2014 one consumer's in-house table, hardcoded into the
    // supposedly project-agnostic planning skill. The filename is generic, so the origin-project
    // rule above could never have seen it. A mechanism does not have to be named after a project
    // to be that project's.
    //
    // `flagsmith` is deliberately NOT repeated here: the decommissioned-tooling rule above already
    // fails on it, and listing it twice would report one line as two leaks.
    name: 'project-specific flag mechanism',
    pattern: /\blib\/flags\.(ts|tsx|js|mjs|cjs)\b|DEFAULT_FLAGS|platform_flags/,
    why: 'Names a flag store that is not the one this template ships. Feature flags are Golden '
       + 'Frijoles for every project spawned from here (template/AGENTS.md rule 1): flags are '
       + 'created with `frijoles flags create`, read through the seam in apps/*/flags.mjs, and a read\'s '
       + 'fallback argument is NOT a parallel store. If you need to name a flag, name its KEY '
       + '(`<domain>.<feature>_enabled`), never a file or a table that holds defaults.',
  },
  {
    // golden-frijoles-plugin S1.3 (D6). The marketplace, the plugin dir and the repo were all renamed
    // to golden-frijoles/golden-frijoles/golden-frijoles-skills. The rename touches IDENTIFIERS ONLY
    // (D6): it does not touch `ways-of-work-lean-pass` provenance, `render-ways-of-working`, or
    // Roadmap/ history — so this rule is deliberately narrow (the retired MARKETPLACE/PLUGIN identity),
    // not a bare `ways-of-work` sweep, which would also fire on the process name and a past epic's slug.
    // compiled-prompts S1.4 (E5). `optimize/` at the monorepo root is dev-only Python (DSPy); a plugin user
    // must never need Python. The PATH half lives in `scanPaths` below — a stray `.py` is not a text file this
    // sweep reads. This half catches shipped CODE reaching for it; prose that merely names optimize/ is fine.
    name: 'python or optimize/ reached a shipped script',
    // Every way a module reaches a file (import, require, new URL(…, import.meta.url)) and every way a script
    // starts an interpreter by name or by path. A string held in a variable first is still out of reach of a
    // line sweep — the PATH rule and the packed-kit assertion are the backstop for that.
    pattern:
      /\b(?:from|import|require|URL)\s*\(?\s*['"`][^'"`]*\boptimize\/|\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|execa)\s*\(\s*['"`](?:[^'"`]*\/)?(?:python[\d.]*|pip\d*|uv|uvx|py|pipx|conda)['"`\s]/,
    why: 'The kit, the plugin and the skills mirror are zero-dependency Node. `optimize/` is the monorepo\'s '
       + 'dev-only Python workspace (compiled-prompts D4): what it produces reaches the kit as a reviewed '
       + 'data diff (a question file, a jev.config.json threshold), never as an import or a python call.',
  },
  {
    name: 'retired plugin identity',
    pattern: /ways-of-work@|@dobby-foundation\b|"dobby-foundation"\s*:|\bways-of-work:[a-z]|plugins\/ways-of-work|`ways-of-work` plugin|dobby-foundation marketplace|danybgoode\/dobby-foundation/,
    why: 'Names the retired marketplace/plugin identity (`ways-of-work@dobby-foundation`, '
       + '`plugins/ways-of-work`, "the `ways-of-work` plugin", "dobby-foundation marketplace", '
       + '`danybgoode/dobby-foundation`). The product is `golden-frijoles`, installed from '
       + '`golden-frijoles/skills` — a shipped file naming the old identity sends a stranger to '
       + 'install line that no longer resolves. `ways-of-work-lean-pass` provenance, '
       + '`render-ways-of-working` and Roadmap/ history are deliberately out of scope (D6).',
  },
];

// Deliberate matches. Each entry is matched on the file plus the EXACT trimmed line text, so a line
// moving is fine and a line being reworded is not — that is on purpose. If you rewrite one of these,
// update the entry; if you delete one, delete the entry (a stale entry fails too, below).
export const ALLOW = [
  // REMOVED 2026-09-23 (golden-frijoles-plugin S3.4). This entry allowed the README's OLD intro
  // ("Portable ways-of-work for the `~/dobby/` sibling-repo workspace…"), written for Daniel, not for
  // a stranger. The S3.4 rewrite replaced the whole intro with the install prompt + a plain
  // description, and that sentence no longer exists anywhere in the file — so the allowance goes too.
  {
    file: 'README.md',
    line: 'Extracted from `medusa-bonsai` (`danybgoode/miyagi-product-management`) as the S0 workstream of the',
    why: 'The `## Origin` section — where-it-came-from IS the content here. Removing it deletes history.',
  },
  // REMOVED 2026-08-06. This entry allowed the README to say the origin project "has them today" as
  // the concrete example behind the wraps-a-repo-local-script gotcha. It was worse than a leak: it
  // was FALSE COMFORT. check-skill-scripts.mjs proved eight of the ten scripts exist in no consuming
  // project and not in template/ either — so the sentence reassured every reader that a dependency
  // was satisfied somewhere while eight skills shipped dark. The README now states the real status
  // and the guard enforces it, so the clause is gone and this allowance with it.
  {
    file: '.claude-plugin/marketplace.json',
    line: '"name": "Daniel"',
    why: 'An author field is supposed to name a person. Excluded by the harness-portability pitch.',
  },
  {
    file: 'plugins/golden-frijoles/.claude-plugin/plugin.json',
    line: '"name": "Daniel"',
    why: 'Same — the plugin manifest author field.',
  },
];

function isText(p) {
  return TEXT_EXT.has(extname(p)) || TEXT_NAMES.has(basename(p));
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // an optional root that does not exist is not a failure
  }
  for (const name of entries) {
    if (name === '.git' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (isText(full)) out.push(full);
  }
  return out;
}

/**
 * The whole decision, as a pure function of the files' text.
 *
 * Extracted so the guard's own rules can be exercised against fixtures (golden-flags-by-default
 * S1.3) instead of only against whatever happens to be in the tree today. A guard whose behaviour
 * is only ever observed as "CI was green" is a guard nobody has seen fire.
 *
 * @param {Array<{rel: string, text: string}>} files
 * @param {{rules?: typeof RULES, allow?: typeof ALLOW}} [options]
 * @returns {{violations: Array, stale: Array}}
 */
export function scan(files, { rules = RULES, allow = ALLOW } = {}) {
  const violations = [];
  const usedAllow = new Set();

  for (const { rel, text } of files) {
    text.split('\n').forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      for (const rule of rules) {
        if (!rule.pattern.test(line)) continue;
        const allowIdx = allow.findIndex((a) => a.file === rel && a.line === line);
        if (allowIdx !== -1) {
          usedAllow.add(allowIdx);
          continue;
        }
        violations.push({ rel, lineNo: i + 1, line, rule });
      }
    });
  }

  return {
    violations,
    stale: allow.map((a, i) => ({ ...a, i })).filter((a) => !usedAllow.has(a.i)),
  };
}

/**
 * A shipped PATH a Python workspace would leave behind (compiled-prompts S1.4): anything under an `optimize/`
 * directory, a `.py`/`.pyc`, or a `requirements*` file. kit-tarball.test.mjs applies the same regex to the packed
 * kit's file list, so it lives here, once.
 */
export const OPTIMIZE_PATH =
  /(^|\/)optimize\/|\.(?:pyc?|pyi|ipynb)$|(^|\/)(?:requirements[^/]*|pyproject\.toml|uv\.lock|Pipfile(?:\.lock)?|setup\.py|\.python-version)$/;

/** Every file under `dir`, text or not — the path rule must see the files the text sweep skips. */
function walkAll(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    // kit/dist is the kit's build output (gitignored, rebuilt by build-kit) — only THAT dist, never any directory so named.
    if (name === '.git' || name === 'node_modules' || relative(repoRoot, full) === join('kit', 'dist')) continue;
    if (statSync(full).isDirectory()) walkAll(full, out);
    else out.push(full);
  }
  return out;
}

/** Pure: the shipped paths that are Python or optimize/ residue. `rels` are repo-relative, `/`-separated. */
export const scanPaths = (rels) => rels.filter((r) => OPTIMIZE_PATH.test(r));

// ── The CLI half ─────────────────────────────────────────────────────────────────────────────
// Guarded, so the test above can import `scan` without the module walking the tree and calling
// process.exit() out from under the test runner.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const targets = [
    ...SCAN_ROOTS.flatMap((r) => walk(join(repoRoot, r))),
    ...SCAN_FILES.map((f) => join(repoRoot, f)),
  ];

  const { violations, stale } = scan(
    targets.flatMap((abs) => {
      try {
        return [{ rel: relative(repoRoot, abs), text: readFileSync(abs, 'utf8') }];
      } catch {
        return [];
      }
    })
  );

  // The path rule sweeps the WHOLE skills tree, not only SCAN_ROOTS: every file here is mirrored to
  // golden-frijoles/skills, and that mirror is exactly what E5 promises carries no Python.
  const pythonPaths = scanPaths(walkAll(repoRoot).map((abs) => relative(repoRoot, abs).split('\\').join('/')));
  if (pythonPaths.length) {
    console.error(`\ncheck-plugin-leaks: ${pythonPaths.length} Python / optimize/ file(s) in what ships.\n`);
    for (const p of pythonPaths) console.error(`    ${p}`);
    console.error('\n  optimize/ is dev-only Python at the monorepo root (compiled-prompts D4); it never ships in the');
    console.error('  plugin, the kit or the template. Move the file out, or make its output a reviewed data file.\n');
  }

  if (!violations.length && !stale.length && !pythonPaths.length) {
    console.log(`check-plugin-leaks: clean (${targets.length} files scanned, ${ALLOW.length} deliberate matches allowed).`);
    process.exit(0);
  }

  if (violations.length) {
    console.error(`\ncheck-plugin-leaks: ${violations.length} leak(s) found.\n`);
    const byRule = new Map();
    for (const v of violations) {
      if (!byRule.has(v.rule.name)) byRule.set(v.rule.name, []);
      byRule.get(v.rule.name).push(v);
    }
    for (const [name, vs] of byRule) {
      console.error(`  ${name}`);
      console.error(`  ${'-'.repeat(name.length)}`);
      console.error(`  ${vs[0].rule.why}\n`);
      for (const v of vs) console.error(`    ${v.rel}:${v.lineNo}\n      ${v.line}`);
      console.error('');
    }
    console.error('  If a match is genuinely deliberate (provenance, an author field), add it to ALLOW');
    console.error('  in scripts/check-plugin-leaks.mjs WITH a reason. A reason nobody can defend is a leak.\n');
  }

  if (stale.length) {
    console.error(`check-plugin-leaks: ${stale.length} stale ALLOW entr(y/ies) — no longer matching anything:\n`);
    for (const s of stale) console.error(`    ${s.file}\n      ${s.line}`);
    console.error('\n  The line was removed or reworded. Update or delete the ALLOW entry so the');
    console.error('  allowlist keeps describing the repo as it actually is.\n');
  }

  process.exit(1);
}
