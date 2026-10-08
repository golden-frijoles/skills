#!/usr/bin/env node
// read-repo.mjs — read an existing project into its roadmap: what shipped, what is being built, the open issues as
// ideas (first-run-setup D1). Setup runs it; it is a groom script because it writes through groom's generators.
//
//   node "$GROOM/read-repo.mjs" --look     # what setup found, before its first question (S1.1, D3); writes nothing
//   node "$GROOM/read-repo.mjs"            # the dry run: counts, what was left out, the first few of each (D10)
//   node "$GROOM/read-repo.mjs" --write    # on approval: write it into Roadmap/ (D8, D9)
//   … --root <dir>                         # another project root (default: cwd)
//
// ── What it reads (D5–D7) ─────────────────────────────────────────────────────────────────────────────────────────
// Shipped work: merged pull requests from `gh`, grouped into epics by their head branch; without `gh`, the merge
// commits and `(#N)` squash subjects git holds; with neither, release tags; with none, the files in `docs/`. The last
// 12 months, the 20 largest, and the rest counted in a "left out" note. Being built: open pull requests, one epic per
// branch group, named by the branch so the live board (lib/stage.mjs) finds it. Ideas: open issues, clustered by label
// or a shared title word, one raw seed each, listing its issue numbers. Bots' pull requests are left out and counted.
//
// ── What it never does (D9) ───────────────────────────────────────────────────────────────────────────────────────
// It moves, renames and deletes nothing, and writes only new files under Roadmap/: `--write` refuses a Roadmap/ that
// already holds an epic or an idea, and afterwards checks `git status` for anything new outside Roadmap/. On GitHub it
// only reads (`gh auth status`, `gh repo view`, `gh pr list`, `gh issue list`). It never reads stdin. Nothing leaves
// the machine: the roadmap reaches the Hub only when the founder pushes it.
//
// ── Through the generators (D8) ───────────────────────────────────────────────────────────────────────────────────
// Every epic is made by `scaffold-epic.mjs`, every open pull request's epic is funded by `fund.mjs` (the board refuses
// a live epic with no funding), and every idea starts from `templates/scope-seed.md`'s frontmatter. This script only
// edits the fields a backfill changes, with `roadmap-fm.mjs`, and checks the result against the roadmap contract.
//
// Zero deps — Node 18+.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readField, setField, yamlString } from './roadmap-fm.mjs';
import { branchCandidates, parseBranch } from './vendor/lib/work-branch.mjs';
import { parseDocFrontmatter, validateEpicFrontmatter, validateSprintFrontmatter } from './vendor/lib/roadmap-contract.mjs';

const GROOM = dirname(fileURLToPath(import.meta.url));

export const WINDOW_DAYS = 365;
export const SHIPPED_CAP = 20;
export const ISSUE_LIMIT = 500;
export const MERGED_LIMIT = 1000;
export const OPEN_LIMIT = 200;
const FIRST_FEW = 5;

// ── Pure: names ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A Roadmap slug: lower-case words joined by `-`, at most 60 characters. '' when nothing is left. */
export function slugify(text) {
  let slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > 60) {
    // Cut at the last word boundary inside 60 characters; a single 60+ letter word is cut where it stands.
    const at = slug.slice(0, 61).lastIndexOf('-');
    slug = at > 0 ? slug.slice(0, at) : slug.slice(0, 60);
  }
  return slug.replace(/-+$/, '');
}

