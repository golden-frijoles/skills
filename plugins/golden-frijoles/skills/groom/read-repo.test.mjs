// read-repo.test.mjs — first-run-setup S1.1/S1.2: the read's grouping, caps and "left out" note as pure logic, then
// fixture repos run end to end with and without `gh` on PATH, and the contract + the board on everything written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appetiteFor,
  capShipped,
  clusterIssues,
  formatLook,
  formatPlan,
  gatherFacts,
  MERGED_LIMIT,
  OPEN_LIMIT,
  groupChanges,
  groupKey,
  isBot,
  macroFor,
  writePlan,
  outsideRoadmap,
  parseMergeCommit,
  planRead,
  readStack,
  slugify,
  writeRefusal,
} from './read-repo.mjs';
import {
  parseDocFrontmatter,
  validateEpicFrontmatter,
  validateSprintFrontmatter,
} from '../../../../template/scripts/lib/roadmap-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const READ = join(HERE, 'read-repo.mjs');
// The board as a stranger runs it: the kit's bin, which resolves the project from the cwd (template/ resolves its own).
const KIT_BIN = join(HERE, '..', '..', '..', '..', 'kit', 'bin.mjs');
const NOW = new Date('2026-10-07T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

// ── Pure: grouping ────────────────────────────────────────────────────────────────────────────────────────────────

test('groupKey: a sprint branch, a close-out branch and a plain one each find their epic', () => {
  const exact = new Set(['checkout-v2', 'checkout-v2-s2', 'checkout-v2-close', 'search']);
  assert.equal(groupKey('feat/checkout-v2', exact), 'checkout-v2');
  assert.equal(groupKey('feat/checkout-v2-s2', exact), 'checkout-v2');
  assert.equal(groupKey('docs/checkout-v2-close', exact), 'checkout-v2');
  assert.equal(groupKey('docs/checkout-v2-s3-close', exact), 'checkout-v2');
  assert.equal(groupKey('fix/search', exact), 'search');
  assert.equal(groupKey('patch-1', exact), null, 'not a work branch: the caller falls back to the title');
});

test('groupChanges: one epic per branch family, named by the family; a lone PR keeps its title', () => {
  const groups = groupChanges([
    { number: 3, title: 'feat: checkout sprint 1', branch: 'feat/checkout-v2', date: daysAgo(30), size: 100 },
    { number: 5, title: 'checkout sprint 2', branch: 'feat/checkout-v2-s2', date: daysAgo(20), size: 50 },
    { number: 6, title: 'close checkout', branch: 'docs/checkout-v2-close', date: daysAgo(19), size: 5 },
    { number: 7, title: 'fix(search): handle empty query', branch: 'fix/search-empty', date: daysAgo(10), size: 9 },
    { number: 8, title: 'Tweak the footer', branch: 'patch-1', date: daysAgo(5), size: 2 },
  ]);
  assert.deepEqual(
    groups.map((g) => [g.key, g.title, g.changes.map((c) => c.number), g.size, g.type]),
    [
      ['checkout-v2', 'Checkout v2', [3, 5, 6], 155, 'feature'],
      ['search-empty', 'Handle empty query', [7], 9, 'bug'],
      ['tweak-the-footer', 'Tweak the footer', [8], 2, 'feature'],
    ]
  );
});

test('capShipped: the last 12 months, the 20 largest, and the rest counted', () => {
  const groups = Array.from({ length: 25 }, (_, i) => ({ key: `g${i}`, size: i, latest: daysAgo(i < 3 ? 400 : 10) }));
  const { kept, older, smaller } = capShipped(groups, NOW);
  assert.equal(older, 3, 'three groups fall outside the window');
  assert.equal(kept.length, 20);
  assert.equal(smaller, 2, '22 in the window, 20 kept');
  assert.ok(kept.every((g) => g.size >= 5), 'the largest are kept: sizes 3 and 4 are the two left out');
});

test('isBot: by author flag, by [bot] login, by a dependency bot branch', () => {
  assert.ok(isBot({ author: { login: 'x', is_bot: true } }));
  assert.ok(isBot({ author: { login: 'renovate[bot]' } }));
  assert.ok(isBot({ author: { login: 'app/dependabot' }, branch: 'dependabot/npm_and_yarn/x-1.2' }));
  assert.ok(!isBot({ author: { login: 'dana' }, branch: 'feat/x' }));
});

test('appetiteFor: S up to 300 lines, M up to 1500, else L', () => {
  assert.deepEqual([appetiteFor(300), appetiteFor(301), appetiteFor(1500), appetiteFor(1501)], ['S', 'M', 'M', 'L']);
});

test('parseMergeCommit: a GitHub merge, a branch merge, a squash subject, and a plain commit', () => {
  assert.deepEqual(
    parseMergeCommit({ sha: 'a', parents: ['p', 'q'], date: 'd', subject: 'Merge pull request #12 from dana/feat/x-s2', body: 'Sprint two\n' }),
    { sha: 'a', number: 12, branch: 'feat/x-s2', title: 'Sprint two', date: 'd' }
  );
  assert.equal(parseMergeCommit({ sha: 'b', parents: ['p', 'q'], date: 'd', subject: "Merge branch 'feat/y' into main" }).branch, 'feat/y');
  assert.deepEqual(parseMergeCommit({ sha: 'c', parents: ['p'], date: 'd', subject: 'Add search (#9)' }), {
    sha: 'c', number: 9, branch: null, title: 'Add search', date: 'd',
  });
  assert.equal(parseMergeCommit({ sha: 'e', parents: ['p'], date: 'd', subject: 'wip' }), null);
});

// ── Pure: ideas ───────────────────────────────────────────────────────────────────────────────────────────────────

test('clusterIssues: by first label, then a shared title word, then one idea each', () => {
  const ideas = clusterIssues([
    { number: 1, title: 'Export fails', labels: [{ name: 'export' }, { name: 'bug' }] },
    { number: 2, title: 'Crash on load', labels: [{ name: 'bug' }] },
    { number: 3, title: 'Invoice totals wrong', labels: [] },
    { number: 4, title: 'Invoice PDF missing logo', labels: [] },
    { number: 5, title: 'Dark mode', labels: [] },
  ]);
  assert.deepEqual(
    ideas.map((i) => [i.title, i.issues.map((x) => x.number)]),
    [
      ['Bug: 2 issues', [1, 2]],
      ['Invoice: 2 issues', [3, 4]],
      ['Dark mode', [5]],
    ]
  );
});

test('clusterIssues: a word whose other issues were already taken is no cluster; its last issue stands alone', () => {
  const ideas = clusterIssues([
    { number: 1, title: 'Invoice export broken', labels: [] },
    { number: 2, title: 'Invoice totals wrong', labels: [] },
    { number: 3, title: 'Export button hidden', labels: [] },
  ]);
  assert.deepEqual(
    ideas.map((i) => [i.title, i.issues.map((x) => x.number)]),
    [
      ['Export: 2 issues', [1, 3]],
      ['Invoice totals wrong', [2]],
    ]
  );
});

test('outsideRoadmap: only what is new since the read began, and only outside Roadmap/', () => {
  const before = new Set([' M src/app.js']);
  const after = new Set([' M src/app.js', '?? Roadmap/01-product/x/README.md', '?? package-lock.json', ' M "docs/a b.md"']);
  assert.deepEqual(outsideRoadmap(before, after), ['package-lock.json', 'docs/a b.md']);
});

// ── Pure: the plan and its text ───────────────────────────────────────────────────────────────────────────────────

const baseFacts = (over = {}) => ({
  root: '/x',
  empty: false,
  roadmap: { present: true, epics: 0, ideas: 0 },
  stack: ['Node.js (Next.js)'],
  files: { readme: 'README.md', docs: 2, manifests: ['package.json'] },
  git: { ok: true, commits: 1284 },
  gh: { ok: true, why: '' },
  mergedPrs: [],
  openPrs: [],
  issues: [],
  issuesMore: false,
  gitMerges: [],
  tags: [],
  docs: [],
  ...over,
});

test('planRead: pull requests first; an open PR wins over its merged sprint; bots counted', () => {
  const plan = planRead(
    baseFacts({
      mergedPrs: [
        { number: 1, title: 'Search', branch: 'feat/search', date: daysAgo(40), size: 10, author: { login: 'dana' } },
        { number: 2, title: 'Checkout s1', branch: 'feat/checkout', date: daysAgo(30), size: 10, author: { login: 'dana' } },
        { number: 3, title: 'bump', branch: 'dependabot/npm/x', date: daysAgo(3), size: 1, author: { login: 'app/dependabot' } },
      ],
      openPrs: [{ number: 4, title: 'Checkout s2', branch: 'feat/checkout-s2', date: daysAgo(1), size: 2000, author: { login: 'dana' } }],
      tags: [{ name: 'v1', date: daysAgo(10), commits: 3 }],
    }),
    NOW
  );
  assert.equal(plan.source, 'pull requests', 'tags are a fallback only');
  assert.deepEqual(plan.shipped.map((g) => g.slug), ['search']);
  assert.deepEqual(plan.building.map((g) => [g.slug, g.merged?.map((c) => c.number)]), [['checkout', [2]]]);
  assert.equal(plan.leftOut.bots, 1);
});

test('planRead: no gh falls back to merge commits, then tags, then docs, and says what it skipped', () => {
  const why = 'gh is not installed, so pull requests and issues were skipped (git only)';
  const noGh = { gh: { ok: false, why } };
  const merges = planRead(baseFacts({ ...noGh, gitMerges: [{ number: 9, title: 'Add search', branch: null, date: daysAgo(5), size: 4 }] }), NOW);
  assert.equal(merges.source, 'merge commits');
  assert.deepEqual(merges.skipped, [why]);
  const tags = planRead(baseFacts({ ...noGh, tags: [{ name: 'v1.0', date: daysAgo(5), commits: 7 }] }), NOW);
  assert.deepEqual([tags.source, tags.shipped[0].title, tags.shipped[0].slug], ['release tags', 'Release v1.0', 'release-v1-0']);
  const docs = planRead(baseFacts({ ...noGh, docs: [{ file: 'docs/billing.md', title: 'Billing', size: 900 }] }), NOW);
  assert.deepEqual([docs.source, docs.shipped[0].slug], ['docs', 'billing']);
});

test('formatPlan: counts, the left-out note, the first few, and that nothing was written', () => {
  const facts = baseFacts({
    mergedPrs: Array.from({ length: 23 }, (_, i) => ({ number: i + 1, title: `Work ${i + 1}`, branch: `feat/w${i + 1}`, date: daysAgo(i < 2 ? 500 : 5), size: i + 1, author: { login: 'dana' } })),
    openPrs: [{ number: 40, title: 'New thing', branch: 'feat/new-thing', date: daysAgo(1), size: 5, author: { login: 'dana' } }],
    issues: [{ number: 50, title: 'Slow page', labels: [] }],
  });
  const text = formatPlan(planRead(facts, NOW), facts);
  assert.match(text, /^I'll read what's here and write it down\. Nothing is moved or deleted\./);
  assert.match(text, /20 shipped, from the pull requests \(no targets back then, so no verdicts\) · 1 Building: your open pull requests · 1 issue grouped into 1 idea/);
  assert.match(text, /Left out: 2 groups older than 12 months · 1 smaller group past the 20 largest/);
  assert.match(text, /… and 15 more/);
  assert.match(text, /Nothing written yet\./);
});

test('formatLook: Roadmap/ here or not, the stack, commits and open PRs; without gh it says why', () => {
  assert.equal(
    formatLook(baseFacts({ roadmap: { present: false, epics: 0, ideas: 0 }, openPrs: [{ number: 1, branch: 'feat/a', author: { login: 'd' } }] })),
    'I looked first:\n  Roadmap/ ....... not here yet\n  This repo ...... Node.js (Next.js) · 1,284 commits · 1 open pull request'
  );
  const noGh = formatLook(baseFacts({ gh: { ok: false, why: 'gh is not signed in (gh auth login)' } }));
  assert.match(noGh, /Pull requests \.\. not counted: gh is not signed in/);
  assert.match(formatLook(baseFacts({ git: { ok: false, commits: 0 }, empty: true })), /This folder \.\.\.\. empty: nothing built yet/);
});

test('readStack: runtime dependencies name the framework; a dev-only test server does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-repo-stack-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { express: '4', '@sveltejs/kit': '2' } }));
    assert.deepEqual(readStack(dir).stack, ['Node.js (SvelteKit)']);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { express: '4' } }));
    writeFileSync(join(dir, 'go.mod'), 'module x\n');
    assert.deepEqual(readStack(dir), { stack: ['Node.js', 'Go'], manifests: ['package.json', 'go.mod'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('slugify: a long title is cut at a word boundary, a long word where it stands', () => {
  assert.equal(slugify('CI runs the browser tests and Playwright install on all three Node versions'), 'ci-runs-the-browser-tests-and-playwright-install-on-all');
  assert.equal(slugify('a'.repeat(70)).length, 60);
  assert.equal(slugify('  Checkout: v2! '), 'checkout-v2');
});

test('gatherFacts: a list cut at its limit is said out loud, for open and merged pull requests alike', () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-repo-limit-'));
  const prs = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `PR ${i + 1}`, headRefName: `feat/p${i + 1}`, author: { login: 'd' } })));
  const asked = [];
  const run = (cmd, args) => {
    const a = args.join(' ');
    if (cmd === 'git') return a.startsWith('rev-parse') ? 'true\n' : a.startsWith('rev-list') ? '5\n' : '';
    asked.push(a);
    if (a.startsWith('pr list --state open')) return prs(OPEN_LIMIT + 1);
    if (a.startsWith('pr list --state merged')) return prs(MERGED_LIMIT + 1);
    if (a.startsWith('issue list')) return '[]';
    return '';
  };
  try {
    const facts = gatherFacts(dir, { run, now: NOW });
    assert.ok(asked.some((a) => a.includes(`--limit ${OPEN_LIMIT + 1}`)) && asked.some((a) => a.includes(`--limit ${MERGED_LIMIT + 1}`)));
    assert.deepEqual([facts.openPrs.length, facts.openMore, facts.mergedPrs.length, facts.mergedMore], [OPEN_LIMIT, true, MERGED_LIMIT, true]);
    const plan = planRead(facts, NOW);
    assert.ok(plan.skipped.includes(`only the newest ${OPEN_LIMIT} open pull requests were read`));
    assert.ok(plan.skipped.includes(`only the newest ${MERGED_LIMIT} merged pull requests were read`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('macroFor: a 00-* folder (strategy, ideas) never holds epics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-repo-macro-'));
  try {
    mkdirSync(join(dir, 'Roadmap', '00-ideas'), { recursive: true });
    mkdirSync(join(dir, 'Roadmap', '00-strategy'));
    assert.equal(macroFor(dir), '01-product');
    mkdirSync(join(dir, 'Roadmap', '03-billing'));
    assert.equal(macroFor(dir), '03-billing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gatherFacts: a gh list that fails is "could not read", never zero, and the write refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-repo-fail-'));
  mkdirSync(join(dir, 'Roadmap'));
  const run = (cmd, args) => {
    const a = args.join(' ');
    if (cmd === 'git') return a.startsWith('rev-parse') ? 'true\n' : a.startsWith('rev-list') ? '5\n' : '';
    if (a.startsWith('pr list --state open')) throw Object.assign(new Error('x'), { stderr: 'HTTP 502: bad gateway\n' });
    if (a.startsWith('pr list --state merged')) return 'not json';
    if (a.startsWith('issue list')) return '[]';
    return '';
  };
  try {
    const facts = gatherFacts(dir, { run, now: NOW });
    assert.deepEqual(facts.unread, ['open pull requests (HTTP 502: bad gateway)', 'merged pull requests (gh answered something that is not a list)']);
    assert.ok(planRead(facts, NOW).skipped.includes('could not read the open pull requests (HTTP 502: bad gateway), so they are not counted'));
    assert.match(formatLook(facts), /open pull requests: could not read/);
    assert.match(writeRefusal(facts), /^Could not read the open pull requests .* Nothing was written\.$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writePlan: a generator failing part-way stops with what failed and how to start over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-repo-stop-'));
  mkdirSync(join(dir, 'Roadmap'));
  const run = () => {
    throw Object.assign(new Error('boom'), { stderr: 'scaffold-epic: refusing to clobber existing epic dir\n' });
  };
  try {
    const plan = { source: 'pull requests', shipped: [{ slug: 'a', title: 'A', type: 'feature', changes: [{ number: 1 }] }], building: [], ideas: [] };
    const { problems } = writePlan(plan, baseFacts({ root: dir, git: { ok: false, commits: 0 } }), { run });
    assert.deepEqual(problems, [
      'stopped part-way: scaffold-epic: refusing to clobber existing epic dir',
      'to start over, delete the new files under Roadmap/ that `git status` lists, then run this again',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planRead: an open close-out branch joins its merged family as one Building epic', () => {
  const plan = planRead(
    baseFacts({
      mergedPrs: [{ number: 1, title: 'X', branch: 'feat/x', date: daysAgo(9), size: 10, author: { login: 'd' } }],
      openPrs: [{ number: 2, title: 'Close x', branch: 'docs/x-close', date: daysAgo(1), size: 3, author: { login: 'd' } }],
    }),
    NOW
  );
  assert.deepEqual([plan.shipped.length, plan.building.map((g) => [g.slug, g.merged?.map((c) => c.number)])], [0, [['x', [1]]]]);
});

test('clusterIssues: labels that differ only in case are one idea', () => {
  const ideas = clusterIssues([
    { number: 1, title: 'a', labels: [{ name: 'Bug' }] },
    { number: 2, title: 'b', labels: [{ name: 'bug' }] },
  ]);
  assert.deepEqual(ideas.map((i) => i.issues.length), [2]);
});

test('writeRefusal: first run only', () => {
  assert.equal(writeRefusal(baseFacts()), null);
  assert.match(writeRefusal(baseFacts({ roadmap: { present: true, epics: 1, ideas: 0 } })), /first run only/);
  assert.match(writeRefusal(baseFacts({ roadmap: { present: false, epics: 0, ideas: 0 } })), /frijoles-kit init/);
});

// ── Fixture repos, end to end ─────────────────────────────────────────────────────────────────────────────────────

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

/** A repo with a README, a package.json, a merged work branch, a release tag and a skeleton Roadmap/. */
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'read-repo-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), '# Shop\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '15' } }));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'switch', '-q', '-c', 'feat/search');
  writeFileSync(join(root, 'search.js'), 'export const search = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'search');
  git(root, 'switch', '-q', 'main');
  git(root, 'merge', '-q', '--no-ff', 'feat/search', '-m', 'Merge pull request #3 from dana/feat/search', '-m', 'Search the catalog');
  git(root, 'tag', 'v1.0');
  for (const f of ['Roadmap/README.md', 'Roadmap/00-ideas/README.md']) {
    mkdirSync(join(root, dirname(f)), { recursive: true });
    writeFileSync(join(root, f), '# x\n');
  }
  mkdirSync(join(root, 'Roadmap', '00-ideas', 'seeds'), { recursive: true });
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'roadmap skeleton');
  return root;
}

/** A PATH holding only git and node, plus (optionally) a fake `gh` that answers from canned JSON. */
function fakePath(gh) {
  const bin = mkdtempSync(join(tmpdir(), 'read-repo-bin-'));
  const which = (cmd) => execFileSync('/usr/bin/which', [cmd], { encoding: 'utf8' }).trim();
  symlinkSync(which('git'), join(bin, 'git'));
  symlinkSync(process.execPath, join(bin, 'node'));
  if (gh) {
    const script = join(bin, 'gh');
    writeFileSync(
      script,
      `#!${process.execPath}\nconst a = process.argv.slice(2).join(' ');\nconst out = ${JSON.stringify(gh)};\n` +
        `for (const [k, v] of Object.entries(out)) if (a.startsWith(k)) { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); }\n` +
        `process.stderr.write('fake gh: no answer for ' + a); process.exit(1);\n`
    );
    chmodSync(script, 0o755);
  }
  return bin;
}

const GH = {
  '--version': 'gh version 2.0.0\n',
  'auth status': '',
  'repo view': '{"nameWithOwner":"dana/shop"}',
  'pr list --state open': [
    { number: 7, title: 'feat: wishlist', headRefName: 'feat/wishlist', author: { login: 'dana' }, additions: 400, deletions: 20, isDraft: false, createdAt: new Date().toISOString() },
    { number: 8, title: 'bump x', headRefName: 'dependabot/npm_and_yarn/x', author: { login: 'app/dependabot', is_bot: true }, additions: 2, deletions: 2, isDraft: false, createdAt: new Date().toISOString() },
  ],
  'pr list --state merged': [
    { number: 3, title: 'Search the catalog', headRefName: 'feat/search', author: { login: 'dana' }, additions: 30, deletions: 1, mergedAt: new Date().toISOString() },
    { number: 5, title: 'Search: sprint 2', headRefName: 'feat/search-s2', author: { login: 'dana' }, additions: 10, deletions: 1, mergedAt: new Date().toISOString() },
  ],
  'issue list': [
    { number: 11, title: 'Checkout times out', labels: [] },
    { number: 12, title: 'Checkout button hidden on mobile', labels: [] },
    { number: 13, title: 'Add gift cards', labels: [{ name: 'idea' }] },
  ],
};

function read(root, args, bin) {
  return spawnSync(process.execPath, [READ, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: bin } });
}

/** Every epic and sprint file under Roadmap/, held to the contract. */
function contractProblems(root) {
  const problems = [];
  const roadmap = join(root, 'Roadmap');
  for (const macro of readdirSync(roadmap).filter((d) => /^\d{2}-/.test(d) && d !== '00-ideas')) {
    for (const slug of readdirSync(join(roadmap, macro))) {
      const dir = join(roadmap, macro, slug);
      const epic = validateEpicFrontmatter(parseDocFrontmatter(readFileSync(join(dir, 'README.md'), 'utf8')), { sprintCount: 1, storyCount: 1 });
      const sprint = validateSprintFrontmatter(parseDocFrontmatter(readFileSync(join(dir, 'sprint-1.md'), 'utf8')), { n: 1, slug });
      problems.push(...[...epic, ...sprint].map((o) => `${slug}: ${o.rule} ${o.detail}`));
    }
  }
  return problems;
}

test('without gh: git only, said out loud; the merge commit is the shipped epic', () => {
  const root = fixtureRepo();
  const bin = fakePath(null);
  try {
    const look = read(root, ['--look'], bin);
    assert.equal(look.status, 0, look.stderr);
    assert.match(look.stdout, /Roadmap\/ \.\.\.\.\.\.\. here, empty so far/);
    assert.match(look.stdout, /This repo \.\.\.\.\.\. Node\.js \(Next\.js\) · 4 commits/);
    assert.match(look.stdout, /not counted: gh is not installed/);

    const dry = read(root, [], bin);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /1 shipped, from the merge commits/);
    assert.match(dry.stdout, /Skipped: gh is not installed, so pull requests and issues were skipped \(git only\)/);
    assert.match(dry.stdout, /Search the catalog {2}\(merge #3\)/);
    assert.equal(existsSync(join(root, 'Roadmap', '01-product')), false, 'the dry run writes nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('with gh: --write puts shipped, Building and ideas under Roadmap/ only; the contract and the board pass', () => {
  const root = fixtureRepo();
  const bin = fakePath(GH);
  try {
    const dry = read(root, [], bin);
    assert.match(dry.stdout, /1 shipped, from the pull requests .* · 1 Building: your open pull requests · 3 issues grouped into 2 ideas/);
    assert.match(dry.stdout, /Left out: 1 pull request by bots/);

    const out = read(root, ['--write'], bin);
    assert.equal(out.status, 0, out.stdout + out.stderr);

    const epic = (slug) => readFileSync(join(root, 'Roadmap', '01-product', slug, 'README.md'), 'utf8');
    assert.match(epic('search'), /^status: shipped/m);
    assert.match(epic('search'), /^phase: Shipped/m);
    assert.match(epic('search'), /\*\*Backfilled, no target\.\*\* Read from the pull requests on .*: PR #3, #5\./);
    assert.match(epic('search'), /^verdict: null/m, 'no verdict is invented');
    assert.match(epic('wishlist'), /^status: in-progress/m);
    assert.match(epic('wishlist'), /^underwritten_by: backfill/m);
    assert.match(epic('wishlist'), /^appetite: M/m, '420 lines');
    assert.match(readFileSync(join(root, 'Roadmap', 'bets', 'backfill.md'), 'utf8'), /already being built when the roadmap was read/);

    const seeds = readdirSync(join(root, 'Roadmap', '00-ideas', 'seeds')).sort();
    assert.deepEqual(seeds, ['checkout.md', 'idea.md']);
    const checkout = readFileSync(join(root, 'Roadmap', '00-ideas', 'seeds', 'checkout.md'), 'utf8');
    assert.match(checkout, /^status: raw$/m);
    assert.match(checkout, /^title: "Checkout: 2 issues"$/m);
    assert.match(checkout, /> #11 Checkout times out\n> #12 Checkout button hidden on mobile/);

    assert.deepEqual(contractProblems(root), []);
    assert.match(epic('search'), /\*\*Scope seed:\*\* none \(backfilled from the history\)/);
    const format = spawnSync(process.execPath, [KIT_BIN, 'doc-format'], { cwd: root, encoding: 'utf8' });
    assert.equal(format.status, 0, format.stdout + format.stderr);
    assert.doesNotMatch(format.stdout, /\[ENFORCED\]/, format.stdout);
    const changed = git(root, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean);
    assert.ok(changed.length > 0 && changed.every((l) => l.slice(3).startsWith('Roadmap/')), changed.join('\n'));

    const board = spawnSync(process.execPath, [KIT_BIN, 'build-order'], { cwd: root, encoding: 'utf8' });
    assert.equal(board.status, 0, board.stderr);
    const order = readFileSync(join(root, 'Roadmap', '00-ideas', 'BUILD-ORDER.md'), 'utf8');
    assert.match(order, /## To groom \(2\)/);
    assert.match(order, /## Shipped \(1\)/);

    const again = read(root, ['--write'], bin);
    assert.equal(again.status, 1, 'a second run refuses: first run only');
    assert.match(again.stderr, /first run only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
