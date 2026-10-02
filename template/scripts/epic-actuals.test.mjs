// epic-actuals.test.mjs — transcripts → usage by epic, against fixture transcripts and a REAL fixture git repo with a
// worktree (finops S1.1, S1.2, S1.4). Every fixture line is shaped like a real Claude Code 2.1.287 entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backfillReport,
  emptyIndex,
  epicOfBranch,
  epicReport,
  inRepo,
  projectDirName,
  readEntry,
  refresh,
  stampEpic,
  repoPaths,
  stampFrontmatter,
  summarize,
  updateIndex,
  usdText,
} from './epic-actuals.mjs';

// ⚠️ SEALED: git exports GIT_DIR into hooks, and it overrides cwd (see build-state.test.mjs).
const GIT_ENV_TO_CLEAR = [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
];
function sealedEnv(base = process.env) {
  const env = { ...base };
  for (const k of GIT_ENV_TO_CLEAR) delete env[k];
  return env;
}

const README = (slug, status = 'in-progress', extra = '') => `---
status: ${status}
slug: ${slug}
title: ${slug}
area: 09-platform-infra
risk: low
type: feature
phase: Building
sprints_total: 0
stories_total: 0${extra}
---
# Epic: ${slug}
`;

/** A repo with epics `alpha` and `beta`, and a worktree of it on `feat/alpha-s2`. */
function repoFixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'epic-actuals-')));
  const root = join(base, 'repo');
  mkdirSync(join(root, 'Roadmap', '09-platform-infra', 'alpha'), { recursive: true });
  mkdirSync(join(root, 'Roadmap', '09-platform-infra', 'beta'), { recursive: true });
  writeFileSync(join(root, 'Roadmap', '09-platform-infra', 'alpha', 'README.md'), README('alpha'));
  writeFileSync(join(root, 'Roadmap', '09-platform-infra', 'beta', 'README.md'), README('beta', 'shipped'));
  const git = (...a) =>
    execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], env: sealedEnv() });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  const wt = join(base, 'wt-alpha-s2');
  git('worktree', 'add', '-q', '-b', 'feat/alpha-s2', wt);
  const projects = join(base, 'projects');
  mkdirSync(projects);
  return { base, root, wt, projects, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

let n = 0;
/** One assistant entry, as Claude Code writes it. */
function entry({
  id = `msg_${++n}`,
  session = 'sess-1',
  branch = 'feat/alpha',
  cwd,
  model = 'claude-opus-5-5',
  skill,
  at = '2026-10-01T10:00:00.000Z',
  input = 2,
  output = 100,
  read = 1000,
  w5 = 0,
  w1 = 500,
  speed = 'standard',
  content = 'SECRET PROMPT TEXT',
  usage,
}) {
  const e = {
    parentUuid: null,
    isSidechain: false,
    message: {
      id,
      model,
      role: 'assistant',
      content: [{ type: 'text', text: content }],
      usage: usage ?? {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: w5 + w1,
        cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 },
        service_tier: 'standard',
        speed,
      },
    },
    requestId: `req_${id}`,
    type: 'assistant',
    uuid: `u-${id}`,
    timestamp: at,
    cwd,
    sessionId: session,
    gitBranch: branch,
    version: '2.1.287',
  };
  if (skill) e.attributionSkill = skill;
  return JSON.stringify(e);
}
const userLine = (cwd) => JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, cwd });