/** `checkout-v2` → `Checkout v2`. */
export function humanize(slug) {
  const t = String(slug ?? '').replace(/-/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

/** A pull request title without its conventional prefix (`feat(x): `), first letter up. */
export function cleanTitle(title) {
  const t = String(title ?? '').replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

/** Is this pull request a bot's? Its author says so, or its branch is a dependency bot's. */
export function isBot(pr) {
  const login = String(pr.author?.login ?? '');
  return Boolean(pr.author?.is_bot) || /\[bot\]$/.test(login) || /^(?:dependabot|renovate)[/-]/.test(String(pr.branch ?? ''));
}

/**
 * Which group a branch belongs to (D5): the work-branch reading when it carries a sprint (`feat/x-s2` → `x`), else the
 * longest proper prefix that is another branch's own slug (`docs/x-close` → `x`, given `feat/x`), else its own slug.
 * null for a branch that is not a work branch (`patch-1`, `main`): the caller falls back to the title.
 */
export function groupKey(branch, exactSlugs = new Set()) {
  const cands = branchCandidates(branch);
  if (!cands.length) return null;
  const parsed = parseBranch(branch);
  let key = parsed.sprint !== null ? parsed.slug : (cands.slice(1).find((c) => exactSlugs.has(c.slug))?.slug ?? cands[0].slug);
  // A prefix can itself carry a sprint (`docs/x-s3-close` → `x-s3` → `x`).
  const again = parseBranch(`feat/${key}`);
  if (again && again.sprint !== null) key = again.slug;
  return slugify(key) || null;
}

/** The work-branch type a branch names, as an epic type: feat → feature, fix → bug, docs → chore. */
export function typeOf(branch) {
  const prefix = /^(feat|fix|chore|spike|bug|docs)\//.exec(String(branch ?? ''))?.[1];
  return { feat: 'feature', fix: 'bug', bug: 'bug', chore: 'chore', docs: 'chore', spike: 'spike' }[prefix] ?? 'feature';
}

/** An appetite read off a pull request's size, since none was chosen for it (D8): ≤300 lines S, ≤1500 M, else L. */
export function appetiteFor(size) {
  return size <= 300 ? 'S' : size <= 1500 ? 'M' : 'L';
}

// ── Pure: grouping and caps ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Group changes (merged or open pull requests, merge commits) into epics. A change is
 * `{ number, title, branch, date, size }`. Returns `[{ key, title, type, changes, size, latest }]`, oldest first.
 */
export function groupChanges(changes, siblings = []) {
  // A branch joins the family of any other branch it extends, in this list or a sibling one (an open `docs/x-close`
  // joins the merged `feat/x`: fresh review, #307).
  const exact = new Set([...changes, ...siblings].map((c) => branchCandidates(c.branch)[0]?.slug).filter(Boolean));
  const groups = new Map();
  for (const c of changes) {
    const key = groupKey(c.branch, exact) || slugify(c.title) || (c.number != null ? `pr-${c.number}` : '');
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, changes: [] });
    groups.get(key).changes.push(c);
  }
  return [...groups.values()]
    .map((g) => {
      const byNumber = [...g.changes].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
      const first = byNumber[0];
      const latest = g.changes.map((c) => c.date).filter(Boolean).sort().at(-1) ?? null;
      return {
        key: g.key,
        // Several pull requests on one branch family are one piece of work: its branch names it better than the first
        // one's "Sprint 1: …" title. A lone change keeps its own title.
        title: (g.changes.length > 1 && branchCandidates(first.branch).length ? humanize(g.key) : cleanTitle(first.title)) || humanize(g.key),
        type: typeOf(first.branch),
        changes: byNumber,
        size: g.changes.reduce((n, c) => n + (c.size ?? 0), 0),
        latest,
      };
    })
    .sort((a, b) => String(a.latest ?? '').localeCompare(String(b.latest ?? '')) || a.key.localeCompare(b.key));
}

/**
 * The shipped cap (D5): groups inside the window, the `cap` largest of them; what was left out, counted. A group with
 * no date (a doc) is never "older". Kept groups stay oldest first.
 */
export function capShipped(groups, now, { windowDays = WINDOW_DAYS, cap = SHIPPED_CAP } = {}) {
  const since = new Date(now.getTime() - windowDays * 86400000).toISOString();
  const inWindow = groups.filter((g) => !g.latest || g.latest >= since);
  const older = groups.length - inWindow.length;
  const largest = new Set([...inWindow].sort((a, b) => b.size - a.size || a.key.localeCompare(b.key)).slice(0, cap));
  const kept = inWindow.filter((g) => largest.has(g));
  return { kept, older, smaller: inWindow.length - kept.length };
}

const STOP = new Set(
  ('the and for with from into onto that this when then than not but are was were has have had can could should ' +
    'would will does doesn don isn aren wasn its it\'s add adds added fix fixes fixed bug bugs issue issues error errors ' +
    'make makes use uses using new update updates support feature request allow allows able also more some any all ' +
    'get gets set sets after before about via there their them they you your our out off too very just only')
    .split(/\s+/)
);

/** The words of an issue title a cluster can share: lower case, three letters or more, no stop words, each once. */
export function titleWords(title) {
  return [...new Set(String(title ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
}

/**
 * Open issues into ideas (D7). By the issue's first label (alphabetical); unlabelled ones by the most shared title word
 * (at least two issues per cluster, the commonest word first); the rest one idea each. Each idea:
 * `{ key, title, issues: [{ number, title }] }`, issues in number order, ideas in order of their first issue.
 */
export function clusterIssues(issues) {
  const ideas = new Map();
  const add = (key, title, issue) => {
    if (!ideas.has(key)) ideas.set(key, { key, title, issues: [] });
    ideas.get(key).issues.push({ number: issue.number, title: issue.title });
  };
  const unlabelled = [];
  for (const issue of issues) {
    const label = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean).sort()[0];
    if (label) add(`label:${label.toLowerCase()}`, label, issue); // `Bug` and `bug` are one label
    else unlabelled.push(issue);
  }
  const words = new Map(unlabelled.map((i) => [i.number, titleWords(i.title)]));
  const count = new Map();
  for (const ws of words.values()) for (const w of ws) count.set(w, (count.get(w) ?? 0) + 1);
  const ranked = [...count].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const placed = new Set();
  for (const [word] of ranked) {
    const members = unlabelled.filter((i) => !placed.has(i.number) && words.get(i.number).includes(word));
    if (members.length < 2) continue;
    for (const i of members) {
      placed.add(i.number);
      add(`word:${word}`, word, i);
    }
  }
  for (const i of unlabelled) if (!placed.has(i.number)) add(`issue:${i.number}`, cleanTitle(i.title) || `Issue ${i.number}`, i);
  return [...ideas.values()]
    .map((idea) => {
      const sorted = [...idea.issues].sort((a, b) => a.number - b.number);
      const many = sorted.length > 1;
      const name = idea.title[0].toUpperCase() + idea.title.slice(1);
      return { key: idea.key, title: many ? `${name}: ${sorted.length} issues` : name, issues: sorted };
    })
    .sort((a, b) => a.issues[0].number - b.issues[0].number);
}

/** Give every item a slug no other item (and nothing already in `taken`) holds: `x`, `x-2`, `x-3`… */
export function uniqueSlugs(items, base, taken = new Set()) {
  return items.map((item) => {
    const root = base(item) || 'item';
    let slug = root;
    for (let n = 2; taken.has(slug); n++) slug = `${root}-${n}`;
    taken.add(slug);
    return { ...item, slug };
  });
}

// ── Pure: the plan ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the read proposes, from gathered facts (see `gatherFacts`). Shipped work comes from the first source that has
 * any: pull requests, then git's merge commits, then tags, then docs. An open pull request's group wins over a shipped
 * one with the same key: that work is still being built (D6).
 */
export function planRead(facts, now = new Date()) {
  const plan = { source: 'none', shipped: [], building: [], ideas: [], leftOut: { older: 0, smaller: 0, bots: 0 }, skipped: [] };
  if (!facts.gh.ok) plan.skipped.push(facts.gh.why);
  // Every list is read with one more than its limit, so a cut list is said out loud, never silent (codex, #307).
  for (const what of facts.unread ?? []) plan.skipped.push(`could not read the ${what}, so they are not counted`);
  if (facts.openMore) plan.skipped.push(`only the newest ${OPEN_LIMIT} open pull requests were read`);
  if (facts.mergedMore) plan.skipped.push(`only the newest ${MERGED_LIMIT} merged pull requests were read`);
  if (facts.issuesMore) plan.skipped.push(`only the first ${ISSUE_LIMIT} open issues were read`);

  const human = (prs) => {
    const kept = prs.filter((p) => !isBot(p));
    plan.leftOut.bots += prs.length - kept.length;
    return kept;
  };

  const openHuman = human(facts.openPrs ?? []);
  const mergedHuman = (facts.mergedPrs ?? []).filter((p) => !isBot(p));
  const open = groupChanges(openHuman, mergedHuman);
  plan.building = open;
  const openKeys = new Set(open.map((g) => g.key));

  let shippedGroups = [];
  const merged = human(facts.mergedPrs ?? []);
  if (merged.length) {
    plan.source = 'pull requests';
    shippedGroups = groupChanges(merged, openHuman);
  } else if ((facts.gitMerges ?? []).length) {
    plan.source = 'merge commits';
    shippedGroups = groupChanges(human(facts.gitMerges), openHuman);
  } else if ((facts.tags ?? []).length) {
    plan.source = 'release tags';
    shippedGroups = facts.tags.map((t) => ({
      key: slugify(`release-${t.name}`),
      title: `Release ${t.name}`,
      type: 'feature',
      changes: [{ tag: t.name, date: t.date, size: t.commits }],
      size: t.commits ?? 0,
      latest: t.date ?? null,
    }));
  } else if ((facts.docs ?? []).length) {
    plan.source = 'docs';
    shippedGroups = facts.docs.map((d) => ({
      key: slugify(d.title) || slugify(d.file),
      title: d.title,
      type: 'feature',
      changes: [{ file: d.file, size: d.size }],
      size: d.size ?? 0,
      latest: null,
    }));
  }
  // The same work, merged in part and still open: one Building epic citing both (D6).
  for (const g of shippedGroups.filter((g) => openKeys.has(g.key))) {
    const b = open.find((o) => o.key === g.key);
    b.merged = g.changes;
  }
  const capped = capShipped(shippedGroups.filter((g) => !openKeys.has(g.key)), now);
  plan.shipped = capped.kept;
  plan.leftOut.older = capped.older;
  plan.leftOut.smaller = capped.smaller;
  plan.ideas = clusterIssues(facts.issues ?? []);

  const taken = new Set();
  plan.building = uniqueSlugs(plan.building, (g) => g.key, taken);
  plan.shipped = uniqueSlugs(plan.shipped, (g) => g.key, taken);
  plan.ideas = uniqueSlugs(plan.ideas, ideaSlug, taken);
  return plan;
}

/** An idea's slug: its label or shared word, or a lone issue's title (`issue-<n>` when the title has no letters). */
export function ideaSlug(idea) {
  const [kind, rest] = [idea.key.slice(0, idea.key.indexOf(':')), idea.key.slice(idea.key.indexOf(':') + 1)];
  if (kind === 'issue') return slugify(cleanTitle(idea.issues[0].title)) || `issue-${rest}`;
  return slugify(rest) || slugify(idea.title);
}

/** Where a group came from, in words: `PR #4, #9`, `merge #12`, `tag v1.2`, `docs/setup.md`. */
export function sourcesOf(group) {
  const all = [...(group.merged ?? []), ...group.changes];
  const numbers = all.filter((c) => c.number != null).map((c) => `#${c.number}`);
  const out = [];
  if (numbers.length) out.push(`${group.source === 'merge commits' ? 'merge' : 'PR'} ${numbers.join(', ')}`);
  for (const c of all) {
    if (c.tag) out.push(`tag ${c.tag}`);
    if (c.file) out.push(c.file);
    if (c.number == null && !c.tag && !c.file && c.sha) out.push(`commit ${c.sha.slice(0, 7)}`);
  }
  return out.join(' · ') || 'the history';
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** S1.1's block (D3): is Roadmap/ here, what the repo is. */
export function formatLook(facts) {
  const out = ['I looked first:'];
  const r = facts.roadmap;
  out.push(
    `  Roadmap/ ....... ${r.present ? `here${r.epics || r.ideas ? ` (${plural(r.epics, 'epic')}, ${plural(r.ideas, 'idea')})` : ', empty so far'}` : 'not here yet'}`
  );
  if (!facts.git.ok) {
    out.push(`  This folder .... ${facts.empty ? 'empty: nothing built yet' : 'not a git repository'}`);
    return out.join('\n');
  }
  const parts = [];
  parts.push(facts.stack.length ? facts.stack.join(', ') : 'no manifest file found');
  parts.push(plural(facts.git.commits, 'commit'));
  if (facts.gh.ok && !(facts.unread ?? []).length) parts.push(plural(facts.openPrs.filter((p) => !isBot(p)).length, 'open pull request'));
  else if (facts.gh.ok) parts.push(`open pull requests: could not read (${facts.unread[0]})`);
  out.push(`  This repo ...... ${parts.join(' · ')}`);
  if (!facts.gh.ok) out.push(`  Pull requests .. not counted: ${facts.gh.why}`);
  return out.join('\n');
}

/** The dry run (D10): counts, what was left out, the first few of each, and that nothing was written. */
export function formatPlan(plan, facts, { refusal = null } = {}) {
  const out = ["I'll read what's here and write it down. Nothing is moved or deleted.", ''];
  const looked = [];
  if (facts.files.readme) looked.push(facts.files.readme);
  if (facts.files.docs) looked.push(`docs/ (${plural(facts.files.docs, 'file')})`);
  looked.push(...facts.files.manifests);
  looked.push(plural(facts.git.commits, 'commit'));
  const gh = facts.gh.ok
    ? ` · ${plural(facts.openPrs.filter((p) => !isBot(p)).length, 'open pull request')} and ${plural((facts.issues ?? []).length, 'open issue')}`
    : '';
  out.push(`Looked at ${looked.join(', ')}${gh}`);
  const issueCount = plan.ideas.reduce((n, i) => n + i.issues.length, 0);
  out.push(
    [
      `${plan.shipped.length} shipped, from the ${plan.source === 'none' ? 'history (nothing found)' : plan.source} (no targets back then, so no verdicts)`,
      `${plan.building.length} Building: your open pull requests`,
      `${plural(issueCount, 'issue')} grouped into ${plural(plan.ideas.length, 'idea')}`,
    ].join(' · ')
  );
  const left = [];
  if (plan.leftOut.older) left.push(`${plural(plan.leftOut.older, 'group')} older than 12 months`);
  if (plan.leftOut.smaller) left.push(`${plural(plan.leftOut.smaller, 'smaller group')} past the ${SHIPPED_CAP} largest`);
  if (plan.leftOut.bots) left.push(`${plural(plan.leftOut.bots, 'pull request')} by bots`);
  if (left.length) out.push(`Left out: ${left.join(' · ')}`);
  for (const why of plan.skipped) out.push(`Skipped: ${why}`);
  const few = (title, list, line) => {
    if (!list.length) return;
    out.push('', `${title}:`);
    for (const item of list.slice(0, FIRST_FEW)) out.push(`  ${line(item)}`);
    if (list.length > FIRST_FEW) out.push(`  … and ${list.length - FIRST_FEW} more`);
  };
  few('Shipped (epics, marked backfilled, no target)', plan.shipped, (g) => `${g.title}  (${sourcesOf({ ...g, source: plan.source })})`);
  few('Building (epics)', plan.building, (g) => `${g.title}  (${sourcesOf(g)})`);
  few('Ideas, in the backlog', plan.ideas, (i) => `${i.title}  (${i.issues.map((x) => `#${x.number}`).join(', ')})`);
  out.push('');
  out.push(refusal ?? 'Nothing written yet. Approved, it writes new files under Roadmap/ only; nothing on GitHub changes.');
  return out.join('\n');
}

// ── Facts (git, gh, the files) ────────────────────────────────────────────────────────────────────────────────────

/** The default runner: a command's stdout, or a thrown error. Never a shell. */
export function defaultRun(cmd, args, { cwd }) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

const MANIFESTS = [
  ['package.json', 'Node.js'],
  ['pyproject.toml', 'Python'],
  ['requirements.txt', 'Python'],
  ['go.mod', 'Go'],
  ['Cargo.toml', 'Rust'],
  ['Gemfile', 'Ruby'],
  ['composer.json', 'PHP'],
  ['pom.xml', 'Java'],
  ['build.gradle', 'Java/Kotlin'],
  ['mix.exs', 'Elixir'],
  ['pubspec.yaml', 'Dart'],
  ['Package.swift', 'Swift'],
];
const FRAMEWORKS = [
  ['next', 'Next.js'],
  ['nuxt', 'Nuxt'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['astro', 'Astro'],
  ['@remix-run/react', 'Remix'],
  ['react', 'React'],
  ['vue', 'Vue'],
  ['express', 'Express'],
  ['hono', 'Hono'],
];

const BUILD_FRAMEWORKS = new Set(['next', 'nuxt', '@sveltejs/kit', 'astro']);

/** The stack, from manifest files at the root (D3): `Node.js (Next.js)`, `Python`. */
export function readStack(root) {
  const stack = [];
  const manifests = [];
  for (const [file, lang] of MANIFESTS) {
    if (!existsSync(join(root, file))) continue;
    manifests.push(file);
    let label = lang;
    if (file === 'package.json') {
      try {
        const pkg = JSON.parse(readFileSync(join(root, file), 'utf8'));
        // Runtime dependencies name the framework; a dev dependency does only for the frameworks that usually sit there
        // (a library's test server, Express in ky's devDependencies, is not its stack — found on a real repo).
        const deps = { ...pkg.dependencies, ...pkg.peerDependencies };
        const dev = pkg.devDependencies ?? {};
        const fw = FRAMEWORKS.find(([dep]) => dep in deps || (BUILD_FRAMEWORKS.has(dep) && dep in dev))?.[1];
        if (fw) label = `${lang} (${fw})`;
      } catch {
        // An unreadable package.json is still a Node.js project.
      }
    }
    if (!stack.includes(label)) stack.push(label);
  }
  return { stack, manifests };
}

function countRoadmap(root) {
  const dir = join(root, 'Roadmap');
  if (!existsSync(dir)) return { present: false, epics: 0, ideas: 0 };
  let epics = 0;
  for (const macro of readdirSync(dir).filter((d) => /^\d{2}-/.test(d) && d !== '00-ideas')) {
    const m = join(dir, macro);
    if (!statSync(m).isDirectory()) continue;
    epics += readdirSync(m).filter((d) => existsSync(join(m, d, 'README.md'))).length;
  }
  const seeds = join(dir, '00-ideas', 'seeds');
  const ideas = existsSync(seeds) ? readdirSync(seeds).filter((f) => f.endsWith('.md') && f !== 'README.md').length : 0;
  return { present: true, epics, ideas };
}

function readDocs(root) {
  const dir = join(root, 'docs');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => /\.mdx?$/i.test(f))
    .sort()
    .map((f) => {
      const text = readFileSync(join(dir, f), 'utf8');
      const h1 = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
      return { file: `docs/${f}`, title: h1 || f.replace(/\.mdx?$/i, ''), size: Buffer.byteLength(text) };
    });
}

/** `git diff --shortstat` → insertions + deletions. */
export function shortstatSize(text) {
  const ins = /(\d+) insertions?\(\+\)/.exec(text)?.[1] ?? 0;
  const del = /(\d+) deletions?\(-\)/.exec(text)?.[1] ?? 0;
  return Number(ins) + Number(del);
}

/**
 * A first-parent log line as a change, or null: `Merge pull request #N from owner/branch` (title: the body's first
 * line), `Merge branch 'b'`, or a squash subject ending `(#N)`.
 */
export function parseMergeCommit({ sha, parents, date, subject, body }) {
  const pr = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(subject);
  if (pr) return { sha, number: Number(pr[1]), branch: pr[2], title: String(body ?? '').trim().split('\n')[0] || pr[2], date };
  const br = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject);
  if (br && parents.length > 1) return { sha, number: null, branch: br[1].replace(/^origin\//, ''), title: br[1], date };
  const squash = /^(.*\S)\s+\(#(\d+)\)$/.exec(subject);
  if (squash) return { sha, number: Number(squash[2]), branch: null, title: squash[1], date };
  return null;
}

function tryRun(run, cmd, args, root) {
  try {
    return { ok: true, out: run(cmd, args, { cwd: root }) };
  } catch (err) {
    return { ok: false, err };
  }
}

/** Everything the look, the dry run and the write read. `run` is injected in tests. */
export function gatherFacts(root, { run = defaultRun, now = new Date(), full = true } = {}) {
  const entries = existsSync(root) ? readdirSync(root).filter((f) => f !== '.git' && f !== '.DS_Store') : [];
  const { stack, manifests } = readStack(root);
  const readme = entries.find((f) => /^readme(\.md|\.mdx|\.txt|\.rst)?$/i.test(f)) ?? null;
  const docs = readDocs(root);
  const facts = {
    root,
    empty: entries.length === 0,
    roadmap: countRoadmap(root),
    stack,
    files: { readme, docs: docs.length, manifests },
    git: { ok: false, commits: 0 },
    gh: { ok: false, why: '' },
    mergedPrs: [],
    openPrs: [],
    issues: [],
    issuesMore: false,
    openMore: false,
    unread: [],
    mergedMore: false,
    gitMerges: [],
    tags: [],
    docs,
  };
  const inside = tryRun(run, 'git', ['rev-parse', '--is-inside-work-tree'], root);
  facts.git.ok = inside.ok && inside.out.trim() === 'true';
  if (facts.git.ok) {
    const count = tryRun(run, 'git', ['rev-list', '--count', 'HEAD'], root);
    facts.git.commits = count.ok ? Number(count.out.trim()) || 0 : 0;
  }

  // gh: installed, signed in, and this is a GitHub repository it can see — else say which (D3, "without gh").
  if (!tryRun(run, 'gh', ['--version'], root).ok) facts.gh.why = 'gh is not installed, so pull requests and issues were skipped (git only)';
  else if (!tryRun(run, 'gh', ['auth', 'status'], root).ok) facts.gh.why = 'gh is not signed in (gh auth login), so pull requests and issues were skipped (git only)';
  else if (!facts.git.ok || !tryRun(run, 'gh', ['repo', 'view', '--json', 'nameWithOwner'], root).ok)
    facts.gh.why = 'this is not a GitHub repository gh can see, so pull requests and issues were skipped (git only)';
  else facts.gh.ok = true;

  const prFields = 'number,title,headRefName,author,additions,deletions';
  const asChange = (p, date) => ({
    number: p.number,
    title: p.title,
    branch: p.headRefName,
    author: p.author,
    date,
    size: (p.additions ?? 0) + (p.deletions ?? 0),
  });
  // A list gh could not give is "could not read", never zero (fresh review, #307): named, and --write refuses.
  const readList = (result, what) => {
    if (!result.ok) {
      facts.unread.push(`${what} (${String(result.err?.stderr || result.err?.message || 'gh failed').trim().split('\n')[0]})`);
      return null;
    }
    try {
      const list = JSON.parse(result.out);
      if (Array.isArray(list)) return list;
    } catch {
      // fall through: not JSON
    }
    facts.unread.push(`${what} (gh answered something that is not a list)`);
    return null;
  };
  if (facts.gh.ok) {
    const open = tryRun(run, 'gh', ['pr', 'list', '--state', 'open', '--limit', String(OPEN_LIMIT + 1), '--json', `${prFields},isDraft,createdAt`], root);
    const openList = readList(open, 'open pull requests');
    if (openList) {
      const list = openList;
      facts.openMore = list.length > OPEN_LIMIT;
      facts.openPrs = list.slice(0, OPEN_LIMIT).map((p) => asChange(p, p.createdAt));
    }
    if (!full) return facts;
    const merged = tryRun(run, 'gh', ['pr', 'list', '--state', 'merged', '--limit', String(MERGED_LIMIT + 1), '--json', `${prFields},mergedAt`], root);
    const mergedList = readList(merged, 'merged pull requests');
    if (mergedList) {
      const list = mergedList;
      facts.mergedMore = list.length > MERGED_LIMIT;
      facts.mergedPrs = list.slice(0, MERGED_LIMIT).map((p) => asChange(p, p.mergedAt));
    }
    const issues = tryRun(run, 'gh', ['issue', 'list', '--state', 'open', '--limit', String(ISSUE_LIMIT + 1), '--json', 'number,title,labels'], root);
    const issueList = readList(issues, 'open issues');
    if (issueList) {
      const list = issueList;
      facts.issuesMore = list.length > ISSUE_LIMIT;
      facts.issues = list.slice(0, ISSUE_LIMIT);
    }
  }
  if (!full || !facts.git.ok) return facts;

  // git alone: merge commits and squash subjects on the first-parent line, inside the window (D5).
  if (!facts.mergedPrs.length) {
    const since = new Date(now.getTime() - WINDOW_DAYS * 86400000).toISOString();
    const log = tryRun(run, 'git', ['log', '--first-parent', `--since=${since}`, '--format=%H%x1f%P%x1f%cI%x1f%s%x1f%b%x1e', 'HEAD'], root);
    if (log.ok) {
      for (const rec of log.out.split('\x1e')) {
        const [sha, parents, date, subject, body] = rec.replace(/^\n/, '').split('\x1f');
        if (!sha || !subject) continue;
        const change = parseMergeCommit({ sha, parents: parents.trim().split(/\s+/).filter(Boolean), date, subject, body });
        if (!change) continue;
        const stat = tryRun(run, 'git', ['diff', '--shortstat', `${sha}^1`, sha], root);
        facts.gitMerges.push({ ...change, size: stat.ok ? shortstatSize(stat.out) : 0 });
      }
    }
  }
  const tags = tryRun(run, 'git', ['for-each-ref', '--sort=creatordate', '--format=%(refname:short)%1f%(creatordate:iso-strict)', 'refs/tags'], root);
  if (tags.ok) {
    let previous = null;
    for (const line of tags.out.split('\n').filter(Boolean)) {
      const [name, date] = line.split('\x1f');
      const range = previous ? `${previous}..${name}` : name;
      const count = tryRun(run, 'git', ['rev-list', '--count', range], root);
      facts.tags.push({ name, date, commits: count.ok ? Number(count.out.trim()) || 0 : 0 });
      previous = name;
    }
  }
  return facts;
}

// ── Writing (D8, D9) ──────────────────────────────────────────────────────────────────────────────────────────────

/** Why `--write` must not run here, or null. First run only: an existing epic or idea means a roadmap already exists. */
export function writeRefusal(facts) {
  if ((facts.unread ?? []).length)
    return `Could not read the ${facts.unread.join(' and the ')}: fix gh and run this again. Nothing was written.`;
  if (!facts.roadmap.present) return 'There is no Roadmap/ here yet: run setup\'s `frijoles-kit init` first. Nothing was written.';
  if (facts.roadmap.epics || facts.roadmap.ideas)
    return `Roadmap/ already holds ${plural(facts.roadmap.epics, 'epic')} and ${plural(facts.roadmap.ideas, 'idea')}: this read is for a first run only. Nothing was written.`;
  return null;
}

/** The one `Roadmap/NN-*` folder an epic goes in: the only one there, else `01-product` (D8). `00-*` folders hold ideas
 * and strategy, never epics (fresh review, #307: a coach's `00-strategy/` was picked). */
export function macroFor(root) {
  const dirs = readdirSync(join(root, 'Roadmap')).filter((d) => /^\d{2}-/.test(d) && !d.startsWith('00-') && statSync(join(root, 'Roadmap', d)).isDirectory());
  return dirs.length === 1 ? dirs[0] : '01-product';
}

/** The epic README after a backfill: lifecycle fields, and one line saying what it is and where it came from. */
export function backfillEpic(text, { status, phase, note, seed }) {
  let next = setField(setField(text, 'status', status), 'phase', phase);
  // No seed was ever written for this work: the header says so instead of linking one that does not exist.
  next = next.replace(/(\*\*Scope seed:\*\*) \[`00-ideas\/seeds\/[^`]*`\]\([^)]*\)/, (_, label) => `${label} ${seed}`);
  next = next.replace(/^(> \*\*Area:\*\*.*)$/m, (line) => `${line}\n>\n> ${note}`);
  return next;
}

/** Sprint 1 after a backfill: its phase, its one story filled in from the work, and the prose to match. */
export function backfillSprint(text, { phase, storyStatus, title, wants, soThat, statusLine, heading }) {
  let next = setField(text, 'phase', phase);
  const story = [
    '  - id: S1.1',
    `    title: ${yamlString(title)}`,
    '    as_a: "the team"',
    `    i_want: ${yamlString(wants)}`,
    `    so_that: ${yamlString(soThat)}`,
    `    risk: ${readField(text, 'risk') ?? 'high'}`,
    `    status: ${storyStatus}`,
  ].join('\n');
  next = next.replace(/^stories:\n[\s\S]*?(?=^---$)/m, () => `stories:\n${story}\n`);
  next = next.replace(/^\*\*Status:\*\*.*$/m, () => `**Status:** ${statusLine}`);
  next = next.replace(
    /^### Story 1\.1 — [\s\S]*?(?=^## Sprint QA)/m,
    () => `### Story 1.1 — ${heading}\n**As** the team, **I want** ${wants}, **so that** ${soThat}.\n**Risk:** ${readField(text, 'risk') ?? 'high'}\n\n`
  );
  return next;
}

/** An idea's seed: the template's frontmatter, rendered, then the issues as the ask (D7). */
export function renderSeed(template, idea, { area, date }) {
  const fm = /^---\n[\s\S]*?\n---\n/.exec(template)?.[0];
  if (!fm) throw new Error('templates/scope-seed.md has no frontmatter block');
  const vars = { TITLE: '', SLUG: idea.slug, AREA: area, TYPE: 'feature', APPETITE: 'null', RISK: 'high', DATE: date };
  let text = fm.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
  text = setField(setField(text, 'title', yamlString(idea.title)), 'status', 'raw');
  const numbers = idea.issues.map((i) => `#${i.number}`).join(', ');
  const asked = idea.issues.map((i) => `> #${i.number} ${i.title.replace(/\n/g, ' ')}`).join('\n');
  return (
    `${text}\n# Idea — ${idea.title}\n\n` +
    `Read in from GitHub issues on ${date} by setup. Nothing on GitHub was changed. Groom it to make it a plan.\n\n` +
    `## The ask, as given\n\n${asked}\n\n**Issues:** ${numbers}\n`
  );
}

/** The roadmap contract on one written doc: `<path>: <rule> — <detail>` per offense. */
function check(path, kind, ctx) {
  const parsed = parseDocFrontmatter(readFileSync(path, 'utf8'));
  if (!parsed.hasFrontmatter) return [`${path}: no frontmatter`];
  const offenses = kind === 'epic' ? validateEpicFrontmatter(parsed, ctx) : validateSprintFrontmatter(parsed, ctx);
  return offenses.map((o) => `${path}: ${o.rule} — ${o.detail}`);
}

const porcelain = (run, root) =>
  new Set(
    run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root })
      .split('\n')
      .filter(Boolean)
  );

/** The paths `git status --porcelain` lists after the write, not before, outside Roadmap/ (D9). */
export function outsideRoadmap(before, after) {
  const out = [];
  for (const line of after) {
    if (before.has(line)) continue;
    const path = line.slice(3).replace(/^"|"$/g, '');
    if (!path.startsWith('Roadmap/')) out.push(path);
  }
  return out;
}

/** Write the plan into Roadmap/ (D8), then check it (D9). Returns `{ written, problems }`. */
export function writePlan(plan, facts, { run = defaultRun, date = new Date().toISOString().slice(0, 10) } = {}) {
  const root = facts.root;
  const before = facts.git.ok ? porcelain(run, root) : new Set();
  const macro = macroFor(root);
  const area = macro.slice(0, 2);
  const node = (script, args) => run(process.execPath, [join(GROOM, script), ...args, '--repo-root', root], { cwd: root });
  const written = [];
  const problems = [];
  const epicDir = (slug) => join(root, 'Roadmap', macro, slug);
  const edit = (path, fn) => writeFileSync(path, fn(readFileSync(path, 'utf8')));
  const seeds = join(root, 'Roadmap', '00-ideas', 'seeds');

  // A title is one sprint's name too: a `;` would split it into two sprints, and a leading `--` would read as a flag.
  const safe = (t) => t.replace(/;/g, ',').replace(/^-+\s*/, '') || 'Untitled';
  const scaffold = (g, risk) =>
    node('scaffold-epic.mjs', ['--slug', g.slug, '--area', area, '--macro', macro, '--title', safe(g.title), '--risk', risk, '--type', g.type, '--sprints', safe(g.title)]);

  // A generator that fails part-way stops the write with what failed, what was written and how to start over — never a
  // bare stack trace, and never a half-roadmap that "first run only" then refuses to finish (fresh review, #307).
  try {
  for (const g of plan.shipped) {
    scaffold(g, 'low');
    const from = sourcesOf({ ...g, source: plan.source });
    edit(join(epicDir(g.slug), 'README.md'), (t) =>
      backfillEpic(t, {
        status: 'shipped',
        phase: 'Shipped',
        seed: 'none (backfilled from the history)',
        note: `**Backfilled, no target.** Read from the ${plan.source} on ${date} by setup: ${from}. No target was written then, so there is no verdict.`,
      })
    );
    edit(join(epicDir(g.slug), 'sprint-1.md'), (t) =>
      backfillSprint(t, {
        phase: 'Shipped',
        storyStatus: 'done',
        title: g.title,
        wants: g.title,
        soThat: `it shipped (backfilled from ${from})`,
        statusLine: `✅ shipped (backfilled, no target: ${from})`,
        heading: `${g.title} ✅ ${from}`,
      })
    );
    written.push(`Roadmap/${macro}/${g.slug}/`);
  }

  let previous = null;
  for (const g of plan.building) {
    scaffold(g, 'high');
    const from = sourcesOf(g);
    // In pull-request order: the first at the front of the queue, each next one behind the one before.
    node('fund.mjs', [
      '--slug', g.slug, '--cycle', 'backfill', '--appetite', appetiteFor(g.size), '--date', date,
      '--displaced', `nothing: already being built when the roadmap was read (appetite from the pull request's size, ${g.size} lines)`,
      ...(previous ? ['--after', previous] : ['--next']),
    ]);
    previous = g.slug;
    edit(join(epicDir(g.slug), 'README.md'), (t) =>
      backfillEpic(t, {
        status: 'in-progress',
        phase: 'Building',
        seed: 'none (read in from an open pull request)',
        note: `**Read in, already being built.** From the open pull request${g.changes.length > 1 ? 's' : ''} on ${date} by setup: ${from}. No target yet.`,
      })
    );
    edit(join(epicDir(g.slug), 'sprint-1.md'), (t) =>
      backfillSprint(t, {
        phase: 'Building',
        storyStatus: 'in-progress',
        title: g.title,
        wants: g.title,
        soThat: `the open pull request ships (${from})`,
        statusLine: `🟨 building (${from})`,
        heading: g.title,
      })
    );
    written.push(`Roadmap/${macro}/${g.slug}/`);
  }
  if (plan.building.length) written.push('Roadmap/bets/backfill.md');

  const template = readFileSync(join(GROOM, 'templates', 'scope-seed.md'), 'utf8');
  if (plan.ideas.length) mkdirSync(seeds, { recursive: true });
  for (const idea of plan.ideas) {
    const path = join(seeds, `${idea.slug}.md`);
    if (existsSync(path)) {
      problems.push(`${path}: already exists, not overwritten`);
      continue;
    }
    writeFileSync(path, renderSeed(template, idea, { area, date }));
    written.push(`Roadmap/00-ideas/seeds/${idea.slug}.md`);
  }

  } catch (err) {
    const why = String(err?.stderr || err?.message || err).trim().split('\n')[0];
    problems.push(`stopped part-way: ${why}`);
    problems.push('to start over, delete the new files under Roadmap/ that `git status` lists, then run this again');
    return { written, problems };
  }

  // D9 — the contract on everything written, and nothing new outside Roadmap/.
  for (const g of [...plan.shipped, ...plan.building]) {
    problems.push(
      ...check(join(epicDir(g.slug), 'README.md'), 'epic', { sprintCount: 1, storyCount: 1 }),
      ...check(join(epicDir(g.slug), 'sprint-1.md'), 'sprint', { n: 1, slug: g.slug })
    );
  }
  for (const idea of plan.ideas) {
    const text = readFileSync(join(seeds, `${idea.slug}.md`), 'utf8');
    if (readField(text, 'status') !== 'raw' || readField(text, 'slug') !== idea.slug) problems.push(`${idea.slug}.md: the seed's frontmatter did not render`);
  }
  if (facts.git.ok) {
    for (const path of outsideRoadmap(before, porcelain(run, root))) problems.push(`${path}: changed outside Roadmap/ — the read must never touch it`);
  }
  return { written, problems };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function main(argv) {
  const at = argv.indexOf('--root');
  if (at !== -1 && (!argv[at + 1] || argv[at + 1].startsWith('--'))) {
    console.error('read-repo: --root needs a directory');
    return 1;
  }
  const root = resolve(at === -1 ? process.cwd() : argv[at + 1]);
  if (argv.includes('--look')) {
    console.log(formatLook(gatherFacts(root, { full: false })));
    return 0;
  }
  const facts = gatherFacts(root);
  const plan = planRead(facts);
  const refusal = writeRefusal(facts);
  if (!argv.includes('--write')) {
    console.log(formatPlan(plan, facts, { refusal }));
    return 0;
  }
  if (refusal) {
    console.error(refusal);
    return 1;
  }
  const { written, problems } = writePlan(plan, facts);
  console.log(`Wrote ${plural(written.length, 'path')} under Roadmap/ (new files only):`);
  for (const p of written) console.log(`  + ${p}`);
  if (problems.length) {
    console.error(`\n${plural(problems.length, 'problem')}:`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    return 1;
  }
  console.log('\nNext: regenerate the board (node scripts/build-order.mjs), then show it live (… --live).');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
