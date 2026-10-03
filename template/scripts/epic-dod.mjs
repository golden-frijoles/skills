#!/usr/bin/env node
// epic-dod.mjs — the mechanical half of the epic Definition of Done, DERIVED instead of recited.
//
//   node scripts/epic-dod.mjs --check <macro>/<slug>     # e.g. 09-platform-infra/dobby-foundation
//
// The epic DoD used to be a nine-item checklist an agent ticked from memory at close — and "ticked from
// memory" is how a README said `shipped` while a sprint still said ⬜, or a feature branch outlived its
// merge by a month. Five of those items are facts about files, frontmatter and git, so they are checked
// here (ways-of-work-lean-pass S3.3, D13). The ones that need judgement — is the poster honest, does the
// retro say what happened, is each smoke walkthrough followable, did team memory record it — stay prose in
// WAYS-OF-WORKING, where each project's own list lives.
//
// ── The five derived items ─────────────────────────────────────────────────────────────────────────
//   readme-shipped   README frontmatter `status: shipped`
//   sprints-ticked   every sprint-N.md's `**Status:**` line starts with ✅
//   sprints-merged   every sprint cites ≥1 PR/commit, ≥1 citation VERIFIES as merged, none verifies unmerged
//   retro-written    RETROSPECTIVE.md exists with a real `_Closed: YYYY-MM-DD_` (not the `<date>` stub)
//   branch-deleted   no `feat|fix|chore/<slug>` (or `-<suffix>`) branch left on origin
//   intent-answered  a SCORED epic (its README or seed carries a numeric `intent_match:`) says in its retro whether we
//                    built what was meant: `_Intent: yes_`, `_mostly_` or `_no_` (intent-match D17). An unscored
//                    epic passes — no epic closed before the score existed is failed retroactively.
//
// ── Three states, never two ────────────────────────────────────────────────────────────────────────
// Each item is `pass`, `fail` or `unavailable` (gh unauthenticated, a citation into a repo this checkout
// cannot see). Unavailable is NOT pass — the run exits non-zero and names what it could not check. A
// green run that verified nothing is worse than no script (AGENTS rule).
//
// An epic whose sprint docs live in another repo (frontmatter `sprints_in:`) is checked against THOSE
// files: the URL is fetched and the same tick/citation/retro rules run on what comes back. Directory
// existence alone is not a pass — an empty or wrong directory answered 200 and turned three items green
// (found by codex on dobby-foundation#17). Unfetchable ⇒ `unavailable`, 404 ⇒ `fail`.
//
// ── Exemptions, with the check-plugin-leaks discipline ─────────────────────────────────────────────
// `scripts/epic-dod.exemptions.json` lists {epic, item, reason} for epics closed before a convention
// existed. An exemption for an item that now PASSES is itself a failure: a stale exemption is a promise
// the ledger no longer needs to make, and it hides the next real regression.
//
// Zero deps — Node 18+. Pure core (`evaluate`) + an injected I/O shell.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
/** The branch prefixes WAYS-OF-WORKING names: a leftover branch under any of them is still a leftover. */
export const BRANCH_PREFIXES = ['feat/', 'fix/', 'chore/'];

export const ITEMS = [
  'readme-shipped',
  'sprints-ticked',
  'sprints-merged',
  'retro-written',
  'branch-deleted',
  'intent-answered',
];

/** A numeric `intent_match:` is what makes an epic "scored" (intent-match D17). `null`, absent or a typo is not. */
export const intentScore = (fm) =>
  /^\d{1,3}$/.test(String(fm?.intent_match ?? '')) && Number(fm.intent_match) <= 100
    ? Number(fm.intent_match)
    : null;

/**
 * The retro's answer: a line that is EXACTLY `_Intent: yes_` · `_mostly_` · `_no_`, or null. HTML comments are
 * stripped first and the match is anchored to its own line: an unanchored match read the template's own guidance
 * ("e.g. `_Intent: mostly_`") as an answer, so every scaffolded retro passed unanswered (fresh review of #198). The
 * template's `yes | mostly | no` is not one either.
 */
