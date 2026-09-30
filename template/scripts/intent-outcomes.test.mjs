// intent-outcomes.test.mjs — the join across repos, corrections derived from files (intent-match S3.2, D18).
// Two fixture repos on the Roadmap layout, one with real git history; every git call is SEALED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CALIBRATION_N,
  corrections,
  firstCommitted,
  intentAnswer,
  parseBackfill,
  readRepo,
  rowsFor,
  run,
  sealedEnv,
  summary,
} from './intent-outcomes.mjs';

const readme = ({ score = null, stories = 3, extra = '' } = {}) =>
  `---\nstatus: shipped\nslug: x\nstories_total: ${stories}   # sum\n${score == null ? '' : `intent_match: ${score}\n`}---\n# Epic\n${extra}`;

function repo(name, epics, { backfill } = {}) {
  const root = join(mkdtempSync(join(tmpdir(), 'outcomes-')), name);
  mkdirSync(join(root, 'Roadmap', '00-ideas', 'seeds'), { recursive: true });
  for (const e of epics) {
    const dir = join(root, 'Roadmap', '09-platform-infra', e.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), e.readme);
    if (e.retro) writeFileSync(join(dir, 'RETROSPECTIVE.md'), e.retro);
    if (e.seed) writeFileSync(join(root, 'Roadmap', '00-ideas', 'seeds', `${e.slug}.md`), e.seed);
  }
  if (backfill)
    writeFileSync(join(root, 'Roadmap', '00-ideas', 'intent-backfill.json'), JSON.stringify(backfill));
  return root;
}

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: sealedEnv() });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

// ── pure ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('intentAnswer: one word counts; the template line does not', () => {
  assert.equal(intentAnswer('_Closed: 2026-09-30_\n_Intent: Mostly_\n'), 'mostly');
  assert.equal(intentAnswer('_Intent: yes | mostly | no_'), null);
  assert.equal(intentAnswer(null), null);
});

test('corrections: derived from the README — stories added since the first commit, amendments, disproved scope', () => {
  const now = readme({
    stories: 5,
    extra: '*(Amended 2026-09-29: …)*\nAmended 2026-10-01 again.\nThe live system disproved it.\n',
  });
  assert.deepEqual(corrections(now, readme({ stories: 3 })), {
    storiesAdded: 2,
    amendments: 2,
    disproved: 1,
  });
  assert.equal(corrections(now, null).storiesAdded, null, 'no history is unknown, never zero');
  assert.equal(
    corrections(readme({ stories: 2 }), readme({ stories: 3 })).storiesAdded,
    0,
    'a cut story is not a correction'
  );
});

test('rowsFor: only scored epics get a row; README beats seed beats backfill; the ask is carried', () => {
  const epics = [
    {
      slug: 'a',
      readme: readme({ score: 84 }),
      seed: '---\nintent_match: 89\nintent_ask: proxy\n---\n',
      retro: '_Intent: yes_',
    },
    { slug: 'b', readme: readme(), seed: '---\nintent_match: 61\nintent_ask: verbatim\n---\n', retro: null },
    { slug: 'c', readme: readme(), seed: null, retro: '_Intent: no_' },
    { slug: 'd', readme: readme(), seed: '---\nintent_match: null\n---\n', retro: null },
  ];
  const rows = rowsFor('r', epics, [{ slug: 'c', score: 55, ask: 'proxy' }]);
  assert.deepEqual(
    rows.map((r) => [r.epic, r.score, r.source, r.ask, r.answer]),
    [
      ['a', 84, 'readme', 'proxy', 'yes'],
      ['b', 61, 'seed', 'verbatim', null],
      ['c', 55, 'backfill', 'proxy', 'no'],
    ]
  );
});

test('parseBackfill: a malformed record fails closed; none is empty', () => {
  assert.deepEqual(parseBackfill(null), []);
  assert.throws(() => parseBackfill('{'), /not JSON/);
  assert.throws(() => parseBackfill('{"epics":[{"slug":"x","score":"high"}]}'), /whole-number score/);
  assert.throws(() => parseBackfill('{"rows":[]}'), /"epics" array/);
});

test('summary: n of 20 counts answered rows only, and names the proxies', () => {
  const rows = [
    { answer: 'yes', ask: 'proxy', status: 'shipped' },
    { answer: 'no', ask: 'verbatim', status: 'shipped' },
    { answer: null, ask: 'verbatim', status: 'shipped' },
    { answer: null, ask: 'verbatim', status: 'in-progress' },
  ];
  const s = summary(rows, 2);
  assert.equal(s.answered, 2);
  assert.match(
    s.line,
    new RegExp(
      `^2 of ${CALIBRATION_N}: 2 scored epic\\(s\\) answered \\(1 with a proxy ask\\), 4 scored across 2 repo\\(s\\); 1 shipped but unanswered\\.`
    )
  );
});