function write(projects, folder, file, lines) {
  mkdirSync(join(projects, folder, ...file.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(projects, folder, file), `${lines.join('\n')}\n`);
}

function run(fx, index = emptyIndex()) {
  const changes = updateIndex(index, { projectsDir: fx.projects, paths: repoPaths(fx.root) });
  const summary = summarize(index, { epicOf: epicOfBranch(fx.root) });
  return { index, changes, summary };
}

test('D13: a streamed response written as several entries counts ONCE, with the final (largest) output', () => {
  const fx = repoFixture();
  try {
    write(fx.projects, '-elsewhere', 's.jsonl', [
      entry({ id: 'm1', cwd: fx.root, output: 8 }),
      entry({ id: 'm1', cwd: fx.root, output: 208 }),
      entry({ id: 'm1', cwd: fx.root, output: 208 }),
      userLine(fx.root),
    ]);
    const { summary } = run(fx);
    assert.equal(summary.epics.alpha.tokens.output, 208);
    assert.equal(summary.epics.alpha.tokens.cache_read, 1000, 'cache read counted once, not three times');
  } finally {
    fx.cleanup();
  }
});

test('D13: a resumed copy re-stamped with another branch never moves the turn — the first occurrence owns it', () => {
  const fx = repoFixture();
  try {
    write(fx.projects, '-elsewhere', 'a-original.jsonl', [
      entry({ id: 'm1', cwd: fx.root, branch: 'main', session: 'A' }),
    ]);
    const index = emptyIndex();
    run(fx, index);
    // Later, a resume copies the turn into a new file and re-stamps it with the branch of the new session.
    write(fx.projects, '-elsewhere', 'b-resumed.jsonl', [
      entry({ id: 'm1', cwd: fx.root, branch: 'feat/alpha', session: 'B' }),
    ]);
    const { summary } = run(fx, index);
    assert.equal(summary.epics.alpha, undefined, 'the copy did not move the turn onto alpha');
    assert.equal(summary.unattributed.main.sessions, 1);
  } finally {
    fx.cleanup();
  }
});

test('D15/D16: a worktree on feat/<slug>-s2 counts toward <slug>; main is unattributed; another repo never counts', () => {
  const fx = repoFixture();
  try {
    write(fx.projects, '-elsewhere', 's.jsonl', [
      entry({ cwd: join(fx.wt, 'apps'), branch: 'feat/alpha-s2', session: 'W' }),
      entry({ cwd: fx.root, branch: 'main', session: 'M' }),
      entry({ cwd: fx.root, branch: 'docs/alpha-close-out', session: 'C' }),
      entry({ cwd: join(fx.base, 'other-repo'), branch: 'feat/alpha', session: 'X' }),
      entry({ cwd: `${fx.root}-old`, branch: 'feat/alpha', session: 'Y' }),
    ]);
    const { summary } = run(fx);
    assert.equal(summary.epics.alpha.sessions, 2, 'the worktree session and the close-out branch');
    assert.deepEqual(summary.epics.alpha.branches, ['docs/alpha-close-out', 'feat/alpha-s2']);
    assert.deepEqual(Object.keys(summary.unattributed), ['main']);
  } finally {
    fx.cleanup();
  }
});

test('D15 (C15): a transcript in the folder Claude Code keeps for this repo counts even under the pre-move cwd', () => {
  const fx = repoFixture();
  try {
    write(fx.projects, projectDirName(fx.root), 's.jsonl', [
      entry({ cwd: '/Users/someone/old-name', branch: 'feat/alpha' }),
    ]);
    write(fx.projects, '-elsewhere', 's.jsonl', [
      entry({ cwd: '/Users/someone/old-name', branch: 'feat/alpha' }),
    ]);
    const { summary } = run(fx);
    assert.equal(summary.epics.alpha.sessions, 1, 'only the one in this repo’s own folder');
  } finally {
    fx.cleanup();
  }
});

test('D14: a subagent file counts toward its parent session', () => {
  const fx = repoFixture();
  try {
    write(fx.projects, '-elsewhere', 'P.jsonl', [entry({ cwd: fx.root, session: 'P' })]);
    write(fx.projects, '-elsewhere', 'P/subagents/agent-1.jsonl', [
      entry({ cwd: fx.root, session: 'P', output: 50 }),
    ]);
    const { summary } = run(fx);
    assert.equal(summary.epics.alpha.sessions, 1);
    assert.equal(summary.epics.alpha.tokens.output, 150);
  } finally {
    fx.cleanup();
  }
});

test('D4: missing fields are skipped and counted; an unknown model keeps its tokens and makes $ a lower bound', () => {
  const fx = repoFixture();
  try {
    write(fx.projects, '-elsewhere', 's.jsonl', [
      entry({ cwd: fx.root }),
      entry({ cwd: fx.root, model: 'claude-future-9', output: 1000 }),
      entry({ cwd: fx.root, model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'nousage', model: 'claude-opus-5-5' },
        cwd: fx.root,
      }),
      '{"type":"assistant", broken',
    ]);
    const { summary } = run(fx);
    assert.deepEqual(
      summary.skipped,
      { synthetic: 1, no_usage: 1 },
      'a line too broken to place counts only in this repo’s own folder'
    );
    assert.equal(summary.epics.alpha.usd_known, false);
    assert.equal(summary.epics.alpha.tokens.output, 1100, 'the unknown model’s tokens still count');
    assert.ok(summary.epics.alpha.usd > 0, 'the known turn is still priced');
    assert.match(usdText(summary.epics.alpha.usd, false), /^≥\$/);
  } finally {
    fx.cleanup();
  }
});

