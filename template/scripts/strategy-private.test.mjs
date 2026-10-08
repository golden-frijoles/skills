// strategy-private.test.mjs — strategy stays out of a public repo unless the maker chose otherwise (coaches-v2 D9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { IGNORE_LINE, OPT_IN_LINE, appendIgnore, decide, hasOptIn, readFacts } from './strategy-private.mjs';
import { fileURLToPath } from 'node:url';

const base = { isRepo: true, visibility: 'public', tracked: 0, ignored: false, optedIn: false };

test('a public repo, or one whose visibility cannot be read, gets the folder ignored by default', () => {
  assert.equal(decide(base).write, true);
  assert.match(decide(base).line, /because this repo is public/);
  const unknown = decide({ ...base, visibility: 'unknown' });
  assert.equal(unknown.write, true);
  assert.match(unknown.line, /visibility couldn't be read/);
  assert.ok(unknown.line.includes(`delete that line or change it to \`${OPT_IN_LINE}\``));
});

test('a choice the maker already made is never undone: opted in, already committed, already ignored, private', () => {
  assert.equal(decide({ ...base, optedIn: true }).write, false);
  const tracked = decide({ ...base, tracked: 3 });
  assert.equal(tracked.write, false);
  assert.match(tracked.line, /3 already committed/);
  assert.equal(decide({ ...base, ignored: true }).write, false);
  assert.equal(decide({ ...base, visibility: 'private' }).write, false);
  assert.equal(decide({ ...base, visibility: 'internal' }).write, false);
  assert.equal(decide({ isRepo: false }).write, false);
});

test('appendIgnore keeps what was there and adds the folder once, with how to opt in', () => {
  assert.equal(
    appendIgnore(''),
    `# Strategy files are the maker's own. To commit them, change the next line to ${OPT_IN_LINE}\n${IGNORE_LINE}\n`
  );
  assert.match(appendIgnore('node_modules/'), /^node_modules\/\n# Strategy/);
  assert.ok(hasOptIn(`x\n${OPT_IN_LINE}\n`));
  assert.ok(hasOptIn('!/Roadmap/00-strategy/\n'));
  assert.ok(!hasOptIn(appendIgnore('')), 'the comment that mentions the opt-in is not itself an opt-in');
});

// Sealed from any outer repo: a hook's exported GIT_DIR must not retarget these git calls (LEARNINGS, 2026-10-06).
function sealedEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'strategy-private-'));
  spawnSync('git', ['init', '-q', root], { env: sealedEnv() });
  return root;
}
const gh = (visibility) => () => ({
  status: visibility ? 0 : 1,
  stdout: visibility ? `${visibility}\n` : '',
});

test('on a real repo: public → ignored after one write; after opting in, the next coach leaves it alone', () => {
  const root = repo();
  try {
    let facts = readFacts(root, { run: gh('PUBLIC'), env: sealedEnv() });
    assert.equal(facts.visibility, 'public');
    assert.equal(decide(facts).write, true);
    writeFileSync(facts.gitignorePath, appendIgnore(facts.gitignore));

    facts = readFacts(root, { run: gh('PUBLIC'), env: sealedEnv() });
    assert.equal(facts.ignored, true, 'git itself now ignores the folder');
    assert.equal(decide(facts).write, false);

    const gi = join(root, '.gitignore');
    writeFileSync(gi, readFileSync(gi, 'utf8').replace(`\n${IGNORE_LINE}\n`, `\n${OPT_IN_LINE}\n`));
    facts = readFacts(root, { run: gh('PUBLIC'), env: sealedEnv() });
    assert.equal(facts.optedIn, true);
    assert.equal(decide(facts).write, false, 'the opt-in survives the next coach');

    assert.equal(
      readFacts(root, { run: gh(null), env: sealedEnv() }).visibility,
      'unknown',
      'gh failing reads as unknown'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readFacts counts files already committed under the folder', () => {
  const root = repo();
  try {
    mkdirSync(join(root, 'Roadmap', '00-strategy'), { recursive: true });
    writeFileSync(join(root, 'Roadmap', '00-strategy', 'north-star.md'), 'x\n');
    spawnSync('git', ['-C', root, 'add', 'Roadmap/00-strategy/north-star.md'], { env: sealedEnv() });
    assert.equal(readFacts(root, { run: gh('PUBLIC'), env: sealedEnv() }).tracked, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every spelling of the opt-in git honours is an opt-in; so is deleting the line under our comment (review of #315)', () => {
  for (const l of [
    '!Roadmap/00-strategy',
    '!Roadmap/00-strategy/',
    '!/Roadmap/00-strategy/',
    '!Roadmap/00-strategy/**',
    '!Roadmap/00-strategy/*',
  ])
    assert.ok(hasOptIn(`${l}\n`), l);
  const ours = appendIgnore('');
  assert.ok(!hasOptIn(ours), 'our own block is not an opt-in');
  assert.ok(hasOptIn(ours.replace(`${IGNORE_LINE}\n`, '')), 'the line deleted under our comment');
  assert.ok(!hasOptIn('!Roadmap/00-strategy-old/\n'), 'a different folder is not this one');
});

test("on a real repo: an opt-in in a nested .gitignore counts, and a hook's GIT_DIR cannot retarget the checks", () => {
  const root = repo();
  const outer = repo();
  try {
    mkdirSync(join(root, 'Roadmap'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), `${IGNORE_LINE}\n`);
    writeFileSync(join(root, 'Roadmap', '.gitignore'), '!00-strategy/\n');
    assert.equal(
      readFacts(root, { run: gh('PUBLIC'), env: sealedEnv() }).optedIn,
      true,
      'git itself names the negation'
    );

    const plain = repo();
    const leaky = { ...sealedEnv(), GIT_DIR: join(outer, '.git'), GIT_WORK_TREE: outer };
    writeFileSync(join(outer, '.gitignore'), `${IGNORE_LINE}\n`);
    assert.equal(
      readFacts(plain, { run: gh('PUBLIC'), env: leaky }).ignored,
      false,
      'checked the repo it was given'
    );
    rmSync(plain, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outer, { recursive: true, force: true });
  }
});

test('the CLI: check never writes; ensure writes once and says how to opt in', () => {
  const root = repo();
  const script = join(dirname(fileURLToPath(import.meta.url)), 'strategy-private.mjs');
  // A PATH with no gh: visibility reads as unknown, which keeps strategy private.
  const env = { ...sealedEnv(), GF_PROJECT_ROOT: root, PATH: '/usr/bin:/bin' };
  try {
    const check = spawnSync(process.execPath, [script, 'check'], { encoding: 'utf8', env });
    assert.match(check.stdout, /would be kept out of git .*would add/);
    assert.ok(!existsSync(join(root, '.gitignore')), 'check wrote nothing');
    const ensure = spawnSync(process.execPath, [script, 'ensure'], { encoding: 'utf8', env });
    assert.match(ensure.stdout, /visibility couldn't be read .*delete that line or change it to/);
    assert.ok(readFileSync(join(root, '.gitignore'), 'utf8').includes(IGNORE_LINE));
    assert.equal(spawnSync(process.execPath, [script, 'bogus'], { encoding: 'utf8', env }).status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