// ── across repos, with real (sealed) git ─────────────────────────────────────────────────────────────────────

test('two repos: one row per scored epic from each, the story delta read from git, and the n-of-20 line', () => {
  const one = repo('alpha', [
    {
      slug: 'scored',
      readme: readme({ score: 72, stories: 3 }),
      retro: '_Closed: 2026-09-30_\n_Intent: mostly_\n',
    },
    { slug: 'old', readme: readme(), retro: '_Closed: 2026-01-01_\n' },
  ]);
  git(one, 'init', '-q');
  git(one, 'config', 'user.email', 't@t');
  git(one, 'config', 'user.name', 't');
  git(one, 'add', '.');
  git(one, 'commit', '-qm', 'scaffold');
  writeFileSync(
    join(one, 'Roadmap', '09-platform-infra', 'scored', 'README.md'),
    readme({ score: 72, stories: 4, extra: 'Amended 2026-09-30.\n' })
  );
  git(one, 'commit', '-qam', 'a story was added');
  const two = repo('beta', [{ slug: 'past', readme: readme(), retro: '_Intent: yes_' }], {
    backfill: { epics: [{ slug: 'past', score: 64, ask: 'proxy' }] },
  });
  let out = '';
  assert.equal(run(['--repo', one, '--repo', two], { out: (t) => (out += t), err: () => {} }), 0);
  assert.match(out, /alpha\s+scored\s+72\s+unknown\s+mostly\s+1\s+1\s+0/);
  assert.match(
    out,
    /beta\s+past\s+64\s+proxy ⚑\s+yes\s+\?\s+0\s+0/,
    'no git in beta: stories added is unknown (?)'
  );
  assert.doesNotMatch(out, /\bold\b/, 'an unscored epic has no row');
  assert.match(
    out,
    /2 of 20: 2 scored epic\(s\) answered \(1 with a proxy ask\), 2 scored across 2 repo\(s\)/
  );
});

test('firstCommitted: the README as the commit that ADDED it, or null without history', () => {
  const r = repo('gamma', [{ slug: 'e', readme: readme({ stories: 1 }) }]);
  const rel = join('Roadmap', '09-platform-infra', 'e', 'README.md');
  assert.equal(firstCommitted(r, rel), null, 'not a git repo');
  git(r, 'init', '-q');
  git(r, 'config', 'user.email', 't@t');
  git(r, 'config', 'user.name', 't');
  git(r, 'add', '.');
  git(r, 'commit', '-qm', 'one');
  writeFileSync(join(r, rel), readme({ stories: 9 }));
  git(r, 'commit', '-qam', 'two');
  assert.match(firstCommitted(r, rel), /stories_total: 1 /);
});

test('an unreadable repo is could-not-look (exit 2) — never a smaller table passed off as the whole', () => {
  let err = '';
  assert.equal(run(['--repo', '/nonexistent-intent-outcomes'], { out: () => {}, err: (t) => (err += t) }), 2);
  assert.match(err, /could not look/);
  const bad = repo('delta', [], { backfill: { rows: [] } });
  assert.equal(run(['--repo', bad], { out: () => {}, err: () => {} }), 2);
});

test('sealedEnv strips every GIT_* variable and keeps the rest', () => {
  const env = sealedEnv({ GIT_DIR: '/real/.git', GIT_WORK_TREE: '/real', PATH: '/bin' });
  assert.deepEqual(env, { PATH: '/bin' });
});

test('readRepo: epics, seeds and retros are read from the layout', () => {
  const r = repo('eps', [
    {
      slug: 's',
      readme: readme({ score: 70 }),
      seed: '---\nintent_ask: verbatim\n---\n',
      retro: '_Intent: no_',
    },
  ]);
  const { epics } = readRepo(r);
  assert.equal(epics.length, 1);
  assert.equal(epics[0].macro, '09-platform-infra');
  assert.match(epics[0].seed, /verbatim/);
});

test("the answer rule is the same as epic-dod's, case for case (fresh review of #198)", async () => {
  const dod = await import('./epic-dod.mjs');
  for (const text of [
    '_Intent: mostly_',
    '_Intent: yes | mostly | no_',
    '<!-- e.g. `_Intent: mostly_` -->',
    'like `_Intent: yes_` here',
    '_Closed: x_\n_Intent: No_\n',
    null,
  ])
    assert.equal(intentAnswer(text), dod.intentAnswer(text), JSON.stringify(text));
});

test('a backfill slug with no epic folder is could-not-look, never a silently smaller table', () => {
  const r = repo('orph', [{ slug: 'real', readme: readme() }], {
    backfill: { epics: [{ slug: 'typo', score: 70 }] },
  });
  let err = '';
  assert.equal(run(['--repo', r], { out: () => {}, err: (t) => (err += t) }), 2);
  assert.match(err, /no Roadmap folder: typo/);
});