test('D9: no content ever reaches the index, the summary or the report — and the report key set is pinned', () => {
  const fx = repoFixture();
  try {
    write(fx.projects, '-elsewhere', 's.jsonl', [entry({ cwd: fx.root, skill: 'golden-frijoles:groom' })]);
    const { index, summary } = run(fx);
    const report = epicReport(summary, 'alpha');
    for (const blob of [index, summary, report])
      assert.doesNotMatch(JSON.stringify(blob), /SECRET PROMPT TEXT/);
    assert.deepEqual(Object.keys(report).sort(), [
      'basis',
      'branches',
      'by_model',
      'by_skill',
      'epic',
      'first_at',
      'last_at',
      'measured',
      'mtok',
      'not_measured',
      'prices_as_of',
      'prices_source',
      'sessions',
      'skipped',
      'tokens',
      'usd',
      'usd_known',
    ]);
    assert.deepEqual(Object.keys(report.tokens), [
      'input',
      'output',
      'cache_read',
      'cache_write_5m',
      'cache_write_1h',
    ]);
    assert.deepEqual(Object.keys(report.by_skill), ['golden-frijoles:groom']);
    assert.deepEqual(report.not_measured, ['codex', 'agy', 'vibe', 'devin']);
    const rec = readEntry(entry({ cwd: fx.root })).record;
    assert.deepEqual(Object.keys(rec).sort(), [
      'at',
      'branch',
      'cwd',
      'geo',
      'id',
      'model',
      'session',
      'skill',
      'speed',
      'tokens',
    ]);
  } finally {
    fx.cleanup();
  }
});

test('1.2: the index is incremental — a second run reads nothing, an append reads only the new bytes', () => {
  const fx = repoFixture();
  try {
    write(fx.projects, '-elsewhere', 's.jsonl', [entry({ cwd: fx.root })]);
    const index = emptyIndex();
    assert.equal(run(fx, index).changes.files_read, 1);
    const before = JSON.stringify(index);
    const again = run(fx, index);
    assert.deepEqual(again.changes, { files_read: 0, added: 0, raised: 0, complete: true });
    assert.equal(JSON.stringify(index), before, 'nothing changed');
    appendFileSync(join(fx.projects, '-elsewhere', 's.jsonl'), `${entry({ cwd: fx.root, output: 7 })}\n`);
    const grown = run(fx, index);
    assert.deepEqual(grown.changes, { files_read: 1, added: 1, raised: 0, complete: true });
    assert.equal(grown.summary.epics.alpha.tokens.output, 107);
    // A half-written last line is left for the next run, not half-read.
    appendFileSync(
      join(fx.projects, '-elsewhere', 's.jsonl'),
      entry({ cwd: fx.root, output: 1 }).slice(0, 40)
    );
    assert.equal(run(fx, index).changes.added, 0);
  } finally {
    fx.cleanup();
  }
});

test('1.2: totals survive the transcript being deleted (Claude Code’s 30-day cleanup)', () => {
  const fx = repoFixture();
  try {
    write(fx.projects, '-elsewhere', 's.jsonl', [entry({ cwd: fx.root })]);
    const index = emptyIndex();
    run(fx, index);
    rmSync(join(fx.projects, '-elsewhere'), { recursive: true });
    assert.equal(run(fx, index).summary.epics.alpha.sessions, 1);
  } finally {
    fx.cleanup();
  }
});

test('1.2: refresh writes the index and the summary into the MAIN checkout, from a worktree too (D19)', () => {
  const fx = repoFixture();
  try {
    write(fx.projects, '-elsewhere', 's.jsonl', [entry({ cwd: fx.wt, branch: 'feat/alpha-s2' })]);
    refresh({ root: fx.wt, projectsDir: fx.projects });
    const summary = JSON.parse(readFileSync(join(fx.root, '.golden-frijoles', 'usage-summary.json'), 'utf8'));
    assert.equal(summary.epics.alpha.sessions, 1);
    assert.equal(readFileSync(join(fx.root, '.golden-frijoles', '.gitignore'), 'utf8'), '*\n');
  } finally {
    fx.cleanup();
  }
});

test('inRepo: the repo, under it — never a sibling that only shares a prefix', () => {
  assert.equal(inRepo('/a/repo', ['/a/repo']), true);
  assert.equal(inRepo('/a/repo/apps/web', ['/a/repo']), true);
  assert.equal(inRepo('/a/repo-old', ['/a/repo']), false);
  assert.equal(inRepo(undefined, ['/a/repo']), false);
});