export function intentAnswer(retro) {
  const text = String(retro ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const m = /^_Intent:\s*(yes|mostly|no)\s*_\s*$/im.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** Frontmatter keys → values (flat, comment-stripped). */
export function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(String(text));
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Every PR / commit citation in a sprint doc.
 *   `#123`                → this repo's PR 123
 *   `golden-beans #10`    → PR 10 in the aliased repo
 *   `owner/repo#12`       → explicit
 *   a 7–40 char hex word with at least one letter → a commit
 * Numbers without `#` (CI run ids, dates) are deliberately not citations.
 */
export function citations(text, { aliases = {}, bareRefsRepo = null } = {}) {
  const t = String(text);
  const refs = [];
  const seen = new Set();
  const add = (r) => {
    const k = JSON.stringify(r);
    if (!seen.has(k)) {
      seen.add(k);
      refs.push(r);
    }
  };
  let rest = t;
  // 1. Full GitHub PR links — the least ambiguous citation there is.
  for (const m of t.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g))
    add({ kind: 'pr', repo: m[1], number: Number(m[2]) });
  rest = rest.replace(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g, ' ');
  // 2. Explicit owner/repo#N.
  for (const m of rest.matchAll(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/g))
    add({ kind: 'pr', repo: m[1], number: Number(m[2]) });
  rest = rest.replace(/\b[\w.-]+\/[\w.-]+#\d+\b/g, ' ');
  // 3. A named repo the project's alias map knows: `backend #33`, `web-app#33`, `frontend PR [#100]`. Only
  //    mapped names count; an unknown word before a `#N` is prose, not a repo.
  for (const m of rest.matchAll(/\b([a-z][\w-]*)\s*(?:PR\s*)?\[?#(\d{1,5})\b/gi)) {
    const repo = aliases[m[1].toLowerCase()];
    if (repo) add({ kind: 'pr', repo, number: Number(m[2]) });
  }
  rest = rest.replace(/\b([a-z][\w-]*)\s*(?:PR\s*)?\[?#\d{1,5}\b/gi, (w, name) =>
    aliases[name.toLowerCase()] ? ' ' : w
  );
  // 4. A bare `#N` means THIS repo only where the project says so (`bareRefsRepo`). In a multi-repo project
  //    a bare `#N` is ambiguous — resolving it against the docs repo verified the wrong PRs on real epics
  //    (found by a fresh review on a real multi-repo epic), so it is ignored, never guessed.
  if (bareRefsRepo) {
    for (const m of rest.matchAll(/(?<![\w/])\[?#(\d{1,5})\b/g))
      add({ kind: 'pr', repo: bareRefsRepo, number: Number(m[1]) });
  }
  for (const m of t.matchAll(/(?<![\w/#-])([0-9a-f]{7,40})(?![\w-])/g)) {
    if (/[a-f]/.test(m[1])) add({ kind: 'commit', sha: m[1] });
  }
  return refs;
}

/**
 * `bareRefsRepo` is only trustworthy in a project whose epics never cite another repo. The moment the alias
 * map names a SECOND repository, a bare `#N` is ambiguous again — and `#143` resolving to this repo's PR 143
 * instead of the sibling's is a false GREEN, not a miss (found by codex on dobby-foundation#17). So the knob
 * is honoured only in a single-repo config, and the reason is printed rather than silently applied.
 */
export function effectiveBareRefsRepo(cfg = {}) {
  const repo = cfg.bareRefsRepo || null;
  if (!repo) return { repo: null, note: 'bareRefsRepo is not set' };
  const others = [...new Set(Object.values(cfg.aliases || {}))].filter((r) => r !== repo);
  return others.length
    ? {
        repo: null,
        note: `bareRefsRepo is IGNORED — this project also cites ${others.join(', ')}, so a bare #N is ambiguous`,
      }
    : { repo, note: `bare #N means ${repo}` };
}

/**
 * THE DECISION. Pure. Facts in, one verdict per item out.
 * sprints: [{ name, text }] · verified: Map(refKey → 'merged' | 'unmerged' | 'unavailable')
 * branches: string[] of remote branch names, or null when the remote could not be read.
 */
export function evaluate({
  slug,
  readme,
  sprints,
  retro,
  verified,
  branches,
  aliases = {},
  exemptions = [],
  externalDocs = null,
  bareRefsRepo = null,
  bareRefsNote = 'bareRefsRepo is not set',
  seed = null,
}) {
  const fm = frontmatter(readme);
  const items = {};
  // `sprints_in` is only trusted when the docs it names were actually READ: a typo'd URL must not turn the
  // sprint items green (found by codex on #179), and neither must a directory that exists but holds no
  // sprint files (found by codex on dobby-foundation#17). null = could not check.
  // Two sources for the same sprints is a contradiction, and picking one silently is how a stale local copy
  // certifies a remote that nobody read (found by codex on #17). Say it and fail.
  const conflicted = Boolean(fm.sprints_in) && sprints.length > 0;
  const wantsExternal = Boolean(fm.sprints_in) && sprints.length === 0;
  const fetched = wantsExternal && externalDocs && Array.isArray(externalDocs.sprints);
  if (fetched) {
    // Same rules, other repo: from here on the fetched files ARE the sprint docs.
    sprints = externalDocs.sprints;
    retro = externalDocs.retro ?? null;
  }
  const from = fetched ? ` (read from ${fm.sprints_in})` : '';
  const externalState = externalDocs === false ? 'fail' : 'unavailable';
  const externalDetail =
    externalDocs === false
      ? `sprints_in points at nothing: ${fm.sprints_in}`
      : `could not read sprints_in: ${fm.sprints_in}`;
  const external = wantsExternal && !fetched;

  items['readme-shipped'] =
    fm.status === 'shipped'
      ? { state: 'pass', detail: 'status: shipped' }
      : {
          state: 'fail',
          detail: `README frontmatter status is '${fm.status || '(missing)'}'`,
        };

  if (conflicted) {
    const clash = `both a sprints_in (${fm.sprints_in}) and ${sprints.length} local sprint-N.md file(s) — one epic, one source: delete one`;
    items['sprints-ticked'] = { state: 'fail', detail: clash };
    items['sprints-merged'] = { state: 'fail', detail: clash };
  } else if (external) {
    items['sprints-ticked'] = { state: externalState, detail: externalDetail };
    items['sprints-merged'] = { state: externalState, detail: externalDetail };
  } else if (!sprints.length) {
    items['sprints-ticked'] = {
      state: 'fail',
      detail: `no sprint-N.md files${from}`,
    };
    items['sprints-merged'] = {
      state: 'fail',
      detail: `no sprint-N.md files${from}`,
    };
  } else {
    const unticked = sprints.filter((s) => !/^\*\*Status:\*\*\s*(?:✅|🟩)/m.test(s.text)).map((s) => s.name);
    items['sprints-ticked'] = unticked.length
      ? { state: 'fail', detail: `not ✅: ${unticked.join(', ')}${from}` }
      : { state: 'pass', detail: `${sprints.length} sprint(s) ✅${from}` };

    const problems = [];
    let unavailable = false;
    for (const s of sprints) {
      const refs = citations(s.text, { aliases, bareRefsRepo });
      if (!refs.length) {
        // Bare `#N` refs exist but nothing says which repo they mean: UNKNOWN, not "cites nothing".
        if (/(?<![\w/])#\d{1,5}\b/.test(s.text)) {
          unavailable = true;
          problems.push(
            `${s.name}: only bare #N citations — ${bareRefsNote}, so they could be verified only with a repo. Cite owner/repo#N or a full PR link.`
          );
        } else problems.push(`${s.name} cites no PR or commit`);
        continue;
      }
      const states = refs.map((r) => verified.get(refKey(r)) || 'unavailable');
      if (states.includes('unmerged')) problems.push(`${s.name} cites an UNMERGED PR`);
      else if (!states.includes('merged')) {
        unavailable = true;
        problems.push(`${s.name}: none of ${refs.length} citation(s) could be verified`);
      } else if (states.includes('unavailable')) {
        // One merged citation does not vouch for the rest: a sprint citing a merged PR *and* a commit this
        // checkout has never seen is one un-run check away from a false green (found by codex on #17).
        unavailable = true;
        const n = states.filter((x) => x === 'unavailable').length;
        problems.push(
          `${s.name}: cites a merged change, but ${n} of ${refs.length} citation(s) could be verified by nobody here`
        );
      }
    }
    items['sprints-merged'] = !problems.length
      ? {
          state: 'pass',
          detail: `every sprint cites a verified-merged change${from}`,
        }
      : {
          state: unavailable && problems.every((p) => /could be verified/.test(p)) ? 'unavailable' : 'fail',
          detail: problems.join('; '),
        };
  }

  items['retro-written'] =
    retro == null && external
      ? { state: externalState, detail: externalDetail }
      : retro == null
        ? { state: 'fail', detail: `RETROSPECTIVE.md missing${from}` }
        : isRealClosedDate(retro)
          ? { state: 'pass', detail: `closed with a real date${from}` }
          : {
              state: 'fail',
              detail: 'RETROSPECTIVE.md is still the stub (no `_Closed: YYYY-MM-DD_`)',
            };

  if (branches == null)
    items['branch-deleted'] = {
      state: 'unavailable',
      detail: 'could not list origin branches',
    };
  else {
    // The process names three branch prefixes (`feat/`, `fix/`, `chore/`), so checking only `feat/` let a
    // leftover `fix/<slug>` pass the item (found by codex on #179).
    const left = branches.filter((b) =>
      BRANCH_PREFIXES.some((p) => b === `${p}${slug}` || b.startsWith(`${p}${slug}-`))
    );
    items['branch-deleted'] = left.length
      ? { state: 'fail', detail: `still on origin: ${left.join(', ')}` }
      : { state: 'pass', detail: 'no feature branch left' };
  }

  const score = intentScore(fm) ?? intentScore(frontmatter(seed ?? ''));
  const answer = intentAnswer(retro);
  items['intent-answered'] =
    score == null
      ? { state: 'pass', detail: 'not scored (no intent_match) — not required' }
      : answer
        ? { state: 'pass', detail: `scored ${score}; answered: ${answer}${from}` }
        : retro == null && external
          ? { state: externalState, detail: externalDetail }
          : {
              state: 'fail',
              detail: `scored epic (intent_match: ${score}) — the retrospective needs \`_Intent: yes | mostly | no_\` answered with one word: did we build what was meant?`,
            };

  // Exemptions: an exempted failure passes with its reason; an exemption on a passing item is STALE.
  const epicExemptions = exemptions.filter((e) => e.epic === slug);
  // Two entries for the same item made the FIRST one flag a stale exemption and the SECOND one excuse that
  // flag — a duplicate silently disarming the staleness check (found by codex on #17/#179).
  const dupes = [...new Set(epicExemptions.map((e) => e.item).filter((it, i, a) => a.indexOf(it) !== i))];
  for (const item of dupes) {
    if (items[item])
      items[item] = {
        state: 'fail',
        detail: `duplicate exemption entries for '${item}' — one per (epic, item), or they cancel each other out`,
      };
  }
  for (const e of epicExemptions) {
    const it = items[e.item];
    if (!it || dupes.includes(e.item)) continue;
    // An exemption excuses a known FAILURE. It never turns "could not check" into a pass — unavailable
    // stays unavailable (found by codex on #179).
    if (it.state === 'unavailable') continue;
    if (it.state === 'pass') {
      items[e.item] = {
        state: 'fail',
        detail: `STALE exemption — '${e.item}' passes now, so remove it from epic-dod.exemptions.json`,
      };
    } else {
      items[e.item] = {
        state: 'exempt',
        detail: `${it.detail} — exempt: ${e.reason}`,
      };
    }
  }
  const ok = ITEMS.every((k) => ['pass', 'exempt'].includes(items[k].state));
  // finops S2.5 — a WARNING, never a failure: epics shipped before FinOps have no actual, and this must not turn them
  // red (epic-dod.exemptions.json stays untouched). An actual held on purpose (`actual_basis` says why) is recorded.
  const warnings = [];
  const actual = String(fm?.actual_usd ?? '').trim();
  const held =
    String(fm?.actual_basis ?? '').trim() && !['null', '~'].includes(String(fm?.actual_basis).trim());
  if (fm?.status === 'shipped' && !(actual && Number.isFinite(Number(actual))) && !held)
    warnings.push(
      `no actual_usd — stamp what it cost: node scripts/epic-actuals.mjs --epic ${slug} --write (finops; a warning, not a failure)`
    );
  return { ok, items, warnings };
}

/** `_Closed: YYYY-MM-DD_` with a date that EXISTS — `2026-99-99` matched the shape and meant nothing. */
export function isRealClosedDate(retro) {
  const m = /_Closed:\s*(\d{4})-(\d{2})-(\d{2})/.exec(String(retro || ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function refKey(r) {
  return r.kind === 'commit' ? `commit:${r.sha}` : `pr:${r.repo || '.'}#${r.number}`;
}

// ── I/O shell ─────────────────────────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', cwd: REPO, ...opts });
}

export function verify(refs, deps = {}) {
  const exec = deps.run ?? run;
  // A failed fetch means `origin/main` is whatever this checkout last saw, and a rewritten remote can make
  // an abandoned commit look merged. Ancestry becomes UNKNOWN, not "warned about" (found by codex on #17
  // and #179 after the warning-only first fix).
  const staleRemote = deps.staleRemote === true;
  const out = new Map();
  for (const r of refs) {
    const key = refKey(r);
    if (out.has(key)) continue;
    if (r.kind === 'commit') {
      if (staleRemote) {
        out.set(key, 'unavailable');
        continue;
      }
      const known = exec('git', ['cat-file', '-e', `${r.sha}^{commit}`]);
      if (known.status !== 0) {
        out.set(key, 'unavailable');
        continue;
      }
      // Exit 1 = "not an ancestor" (a fact). Anything else — 128 for a missing or unfetched `origin/main`,
      // a shallow clone, no remote — is "I could not check", and reporting that as UNMERGED is a confident
      // false FAIL (found by codex twice, then by the fresh reviewer, who measured the two exit codes).
      const anc = exec('git', ['merge-base', '--is-ancestor', r.sha, 'origin/main']);
      out.set(key, anc.status === 0 ? 'merged' : anc.status === 1 ? 'unmerged' : 'unavailable');
      continue;
    }
    const args = [
      'api',
      r.repo ? `repos/${r.repo}/pulls/${r.number}` : `repos/{owner}/{repo}/pulls/${r.number}`,
      '--jq',
      '[.merged_at, .state] | @tsv',
    ];
    const res = exec('gh', args);
    if (res.status !== 0) {
      out.set(key, 'unavailable');
      continue;
    }
    const [mergedAt, state] = String(res.stdout).trim().split('\t');
    out.set(
      key,
      mergedAt && mergedAt !== 'null'
        ? 'merged'
        : state === 'closed' || state === 'open'
          ? 'unmerged'
          : 'unavailable'
    );
  }
  return out;
}

/**
 * Only github.com tree URLs are understood; anything else is unreadable (null), never assumed.
 */
export function parseTreeUrl(url) {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/tree\/([\w.\/-]+?)\/(Roadmap\/[^\s#?]+?)\/?$/.exec(
    String(url || '')
  );
  return m ? { repo: m[1], ref: m[2], path: m[3] } : null;
}

/**
 * READ the sprint docs a `sprints_in:` URL points at, so the same checks run on them.
 * null = could not check · false = GitHub says the directory does not exist · { sprints, retro } = read.
 * A file that lists but will not fetch makes the whole thing unavailable: a partially-read directory
 * would silently check fewer sprints than the epic has.
 */
export function fetchExternal(url, deps = {}) {
  const t = parseTreeUrl(url);
  if (!t) return null;
  const exec = deps.run ?? run;
  const ls = exec('gh', ['api', `repos/${t.repo}/contents/${t.path}?ref=${t.ref}`, '--jq', '.[] | .name']);
  if (ls.status !== 0) return /404|Not Found/.test(`${ls.stderr || ''}${ls.stdout || ''}`) ? false : null;
  const names = String(ls.stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const read = (name) => {
    const r = exec('gh', [
      'api',
      `repos/${t.repo}/contents/${t.path}/${name}?ref=${t.ref}`,
      '-H',
      'Accept: application/vnd.github.raw',
    ]);
    return r.status === 0 ? String(r.stdout) : null;
  };
  const sprints = [];
  for (const name of names.filter((n) => /^sprint-\d+\.md$/.test(n)).sort()) {
    const text = read(name);
    if (text == null) return null;
    sprints.push({ name, text });
  }
  const retro = names.includes('RETROSPECTIVE.md') ? read('RETROSPECTIVE.md') : null;
  if (names.includes('RETROSPECTIVE.md') && retro == null) return null;
  return { sprints, retro };
}

function main() {
  const i = process.argv.indexOf('--check');
  const target = i >= 0 ? process.argv[i + 1] : null;
  if (!target || !/^[\w.-]+\/[\w.-]+$/.test(target)) {
    process.stderr.write('usage: node scripts/epic-dod.mjs --check <macro>/<slug>\n');
    process.exit(2);
  }
  const dir = join(REPO, 'Roadmap', target);
  if (!existsSync(join(dir, 'README.md'))) {
    process.stderr.write(`✗ no epic at Roadmap/${target}/README.md\n`);
    process.exit(2);
  }
  const slug = target.split('/')[1];
  const cfgPath = join(__dirname, 'epic-dod.exemptions.json');
  const cfg = existsSync(cfgPath)
    ? JSON.parse(readFileSync(cfgPath, 'utf8'))
    : { aliases: {}, exemptions: [] };
  const aliases = Object.fromEntries(Object.entries(cfg.aliases || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const sprints = readdirSync(dir)
    .filter((f) => /^sprint-\d+\.md$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }));
  const retroPath = join(dir, 'RETROSPECTIVE.md');
  // A failed fetch means every ancestry answer below is about a STALE origin/main. Say so rather than
  // verifying against yesterday's remote (found by codex, then measured by the fresh reviewer).
  const fetched = run('git', ['fetch', '-q', 'origin']);
  const staleRemote = fetched.status !== 0;
  if (staleRemote)
    process.stderr.write(
      '⚠ `git fetch origin` failed — commit ancestry is UNAVAILABLE for this run (not "unmerged", and not merged).\n'
    );
  const { repo: bareRefsRepo, note: bareRefsNote } = effectiveBareRefsRepo(cfg);
  const refs = sprints.flatMap((s) => citations(s.text, { aliases, bareRefsRepo }));
  const readmeText = readFileSync(join(dir, 'README.md'), 'utf8');
  const externalDocs = frontmatter(readmeText).sprints_in
    ? fetchExternal(frontmatter(readmeText).sprints_in)
    : null;
  // The fetched sprint docs cite PRs too — verify THEIR citations, not just the local ones.
  if (!sprints.length && externalDocs && Array.isArray(externalDocs.sprints))
    refs.push(...externalDocs.sprints.flatMap((s) => citations(s.text, { aliases, bareRefsRepo })));
  const verified = verify(refs, { staleRemote });
  const ls = run('git', ['ls-remote', '--heads', 'origin']);
  const branches =
    ls.status === 0
      ? ls.stdout
          .split('\n')
          .filter(Boolean)
          .map((l) => l.split('refs/heads/')[1])
      : null;
  const { ok, items, warnings } = evaluate({
    slug,
    readme: readmeText,
    externalDocs,
    bareRefsRepo,
    bareRefsNote,
    sprints,
    retro: existsSync(retroPath) ? readFileSync(retroPath, 'utf8') : null,
    seed: existsSync(join(REPO, 'Roadmap', '00-ideas', 'seeds', `${slug}.md`))
      ? readFileSync(join(REPO, 'Roadmap', '00-ideas', 'seeds', `${slug}.md`), 'utf8')
      : null,
    verified,
    branches,
    aliases,
    exemptions: cfg.exemptions || [],
  });
  const icon = { pass: '✓', fail: '✗', unavailable: '?', exempt: '~' };
  process.stdout.write(`epic-dod — ${target}\n`);
  for (const k of ITEMS)
    process.stdout.write(
      `  ${icon[items[k].state]} ${k.padEnd(15)} ${items[k].state.padEnd(11)} ${items[k].detail}\n`
    );
  for (const w of warnings) process.stdout.write(`  ⚠ ${w}\n`);
  process.stdout.write(
    ok
      ? '✓ the derivable half of the DoD holds. Still yours: poster honest, retro true + learnings promoted, smoke walkthroughs followable.\n'
      : '✗ not done — see above. `?` means UNCHECKED, not passed.\n'
  );
  process.exit(ok ? 0 : 1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