test('stampFrontmatter replaces in place, inserts what is missing, touches nothing else, and is idempotent', () => {
  const md = '---\nstatus: shipped # SSOT\nactual_usd: 1\ntitle: T\n---\n# Body\nactual_usd: 99\n';
  const once = stampFrontmatter(md, {
    actual_usd: 38.42,
    actual_mtok: 1.9,
    actual_basis: 'this machine · 2026-10-02',
  });
  assert.equal(
    once,
    '---\nstatus: shipped # SSOT\nactual_usd: 38.42\ntitle: T\nactual_mtok: 1.9\nactual_basis: "this machine · 2026-10-02"\n---\n# Body\nactual_usd: 99\n'
  );
  assert.equal(
    stampFrontmatter(once, {
      actual_usd: 38.42,
      actual_mtok: 1.9,
      actual_basis: 'this machine · 2026-10-02',
    }),
    once
  );
});

test('1.4 backfill: measured epics, partly-measured ones (never stamped), and each unmeasured one with its reason', () => {
  const row = { usd: 1, usd_known: true, tokens: {}, mtok: 0, sessions: 1, branches: ['feat/a'] };
  const summary = {
    epics: { a: row, early: row, retro: { ...row, branches: ['docs/retro-owed'] } },
    skipped: {},
  };
  const rep = backfillReport({
    summary,
    shipped: ['a', 'early', 'retro', 'old', 'cloud'],
    oldestTranscriptAt: '2026-09-09T00:00:00Z',
    shippedAt: (s) => ({ old: '2026-08-01T00:00:00Z', cloud: '2026-09-20T00:00:00Z' })[s],
    scaffoldedAt: (s) => ({ a: '2026-09-20T00:00:00Z', early: '2026-09-01T00:00:00Z' })[s],
  });
  assert.deepEqual(
    rep.resolved.map((r) => r.epic),
    ['a']
  );
  assert.deepEqual(
    rep.partial.map((r) => r.epic),
    ['early', 'retro']
  );
  assert.match(rep.partial[1].reason, /only close-out sessions/);
  assert.match(rep.partial[0].reason, /partial total, not stamped/);
  assert.match(rep.unresolved[0].reason, /before the oldest transcript/);
  assert.match(rep.unresolved[1].reason, /in the cloud, on another machine/);
});

test('fresh review #230: a time budget stops BETWEEN files, saves progress, and the next run finishes', () => {
  const fx = repoFixture();
  try {
    write(fx.projects, '-elsewhere', 'a.jsonl', [entry({ cwd: fx.root, session: 'A' })]);
    write(fx.projects, '-elsewhere', 'b.jsonl', [entry({ cwd: fx.root, session: 'B' })]);
    const index = emptyIndex();
    const first = updateIndex(index, {
      projectsDir: fx.projects,
      paths: repoPaths(fx.root),
      deadline: 0,
      now: () => 1, // past the deadline from the start — the first file is still read (at least one per run)
    });
    assert.equal(first.complete, false);
    assert.equal(first.files_read, 1, 'one whole file, then stop');
    const second = updateIndex(index, { projectsDir: fx.projects, paths: repoPaths(fx.root) });
    assert.deepEqual(
      [second.complete, second.files_read],
      [true, 1],
      'resumes with the file it had not read'
    );
    assert.equal(summarize(index, { epicOf: epicOfBranch(fx.root) }).epics.alpha.sessions, 2);
  } finally {
    fx.cleanup();
  }
});

test('fresh review #230: skips are counted for this repo only', () => {
  const fx = repoFixture();
  try {
    write(fx.projects, '-elsewhere', 's.jsonl', [
      entry({ cwd: fx.root, model: '<synthetic>' }),
      entry({ cwd: join(fx.base, 'other'), model: '<synthetic>' }),
    ]);
    assert.deepEqual(run(fx).summary.skipped, { synthetic: 1 });
  } finally {
    fx.cleanup();
  }
});

test('fresh review #230: a backfill never overwrites an actual already written; the close (--epic --write) does', () => {
  const fx = repoFixture();
  try {
    const readme = join(fx.root, 'Roadmap', '09-platform-infra', 'beta', 'README.md');
    writeFileSync(readme, README('beta', 'shipped', '\nactual_usd: null\nactual_basis: "held — C14"'));
    const summary = {
      epics: { beta: { usd: 9, usd_known: true, tokens: {}, mtok: 1, sessions: 1, branches: [] } },
      skipped: {},
    };
    assert.equal(stampEpic({ root: fx.root, summary, slug: 'beta', date: 'd', keepStamped: true }), null);
    assert.match(readFileSync(readme, 'utf8'), /actual_usd: null/);
    assert.ok(stampEpic({ root: fx.root, summary, slug: 'beta', date: 'd' }));
    assert.match(readFileSync(readme, 'utf8'), /actual_usd: 9\n/);
  } finally {
    fx.cleanup();
  }
});

test('round-2 review #230: refresh() under a budget writes complete:false to disk, at least one file per run, then true', () => {
  const fx = repoFixture();
  try {
    write(fx.projects, '-elsewhere', 'a.jsonl', [entry({ cwd: fx.root, session: 'A' })]);
    write(fx.projects, '-elsewhere', 'b.jsonl', [entry({ cwd: fx.root, session: 'B' })]);
    const summaryOnDisk = () =>
      JSON.parse(readFileSync(join(fx.root, '.golden-frijoles', 'usage-summary.json'), 'utf8'));
    const first = refresh({ root: fx.root, projectsDir: fx.projects, budgetMs: -1 });
    assert.equal(first.changes.files_read, 1, 'an exhausted budget still reads one file');
    assert.equal(summaryOnDisk().complete, false);
    refresh({ root: fx.root, projectsDir: fx.projects, budgetMs: -1 });
    assert.equal(summaryOnDisk().complete, true, 'the second run finishes the scan');
    assert.equal(summaryOnDisk().epics.alpha.sessions, 2);
    // A FINITE budget is relative to now: two new files inside a minute's budget are both read in one run.
    write(fx.projects, '-elsewhere', 'c.jsonl', [entry({ cwd: fx.root, session: 'C' })]);
    write(fx.projects, '-elsewhere', 'd.jsonl', [entry({ cwd: fx.root, session: 'D' })]);
    const finite = refresh({ root: fx.root, projectsDir: fx.projects, budgetMs: 60_000 });
    assert.deepEqual([finite.changes.files_read, summaryOnDisk().complete], [2, true]);
  } finally {
    fx.cleanup();
  }
});

test('round-2 review #230: an empty or null actual_basis is not a written actual', () => {
  const fx = repoFixture();
  try {
    const readme = join(fx.root, 'Roadmap', '09-platform-infra', 'beta', 'README.md');
    const summary = {
      epics: { beta: { usd: 9, usd_known: true, tokens: {}, mtok: 1, sessions: 1, branches: [] } },
      skipped: {},
    };
    for (const extra of ['\nactual_basis: null', '\nactual_basis:\nactual_mtok: null']) {
      writeFileSync(readme, README('beta', 'shipped', extra));
      assert.ok(stampEpic({ root: fx.root, summary, slug: 'beta', date: 'd', keepStamped: true }), extra);
    }
  } finally {
    fx.cleanup();
  }
});

test('round-3 review #230: an unreadable frontmatter fails CLOSED — a backfill never overwrites what it cannot read', () => {
  const fx = repoFixture();
  try {
    const readme = join(fx.root, 'Roadmap', '09-platform-infra', 'beta', 'README.md');
    writeFileSync(
      readme,
      README('beta', 'shipped', '\nnot: [a, subset, line]\nactual_usd: 12\nactual_basis: "close"').replace(
        'title: beta',
        'title: beta\r'
      )
    );
    const summary = {
      epics: { beta: { usd: 9, usd_known: true, tokens: {}, mtok: 1, sessions: 1, branches: [] } },
      skipped: {},
    };
    assert.equal(stampEpic({ root: fx.root, summary, slug: 'beta', date: 'd', keepStamped: true }), null);
    assert.match(readFileSync(readme, 'utf8'), /actual_usd: 12/);
  } finally {
    fx.cleanup();
  }
});

test('round-3 review #230: D13 order — files are indexed oldest-born first, so the original owns a resumed copy', () => {
  const fx = repoFixture();
  try {
    // Both files carry the same message id; the copy re-stamps the branch. Name the COPY so it sorts first by path,
    // and make it the newer file — only a birth/mtime ordering makes the original win.
    write(fx.projects, '-elsewhere', 'z-original.jsonl', [
      entry({ id: 'm1', cwd: fx.root, branch: 'main', session: 'O' }),
    ]);
    write(fx.projects, '-elsewhere', 'a-copy.jsonl', [
      entry({ id: 'm1', cwd: fx.root, branch: 'feat/alpha', session: 'C' }),
    ]);
    const older = new Date('2026-09-01T00:00:00Z');
    utimesSync(join(fx.projects, '-elsewhere', 'z-original.jsonl'), older, older);
    const index = emptyIndex();
    updateIndex(index, {
      projectsDir: fx.projects,
      paths: repoPaths(fx.root),
      stat: (p) => {
        const st = statSync(p);
        return { size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: 0 };
      },
    });
    const summary = summarize(index, { epicOf: epicOfBranch(fx.root) });
    assert.equal(summary.epics.alpha, undefined, 'the copy did not own the turn');
    assert.equal(summary.unattributed.main.sessions, 1);
  } finally {
    fx.cleanup();
  }
});
